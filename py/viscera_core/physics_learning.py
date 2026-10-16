"""Separate, bounded inverse-mechanics MLP ensemble; NumPy-only inference.

Training observations are synthetic small-strain uniaxial standard-linear-solid
experiments. These weights do not identify material properties from an organ's
shape, colour or uncalibrated video. All three inferred parameters require a
known metric strain history and calibrated stress (force / reference area).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

VERSION = "liver-inverse-sls-1.0.0"
PARAMETER_NAMES = ("young_pa", "relaxation_fraction", "relaxation_time_s")
BOUNDS = np.array([[500.0, 20000.0], [0.05, 0.75], [0.05, 2.0]])
TIMES = np.linspace(0.0, 6.0, 81)
SCOPE = (
    "Separate neural inverse model trained on synthetic small-strain force/strain "
    "ramp-hold-release experiments; not calibrated human liver mechanics."
)


def standard_strain(times: np.ndarray = TIMES) -> np.ndarray:
    """2.5% strain: 0.6 s ramp, 3 s hold, 0.6 s unload, 1.8 s recovery."""
    return 0.025 * np.minimum(np.clip(times / 0.6, 0, 1), np.clip((4.2 - times) / 0.6, 0, 1))


def sls_stress(times: np.ndarray, strain: np.ndarray, parameters: np.ndarray) -> np.ndarray:
    """Exact Maxwell update for piecewise-linear strain; stress in Pa.

    E is instantaneous Young modulus; equilibrium modulus is E*(1-g).
    Arrays of parameter rows are supported. The initial state is stress-free.
    """
    t, e, p = np.asarray(times, float), np.asarray(strain, float), np.asarray(parameters, float)
    if t.ndim != 1 or e.shape != t.shape or len(t) < 2:
        raise ValueError("Matching one-dimensional time and strain arrays required")
    if not np.isfinite(t).all() or not np.isfinite(e).all() or np.any(np.diff(t) <= 0):
        raise ValueError("Finite, strictly increasing observations required")
    if abs(e[0]) > 1e-9 or t[0] != 0:
        raise ValueError("Observations must begin at stress-free zero strain and time")
    if p.shape[-1:] != (3,) or not np.isfinite(p).all():
        raise ValueError("Expected E, relaxation fraction and relaxation time")
    if (
        np.any(p[..., 0] <= 0)
        or np.any((p[..., 1] < 0) | (p[..., 1] >= 1))
        or np.any(p[..., 2] <= 0)
    ):
        raise ValueError("Non-passive SLS parameters")
    young, g, tau = p[..., 0], p[..., 1], p[..., 2]
    q = np.zeros_like(young)
    result = np.zeros((*p.shape[:-1], len(t)))
    for k, dt in enumerate(np.diff(t), 1):
        decay = np.exp(-dt / tau)
        q = decay * q + young * g * tau * (-np.expm1(-dt / tau)) * (e[k] - e[k - 1]) / dt
        result[..., k] = young * (1 - g) * e[k] + q
    return result


def encode_parameters(parameters: np.ndarray) -> np.ndarray:
    p = np.array(parameters, dtype=float, copy=True)
    p[..., [0, 2]] = np.log(p[..., [0, 2]])
    bounds = BOUNDS.copy()
    bounds[[0, 2]] = np.log(bounds[[0, 2]])
    return (p - bounds[:, 0]) / np.diff(bounds, axis=1).ravel()


def decode_parameters(encoded: np.ndarray) -> np.ndarray:
    bounds = BOUNDS.copy()
    bounds[[0, 2]] = np.log(bounds[[0, 2]])
    p = np.clip(encoded, 0, 1) * np.diff(bounds, axis=1).ravel() + bounds[:, 0]
    p[..., [0, 2]] = np.exp(p[..., [0, 2]])
    return p


def observation_features(stress_pa: np.ndarray) -> np.ndarray:
    s = np.asarray(stress_pa, float)
    if s.shape[-1] != len(TIMES) or not np.isfinite(s).all():
        raise ValueError("Expected 81 finite calibrated stress observations")
    scale = np.maximum(np.max(abs(s), axis=-1, keepdims=True), 0.01)
    # Keep absolute stress scale: normalization alone destroys E identifiability.
    return np.concatenate([s / scale, np.log(scale / 0.025 / 5000)], axis=-1)


def synthetic_dataset(
    count: int, seed: int, noise_fraction: float = 0.003
) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    parameters = decode_parameters(rng.uniform(0.025, 0.975, (count, 3)))
    curves = sls_stress(TIMES, standard_strain(), parameters)
    noise = (
        rng.normal(size=curves.shape) * np.max(abs(curves), axis=1, keepdims=True) * noise_fraction
    )
    noise[:, 0] = 0
    return curves + noise, parameters


def project_stiffness(parameters: np.ndarray, stress_pa: np.ndarray) -> np.ndarray:
    """Exact bounded least-squares E update after the neural g/tau proposal.

    Stress is linear in E for fixed g and tau; solving this observable scale
    analytically avoids asking the network to approximate an available identity.
    This is a hybrid estimator, not an additional training label or ground truth.
    """
    p = np.array(parameters, dtype=float, copy=True)
    p[..., 0] = 1.0
    basis = sls_stress(TIMES, standard_strain(), p)
    p[..., 0] = np.clip(
        np.sum(basis * stress_pa, axis=-1) / np.sum(basis * basis, axis=-1), *BOUNDS[0]
    )
    return p


def demo_observation() -> dict[str, Any]:
    p = np.array([4800.0, 0.42, 0.65])
    stress = sls_stress(TIMES, standard_strain(), p)
    return {
        "evidence": "synthetic_demonstration_not_measurement",
        "times_s": TIMES.tolist(),
        "strain": standard_strain().tolist(),
        "stress_pa": stress.tolist(),
        "reference_length_mm": 20.0,
        "reference_area_mm2": 100.0,
        "displacement_mm": (standard_strain() * 20).tolist(),
        "force_n": (stress * 100e-6).tolist(),
        "teacher_parameters": dict(zip(PARAMETER_NAMES, p.tolist(), strict=True)),
    }


def load_model(directory: str | Path) -> tuple[dict[str, Any], str]:
    root = Path(directory)
    manifest = json.loads((root / "manifest.json").read_text())
    raw = (root / "model.json").read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if manifest.get("model_sha256") != digest:
        raise ValueError("Physics network checksum mismatch")
    model = json.loads(raw)
    if model.get("version") != VERSION or model.get("parameter_names") != list(PARAMETER_NAMES):
        raise ValueError("Incompatible physics model contract")
    if not model.get("members") or len(model["members"]) > 8:
        raise ValueError("Invalid physics ensemble")
    return model, digest


def predict(directory: str | Path, stress_pa: np.ndarray) -> dict[str, Any]:
    model, digest = load_model(directory)
    x = observation_features(stress_pa)
    predictions = []
    for member in model["members"]:
        h = x
        for k, layer in enumerate(member):
            w, b = np.asarray(layer["weight"]), np.asarray(layer["bias"])
            if not np.isfinite(w).all() or not np.isfinite(b).all():
                raise ValueError("Nonfinite physics model weights")
            h = h @ w.T + b
            h = np.maximum(h, 0) if k < len(member) - 1 else 1 / (1 + np.exp(-np.clip(h, -60, 60)))
        predictions.append(project_stiffness(decode_parameters(h), np.asarray(stress_pa)))
    p = np.stack(predictions)
    mean, std = p.mean(axis=0), p.std(axis=0)
    return {
        "parameters": dict(zip(PARAMETER_NAMES, mean.tolist(), strict=True))
        if mean.ndim == 1
        else mean,
        "ensemble_std": dict(zip(PARAMETER_NAMES, std.tolist(), strict=True))
        if std.ndim == 1
        else std,
        "model_id": digest,
        "scope": SCOPE,
        "estimator": "neural ensemble proposal plus exact bounded least-squares stiffness projection",
        "uncertainty_scope": "Ensemble disagreement only; not a confidence interval or model-form uncertainty",
    }


def infer_observation(
    directory: str | Path,
    *,
    times_s: list[float],
    force_n: list[float],
    displacement_mm: list[float],
    reference_length_mm: float,
    reference_area_mm2: float,
    provenance: str,
) -> dict[str, Any]:
    """Fit only the trained, calibrated small-strain protocol, and report residual.

    No camera pixels, arbitrary organ force histories or unsupported loading
    geometry are silently interpreted as uniaxial stress/strain.
    """
    t, force, displacement = map(
        lambda a: np.asarray(a, float), (times_s, force_n, displacement_mm)
    )
    if t.shape != TIMES.shape or force.shape != t.shape or displacement.shape != t.shape:
        raise ValueError("The v1 model requires 81 observations on the documented 0–6 s protocol")
    if not all(np.isfinite(a).all() for a in (t, force, displacement)) or not np.allclose(
        t, TIMES, atol=1e-6, rtol=0
    ):
        raise ValueError("Time samples must follow the calibrated 0–6 s grid")
    if (
        not np.isfinite([reference_length_mm, reference_area_mm2]).all()
        or min(reference_length_mm, reference_area_mm2) <= 0
    ):
        raise ValueError("Positive calibrated reference length and area required")
    strain = displacement / reference_length_mm
    if not np.allclose(strain, standard_strain(), atol=2e-5, rtol=0):
        raise ValueError(
            "Unsupported excitation: use the documented 2.5% uniaxial ramp-hold-release protocol"
        )
    stress = force / (reference_area_mm2 * 1e-6)
    if not isinstance(provenance, str) or len(provenance.strip()) < 8:
        raise ValueError("Observation provenance must be supplied")
    if np.max(stress) <= 0 or abs(stress[0]) > max(0.05, 0.02 * np.max(abs(stress))):
        raise ValueError("Expected tared stress and a positive uniaxial loading response")
    result = predict(directory, stress)
    fitted = sls_stress(t, strain, np.array([result["parameters"][k] for k in PARAMETER_NAMES]))
    error = float(np.sqrt(np.mean((fitted - stress) ** 2)) / max(np.max(abs(stress)), 1e-9))
    result.update(
        {
            "observation_provenance": provenance,
            "stress_nrmse": error,
            "stress_nrmse_definition": "RMSE(fitted stress minus observation) / peak absolute observed stress",
            "fitted_stress_pa": fitted.tolist(),
            "within_synthetic_fit_gate": error <= 0.05,
            "human_liver_validated": False,
            "fixed_or_unidentified": [
                "poisson",
                "density_kg_m3",
                "contact_stiffness_n_m",
                "indentation_stiffness_n_m",
                "fracture_energy_j_m2",
                "capsule",
                "regional_heterogeneity",
            ],
        }
    )
    return result
