"""Optional selective application policy for the frozen v2 inverse model.

This adds no tissue data and changes no learned weights or parameter estimate.
It screens parameter precision and structured lack of fit. Rejection means an
experiment is inadequate for this model, not proof of biological out-of-domain
tissue: correlated sensor error can also produce structured residuals.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

from . import physics_learning_v2 as v2
from .physics_learning import BOUNDS, PARAMETER_NAMES, encode_parameters

POLICY_VERSION = "liver-sls-application-policy-1.2.0"
SCORE_VERSION = "orthogonal-physical-residual-dictionary-drift-nuisance-1.1.0"
PRECISION_LIMITS = {"young_pa": .25, "relaxation_fraction": .50, "relaxation_time_s": 1.0}
ALPHA = .05
NOISE_STRATUM_BOUNDARIES = (.005, .015)
RECOMMENDATIONS = {
    "young_pa_precision_insufficient": "Improve force/geometry calibration and use a resolved loading ramp at more than one loading rate.",
    "relaxation_fraction_precision_insufficient": "Include a sustained hold and unloading segment with adequate signal relative to force noise.",
    "relaxation_time_s_precision_insufficient": "Use faster resolved loading and a longer hold/recovery; include distinct loading rates.",
    "structured_residual_not_explained": "Check force taring, timing and correlated sensor noise; repeat at several loading rates. A richer constitutive model may be required.",
}


def residual_and_precision(model: dict[str, Any], times: np.ndarray, strain: np.ndarray,
                           stress: np.ndarray, result: dict[str, Any]) -> dict[str, Any]:
    """Mechanistic score independent of neural ensemble disagreement.

    Extra relaxation modes and a quadratic strain response are projected away
    from the fitted SLS tangent space. Remaining coherent residual components
    are normalized by successive-difference noise. A separate exchangeable
    synthetic calibration cohort sets the null score distribution.
    """
    t, e, s = v2.validate_history(times, strain, stress)
    parameters = np.array([result["parameters"][name] for name in PARAMETER_NAMES])
    encoded = encode_parameters(parameters)
    scale = max(float(np.max(abs(s))), 1e-6)
    fitted = np.asarray(result["fitted_stress_pa"])
    residual = (s - fitted) / scale
    jacobian = np.empty((len(t), 3))
    for column in range(3):
        lo, hi = encoded.copy(), encoded.copy()
        lo[column] = max(0, lo[column] - 1e-4)
        hi[column] = min(1, hi[column] + 1e-4)
        jacobian[:, column] = (v2.stress_response(t, e, v2.decode_parameters(hi)) - v2.stress_response(t, e, v2.decode_parameters(lo))) / (scale * (hi[column] - lo[column]))
    # Reproduce v2's sensitivity uncertainty without a second nonlinear fit.
    noise = max(.002, float(np.median(abs(residual - np.median(residual))) / .67448975))
    covariance = np.linalg.pinv(jacobian.T @ jacobian, rcond=1e-12) * noise ** 2
    sigma = np.sqrt(np.maximum(np.diag(covariance), 0) + np.array([.006, .006, .008]) ** 2)
    delta = np.asarray(model["calibration"]["quantiles_90"]) * sigma
    # Prior-clipped intervals can look artificially precise. Screen on the
    # untruncated local span instead; this is NOT a posterior beyond the prior.
    widths = np.empty(3)
    for index in (0, 2):
        half_log_span = delta[index] * np.log(BOUNDS[index, 1] / BOUNDS[index, 0])
        widths[index] = 2 * np.sinh(min(float(half_log_span), 300))
    widths[1] = 2 * delta[1] * np.diff(BOUNDS[1])[0] / parameters[1]
    truncated = (encoded - delta < 0) | (encoded + delta > 1)

    # V2's declared sensor generator includes linear force drift. It must not
    # become evidence for another constitutive branch at low white-noise levels.
    # Treat the drift direction as a nuisance in this test only: estimates and
    # curves remain unchanged. Slow material responses collinear with sensor
    # drift are consequently indistinguishable in this structural check.
    tangent_and_nuisance = np.column_stack((jacobian, t / t[-1]))
    u, singular, _ = np.linalg.svd(tangent_and_nuisance, full_matrices=False)
    tangent = u[:, singular > max(float(singular[0]), 1e-12) * 1e-8]
    amplitude = max(float(np.max(e)), 1e-8)
    dictionary = []
    for tau in (.02, .05, .15, .5, 1.5, 5., 12.):
        candidate = v2.stress_response(t, e, np.array([1., 1., tau])) - e
        dictionary.append(candidate)
    dictionary.append(v2.stress_response(t, e * e / amplitude, parameters) / scale)
    differences = np.diff(residual)
    difference_noise = float(np.median(abs(differences - np.median(differences))) / (.67448975 * np.sqrt(2)))
    noise_for_score = max(.0001, difference_noise)
    score = 0.
    for candidate in dictionary:
        orthogonal = candidate - tangent @ (tangent.T @ candidate)
        norm = np.linalg.norm(orthogonal)
        if norm > 1e-10:
            score = max(score, float((residual @ orthogonal / norm / noise_for_score) ** 2))
    if np.sqrt(np.mean(residual ** 2)) < 1e-5:
        score = 0.  # Numerical roundoff is not constitutive mismatch.
    return {"structured_residual_score": score,
            "structural_test_nuisance_directions": ["linear_force_sensor_drift"],
            "successive_difference_noise_fraction": difference_noise,
            "unclipped_sensitivity_span_relative": dict(zip(PARAMETER_NAMES, widths.tolist(), strict=True)),
            "displayed_interval_truncated_by_prior": dict(zip(PARAMETER_NAMES, truncated.tolist(), strict=True))}


def load_policy(directory: str | Path, model_sha256: str) -> tuple[dict[str, Any], str]:
    root = Path(directory)
    manifest = json.loads((root / "policy-manifest.json").read_text())
    raw = (root / "application-policy.json").read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if manifest.get("policy_sha256") != digest:
        raise ValueError("Application policy checksum mismatch")
    policy = json.loads(raw)
    if policy.get("version") != POLICY_VERSION or policy.get("score_version") != SCORE_VERSION:
        raise ValueError("Incompatible physics application policy")
    if policy.get("model_sha256") != model_sha256:
        raise ValueError("Application policy was calibrated for a different physics model")
    scores = np.asarray(policy.get("residual_calibration_scores"), float)
    if scores.ndim != 1 or len(scores) < 100 or not np.isfinite(scores).all() or np.any(scores < 0):
        raise ValueError("Invalid residual calibration scores")
    if policy.get("noise_stratum_boundaries") != list(NOISE_STRATUM_BOUNDARIES):
        raise ValueError("Incompatible residual noise strata")
    strata = policy.get("residual_calibration_strata", [])
    if not isinstance(strata, list) or len(strata) != 3:
        raise ValueError("Missing residual calibration strata")
    for values in strata:
        values = np.asarray(values, float)
        if values.ndim != 1 or len(values) < 100 or not np.isfinite(values).all() or np.any(values < 0):
            raise ValueError("Insufficient or invalid residual noise stratum")
    limits = policy.get("maximum_unclipped_span_relative", {})
    if set(limits) != set(PARAMETER_NAMES) or not all(np.isfinite(v) and v > 0 for v in limits.values()):
        raise ValueError("Invalid application precision limits")
    alpha = policy.get("structured_residual_alpha")
    if not isinstance(alpha, (float, int)) or not 0 < alpha < .2:
        raise ValueError("Invalid structured residual significance level")
    return policy, digest


def apply_policy(model: dict[str, Any], policy: dict[str, Any], times: np.ndarray,
                 strain: np.ndarray, stress: np.ndarray, result: dict[str, Any]) -> dict[str, Any]:
    """Return a new result; preserve v2 fitted values and residual-only gate."""
    diagnostic = residual_and_precision(model, times, strain, stress, result)
    reasons = list(result["rejection_reasons"])
    limits = dict(policy["maximum_unclipped_span_relative"])
    precision_reasons = []
    for name in PARAMETER_NAMES:
        if diagnostic["unclipped_sensitivity_span_relative"][name] > limits[name]:
            precision_reasons.append(f"{name}_precision_insufficient")
    stratum = int(np.searchsorted(policy["noise_stratum_boundaries"], diagnostic["successive_difference_noise_fraction"], side="right"))
    scores = np.asarray(policy["residual_calibration_strata"][stratum])
    p_value = float((1 + np.sum(scores >= diagnostic["structured_residual_score"])) / (len(scores) + 1))
    structured_rejected = p_value <= policy["structured_residual_alpha"]
    added = precision_reasons + (["structured_residual_not_explained"] if structured_rejected else [])
    reasons.extend(reason for reason in added if reason not in reasons)
    diagnostic.update({"policy_version": POLICY_VERSION, "score_version": SCORE_VERSION,
                       "base_v2_accepted_for_application": result["accepted_for_application"],
                       "precision_passed": not precision_reasons,
                       "structured_residual_passed": not structured_rejected,
                       "structured_residual_conformal_p_value": p_value,
                       "residual_calibration_noise_stratum": stratum,
                       "residual_calibration_stratum_count": len(scores),
                       "noise_stratum_boundaries": list(policy["noise_stratum_boundaries"]),
                       "structured_residual_alpha": policy["structured_residual_alpha"],
                       "maximum_unclipped_span_relative": limits,
                       "additional_rejection_reasons": added,
                       "recommended_next_steps": [RECOMMENDATIONS[reason] for reason in added],
                       "scope": "Synthetic experimental adequacy screening. Unclipped local sensitivity spans are precision diagnostics, not human posterior confidence. Structured residuals may reflect correlated sensor error or model mismatch; passing does not validate constitutive form."})
    return {**result, "application_policy_version": POLICY_VERSION,
            "accepted_for_application": not reasons, "rejection_reasons": reasons,
            "application_diagnostics": diagnostic}


def predict_history(model: dict[str, Any], policy: dict[str, Any], times: np.ndarray,
                    strain: np.ndarray, stress: np.ndarray) -> dict[str, Any]:
    return apply_policy(model, policy, times, strain, stress, v2.predict_history(model, times, strain, stress))


def infer_observation(directory: str | Path, *, policy_directory: str | Path | None = None,
                      times_s: list[float], force_n: list[float], displacement_mm: list[float],
                      reference_length_mm: float, reference_area_mm2: float, provenance: str) -> dict[str, Any]:
    # The unchanged v2 entry point remains authoritative for input validation.
    result = v2.infer_observation(directory, times_s=times_s, force_n=force_n,
                                  displacement_mm=displacement_mm, reference_length_mm=reference_length_mm,
                                  reference_area_mm2=reference_area_mm2, provenance=provenance)
    model, digest = v2.load_model(directory)
    policy, policy_digest = load_policy(policy_directory or directory, digest)
    updated = apply_policy(model, policy, np.asarray(times_s), np.asarray(displacement_mm) / reference_length_mm,
                           np.asarray(force_n) / (reference_area_mm2 * 1e-6), result)
    updated["application_policy_id"] = policy_digest
    return updated
