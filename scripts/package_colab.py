"""Build a portable source archive without caches, credentials or local databases."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = (
    "py",
    "pipelines",
    "notebooks",
    "services",
    "tests",
    "docs",
    "scripts",
    "assets",
    "licences",
)
SOURCE_FILES = ("pyproject.toml", "uv.lock", ".python-version", "README.md")
EXTENSIONS = {
    ".py",
    ".json",
    ".jsonl",
    ".md",
    ".txt",
    ".ipynb",
    ".yaml",
    ".toml",
    ".npz",
    ".ply",
    ".ts",
    ".mjs",
}


def package(output: Path, include_dataset: bool = False) -> dict[str, object]:
    """Archive exact sources with per-file digests and deterministic ZIP metadata."""
    files = [ROOT / name for name in SOURCE_FILES if (ROOT / name).is_file()]
    for directory in SOURCE_DIRS:
        files.extend(
            p
            for p in (ROOT / directory).rglob("*")
            if p.is_file()
            and not p.is_symlink()
            and p.suffix in EXTENSIONS
            and "__pycache__" not in p.parts
            and ".venv" not in p.parts
        )
    if include_dataset:
        files.extend(
            p
            for p in (ROOT / "datasets/original/pilot-v1").rglob("*")
            if p.is_file() and not p.is_symlink()
        )
    files = sorted(set(files))
    output.parent.mkdir(parents=True, exist_ok=True)
    hashes: dict[str, str] = {}
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in files:
            name = f"viscera/{file.relative_to(ROOT).as_posix()}"
            data = file.read_bytes()
            hashes[name] = hashlib.sha256(data).hexdigest()
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
        manifest = {
            "bundle_version": "0.1.0",
            "contains_dataset": include_dataset,
            "review_status": "unreviewed_synthetic_development",
            "files": hashes,
        }
        info = zipfile.ZipInfo("MANIFEST.json", (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, json.dumps(manifest, indent=2))
    report: dict[str, object] = {
        "path": str(output),
        "bytes": output.stat().st_size,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "file_count": len(files),
        "includes_dataset": include_dataset,
    }
    output.with_suffix(".sha256.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=ROOT / "artifacts/colab/viscera-colab-source.zip"
    )
    parser.add_argument("--include-dataset", action="store_true")
    args = parser.parse_args()
    print(json.dumps(package(args.output, args.include_dataset), indent=2))
