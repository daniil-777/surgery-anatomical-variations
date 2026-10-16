"""Protocol-conditioned neural inverse SLS model with calibrated synthetic uncertainty.

All preprocessing, inference and post-fit diagnostics live here and are shared
with training. This identifies a calibrated uniaxial small-strain experiment;
it does not infer forces from pixels or claim human-liver validity.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import least_squares

from .physics_learning import BOUNDS, PARAMETER_NAMES, decode_parameters as _decode_parameters, encode_parameters

VERSION = "liver-inverse-sls-2.0.0"
PREPROCESSING_VERSION = "calibrated-strain-stress-time-81-v1"
SCOPE = "Protocol-conditioned neural inverse model with bounded physical refinement and synthetic uncertainty calibration; not validated human liver mechanics."
FEATURE_POINTS = 81
CALIBRATION_CONTRACT = {
    "version": VERSION, "sample_count": {"min": 16, "max": 257},
    "duration_s": {"min": 1.0, "max": 12.0},
    "peak_strain": {"min": 0.005, "max": 0.05},
    "time_origin_s": 0.0, "loading": "calibrated uniaxial small strain starting from zero; ramp-hold-release, triangular and smooth cyclic histories",
    "units": {"force_n": "N", "displacement_mm": "mm", "times_s": "s", "reference_length_mm": "mm", "reference_area_mm2": "mm^2"},
    "uncertainty": "Nominal 90% marginal split-conformal intervals on synthetic specimens only",
}


def decode_parameters(encoded: np.ndarray) -> np.ndarray:
    """Keep floating-point exp(log(bound)) inside the strict API bounds."""
    return np.clip(_decode_parameters(encoded), BOUNDS[:, 0], BOUNDS[:, 1])


def stress_response(times: np.ndarray, strain: np.ndarray, parameters: np.ndarray) -> np.ndarray:
    """Exact piecewise-linear-strain SLS convolution, in Pa (zero initial state)."""
    t, e, p = np.asarray(times, float), np.asarray(strain, float), np.asarray(parameters, float)
    young, g, tau = p
    dt = np.diff(t)
    # q/(E*g) = convolution of strain-rate with exp(-t/tau).
    lag = t[:, None] - t[None, 1:]
    kernel = np.exp(-np.maximum(lag, 0) / tau) * (lag >= -1e-12)
    h = kernel @ (tau * (-np.expm1(-dt / tau)) * np.diff(e) / dt)
    return young * ((1 - g) * e + g * h)


def validate_history(times: np.ndarray, strain: np.ndarray, stress: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    t, e, s = (np.asarray(value, float) for value in (times, strain, stress))
    if t.ndim != 1 or not 16 <= len(t) <= 257 or e.shape != t.shape or s.shape != t.shape:
        raise ValueError("V2 requires 16–257 matching time, displacement and force observations")
    if not all(np.isfinite(a).all() for a in (t, e, s)) or abs(t[0]) > 1e-9 or np.any(np.diff(t) <= 0):
        raise ValueError("Finite observations must begin at time zero and increase strictly")
    if not 1 <= t[-1] <= 12:
        raise ValueError("V2 calibrated duration is 1–12 seconds")
    amplitude = np.max(np.abs(e))
    if not 0.005 <= amplitude <= 0.050001 or abs(e[0]) > 2e-5:
        raise ValueError("V2 requires zero initial strain and peak calibrated strain of 0.5–5%")
    if np.min(e) < -0.001 or np.max(e) <= 0 or np.max(s) <= 0:
        raise ValueError("Use the positive calibrated uniaxial loading convention")
    if abs(s[0]) > max(0.1, 0.05 * np.max(np.abs(s))):
        raise ValueError("Force must be tared before loading")
    if np.max(np.diff(t)) > 0.2 * t[-1]:
        raise ValueError("Observation time gaps are too large for calibrated inference")
    return t, e, s


def observation_features(times: np.ndarray, strain: np.ndarray, stress: np.ndarray) -> np.ndarray:
    """Same routine for generated training traces and uploaded observations.

    Resample both measured channels on normalized time, retaining physical
    duration and absolute stress/strain scale; E and tau remain identifiable.
    """
    t, e, s = validate_history(times, strain, stress)
    grid = np.linspace(0, t[-1], FEATURE_POINTS)
    amplitude = max(np.max(np.abs(e)), 1e-8)
    scale = max(np.max(np.abs(s)), 1e-6)
    return np.concatenate((np.interp(grid, t, e) / amplitude, np.interp(grid, t, s) / scale,
                           [np.log(amplitude / .025), np.log(scale / amplitude / 5000), np.log(t[-1] / 6)]))


def neural_proposals(model: dict[str, Any], features: np.ndarray) -> np.ndarray:
    x = np.asarray(features, float)
    predictions = []
    for member in model["members"]:
        h = x
        for index, layer in enumerate(member):
            h = h @ np.asarray(layer["weight"]).T + np.asarray(layer["bias"])
            h = np.maximum(h, 0) if index < len(member) - 1 else 1 / (1 + np.exp(-np.clip(h, -60, 60)))
        predictions.append(decode_parameters(h))
    return np.stack(predictions)


def refine_parameters(times: np.ndarray, strain: np.ndarray, stress: np.ndarray, proposal: np.ndarray) -> dict[str, Any]:
    """Bounded differentiable-mechanics residual refinement of a neural proposal.

    Robust loss limits occasional sensor outliers. Parameter uncertainty below
    uses a sensitivity matrix plus independent synthetic conformal calibration.
    The network is a proposal/warm start, not a replacement for equilibrium.
    """
    scale = max(float(np.max(abs(stress))), 1e-6)
    initial = np.clip(encode_parameters(proposal), 1e-6, 1 - 1e-6)
    residual = lambda encoded: (stress_response(times, strain, decode_parameters(encoded)) - stress) / scale
    result = least_squares(residual, initial, bounds=(np.zeros(3), np.ones(3)),
                           loss="soft_l1", f_scale=.02, max_nfev=70,
                           ftol=1e-8, xtol=1e-8, gtol=1e-8)
    parameters = decode_parameters(result.x)
    fitted = stress_response(times, strain, parameters)
    r = (fitted - stress) / scale
    jac = np.empty((len(times), 3))
    for k in range(3):
        lo, hi = result.x.copy(), result.x.copy()
        lo[k] = max(0, lo[k] - 1e-4); hi[k] = min(1, hi[k] + 1e-4)
        jac[:, k] = (residual(hi) - residual(lo)) / (hi[k] - lo[k])
    singular = np.linalg.svd(jac, compute_uv=False)
    noise = max(.002, float(np.median(abs(r - np.median(r))) / .67448975))
    covariance = np.linalg.pinv(jac.T @ jac, rcond=1e-12) * noise ** 2
    # Explicit minimum error floors cover the randomized sensor/geometry scales.
    sigma = np.sqrt(np.maximum(np.diag(covariance), 0) + np.array([.006, .006, .008]) ** 2)
    return {"parameters_array": parameters, "encoded": result.x, "sigma_encoded": sigma,
            "stress_nrmse": float(np.sqrt(np.mean(r ** 2))), "fitted_stress_pa": fitted,
            "condition_number": float(singular[0] / max(singular[-1], 1e-15)),
            "minimum_sensitivity": float(singular[-1]), "noise_fraction_estimate": noise,
            "refinement_evaluations": int(result.nfev), "refinement_converged": bool(result.success)}


def diagnostics(times: np.ndarray, strain: np.ndarray, stress: np.ndarray, fit: dict[str, Any]) -> dict[str, Any]:
    amplitude = float(np.max(strain))
    rate = np.diff(strain) / np.diff(times)
    variation = float(np.sum(abs(np.diff(strain))) / amplitude)
    reasons = []
    if fit["stress_nrmse"] > .05: reasons.append("observed_response_not_reproduced")
    if fit["condition_number"] > 2500 or fit["minimum_sensitivity"] < .015: reasons.append("insufficient_parameter_identifiability")
    if not fit["refinement_converged"]: reasons.append("physical_refinement_not_converged")
    if variation < 1.3: reasons.append("insufficient_loading_and_unloading")
    if np.max(abs(rate)) > .4: reasons.append("strain_rate_outside_training_support")
    encoded = fit["encoded"]
    if np.min(encoded) < .002 or np.max(encoded) > .998: reasons.append("parameter_at_training_bound")
    return {"status": "supported" if not reasons else "review_required", "reasons": reasons,
            "condition_number": fit["condition_number"], "minimum_sensitivity": fit["minimum_sensitivity"],
            "noise_fraction_estimate": fit["noise_fraction_estimate"],
            "excitation": {"peak_strain": amplitude, "duration_s": float(times[-1]),
                           "total_variation_over_amplitude": variation, "peak_strain_rate_s_inv": float(np.max(abs(rate)))},
            "ood_scope": "Checks excitation support, fitted bounds, residual mismatch and local sensitivity; does not detect every biological model mismatch."}


def load_model(directory: str | Path) -> tuple[dict[str, Any], str]:
    root = Path(directory); manifest = json.loads((root / "manifest.json").read_text())
    raw = (root / "model.json").read_bytes(); digest = hashlib.sha256(raw).hexdigest()
    if manifest.get("model_sha256") != digest: raise ValueError("Physics v2 network checksum mismatch")
    model = json.loads(raw)
    if model.get("version") != VERSION or model.get("preprocessing_version") != PREPROCESSING_VERSION or model.get("parameter_names") != list(PARAMETER_NAMES):
        raise ValueError("Incompatible v2 physics/preprocessing contract")
    if not 2 <= len(model.get("members", [])) <= 8: raise ValueError("Invalid v2 ensemble")
    width = FEATURE_POINTS * 2 + 3
    for member in model["members"]:
        previous = width
        for layer in member:
            w, b = np.asarray(layer["weight"]), np.asarray(layer["bias"])
            if w.ndim != 2 or w.shape[1] != previous or b.shape != (w.shape[0],) or not np.isfinite(w).all() or not np.isfinite(b).all():
                raise ValueError("Invalid physics network weights")
            previous = w.shape[0]
        if previous != 3: raise ValueError("Invalid physics output size")
    q = np.asarray(model.get("calibration", {}).get("quantiles_90"), float)
    if q.shape != (3,) or not np.isfinite(q).all() or np.any(q <= 0): raise ValueError("Missing v2 uncertainty calibration")
    return model, digest


def predict_history(model: dict[str, Any], times: np.ndarray, strain: np.ndarray, stress: np.ndarray) -> dict[str, Any]:
    features = observation_features(times, strain, stress)
    proposals = neural_proposals(model, features)
    mean, std = proposals.mean(axis=0), proposals.std(axis=0)
    fit = refine_parameters(times, strain, stress, mean)
    diag = diagnostics(times, strain, stress, fit)
    q = np.asarray(model["calibration"]["quantiles_90"])
    lower = decode_parameters(np.clip(fit["encoded"] - q * fit["sigma_encoded"], 0, 1))
    upper = decode_parameters(np.clip(fit["encoded"] + q * fit["sigma_encoded"], 0, 1))
    return {
        "parameters": dict(zip(PARAMETER_NAMES, fit["parameters_array"].tolist(), strict=True)),
        "neural_parameters": dict(zip(PARAMETER_NAMES, mean.tolist(), strict=True)),
        "ensemble_std": dict(zip(PARAMETER_NAMES, std.tolist(), strict=True)),
        "parameter_intervals_90": {name: {"lower": float(lower[i]), "upper": float(upper[i])} for i, name in enumerate(PARAMETER_NAMES)},
        "version": VERSION, "scope": SCOPE,
        "estimator": "protocol-conditioned neural ensemble proposal plus bounded robust physical refinement",
        "uncertainty_scope": "Nominal 90% marginal split-conformal intervals calibrated on synthetic small-strain observations; not human coverage or model-form confidence",
        "stress_nrmse": fit["stress_nrmse"],
        "stress_nrmse_definition": "RMSE(fitted stress minus observation) / peak absolute observed stress",
        "fitted_stress_pa": fit["fitted_stress_pa"].tolist(),
        "within_synthetic_fit_gate": fit["stress_nrmse"] <= .05,
        "accepted_for_application": not diag["reasons"], "rejection_reasons": diag["reasons"],
        "diagnostics": diag, "refinement_evaluations": fit["refinement_evaluations"],
        "human_liver_validated": False,
        "fixed_or_unidentified": ["poisson", "density_kg_m3", "contact_stiffness_n_m", "indentation_stiffness_n_m", "fracture_energy_j_m2", "capsule", "regional_heterogeneity", "nonlinear_strain_dependence", "additional_relaxation_times"],
    }


def infer_observation(directory: str | Path, *, times_s: list[float], force_n: list[float], displacement_mm: list[float], reference_length_mm: float, reference_area_mm2: float, provenance: str) -> dict[str, Any]:
    if not np.isfinite([reference_length_mm, reference_area_mm2]).all() or not 0 < reference_length_mm <= 1000 or not 0 < reference_area_mm2 <= 1e6:
        raise ValueError("Positive calibrated reference length (≤1000 mm) and area (≤1000000 mm²) required")
    if not isinstance(provenance, str) or not 8 <= len(provenance.strip()) <= 2000: raise ValueError("Calibration provenance must contain 8–2000 characters")
    times = np.asarray(times_s, float); strain = np.asarray(displacement_mm, float) / reference_length_mm
    stress = np.asarray(force_n, float) / (reference_area_mm2 * 1e-6)
    model, digest = load_model(directory)
    result = predict_history(model, times, strain, stress)
    result.update(model_id=digest, observation_provenance=provenance.strip())
    return result
