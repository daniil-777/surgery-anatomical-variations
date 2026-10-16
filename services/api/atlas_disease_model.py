"""Disease model serving bound to exact data and decoder provenance."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, cast

from viscera_core import atlas_disease_recipe_dataset as recipe_data


@lru_cache(maxsize=4)
def _recipe_model(
    model_path: str,
    model_hash: str,
    manifest_hash: str,
    data_root: str,
    release_hash: str,
    decoder_hash: str,
    profile_hash: str,
) -> dict[str, Any]:
    from pipelines.train.viscera_train.atlas_disease import load_recipe_model

    root = Path(data_root)
    release = recipe_data.verify_release(root)
    model = load_recipe_model(Path(model_path))
    if model["dataset_hashes"]["release.json"] != release_hash:
        raise ValueError("Disease model and recipe release do not match")
    if model["source_sha256"] != decoder_hash or release["recipe"]["source_sha256"] != decoder_hash:
        raise ValueError("Disease renderer differs from the trained recipe decoder")
    if model["catalog_sha256"] != release["artifact_hashes"]["catalog.json"]:
        raise ValueError("Disease model profile catalog does not match training")
    if json.loads((root / "catalog.json").read_text())["profile_sha256"] != profile_hash:
        raise ValueError("Disease profile definitions differ from model training")
    return cast(dict[str, Any], model)


def sample_recipe_model(
    model_path: Path, data_root: Path, profile_id: str, seed: int
) -> dict[str, Any]:
    """Return one editor-ready DiseaseSpec and a JSON provenance record."""
    from viscera_core import atlas_disease as renderer

    from pipelines.train.viscera_train.atlas_disease import sample_recipes

    model_path, data_root = Path(model_path), Path(data_root)
    model_hash = recipe_data.digest(model_path)
    release_hash = recipe_data.digest(data_root / "release.json")
    model = _recipe_model(
        str(model_path.resolve()),
        model_hash,
        recipe_data.digest(model_path.with_suffix(".json")),
        str(data_root.resolve()),
        release_hash,
        recipe_data.digest(Path(renderer.__file__)),
        recipe_data.digest(renderer.PROFILE_PATH),
    )
    # Verify release files on every request; a warm cache must not bypass data drift.
    recipe_data.verify_release(data_root)
    disease = sample_recipes(model, profile_id, seed, count=1)[0]
    spec = renderer.DiseaseSpec(**disease)
    disease = spec.model_dump() if hasattr(spec, "model_dump") else disease
    return {
        "disease": disease,
        "model": {
            "method": model["selected_method"],
            "model_sha256": model_hash,
            "recipe_release_sha256": release_hash,
            "profile_id": profile_id,
            "request_seed": seed,
            "spatial_seed": disease["seed"],
            "scope": model["scope"],
            "patient_count": 0,
            "training_recipe_count": model["training_recipe_count"],
            "requires_geometry_validation": True,
        },
    }


def sample_source_model(
    model_path: Path,
    data_root: Path,
    organ: str,
    disease_code: str,
    *,
    seed: int = 0,
    count: int = 1,
    conditions: dict[str, float] | None = None,
    allow_noncommercial: bool = False,
) -> dict[str, Any]:
    """Clinical lane retrieves observed training cases; no invented disease morphology."""
    from viscera_core import atlas_disease_dataset as source_data

    from pipelines.train.viscera_train.atlas_disease import load_source_model, sample_source_cases

    release = source_data.verify_release(data_root)
    model = load_source_model(model_path, allow_noncommercial=allow_noncommercial)
    release_hash = recipe_data.digest(Path(data_root) / "release.json")
    if release_hash != model["dataset_hashes"]["release.json"]:
        raise ValueError("Source prior and clinical release do not match")
    if release["rights"] != model["rights"]:
        raise ValueError("Source prior and clinical release licensing do not match")
    samples = sample_source_cases(
        model, organ, disease_code, seed=seed, count=count, conditions=conditions
    )
    return {
        "cases": samples,
        "model": {
            "method": model["method"],
            "model_sha256": recipe_data.digest(model_path),
            "release_sha256": release_hash,
            "scope": model["scope"],
            "training_patient_count": model["patient_count"],
            "rights": model["rights"],
        },
    }
