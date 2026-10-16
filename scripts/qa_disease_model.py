"""Measure learned recipe samples on actual editor meshes, never a learned proxy."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
from viscera_core import atlas_disease, atlas_disease_scene
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec, realize

from pipelines.train.viscera_train import atlas_disease as prior
from services.api.atlas_disease_model import sample_recipe_model


def run(model_path: Path, data: Path, templates: Path, output: Path) -> dict[str, Any]:
    model = prior.load_recipe_model(model_path)
    catalog = json.loads((templates / "catalog.json").read_text())
    checks = []
    for profile in model["profiles"]:
        organ = model["profile_organs"][profile]
        template = next(t for t in catalog["templates"] if t["organ"] == organ)
        rows, vertices, colors = [], [], []
        for seed in (333, 444):
            sample = sample_recipe_model(model_path, data, profile, seed)
            result = realize(
                templates,
                DiseaseAtlasSpec(template_id=template["template_id"], disease=sample["disease"]),
            )
            meta = result["scene"]["metadata"]
            qa, disease = meta["qa"], meta["disease"]
            if (
                not qa["passed"]
                or not qa["topology_preserved"]
                or qa["continuous_jacobian_lower_bound"] <= 0
            ):
                raise ValueError(f"Generated disease mesh failed geometric gates: {profile}")
            if disease["max_displacement_mm"] <= 0:
                raise ValueError(f"Disease model produced no displacement: {profile}")
            item = result["scene"]["organs"][0]
            vertices.append(np.asarray(item["positions"]).reshape(-1, 3))
            colors.append(np.asarray(item["colors"]).reshape(-1, 3))
            rows.append(
                {
                    "seed": seed,
                    "recipe": sample["disease"],
                    "realized_id": result["spec"]["realized_id"],
                    "geometry_sha256": meta["geometry_sha256"],
                    "max_displacement_mm": disease["max_displacement_mm"],
                    "realized_sites": disease["realized_sites"],
                    "applied_fraction": disease["applied_displacement_fraction"],
                    "qa": qa,
                }
            )
        if rows[0]["geometry_sha256"] == rows[1]["geometry_sha256"]:
            raise ValueError(f"Different model seeds produced identical geometry: {profile}")
        differences = np.linalg.norm(vertices[0] - vertices[1], axis=1)
        checks.append(
            {
                "profile": profile,
                "organ": organ,
                "template": template["template_id"],
                "distinct_seed_geometry": True,
                "between_seed_vertex_rms_mm": float(np.sqrt(np.mean(differences**2))),
                "between_seed_vertex_max_mm": float(differences.max()),
                "between_seed_mean_srgb_difference": float(np.abs(colors[0] - colors[1]).mean()),
                "samples": rows,
            }
        )
    report = {
        "passed": True,
        "profiles": len(checks),
        "organ_families": len({c["organ"] for c in checks}),
        "samples": len(checks) * 2,
        "model_sha256": prior.digest(model_path),
        "decoder_sha256": prior.digest(Path(atlas_disease.__file__)),
        "scene_adapter_sha256": prior.digest(Path(atlas_disease_scene.__file__)),
        "scope": "finite same-topology mesh checks and measured seed sensitivity; not a clinical or perceptual realism score",
        "checks": checks,
    }
    prior.write_json(output, report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--templates", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = run(args.model, args.dataset, args.templates, args.out)
    print(
        json.dumps(
            {key: report[key] for key in ("passed", "profiles", "organ_families", "samples")}
        )
    )


if __name__ == "__main__":
    main()
