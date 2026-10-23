"""Synthetic coupon calibration for a bounded irreversible Mode-I cohesive law.

The two fitted parameters describe this law, not validated liver cutting. The
elasticity network remains separate. Unknown blade friction, crack area or bulk
compliance cannot be inferred from these two channels.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

VERSION = "viscera.cutting-model/v1"
OBSERVATION_SCHEMA = "viscera.cutting-observation/v1"
ALPHA = .12
BOUNDS = np.array([[2., 80.], [4000., 80000.]])
NAMES = ("fractureEnergyJm2", "peakTractionPa")
FEATURE_POINTS = 65
SCOPE = "Synthetic Mode-I coupon inverse model; supplied observations remain unverified; not validated liver cutting."


def cohesive_response(opening: np.ndarray, parameters: np.ndarray) -> np.ndarray:
    """Pa, with irreversible maximum-separation history and undamaged compression."""
    x = np.asarray(opening, float)
    gc, peak = np.asarray(parameters, float)
    if x.ndim != 1 or not np.isfinite(x).all() or not np.isfinite([gc, peak]).all() or min(gc, peak) <= 0:
        raise ValueError("Finite opening history and positive cohesive parameters required")
    df = 2 * gc / peak
    d0 = ALPHA * df
    maximum = np.maximum.accumulate(np.maximum(x, 0))
    damage = np.zeros_like(x)
    loading = maximum > d0
    damage[loading] = np.minimum(1, df * (maximum[loading] - d0) / (maximum[loading] * (df - d0)))
    return peak / d0 * x * np.where(x < 0, 1., 1 - damage)


def validate_observation(value: Any) -> dict[str, Any]:
    keys = {"schema", "opening_mm", "force_n", "area_mm2", "provenance"}
    if not isinstance(value, dict) or set(value) != keys or value.get("schema") != OBSERVATION_SCHEMA:
        raise ValueError("Expected cutting-observation/v1 with opening_mm, force_n, area_mm2 and provenance")
    x, force = value["opening_mm"], value["force_n"]
    number = lambda v: isinstance(v, (float, int)) and not isinstance(v, bool) and np.isfinite(v)
    if not isinstance(x, list) or not isinstance(force, list) or not 32 <= len(x) <= 1024 or len(x) != len(force) or not all(number(v) for v in x + force):
        raise ValueError("32–1024 matching finite opening and force samples required")
    x, force = np.asarray(x, float), np.asarray(force, float)
    area = value["area_mm2"]
    if not number(area) or not 0 < area <= 10000:
        raise ValueError("Known positive fracture interface area up to 10000 mm² required")
    if not isinstance(value["provenance"], str) or not 8 <= len(value["provenance"].strip()) <= 2000:
        raise ValueError("Describe specimen, force/geometry calibration and fixture in provenance")
    if np.min(x) < 0 or np.max(x) > 80 or x[0] > 1e-8 or np.max(x) < .02:
        raise ValueError("Opening must start at zero, remain nonnegative and span 0.02–80 mm")
    scale = np.max(np.abs(force))
    if np.max(force) <= 0 or abs(force[0]) > max(1e-7, .03 * scale) or np.min(force) < -.1 * scale:
        raise ValueError("Tared tensile force in the positive opening convention required")
    maximum = np.maximum.accumulate(x)
    # Ordered displacement measurements may unload/reload; a large missing
    # interval can hide the traction peak and cannot be repaired by resampling.
    if np.max(np.diff(maximum)) > .08 * np.max(x):
        raise ValueError("Opening samples are too sparse to resolve fracture")
    return {**value, "provenance": value["provenance"].strip()}


def channels(observation: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    o = validate_observation(observation)
    return np.asarray(o["opening_mm"]) * .001, np.asarray(o["force_n"]) / (o["area_mm2"] * 1e-6)


def features(x: np.ndarray, stress: np.ndarray) -> np.ndarray:
    # Preserve physical length and traction: normalized curves alone lose both
    # energy and strength scales. History ordering is retained on sample index.
    grid = np.linspace(0, 1, FEATURE_POINTS)
    source = np.linspace(0, 1, len(x))
    xm, sm = float(np.max(x)), max(float(np.max(abs(stress))), 1e-9)
    return np.r_[np.interp(grid, source, x / xm), np.interp(grid, source, stress / sm), np.log(xm / .005), np.log(sm / 16000)]


def encode(p: np.ndarray) -> np.ndarray:
    return np.log(np.asarray(p) / BOUNDS[:, 0]) / np.log(BOUNDS[:, 1] / BOUNDS[:, 0])


def decode(z: np.ndarray) -> np.ndarray:
    return np.clip(BOUNDS[:, 0] * np.exp(np.clip(z, 0, 1) * np.log(BOUNDS[:, 1] / BOUNDS[:, 0])), BOUNDS[:, 0], BOUNDS[:, 1])


def neural_proposal_with_uncertainty(model: dict[str, Any], x: np.ndarray, stress: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    predictions = []
    for member in model["members"]:
        h = features(x, stress)
        for i, layer in enumerate(member):
            h = np.asarray(layer["weight"]) @ h + np.asarray(layer["bias"])
            h = np.maximum(h, 0) if i < len(member) - 1 else 1 / (1 + np.exp(-np.clip(h, -60, 60)))
        predictions.append(decode(h))
    arr = np.asarray(predictions, float)
    return np.mean(arr, axis=0), np.std(arr, axis=0)


def neural_proposal(model: dict[str, Any], x: np.ndarray, stress: np.ndarray) -> np.ndarray:
    mean, _ = neural_proposal_with_uncertainty(model, x, stress)
    return mean


def refine(x: np.ndarray, stress: np.ndarray, proposal: np.ndarray | None = None) -> dict[str, Any]:
    """Global bounded scalar profile fit, exact least-squares peak at each df.

    A neural df is an extra candidate; all grid-local minima are refined so the
    fit is not granted authority by a plausible-looking neural proposal.
    """
    low, high = np.log(2 * BOUNDS[0, 0] / BOUNDS[1, 1]), np.log(2 * BOUNDS[0, 1] / BOUNDS[1, 0])
    scale = max(float(np.max(abs(stress))), 1e-9)
    evaluations = 0
    def objective(log_df):
        nonlocal evaluations
        evaluations += 1
        df = float(np.exp(log_df))
        q = cohesive_response(x, np.array([df / 2, 1.]))
        lower = max(BOUNDS[1, 0], 2 * BOUNDS[0, 0] / df)
        upper = min(BOUNDS[1, 1], 2 * BOUNDS[0, 1] / df)
        peak = float(np.clip(np.dot(q, stress) / max(float(np.dot(q, q)), 1e-30), lower, upper))
        error = float(np.mean(((peak * q - stress) / scale) ** 2))
        return error, np.array([peak * df / 2, peak])
    grid = np.linspace(low, high, 129)
    if proposal is not None:
        grid = np.unique(np.r_[grid, np.clip(np.log(2 * proposal[0] / proposal[1]), low, high)])
    values = [objective(v) for v in grid]
    best = min(values, key=lambda v: v[0])
    golden = (np.sqrt(5) - 1) / 2
    for i in range(1, len(grid) - 1):
        if values[i][0] > values[i - 1][0] or values[i][0] > values[i + 1][0]:
            continue
        a, b = grid[i - 1], grid[i + 1]
        c, d = b - golden * (b - a), a + golden * (b - a)
        fc, fd = objective(c), objective(d)
        for _ in range(45):
            if fc[0] < fd[0]:
                b, d, fd = d, c, fc
                c = b - golden * (b - a); fc = objective(c)
            else:
                a, c, fc = c, d, fd
                d = a + golden * (b - a); fd = objective(d)
        best = min(best, fc, fd, key=lambda v: v[0])
    return {"parameters": np.clip(best[1], BOUNDS[:, 0], BOUNDS[:, 1]), "residualNrmse": float(np.sqrt(best[0])), "evaluations": evaluations}


def assess(x: np.ndarray, stress: np.ndarray, fitted: dict[str, Any]) -> dict[str, Any]:
    p = fitted["parameters"]; df = 2 * p[0] / p[1]; d0 = ALPHA * df
    maximum = np.maximum.accumulate(x)
    loading = x >= maximum - 1e-12
    reasons = []
    if fitted["residualNrmse"] > .05: reasons.append("force_response_not_reproduced")
    if np.max(x) < 1.05 * df or np.count_nonzero(x >= df) < 3: reasons.append("complete_fracture_not_observed")
    if np.count_nonzero(loading & (x > .1 * d0) & (x < d0)) < 3 or np.count_nonzero(loading & (x > d0) & (x < .95 * df)) < 6:
        reasons.append("traction_peak_or_softening_insufficiently_sampled")
    z = encode(p)
    if np.min(z) < .005 or np.max(z) > .995: reasons.append("parameter_at_training_bound")
    scale = max(float(np.max(abs(stress))), 1e-9)
    jac = []
    for i in range(2):
        lo, hi = z.copy(), z.copy(); lo[i] -= 1e-4; hi[i] += 1e-4
        jac.append((cohesive_response(x, decode(hi)) - cohesive_response(x, decode(lo))) / (.0002 * scale))
    jac_arr = np.array(jac)
    singular = np.linalg.svd(jac_arr.T, compute_uv=False)
    condition = float(singular[0] / max(singular[-1], 1e-15))
    if condition > 100 or singular[-1] < .1: reasons.append("parameters_not_identifiable")
    tail = x >= df * 1.05
    if tail.any() and np.sqrt(np.mean(stress[tail] ** 2)) / scale > .05: reasons.append("post_fracture_force_not_zero")
    dof = max(1, len(x) - 2)
    sigma2 = max(float(fitted["residualNrmse"]) ** 2, 2.5e-5) * len(x) / dof
    fisher = jac_arr @ jac_arr.T + 1e-12 * np.eye(2)
    cov_z = sigma2 * np.linalg.inv(fisher)
    half_z = 1.6448536269514722 * np.sqrt(np.maximum(0., np.diag(cov_z)))
    low_p, high_p = decode(z - half_z), decode(z + half_z)
    intervals = {name: [float(low_p[i]), float(high_p[i])] for i, name in enumerate(NAMES)}
    specific_work = float(np.sum(.5 * (stress[1:] + stress[:-1]) * np.diff(x)))
    diagnostics = {
        "criticalOpeningMm": float(df * 1000.),
        "onsetOpeningMm": float(d0 * 1000.),
        "specificWorkJm2": specific_work,
        "cohesiveLengthScaleMm": float(6000. * p[0] / (p[1] ** 2) * 1000.),
    }
    return {"accepted": not reasons, "reasons": reasons, "conditionNumber": condition, "parameterIntervals90": intervals, "diagnostics": diagnostics}


def infer(model: dict[str, Any], observation: dict[str, Any]) -> dict[str, Any]:
    x, stress = channels(observation)
    proposal, uncertainty = neural_proposal_with_uncertainty(model, x, stress)
    fit = refine(x, stress, proposal)
    return {**assess(x, stress, fit), "parameters": dict(zip(NAMES, fit["parameters"].tolist())), "neuralParameters": dict(zip(NAMES, proposal.tolist())), "neuralUncertainty": dict(zip(NAMES, uncertainty.tolist())), "residualNrmse": fit["residualNrmse"], "source": "synthetic-trained-coupon-calibration", "humanLiverValidated": False, "modelId": model["modelId"], "observationProvenance": observation["provenance"], "scope": SCOPE}


def model_digest(model: dict[str, Any]) -> str:
    # Hash the exact canonical UTF-8 payload used in the JSON envelope.
    return hashlib.sha256(json.dumps(model, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def load_model(path: str | Path) -> dict[str, Any]:
    envelope = json.loads(Path(path).read_text())
    payload = envelope["payload"]
    if hashlib.sha256(payload.encode()).hexdigest() != envelope["sha256"]:
        raise ValueError("Cutting model checksum mismatch")
    model = json.loads(payload)
    if model.get("schema") != VERSION or model.get("alpha") != ALPHA or model.get("bounds") != BOUNDS.tolist():
        raise ValueError("Unsupported cutting model")
    if model.get("featurePoints") != 65 or model.get("evidence") != "synthetic_only" or model.get("humanLiverValidated") is not False:
        raise ValueError("Invalid cutting evidence contract")
    if not isinstance(model.get("members"), list) or not 2 <= len(model["members"]) <= 4:
        raise ValueError("Invalid cutting ensemble")
    for member in model["members"]:
        if not isinstance(member, list) or len(member) != 3:
            raise ValueError("Invalid cutting architecture")
        previous = 132
        for layer, rows in zip(member, (96, 48, 2)):
            w, b = np.asarray(layer["weight"], float), np.asarray(layer["bias"], float)
            if w.shape != (rows, previous) or b.shape != (rows,) or not np.isfinite(w).all() or not np.isfinite(b).all():
                raise ValueError("Invalid cutting weights")
            previous = rows
    return {**model, "modelId": envelope["sha256"]}


def demo_observation() -> dict[str, Any]:
    p = np.array([20., 16000.]); df = 2 * p[0] / p[1]
    x = np.linspace(0, 1.3 * df, 161)
    return {"schema": OBSERVATION_SCHEMA, "opening_mm": (x * 1000).tolist(), "force_n": (cohesive_response(x, p) * 25e-6).tolist(), "area_mm2": 25., "provenance": "Synthetic complete Mode-I coupon; known area; no liver measurement"}
