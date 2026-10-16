"""Serve only a checksummed atlas model bound to its exact geometry release."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from viscera_core import atlas
from viscera_core.atlas_dataset import CONDITION_NAMES, digest, verify_release
from viscera_core.atlas_scene import AtlasSpec, get_template, realize


@lru_cache(maxsize=4)
def _model(
    model_path: str, model_hash: str, sidecar_hash: str, data_root: str, release_hash: str
) -> dict[str, Any]:
    from pipelines.train.viscera_train.atlas_shape import load_model

    artifact = load_model(Path(model_path))
    release = verify_release(data_root)
    if artifact["dataset_hashes"]["release.json"] != release_hash:
        raise ValueError("Trained model and atlas dataset release do not match")
    if artifact["condition_names"] != list(CONDITION_NAMES):
        raise ValueError("Model uses an unsupported measurement contract")
    if release["recipe"]["generator_source_hashes"]["atlas.py"] != digest(Path(atlas.__file__)):
        raise ValueError("Geometry decoder differs from the model training release")
    return artifact


def sample_model(
    template_root: Path,
    model_path: Path,
    data_root: Path,
    spec: AtlasSpec,
    match_dimensions: bool = True,
) -> dict[str, Any]:
    from pipelines.train.viscera_train.atlas_shape import refine_controls, sample_controls

    active = get_template(template_root, spec.template_id)
    trained = get_template(data_root / "templates", spec.template_id)
    if active.metadata["artifact_sha256"] != trained.metadata["artifact_sha256"]:
        raise ValueError("Selected reference does not match the model training template")
    if (
        spec.template_sha256 is not None
        and spec.template_sha256 != active.metadata["artifact_sha256"]
    ):
        raise ValueError("Displayed reference changed; reload before sampling")
    checksum = model_path.with_suffix(model_path.suffix + ".sha256.json")
    model_hash = digest(model_path)
    artifact = _model(
        str(model_path.resolve()),
        model_hash,
        digest(checksum),
        str(data_root.resolve()),
        digest(data_root / "release.json"),
    )
    # A warm model cache must not bypass corruption of its paired release files.
    verify_release(data_root)

    def decoder(template_id: str, controls: Any) -> tuple[Any, Any]:
        if template_id != spec.template_id:
            raise ValueError("Refinement attempted to change reference")
        v = atlas.deform_vertices(
            active.vertices_mm,
            controls,
            active.metadata["control_limits"],
            active.metadata["normalization_mm"],
        )
        values = np.full(6, np.nan)
        values[:3] = np.ptp(v, axis=0)
        return values, np.array([True, True, True, False, False, False])

    current, _ = decoder(
        spec.template_id, np.array([spec.controls[k] for k in atlas.CONTROL_NAMES])
    )
    targets = (
        {k: float(current[i]) for i, k in enumerate(CONDITION_NAMES[:3])}
        if match_dimensions
        else {}
    )
    refinement: dict[str, Any] = {"status": "not_requested"}
    controls = None
    for attempt in range(4):
        proposal = sample_controls(
            artifact,
            spec.template_id,
            targets,
            count=1,
            seed=(spec.seed + attempt * 104729) % (2**32),
        )[0]
        if match_dimensions:
            refinement = refine_controls(
                artifact,
                spec.template_id,
                proposal,
                targets,
                decoder,
                relative_tolerance=0.001,
                prior_weight=0.005,
                max_nfev=60,
            )
            if refinement["status"] != "matched":
                continue
            controls = refinement["controls"]
        else:
            controls = proposal
        break
    if controls is None:
        raise ValueError(
            "No sampled variation could match the requested dimensions within the bounded range"
        )
    request = AtlasSpec(
        template_id=spec.template_id,
        seed=spec.seed,
        appearance=spec.appearance,
        controls=dict(zip(atlas.CONTROL_NAMES, np.asarray(controls).tolist(), strict=True)),
        template_sha256=active.metadata["artifact_sha256"],
    )
    result = realize(template_root, request)
    # Store only JSON-compatible provenance; the exact realized controls are in result.spec.
    info = {
        "method": artifact["selected_method"],
        "model_sha256": model_hash,
        "scope": "within_generator_design_distribution",
        "sampling": "conditional_residual_proposal"
        if match_dimensions
        else "empirical_training_bootstrap",
        "match_dimensions": match_dimensions,
        "requested_dimensions_mm": targets,
        "refinement_status": refinement["status"],
        "refinement": {k: v for k, v in refinement.items() if k != "controls"},
        "attempt": attempt + 1,
    }
    result["summary"]["model"] = info
    result["scene"]["metadata"]["model"] = info
    return result
