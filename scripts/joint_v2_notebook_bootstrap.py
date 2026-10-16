"""Standard-library-only, checksum-bound expanded-disease Colab setup helpers."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


def file_digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def extract_package(archive_path: Path, expected: str, destination: Path, prefix: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or file_digest(archive_path) != expected:
        raise ValueError("Archive does not match this notebook: " + archive_path.name)
    destination.mkdir(parents=True, exist_ok=True)
    root = destination / prefix
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        names = [item.filename for item in entries]
        if (
            len(names) != len(set(names))
            or len(entries) > 10000
            or sum(i.file_size for i in entries) > 12_000_000_000
        ):
            raise ValueError("Archive entry count or expanded size is invalid")
        for item in entries:
            parts = item.filename.split("/")
            if (
                len(parts) < 2
                or parts[0] != prefix
                or any(p in ("", ".", "..") for p in parts)
                or "\\" in item.filename
                or ":" in item.filename
                or item.flag_bits & 1
                or item.is_dir()
                or stat.S_IFMT(item.external_attr >> 16) not in (0, stat.S_IFREG)
            ):
                raise ValueError("Unsafe ZIP member")
        manifest_name = prefix + "/package-manifest.json"
        manifest_bytes = archive.read(manifest_name)
        manifest = json.loads(manifest_bytes)
        hashes = manifest.get("artifact_hashes", {})
        if manifest.get("format") != "viscera-joint-package-v1" or not hashes:
            raise ValueError("Missing package manifest")
        if set(names) != {manifest_name} | {prefix + "/" + key for key in hashes}:
            raise ValueError("Package has extra or missing members")

        def verify(target: Path) -> None:
            if target.is_symlink() or any(p.is_symlink() for p in target.rglob("*")):
                raise ValueError("Extraction must not contain symlinks")
            if (target / "package-manifest.json").read_bytes() != manifest_bytes:
                raise ValueError("Cached package manifest differs from the pinned archive")
            actual = {p.relative_to(target).as_posix() for p in target.rglob("*") if p.is_file()}
            if actual != set(hashes) | {"package-manifest.json"}:
                raise ValueError("Extraction has extra or missing files")
            for name, sha in hashes.items():
                path = target / name
                if (
                    path.is_symlink()
                    or not path.resolve().is_relative_to(target.resolve())
                    or file_digest(path) != sha
                ):
                    raise ValueError("Extracted file checksum mismatch: " + name)

        if root.exists():
            verify(root)
            return root
        temporary = Path(tempfile.mkdtemp(prefix=".joint-extract-", dir=destination))
        try:
            for item in entries:
                target = temporary.joinpath(*PurePosixPath(item.filename).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
            verify(temporary / prefix)
            (temporary / prefix).replace(root)
        finally:
            shutil.rmtree(temporary)
    return root


def install_environment(root: Path, environment: Path) -> Path:
    override = os.environ.get("VISCERA_TRAIN_PYTHON")
    # Resolving a venv's interpreter symlink would silently select the base
    # interpreter and install into the wrong environment (PEP 668 on macOS).
    python = Path(override).expanduser().absolute() if override else environment / "bin/python"
    if not override:
        if not python.is_file():
            result = subprocess.run([sys.executable, "-m", "venv", str(environment)])
            if result.returncode:
                subprocess.run(
                    [sys.executable, "-m", "pip", "install", "virtualenv==20.35.3"], check=True
                )
                subprocess.run([sys.executable, "-m", "virtualenv", str(environment)], check=True)
        host = subprocess.run(
            [
                sys.executable,
                "-c",
                "import torch,json; print(json.dumps({'version':torch.__version__.split('+')[0],'cuda':torch.version.cuda,'available':torch.cuda.is_available()}))",
            ],
            capture_output=True,
            text=True,
        )
        info = (
            json.loads(host.stdout)
            if host.returncode == 0
            else {"version": "2.11.0", "cuda": None, "available": False}
        )
        if not re.fullmatch(r"2\.\d+\.\d+", info["version"]):
            raise ValueError("Unsupported host PyTorch version")
        variant = (
            "cu" + info["cuda"].replace(".", "") if info["available"] and info["cuda"] else "cpu"
        )
        command = [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "torch==" + info["version"],
        ]
        if sys.platform == "linux":
            command += ["--index-url", "https://download.pytorch.org/whl/" + variant]
        subprocess.run(command, check=True)
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            str(root / "notebooks/requirements-joint-v2-colab.txt"),
        ],
        check=True,
    )
    subprocess.run(
        [
            str(python),
            "-c",
            "import numpy,scipy,torch,trimesh,pydantic; print('Joint training dependencies ready; CUDA:', torch.cuda.is_available())",
        ],
        check=True,
    )
    return python


def verify_weights(path: Path, receipt: dict) -> str:
    actual = file_digest(path)
    if receipt.get("status") != "complete" or receipt.get("weights_sha256") != actual:
        raise ValueError("Weight export did not complete or its checksum changed")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        prefix = "viscera-joint-v2-weights/"
        if len(entries) > 1000 or sum(entry.file_size for entry in entries) > 512 * 1024 * 1024:
            raise ValueError("Joint weight archive exceeds its size limit")
        for entry in entries:
            parts = entry.filename.split("/")
            if (
                len(parts) < 2
                or parts[0] != prefix[:-1]
                or any(p in ("", ".", "..") for p in parts)
                or "\\" in entry.filename
                or ":" in entry.filename
                or entry.flag_bits & 1
                or entry.is_dir()
                or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG)
            ):
                raise ValueError("Unsafe weight archive member")
        manifest = json.loads(archive.read(prefix + "manifest.json"))
        hashes = manifest.get("artifact_hashes", {})
        required = {
            "model.npz",
            "model.json",
            "training_report.json",
            "exact-renderer-audit.json",
            "data/baseline-release.json",
            "data/disease-release.json",
        }
        if (
            manifest.get("format") != "viscera-joint-flow-v2"
            or manifest.get("smoke_only") is not False
            or manifest.get("profile") != "full"
            or not required <= hashes.keys()
            or len(names) != len(set(names))
            or set(names) != {prefix + "manifest.json"} | {prefix + k for k in hashes}
        ):
            raise ValueError("Invalid joint weight archive")
        for relative, expected in hashes.items():
            if hashlib.sha256(archive.read(prefix + relative)).hexdigest() != expected:
                raise ValueError("Weight member checksum mismatch")
        if hashlib.sha256(archive.read(prefix + "manifest.json")).hexdigest() != receipt.get(
            "export_manifest_sha256"
        ):
            raise ValueError("Export manifest changed after completion")
        audit = json.loads(archive.read(prefix + "exact-renderer-audit.json"))
        if audit.get("passed") is not True:
            raise ValueError("Exact renderer checks did not pass")
    return actual
