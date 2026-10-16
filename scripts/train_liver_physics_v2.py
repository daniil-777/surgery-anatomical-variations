"""Train and audit the separate protocol-conditioned physics network, CPU only.

Run with PYTHONPATH=py python scripts/train_liver_physics_v2.py --output DIR.
The final test seed is evaluated only after weights and conformal calibration
are frozen. Specimen IDs and a held-out parameter box prevent sibling leakage.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import time

import numpy as np
import torch
from torch import nn

from viscera_core.physics_learning import BOUNDS, PARAMETER_NAMES, TIMES, decode_parameters, encode_parameters, standard_strain, predict as predict_v1
from viscera_core.physics_learning_v2 import VERSION, PREPROCESSING_VERSION, SCOPE, CALIBRATION_CONTRACT, observation_features, stress_response, neural_proposals, refine_parameters, predict_history

SEEDS = {"train": 27103, "validation": 28103, "calibration": 29103, "development": 39103, "test": 139103, "parameter_region_test": 149103, "ood": 159103}
REGION = np.array([[.68, .86], [.58, .90], [.25, .60]])
PROTOCOLS = ("ramp_hold_release", "triangle", "cyclic")


def protocol(t, amplitude, family, rng):
    duration = t[-1]
    if family == "ramp_hold_release":
        ramp = max(duration * rng.uniform(.08, .22), amplitude / .25)
        release_start = max(ramp + .05, duration * rng.uniform(.45, .68))
        return amplitude * np.minimum(np.clip(t / ramp, 0, 1), np.clip((release_start + ramp - t) / ramp, 0, 1))
    if family == "triangle":
        peak = duration * rng.uniform(.22, .55)
        finish = duration * rng.uniform(.72, .95)
        return amplitude * np.minimum(np.clip(t / peak, 0, 1), np.clip((finish - t) / (finish - peak), 0, 1))
    cycles = int(rng.integers(1, 4))
    return amplitude * .5 * (1 - np.cos(2 * np.pi * cycles * t / duration))


def dataset(count, seed, *, region=False, fixed=False, noise_max=.03):
    rng = np.random.default_rng(seed); rows = []
    for specimen in range(count):
        encoded = rng.uniform(.025, .975, 3)
        if region: encoded = rng.uniform(REGION[:, 0], REGION[:, 1])
        else:
            while np.all((encoded >= REGION[:, 0]) & (encoded <= REGION[:, 1])): encoded = rng.uniform(.025, .975, 3)
        parameters = decode_parameters(encoded)
        family = PROTOCOLS[specimen % 3]
        duration = rng.uniform(1.0, 12.0)
        n = int(rng.choice([33, 65, 81, 129, 193]))
        times = np.linspace(0, duration, n)
        times[1:-1] += rng.uniform(-.18, .18, n - 2) * duration / (n - 1)
        amplitude = rng.uniform(.0053, .0485)
        strain = protocol(times, amplitude, family, rng)
        if fixed: times, strain, family = TIMES.copy(), standard_strain(), "v1_fixed_protocol"
        clean = stress_response(times, strain, parameters)
        noise_fraction = rng.uniform(.001, noise_max) if noise_max else 0
        area_gain = np.exp(rng.normal(0, .008)) if noise_max else 1
        length_gain = np.exp(rng.normal(0, .006)) if noise_max else 1
        stress = clean * area_gain + rng.normal(0, noise_fraction, len(times)) * np.max(abs(clean))
        stress += np.linspace(0, rng.normal(0, .0015), len(times)) * np.max(abs(clean)) if noise_max else 0
        observed_strain = strain * length_gain + rng.normal(0, amplitude * .001, len(times)) if noise_max else strain.copy()
        observed_strain = np.maximum(observed_strain, 0); observed_strain[0] = 0; stress[0] = 0
        rows.append({"specimen_id": f"{seed}:{specimen}", "family": family, "times": times, "strain": observed_strain,
                     "stress": stress, "clean_stress": clean, "true_strain": strain, "parameters": parameters,
                     "noise_fraction": noise_fraction, "area_gain": area_gain, "length_gain": length_gain})
    return rows


def features(rows): return np.stack([observation_features(r["times"], r["strain"], r["stress"]) for r in rows]).astype(np.float32)
def targets(rows): return encode_parameters(np.stack([r["parameters"] for r in rows])).astype(np.float32)


def export(network):
    return [{"weight": layer.weight.detach().numpy().tolist(), "bias": layer.bias.detach().numpy().tolist()} for layer in network if isinstance(layer, nn.Linear)]


def metric(parameters, truth):
    return {name: {"median_absolute_relative_error": float(np.median(abs(parameters[:, i] / truth[:, i] - 1))),
                   "p95_absolute_relative_error": float(np.percentile(abs(parameters[:, i] / truth[:, i] - 1), 95)),
                   "mae": float(np.mean(abs(parameters[:, i] - truth[:, i])))} for i, name in enumerate(PARAMETER_NAMES)}


def evaluate(model, rows, *, baselines=False):
    predictions, neural, truth, errors, clean_errors, accepted, widths, covers, evaluations, baseline_predictions, baseline_errors, baseline_evaluations = [], [], [], [], [], [], [], [], [], [], [], []
    for row in rows:
        result = predict_history(model, row["times"], row["strain"], row["stress"])
        p = np.array([result["parameters"][k] for k in PARAMETER_NAMES]); n = np.array([result["neural_parameters"][k] for k in PARAMETER_NAMES])
        predictions.append(p); neural.append(n); truth.append(row["parameters"]); errors.append(result["stress_nrmse"])
        clean_fit = stress_response(row["times"], row["true_strain"], p)
        clean_errors.append(float(np.sqrt(np.mean((clean_fit - row["clean_stress"]) ** 2)) / np.max(abs(row["clean_stress"]))))
        accepted.append(result["accepted_for_application"]); evaluations.append(result["refinement_evaluations"])
        intervals = result["parameter_intervals_90"]
        widths.append([(intervals[k]["upper"] - intervals[k]["lower"]) / row["parameters"][i] for i, k in enumerate(PARAMETER_NAMES)])
        covers.append([intervals[k]["lower"] <= row["parameters"][i] <= intervals[k]["upper"] for i, k in enumerate(PARAMETER_NAMES)])
        if baselines:
            pure = refine_parameters(row["times"], row["strain"], row["stress"], decode_parameters(np.array([.5, .5, .5])))
            baseline_predictions.append(pure["parameters_array"]); baseline_errors.append(pure["stress_nrmse"]); baseline_evaluations.append(pure["refinement_evaluations"])
    predictions, neural, truth, widths, covers = map(np.asarray, (predictions, neural, truth, widths, covers))
    result = {"count": len(rows), "parameter_metrics": metric(predictions, truth), "neural_only_parameter_metrics": metric(neural, truth),
              "stress_nrmse_median": float(np.median(errors)), "stress_nrmse_p95": float(np.percentile(errors, 95)),
              "clean_response_nrmse_median": float(np.median(clean_errors)), "clean_response_nrmse_p95": float(np.percentile(clean_errors, 95)),
              "application_acceptance_rate": float(np.mean(accepted)), "refinement_evaluations_median": float(np.median(evaluations)),
              "interval_coverage_90": dict(zip(PARAMETER_NAMES, covers.mean(axis=0).tolist(), strict=True)),
              "interval_relative_width_median": dict(zip(PARAMETER_NAMES, np.median(widths, axis=0).tolist(), strict=True)),
              "interval_relative_width_p95": dict(zip(PARAMETER_NAMES, np.percentile(widths, 95, axis=0).tolist(), strict=True))}
    if baselines: result["non_neural_bounded_fit"] = {"parameter_metrics": metric(np.asarray(baseline_predictions), truth), "stress_nrmse_median": float(np.median(baseline_errors)), "stress_nrmse_p95": float(np.percentile(baseline_errors, 95)), "refinement_evaluations_median": float(np.median(baseline_evaluations))}
    return result


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp"); temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n"); os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--output", type=Path, required=True); parser.add_argument("--train", type=int, default=12000); parser.add_argument("--epochs", type=int, default=280); parser.add_argument("--test", type=int, default=640); parser.add_argument("--v1", type=Path, default=Path("/tmp/viscera-liver-model-v1")); args = parser.parse_args()
    torch.set_num_threads(2); started = time.perf_counter(); args.output.mkdir(parents=True, exist_ok=True)
    train = dataset(args.train, SEEDS["train"]); validation = dataset(1200, SEEDS["validation"]); calibration = dataset(900, SEEDS["calibration"])
    x, y = torch.from_numpy(features(train)), torch.from_numpy(targets(train)); vx, vy = torch.from_numpy(features(validation)), torch.from_numpy(targets(validation))
    model = {"version": VERSION, "preprocessing_version": PREPROCESSING_VERSION, "parameter_names": list(PARAMETER_NAMES), "bounds": BOUNDS.tolist(), "members": [], "calibration": {"quantiles_90": [1, 1, 1]}}
    histories = []; maximum_export_discrepancy = 0.0
    for member in range(3):
        torch.manual_seed(6103 + member)
        network = nn.Sequential(nn.Linear(x.shape[1], 160), nn.ReLU(), nn.Linear(160, 96), nn.ReLU(), nn.Linear(96, 3), nn.Sigmoid())
        optimizer = torch.optim.AdamW(network.parameters(), lr=.002, weight_decay=.0001)
        best, best_state, best_epoch = float("inf"), None, 0
        for epoch in range(args.epochs):
            network.train(); order = torch.randperm(len(x))
            for batch in order.split(512):
                predicted = network(x[batch]); loss = ((predicted - y[batch]) ** 2).mean(); optimizer.zero_grad(); loss.backward(); optimizer.step()
            if epoch % 5 == 0 or epoch + 1 == args.epochs:
                network.eval()
                with torch.no_grad(): score = float(((network(vx) - vy) ** 2).mean())
                if score < best: best, best_epoch, best_state = score, epoch + 1, {k: v.clone() for k, v in network.state_dict().items()}
        network.load_state_dict(best_state); model["members"].append(export(network)); histories.append({"member": member, "best_epoch": best_epoch, "validation_normalized_mse": best})
        with torch.no_grad(): torch_prediction = decode_parameters(network(vx[:16]).numpy())
        exported_prediction = neural_proposals({"members": [model["members"][-1]]}, vx[:16].numpy())[0]
        maximum_export_discrepancy = max(maximum_export_discrepancy, float(np.max(abs(exported_prediction / torch_prediction - 1))))
        print(json.dumps({"member": member, "best_epoch": best_epoch, "validation_mse": best}), flush=True)
    scores = []
    for row in calibration:
        proposal = neural_proposals(model, observation_features(row["times"], row["strain"], row["stress"])).mean(axis=0)
        fit = refine_parameters(row["times"], row["strain"], row["stress"], proposal)
        scores.append(abs(fit["encoded"] - encode_parameters(row["parameters"])) / fit["sigma_encoded"])
    # Finite-sample marginal split-conformal order statistic, never test-derived.
    level = min(1, np.ceil((len(scores) + 1) * .9) / len(scores))
    model["calibration"] = {"quantiles_90": np.quantile(scores, level, axis=0, method="higher").tolist(), "count": len(scores), "seed": SEEDS["calibration"], "nominal_marginal_coverage": .9, "method": "split conformal standardized encoded-parameter error", "scope": "same-distribution synthetic specimens, not simultaneous joint or human coverage"}
    print(json.dumps({"calibration": model["calibration"]}), flush=True)
    atomic_json(args.output / "model.json", model); digest = hashlib.sha256((args.output / "model.json").read_bytes()).hexdigest()
    atomic_json(args.output / "manifest.json", {"version": VERSION, "model_sha256": digest, "scope": SCOPE, "calibration_contract": CALIBRATION_CONTRACT})
    tests = dataset(args.test, SEEDS["test"]); region = dataset(args.test // 2, SEEDS["parameter_region_test"], region=True)
    fixed = dataset(args.test // 2, SEEDS["test"] + 1, fixed=True, noise_max=.003)
    iid = evaluate(model, tests, baselines=True); region_report = evaluate(model, region); fixed_report = evaluate(model, fixed)
    print(json.dumps({"iid": iid, "parameter_region": region_report, "fixed": fixed_report}), flush=True)
    v1_params = np.stack([np.array(list(predict_v1(args.v1, r["stress"])["parameters"].values())) for r in fixed])
    v1_errors = [float(np.sqrt(np.mean((stress_response(r["times"], r["strain"], p) - r["stress"]) ** 2)) / np.max(abs(r["stress"]))) for p, r in zip(v1_params, fixed)]
    v1_report = {"parameter_metrics": metric(v1_params, np.stack([r["parameters"] for r in fixed])), "stress_nrmse_median": float(np.median(v1_errors)), "stress_nrmse_p95": float(np.percentile(v1_errors, 95))}
    # Structural mismatch is not automatically identifiable: report detection,
    # including near-equivalent two-time-scale traces that may legitimately fit.
    ood = dataset(240, SEEDS["ood"], noise_max=.01); ood_results = {}
    for label in ("two_branch", "nonlinear", "gross_mismatch"):
        accepted, errors = [], []
        for row in ood:
            t, e, p = row["times"], row["strain"], row["parameters"]
            if label == "two_branch":
                p1, p2 = p.copy(), p.copy(); p1[2] = max(.02, p[2] * .12); p2[2] = min(8, p[2] * 4)
                stress = .5 * stress_response(t, e, p1) + .5 * stress_response(t, e, p2)
            elif label == "nonlinear": stress = stress_response(t, e * (1 + 25 * e), p)
            else: stress = row["stress"] + .35 * np.max(abs(row["stress"])) * np.sin(2 * np.pi * 6.5 * t / t[-1]); stress[0] = 0
            result = predict_history(model, t, e, stress); accepted.append(result["accepted_for_application"]); errors.append(result["stress_nrmse"])
        ood_results[label] = {"count": len(ood), "rejection_rate": 1 - float(np.mean(accepted)), "stress_nrmse_median": float(np.median(errors))}
    gates = {"fixed_protocol_stress_p95_below_1pct": fixed_report["stress_nrmse_p95"] <= .01,
             "iid_stress_p95_below_5pct": iid["stress_nrmse_p95"] <= .05,
             "iid_median_E_error_below_5pct": iid["parameter_metrics"]["young_pa"]["median_absolute_relative_error"] <= .05,
             "iid_median_g_tau_error_below_15pct": all(iid["parameter_metrics"][k]["median_absolute_relative_error"] <= .15 for k in PARAMETER_NAMES[1:]),
             "marginal_coverage_at_least_85pct": min(iid["interval_coverage_90"].values()) >= .85,
             "median_interval_width_useful": all(iid["interval_relative_width_median"][k] <= limit for k, limit in zip(PARAMETER_NAMES, [.25, .6, .8])),
             "iid_false_reject_at_most_10pct": iid["application_acceptance_rate"] >= .9,
             "gross_mismatch_rejected_90pct": ood_results["gross_mismatch"]["rejection_rate"] >= .9,
             "heldout_region_E_median_below_8pct": region_report["parameter_metrics"]["young_pa"]["median_absolute_relative_error"] <= .08}
    report = {"schema": "viscera.physics.learning-evaluation.v2", "model_sha256": digest, "version": VERSION, "scope": SCOPE,
              "split_unit": "Independent synthetic parameter specimens; one history per specimen; no frame-level splits", "split_seeds": SEEDS,
              "split_counts": {"train": len(train), "validation": len(validation), "calibration": len(calibration), "test": len(tests), "parameter_region_test": len(region)},
              "excluded_encoded_parameter_region": REGION.tolist(), "excluded_region_definition": "All three encoded coordinates simultaneously inside the box; excluded from train, validation, calibration and IID test",
              "dataset_fingerprint": {name: hashlib.sha256("|".join(r["specimen_id"] for r in rows).encode()).hexdigest() for name, rows in (("train", train), ("validation", validation), ("calibration", calibration), ("test", tests), ("region", region))},
              "training_domains": {"protocols": PROTOCOLS, "force_noise_peak_fraction": [.001, .03], "strain_noise_amplitude_fraction": .001, "multiplicative_stress_scale_log_sd": .008, "strain_scale_log_sd": .006, "sample_counts": [33,65,81,129,193], "duration_s": [1,12], "strain_amplitude": [.0053,.0485], "accepted_strain_margin": [.005,.05]},
              "selection": "Validation selects weights; separate calibration determines conformal quantiles; frozen test never selects weights or intervals", "histories": histories,
              "parameter_metrics": iid["parameter_metrics"], "held_out_stress_nrmse_median": iid["stress_nrmse_median"], "held_out_stress_nrmse_p95": iid["stress_nrmse_p95"],
              "iid": iid, "heldout_parameter_region": region_report, "fixed_protocol": fixed_report, "v1_same_fixed_test": v1_report,
              "ood": ood_results, "calibration": model["calibration"], "gates": gates, "synthetic_gate_passed": all(gates.values()),
              "torch_numpy_export_max_relative_difference": maximum_export_discrepancy,
              "development_history": "Initial implementation evaluated seeds39103/49103/59103 in development only; final audit uses untouched139103/149103/159103. Support bounds expanded before final freeze; gates unchanged.",
              "human_liver_validation": "NOT_RUN", "independent_solver_validation": "NOT_RUN", "training_and_evaluation_seconds": time.perf_counter() - started,
              "limitations": ["One-term small-strain SLS is not a complete liver constitutive model", "Some multi-branch/nonlinear histories fit one-term SLS and are not detectable from one experiment", "Calibration scale errors beyond randomized support are not identifiable from force/displacement alone", "Non-neural bounded fitting can be equally accurate; the network supplies a learned proposal, not independent physical evidence"]}
    atomic_json(args.output / "evaluation.json", report)
    print(json.dumps({"gates": gates, "synthetic_gate_passed": report["synthetic_gate_passed"], "seconds": report["training_and_evaluation_seconds"]}), flush=True)


if __name__ == "__main__": main()
