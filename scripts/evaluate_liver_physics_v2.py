"""Supplemental, read-only audit of frozen v2 weights (no retraining or tuning)."""
import argparse
import json
from pathlib import Path
import time

import numpy as np

from train_liver_physics_v2 import dataset, evaluate, atomic_json, SEEDS
from viscera_core.physics_learning import decode_parameters
from viscera_core.physics_learning_v2 import load_model, predict_history, refine_parameters, observation_features


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--model", type=Path, required=True); parser.add_argument("--output", type=Path, required=True); args = parser.parse_args()
    model, digest = load_model(args.model)
    rows = dataset(640, SEEDS["test"])
    # Preserve per-specimen results to audit accepted/rejected tails independently.
    records = []; neural_ms, fit_ms, cold_ms = [], [], []
    for index, row in enumerate(rows):
        start = time.perf_counter(); result = predict_history(model, row["times"], row["strain"], row["stress"]); neural_ms.append(1000 * (time.perf_counter() - start))
        start = time.perf_counter(); baseline = refine_parameters(row["times"], row["strain"], row["stress"], decode_parameters(np.array([.5, .5, .5]))); fit_ms.append(1000 * (time.perf_counter() - start))
        if index < 20:
            start = time.perf_counter(); load_model(args.model); cold_ms.append(1000 * (time.perf_counter() - start))
        records.append({"specimen_id": row["specimen_id"], "family": row["family"], "parameters_true": row["parameters"].tolist(),
                        "parameters": result["parameters"], "intervals": result["parameter_intervals_90"], "noise_fraction": row["noise_fraction"],
                        "accepted": result["accepted_for_application"], "reasons": result["rejection_reasons"], "stress_nrmse": result["stress_nrmse"],
                        "neural_refinement_evaluations": result["refinement_evaluations"], "non_neural_refinement_evaluations": baseline["refinement_evaluations"],
                        "condition_number": result["diagnostics"]["condition_number"]})
    sweep = {}
    for index, noise in enumerate([0, .003, .01, .03, .06]):
        sweep[str(noise)] = evaluate(model, dataset(128, 739103 + index, noise_max=noise))
    timings = {"warm_neural_plus_refinement_median_ms": float(np.median(neural_ms)), "warm_neural_plus_refinement_p95_ms": float(np.percentile(neural_ms, 95)),
               "non_neural_refinement_median_ms": float(np.median(fit_ms)), "non_neural_refinement_p95_ms": float(np.percentile(fit_ms, 95)),
               "artifact_load_and_checksum_median_ms": float(np.median(cold_ms)),
               "definition": "Single CPU process OPENBLAS_NUM_THREADS=1; warm includes shared preprocessing, network, physical fit and intervals; cold load separate. Interleaved NN then baseline per same specimen, no serving/network overhead."}
    tails = {}
    names = ("young_pa", "relaxation_fraction", "relaxation_time_s")
    for label, selected in (("accepted", [r for r in records if r["accepted"]]), ("rejected", [r for r in records if not r["accepted"]])):
        widths = np.array([[(r["intervals"][k]["upper"] - r["intervals"][k]["lower"]) / r["parameters_true"][i] for i, k in enumerate(names)] for r in selected])
        errors = np.array([[abs(r["parameters"][k] / r["parameters_true"][i] - 1) for i, k in enumerate(names)] for r in selected])
        tails[label] = {"count": len(selected), "interval_relative_width_p95": dict(zip(names, np.percentile(widths, 95, axis=0).tolist(), strict=True)), "parameter_absolute_relative_error_p95": dict(zip(names, np.percentile(errors, 95, axis=0).tolist(), strict=True))}
    args.output.mkdir(parents=True, exist_ok=True)
    atomic_json(args.output / "per-specimen-test.json", {"model_sha256": digest, "records": records})
    atomic_json(args.output / "supplemental-audit.json", {"model_sha256": digest, "timing": timings, "accepted_rejected_tails": tails, "noise_sweep_max_fraction": sweep, "test_seed": SEEDS["test"], "no_model_selection": True})
    print(json.dumps(timings, indent=2))


if __name__ == "__main__": main()
