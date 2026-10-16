"""Reproducible material-v2 source/data/model bundle, separate from frozen atlas archives."""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def main() -> None:
    required = [
        "pyproject.toml",
        "uv.lock",
        "notebooks/requirements-material-colab.txt",
        "notebooks/VISCERA_material_dataset_and_training.ipynb",
        "notebooks/VISCERA_atlas_dataset_and_training.ipynb",
        "datasets/atlas/material-v1/release.json",
        "datasets/atlas/cohort-v2/release.json",
        "artifacts/atlas/material-run-v1/model.npz",
        "artifacts/atlas/material-run-v1/model.json",
        "docs/ATLAS_MATERIAL_ARCHITECTURE.md",
        "docs/ATLAS_MATERIAL_FIELDS.md",
        "pipelines/train/viscera_train/atlas_material.py",
        "pipelines/train/viscera_train/atlas_shape.py",
        "scripts/package_material_colab.py",
    ]
    for name in required:
        if not (ROOT / name).is_file():
            raise ValueError(f"Material bundle source missing: {name}")
    included = {ROOT / name for name in required}
    for pattern in (
        "py/viscera_core/*.py",
        "pipelines/**/__init__.py",
        "services/**/*.py",
        "scripts/*material*.py",
        "tests/python/test_atlas_material*.py",
        "tests/python/test_atlas_surface_scene.py",
        "tests/python/test_atlas_surface_normals.py",
        "tests/python/test_atlas_integration.py",
        "docs/ATLAS_MATERIAL*.md",
        "data/sheets/**/*",
        "datasets/atlas/cohort-v2/**/*",
        "datasets/atlas/material-v1/**/*",
        "artifacts/atlas/material-run-v1/**/*",
    ):
        included.update(ROOT.glob(pattern))
    files = sorted(p for p in included if p.is_file() and "__pycache__" not in p.parts)
    if any(p.is_symlink() or not p.resolve().is_relative_to(ROOT) for p in files):
        raise ValueError("Bundle must contain only regular project files")
    output = ROOT / "artifacts/colab/viscera-material-colab.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(".tmp")
    manifest = {"viscera/" + str(p.relative_to(ROOT)): digest(p) for p in files}
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in files:
            info = zipfile.ZipInfo("viscera/" + str(path.relative_to(ROOT)), (2026, 10, 7, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
        info = zipfile.ZipInfo("viscera/material-bundle-manifest.json", (2026, 10, 7, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, json.dumps({"artifact_hashes": manifest}, indent=2) + "\n")
    with zipfile.ZipFile(temp) as archive:
        if archive.testzip() is not None:
            raise ValueError("Material bundle ZIP integrity failure")
        for name, expected in manifest.items():
            if hashlib.sha256(archive.read(name)).hexdigest() != expected:
                raise ValueError(f"Material bundle hash mismatch: {name}")
    temp.replace(output)
    receipt = {
        "sha256": digest(output),
        "files": len(files),
        "bytes": output.stat().st_size,
        "format": "material-colab-bundle-1.0.0",
        "all_members_hash_verified": True,
        "scope": "material source, Colab, frozen shape parent, material recipes and trained model",
    }
    output.with_suffix(".sha256.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
