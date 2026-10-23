#!/usr/bin/env python3
"""Acquire explicitly selected, reviewed source archives without extracting or training.

Defaults are a dry run and a 2 GiB aggregate byte ceiling. Existing artifacts are
rehashed before reuse. Interrupted HTTP transfers resume only with a validator.
No package dependencies; network and storage permissions remain the caller's.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

CATALOG = Path(__file__).resolve().parents[1] / "research/tissue-materials/datasets.json"
CHUNK = 1024 * 1024


class AcquisitionError(ValueError):
    """An archive could not be safely acquired or validated."""


def check_url(url: str, hosts: list[str]) -> None:
    parsed = urlparse(url)
    if (parsed.scheme != "https" or parsed.hostname not in hosts
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise AcquisitionError(f"Unapproved download URL: {url}")


class ApprovedRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts: list[str]):
        self.hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl, self.hosts)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class CurlResponse:
    """Stream a verified native-curl HTTPS response through the same validation path.

    Never follows redirects, ignores curlrc, never invokes a shell. This is useful
    where Apple's trust store can validate a chain absent from Python's CA bundle.
    """

    def __init__(self, request: urllib.request.Request, *, limit: int, timeout: int):
        executable = "/usr/bin/curl" if Path("/usr/bin/curl").is_file() else "curl"
        command = [executable, "--disable", "--silent", "--show-error", "--http1.1",
                   "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "0",
                   "--connect-timeout", str(timeout), "--speed-time", "60", "--speed-limit", "1",
                   "--max-filesize", str(limit), "--include", "--output", "-"]
        for name, value in request.header_items():
            command.extend(["--header", f"{name}: {value}"])
        command.extend(["--url", request.full_url])
        self.url = request.full_url
        self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # A proxy CONNECT response and HTTP interim responses may precede the
            # origin status. Bound both the number and length of header sections.
            for _ in range(8):
                line = self.process.stdout.readline(8193)
                match = re.fullmatch(rb"HTTP/\d(?:\.\d)? (\d{3}) ([^\r\n]*)\r?\n", line)
                if not match:
                    self._check_exit()
                    raise AcquisitionError("curl returned an invalid HTTP status line")
                self.status = int(match[1])
                self.headers = http.client.parse_headers(self.process.stdout)
                if self.status < 200 or b"connection established" in match[2].lower():
                    continue
                break
            else:
                raise AcquisitionError("Too many intermediate HTTP responses")
        except BaseException:
            self.close()
            raise

    def _check_exit(self) -> None:
        code = self.process.wait(timeout=5)
        if code:
            message = self.process.stderr.read(4096).decode("utf-8", errors="replace").strip()
            raise AcquisitionError(f"Native curl transfer failed ({code}): {message}")

    def read(self, size: int) -> bytes:
        data = self.process.stdout.read(size)
        if not data:
            self._check_exit()
        return data

    def geturl(self) -> str:
        return self.url

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temp = path.with_name(path.name + ".tmp")
    if temp.is_symlink():
        raise AcquisitionError(f"Refusing symlink: {temp}")
    with temp.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def validate_archive(path: Path, asset: dict[str, Any], limit: int) -> dict[str, Any]:
    size = path.stat().st_size
    if size <= 0 or size > limit:
        raise AcquisitionError("Archive size is empty or exceeds byte budget")
    if asset.get("expected_bytes") is not None and size != asset["expected_bytes"]:
        raise AcquisitionError("Archive does not match publisher byte count")
    digests = {"sha256": hashlib.sha256(), "md5": hashlib.md5(usedforsecurity=False)}
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            for digest in digests.values():
                digest.update(chunk)
    values = {name: digest.hexdigest() for name, digest in digests.items()}
    publisher_verified = []
    for name in values:
        expected = asset.get("checksums", {}).get(name)
        if expected:
            if values[name] != expected.lower():
                raise AcquisitionError(f"Publisher {name} checksum mismatch")
            publisher_verified.append(name)
    archive_info: dict[str, Any] = {}
    if asset.get("format") == "zip":
        try:
            with zipfile.ZipFile(path) as archive:
                members = archive.infolist()
                expanded = sum(item.file_size for item in members)
                if (len(members) > asset.get("max_members", 200000)
                        or expanded > asset.get("max_uncompressed_bytes", 8 * limit)):
                    raise AcquisitionError("ZIP expansion or member count exceeds validation budget")
                if any(item.flag_bits & 1 for item in members):
                    raise AcquisitionError("Encrypted archive is not a reviewed open dataset")
                # Reads bounded chunks, validates CRC; never extracts archive paths.
                bad_member = archive.testzip()
                if bad_member:
                    raise AcquisitionError(f"ZIP CRC mismatch: {bad_member}")
                archive_info = {"members": len(members), "uncompressed_bytes": expanded,
                                "crc_verified": True}
        except (zipfile.BadZipFile, RuntimeError, EOFError) as exc:
            raise AcquisitionError(f"Invalid ZIP: {exc}") from exc
    return {"bytes": size, "sha256": values["sha256"], "md5": values["md5"],
            "publisher_checksums_verified": publisher_verified,
            "integrity_scope": "publisher_checksum" if publisher_verified else "local_hash_only",
            "archive": archive_info}


def select_assets(catalog: dict[str, Any], ids: list[str], purpose: str) -> list[dict[str, Any]]:
    if not ids or len(set(ids)) != len(ids):
        raise AcquisitionError("Select one or more unique asset IDs")
    available = {item["id"]: item for item in catalog["assets"]}
    selected = []
    for identifier in ids:
        if identifier not in available:
            raise AcquisitionError(f"Unknown asset: {identifier}")
        asset = available[identifier]
        if asset.get("access") != "direct" or purpose not in asset.get("allowed_purposes", []):
            raise AcquisitionError(f"Asset {identifier} is not approved for {purpose}")
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", identifier):
            raise AcquisitionError("Unsafe asset ID")
        name = asset["filename"]
        if Path(name).name != name or name in (".", "..") or "\\" in name:
            raise AcquisitionError("Unsafe asset filename")
        check_url(asset["url"], asset["allowed_hosts"])
        if not isinstance(asset.get("max_bytes"), int) or asset["max_bytes"] <= 0:
            raise AcquisitionError("Asset must have a positive byte ceiling")
        selected.append(asset)
    return selected


def acquire(asset: dict[str, Any], destination: Path, *, max_bytes: int,
            reserve_bytes: int = 1024**3, purpose: str = "commercial-compatible",
            opener=None, ca_bundle: Path | None = None,
            transport: str = "urllib") -> dict[str, Any]:
    """Download one asset under an exclusive lock, returning a durable receipt."""
    select_assets({"assets": [asset]}, [asset["id"]], purpose)
    if transport not in ("urllib", "curl"):
        raise AcquisitionError("Unknown HTTP transport")
    limit = min(max_bytes, asset["max_bytes"])
    if limit <= 0 or reserve_bytes < 0:
        raise AcquisitionError("Byte budget must be positive and reserve nonnegative")
    destination = destination.expanduser().resolve()
    if not destination.is_dir():
        raise AcquisitionError("Destination must already exist; mounted drives are never created")
    folder = destination / asset["id"]
    if folder.is_symlink():
        raise AcquisitionError("Asset directory cannot be a symlink")
    folder.mkdir(exist_ok=True)
    target = folder / asset["filename"]
    partial = target.with_name(target.name + ".part")
    state_path = target.with_name(target.name + ".part.json")
    receipt_path = target.with_name(target.name + ".provenance.json")
    lock_path = target.with_name(target.name + ".lock")
    for path in (target, partial, state_path, receipt_path, lock_path):
        if path.is_symlink():
            raise AcquisitionError(f"Refusing symlink: {path}")
    try:
        lock = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise AcquisitionError(f"Acquisition already locked: {lock_path}") from exc
    try:
        with os.fdopen(lock, "w") as stream:
            stream.write(str(os.getpid()))
        if target.exists():
            if not receipt_path.exists():
                raise AcquisitionError("Existing archive has no receipt; refusing untracked reuse")
            previous = json.loads(receipt_path.read_text())
            if previous.get("source_url") != asset["url"]:
                raise AcquisitionError("Existing receipt belongs to a different source")
            measured = validate_archive(target, asset, limit)
            if measured["sha256"] != previous.get("sha256"):
                raise AcquisitionError("Existing archive differs from its provenance receipt")
            return {**previous, "reused": True}

        if asset.get("expected_bytes", 0) and asset["expected_bytes"] > limit:
            raise AcquisitionError("Publisher size exceeds remaining byte budget")
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        offset = partial.stat().st_size if partial.exists() else 0
        validator = state.get("validator") if state.get("source_url") == asset["url"] else None
        # Unvalidated partials are restarted, never spliced into unknown objects.
        if not validator:
            offset = 0
        if offset > limit:
            raise AcquisitionError("Partial archive exceeds remaining byte budget")
        headers = {"User-Agent": "VISCERA-dataset-acquisition/1.0", "Accept-Encoding": "identity"}
        if offset:
            headers.update({"Range": f"bytes={offset}-", "If-Range": validator})
        request = urllib.request.Request(asset["url"], headers=headers)
        handlers = [ApprovedRedirects(asset["allowed_hosts"])]
        if ca_bundle is not None and transport == "urllib":
            handlers.append(urllib.request.HTTPSHandler(
                context=ssl.create_default_context(cafile=str(ca_bundle))))
        if opener is not None:
            open_url = opener
        elif transport == "curl":
            def open_url(request, timeout):
                return CurlResponse(request, limit=limit, timeout=timeout)
        else:
            open_url = urllib.request.build_opener(*handlers).open
        with open_url(request, timeout=60) as response:
            check_url(response.geturl(), asset["allowed_hosts"])
            status = response.status
            if status not in (200, 206):
                raise AcquisitionError(f"Unexpected HTTP status {status}")
            if response.headers.get("Content-Encoding", "identity") != "identity":
                raise AcquisitionError("Encoded HTTP transfer is incompatible with byte validation")
            content_type = response.headers.get("Content-Type", "").lower()
            if "text/html" in content_type or "application/json" in content_type:
                raise AcquisitionError("Server returned a page instead of a data archive")
            etag = response.headers.get("ETag")
            new_validator = etag if etag and not etag.startswith("W/") else response.headers.get("Last-Modified")
            length = response.headers.get("Content-Length")
            received_length = int(length) if length is not None else None
            total = None
            if status == 206:
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                if not offset or not match or int(match[1]) != offset:
                    raise AcquisitionError("Invalid resume Content-Range")
                start, end, total = map(int, match.groups())
                if (end < start or end + 1 != total or new_validator != validator
                        or (received_length is not None and received_length != end - start + 1)):
                    raise AcquisitionError("Resume response does not match the validated object")
            else:
                offset = 0  # Server may ignore Range or changed object under If-Range.
                total = received_length
            if total is not None and (total <= 0 or total > limit):
                raise AcquisitionError("Server size exceeds byte budget or is empty")
            if total is not None and asset.get("expected_bytes") not in (None, total):
                raise AcquisitionError("Server size differs from publisher byte count")
            needed = (total if total is not None else limit) - offset
            if shutil.disk_usage(destination).free < needed + reserve_bytes:
                raise AcquisitionError("Insufficient free disk space including reserve")
            # Set the state only after truncation: a crash must never associate a new
            # validator with bytes from a previous object.
            with partial.open("ab" if offset else "wb") as stream:
                atomic_json(state_path, {"source_url": asset["url"], "validator": new_validator})
                written = offset
                while True:
                    chunk = response.read(min(CHUNK, limit - written + 1))
                    if not chunk:
                        break
                    if written + len(chunk) > limit:
                        raise AcquisitionError("Streaming response exceeds byte budget")
                    if shutil.disk_usage(destination).free < len(chunk) + reserve_bytes:
                        raise AcquisitionError("Free disk space fell below reserve")
                    stream.write(chunk)
                    written += len(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            if total is not None and written != total:
                raise AcquisitionError("Truncated HTTP response; partial retained for resume")
        measured = validate_archive(partial, asset, limit)
        receipt = {"schema_version": 1, "asset_id": asset["id"],
                   "dataset_id": asset["dataset_id"], "source_url": asset["url"],
                   "retrieved_utc": datetime.now(timezone.utc).isoformat(),
                   "license": asset["license"], "license_sources": asset["license_sources"],
                   "citation": asset["citation"], "purpose": purpose,
                   "transport": transport,
                   "allowed_purposes": asset["allowed_purposes"],
                   "source_snapshot": asset, "path": str(target), "reused": False, **measured}
        # Publish receipt before data: a crash can leave an unused receipt, but never
        # a completed-looking archive whose provenance was not written.
        atomic_json(receipt_path, receipt)
        os.replace(partial, target)
        state_path.unlink(missing_ok=True)
        return receipt
    finally:
        lock_path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--asset", action="append", default=[])
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--purpose", choices=["commercial-compatible", "noncommercial-research"],
                        default="commercial-compatible")
    parser.add_argument("--max-total-gib", type=float, default=2)
    parser.add_argument("--reserve-gib", type=float, default=1)
    parser.add_argument("--ca-bundle", type=Path,
                        help="Trusted CA bundle for urllib; curl uses native trust. TLS remains verified")
    parser.add_argument("--transport", choices=["urllib", "curl"], default="urllib",
                        help="Native curl supports OS trust stores and rejects all redirects")
    parser.add_argument("--execute", action="store_true", help="Download; otherwise show the plan")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args(argv)
    try:
        catalog = json.loads(args.catalog.read_text())
        if args.list:
            print(json.dumps(catalog["assets"], indent=2))
            return 0
        selected = select_assets(catalog, args.asset, args.purpose)
        budget = int(args.max_total_gib * 1024**3)
        reserve = int(args.reserve_gib * 1024**3)
        if budget <= 0 or reserve < 0:
            raise AcquisitionError("Invalid disk/byte budget")
        if not args.execute:
            print(json.dumps({"dry_run": True, "max_total_bytes": budget,
                              "destination": str(args.destination), "assets": selected}, indent=2))
            return 0
        if args.destination is None:
            raise AcquisitionError("--destination is required for execution")
        for asset in selected:
            result = acquire(asset, args.destination, max_bytes=budget,
                             reserve_bytes=reserve, purpose=args.purpose, ca_bundle=args.ca_bundle,
                             transport=args.transport)
            budget -= result["bytes"]  # Aggregate retained payload, including reused files.
            print(json.dumps(result), flush=True)
        return 0
    except (AcquisitionError, OSError, ValueError, KeyError) as exc:
        print(f"Acquisition failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
