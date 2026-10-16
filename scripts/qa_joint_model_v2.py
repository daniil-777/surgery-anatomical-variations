"""Check the trained v2 generator with complete meshes at every severity band."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
from viscera_core import atlas_joint_v2 as joint
from viscera_core.atlas_disease_scene_v2 import DiseaseAtlasSpecV2, realize
from viscera_core.atlas_scene import get_template

BANDS = {"mild": (0.1, 0.35), "moderate": (0.35, 0.7), "severe": (0.7, 1.0)}


def audit(model_path: Path, template_root: Path, out: Path) -> dict[str, Any]:
    model = joint.load_model(model_path)
    root = Path(__file__).resolve().parents[1]
    for name, sha in model["renderer_hashes"].items():
        if joint.digest(root / name) != sha:
            raise ValueError("V2 renderer differs from trained source: " + name)
    if joint.digest(Path(joint.__file__)) != model["model_decoder_sha256"]:
        raise ValueError("V2 deployment decoder changed after training")
    for tid, sha in model["template_hashes"].items():
        if (
            joint.digest(template_root / (tid + ".npz")) != sha
            or joint.digest(template_root / (tid + ".json"))
            != model["template_metadata_hashes"][tid]
        ):
            raise ValueError("V2 source template changed: " + tid)
    conditions = []
    rendered = 0
    for condition in model["conditions"]:
        tid, pid = condition["template_id"], condition["profile_id"]
        template = get_template(template_root, tid)
        norm = float(template.metadata["normalization_mm"])
        profile = None if pid == "baseline" else pid
        band_rows = []
        for band in ["baseline"] if profile is None else list(BANDS):
            severity = "auto" if profile is None else band
            rows, geometry, colour = [], [], []
            for seed in (71, 1729, 10007):
                proposal = joint.sample_joint(model, tid, profile, seed, severity=severity)
                recipe = {key: proposal[key] for key in ("controls", "material", "disease")}
                spec = DiseaseAtlasSpecV2.model_validate(
                    {
                        "template_id": tid,
                        "renderer_version": "disease-v2",
                        "seed": seed,
                        "appearance": "tissue",
                        **recipe,
                    }
                )
                result = realize(template_root, spec)
                organ = result["scene"]["organs"][0]
                points = np.asarray(organ["positions"], dtype=np.float64).reshape(-1, 3)
                colours = np.asarray(organ["colors"], dtype=np.float64).reshape(-1, 3)
                faces = np.asarray(organ["indices"], dtype=np.int64).reshape(-1, 3)
                finite = bool(np.isfinite(points).all() and np.isfinite(colours).all())
                topology = points.shape == template.vertices_mm.shape and np.array_equal(
                    faces, template.faces
                )
                bounded = bool(
                    np.all((colours >= 0) & (colours <= 1)) and np.all(np.ptp(points, axis=0) > 0)
                )
                qa = result["scene"]["metadata"]["qa"].get("passed") is True
                band_ok = (
                    profile is None
                    or BANDS[band][0] - 1e-6 <= spec.disease.severity <= BANDS[band][1] + 1e-6
                )
                replay = joint.sample_joint(model, tid, profile, seed, severity=severity)
                replay_ok = all(replay[key] == recipe[key] for key in recipe)
                bound_replay = realize(
                    template_root, DiseaseAtlasSpecV2.model_validate(result["spec"])
                )
                bound_organ = bound_replay["scene"]["organs"][0]
                bound_replay_ok = (
                    result["scene"]["metadata"]["geometry_sha256"]
                    == bound_replay["scene"]["metadata"]["geometry_sha256"]
                    and np.array_equal(organ["positions"], bound_organ["positions"])
                    and np.array_equal(organ["colors"], bound_organ["colors"])
                )
                rows.append(
                    {
                        "seed": seed,
                        "passed": bool(
                            finite
                            and topology
                            and bounded
                            and qa
                            and band_ok
                            and replay_ok
                            and bound_replay_ok
                        ),
                        "finite": finite,
                        "topology_preserved": bool(topology),
                        "bounded_colours": bounded,
                        "renderer_qa_passed": qa,
                        "severity_band_passed": bool(band_ok),
                        "seed_replay_passed": replay_ok,
                        "bound_recipe_replay_passed": bound_replay_ok,
                        "geometry_sha256": result["scene"]["metadata"]["geometry_sha256"],
                        "extent_mm": np.ptp(points, axis=0).tolist(),
                        "mean_srgb": colours.mean(0).tolist(),
                        "spec": result["spec"],
                    }
                )
                if len(geometry) < 2:
                    geometry.append(points)
                    colour.append(colours)
                rendered += 1
            shape_delta = float(np.sqrt(np.mean((geometry[0] - geometry[1]) ** 2)) / norm)
            colour_delta = float(np.sqrt(np.mean((colour[0] - colour[1]) ** 2)))
            distinct = len({row["geometry_sha256"] for row in rows}) == 3
            passed = (
                all(row["passed"] for row in rows)
                and distinct
                and shape_delta > 5e-4
                and colour_delta > 5e-4
            )
            band_rows.append(
                {
                    "severity": band,
                    "passed": bool(passed),
                    "normalized_shape_rms_between_seeds": shape_delta,
                    "srgb_rms_between_seeds": colour_delta,
                    "distinct_rendered_meshes": distinct,
                    "samples": rows,
                }
            )
        conditions.append(
            {
                "template_id": tid,
                "profile_id": pid,
                "passed": all(row["passed"] for row in band_rows),
                "severity_bands": band_rows,
            }
        )
        print(
            json.dumps(
                {
                    "renderer_audit": len(conditions),
                    "of": len(model["conditions"]),
                    "template_id": tid,
                    "profile_id": pid,
                    "passed": conditions[-1]["passed"],
                }
            ),
            flush=True,
        )
    report = {
        "format": "viscera-joint-exact-renderer-audit-v2",
        "model_sha256": model["artifact_sha256"],
        "passed": all(row["passed"] for row in conditions),
        "condition_count": len(conditions),
        "rendered_samples": rendered,
        "conditions": conditions,
        "scope": "Complete Studio meshes and colours for every condition and severity design band; seeded replay, finite geometry, preserved connectivity, bounded appearance and inter-seed diversity.",
        "clinical_validity": "NOT_EVALUATED",
        "mechanical_validity": "NOT_EVALUATED",
        "engineering_diversity_thresholds": {"normalized_shape_rms": 5e-4, "srgb_rms": 5e-4},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--templates", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not audit(args.model, args.templates, args.out)["passed"]:
        raise SystemExit("V2 full-mesh audit failed; no successful export is claimed")
