#!/usr/bin/env python3
"""Acquire one catalog archive with bounded, ETag-pinned parallel HTTPS ranges.

Uses native curl with certificate verification. Existing single-stream .part
files are preserved; range chunks resume independently from local hash receipts.
No extraction or training. Run only after another download of this asset stops.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if __package__:
    from .acquire_tissue_datasets import (
        CATALOG,
        CHUNK,
        AcquisitionError,
        CurlResponse,
        acquire,
        atomic_json,
        check_url,
        select_assets,
        validate_archive,
    )
else:
    from acquire_tissue_datasets import (
        CATALOG,
        CHUNK,
        AcquisitionError,
        CurlResponse,
        acquire,
        atomic_json,
        check_url,
        select_assets,
        validate_archive,
    )


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def reject_symlinks(*paths: Path) -> None:
    for path in paths:
        if path.is_symlink():
            raise AcquisitionError(f"Refusing symlink: {path}")


def locked_asset_error(lock_path: Path) -> AcquisitionError:
    return AcquisitionError(
        f"Asset is locked: {lock_path}. No existing lock or download bytes were removed. "
        "Another Colab kernel or local process may still be writing this archive. "
        "Before manual recovery, confirm that ALL kernels/processes using this exact destination "
        "are stopped; a PID from a previous VM is not proof of inactivity. Inspect and preserve "
        "the lock metadata (older locks may contain only a PID). Only after confirming the writer "
        "is inactive, manually remove this specific stale .lock file and rerun. Preserve range "
        "chunks, manifests, receipts and partial archives: resume rechecks source ETag and chunk "
        "SHA256, or fully verifies a published archive. Interrupted acquisition recovery is "
        "separate from training checkpoint resume."
    )


def request_range(asset: dict[str, Any], start: int, end: int, *, opener,
                  validator: str | None = None):
    headers = {"User-Agent": "VISCERA-dataset-acquisition/1.0", "Accept-Encoding": "identity",
               "Range": f"bytes={start}-{end}"}
    if validator is not None:
        headers["If-Match"] = validator
    return opener(urllib.request.Request(asset["url"], headers=headers),
                  limit=end - start + 1, timeout=60)


def check_range(response, asset: dict[str, Any], start: int, end: int,
                *, validator: str | None = None, total: int | None = None) -> tuple[int, str]:
    check_url(response.geturl(), asset["allowed_hosts"])
    if response.status != 206:
        raise AcquisitionError(f"Range server returned {response.status}; HTTP 206 required")
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
    if not match or int(match[1]) != start or int(match[2]) != end:
        raise AcquisitionError("Range response has an incorrect Content-Range")
    actual_total = int(match[3])
    if actual_total <= end or (total is not None and actual_total != total):
        raise AcquisitionError("Range object total changed")
    etag = response.headers.get("ETag", "")
    if not re.fullmatch(r'"[^"\r\n]+"', etag) or (validator is not None and etag != validator):
        raise AcquisitionError("A matching strong ETag is required for all ranges")
    length = response.headers.get("Content-Length")
    if length is not None and int(length) != end - start + 1:
        raise AcquisitionError("Range Content-Length mismatch")
    if response.headers.get("Content-Encoding", "identity") != "identity":
        raise AcquisitionError("Encoded range responses are not supported")
    content_type = response.headers.get("Content-Type", "").lower()
    if "text/html" in content_type or "application/json" in content_type:
        raise AcquisitionError("Range server returned a page instead of archive bytes")
    return actual_total, etag


def parallel_acquire(asset: dict[str, Any], destination: Path, *, max_bytes: int,
                     reserve_bytes: int = 1024**3, workers: int = 8,
                     chunk_bytes: int = 64 * 1024**2,
                     purpose: str = "commercial-compatible", opener=None,
                     progress=None) -> dict[str, Any]:
    select_assets({"assets": [asset]}, [asset["id"]], purpose)
    if not 1 <= workers <= 8 or chunk_bytes <= 0 or max_bytes <= 0 or reserve_bytes < 0:
        raise AcquisitionError("Workers must be 1..8; byte limits positive; reserve nonnegative")
    limit = min(max_bytes, asset["max_bytes"])
    destination = destination.expanduser().resolve()
    if not destination.is_dir():
        raise AcquisitionError("Destination must already exist")
    folder = destination / asset["id"]
    reject_symlinks(folder)
    folder.mkdir(exist_ok=True)
    target = folder / asset["filename"]
    receipt_path = target.with_name(target.name + ".provenance.json")
    lock_path = target.with_name(target.name + ".lock")
    fallback = target.with_name(target.name + ".part")
    assembly = target.with_name(target.name + ".parallel.part")
    reject_symlinks(target, receipt_path, lock_path, fallback, assembly)
    if lock_path.exists():
        # Includes legacy single-stream/PID-only locks and interrupted publication.
        # Never infer inactivity from a PID on another machine or delete the lock.
        raise locked_asset_error(lock_path)
    if target.exists():
        return acquire(asset, destination, max_bytes=limit, reserve_bytes=reserve_bytes,
                       purpose=purpose)
    try:
        lock = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise locked_asset_error(lock_path) from exc
    opener = opener or CurlResponse
    cancel = threading.Event()
    try:
        with os.fdopen(lock, "w") as stream:
            json.dump({"schema": "viscera.dataset-acquisition-writer/v1", "pid": os.getpid(),
                       "hostname": platform.node(), "created_utc": datetime.now(timezone.utc).isoformat(),
                       "asset_id": asset["id"], "source_url": asset["url"],
                       "destination": str(target)}, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        with request_range(asset, 0, 0, opener=opener) as response:
            total, etag = check_range(response, asset, 0, 0)
            if total > limit or asset.get("expected_bytes") not in (None, total):
                raise AcquisitionError("Publisher/server size exceeds budget or differs from catalog")
            if len(response.read(2)) != 1 or response.read(1):
                raise AcquisitionError("Invalid one-byte range probe")
        # At peak, chunks and assembled archive coexist. Existing fallback data is
        # already charged against free space and is never incorporated or deleted.
        if shutil.disk_usage(destination).free < 2 * total + reserve_bytes:
            raise AcquisitionError("Insufficient disk space for chunks plus atomic assembly")
        identity = hashlib.sha256(
            f"{asset['url']}\n{etag}\n{total}\n{chunk_bytes}".encode()).hexdigest()[:20]
        staging = folder / (target.name + ".ranges-" + identity)
        reject_symlinks(staging)
        staging.mkdir(exist_ok=True)
        manifest = {"source_url": asset["url"], "etag": etag, "total_bytes": total,
                    "chunk_bytes": chunk_bytes, "workers": workers}
        manifest_path = staging / "manifest.json"
        reject_symlinks(manifest_path)
        atomic_json(manifest_path, manifest)
        spans = [(start, min(start + chunk_bytes, total) - 1)
                 for start in range(0, total, chunk_bytes)]

        def fetch(span: tuple[int, int]) -> Path:
            start, end = span
            size = end - start + 1
            chunk = staging / f"{start:012d}-{end:012d}.bin"
            temp = chunk.with_name(chunk.name + ".part")
            metadata = chunk.with_name(chunk.name + ".json")
            reject_symlinks(chunk, temp, metadata)
            if chunk.exists() and metadata.exists():
                saved = json.loads(metadata.read_text())
                if (saved.get("etag") == etag and saved.get("source_url") == asset["url"]
                        and saved.get("start") == start and saved.get("end") == end
                        and chunk.stat().st_size == size
                        and saved.get("sha256") == digest_file(chunk)):
                    return chunk
            if cancel.is_set():
                raise AcquisitionError("Another range failed; transfer cancelled")
            try:
                with request_range(asset, start, end, opener=opener, validator=etag) as response:
                    check_range(response, asset, start, end, validator=etag, total=total)
                    digest = hashlib.sha256()
                    written = 0
                    with temp.open("wb") as stream:
                        while True:
                            if cancel.is_set():
                                raise AcquisitionError("Another range failed; transfer cancelled")
                            block = response.read(min(CHUNK, size - written + 1))
                            if not block:
                                break
                            if written + len(block) > size:
                                raise AcquisitionError("Range exceeded its assigned byte budget")
                            # Reserve assembly capacity as well as the requested free reserve.
                            if shutil.disk_usage(destination).free < total + reserve_bytes + workers * CHUNK:
                                raise AcquisitionError("Disk reserve reached during range download")
                            stream.write(block)
                            digest.update(block)
                            written += len(block)
                        stream.flush()
                        os.fsync(stream.fileno())
                    if written != size:
                        raise AcquisitionError("Truncated range; incomplete chunk retained")
                atomic_json(metadata, {"source_url": asset["url"], "etag": etag,
                                       "start": start, "end": end, "bytes": size,
                                       "sha256": digest.hexdigest()})
                os.replace(temp, chunk)
                if progress:
                    progress({"chunk_complete": [start, end], "bytes": size, "total_bytes": total})
                return chunk
            except BaseException:
                cancel.set()
                raise

        with ThreadPoolExecutor(max_workers=workers) as pool:
            # Bounded workers; each task streams to disk. Results remain ordered for assembly.
            try:
                chunks = list(pool.map(fetch, spans))
            except BaseException:
                cancel.set()
                raise
        # Re-probe to detect an origin update after the last range, before publication.
        with request_range(asset, 0, 0, opener=opener, validator=etag) as response:
            check_range(response, asset, 0, 0, validator=etag, total=total)
            if len(response.read(2)) != 1 or response.read(1):
                raise AcquisitionError("Invalid final range probe")
        if shutil.disk_usage(destination).free < total + reserve_bytes:
            raise AcquisitionError("Insufficient free space for final assembly")
        with assembly.open("wb") as stream:
            for chunk in chunks:
                with chunk.open("rb") as source:
                    for block in iter(lambda: source.read(CHUNK), b""):
                        if shutil.disk_usage(destination).free < reserve_bytes + len(block):
                            raise AcquisitionError("Disk reserve reached during archive assembly")
                        stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
        measured = validate_archive(assembly, {**asset, "expected_bytes": total}, limit)
        receipt = {"schema_version": 1, "asset_id": asset["id"], "dataset_id": asset["dataset_id"],
                   "source_url": asset["url"], "retrieved_utc": datetime.now(timezone.utc).isoformat(),
                   "license": asset["license"], "license_sources": asset["license_sources"],
                   "citation": asset["citation"], "purpose": purpose,
                   "allowed_purposes": asset["allowed_purposes"], "source_snapshot": asset,
                   "path": str(target), "reused": False, "transport": "curl-parallel-ranges",
                   "http_etag": etag, "range_manifest": manifest,
                   "single_stream_partial_preserved": str(fallback) if fallback.exists() else None,
                   **measured}
        atomic_json(receipt_path, receipt)
        os.replace(assembly, target)
        # Only remove exact files created for successful ranges; retain manifest as evidence.
        for chunk in chunks:
            chunk.unlink()
            chunk.with_name(chunk.name + ".json").unlink()
        return receipt
    finally:
        cancel.set()
        lock_path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--asset", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--chunk-mib", type=int, default=64)
    parser.add_argument("--max-total-gib", type=float, default=5)
    parser.add_argument("--reserve-gib", type=float, default=1)
    parser.add_argument("--purpose", choices=["commercial-compatible", "noncommercial-research"],
                        default="commercial-compatible")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        catalog = json.loads(args.catalog.read_text())
        asset = select_assets(catalog, [args.asset], args.purpose)[0]
        if not args.execute:
            print(json.dumps({"dry_run": True, "asset": asset, "workers": args.workers,
                              "max_total_gib": args.max_total_gib,
                              "scratch_space": "Up to two archive copies plus existing fallback"}, indent=2))
            return 0
        receipt = parallel_acquire(
            asset, args.destination, max_bytes=int(args.max_total_gib * 1024**3),
            reserve_bytes=int(args.reserve_gib * 1024**3), workers=args.workers,
            chunk_bytes=args.chunk_mib * 1024**2, purpose=args.purpose,
            progress=lambda value: print(json.dumps(value), file=sys.stderr, flush=True))
        print(json.dumps(receipt), flush=True)
        return 0
    except (AcquisitionError, OSError, ValueError, KeyError) as exc:
        print(f"Parallel acquisition failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
