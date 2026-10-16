"""Evaluate frozen atlas controls against real geometry, including organ slices.

Validation can compare methods. Audit evaluates the frozen selection only. This
runner does not update the model, choose weights, or change a dataset release.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import numpy as np

from pipelines.train.viscera_train import atlas_shape as atlas

ROW_KEYS = {
    "controls",
    "conditions",
    "condition_mask",
    "template_ids",
    "organ_ids",
    "sample_ids",
    "group_ids",
}


def run(dataset: Path, model_path: Path, out: Path, split: str, compare: bool) -> dict[str, Any]:
    if split == "audit" and compare:
        raise ValueError("Method comparisons are forbidden on audit")
    model = atlas.load_model(model_path)
    if model["dataset_hashes"]["release.json"] != atlas.digest(dataset / "release.json"):
        raise ValueError("Frozen release mismatch")
    data = atlas.read_split(dataset, split)
    atlas.audit_splits(atlas.read_split(dataset, "train"), data)
    if split == "audit":
        atlas.audit_splits(atlas.read_split(dataset, "val"), data)
    decoder = atlas.make_geometry_decoder(dataset / "templates")
    methods = atlas.METHODS if compare else (model["selected_method"],)
    results = {}
    for method in methods:
        metrics = atlas.evaluate_arrays(model, data, method)
        per_organ = {}
        for organ_id, organ in enumerate(data["organ_names"]):
            selected = data["organ_ids"] == organ_id
            if not selected.any():
                continue
            sliced = {
                key: value[selected] if key in ROW_KEYS else value for key, value in data.items()
            }
            per_organ[str(organ)] = atlas.evaluate_arrays(
                model, sliced, method, decoder, sampling=False
            )
        merged = {}
        for name in model["condition_names"]:
            source = [x["decoded_geometry"]["conditions"][name] for x in per_organ.values()]
            count = sum(x["observed_rows"] for x in source)
            merged[name] = {
                "observed_rows": count,
                "mae_original_units": sum(
                    x["mae_original_units"] * x["observed_rows"]
                    for x in source
                    if x["observed_rows"]
                )
                / count
                if count
                else None,
                "nrmse_training_std": float(
                    np.sqrt(
                        sum(
                            x["nrmse_training_std"] ** 2 * x["observed_rows"]
                            for x in source
                            if x["observed_rows"]
                        )
                        / count
                    )
                )
                if count
                else None,
            }
        metrics["decoded_geometry"] = {"status": "MEASURED", "conditions": merged}
        metrics["per_organ"] = per_organ
        results[method] = metrics
    report = {
        "split": split,
        "selected_method": model["selected_method"],
        "model_frozen": True,
        "model_sha256": atlas.digest(model_path),
        "split_sha256": atlas.digest(dataset / f"{split}.npz"),
        "release_sha256": atlas.digest(dataset / "release.json"),
        "methods": results,
        "scope": "Within-generator controls and decoded geometry; independent anatomy, textures and mechanics not validated",
    }
    atlas.atomic_json(out, report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--split", choices=("val", "audit"), default="val")
    parser.add_argument("--compare", action="store_true")
    args = parser.parse_args()
    result = run(args.dataset, args.model, args.out, args.split, args.compare)
    for method, metrics in result["methods"].items():
        print(
            method, metrics["macro_template_control_nrmse"], metrics["decoded_geometry"], flush=True
        )


if __name__ == "__main__":
    main()
