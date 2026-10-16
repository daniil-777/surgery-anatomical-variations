"""Decode bounded material-prior proposals on fixed source surface anchors."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import numpy as np
from viscera_core import atlas_material_dataset as dataset

from pipelines.train.viscera_train import atlas_material as prior


def run(data: Path, model_path: Path, output: Path, per_mode: int = 8) -> dict[str, Any]:
    if per_mode < 2:
        raise ValueError("At least two proposals per mode are required")
    model = prior.load_model(model_path)
    anchors = prior.load_anchors(data)
    training = dataset.read_split(data, "train")
    groups = prior.group_names(training)
    rows: list[dict[str, Any]] = []
    diversity: list[dict[str, Any]] = []
    for group in model["group_names"]:
        organ, preset = str(group).split("|")
        ids = np.flatnonzero(groups == group)
        template_id = str(training["template_ids"][ids[0]])
        requested = {
            "roughness_mean": float(
                training["conditions"][ids, dataset.CONDITION_NAMES.index("roughness_mean")].mean()
            )
        }
        for mode in ("unconditional", "conditional"):
            mode_controls, mode_summaries = [], []
            for i in range(per_mode):
                seed = dataset.sub_seed(23007, str(group), mode, str(i)) % 2**32
                proposal = prior.sample_recipe(
                    model, organ, preset, seed, requested if mode == "conditional" else None
                )
                controls = np.asarray(proposal["normalized_controls"])
                summary, fields = dataset.evaluate_controls(
                    organ, preset, seed, controls, anchors[template_id]
                )
                if not np.isfinite(fields).all() or np.abs(controls).max() > 1:
                    raise ValueError("Generated material proposal failed field bounds")
                mode_controls.append(controls)
                mode_summaries.append(summary)
                measured = dict(zip(dataset.CONDITION_NAMES, summary.tolist(), strict=True))
                rows.append(
                    {
                        "organ": organ,
                        "preset": preset,
                        "mode": mode,
                        "template_id": template_id,
                        "proposal": proposal,
                        "measurements": measured,
                        "requested_condition_errors": {
                            k: measured[k] - v
                            for k, v in (requested if mode == "conditional" else {}).items()
                        },
                        "geometry_modified": False,
                        "field_bounds_passed": True,
                    }
                )
            diversity.append(
                {
                    "organ": organ,
                    "preset": preset,
                    "mode": mode,
                    "unique_control_vectors": len(np.unique(np.asarray(mode_controls), axis=0)),
                    "mean_control_std": float(np.std(mode_controls, axis=0).mean()),
                    "condition_std": dict(
                        zip(
                            dataset.CONDITION_NAMES,
                            np.std(mode_summaries, axis=0).tolist(),
                            strict=True,
                        )
                    ),
                }
            )
    result = {
        "status": "PASS",
        "model_sha256": prior.digest(model_path),
        "samples": len(rows),
        "geometry_modified": False,
        "every_field_finite_and_bounded": True,
        "minimum_unique_control_vectors": min(x["unique_control_vectors"] for x in diversity),
        "minimum_mean_control_std": min(x["mean_control_std"] for x in diversity),
        "diversity": diversity,
        "samples_detail": rows,
        "scope": "Numerical appearance field checks; not tissue optics, histology, clinical realism or population variation",
    }
    prior.write_json(output, result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.data, args.model, args.out)
    print({k: v for k, v in result.items() if k not in ("diversity", "samples_detail")})
