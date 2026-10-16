"""Realize diverse frozen-model recipes across every trained source template."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import numpy as np
from viscera_core.atlas import generate, load_template

from pipelines.train.viscera_train import atlas_shape as atlas


def run(dataset: Path, model_path: Path, out: Path, count: int = 12) -> dict[str, Any]:
    model = atlas.load_model(model_path)
    if model["dataset_hashes"]["release.json"] != atlas.digest(dataset / "release.json"):
        raise ValueError("Frozen model release mismatch")
    train = atlas.read_split(dataset, "train")
    decoder = atlas.make_geometry_decoder(dataset / "templates")
    records: list[dict[str, Any]] = []
    refinements = []
    for i, template_id in enumerate(model["preprocessing"]["templates"]):
        template = load_template(dataset / "templates", template_id)
        candidates = atlas.sample_controls(model, template_id, count=256, seed=4900 + i)
        _, unique = np.unique(candidates, return_index=True, axis=0)
        controls = candidates[np.sort(unique)[:count]]
        if len(controls) != count:
            raise ValueError(f"Insufficient distinct prior recipes: {template_id}")
        ix = train["template_ids"] == template_id
        target = float(np.median(train["conditions"][ix, 0]))
        conditions = {model["condition_names"][0]: target}
        proposals = atlas.sample_controls(
            model, template_id, conditions, count=count, seed=9700 + i
        )
        refinement = atlas.refine_controls(model, template_id, proposals[0], conditions, decoder)
        refinements.append(refinement)
        proposals[0] = refinement["controls"]
        for role, values in (("unconditional", controls), ("conditional", proposals)):
            for j, row in enumerate(values):
                sample = generate(template, row, seed=801000 + i * 100 + j)
                records.append(
                    {
                        "sample_id": f"model-{template_id}-{role}-{j:02d}",
                        "template_id": template_id,
                        "organ": template.metadata["organ"],
                        "sampling_role": role,
                        "controls": row.tolist(),
                        "seed": 801000 + i * 100 + j,
                        "requested_conditions": conditions if role == "conditional" else {},
                        "measurements": sample.measurements,
                        "qa": sample.qa,
                        "vertices": len(sample.vertices_mm),
                        "faces": len(sample.faces),
                    }
                )
    failures = [x["sample_id"] for x in records if not x["qa"]["passed"]]
    report = {
        "format": "viscera-atlas-frozen-model-sample-qa-v1",
        "model_sha256": atlas.digest(model_path),
        "release_sha256": atlas.digest(dataset / "release.json"),
        "selected_method": model["selected_method"],
        "samples": len(records),
        "templates": len(model["preprocessing"]["templates"]),
        "organs": len(set(x["organ"] for x in records)),
        "passed": len(records) - len(failures),
        "failures": failures,
        "refinement_matched": sum(x["status"] == "matched" for x in refinements),
        "refinements": refinements,
        "records": records,
        "scope": "Numerical surface deformation QA only; anatomy and mechanics remain unvalidated",
    }
    atlas.atomic_json(out, report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--count", type=int, default=12)
    args = parser.parse_args()
    result = run(args.dataset, args.model, args.out, args.count)
    print(
        {k: result[k] for k in ("samples", "templates", "organs", "passed", "refinement_matched")},
        flush=True,
    )


if __name__ == "__main__":
    main()
