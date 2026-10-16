"""Record liver protocols and refinement diagnostics on an actual generated mesh.

PYTHONPATH=py:. python scripts/benchmark_liver_physics.py --scene generated.json
The input is an /api/atlas/generate, /sample or /sample-joint response. Its complete
recipe and learning provenance are copied into the evidence directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from viscera_core.liver_physics import run_liver_experiment
from viscera_core.physics_assessment import assess_experiment

from services.api.physics import learned_parameters


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument(
        "--out", type=Path, default=Path("benchmarks/results/liver-physics-2026-10-07")
    )
    parser.add_argument("--skip-refinement", action="store_true")
    args = parser.parse_args()
    source = json.loads(args.scene.read_text())
    liver = next(o for o in source["scene"]["organs"] if o["id"] == "liver")
    positions, faces = (
        np.asarray(liver["positions"]).reshape(-1, 3),
        np.asarray(liver["indices"]).reshape(-1, 3),
    )
    parameters, learning = learned_parameters()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "input-scene.json").write_text(json.dumps(source, separators=(",", ":")) + "\n")
    cases = [("indent", "indent", 4, 48), ("grasp", "grasp", 4, 48), ("cut", "cut", 4, 48)]
    if not args.skip_refinement:
        cases += [("grasp-finer-time", "grasp", 4, 96), ("grasp-finer-mesh", "grasp", 5, 48)]
    runs = {}
    for name, protocol, resolution, steps in cases:
        result = run_liver_experiment(
            positions, faces, parameters, protocol=protocol, resolution=resolution, steps=steps
        )
        result["learning"] = learning
        result["source"] = {"spec": source["spec"], "summary": source["summary"]}
        # Corresponding material points on the displayed source surface, not
        # mesh-dependent cage nodes and not measured anatomical landmarks.
        ids = np.linspace(0, len(positions) - 1, min(128, len(positions)), dtype=int)
        tets = np.asarray(result["mesh"]["tets"]).reshape(-1, 4)
        mapped = tets[np.asarray(result["mesh"]["embedding"]["tet_indices"])[ids]]
        weights = np.asarray(result["mesh"]["embedding"]["weights"]).reshape(-1, 4)[ids]
        result["landmarks_mm"] = [
            np.einsum(
                "ni,nij->nj", weights, np.asarray(frame["positions_mm"]).reshape(-1, 3)[mapped]
            ).tolist()
            for frame in result["frames"]
        ]
        result["visibility"] = np.ones((len(result["frames"]), len(ids)), dtype=bool).tolist()
        result["landmark_definition"] = {
            "kind": "synthetic_corresponding_material_samples_not_measured_landmarks",
            "source_vertex_ids": ids.tolist(),
        }
        result["coordinate_frame"] = "atlas-Y-up-centered-mm"
        result["protocol_windows"] = (
            {"hold_start_s": 1.0, "hold_end_s": 2.2, "release_time_s": 2.88, "recovery_end_s": 4.0}
            if protocol != "cut"
            else {}
        )
        result["assessment"] = assess_experiment(result)
        (args.out / f"{name}.json").write_text(
            json.dumps(result, allow_nan=False, separators=(",", ":")) + "\n"
        )
        runs[name] = result
        print(
            json.dumps(
                {
                    "case": name,
                    "metrics": result["metrics"],
                    "mesh": {
                        k: result["mesh"][k]
                        for k in (
                            "embedding_max_error_mm",
                            "cage_volume_ml",
                            "enclosure_over_convex_hull_pct",
                        )
                    },
                }
            ),
            flush=True,
        )
    comparisons = {}
    for name in ("grasp-finer-time", "grasp-finer-mesh"):
        if name in runs:
            reference = {**runs[name], "evidence_kind": "numerical_refinement_not_real_tissue"}
            comparisons[name] = assess_experiment(runs["grasp"], reference)
    report = {
        "schema": "viscera.liver.physics.benchmark.v1",
        "evidence": "Numerical implementation and refinement diagnostics only",
        "source_scene_sha256": hashlib.sha256(args.scene.read_bytes()).hexdigest(),
        "implementation_sha256": {
            str(path): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (
                Path("py/viscera_core/liver_physics.py"),
                Path("py/viscera_core/physics_learning.py"),
                Path("py/viscera_core/physics_assessment.py"),
                Path(__file__).relative_to(Path.cwd()),
            )
        },
        "source_spec": source["spec"],
        "source_model": source["summary"].get("joint_model", source["summary"].get("model")),
        "learning": {
            k: v for k, v in learning.items() if k not in ("observation", "fitted_stress_pa")
        },
        "cases": {
            name: {
                "metrics": run["metrics"],
                "numerical_assessment": run["assessment"]["numerical"],
                "node_count": len(run["mesh"]["reference_positions_mm"]) // 3,
                "tet_count": len(run["mesh"]["tets"]) // 4,
            }
            for name, run in runs.items()
        },
        "refinement": comparisons,
        "physical_validation": "NOT_RUN: no calibrated reference liver experiment",
        "clinical_or_surgical_realism": "NOT_ESTABLISHED",
    }
    (args.out / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, axes = plt.subplots(2, 2, figsize=(12, 7), constrained_layout=True)
        for name, color in [("indent", "#6e9eff"), ("grasp", "#dc754e")]:
            r = runs[name]
            times = np.array([f["time_s"] for f in r["frames"]])
            force = np.linalg.norm([f["tool_force_n"] for f in r["frames"]], axis=1)
            reference = np.array(r["mesh"]["reference_positions_mm"]).reshape(-1, 3)
            displacement = [
                np.linalg.norm(np.array(f["positions_mm"]).reshape(-1, 3) - reference, axis=1).max()
                for f in r["frames"]
            ]
            axes[0, 0].plot(times, force, label=name, color=color)
            axes[0, 1].plot(times, displacement, label=name, color=color)
        axes[0, 0].set(
            title="Tool reaction · simulated", xlabel="Time (s)", ylabel="Force magnitude (N)"
        )
        axes[0, 1].set(
            title="Deformation and recovery",
            xlabel="Time (s)",
            ylabel="Maximum cage displacement (mm)",
        )
        for name in ("grasp", "grasp-finer-time", "grasp-finer-mesh"):
            if name in runs:
                r = runs[name]
                axes[1, 0].plot(
                    [f["time_s"] for f in r["frames"]],
                    np.linalg.norm([f["tool_force_n"] for f in r["frames"]], axis=1),
                    label=name,
                )
        axes[1, 0].set(
            title="Numerical refinement · grasp", xlabel="Time (s)", ylabel="Force magnitude (N)"
        )
        cut = runs["cut"]
        axes[1, 1].step(
            [f["time_s"] for f in cut["frames"]],
            [f["severed_bonds"] for f in cut["frames"]],
            where="post",
            color="#934a68",
            label="irreversible seam release",
        )
        axes[1, 1].set(
            title="Scripted incision · connectivity change",
            xlabel="Time (s)",
            ylabel="Severed cohesive bonds",
        )
        for ax in axes.ravel():
            ax.grid(alpha=0.15)
            ax.legend(fontsize=8)
        fig.suptitle(
            "VISCERA · learned-parameter liver experiments\nSynthetic engineering prototype; human-liver fidelity not established",
            fontsize=13,
        )
        fig.savefig(args.out / "diagnostics.png", dpi=170)
        plt.close(fig)
    except ImportError:
        print("Install the train extra for the optional matplotlib diagnostic figure", flush=True)


if __name__ == "__main__":
    main()
