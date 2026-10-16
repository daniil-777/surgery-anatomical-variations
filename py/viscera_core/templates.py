"""Export inspectable original template packages and semantic feature records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

from .dataset import _deterministic_npz, _json_write
from .geometry import GENERATOR_VERSION, LINEAGE_ID, generate_scene
from .schema import SceneRequest


def _ply(path: Path, positions: list[float], indices: list[int]) -> None:
    vertices = np.asarray(positions).reshape(-1, 3)
    triangles = np.asarray(indices).reshape(-1, 3)
    with path.open("w") as stream:
        stream.write(
            f"ply\nformat ascii 1.0\ncomment units millimetres frame RAS+\nelement vertex {len(vertices)}\nproperty double x\nproperty double y\nproperty double z\nelement face {len(triangles)}\nproperty list uchar int vertex_indices\nend_header\n"
        )
        np.savetxt(stream, vertices, fmt="%.6f")
        np.savetxt(stream, np.column_stack((np.full(len(triangles), 3), triangles)), fmt="%d")


def export_templates(output: str | Path, resolution: str = "high") -> dict[str, Any]:
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    scene = generate_scene({}, resolution)
    _json_write(output / "pilot-scene-spec.schema.json", SceneRequest.model_json_schema())
    records = []
    for organ in scene["organs"]:
        directory = output / organ["id"] / "original-authoring-v1" / "0.1.0"
        directory.mkdir(parents=True, exist_ok=True)
        _ply(directory / "surface.ply", organ["positions"], organ["indices"])
        if "lumen" in organ:
            _ply(directory / "lumen.ply", organ["lumen"]["positions"], organ["lumen"]["indices"])
        _json_write(
            directory / "landmarks.json",
            {
                "origin": "procedurally_authored",
                "review_status": "unreviewed",
                "units": "mm",
                "positions": organ["landmarks"],
            },
        )
        _json_write(
            directory / "regions.json",
            {
                "origin": "authored_feature_masks_not_clinical_segmentation",
                "overlap_allowed": True,
                "masks": organ.get("semantic_regions", {}),
            },
        )
        _json_write(
            directory / "construction.json",
            {
                "generator_version": GENERATOR_VERSION,
                "parameters": scene["parameters"],
                "seed": scene["spec"]["seed"],
                "resolution": resolution,
                "lineage_id": LINEAGE_ID,
            },
        )
        record = {
            "template_id": f"{organ['id']}-original-authoring-v1",
            "version": "0.1.0",
            "family": organ["id"],
            "topology_id": organ["metadata"]["topology_id"],
            "frame": "RAS+",
            "units": "mm",
            "origin": "authored_scene_anchor",
            "profile": "development_preview",
            "review_status": "unreviewed",
            "parent_lineage": LINEAGE_ID,
            "reference_state": "authored_geometry_not_measured_stress_free",
            "metadata": organ["metadata"],
        }
        _json_write(directory / "template.json", record)
        records.append(record)
        if organ["id"] == "liver":
            proxy = scene["simulation"]
            _deterministic_npz(
                directory / "simulation_preview.npz",
                positions_mm=np.asarray(proxy["positions_mm"]).reshape(-1, 3),
                tets=np.asarray(proxy["tets"]).reshape(-1, 4),
                masses_kg=np.asarray(proxy["masses_kg"]),
                pinned_nodes=np.asarray(proxy["pinned_nodes"]),
                render_tet_indices=np.asarray(proxy["embedding"]["tet_indices"]),
                render_weights=np.asarray(proxy["embedding"]["weights"]).reshape(-1, 4),
                render_rest_residuals_mm=np.asarray(
                    proxy["embedding"]["rest_residuals_mm"]
                ).reshape(-1, 3),
            )
            _json_write(
                directory / "simulation_evidence.json",
                {
                    key: value
                    for key, value in proxy.items()
                    if key
                    not in (
                        "positions_mm",
                        "tets",
                        "surface_indices",
                        "masses_kg",
                        "edges",
                        "rest_lengths_mm",
                        "rest_volumes_mm3",
                        "embedding",
                    )
                },
            )
    _json_write(
        output / "inventory.json",
        {
            "generator_version": GENERATOR_VERSION,
            "independent_construction_lineages": 1,
            "review_status": "unreviewed",
            "templates": records,
            "scene_hash": scene["content_hash"],
        },
    )
    return scene


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("assets/templates"))
    parser.add_argument("--resolution", choices=("low", "medium", "high"), default="high")
    parser.add_argument("--scene-output", type=Path)
    args = parser.parse_args()
    scene = export_templates(args.output, args.resolution)
    if args.scene_output:
        args.scene_output.parent.mkdir(parents=True, exist_ok=True)
        args.scene_output.write_text(json.dumps(scene, separators=(",", ":"), allow_nan=False))
    print(
        json.dumps(
            {
                "output": str(args.output),
                "scene_hash": scene["content_hash"],
                "profile": scene["metadata"]["profile"],
            }
        )
    )


if __name__ == "__main__":
    main()
