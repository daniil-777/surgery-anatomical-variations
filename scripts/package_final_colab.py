"""Audit and package the six frozen VISCERA releases without pretrained weights.

Run with PYTHONPATH=py from the project directory. Only the explicitly selected
data roots may resolve outside this checkout (resident immutable release mounts).
ZIP entries themselves are regular files; no symlink is shipped or extracted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import tempfile
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FORMAT = "viscera-final-colab-bundle-v1"
DATASET_PATHS = {
    "shape": "datasets/atlas/cohort-v2",
    "material": "datasets/atlas/material-v1",
    "language": "datasets/atlas/language-v1",
    "disease_recipes": "disease-releases/recipes-v2",
    "disease_geometry": "disease-releases/geometry-v1",
    "clinical": "disease-releases/clinical-ccby-v3",
}
SPLITS = ("train", "val", "audit")


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def encoded(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()


def rows(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def disjoint(groups: dict[str, set[str]], label: str) -> None:
    for i, split in enumerate(SPLITS):
        for other in SPLITS[i + 1 :]:
            if groups[split] & groups[other]:
                raise ValueError(f"Split leakage in {label}: {split}/{other}")


def audit_data(root: Path = ROOT) -> dict[str, Any]:
    import numpy as np
    from viscera_core import atlas_dataset as shape
    from viscera_core import atlas_disease_dataset as clinical
    from viscera_core import atlas_disease_geometry_dataset as geometry
    from viscera_core import atlas_disease_recipe_dataset as recipes
    from viscera_core import atlas_language as language
    from viscera_core import atlas_material_dataset as material

    paths = {key: root / value for key, value in DATASET_PATHS.items()}
    releases = {
        "shape": shape.verify_release(paths["shape"]),
        "material": material.verify_material_release(paths["material"], paths["shape"]),
        "language": language.verify_language(paths["language"], paths["shape"]),
        "disease_recipes": recipes.verify_release(paths["disease_recipes"]),
        "disease_geometry": geometry.verify_release(paths["disease_geometry"]),
        "clinical": clinical.verify_release(paths["clinical"]),
    }
    if releases["disease_geometry"]["parent_recipe_release_sha256"] != digest(
        paths["disease_recipes"] / "release.json"
    ):
        raise ValueError("Disease geometry parent recipe release mismatch")
    if releases["disease_geometry"]["template_hashes"] != releases["shape"]["template_hashes"]:
        raise ValueError("Disease geometry and shape templates differ")
    if releases["clinical"]["rights"]["contains_noncommercial"]:
        raise ValueError("Default bundle forbids noncommercial clinical data")

    catalog = json.loads((paths["shape"] / "templates/catalog.json").read_text())
    templates = catalog["templates"]
    if any(t["license"] != "CC-BY-4.0" or not t["attribution_verified"] for t in templates):
        raise ValueError("Template attribution/license requires review")
    clinical_rows = rows(paths["clinical"] / "manifest.jsonl")
    if any(row["license_lane"] != "attribution" for row in clinical_rows):
        raise ValueError("Clinical license lane requires review")

    reports: dict[str, Any] = {}
    for lane, path in paths.items():
        groups: dict[str, set[str]] = {}
        sample_ids: dict[str, set[str]] = {}
        counts = {}
        for split in SPLITS:
            if lane == "language":
                data_rows = rows(path / f"{split}.jsonl")
                groups[split] = {r["group_id"] for r in data_rows}
                sample_ids[split] = {r["example_id"] for r in data_rows}
                n = len(data_rows)
                if any(r["split"] != split for r in data_rows):
                    raise ValueError("Language split field mismatch")
            else:
                if lane == "material":
                    data = material.read_split(path, split)
                elif lane == "disease_recipes":
                    data = recipes.read_split(path, split)
                elif lane == "clinical":
                    data = clinical.read_split(path, split)
                else:
                    with np.load(path / f"{split}.npz", allow_pickle=False) as source:
                        data = {key: source[key] for key in source.files}
                key = "case_ids" if lane == "clinical" else "sample_ids"
                n = len(data[key])
                sample_ids[split] = set(map(str, data[key]))
                groups[split] = set(map(str, data["group_ids"]))
                if lane == "shape":
                    for name in ("controls", "points_mm", "point_normals"):
                        if not np.isfinite(data[name]).all():
                            raise ValueError(f"Nonfinite shape {name}")
                    mask = data["condition_mask"]
                    if (
                        mask.shape != data["conditions"].shape
                        or not np.isfinite(data["conditions"][mask]).all()
                    ):
                        raise ValueError("Invalid masked shape measurements")
            if len(sample_ids[split]) != n:
                raise ValueError(f"Duplicate identities in {lane}/{split}")
            counts[split] = n
        disjoint(groups, lane + " recipe/patient groups")
        disjoint(sample_ids, lane + " sample identities")
        files = [p for p in path.rglob("*") if p.is_file()]
        reports[lane] = {
            "path": DATASET_PATHS[lane],
            "release_id": releases[lane]["release_id"],
            "release_sha256": digest(path / "release.json"),
            "split_counts": counts,
            "samples": sum(counts.values()),
            "files": len(files),
            "uncompressed_bytes": sum(p.stat().st_size for p in files),
            "artifact_hashes_verified": True,
            "sample_and_recipe_groups_disjoint": True,
        }

    # Every language derivative remains with its exact shape parent.
    parent_splits = {r["sample_id"]: r["split"] for r in rows(paths["shape"] / "manifest.jsonl")}
    for split in SPLITS:
        for pair in rows(paths["language"] / f"{split}.jsonl"):
            if parent_splits[pair["parent_sample_id"]] != split:
                raise ValueError("Language derivative leaked across its shape parent split")

    return {
        "format": "viscera-final-data-audit-v1",
        "as_of": "2026-10-07",
        "releases": reports,
        "template_count": len(templates),
        "organs": sorted({t["organ"] for t in templates}),
        "supported_disease_profiles": releases["disease_recipes"]["profile_count"],
        "reference_only_disease_profiles": releases["disease_recipes"][
            "reference_only_profile_ids"
        ],
        "clinical_patient_count": releases["clinical"]["case_count"],
        "clinical_train_patient_count": reports["clinical"]["split_counts"]["train"],
        "clinical_organs": sorted({row["organ"] for row in clinical_rows}),
        "third_party_geometry_licenses": sorted({t["license"] for t in templates}),
        "clinical_rights": releases["clinical"]["rights"],
        "patient_generalization_validated": False,
        "measured_material_or_physics_labels": False,
        "pretrained_weights_included": False,
        "cross_lane_parent_links_verified": True,
        "limitations": [
            "Synthetic recipe splits share anatomical source templates; they are not independent patient splits.",
            "Twenty-four display templates are not twenty-four independent patients or certified simulation volumes.",
            "Material fields and disease strengths are authored visual controls, not measured optical/mechanical/clinical targets.",
            "The clinical lane has three pancreatic tumor cases: one training, one validation, one audit.",
            "BodyParts3D millimetre scale remains an explicit source-unit assumption.",
            "No blanket license is assigned to project code or third-party content; retain source notices.",
        ],
    }


def member_name(name: str) -> str:
    path = PurePosixPath(name)
    if (
        "\\" in name
        or path.is_absolute()
        or ":" in name
        or ".." in path.parts
        or not path.parts
        or path.parts[0] != "viscera"
        or str(path) != name
    ):
        raise ValueError(f"Unsafe archive path: {name}")
    return name


def verify_archive(archive_path: Path, extract_to: Path | None = None) -> dict[str, Any]:
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        names = [member_name(info.filename) for info in infos]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate archive members")
        if sum(info.file_size for info in infos) > 2_000_000_000:
            raise ValueError("Archive exceeds the expected uncompressed size budget")
        for info in infos:
            if info.is_dir() or stat.S_IFMT(info.external_attr >> 16) != stat.S_IFREG:
                raise ValueError("Archive entries must be regular files")
        manifest_name = "viscera/final-bundle-manifest.json"
        manifest = json.loads(archive.read(manifest_name))
        if manifest.get("format") != FORMAT or manifest.get("dataset_paths") != DATASET_PATHS:
            raise ValueError("Unexpected bundle contract")
        expected_names = {"viscera/" + name for name in manifest["artifact_hashes"]}
        if set(names) != expected_names | {manifest_name}:
            raise ValueError("Archive contents differ from the exact manifest")
        if archive.testzip() is not None:
            raise ValueError("ZIP CRC verification failed")
        for name, sha in manifest["artifact_hashes"].items():
            full_name = member_name("viscera/" + name)
            payload = archive.read(full_name)
            if hashlib.sha256(payload).hexdigest() != sha:
                raise ValueError(f"Bundle member SHA256 mismatch: {name}")
        if extract_to is not None:
            if extract_to.exists() and any(extract_to.iterdir()):
                raise ValueError("Extraction destination must be empty")
            extract_to.mkdir(parents=True, exist_ok=True)
            for name in names:
                output = extract_to / name
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(archive.read(name))
        return manifest


def source_files(root: Path) -> list[Path]:
    required = [
        "pyproject.toml",
        "uv.lock",
        "scripts/package_final_colab.py",
        "scripts/dev.mjs",
        "scripts/final_train.py",
        "tests/python/test_final_training.py",
        "notebooks/requirements-final-colab.txt",
        "docs/FINAL_DATA_AUDIT.md",
    ]
    missing = [name for name in required if not (root / name).is_file()]
    if missing:
        raise ValueError(f"Required final bundle files missing: {missing}")
    included = {root / name for name in required}
    for pattern in (
        "py/viscera_core/*.py",
        "py/viscera_core/*.json",
        "pipelines/**/__init__.py",
        "pipelines/train/viscera_train/atlas_*.py",
        "services/**/*.py",
        "tests/python/*.py",
        "docs/ATLAS*.md",
        "docs/DISEASE*.md",
        "docs/FINAL*.md",
        "docs/COLAB*.md",
        "scripts/final*.py",
        "scripts/build_final*.py",
        "scripts/qa_atlas_model_samples.py",
        "scripts/qa_material_prior.py",
        "scripts/qa_disease_model.py",
        "scripts/evaluate_atlas_release.py",
        "notebooks/requirements-final*.txt",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.base.json",
        "vitest.config.ts",
        "playwright*.config.ts",
        "apps/studio/*.html",
        "apps/studio/*.json",
        "apps/studio/*.ts",
        "apps/studio/src/**/*",
        "apps/studio/public/*.json",
        "packages/**/*",
        "tests/e2e/**/*",
    ):
        included.update(path for path in root.glob(pattern) if path.is_file())
    for path in included:
        if (
            not path.is_file()
            or path.is_symlink()
            or not path.resolve().is_relative_to(root.resolve())
        ):
            raise ValueError(f"Invalid code source file: {path}")
    for relative in DATASET_PATHS.values():
        release = root / relative
        for path in release.rglob("*"):
            if path.is_symlink() or not path.resolve().is_relative_to(release.resolve()):
                raise ValueError(f"Unapproved symlink inside frozen release: {path}")
            if path.is_file():
                included.add(path)
    return sorted(included)


def package(root: Path, output: Path) -> dict[str, Any]:
    audit = audit_data(root)
    files = source_files(root)
    payloads = {str(p.relative_to(root)): p.read_bytes() for p in files}
    payloads["bundle-data-audit.json"] = encoded(audit)
    inventory = "# VISCERA final training data — 2026-10-07\n\n"
    inventory += "Six immutable releases, executable source and tests. The companion Run-all notebook is distributed separately so it can pin this archive's checksum. No pretrained weights.\n\n"
    inventory += "| Lane | Train | Validation | Audit | Release |\n|---|---:|---:|---:|---|\n"
    for lane, report in audit["releases"].items():
        count = report["split_counts"]
        inventory += f"| {lane} | {count['train']} | {count['val']} | {count['audit']} | `{report['release_id']}` |\n"
    inventory += "\n" + "\n".join("- " + item for item in audit["limitations"]) + "\n"
    inventory += "\nSource attribution: `datasets/atlas/cohort-v2/templates/ATTRIBUTIONS.md`; clinical provenance and dataset card: `disease-releases/clinical-ccby-v3/`. This default archive contains no KiTS19 data, surgical videos, reference photographs or research PDFs.\n"
    payloads["FINAL_BUNDLE_README.md"] = inventory.encode()
    hashes = {name: hashlib.sha256(payload).hexdigest() for name, payload in payloads.items()}
    duplicate_counts = Counter(hashes.values())
    manifest = {
        "format": FORMAT,
        "dataset_paths": DATASET_PATHS,
        "artifact_hashes": hashes,
        "pretrained_weights_included": False,
        "clinical_rights": audit["clinical_rights"],
        "immutable_releases_preserved": True,
        "duplicate_content_entries": sum(n - 1 for n in duplicate_counts.values()),
        "duplication_policy": "Identical template and parent snapshots retained as regular files for independent immutable verifiers.",
    }
    payloads["final-bundle-manifest.json"] = encoded(manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(".tmp")
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, payload in sorted(payloads.items()):
            info = zipfile.ZipInfo(member_name("viscera/" + name), (2026, 10, 7, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, payload)
    verify_archive(temp)
    with tempfile.TemporaryDirectory(prefix="viscera-final-extract-") as directory:
        extracted = Path(directory)
        verify_archive(temp, extracted)
        extracted_audit = audit_data(extracted / "viscera")
        if extracted_audit != audit:
            raise ValueError("Extracted data audit differs from source audit")
    temp.replace(output)
    receipt = {
        "format": FORMAT,
        "filename": output.name,
        "sha256": digest(output),
        "bytes": output.stat().st_size,
        "files": len(payloads),
        "uncompressed_bytes": sum(map(len, payloads.values())),
        "all_members_hash_verified": True,
        "isolated_extract_data_verified": True,
        "pretrained_weights_included": False,
        "dataset_paths": DATASET_PATHS,
    }
    output.with_suffix(".sha256.json").write_bytes(encoded(receipt))
    output.with_suffix(".sha256").write_text(f"{receipt['sha256']}  {output.name}\n")
    output.with_suffix(".inventory.md").write_text(inventory)
    (output.parent / "data-audit.json").write_bytes(encoded(audit))
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "artifacts/final-colab/viscera-final-dataset-2026-10-07.zip",
    )
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--verify", type=Path)
    args = parser.parse_args()
    if args.verify:
        manifest = verify_archive(args.verify)
        print(
            json.dumps(
                {"format": manifest["format"], "verified_files": len(manifest["artifact_hashes"])}
            )
        )
    elif args.audit_only:
        result = audit_data(args.root)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        (args.out.parent / "data-audit.json").write_bytes(encoded(result))
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(package(args.root, args.out), indent=2))


if __name__ == "__main__":
    main()
