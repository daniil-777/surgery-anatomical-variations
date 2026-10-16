"""Standard-library-only bootstrap embedded verbatim into the Colab notebook.

No project module is imported before the pinned ZIP and complete file manifest
are verified. Training happens in a separate interpreter, never the live kernel.
"""

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


def safe_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or path.is_absolute()
        or ":" in name
        or any(part in ("", ".", "..") for part in name.split("/"))
        or path.parts[0] != "viscera"
        or len(path.parts) < 2
    ):
        raise ValueError(f"Unsafe archive member: {name!r}")
    return path


def verify_tree(root: Path, manifest: dict) -> None:
    if root.is_symlink():
        raise ValueError("Extracted bundle root must not be a symlink")
    hashes = manifest.get("artifact_hashes")
    if not isinstance(hashes, dict) or not hashes:
        raise ValueError("Bundle manifest has no file hashes")
    actual_files = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("Symlinks are forbidden inside the extracted bundle")
        if path.is_file():
            actual_files.add(path.relative_to(root).as_posix())
    if actual_files != set(hashes) | {"final-bundle-manifest.json"}:
        raise ValueError(
            "Extracted bundle has missing or unlisted files; use a fresh work directory"
        )
    for relative, expected in hashes.items():
        safe_member("viscera/" + relative)
        path = root / relative
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Escaped manifest member: {relative}")
        if not path.is_file() or file_digest(path) != expected:
            raise ValueError(f"Corrupt or missing bundle file: {relative}")


def extract_verified(
    archive_path: Path, expected_sha256: str, destination: Path
) -> tuple[Path, dict]:
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise ValueError("This notebook must be built with a final dataset SHA-256")
    if file_digest(archive_path) != expected_sha256:
        raise ValueError(
            "Dataset ZIP does not match this notebook. Use the matching release files."
        )
    destination.mkdir(parents=True, exist_ok=True)
    root = destination / "viscera"
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        names = [item.filename for item in entries]
        if len(names) != len(set(names)) or len(entries) > 25000:
            raise ValueError("Duplicate or excessive ZIP entries")
        if sum(item.file_size for item in entries) > 2_000_000_000:
            raise ValueError("Dataset archive exceeds release size limit")
        for item in entries:
            safe_member(item.filename)
            mode = item.external_attr >> 16
            if item.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError("Only regular-file ZIP entries are accepted")
            if item.flag_bits & 1:
                raise ValueError("Encrypted ZIP entries are not supported")
        manifest_name = "viscera/final-bundle-manifest.json"
        manifest = json.loads(archive.read(manifest_name))
        if manifest.get("format") != "viscera-final-colab-bundle-v1":
            raise ValueError("Unsupported final dataset bundle format")
        required = {
            "shape",
            "material",
            "language",
            "disease_recipes",
            "disease_geometry",
            "clinical",
        }
        if set(manifest.get("dataset_paths", {})) != required:
            raise ValueError("Incomplete dataset lane contract")
        for relative in manifest["dataset_paths"].values():
            safe_member("viscera/" + relative)
        expected_names = {"viscera/" + name for name in manifest["artifact_hashes"]} | {
            manifest_name
        }
        if set(names) != expected_names:
            raise ValueError("Archive and manifest members differ")
        if root.exists():
            verify_tree(root, manifest)
            actual_manifest = json.loads((root / "final-bundle-manifest.json").read_text())
            if actual_manifest != manifest:
                raise ValueError("Existing extraction belongs to a different bundle")
            return root, manifest
        temporary = Path(tempfile.mkdtemp(prefix=".extract-", dir=destination))
        try:
            for item in entries:
                target = temporary.joinpath(*PurePosixPath(item.filename).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
            verify_tree(temporary / "viscera", manifest)
            (temporary / "viscera").rename(root)
        finally:
            shutil.rmtree(temporary)
    return root, manifest


def install_environment(root: Path, environment: Path) -> Path:
    """Use a clean venv; retain the host's working PyTorch/CUDA wheel variant."""
    override = os.environ.get("VISCERA_TRAIN_PYTHON")
    if override:
        python = Path(override).resolve()
        if not python.is_file():
            raise ValueError("VISCERA_TRAIN_PYTHON is not a Python executable")
    else:
        python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not python.exists():
            created = subprocess.run([sys.executable, "-m", "venv", str(environment)])
            if created.returncode:
                subprocess.run(
                    [sys.executable, "-m", "pip", "install", "virtualenv==20.35.3"], check=True
                )
                subprocess.run([sys.executable, "-m", "virtualenv", str(environment)], check=True)
        probe = subprocess.run(
            [
                sys.executable,
                "-c",
                "import torch,json; print(json.dumps({'version':torch.__version__.split('+')[0], 'cuda':torch.version.cuda, 'available':torch.cuda.is_available()}))",
            ],
            capture_output=True,
            text=True,
        )
        host = (
            json.loads(probe.stdout.strip())
            if probe.returncode == 0
            else {"version": "2.14.1", "cuda": None, "available": False}
        )
        version = host["version"]
        if not re.fullmatch(r"2\.\d+\.\d+", version) or tuple(map(int, version.split(".")[:2])) < (
            2,
            6,
        ):
            version = "2.14.1"
            host = {"cuda": None, "available": False}
        variant = "cpu"
        if host["available"] and host["cuda"]:
            cuda = host["cuda"].split(".")
            if len(cuda) != 2 or not all(part.isdigit() for part in cuda):
                raise ValueError("Unsupported host CUDA version")
            variant = "cu" + "".join(cuda)
        command = [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            f"torch=={version}",
        ]
        if sys.platform == "linux":
            command += ["--index-url", "https://download.pytorch.org/whl/" + variant]
        print(
            f"Installing isolated PyTorch {version} ({variant}); first setup can take several minutes.",
            flush=True,
        )
        subprocess.run(command, check=True)
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            str(root / "notebooks/requirements-final-colab.txt"),
        ],
        check=True,
    )
    # Import both training stacks in a fresh process; no live-kernel package state.
    subprocess.run(
        [
            str(python),
            "-c",
            "import numpy, scipy, torch, trimesh, pydantic, nibabel; from transformers import Qwen2ForCausalLM; from peft import LoraConfig; print('Training dependencies import successfully; CUDA:', torch.cuda.is_available())",
        ],
        check=True,
    )
    return python


def verify_weights(archive_path: Path, completion: dict) -> str:
    """Check the precise export produced by the successful training command."""
    actual = file_digest(archive_path)
    if completion.get("status") != "complete" or actual != completion.get("weights_sha256"):
        raise ValueError("Weights ZIP changed or training did not complete")
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or archive.testzip() is not None:
            raise ValueError("Export has duplicate entries or a CRC error")
        manifest_name = "viscera-weights/manifest.json"
        payload = archive.read(manifest_name)
        if hashlib.sha256(payload).hexdigest() != completion.get("export_manifest_sha256"):
            raise ValueError("Export manifest changed after verification")
        manifest = json.loads(payload)
        if manifest.get("format") != "viscera-final-training-v1":
            raise ValueError("Unknown weights format")
        hashes = manifest.get("artifact_hashes", {})
        if not hashes or set(names) != {manifest_name} | {
            "viscera-weights/" + key for key in hashes
        }:
            raise ValueError("Export and manifest members differ")
        for relative, expected in hashes.items():
            safe_member("viscera/" + relative)
            if hashlib.sha256(archive.read("viscera-weights/" + relative)).hexdigest() != expected:
                raise ValueError(f"Weights member checksum failed: {relative}")
    return actual
