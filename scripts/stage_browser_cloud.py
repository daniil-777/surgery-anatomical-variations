"""Stage the installed, authenticated browser release without credentials or sessions."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

SOURCE = Path(__file__).resolve().parents[1]


def stage(release: Path, out: Path, app: str, region: str = "fra") -> dict:
    if not re.fullmatch(r"[a-z][a-z0-9-]{2,60}", app) or not re.fullmatch(r"[a-z]{3}", region):
        raise ValueError("Use a valid Fly app name and three-letter region.")
    if out.exists() and any(out.iterdir()):
        raise ValueError("Staging requires an empty output directory.")
    for required in ("public-copy/index.html", "services/web/private_preview.py", "services/web/studio_access.py", "services/web/login/index.html", "apps/studio/public/recorder/manifest.json"):
        if not (release / required).is_file():
            raise ValueError(f"Installed release missing {required}")
    out.mkdir(parents=True, exist_ok=True)
    for directory in ("public-copy", "services", "apps/studio/public/recorder"):
        for source in sorted((release / directory).rglob("*")):
            relative = source.relative_to(release)
            if any(part.startswith(".") or part == "__pycache__" for part in relative.parts):
                continue
            if source.is_symlink():
                raise ValueError(f"Unexpected symlink in installed release: {relative}")
            if not source.is_file():
                continue
            if source.suffix in {".sqlite", ".db", ".pem", ".key", ".pyc"} or "studio-access" in source.name:
                raise ValueError(f"Private runtime file in installed release: {relative}")
            target = out / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    for name in ("Dockerfile", "entrypoint.py", "requirements.txt"):
        shutil.copyfile(SOURCE / "deploy/browser" / name, out / name)
    (out / ".dockerignore").write_text(".git\n*.sqlite\n*.sqlite-*\n.env*\n*access*.json\ncloud-manifest.json\n")
    (out / "fly.toml").write_text(f'''app = "{app}"
primary_region = "{region}"
kill_signal = "SIGTERM"
kill_timeout = "20s"

[build]
  dockerfile = "Dockerfile"
[env]
  PORT = "8080"
  VISCERA_AUTH_ORIGIN = "https://{app}.fly.dev"
[[mounts]]
  source = "viscera_sessions"
  destination = "/data"
  initial_size = "1gb"
[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"
[[restart]]
  policy = "always"
[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
  [http_service.concurrency]
    type = "connections"
    soft_limit = 50
    hard_limit = 100
  [[http_service.checks]]
    grace_period = "30s"
    interval = "30s"
    timeout = "5s"
    method = "GET"
    path = "/auth/login"
    [http_service.checks.headers]
      Host = "{app}.fly.dev"
''')
    files = {str(path.relative_to(out)): {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
             for path in sorted(out.rglob("*")) if path.is_file()}
    receipt = {"schema": "viscera.browser-cloud/v1", "source_release": release.name,
               "app": app, "region": region, "files": files,
               "bytes": sum(item["bytes"] for item in files.values()), "credentials_included": False}
    (out / "cloud-manifest.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--region", default="fra")
    args = parser.parse_args()
    receipt = stage(args.release, args.out, args.app, args.region)
    print(json.dumps({key: value for key, value in receipt.items() if key != "files"}, indent=2))
