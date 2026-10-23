"""Immutable tensor-only checkpoints with JSON structure; no pickle or remote code."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

from .config import canonical


def digest(path: Path) -> str:
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(canonical(value) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def save_checkpoint(root: Path, state: dict, request: dict) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    destination = root / f"step-{state['step']:09d}"
    if destination.exists():
        raise FileExistsError(f"immutable checkpoint already exists: {destination}")
    temporary = Path(tempfile.mkdtemp(prefix=".checkpoint-", dir=root))
    tensors: dict[str, torch.Tensor] = {}

    def pack(value):
        if isinstance(value, torch.Tensor):
            name = f"tensor_{len(tensors):06d}"
            tensors[name] = value.detach().cpu().contiguous().clone()
            return {"type": "tensor", "name": name}
        if isinstance(value, dict):
            return {"type": "dict", "items": [[pack(k), pack(v)] for k, v in value.items()]}
        if isinstance(value, (list, tuple)):
            return {"type": "tuple" if isinstance(value, tuple) else "list", "items": [pack(x) for x in value]}
        if value is None or type(value) in (str, int, float, bool):
            return {"type": "scalar", "value": value}
        raise TypeError(f"unsupported checkpoint state: {type(value)}")

    try:
        atomic_json(temporary / "state.json", pack(state))
        save_file(tensors, str(temporary / "tensors.safetensors"))
        manifest = {"schema": "viscera.tissue-checkpoint/v1", "request": request,
                    "files": {name: {"sha256": digest(temporary / name),
                                     "bytes": (temporary / name).stat().st_size}
                              for name in ("state.json", "tensors.safetensors")}}
        atomic_json(temporary / "manifest.json", manifest)
        temporary.rename(destination)
        atomic_json(root / "latest.json", {"directory": destination.name,
                                           "manifest_sha256": digest(destination / "manifest.json")})
        return destination
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def load_checkpoint(path: Path) -> tuple[dict, dict]:
    path = Path(path)
    manifest = json.loads((path / "manifest.json").read_text())
    if manifest.get("schema") != "viscera.tissue-checkpoint/v1" or set(manifest.get("files", {})) != {"state.json", "tensors.safetensors"}:
        raise ValueError("invalid checkpoint manifest")
    for name, record in manifest["files"].items():
        file = path / name
        if file.is_symlink() or file.stat().st_size != record["bytes"] or digest(file) != record["sha256"]:
            raise ValueError("checkpoint integrity failure")
    tensors = load_file(str(path / "tensors.safetensors"), device="cpu")
    referenced: set[str] = set()

    def unpack(value):
        kind = value["type"]
        if kind == "tensor":
            referenced.add(value["name"])
            return tensors[value["name"]]
        if kind == "dict":
            return {unpack(k): unpack(v) for k, v in value["items"]}
        if kind in ("tuple", "list"):
            result = [unpack(x) for x in value["items"]]
            return tuple(result) if kind == "tuple" else result
        if kind == "scalar" and (value["value"] is None or type(value["value"]) in (str, int, float, bool)):
            return value["value"]
        raise ValueError("invalid checkpoint structure")

    state = unpack(json.loads((path / "state.json").read_text()))
    if referenced != set(tensors):
        raise ValueError("checkpoint has unreferenced tensors")
    if any(not torch.isfinite(t).all() for t in tensors.values() if t.is_floating_point()):
        raise ValueError("nonfinite checkpoint tensor")
    return state, manifest["request"]


def latest_checkpoint(root: Path) -> Path:
    pointer = json.loads((root / "latest.json").read_text())
    name = pointer.get("directory", "")
    if not name.startswith("step-") or "/" in name or "\\" in name:
        raise ValueError("invalid checkpoint pointer")
    path = root / name
    if path.is_symlink() or digest(path / "manifest.json") != pointer["manifest_sha256"]:
        raise ValueError("checkpoint pointer integrity failure")
    return path


def mirror_checkpoint(checkpoint: Path, destination_root: Path) -> Path:
    """Copy a complete verified snapshot, then publish the restart pointer last.

    Drive mount durability is provider-dependent. A new kernel verifies all hashes
    and ignores incomplete .transfer directories rather than trusting a filename.
    """
    load_checkpoint(checkpoint)
    destination_root.mkdir(parents=True, exist_ok=True)
    destination = destination_root / checkpoint.name
    if destination.exists():
        if digest(destination / "manifest.json") != digest(checkpoint / "manifest.json"):
            raise ValueError("conflicting mirrored checkpoint")
        load_checkpoint(destination)
    else:
        temporary = Path(tempfile.mkdtemp(prefix=".transfer-", dir=destination_root))
        try:
            for name in ("state.json", "tensors.safetensors", "manifest.json"):
                shutil.copyfile(checkpoint / name, temporary / name)
            load_checkpoint(temporary)
            temporary.rename(destination)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    atomic_json(destination_root / "latest.json", {"directory": destination.name,
                "manifest_sha256": digest(destination / "manifest.json")})
    return destination
