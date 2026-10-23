#!/usr/bin/env python3
"""Publish a verified, manifest-only tissue snapshot without changing its source.

Usage: python scripts/stage_tissue_library.py SOURCE NEW_TARGET > receipt.json
The receipt is written to stdout, not into the snapshot. Unreferenced files and
empty directories are inventoried but never copied. This verifies declared bytes,
not image semantics or clinical realism; use audit_tissue_library.py for the former.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO


def _relative(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or any(c in value for c in ("\\", ":", "\x00"))
        or PurePosixPath(value).is_absolute()
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        raise ValueError(f"unsafe relative path: {value!r}")
    return value


def _open_file(root_fd: int, relative: str) -> BinaryIO:
    """Resolve each component with no-follow handles, including during source races."""
    parts = _relative(relative).split("/")
    current = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise ValueError(f"not a regular source file: {relative}")
        return os.fdopen(fd, "rb")
    finally:
        os.close(current)


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _json(root_fd: int, relative: str) -> tuple[dict[str, Any], bytes]:
    with _open_file(root_fd, relative) as handle:
        raw = handle.read()
    parsed = json.loads(raw, object_pairs_hook=_object)
    if not isinstance(parsed, dict):
        raise ValueError(f"expected JSON object: {relative}")
    return parsed, raw


def _scan(source: Path) -> tuple[dict[str, int], list[str]]:
    files: dict[str, int] = {}
    directories: list[str] = []

    def fail(error: OSError) -> None:
        raise error

    for parent, dirs, names in os.walk(source, followlinks=False, onerror=fail):
        for name in sorted(dirs + names):
            path = Path(parent) / name
            relative = path.relative_to(source).as_posix()
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise ValueError(f"source symlinks are forbidden: {relative}")
            if stat.S_ISDIR(mode):
                directories.append(relative)
            elif stat.S_ISREG(mode):
                files[relative] = path.stat().st_size
            else:
                raise ValueError(f"source special files are forbidden: {relative}")
    return files, sorted(directories)


def _publish(stage: Path, target: Path) -> None:
    """Atomic no-replace rename; plain os.rename can replace an empty directory."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        args = (os.fsencode(stage), os.fsencode(target), 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                           ctypes.c_char_p, ctypes.c_uint]
        args = (-100, os.fsencode(stage), -100, os.fsencode(target), 1)  # RENAME_NOREPLACE
    else:
        raise RuntimeError("exclusive atomic publication requires macOS or Linux renameat2")
    rename.restype = ctypes.c_int
    if rename(*args) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))


def stage_library(source: Path, target: Path) -> dict[str, Any]:
    """Copy exactly the catalog closure, verifying all declarations before publication."""
    source, target = Path(source), Path(target)
    if source.is_symlink():
        raise ValueError("source root must not be a symlink")
    source = source.resolve(strict=True)
    if not source.is_dir():
        raise ValueError("source must be a directory")
    target = target.parent.resolve(strict=True) / target.name
    if target.is_relative_to(source):
        raise ValueError("target must be outside source")
    if os.path.lexists(target):
        raise FileExistsError(f"target already exists: {target}")
    scanned, directories = _scan(source)
    root_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    stage: Path | None = None
    try:
        catalog, catalog_raw = _json(root_fd, "catalog.json")
        entries = catalog.get("materials")
        if (catalog.get("schema") != "viscera.tissue-catalog/v1"
                or not isinstance(entries, list) or not entries):
            raise ValueError("incomplete or unsupported tissue catalog")
        metadata = {"catalog.json": catalog_raw}
        # relative path -> (expected SHA256, optional declared byte count, file kind)
        plan: dict[str, tuple[str, int | None, str]] = {
            "catalog.json": (hashlib.sha256(catalog_raw).hexdigest(), len(catalog_raw), "catalog")
        }
        identifiers: set[str] = set()
        for entry in entries:
            identifier = entry.get("id") if isinstance(entry, dict) else None
            if not isinstance(identifier, str) or not identifier or identifier in identifiers:
                raise ValueError("catalog material IDs must be nonempty and unique")
            identifiers.add(identifier)
            for variant in ("manifest", "preview"):
                relative = _relative(entry.get(variant))
                if relative in plan:
                    raise ValueError(f"duplicate manifest/file destination: {relative}")
                manifest, raw = _json(root_fd, relative)
                channels, layers = manifest.get("channels"), manifest.get("layers")
                if (manifest.get("schema") != "viscera.tissue-materials/v1"
                        or not isinstance(channels, dict) or not channels
                        or not isinstance(layers, list) or not layers):
                    raise ValueError(f"incomplete or unsupported material manifest: {relative}")
                metadata[relative] = raw
                plan[relative] = (hashlib.sha256(raw).hexdigest(), len(raw), "manifest")
                layer_ids = [layer.get("id") if isinstance(layer, dict) else None
                             for layer in layers]
                if (any(not isinstance(value, str) or not value for value in layer_ids)
                        or len(set(layer_ids)) != len(layer_ids)):
                    raise ValueError(f"layer IDs must be nonempty and unique: {relative}")
                for declaration in [*channels.values(), *layers]:
                    if not isinstance(declaration, dict):
                        raise ValueError(f"invalid asset declaration: {relative}")
                    asset = (PurePosixPath(relative).parent
                             / _relative(declaration.get("file"))).as_posix()
                    digest, size = declaration.get("sha256"), declaration.get("bytes")
                    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                        raise ValueError(f"missing or invalid SHA256: {asset}")
                    if "bytes" in declaration and (type(size) is not int or size < 0):
                        raise ValueError(f"invalid declared byte count: {asset}")
                    spec = (digest, size, "asset")
                    if asset in plan and plan[asset] != spec:
                        raise ValueError(f"conflicting file declarations: {asset}")
                    plan[asset] = spec
        stage = Path(tempfile.mkdtemp(prefix=f".{target.name}.stage-", dir=target.parent))
        copied: list[dict[str, Any]] = []
        for relative, (expected, size, kind) in sorted(plan.items()):
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest, count = hashlib.sha256(), 0
            with _open_file(root_fd, relative) as src, destination.open("xb") as dst:
                while chunk := src.read(1024 * 1024):
                    digest.update(chunk)
                    count += len(chunk)
                    dst.write(chunk)
            if digest.hexdigest() != expected:
                raise ValueError(f"SHA256 mismatch: {relative}")
            if size is not None and count != size:
                raise ValueError(f"byte count mismatch: {relative}: {count} != {size}")
            copied.append({"path": relative, "sha256": expected, "bytes": count, "kind": kind})
        # Catch catalog/manifest replacement during a long native-map copy. Asset
        # hashes already establish a coherent declared snapshot, even if extra
        # unreferenced files arrive after the point-in-time inventory.
        for relative, expected_raw in metadata.items():
            with _open_file(root_fd, relative) as handle:
                if handle.read() != expected_raw:
                    raise ValueError(f"source metadata changed during staging: {relative}")
        used_directories = {parent.as_posix() for name in plan
                            for parent in PurePosixPath(name).parents if str(parent) != "."}
        ignored = sorted(set(scanned) - set(plan))
        receipt = {
            "schema": "viscera.tissue-snapshot/v1",
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "source": str(source), "target": str(target),
            "source_modified": False,
            "material_count": len(entries), "manifest_count": len(metadata) - 1,
            "copied_file_count": len(copied), "asset_count": sum(
                item["kind"] == "asset" for item in copied),
            "copied_bytes": sum(item["bytes"] for item in copied),
            "catalog_sha256": plan["catalog.json"][0], "files": copied,
            "scan": {
                "scope": "point-in-time source tree inventory; symlinks and special files rejected",
                "regular_file_count": len(scanned), "directory_count": len(directories),
                "ignored_unreferenced_file_count": len(ignored),
                "ignored_unreferenced_bytes": sum(scanned[name] for name in ignored),
                "ignored_unreferenced_paths": ignored,
                "ignored_unreferenced_directories": sorted(set(directories) - used_directories),
            },
            "validation": "declared file integrity only; image semantics and realism not assessed",
            "publication": "exclusive atomic directory rename",
        }
        _publish(stage, target)
        stage = None
        return receipt
    finally:
        os.close(root_fd)
        if stage is not None:
            shutil.rmtree(stage)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path, help="new directory; parent must already exist")
    args = parser.parse_args()
    try:
        receipt = stage_library(args.source, args.target)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Tissue snapshot failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
