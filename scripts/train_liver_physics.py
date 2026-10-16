"""Train a separate inverse-physics ensemble on synthetic, grouped SLS experiments.

Run from viscera: PYTHONPATH=py .venv/bin/python scripts/train_liver_physics.py
No shape, appearance, language or disease weights are modified.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn
from viscera_core.physics_learning import (
    BOUNDS,
    PARAMETER_NAMES,
    SCOPE,
    TIMES,
    VERSION,
    decode_parameters,
    encode_parameters,
    observation_features,
    project_stiffness,
    sls_stress,
    standard_strain,
    synthetic_dataset,
)


def train(out: Path, epochs: int = 400, count: int = 6144, members: int = 3) -> dict:
    started = time.perf_counter()
    torch.set_num_threads(2)
    torch.use_deterministic_algorithms(True)
    sets = {
        name: synthetic_dataset(n, seed)
        for name, n, seed in [
            ("train", count, 7103),
            ("validation", 768, 8103),
            ("test", 1024, 19103),
        ]
    }
    tensors = {
        name: (
            torch.tensor(observation_features(curves), dtype=torch.float32),
            torch.tensor(encode_parameters(p), dtype=torch.float32),
        )
        for name, (curves, p) in sets.items()
    }
    x, y = tensors["train"]
    xv, yv = tensors["validation"]
    ensemble, histories, heldout_predictions = [], [], []
    for member in range(members):
        torch.manual_seed(1701 + member)
        model = nn.Sequential(
            nn.Linear(82, 64),
            nn.ReLU(),
            nn.Linear(64, 64),
            nn.ReLU(),
            nn.Linear(64, 3),
            nn.Sigmoid(),
        )
        optimizer = torch.optim.Adam(model.parameters(), lr=0.002)
        best, best_loss, best_epoch = None, float("inf"), 0
        log = []
        for epoch in range(epochs):
            model.train()
            permutation = torch.randperm(len(x))
            for ids in permutation.split(512):
                optimizer.zero_grad(set_to_none=True)
                loss = nn.functional.mse_loss(model(x[ids]), y[ids])
                loss.backward()
                optimizer.step()
            if epoch % 10 == 0 or epoch == epochs - 1:
                model.eval()
                with torch.no_grad():
                    validation = float(nn.functional.mse_loss(model(xv), yv))
                log.append({"epoch": epoch + 1, "validation_normalized_mse": validation})
                if validation < best_loss:
                    best_loss, best, best_epoch = (
                        validation,
                        copy.deepcopy(model.state_dict()),
                        epoch + 1,
                    )
        model.load_state_dict(best)
        model.eval()
        with torch.no_grad():
            heldout_predictions.append(
                project_stiffness(
                    decode_parameters(model(tensors["test"][0]).numpy()), sets["test"][0]
                )
            )
        ensemble.append(
            [
                {"weight": layer.weight.detach().tolist(), "bias": layer.bias.detach().tolist()}
                for layer in model
                if isinstance(layer, nn.Linear)
            ]
        )
        histories.append(
            {
                "member": member,
                "best_epoch": best_epoch,
                "validation_mse": best_loss,
                "history": log,
            }
        )
        print(f"member {member + 1}/{members} validation MSE {best_loss:.6g}", flush=True)
    predicted = np.mean(heldout_predictions, axis=0)
    actual = sets["test"][1]
    per_parameter = {
        key: {
            "median_absolute_relative_error": float(
                np.median(abs(predicted[:, i] - actual[:, i]) / actual[:, i])
            ),
            "p95_absolute_relative_error": float(
                np.quantile(abs(predicted[:, i] - actual[:, i]) / actual[:, i], 0.95)
            ),
            "mae": float(np.mean(abs(predicted[:, i] - actual[:, i]))),
        }
        for i, key in enumerate(PARAMETER_NAMES)
    }
    clean = sls_stress(TIMES, standard_strain(), actual)
    fitted = sls_stress(TIMES, standard_strain(), predicted)
    nrmse = np.sqrt(np.mean((clean - fitted) ** 2, axis=1)) / np.max(abs(clean), axis=1)
    baseline = np.repeat(sets["train"][1].mean(axis=0)[None, :], len(actual), axis=0)
    baseline_curves = sls_stress(TIMES, standard_strain(), baseline)
    baseline_error = np.sqrt(np.mean((clean - baseline_curves) ** 2, axis=1)) / np.max(
        abs(clean), axis=1
    )
    model_dict = {
        "version": VERSION,
        "scope": SCOPE,
        "parameter_names": list(PARAMETER_NAMES),
        "bounds": BOUNDS.tolist(),
        "architecture": [82, 64, 64, 3],
        "activation": "relu,relu,sigmoid",
        "members": ensemble,
    }
    raw = (json.dumps(model_dict, separators=(",", ":"), allow_nan=False) + "\n").encode()
    report = {
        "schema": "viscera.physics.learning-evaluation.v1",
        "scope": SCOPE,
        "model_sha256": hashlib.sha256(raw).hexdigest(),
        "split_unit": "independent synthetic parameter specimens; all times in one specimen stay together",
        "split_seeds": {"train": 7103, "validation": 8103, "test": 19103},
        "development_history": "Seed 9103 evaluated an earlier raw neural proposal; it is a development set, excluded from this frozen final audit.",
        "estimator": "Neural ensemble proposal followed by exact bounded least-squares stiffness projection; g/tau remain network predictions",
        "split_counts": {k: len(v[0]) for k, v in sets.items()},
        "noise": "independent Gaussian stress noise sigma=0.3% peak stress; exact strain and geometry",
        "selection": "Each member selected using validation only; test evaluated after weight selection",
        "parameter_metrics": per_parameter,
        "held_out_stress_nrmse_median": float(np.median(nrmse)),
        "held_out_stress_nrmse_p95": float(np.quantile(nrmse, 0.95)),
        "mean_parameter_baseline_stress_nrmse_median": float(np.median(baseline_error)),
        "synthetic_gate_passed": bool(
            np.quantile(nrmse, 0.95) < 0.05 and np.median(nrmse) < np.median(baseline_error)
        ),
        "human_liver_validation": "NOT_RUN",
        "independent_solver_validation": "NOT_RUN",
        "uncertainty": "Ensemble disagreement is not calibrated confidence; no model mismatch included",
        "histories": histories,
        "training_seconds": time.perf_counter() - started,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "model.json").write_bytes(raw)
    (out / "manifest.json").write_text(
        json.dumps(
            {"version": VERSION, "model_sha256": report["model_sha256"], "scope": SCOPE}, indent=2
        )
        + "\n"
    )
    (out / "evaluation.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    np.savez_compressed(
        out / "held_out_predictions.npz", actual=actual, predicted=predicted, stress_nrmse=nrmse
    )
    print(json.dumps({k: v for k, v in report.items() if k != "histories"}, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("artifacts/physics/liver-network-v1"))
    parser.add_argument("--epochs", type=int, default=400)
    parser.add_argument("--count", type=int, default=6144)
    args = parser.parse_args()
    if args.epochs < 1 or args.count < 64:
        parser.error("Use at least one epoch and 64 independent parameter specimens")
    report = train(args.out, args.epochs, args.count)
    if not report["synthetic_gate_passed"]:
        raise SystemExit(1)
