#!/usr/bin/env python3
"""Research corpus acquisition using reviewed hosts and ETag-pinned ranges.

Native curl verifies certificates. Redirects are followed explicitly only between
catalogued HTTPS hosts; no credentials, cookies, curlrc or source scripts run.
The existing bounded range assembler and publisher-checksum/ZIP-CRC validator
provide atomic publication and independently hashed resumable chunks.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

from acquire_tissue_datasets import AcquisitionError, CurlResponse, check_url, select_assets
from acquire_tissue_parallel import parallel_acquire


class ReviewedRedirectOpener:
    def __init__(self, hosts: list[str], response_factory=CurlResponse):
        self.hosts = hosts
        self.response_factory = response_factory

    def __call__(self, request, *, limit: int, timeout: int):
        for _ in range(5):
            check_url(request.full_url, self.hosts)
            response = self.response_factory(request, limit=limit, timeout=timeout)
            if response.status not in (301, 302, 303, 307, 308):
                return response
            location = response.headers.get("Location")
            response.close()
            if not location:
                raise AcquisitionError("Redirect lacks Location")
            url = urljoin(request.full_url, location)
            check_url(url, self.hosts)
            # Only immutable public range headers are forwarded, never credentials.
            headers = {k: v for k, v in request.header_items()
                       if k.lower() in {"range", "if-match", "accept-encoding", "user-agent"}}
            request = urllib.request.Request(url, headers=headers)
        raise AcquisitionError("Too many reviewed redirects")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=Path(__file__).resolve().parents[1]
                        / "research/tissue-v3/acquisition-catalog.json")
    parser.add_argument("--asset", default="dsad-original-research")
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--max-total-gib", type=float, default=21)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        asset = select_assets(json.loads(args.catalog.read_text()), [args.asset],
                              "noncommercial-research")[0]
        if not args.execute:
            print(json.dumps({"dry_run": True, "asset": asset}, indent=2))
            return 0
        receipt = parallel_acquire(
            asset, args.destination, max_bytes=int(args.max_total_gib * 1024**3),
            reserve_bytes=2 * 1024**3, workers=args.workers,
            purpose="noncommercial-research",
            opener=ReviewedRedirectOpener(asset["allowed_hosts"]),
            progress=lambda row: print(json.dumps(row), file=sys.stderr, flush=True),
        )
        print(json.dumps(receipt), flush=True)
        return 0
    except (AcquisitionError, OSError, ValueError, KeyError) as exc:
        print(f"Tissue v3 acquisition failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
