"""Temporarily publish the installed studio through its existing login boundary.

Run with the installed cloudflared binary. The printed HTTPS address lasts only
while this process and this Mac remain online. No credentials are changed.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cloudflared", type=Path, required=True)
    parser.add_argument("--installation", type=Path, default=Path.home() / "Library/Application Support/Viscera/private-studio")
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--port", type=int, default=5182)
    args = parser.parse_args()
    os.umask(0o077)
    base = args.installation.resolve()
    release = Path(json.loads((base / "installation.json").read_text())["release"])
    args.state.mkdir(parents=True, exist_ok=True)
    children = []

    def stop(*_):
        for process in reversed(children):
            if process.poll() is None:
                process.terminate()
        for process in reversed(children):
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        with (args.state / "tunnel.log").open("w") as log:
            tunnel = subprocess.Popen([
                str(args.cloudflared.resolve()), "tunnel", "--no-autoupdate",
                "--url", f"http://127.0.0.1:{args.port}", "--protocol", "http2",
            ], stdout=log, stderr=subprocess.STDOUT)
            children.append(tunnel)
        origin = None
        for _ in range(120):
            if tunnel.poll() is not None:
                raise RuntimeError("Tunnel exited; inspect tunnel.log.")
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", (args.state / "tunnel.log").read_text())
            if match:
                origin = match.group()
                break
            time.sleep(0.5)
        if not origin:
            raise RuntimeError("Tunnel did not supply an HTTPS address.")
        env = os.environ.copy()
        env.update({
            "PYTHONPATH": str(release), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
            "VISCERA_AUTH_CONFIG": str(base / "data/studio-access.json"),
            "VISCERA_AUTH_DB": str(args.state / "sessions.sqlite"),
            "VISCERA_AUTH_ORIGIN": origin, "VISCERA_WEB_DIST": str(release / "public-copy"),
        })
        with (args.state / "server.log").open("a") as log:
            server = subprocess.Popen([
                str(base / "runtime/bin/python"), "-m", "uvicorn", "services.web.private_preview:app",
                "--host", "127.0.0.1", "--port", str(args.port), "--no-access-log", "--no-proxy-headers",
            ], cwd=release, env=env, stdout=log, stderr=subprocess.STDOUT)
            children.append(server)
        for _ in range(60):
            if server.poll() is not None:
                raise RuntimeError("Protected server exited; inspect server.log.")
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{args.port}/auth/login", headers={"Host": origin.removeprefix("https://")})
                with urllib.request.urlopen(request, timeout=2) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.5)
        else:
            raise RuntimeError("Protected server did not become ready.")
        state = {"origin": origin, "login": origin + "/auth/login", "release": str(release),
                 "runnerPid": os.getpid(), "serverPid": server.pid, "tunnelPid": tunnel.pid,
                 "port": args.port, "temporary": True, "existingCredentialsReused": True}
        temporary = args.state / "deployment.tmp"
        temporary.write_text(json.dumps(state, indent=2) + "\n")
        temporary.replace(args.state / "deployment.json")
        print(state["login"], flush=True)
        while tunnel.poll() is None and server.poll() is None:
            time.sleep(1)
        raise RuntimeError("Public studio stopped; inspect server.log and tunnel.log before restarting.")
    finally:
        for process in reversed(children):
            if process.poll() is None:
                process.terminate()


if __name__ == "__main__":
    main()
