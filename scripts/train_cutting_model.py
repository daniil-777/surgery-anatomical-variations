"""Train/evaluate isolated synthetic cohesive inverse model; CPU, safe JSON export.

PYTHONPATH=py .venv/bin/python scripts/train_cutting_model.py
"""
from __future__ import annotations
import argparse
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import torch
from torch import nn
from viscera_core.cutting_learning import ALPHA, BOUNDS, VERSION, SCOPE, cohesive_response, decode, encode, features, neural_proposal, refine, assess, demo_observation, infer


def dataset(count: int, seed: int):
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(count):
        p = decode(rng.uniform(.035, .965, 2))
        df = 2 * p[0] / p[1]
        n = int(rng.choice([97, 129, 161, 193]))
        x = np.linspace(0, rng.uniform(1.15, 1.5) * df, n)
        if i % 3 == 0:
            at = int(rng.uniform(.25, .6) * n)
            loop = np.r_[np.linspace(x[at], x[at] * rng.uniform(.2, .7), 12)[1:], np.linspace(x[at] * .1, x[at], 14)]
            x = np.r_[x[:at + 1], loop, x[at + 1:]]
        clean = cohesive_response(x, p)
        noise = rng.uniform(.0005, .018)
        stress = clean + rng.normal(0, noise * p[1], len(x))
        stress[0] = 0
        rows.append((x, stress, p))
    return rows


def evaluate(model, rows):
    estimated, neural, baseline, errors, accepted, discrepancies = [], [], [], [], [], []
    for x, s, p in rows:
        proposal = neural_proposal(model, x, s); fit = refine(x, s, proposal); plain = refine(x, s)
        estimated.append(fit["parameters"] / p - 1); neural.append(proposal / p - 1); baseline.append(plain["parameters"] / p - 1)
        errors.append(fit["residualNrmse"]); accepted.append(assess(x, s, fit)["accepted"])
        discrepancies.append(float(np.max(abs(fit["parameters"] / plain["parameters"] - 1))))
    metric = lambda data: {"median_absolute_relative_error": np.median(abs(np.asarray(data)), axis=0).tolist(), "p95_absolute_relative_error": np.percentile(abs(np.asarray(data)), 95, axis=0).tolist()}
    return {"count": len(rows), "hybrid": metric(estimated), "neural_only": metric(neural), "non_neural_profile_fit": metric(baseline), "residual_nrmse_p95": float(np.percentile(errors, 95)), "acceptance_rate": float(np.mean(accepted)), "maximum_hybrid_baseline_relative_difference": max(discrepancies)}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--train", type=int, default=5000); parser.add_argument("--epochs", type=int, default=160); parser.add_argument("--test", type=int, default=160)
    parser.add_argument("--output", type=Path, default=Path("apps/studio/public/models/cutting-v1")); parser.add_argument("--report", type=Path, default=Path("artifacts/cutting-learning-2026-10-20")); args = parser.parse_args()
    torch.set_num_threads(2); torch.use_deterministic_algorithms(True); started = time.perf_counter()
    train, validation = dataset(args.train, 77201), dataset(600, 78201)
    tensor = lambda rows: (torch.tensor(np.stack([features(x, s) for x, s, _ in rows]), dtype=torch.float32), torch.tensor(np.stack([encode(p) for _, _, p in rows]), dtype=torch.float32))
    x, y = tensor(train); vx, vy = tensor(validation)
    model = {"schema": VERSION, "alpha": ALPHA, "bounds": BOUNDS.tolist(), "featurePoints": 65, "parameterNames": ["fractureEnergyJm2", "peakTractionPa"], "members": [], "scope": SCOPE, "evidence": "synthetic_only", "humanLiverValidated": False, "training": {"seed": 77201, "count": len(train), "validationSeed": 78201, "validationCount": len(validation), "splitUnit": "independent synthetic coupon specimen; no shared frames", "noisePeakFraction": [.0005, .018], "strainRateLearning": False}, "limitations": ["Fixed bilinear Mode-I law and onset ratio; no tissue-specific evidence", "Known area and opening; bulk compliance and blade friction must be removed independently", "No force prediction from surgical video", "No calibrated parameter uncertainty interval", "Bounded non-neural profile fit is an equally valid baseline"]}
    histories = []
    for member in range(3):
        torch.manual_seed(79201 + member)
        net = nn.Sequential(nn.Linear(x.shape[1], 96), nn.ReLU(), nn.Linear(96, 48), nn.ReLU(), nn.Linear(48, 2), nn.Sigmoid())
        optimizer = torch.optim.AdamW(net.parameters(), lr=.002, weight_decay=.0001)
        best = float("inf"); state = None
        for epoch in range(args.epochs):
            for batch in torch.randperm(len(x)).split(256):
                prediction = net(x[batch]); loss = ((prediction - y[batch]) ** 2).mean(); optimizer.zero_grad(); loss.backward(); optimizer.step()
            if epoch % 5 == 0 or epoch + 1 == args.epochs:
                with torch.no_grad(): score = float(((net(vx) - vy) ** 2).mean())
                if score < best: best, state = score, {k: v.clone() for k, v in net.state_dict().items()}
        net.load_state_dict(state)
        model["members"].append([{"weight": layer.weight.detach().numpy().tolist(), "bias": layer.bias.detach().numpy().tolist()} for layer in net if isinstance(layer, nn.Linear)])
        histories.append({"member": member, "validation_encoded_mse": best})
        print(json.dumps(histories[-1]), flush=True)
    # Freeze weights before evaluation on independent specimens. Final test does
    # not select weights or rejection thresholds.
    payload = json.dumps(model, separators=(",", ":"), allow_nan=False)
    digest = hashlib.sha256(payload.encode()).hexdigest(); model["modelId"] = digest
    tests = dataset(args.test, 89201); evaluation = evaluate(model, tests)
    demo = demo_observation(); fit = infer(model, demo)
    xdemo = np.asarray(demo["opening_mm"]) * .001; sdemo = np.asarray(demo["force_n"]) / 25e-6
    invalid = {}
    for name, xx, ss in [("incomplete", xdemo[:50], sdemo[:50]), ("post_fracture_load", xdemo, sdemo + np.linspace(0, 6000, len(sdemo))), ("constant_force", xdemo, np.r_[0., np.full(len(sdemo) - 1, 8000.)])]:
        candidate = refine(xx, ss); invalid[name] = assess(xx, ss, candidate)
    gates = {"heldout_p95_parameter_error_under_8pct": max(evaluation["hybrid"]["p95_absolute_relative_error"]) < .08, "heldout_acceptance_above_90pct": evaluation["acceptance_rate"] >= .9, "heldout_residual_p95_under_3pct": evaluation["residual_nrmse_p95"] < .03, "incomplete_and_mismatched_rejected": all(not v["accepted"] for v in invalid.values()), "demo_recovered": fit["accepted"] and fit["residualNrmse"] < 1e-6}
    sources = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in (Path("py/viscera_core/cutting_learning.py"), Path("scripts/train_cutting_model.py"), Path("apps/studio/src/cutting/cohesive.ts"), Path("apps/studio/src/cutting/calibration.ts"))}
    fingerprints = {name: hashlib.sha256(b"".join(np.asarray(value, dtype="<f8").tobytes() for row in rows for value in row)).hexdigest() for name, rows in (("train", train), ("validation", validation), ("test", tests))}
    report = {"schema": "viscera.cutting-evaluation/v1", "model_sha256": digest, "scope": SCOPE, "test_seed": 89201, "frozen_test": True, "source_sha256": sources, "dataset_sha256": fingerprints, "training_history": histories, "evaluation": evaluation, "rejection_fixtures": invalid, "gates": gates, "all_gates_passed": all(gates.values()), "seconds": time.perf_counter() - started, "real_liver_validation": "NOT_RUN", "independent_constitutive_validation": "NOT_RUN"}
    args.report.mkdir(parents=True, exist_ok=True)
    (args.report / "evaluation.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    if not all(gates.values()): raise SystemExit(json.dumps(report, indent=2))
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "model.json").write_text(json.dumps({"sha256": digest, "payload": payload}, separators=(",", ":")) + "\n")
    (args.output / "example-observation.json").write_text(json.dumps(demo, indent=2) + "\n")
    parity_rows = []
    for i, (xx, ss, _) in enumerate(dataset(8, 90201)):
        observation = {"schema": demo["schema"], "opening_mm": (xx * 1000).tolist(), "force_n": (ss * 25e-6).tolist(), "area_mm2": 25., "provenance": f"Independent synthetic browser parity coupon {i}; noisy complete separation"}
        parity_rows.append({"observation": observation, "result": infer(model, observation)})
    (args.report / "browser-parity.json").write_text(json.dumps({"modelId": digest, "observation": demo, "result": fit, "additional": parity_rows}, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__": main()
