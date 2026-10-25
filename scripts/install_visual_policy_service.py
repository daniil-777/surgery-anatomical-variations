#!/usr/bin/env python3
"""Install the verified visual policy as a per-user macOS loopback service.

Runtime/model files live outside iCloud. No administrator privileges are needed.
Use launchctl bootout gui/$(id -u)/com.viscera.visual-policy to stop the job.
Remove its LaunchAgents plist as well to disable startup at login.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

LABEL = "com.viscera.visual-policy"


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def install(root: Path, destination: Path, assets: Path | None):
    if sys.platform != "darwin":
        raise SystemExit("This installer requires macOS; use visual_policy_server.py elsewhere.")
    plist = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
    existing = plistlib.loads(plist.read_bytes()) if plist.exists() else None
    if existing and existing.get("WorkingDirectory") != str(destination):
        raise SystemExit(
            "An existing visual-policy job uses another directory; it was not replaced."
        )
    uv = shutil.which("uv") or "/opt/homebrew/bin/uv"
    destination.mkdir(parents=True, exist_ok=True)
    runtime = destination / "runtime"
    lock = root / "deploy/visual-policy-requirements.lock"
    receipt = destination / "runtime-lock.sha256"
    python = runtime / "bin/python"
    created_runtime = not python.exists()
    if created_runtime:
        subprocess.run([uv, "venv", "--python", "3.11", str(runtime)], check=True)
    if created_runtime or not receipt.exists() or receipt.read_text().strip() != sha(lock):
        subprocess.run([uv, "pip", "install", "--python", str(python), "-r", str(lock)], check=True)
        receipt.write_text(sha(lock) + "\n")
    # Reuse the already downloaded base weights; setup verifies the pinned digest.
    cached = assets / "models/base/model.safetensors" if assets else None
    base = destination / "models/base/model.safetensors"
    if cached and cached.is_file() and not base.exists():
        base.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["/bin/cp", "-c", str(cached), str(base)], check=True)
    subprocess.run(
        [
            str(python),
            str(root / "scripts/setup_visual_policy_models.py"),
            "--root",
            str(destination),
        ],
        check=True,
    )
    sources = [
        "scripts/visual_policy_server.py",
        "py/viscera_core/__init__.py",
        "py/viscera_core/visual_policy/__init__.py",
        "py/viscera_core/visual_policy/contract.py",
        "py/viscera_core/visual_policy/model.py",
    ]
    for name in sources:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".new")
        shutil.copyfile(root / name, temporary)
        temporary.replace(target)
    for name in [
        "deploy/visual-policy-requirements.lock",
        "docs/research/virtamed/visual-policy-model-card.md",
    ]:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, target)
    logs = destination / "logs"
    logs.mkdir(exist_ok=True)
    plist.parent.mkdir(parents=True, exist_ok=True)
    config = {
        "Label": LABEL,
        "ProgramArguments": [
            str(python),
            str(destination / "scripts/visual_policy_server.py"),
            "--models",
            str(destination / "models"),
            "--run",
            str(destination / "trained"),
        ],
        "WorkingDirectory": str(destination),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 30,
        "ProcessType": "Interactive",
        "EnvironmentVariables": {
            "PYTHONUNBUFFERED": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "HF_HUB_OFFLINE": "1",
            "TOKENIZERS_PARALLELISM": "false",
        },
        "StandardOutPath": str(logs / "service.log"),
        "StandardErrorPath": str(logs / "service-error.log"),
    }
    domain = f"gui/{os.getuid()}"
    job = f"{domain}/{LABEL}"
    registered = subprocess.run(["launchctl", "print", job], capture_output=True).returncode == 0
    if registered and existing == config:
        # Restart in place: bootout/bootstrap can race asynchronous job teardown.
        subprocess.run(["launchctl", "kickstart", "-k", job], check=True)
    else:
        if registered:
            subprocess.run(["launchctl", "bootout", job], check=True)
        temporary = plist.with_suffix(".new")
        temporary.write_bytes(plistlib.dumps(config))
        temporary.replace(plist)
        for attempt in range(10):
            bootstrap = subprocess.run(
                ["launchctl", "bootstrap", domain, str(plist)], capture_output=True, text=True
            )
            if bootstrap.returncode == 0:
                break
            if attempt == 9:
                raise SystemExit(f"Could not register {LABEL}: {bootstrap.stderr.strip()}")
            time.sleep(0.5)
    expected = json.loads((destination / "trained/manifest.json").read_text())["modelId"]
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8877/health", timeout=2) as response:
                health = json.load(response)
            if (
                health.get("schema") == "viscera.visual-skills/1"
                and health.get("modelId") == expected
                and health.get("ready") is True
            ):
                status = subprocess.run(["launchctl", "print", job], capture_output=True, text=True)
                match = re.search(r"^\s*pid = (\d+)$", status.stdout, re.MULTILINE)
                pid = match.group(1) if match else ""
                listener = subprocess.run(
                    [
                        "/usr/sbin/lsof",
                        "-nP",
                        "-a",
                        "-p",
                        pid or "0",
                        "-iTCP:8877",
                        "-sTCP:LISTEN",
                        "-t",
                    ],
                    capture_output=True,
                    text=True,
                )
                if not pid or pid not in listener.stdout.split():
                    raise OSError("The ready endpoint is not owned by the installed service yet.")
                result = {
                    "service": LABEL,
                    "pid": int(pid),
                    "destination": str(destination),
                    "launch_agent": str(plist),
                    "health": health,
                    "source_sha256": {name: sha(root / name) for name in sources},
                }
                (destination / "installation.json").write_text(json.dumps(result, indent=2) + "\n")
                print(json.dumps(result), flush=True)
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise SystemExit(f"The service did not become ready. Inspect {logs / 'service-error.log'}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--assets",
        type=Path,
        help="Existing visual-policy-1 asset directory, to reuse base weights",
    )
    parser.add_argument(
        "--destination",
        type=Path,
        default=Path.home() / "Library/Application Support/Viscera/visual-policy-1",
    )
    args = parser.parse_args()
    assets = args.assets.expanduser().resolve() if args.assets else None
    install(Path(__file__).resolve().parents[1], args.destination.expanduser().resolve(), assets)
