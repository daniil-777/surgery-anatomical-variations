"""Calibrate/audit an optional policy without retraining the frozen v2 network.

Development and final specimen seeds are disjoint. Run development first, then
freeze source/plan before the one-shot final audit. No historical v2 test rows
are used for selection, calibration, or the new headline numbers.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import time
from pathlib import Path

import numpy as np

from train_liver_physics_v2 import dataset, atomic_json
from viscera_core import physics_learning_v2 as v2
from viscera_core import physics_learning_robust as robust
from viscera_core.physics_learning import PARAMETER_NAMES, decode_parameters

SEEDS = {
    "development": {"calibration": 771101, "iid": 771102, "region": 771103, "high_excitation": 771104,
                    "two_branch": 771201, "nonlinear": 771202, "two_branch_high": 771203, "nonlinear_high": 771204,
                    "noise_low": 771301, "noise_high": 771302, "noise_correlated": 771303},
    "final": {"calibration": 1071101, "iid": 1071102, "region": 1071103, "high_excitation": 1071104,
              "two_branch": 1071201, "nonlinear": 1071202, "two_branch_high": 1071203, "nonlinear_high": 1071204,
              "noise_low": 1071301, "noise_high": 1071302, "noise_correlated": 1071303},
}
GATES = {"accepted_iid_p95_relative_error": dict(zip(PARAMETER_NAMES, [.10, .20, .35])),
         "minimum_iid_acceptance": .65, "maximum_iid_structured_check_false_rejection": .075,
         "minimum_iid_marginal_interval_coverage": .85, "minimum_pooled_mismatch_rejection_improvement": .10,
         "maximum_low_noise_structured_false_rejection": .10,
         "minimum_iid_accepted_specimens": 500}


def cohort(count: int, seed: int, *, high=False, mismatch=None, noise_max=.03, correlated=False, region=False):
    rows = dataset(count, seed, region=region, noise_max=noise_max)
    rng = np.random.default_rng(seed + 10000000)
    for row in rows:
        t, e, p = row["times"], row["true_strain"], row["parameters"]
        if high:
            duration = rng.uniform(6, 12)
            t = np.linspace(0, duration, 193)
            t[1:-1] += rng.uniform(-.1, .1, len(t) - 2) * duration / (len(t) - 1)
            amplitude = rng.uniform(.012, .045)
            e = amplitude * np.interp(t / duration, [0, .035, .11, .16, .21, .29, .36, .50, .61, .67, .70, .80, .9, 1],
                                     [0, .35, .35, 0, 0, 1, 1, .65, .65, 0, .55, .55, 0, 0])
            row["family"] = "multirate_multiamplitude_validation_only"
        clean = v2.stress_response(t, e, p)
        if mismatch == "two_branch":
            first, second = p.copy(), p.copy()
            first[2] = max(.01, p[2] * rng.uniform(.08, .25))
            second[2] = min(8., p[2] * rng.uniform(2.5, 7.))
            weight = rng.uniform(.25, .75)
            clean = weight * v2.stress_response(t, e, first) + (1 - weight) * v2.stress_response(t, e, second)
            row["mismatch_truth"] = {"fast_tau_s": first[2], "slow_tau_s": second[2], "fast_weight": weight}
        elif mismatch == "nonlinear":
            coefficient = rng.uniform(10, 40)
            clean = v2.stress_response(t, e * (1 + coefficient * e), p)
            row["mismatch_truth"] = {"quadratic_strain_coefficient": coefficient}
        if not high and mismatch is None and not correlated:
            continue  # Exactly the original v2 valid-SLS observation generator.
        noise = rng.normal(0, row["noise_fraction"], len(t))
        if correlated:
            for i in range(1, len(noise)):
                noise[i] = .65 * noise[i - 1] + np.sqrt(1 - .65 ** 2) * noise[i]
        stress = clean * row["area_gain"] + noise * np.max(abs(clean))
        stress += np.linspace(0, rng.normal(0, .0015), len(t)) * np.max(abs(clean))
        observed_strain = np.maximum(0, e * row["length_gain"] + rng.normal(0, np.max(e) * .001, len(t)))
        observed_strain[0] = stress[0] = 0
        row.update(times=t, true_strain=e, strain=observed_strain, stress=stress, clean_stress=clean)
    return rows


def pure_fit_result(model, row):
    fit = v2.refine_parameters(row["times"], row["strain"], row["stress"], decode_parameters(np.array([.5, .5, .5])))
    diag = v2.diagnostics(row["times"], row["strain"], row["stress"], fit)
    q = np.asarray(model["calibration"]["quantiles_90"])
    lo = v2.decode_parameters(fit["encoded"] - q * fit["sigma_encoded"])
    hi = v2.decode_parameters(fit["encoded"] + q * fit["sigma_encoded"])
    return {"parameters": dict(zip(PARAMETER_NAMES, fit["parameters_array"].tolist())),
            "fitted_stress_pa": fit["fitted_stress_pa"].tolist(), "stress_nrmse": fit["stress_nrmse"],
            "parameter_intervals_90": {k: {"lower": lo[i], "upper": hi[i]} for i, k in enumerate(PARAMETER_NAMES)},
            "rejection_reasons": diag["reasons"], "accepted_for_application": not diag["reasons"],
            "within_synthetic_fit_gate": fit["stress_nrmse"] <= .05}


def summarize(records, valid):
    accepted = [r for r in records if r["accepted"]]
    baseline_accepted = [r for r in records if r["v2_accepted"]]
    report = {"count": len(records), "accepted_count": len(accepted), "acceptance": len(accepted) / len(records),
              "v2_acceptance": len(baseline_accepted) / len(records),
              "structured_check_rejection_rate": float(np.mean([not r["structured_passed"] for r in records])),
              "precision_check_rejection_rate": float(np.mean([not r["precision_passed"] for r in records])),
              "rejection_reasons": dict(Counter(reason for r in records for reason in r["reasons"])),
              "added_policy_latency_median_ms": float(np.median([r["policy_ms"] for r in records])),
              "added_policy_latency_p95_ms": float(np.percentile([r["policy_ms"] for r in records], 95))}
    if valid:
        for label, group in (("all", records), ("accepted", accepted), ("v2_accepted", baseline_accepted)):
            if not group:
                report[label] = {"count": 0}; continue
            errors = np.asarray([r["parameter_relative_error"] for r in group])
            coverage = np.asarray([r["interval_covered"] for r in group])
            widths = np.asarray([r["displayed_interval_relative_width"] for r in group])
            report[label] = {"count": len(group),
                             "median_relative_error": dict(zip(PARAMETER_NAMES, np.median(errors, axis=0).tolist())),
                             "p95_relative_error": dict(zip(PARAMETER_NAMES, np.percentile(errors, 95, axis=0).tolist())),
                             "interval_marginal_coverage": dict(zip(PARAMETER_NAMES, coverage.mean(axis=0).tolist())),
                             "median_displayed_interval_relative_width": dict(zip(PARAMETER_NAMES, np.median(widths, axis=0).tolist()))}
        paired = [r for r in records if "non_neural_accepted" in r]
        if paired:
            paired_accepted = [r for r in paired if r["accepted"] and r["non_neural_accepted"]]
            baseline_accepted = [r for r in paired if r["non_neural_accepted"]]
            report["non_neural_comparison"] = {"count": len(paired),
                "acceptance": float(np.mean([r["non_neural_accepted"] for r in paired])),
                "acceptance_agreement": float(np.mean([r["accepted"] == r["non_neural_accepted"] for r in paired])),
                "maximum_relative_parameter_difference": float(np.max([r["non_neural_parameter_difference"] for r in paired])),
                "jointly_accepted_maximum_relative_parameter_difference": float(np.max([r["non_neural_parameter_difference"] for r in paired_accepted])) if paired_accepted else None,
                "accepted_p95_relative_error": dict(zip(PARAMETER_NAMES, np.percentile([r["non_neural_parameter_error"] for r in baseline_accepted], 95, axis=0).tolist())) if baseline_accepted else None}
    else:
        for label, group in (("near_equivalent_clean_response", [r for r in records if r["best_clean_sls_nrmse"] <= .01]),
                             ("material_clean_mismatch", [r for r in records if r["best_clean_sls_nrmse"] > .01])):
            report[label] = {"count": len(group), "rejection_rate": 1 - float(np.mean([r["accepted"] for r in group])) if group else None,
                             "v2_rejection_rate": 1 - float(np.mean([r["v2_accepted"] for r in group])) if group else None}
    return report


def evaluate(model, policy, rows, *, valid=True, compare_non_neural=False):
    records = []
    for index, row in enumerate(rows):
        t, e, stress = row["times"], row["strain"], row["stress"]
        base = v2.predict_history(model, t, e, stress)
        start = time.perf_counter(); result = robust.apply_policy(model, policy, t, e, stress, base); elapsed = 1000 * (time.perf_counter() - start)
        diagnostics = result["application_diagnostics"]
        record = {"specimen_id": row["specimen_id"], "family": row["family"], "noise_fraction": row["noise_fraction"],
                  "accepted": result["accepted_for_application"], "v2_accepted": base["accepted_for_application"],
                  "reasons": result["rejection_reasons"], "precision_passed": diagnostics["precision_passed"],
                  "structured_passed": diagnostics["structured_residual_passed"], "policy_ms": elapsed,
                  "stress_nrmse": result["stress_nrmse"], "parameters": result["parameters"],
                  "diagnostics": diagnostics, "intervals": result["parameter_intervals_90"]}
        if valid:
            p = np.array([result["parameters"][k] for k in PARAMETER_NAMES]); truth = row["parameters"]
            record.update(parameters_true=truth.tolist(), parameter_relative_error=abs(p / truth - 1).tolist(),
                interval_covered=[bool(result["parameter_intervals_90"][k]["lower"] <= truth[i] <= result["parameter_intervals_90"][k]["upper"]) for i, k in enumerate(PARAMETER_NAMES)],
                displayed_interval_relative_width=[(result["parameter_intervals_90"][k]["upper"] - result["parameter_intervals_90"][k]["lower"]) / truth[i] for i, k in enumerate(PARAMETER_NAMES)])
        else:
            clean_fit = v2.refine_parameters(t, row["true_strain"], row["clean_stress"], np.array(list(result["parameters"].values())))
            record.update(best_clean_sls_nrmse=clean_fit["stress_nrmse"], mismatch_truth=row["mismatch_truth"])
        if compare_non_neural:
            non_neural = robust.apply_policy(model, policy, t, e, stress, pure_fit_result(model, row))
            record["non_neural_accepted"] = non_neural["accepted_for_application"]
            record["non_neural_parameter_difference"] = float(np.max([abs(non_neural["parameters"][k] / result["parameters"][k] - 1) for k in PARAMETER_NAMES]))
            record["non_neural_parameter_error"] = [abs(non_neural["parameters"][k] / row["parameters"][i] - 1) for i, k in enumerate(PARAMETER_NAMES)]
        records.append(record)
    return summarize(records, valid), records


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--model", type=Path, required=True); parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stage", choices=("development", "final"), default="development"); args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True); started = time.perf_counter()
    model, digest = v2.load_model(args.model); seeds = SEEDS[args.stage]
    # Saved before evaluating any calibration/test specimens.
    counts = {"calibration": 2400 if args.stage == "final" else 900, "iid": 1000 if args.stage == "final" else 400,
              "secondary": 320 if args.stage == "final" else 120, "noise": 160 if args.stage == "final" else 80}
    plan = {"schema": "physics-robustness-frozen-plan-1.0", "stage": args.stage, "seeds": seeds, "counts": counts,
            "policy_version": robust.POLICY_VERSION, "score_version": robust.SCORE_VERSION, "model_sha256": digest,
            "gates": GATES, "precision_limits": robust.PRECISION_LIMITS, "residual_alpha": robust.ALPHA,
            "noise_stratum_boundaries": list(robust.NOISE_STRATUM_BOUNDARIES),
            "split_unit": "One independent parameter specimen and experiment per row; specimen seeds disjoint from all historical v2 cohorts",
            "no_human_data": True, "no_weight_retraining": True,
            "source_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__), Path(robust.__file__)]}}
    atomic_json(args.output / "frozen-plan.json", plan)
    calibration = cohort(counts["calibration"], seeds["calibration"])
    scores = []; strata = [[], [], []]
    for row in calibration:
        base = v2.predict_history(model, row["times"], row["strain"], row["stress"])
        diagnostic = robust.residual_and_precision(model, row["times"], row["strain"], row["stress"], base)
        score = diagnostic["structured_residual_score"]; scores.append(score)
        stratum = int(np.searchsorted(robust.NOISE_STRATUM_BOUNDARIES, diagnostic["successive_difference_noise_fraction"], side="right"))
        strata[stratum].append(score)
    policy = {"version": robust.POLICY_VERSION, "score_version": robust.SCORE_VERSION, "model_sha256": digest,
              "maximum_unclipped_span_relative": robust.PRECISION_LIMITS, "structured_residual_alpha": robust.ALPHA,
              "residual_calibration_scores": sorted(scores), "calibration_seed": seeds["calibration"],
              "noise_stratum_boundaries": list(robust.NOISE_STRATUM_BOUNDARIES),
              "residual_calibration_strata": [sorted(values) for values in strata],
              "calibration_count": len(scores), "scope": "Synthetic calibrated uniaxial small-strain experiments only; no human posterior or constitutive-validation claim"}
    atomic_json(args.output / "application-policy.json", policy)
    policy_digest = hashlib.sha256((args.output / "application-policy.json").read_bytes()).hexdigest()
    atomic_json(args.output / "policy-manifest.json", {"policy_version": robust.POLICY_VERSION, "policy_sha256": policy_digest, "model_sha256": digest})
    print(json.dumps({"calibration_count": len(scores), "stratum_counts": list(map(len, strata)), "score_p95": float(np.percentile(scores, 95)), "policy_sha256": policy_digest}), flush=True)
    reports, per_specimen = {}, {}
    specifications = {
        "iid": (counts["iid"], {}, True), "region": (counts["secondary"], {"region": True}, True),
        "high_excitation": (counts["secondary"], {"high": True}, True),
        "two_branch": (counts["secondary"], {"mismatch": "two_branch"}, False),
        "nonlinear": (counts["secondary"], {"mismatch": "nonlinear"}, False),
        "two_branch_high": (counts["secondary"], {"mismatch": "two_branch", "high": True}, False),
        "nonlinear_high": (counts["secondary"], {"mismatch": "nonlinear", "high": True}, False),
        "noise_low": (counts["noise"], {"noise_max": .003}, True),
        "noise_high": (counts["noise"], {"noise_max": .06}, True),
        "noise_correlated": (counts["noise"], {"correlated": True}, True),
    }
    for name, (count, options, valid) in specifications.items():
        report, records = evaluate(model, policy, cohort(count, seeds[name], **options), valid=valid, compare_non_neural=name == "iid")
        reports[name], per_specimen[name] = report, records
        atomic_json(args.output / f"specimens-{name}.json", records)
        print(json.dumps({"cohort": name, "report": report}), flush=True)
    iid = reports["iid"]
    mismatch = [reports[k] for k in ("two_branch", "nonlinear", "two_branch_high", "nonlinear_high")]
    improvement = float(np.mean([r["v2_acceptance"] - r["acceptance"] for r in mismatch]))
    checks = {
        "accepted_iid_tail_error": all(iid["accepted"]["p95_relative_error"][k] <= limit for k, limit in GATES["accepted_iid_p95_relative_error"].items()),
        "iid_acceptance": iid["acceptance"] >= GATES["minimum_iid_acceptance"],
        "iid_structured_false_rejection": iid["structured_check_rejection_rate"] <= GATES["maximum_iid_structured_check_false_rejection"],
        "iid_interval_coverage": min(iid["all"]["interval_marginal_coverage"].values()) >= GATES["minimum_iid_marginal_interval_coverage"],
        "mismatch_rejection_improvement": improvement >= GATES["minimum_pooled_mismatch_rejection_improvement"],
        "low_noise_structured_false_rejection": reports["noise_low"]["structured_check_rejection_rate"] <= GATES["maximum_low_noise_structured_false_rejection"],
        "accepted_count": iid["accepted_count"] >= (GATES["minimum_iid_accepted_specimens"] if args.stage == "final" else 200),
    }
    report = {"schema": "physics-ai-robustness-1.0", "stage": args.stage, "model_sha256": digest, "policy_sha256": policy_digest,
              "cohorts": reports, "gates": checks, "all_gates_passed": all(checks.values()),
              "pooled_mismatch_rejection_improvement": improvement,
              "scope": "Synthetic experimental adequacy only. Acceptance is not a guarantee of material validity. Unclipped spans correct prior-truncation optimism, not calibrated posterior support beyond bounds.",
              "no_human_tissue_validation": True, "historical_v2_evidence_untouched": True,
              "parameter_model_unchanged": True, "non_neural_adequacy_policy": True,
              "iteration_history": "Pooled policy1.0 (871xxx) had22.5% low-noise false rejection; stratified1.1 (971xxx) failed the new<=10% gate at11.875%. Both are preserved as rejected candidates. Policy1.2 also removes the linear sensor-drift nuisance already present in the declared generator; precision/mismatch/low-noise gates unchanged, final1071xxx seeds untouched before freeze.",
              "calibration_and_evaluation_seconds": time.perf_counter() - started,
              "specimen_id_fingerprints": {name: hashlib.sha256("|".join(r["specimen_id"] for r in records).encode()).hexdigest() for name, records in per_specimen.items()},
              "runtime": {"numpy": np.__version__, "execution": "CPU, OPENBLAS_NUM_THREADS=1; local dependency mirror"}}
    atomic_json(args.output / "evaluation.json", report)
    print(json.dumps({"gates": checks, "all_gates_passed": report["all_gates_passed"]}), flush=True)


if __name__ == "__main__": main()
