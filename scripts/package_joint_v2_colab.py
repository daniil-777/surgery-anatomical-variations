"""Package immutable expanded-disease data and matching Colab source code."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

from viscera_core.atlas_joint_v2 import RENDERER_PATHS, digest, verify_release


def write_archive(output: Path, prefix: str, files: dict[str, Path]) -> dict:
    """Stream multi-gigabyte datasets without loading a whole split into RAM."""
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "format": "viscera-joint-package-v1",
        "prefix": prefix,
        "artifact_hashes": {name: digest(path) for name, path in sorted(files.items())},
    }
    if output.exists():
        with zipfile.ZipFile(output) as archive:
            names = {prefix + "/" + name for name in files} | {prefix + "/package-manifest.json"}
            if (
                len(archive.infolist()) != len(names)
                or set(archive.namelist()) != names
                or json.loads(archive.read(prefix + "/package-manifest.json")) != manifest
            ):
                raise ValueError("Refusing to replace a different release archive: " + str(output))
            for name, expected in manifest["artifact_hashes"].items():
                checksum = hashlib.sha256()
                with archive.open(prefix + "/" + name) as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        checksum.update(chunk)
                if checksum.hexdigest() != expected:
                    raise ValueError("Existing release archive is damaged: " + str(output))
        return {
            "filename": output.name,
            "prefix": prefix,
            "sha256": digest(output),
            "bytes": output.stat().st_size,
            "files": len(files),
        }
    temporary = output.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            for name, path in sorted(files.items()):
                info = zipfile.ZipInfo(prefix + "/" + name, date_time=(2026, 10, 7, 0, 0, 0))
                info.external_attr = 0o100644 << 16
                # NPZ already compresses its arrays. Recompressing adds CPU cost
                # with negligible space savings on these surface-query targets.
                info.compress_type = (
                    zipfile.ZIP_STORED if path.suffix == ".npz" else zipfile.ZIP_DEFLATED
                )
                with (
                    path.open("rb") as source,
                    archive.open(info, "w", force_zip64=True) as destination,
                ):
                    shutil.copyfileobj(source, destination, length=1024 * 1024)
            info = zipfile.ZipInfo(
                prefix + "/package-manifest.json", date_time=(2026, 10, 7, 0, 0, 0)
            )
            info.external_attr = 0o100644 << 16
            archive.writestr(info, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        temporary.replace(output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return {
        "filename": output.name,
        "prefix": prefix,
        "sha256": digest(output),
        "bytes": output.stat().st_size,
        "files": len(files),
    }


def _preflight(root: Path, baseline: Path, disease: Path, templates: Path) -> dict:
    """Reject incompatible source bundles before expensive archives or training."""
    checked = {}
    for lane, directory in (("baseline", baseline), ("disease", disease)):
        release = verify_release(directory)
        catalog = json.loads((directory / "catalog.json").read_text())
        conditions = catalog.get("conditions", [])
        if (
            release.get("recipe", {}).get("lane") != lane
            or not conditions
            or any((c.get("profile_id") == "baseline") != (lane == "baseline") for c in conditions)
        ):
            raise ValueError("Incorrect dataset lane: " + lane)
        required = {"dataset_card.json", "reference_catalog.json"}
        if not required <= release["artifact_hashes"].keys():
            raise ValueError("Dataset export provenance is incomplete: " + lane)
        hashes = release.get("renderer_hashes", {})
        if set(hashes) != set(RENDERER_PATHS):
            raise ValueError("Dataset must bind every runtime renderer source: " + lane)
        for relative, expected in hashes.items():
            path = root / relative
            if not path.is_file() or path.is_symlink() or digest(path) != expected:
                raise ValueError("Runtime renderer differs from frozen dataset: " + relative)
        ids = {c.get("template_id") for c in conditions}
        for field, extension in (
            ("template_hashes", ".npz"),
            ("template_metadata_hashes", ".json"),
        ):
            expected = release.get(field, {})
            if set(expected) != ids:
                raise ValueError("Dataset template provenance is incomplete: " + lane)
            for identifier, checksum in expected.items():
                if (
                    not isinstance(identifier, str)
                    or Path(identifier).name != identifier
                    or "\\" in identifier
                ):
                    raise ValueError("Unsafe dataset template identifier")
                source = templates / (identifier + extension)
                if not source.is_file() or source.is_symlink() or digest(source) != checksum:
                    raise ValueError("Packaged template differs from frozen dataset: " + identifier)
        builder = next(
            (
                path
                for path in (
                    root / "py/viscera_core/atlas_joint_dataset_v2.py",
                    root / "artifacts/joint-v2/dataset-builder-at-release.py",
                )
                if path.is_file()
                and not path.is_symlink()
                and digest(path) == release.get("builder_sha256")
            ),
            None,
        )
        if builder is None:
            raise ValueError("Matching frozen dataset builder is unavailable: " + lane)
        checked[lane] = (release, builder)
    return checked


def package(
    root: Path, baseline: Path, disease: Path, templates: Path, evidence: Path, out: Path
) -> dict:
    checked = _preflight(root, baseline, disease, templates)
    out.mkdir(parents=True, exist_ok=True)
    packages = {}
    counts = {}
    for lane, directory in (("baseline", baseline), ("disease", disease)):
        release, builder = checked[lane]
        files = {name: directory / name for name in release["artifact_hashes"]}
        files["release.json"] = directory / "release.json"
        files["provenance/dataset-builder.py"] = builder
        packages[lane] = write_archive(
            out
            / f"viscera-joint-v2-{lane}-2026-10-07-{digest(directory / 'release.json')[:8]}.zip",
            lane,
            files,
        )
        counts[lane] = release
    files = {
        p.relative_to(root).as_posix(): p
        for p in (root / "py/viscera_core").glob("*")
        if p.suffix in (".py", ".json")
    }
    for relative in (
        "pipelines/train/viscera_train/joint_v2.py",
        "scripts/joint_v2_train.py",
        "scripts/qa_joint_model_v2.py",
        "notebooks/requirements-joint-v2-colab.txt",
    ):
        files[relative] = root / relative
    for path in templates.rglob("*"):
        if path.is_symlink():
            raise ValueError("Template package must not contain symlinks")
        if path.is_file():
            files["templates/" + path.relative_to(templates).as_posix()] = path
    for path in (root / "docs").glob("JOINT_V2*.md"):
        files[path.relative_to(root).as_posix()] = path
    architecture = root / "docs/JOINT_FLOW_V2_ARCHITECTURE.md"
    if architecture.is_file():
        files[architecture.relative_to(root).as_posix()] = architecture
    packages["runtime"] = write_archive(
        out / "viscera-joint-v2-runtime-2026-10-07.zip", "viscera", files
    )
    evidence_files = {}
    for path in evidence.rglob("*"):
        if path.is_symlink():
            raise ValueError("Evidence package must not contain symlinks")
        if path.is_file() and "__pycache__" not in path.parts:
            evidence_files[path.relative_to(evidence).as_posix()] = path
    usage = root / "artifacts/joint-v2/evidence_usage_receipt.json"
    if usage.is_file():
        evidence_files["post-freeze/evidence_usage_receipt.json"] = usage
    supplement = (
        write_archive(
            out / "viscera-joint-v2-open-evidence-2026-10-07.zip", "evidence", evidence_files
        )
        if evidence_files
        else None
    )
    result = {
        "format": "viscera-joint-colab-release-v2",
        "packages": packages,
        "evidence": supplement,
        "drive_folder": "VISCERA Expanded Disease Training RC2 2026-10-07",
        "datasets": counts,
    }
    (out / "release-index.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("root", "baseline", "disease", "templates", "evidence", "out"):
        parser.add_argument("--" + flag, required=True, type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            package(
                args.root, args.baseline, args.disease, args.templates, args.evidence, args.out
            ),
            indent=2,
        )
    )
