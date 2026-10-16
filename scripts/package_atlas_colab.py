"""Build the independent atlas Colab bundle with exact source/data checksums.

No legacy archives or trained weights are overwritten. All dataset attribution
files are carried through unchanged. Run from the viscera directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def package(dataset: Path, output: Path, source_only: bool = False) -> dict[str, object]:
    """Write a reproducible ZIP and verify every archived file against its source."""
    included = set(ROOT.glob("py/viscera_core/**/*.py"))
    included.update(ROOT.glob("pipelines/**/__init__.py"))
    included.update(ROOT.glob("data/sheets/**/*"))
    for name in (
        "pyproject.toml",
        "uv.lock",
        "notebooks/requirements-colab.txt",
        "notebooks/requirements-atlas-language-colab.txt",
        "notebooks/VISCERA_atlas_dataset_and_training.ipynb",
        "notebooks/VISCERA_atlas_text_to_spec_training.ipynb",
        "pipelines/train/viscera_train/atlas_shape.py",
        "pipelines/train/viscera_train/atlas_language.py",
        "scripts/build_atlas_notebook.py",
        "scripts/build_atlas_language_notebook.py",
        "scripts/package_atlas_colab.py",
        "scripts/evaluate_atlas_release.py",
        "scripts/qa_atlas_model_samples.py",
        "tests/python/test_atlas_training.py",
        "tests/python/test_atlas_language_training.py",
        "docs/ATLAS_TRAINING.md",
        "docs/ATLAS_LANGUAGE_TRAINING.md",
    ):
        included.add(ROOT / name)
    if source_only:
        templates = ROOT / "datasets/atlas/templates-v2"
        if not templates.is_dir():
            raise ValueError("Source-only bundle requires prepared templates-v2")
        included.update(templates.rglob("*"))
    else:
        if not (dataset / "release.json").is_file():
            raise ValueError("Build the immutable atlas cohort before packaging")
        if not dataset.resolve().is_relative_to(ROOT):
            raise ValueError("Dataset must be inside the viscera project")
        included.update(dataset.rglob("*"))
        language = ROOT / "datasets/atlas/language-v1"
        if (language / "release.json").is_file():
            included.update(language.rglob("*"))
    files = sorted(path for path in included if path.is_file())
    for path in files:
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise ValueError(f"Refusing external/symlink source: {path}")
    missing = [path for path in included if not path.exists()]
    if missing:
        raise ValueError(f"Bundle source missing: {missing}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(".tmp")
    manifest = {str(Path("viscera") / p.relative_to(ROOT)): sha256(p) for p in files}
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in files:
            member = str(Path("viscera") / path.relative_to(ROOT))
            info = zipfile.ZipInfo(member, date_time=(2026, 10, 6, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
        info = zipfile.ZipInfo(
            "viscera/atlas-bundle-manifest.json", date_time=(2026, 10, 6, 0, 0, 0)
        )
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, json.dumps({"artifact_hashes": manifest}, indent=2) + "\n")
    with zipfile.ZipFile(temp) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP integrity check failed")
        for name, expected in manifest.items():
            if hashlib.sha256(archive.read(name)).hexdigest() != expected:
                raise ValueError(f"ZIP content mismatch: {name}")
    temp.replace(output)
    result: dict[str, object] = {
        "sha256": sha256(output),
        "files": len(files),
        "bytes": output.stat().st_size,
        "source_only": source_only,
        "dataset": str(dataset.relative_to(ROOT)) if not source_only else None,
    }
    output.with_suffix(".sha256.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=ROOT / "datasets/atlas/cohort-v2")
    parser.add_argument(
        "--out", type=Path, default=ROOT / "artifacts/colab/viscera-atlas-colab.zip"
    )
    parser.add_argument("--source-only", action="store_true")
    args = parser.parse_args()
    print(
        json.dumps(
            package(args.dataset.resolve(), args.out.resolve(), args.source_only),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
