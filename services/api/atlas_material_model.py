"""Checksummed material-prior serving; geometry remains the atlas decoder's output."""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from viscera_core.atlas_materials import MaterialRecipe, make_recipe
from viscera_core.atlas_scene import get_template
from viscera_core.atlas_surface_scene import SurfaceAtlasSpec, realize


@lru_cache(maxsize=4)
def _load(path: str, model_mtime: int, metadata_mtime: int) -> Any:
    # The trainer's loader, its pinned source checks under the reviewed renderer extension.
    from .atlas_material_compat import load_model

    return load_model(Path(path))


def sample_material_model(
    template_root: Path,
    model_path: Path,
    data_path: Path,
    spec: SurfaceAtlasSpec,
    seed: int,
    conditions: dict[str, float] | None = None,
) -> dict[str, Any]:
    from viscera_core import atlas_material_dataset as dataset

    from pipelines.train.viscera_train import atlas_material as prior

    from .atlas_material_compat import verify_material_release

    model = _load(
        str(model_path.resolve()),
        model_path.stat().st_mtime_ns,
        model_path.with_suffix(".json").stat().st_mtime_ns,
    )
    release_hash = hashlib.sha256((data_path / "release.json").read_bytes()).hexdigest()
    if model["metadata"]["identity"]["dataset_release_sha256"] != release_hash:
        raise ValueError("Material sampler dataset/model release mismatch")
    # Dataset verifier pins all field anchors and decoder source, not just a path.
    verify_material_release(data_path)
    template = get_template(template_root, spec.template_id)
    organ = template.metadata["organ"]
    current = spec.material or make_recipe(organ)
    if current.organ != organ:
        raise ValueError("Material organ must match selected anatomy")
    proposal = prior.sample_recipe(model, organ, current.preset, seed, conditions)
    recipe = MaterialRecipe.model_validate(proposal["recipe"])
    target = spec.model_copy(
        update={"material": recipe, "appearance": "tissue", "realized_id": None}
    )
    result = realize(template_root, target)
    anchors = prior.load_anchors(data_path)
    # The dataset may intentionally have only one fixed anchor surface per organ.
    sources = json.loads((data_path / "dataset_card.json").read_text())["source_templates"]
    keys = [key for key in anchors if sources.get(key, {}).get("organ") == organ]
    if not keys:
        raise ValueError("Material dataset has no matching organ field anchors")
    key = spec.template_id if spec.template_id in keys else sorted(keys)[0]
    measured, _ = dataset.evaluate_controls(
        organ, recipe.preset, recipe.seed, dataset.recipe_controls(recipe), anchors[key]
    )
    measurements = dict(zip(dataset.CONDITION_NAMES, measured.tolist(), strict=True))
    provenance = {
        **proposal,
        "model_sha256": model["metadata"]["model_sha256"],
        "measured_anchor_template": key,
        "measured_anchor_template_sha256": sources[key]["artifact_sha256"],
        "measured_field_statistics": measurements,
        "condition_errors": {k: measurements[k] - v for k, v in (conditions or {}).items()},
        "condition_status": "measured_proposal_not_exact_constraint"
        if conditions
        else "not_requested",
        "measurement_scope": "fixed rest-space tissue anchors; not patient tissue measurements",
    }
    result["summary"]["material_model"] = provenance
    result["scene"]["metadata"]["material_model"] = provenance
    return result
