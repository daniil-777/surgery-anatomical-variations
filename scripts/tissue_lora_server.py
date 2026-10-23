#!/usr/bin/env python3
"""Loopback-only HTTP front end for the learned tile service (stdlib only).

  GET  /health    -> generator status, families, modes, rights
  POST /generate  -> {"family", "seed"?, "mode"?, "guidance"?, "steps"?, "guide_strength"?} -> tissue-pbr bundle JSON

CORS answers only the listed origins; Private Network Access preflights are answered so a page
served from another origin on this machine can call it. Never binds a non-loopback address.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))

from viscera_core.tissue_lora.service import BusyError, TileService, parse_request  # noqa: E402

DEFAULT_ORIGINS = (
    "http://127.0.0.1:5174",
    "http://localhost:5174",
    "http://127.0.0.1:5176",
    "http://localhost:5176",
    "http://127.0.0.1:5191",
    "http://localhost:5191",
    "http://127.0.0.1:5193",
    "http://localhost:5193",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://127.0.0.1:8123",
    "http://localhost:8123",
    "http://127.0.0.1:8822",
    "http://localhost:8822",
    "https://daniil-777.github.io",
)


def _is_loopback_origin(origin: str) -> bool:
    for prefix in ("http://127.0.0.1:", "http://localhost:", "http://[::1]:", "https://127.0.0.1:", "https://localhost:"):
        if origin.startswith(prefix) and origin[len(prefix):].isdigit():
            return True
    return origin in ("http://127.0.0.1", "http://localhost", "http://[::1]", "https://127.0.0.1", "https://localhost")


def make_handler(service: TileService, origins: set[str]):
    allow_any_loopback = bool(origins & set(DEFAULT_ORIGINS))

    class Handler(BaseHTTPRequestHandler):
        server_version = "viscera-tissue-generator/1"

        def log_message(self, fmt, *args):  # concise access log on stderr
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

        def _origin_allowed(self) -> bool:
            origin = self.headers.get("Origin")
            if origin is None or "*" in origins or origin in origins:
                return True
            if allow_any_loopback and _is_loopback_origin(origin):
                return True
            return False

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and self._origin_allowed():
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Max-Age", "600")

        def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status: int, message: str) -> None:
            self._send(status, json.dumps({"error": message}).encode())

        def do_OPTIONS(self):  # noqa: N802
            if not self._origin_allowed():
                return self._error(403, "origin not allowed")
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            if not self._origin_allowed():
                return self._error(403, "origin not allowed")
            if self.path != "/health":
                return self._error(404, "not found")
            self._send(200, json.dumps(service.health()).encode())

        def do_POST(self):  # noqa: N802
            if not self._origin_allowed():
                return self._error(403, "origin not allowed")
            if self.path != "/generate":
                return self._error(404, "not found")
            if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
                return self._error(415, "Content-Type must be application/json")
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 <= length <= 4096:
                return self._error(413, "request too large")
            try:
                request = parse_request(self.rfile.read(length), service.families)
            except ValueError as error:
                return self._error(400, str(error))
            try:
                source, receipt = service.generate(request)
            except BusyError as error:
                return self._error(409, str(error))
            except ValueError as error:
                return self._error(400, str(error))
            except Exception as error:  # noqa: BLE001 - report, keep serving
                traceback.print_exc()
                return self._error(500, f"generation failed: {type(error).__name__}")
            sys.stderr.write(json.dumps({"generated": receipt}) + "\n")
            self._send(200, source.encode())

    return Handler


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", type=Path, required=True, help="pinned SD 1.5 snapshot")
    parser.add_argument("--lora", type=Path, required=True, help="checkpoint directory with lora.json and weights")
    parser.add_argument("--work", type=Path, required=True, help="directory for job outputs (kept, pruned to 50)")
    parser.add_argument("--colour-stats", type=Path, help="family colour statistics JSON (enables clean/guided modes)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--allow-origin", action="append", help="extra allowed browser origin (repeatable)")
    parser.add_argument("--device", default=None)
    parser.add_argument("--warm", action="store_true", help="load the pipeline before accepting requests")
    args = parser.parse_args(argv)
    if not ipaddress.ip_address(args.host).is_loopback:
        raise SystemExit("the tile generator only binds loopback addresses")
    service = TileService(args.model, args.lora, args.work, colour_stats=args.colour_stats, device=args.device)
    origins = set(DEFAULT_ORIGINS) | set(args.allow_origin or [])
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service, origins))
    if args.warm:
        import threading

        def _warm_pipeline() -> None:
            with service._lock:
                from viscera_core.tissue_lora.model import default_precision, pick_device
                from viscera_core.tissue_lora.sample import get_pipeline

                device = pick_device(args.device)
                get_pipeline(args.model, args.lora, device, default_precision(device))

        threading.Thread(target=_warm_pipeline, daemon=True).start()
    sys.stderr.write(json.dumps({"listening": f"http://{args.host}:{args.port}", "families": service.families,
                                 "run_id": service.run_id, "origins": sorted(origins)}) + "\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
