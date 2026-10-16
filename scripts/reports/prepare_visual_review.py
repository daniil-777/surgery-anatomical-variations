"""Prepare actual mesh inputs for a reproducible visual review, without altering releases."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from viscera_core.geometry import DEFAULT_PARAMETERS, generate_scene

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT.parent / "reports/viscera-organ-review-2026-10-06"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sources = OUT / "mesh-inputs"
    sources.mkdir(exist_ok=True)
    index: dict[str, object] = {}

    def save(name: str, scene: dict, origin: str) -> None:
        path = sources / f"{name}.json"
        payload = json.dumps(scene, separators=(",", ":"), allow_nan=False)
        path.write_text(payload)
        index[name] = {
            "file": str(path.relative_to(OUT)),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "origin": origin,
            "measurements": scene["measurements"],
            "parameters": scene.get("parameters"),
            "triangles": {o["id"]: len(o["indices"]) // 3 for o in scene["organs"]},
        }

    default = generate_scene({}, "high", include_simulation=False)
    save(
        "default",
        default,
        "Current high-resolution procedural generator, default controls, seed 1234",
    )
    liver_only = {**default, "organs": [default["organs"][0]], "vessels": []}
    save("liver", liver_only, "Exact default liver, isolated without geometry modification")
    gallbladder = {**default, "organs": [default["organs"][1]], "vessels": []}
    save(
        "gallbladder",
        gallbladder,
        "Exact default gallbladder, isolated without geometry modification",
    )

    release = ROOT / "datasets/original/pilot-v1"
    records = [json.loads(line) for line in (release / "manifest.jsonl").read_text().splitlines()]
    accepted = sorted(
        (r for r in records if r["status"] == "accepted_development_preview"),
        key=lambda r: r["measurements"]["liver_volume_ml"],
    )
    for i, position in enumerate(np.linspace(0, len(accepted) - 1, 6).round().astype(int)):
        row = accepted[position]
        artifact = release / row["artifact"]
        assert hashlib.sha256(artifact.read_bytes()).hexdigest() == row["artifact_sha256"]
        organs = []
        with np.load(artifact, allow_pickle=False) as arrays:
            for organ_id, color in (("liver", "#99544b"), ("gallbladder", "#8d9870")):
                organs.append(
                    {
                        "id": organ_id,
                        "color": color,
                        "positions": arrays[f"{organ_id}_positions_mm"].reshape(-1).tolist(),
                        "indices": arrays[f"{organ_id}_faces"].reshape(-1).tolist(),
                        "colors": arrays[f"{organ_id}_colors"].reshape(-1).tolist(),
                    }
                )
        save(
            f"cohort-{i}",
            {
                "organs": organs,
                "vessels": [],
                "measurements": row["measurements"],
                "parameters": row["parameters"],
            },
            f"Stored pilot-v1 geometry {row['sample_id']}; volume rank {position + 1}/128, chosen for visual coverage",
        )

    for key, values in (
        ("left_lobe_ratio", (0.30, 0.48, 0.78)),
        ("inferior_concavity", (0.10, 0.30, 0.55)),
        ("fissure_depth_mm", (2.0, 7.0, 12.0)),
    ):
        for i, value in enumerate(values):
            scene = generate_scene(
                {"parameters": {**DEFAULT_PARAMETERS, key: value}, "include_vessels": False},
                "medium",
                include_simulation=False,
            )
            scene["organs"] = [scene["organs"][0]]
            save(
                f"control-{key}-{i}",
                scene,
                f"Controlled construction: only {key} changed to {value}; seed 1234",
            )

    for i, (length, radius) in enumerate(((55, 10), (80, 15), (110, 10), (60, 22))):
        scene = generate_scene(
            {
                "parameters": {"gallbladder_length_mm": length, "gallbladder_radius_mm": radius},
                "include_vessels": False,
            },
            "high",
            include_simulation=False,
        )
        scene["organs"] = [scene["organs"][1]]
        save(
            f"gb-control-{i}",
            scene,
            f"Authored control example: length {length} mm, radius control {radius} mm; not population frequency",
        )

    (OUT / "sources.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"Prepared {len(index)} actual mesh sources at {OUT}")


if __name__ == "__main__":
    main()
