"""Run the existing authenticated browser studio with bounded health recovery.

Credentials arrive through a Fly secret, never the image or frontend. The only
persistent application state is the existing SQLite session/rate-limit store.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def configure_access(data: Path, private: Path) -> None:
    secret = os.environ.pop("VISCERA_ACCESS_CONFIG_B64", "")
    if not secret:
        raise RuntimeError("The studio access secret is missing; refusing to serve.")
    try:
        raw = base64.b64decode(secret, validate=True)
        config = json.loads(raw)
        if set(config) != {"username", "password_hash"}:
            raise ValueError("Unexpected access configuration")
    except (ValueError, TypeError):
        raise RuntimeError("The studio access secret is invalid.") from None
    origin = os.environ.get("VISCERA_AUTH_ORIGIN", "")
    url = urlsplit(origin)
    if url.scheme != "https" or not url.hostname or url.path or url.query or url.fragment or url.username:
        raise RuntimeError("Configure a fixed HTTPS studio origin.")
    data.mkdir(parents=True, exist_ok=True)
    private.mkdir(parents=True, exist_ok=True)
    private.chmod(0o700)
    path = private / "studio-access.json"
    if path.is_symlink() or data.is_symlink() or private.is_symlink():
        raise RuntimeError("Runtime paths must not be symlinks.")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
    path.chmod(0o600)
    os.environ["VISCERA_AUTH_CONFIG"] = str(path)
    os.environ["VISCERA_AUTH_DB"] = str(data / "sessions.sqlite")
    # Fly mounts a newly provisioned volume owned by root. Hand only the
    # application state paths to the unprivileged runtime, then drop root.
    if os.geteuid() == 0:
        for item in (data, private, path, *(data / name for name in ("sessions.sqlite", "sessions.sqlite-wal", "sessions.sqlite-shm"))):
            if item.exists():
                if item.is_symlink():
                    raise RuntimeError("State paths must not be symlinks.")
                os.chown(item, 1000, 1000)
        os.setgroups([])
        os.setgid(1000)
        os.setuid(1000)
    from services.web.studio_access import AccessConfig
    AccessConfig.from_env()  # Validate the hash and permissions before listening.


def healthy(port: int, origin: str) -> bool:
    headers = {"Host": urlsplit(origin).netloc}
    try:
        request = urllib.request.Request(f"http://127.0.0.1:{port}/auth/login", headers=headers)
        with urllib.request.urlopen(request, timeout=4) as response:
            if response.status != 200 or b'type="password"' not in response.read(256_000):
                return False
        request = urllib.request.Request(f"http://127.0.0.1:{port}/auth/session", headers=headers)
        try:
            urllib.request.urlopen(request, timeout=4).close()
        except urllib.error.HTTPError as error:
            return error.code == 401
        return False
    except (OSError, ValueError):
        return False


def stop_child(child: subprocess.Popen) -> None:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


def supervise(command: list[str], port: int, origin: str, *, interval=20, startup_grace=30, failure_limit=3) -> int:
    child = subprocess.Popen(command)
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started = time.monotonic()
    next_check = started + startup_grace
    failures = 0
    try:
        while not stopping:
            if child.poll() is not None:
                print("Studio process exited; requesting platform restart.", flush=True)
                return 1
            now = time.monotonic()
            if now >= next_check:
                failures = 0 if healthy(port, origin) else failures + 1
                if failures >= failure_limit:
                    print("Studio health checks failed; requesting platform restart.", flush=True)
                    return 1
                next_check = now + interval
            time.sleep(0.25)
        return 0
    finally:
        stop_child(child)


def main() -> int:
    os.umask(0o077)
    configure_access(Path("/data"), Path("/run/viscera"))
    port = int(os.environ.get("PORT", "8080"))
    command = [sys.executable, "-m", "uvicorn", "services.web.private_preview:app",
               "--host", "0.0.0.0", "--port", str(port), "--no-access-log",
               "--no-proxy-headers", "--limit-concurrency", "128", "--timeout-keep-alive", "30"]
    return supervise(command, port, os.environ["VISCERA_AUTH_ORIGIN"])


if __name__ == "__main__":
    raise SystemExit(main())
