"""Freeze independent baseline/disease data and a matching Colab runtime archive."""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

from viscera_core.atlas_joint import digest, verify_release

ROOT = Path(__file__).resolve().parents[1]


def write_archive(output: Path, prefix: str, files: dict[str, Path]) -> dict:
    if output.exists():
        raise ValueError("Refusing to replace release archive: " + str(output))
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "format": "viscera-joint-package-v1",
        "prefix": prefix,
        "artifact_hashes": {name: digest(path) for name, path in sorted(files.items())},
    }
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, path in sorted(files.items()):
            info = zipfile.ZipInfo(prefix + "/" + name, date_time=(2026, 10, 7, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
        info = zipfile.ZipInfo(prefix + "/package-manifest.json", date_time=(2026, 10, 7, 0, 0, 0))
        info.external_attr = 0o100644 << 16
        archive.writestr(info, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return {
        "filename": output.name,
        "prefix": prefix,
        "sha256": digest(output),
        "bytes": output.stat().st_size,
        "files": len(files),
    }


def package(root: Path, baseline: Path, disease: Path, templates: Path, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    packages = {}
    for lane, directory in (("baseline", baseline), ("disease", disease)):
        release = verify_release(directory)
        files = {name: directory / name for name in release["artifact_hashes"]}
        files["release.json"] = directory / "release.json"
        builder_source = root / "artifacts/joint-vae/dataset-builder-at-release.py"
        if builder_source.is_file() and digest(builder_source) == release.get("builder_sha256"):
            files["provenance/dataset-builder.py"] = builder_source
        packages[lane] = write_archive(output / f"viscera-joint-{lane}-2026-10-07.zip", lane, files)
    files = {
        p.relative_to(root).as_posix(): p
        for p in (root / "py/viscera_core").glob("*")
        if p.suffix in (".py", ".json")
    }
    for relative in (
        "pipelines/train/viscera_train/joint.py",
        "scripts/joint_train.py",
        "scripts/qa_joint_model.py",
        "notebooks/requirements-joint-colab.txt",
    ):
        files[relative] = root / relative
    for p in templates.rglob("*"):
        if p.is_file():
            if p.is_symlink():
                raise ValueError("Template package cannot contain symlinks")
            files["templates/" + p.relative_to(templates).as_posix()] = p
    for relative in (
        "docs/JOINT_VAE_TRAINING.md",
        "docs/JOINT_VAE_GROUND_TRUTH.md",
        "docs/JOINT_MODEL_ARCHITECTURE.md",
        "docs/JOINT_VAE_IN_STUDIO.md",
    ):
        if (root / relative).is_file():
            files[relative] = root / relative
    packages["runtime"] = write_archive(
        output / "viscera-joint-runtime-2026-10-07.zip", "viscera", files
    )
    result = {
        "format": "viscera-joint-colab-release-v1",
        "packages": packages,
        "drive_folder": "VISCERA Joint VAE Training 2026-10-07",
    }
    (output / "release-index.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--disease", type=Path, required=True)
    parser.add_argument("--templates", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            package(args.root, args.baseline, args.disease, args.templates, args.out), indent=2
        )
    )
