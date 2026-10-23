#!/usr/bin/env python3
"""Loopback-only HTTP server for VISCERA accounts, login and per-user workspace storage.

  GET    /api/account/me
  POST   /api/account/register
  POST   /api/account/login
  POST   /api/account/logout
  DELETE /api/account
  GET    /api/account/items
  GET    /api/account/items/<id>
  POST   /api/account/items
  DELETE /api/account/items/<id>
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from services.api.accounts import AccountStore, make_account_http_handler  # noqa: E402

DEFAULT_ORIGINS = (
    "http://127.0.0.1:5174",
    "http://localhost:5174",
    "http://127.0.0.1:5176",
    "http://localhost:5176",
    "http://127.0.0.1:5193",
    "http://localhost:5193",
    "http://127.0.0.1:8123",
    "http://localhost:8123",
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=ROOT / "data" / "accounts.sqlite",
        help="SQLite database path for accounts and saved workspace items",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--allow-origin", action="append")
    args = parser.parse_args(argv)
    if not ipaddress.ip_address(args.host).is_loopback:
        raise SystemExit("account_server only binds loopback addresses")
    store = AccountStore(args.db)
    origins = set(DEFAULT_ORIGINS) | set(args.allow_origin or [])
    server = ThreadingHTTPServer((args.host, args.port), make_account_http_handler(store, origins))
    actual_port = server.server_address[1]
    ready_line = (
        json.dumps(
            {
                "ready": True,
                "port": actual_port,
                "listening": f"http://{args.host}:{actual_port}",
                "db": str(args.db),
            }
        )
        + "\n"
    )
    sys.stdout.write(ready_line)
    sys.stdout.flush()
    sys.stderr.write(ready_line)
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

