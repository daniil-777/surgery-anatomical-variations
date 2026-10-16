"""Independent exact-UI-renderer audit of a trained joint CVAE.

Uses complete meshes/vertex colours, not the differentiable training surrogate.
Passing checks establish bounded usable design variations, not clinical validity.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
from viscera_core import atlas_joint as joint
from viscera_core.atlas_disease_recipe_dataset import write_json
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec, realize
from viscera_core.atlas_scene import get_template


def audit(model_path: Path, template_root: Path, out: Path) -> dict[str, Any]:
    model = joint.load_model(Path(model_path))
    template_root = Path(template_root)
    root = Path(__file__).resolve().parents[1]
    for name, sha in model["renderer_hashes"].items():
        if joint.digest(root / name) != sha:
            raise ValueError("Joint renderer differs from training: " + name)
    if joint.digest(Path(joint.__file__)) != model["model_decoder_sha256"]:
        raise ValueError("Joint decoder differs from trained deployment contract")
    for template_id, sha in model["template_hashes"].items():
        if joint.digest(template_root / (template_id + ".npz")) != sha:
            raise ValueError("Joint template differs from training: " + template_id)
        if (
            joint.digest(template_root / (template_id + ".json"))
            != model["template_metadata_hashes"][template_id]
        ):
            raise ValueError("Joint template metadata differs from training: " + template_id)
    conditions = []
    count = 0
    for condition in model["conditions"]:
        template = get_template(template_root, condition["template_id"])
        norm = float(template.metadata["normalization_mm"])
        seeds = (71, 1729, 10007)
        meshes, colors, rows, passed = [], [], [], True
        for seed in seeds:
            sampled = joint.sample_joint(
                model,
                condition["template_id"],
                None if condition["profile_id"] == "baseline" else condition["profile_id"],
                seed,
            )
            payload = {k: sampled[k] for k in ("controls", "material", "disease")}
            spec = DiseaseAtlasSpec.model_validate(
                {
                    "template_id": condition["template_id"],
                    "seed": seed,
                    "appearance": "tissue",
                    **payload,
                }
            )
            result = realize(template_root, spec)
            organ = result["scene"]["organs"][0]
            v = np.asarray(organ["positions"], dtype=np.float64).reshape(-1, 3)
            c = np.asarray(organ["colors"], dtype=np.float64).reshape(-1, 3)
            # Geometry packets use indices; compare direct source connectivity too.
            indices = np.asarray(organ["indices"], dtype=np.int64).reshape(-1, 3)
            finite = bool(np.isfinite(v).all() and np.isfinite(c).all())
            topology = bool(
                v.shape == template.vertices_mm.shape and np.array_equal(indices, template.faces)
            )
            bounds = bool(np.all((c >= 0) & (c <= 1)) and np.all(np.ptp(v, axis=0) > 0))
            qa = result["scene"]["metadata"]["qa"]
            okay = finite and topology and bounds and qa.get("passed") is True
            passed &= okay
            rows.append(
                {
                    "seed": seed,
                    "geometry_sha256": result["scene"]["metadata"]["geometry_sha256"],
                    "extent_mm": np.ptp(v, axis=0).tolist(),
                    "mean_srgb": c.mean(0).tolist(),
                    "srgb_std": c.std(0).tolist(),
                    "finite": finite,
                    "topology_preserved": topology,
                    "bounded": bounds,
                    "renderer_qa_passed": qa.get("passed"),
                    "disease_displacement_fraction": result["summary"]
                    .get("disease", {})
                    .get("applied_displacement_fraction", 1),
                    "spec": result["spec"],
                }
            )
            meshes.append(v)
            colors.append(c)
            count += 1
        first = joint.sample_joint(
            model,
            condition["template_id"],
            None if condition["profile_id"] == "baseline" else condition["profile_id"],
            seeds[0],
        )
        replay = (
            first["controls"] == rows[0]["spec"]["controls"]
            and first["material"] == rows[0]["spec"]["material"]
            and first["disease"] == rows[0]["spec"].get("disease")
        )
        shape_diversity = float(np.sqrt(np.mean((meshes[0] - meshes[1]) ** 2)) / norm)
        colour_diversity = float(np.sqrt(np.mean((colors[0] - colors[1]) ** 2)))
        distinct = len({r["geometry_sha256"] for r in rows}) == len(seeds)
        passed &= replay and distinct and shape_diversity > 5e-4 and colour_diversity > 5e-4
        conditions.append(
            {
                "template_id": condition["template_id"],
                "profile_id": condition["profile_id"],
                "passed": bool(passed),
                "seed_replay_passed": bool(replay),
                "distinct_rendered_meshes": bool(distinct),
                "normalized_shape_rms_between_seeds": shape_diversity,
                "srgb_rms_between_seeds": colour_diversity,
                "samples": rows,
            }
        )
        print(
            json.dumps(
                {
                    "renderer_audit": len(conditions),
                    "of": len(model["conditions"]),
                    "condition": list(joint.condition_key(condition)),
                    "passed": bool(passed),
                }
            ),
            flush=True,
        )
    report = {
        "format": "viscera-joint-exact-renderer-audit-v1",
        "model_sha256": model["artifact_sha256"],
        "passed": all(c["passed"] for c in conditions),
        "rendered_samples": count,
        "condition_count": len(conditions),
        "conditions": conditions,
        "scope": "Exact Studio renderer, full-source topology, finite geometry, bounded vertex colours, seed replay, and visible variation measurements.",
        "engineering_diversity_thresholds": {
            "minimum_normalized_shape_rms_between_seeds": 5e-4,
            "minimum_srgb_rms_between_seeds": 5e-4,
            "meaning": "Numerical anti-collapse thresholds; not human realism scores.",
        },
        "clinical_validity": "NOT_EVALUATED",
        "patient_distribution_validity": "NOT_EVALUATED",
        "mechanical_validity": "NOT_EVALUATED",
    }
    write_json(Path(out), report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--templates", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    result = audit(args.model, args.templates, args.out)
    if not result["passed"]:
        raise SystemExit("Joint exact-renderer audit failed; inspect the report before export")


if __name__ == "__main__":
    main()
