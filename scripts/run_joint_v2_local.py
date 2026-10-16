"""Start the verified local API using its preserved machine configuration.

This does not stop an existing API, change model selection, or download a model.
Run --check to inspect availability without launching anything. Studio's existing
development server is separate. The command fails clearly if the prior runtime
checkout or Python environment has been removed.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    workspace_config = Path(__file__).resolve().parents[1] / "artifacts/local-api/runtime-config.json"
    legacy_config = Path.home() / "Library/Application Support/VISCERA/joint-v2-2026-10-07/runtime-config.json"
    parser.add_argument("--config", type=Path, default=workspace_config if workspace_config.is_file() else legacy_config)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    command, cwd, values = config["command"], Path(config["cwd"]), config["environment"]
    if not Path(command[0]).is_file() or not (cwd / "services/api/app.py").is_file():
        raise SystemExit("The verified Python environment/runtime checkout is unavailable. Restore it before launching; retained weights remain in the local cache.")
    for key in ("VISCERA_MODEL_STORE", "VISCERA_ATLAS_TEMPLATES_V2", "VISCERA_ATLAS_TEMPLATES", "VISCERA_PROJECT_ROOT"):
        if not Path(values[key]).is_dir():
            raise SystemExit(f"Required local runtime directory is missing: {key}")
    with socket.socket() as connection:
        occupied = connection.connect_ex(("127.0.0.1", 8000)) == 0
    if args.check:
        print(json.dumps({"runtime_available": True, "api_port_occupied": occupied, "model_store": values["VISCERA_MODEL_STORE"], "v2_templates": values["VISCERA_ATLAS_TEMPLATES_V2"]}, indent=2))
        return
    if occupied:
        raise SystemExit("Port 8000 is already in use. The running API was left untouched.")
    bytecode = tempfile.mkdtemp(prefix="local-api-bytecode-", dir=args.config.parent)
    env = {**os.environ, **values, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPYCACHEPREFIX": bytecode}
    process = subprocess.Popen(command, cwd=cwd, env=env)

    def owns_port() -> bool:
        result = subprocess.run(["lsof", "-nP", "-iTCP:8000", "-sTCP:LISTEN", "-t"], capture_output=True, text=True, check=False)
        if result.returncode not in (0, 1):
            raise RuntimeError("Cannot verify API listener ownership")
        listeners = {int(value) for value in result.stdout.split()}
        if listeners and listeners != {process.pid}:
            raise RuntimeError("Another process acquired port 8000; leaving it untouched")
        return listeners == {process.pid} and process.poll() is None

    try:
        deadline = time.monotonic() + 60
        while True:
            if process.poll() is not None:
                raise RuntimeError("API exited before becoming ready")
            try:
                with urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=3) as response:
                    if response.status == 200 and owns_port():
                        break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("API did not become ready within 60 seconds")
                time.sleep(0.3)
        if config.get("restore_language_offline"):
            if not owns_port():
                raise RuntimeError("API no longer owns its listener")
            request = urllib.request.Request("http://127.0.0.1:8000/api/atlas/models/language/enable", data=json.dumps({"allow_model_download": True}).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=180) as response:
                if json.load(response).get("language_enabled") is not True:
                    raise RuntimeError("Cached text adapter did not activate")
        print("Verified local API ready at http://127.0.0.1:8000", flush=True)
        raise SystemExit(process.wait())
    except KeyboardInterrupt:
        pass
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


if __name__ == "__main__":
    main()
