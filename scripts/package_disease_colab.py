"""Package independent disease learning lanes with explicit clinical license scope."""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path
from typing import Any

from viscera_core import atlas_disease_dataset as clinical
from viscera_core import atlas_disease_geometry_dataset as geometry
from viscera_core import atlas_disease_recipe_dataset as recipes

ROOT = Path(__file__).resolve().parents[1]


def package(
    *,
    recipe_release: str = "disease-releases/recipes-v2",
    clinical_release: str = "disease-releases/clinical-ccby-v3",
    geometry_release: str = "disease-releases/geometry-v1",
    recipe_model: str = "artifacts/disease/recipes-run-v2",
    source_model: str = "artifacts/disease/clinical-ccby-run-v1",
    allow_noncommercial: bool = False,
) -> dict[str, Any]:
    from pipelines.train.viscera_train.atlas_disease import load_recipe_model, load_source_model

    selected = (recipe_release, clinical_release, geometry_release, recipe_model, source_model)
    for name in selected:
        if not (ROOT / name).resolve().is_relative_to(ROOT.resolve()):
            raise ValueError("Bundle paths must stay inside the project")
    recipes.verify_release(ROOT / recipe_release)
    clinical_release_data = clinical.verify_release(ROOT / clinical_release)
    geometry_release_data = geometry.verify_release(ROOT / geometry_release)
    if geometry_release_data["parent_recipe_release_sha256"] != recipes.digest(
        ROOT / recipe_release / "release.json"
    ):
        raise ValueError("Geometry dataset parent recipe release does not match package")
    rights = clinical_release_data["rights"]
    if rights["contains_noncommercial"] and not allow_noncommercial:
        raise ValueError("Packaging noncommercial cases requires explicit opt-in")
    model = load_recipe_model(ROOT / recipe_model / "model.npz")
    source = load_source_model(
        ROOT / source_model / "source_model.json", allow_noncommercial=allow_noncommercial
    )
    if model["dataset_hashes"]["release.json"] != recipes.digest(
        ROOT / recipe_release / "release.json"
    ):
        raise ValueError("Recipe model release does not match package")
    if source["dataset_hashes"]["release.json"] != recipes.digest(
        ROOT / clinical_release / "release.json"
    ):
        raise ValueError("Source prior release does not match package")
    required = [
        "notebooks/VISCERA_disease_variations_and_training.ipynb",
        "notebooks/requirements-disease-colab.txt",
        "notebooks/requirements-disease-test.txt",
        "pipelines/train/viscera_train/atlas_disease.py",
        "services/api/atlas_disease_model.py",
        "py/viscera_core/atlas_disease.py",
        "py/viscera_core/disease_profiles.json",
        "py/viscera_core/atlas_disease_dataset.py",
        "py/viscera_core/atlas_disease_recipe_dataset.py",
        "py/viscera_core/atlas_disease_geometry_dataset.py",
        "scripts/build_disease_notebook.py",
        "scripts/package_disease_colab.py",
        "scripts/qa_disease_model.py",
        "docs/DISEASE_TRAINING.md",
        "docs/DISEASE_SOURCE_DATASET.md",
        "artifacts/disease/geometry-replay-qa.json",
    ]
    for name in required:
        if not (ROOT / name).is_file():
            raise ValueError(f"Missing required disease bundle file: {name}")
    included = {ROOT / name for name in required}
    for pattern in (
        "py/viscera_core/*.py",
        "py/viscera_core/disease_profiles.json",
        "pipelines/**/__init__.py",
        "services/**/__init__.py",
        "services/api/atlas_disease*.py",
        "tests/python/test_atlas_disease_training.py",
        "tests/python/test_atlas_disease_dataset.py",
        "tests/python/test_atlas_disease_geometry_dataset.py",
        "docs/DISEASE*.md",
        *(name + "/**/*" for name in selected),
    ):
        included.update(ROOT.glob(pattern))
    files = sorted(
        p
        for p in included
        if p.is_file() and "__pycache__" not in p.parts and p.name != ".DS_Store"
    )
    if any(p.is_symlink() or not p.resolve().is_relative_to(ROOT.resolve()) for p in files):
        raise ValueError("Disease bundle must contain only regular project files")
    manifest = {
        "format": "viscera-disease-colab-bundle-v1",
        "recipe_release": recipe_release,
        "clinical_release": clinical_release,
        "geometry_release": geometry_release,
        "recipe_model": recipe_model,
        "source_model": source_model,
        "clinical_rights": rights,
        "scope": "authored disease recipe CVAE and separate measured clinical case prior",
        "clinical_cases_are_not_paired_with_reference_photos": True,
        "artifact_hashes": {str(p.relative_to(ROOT)): recipes.digest(p) for p in files},
    }
    output = (
        ROOT
        / "artifacts/colab"
        / (
            "viscera-disease-noncommercial-colab.zip"
            if rights["contains_noncommercial"]
            else "viscera-disease-colab.zip"
        )
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(".tmp")
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:

        def add(name: str, payload: bytes) -> None:
            info = zipfile.ZipInfo("viscera-disease/" + name, (2026, 10, 7, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, payload)

        for path in files:
            add(str(path.relative_to(ROOT)), path.read_bytes())
        add("disease-bundle-manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())
    with zipfile.ZipFile(temp) as archive:
        if archive.testzip() is not None:
            raise ValueError("Disease bundle ZIP integrity failure")
        import hashlib

        for name, expected in manifest["artifact_hashes"].items():
            if hashlib.sha256(archive.read("viscera-disease/" + name)).hexdigest() != expected:
                raise ValueError(f"Disease bundle member checksum mismatch: {name}")
    temp.replace(output)
    receipt = {
        "format": manifest["format"],
        "sha256": recipes.digest(output),
        "files": len(files),
        "bytes": output.stat().st_size,
        "clinical_rights": rights,
        "all_members_hash_verified": True,
        "recipe_model_sha256": recipes.digest(ROOT / recipe_model / "model.npz"),
        "source_model_sha256": recipes.digest(ROOT / source_model / "source_model.json"),
    }
    recipes.write_json(output.with_suffix(".sha256.json"), receipt)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recipe-release", default="disease-releases/recipes-v2")
    parser.add_argument("--clinical-release", default="disease-releases/clinical-ccby-v3")
    parser.add_argument("--geometry-release", default="disease-releases/geometry-v1")
    parser.add_argument("--recipe-model", default="artifacts/disease/recipes-run-v2")
    parser.add_argument("--source-model", default="artifacts/disease/clinical-ccby-run-v1")
    parser.add_argument("--allow-noncommercial", action="store_true")
    args = parser.parse_args()
    print(json.dumps(package(**vars(args)), indent=2))


if __name__ == "__main__":
    main()
