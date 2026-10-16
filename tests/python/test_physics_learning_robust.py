"""Precision, residual-structure and artifact-isolation regression checks."""
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pytest

from viscera_core import physics_learning_v2 as v2
from viscera_core import physics_learning_robust as robust

MODEL = Path(os.environ.get("VISCERA_PHYSICS_V2_TEST_MODEL", Path(__file__).parents[2] / "artifacts/physics/liver-network-v2"))


@pytest.fixture(scope="module")
def model():
    return v2.load_model(MODEL)[0]


def policy(model_sha="unit-test-digest"):
    # Deliberately fixed unit-test reference scores, not the trained artifact.
    return {"version": robust.POLICY_VERSION, "score_version": robust.SCORE_VERSION,
            "model_sha256": model_sha, "residual_calibration_scores": np.linspace(0, 10, 200).tolist(),
            "noise_stratum_boundaries": list(robust.NOISE_STRATUM_BOUNDARIES),
            "residual_calibration_strata": [np.linspace(0, 10, 200).tolist() for _ in range(3)],
            "maximum_unclipped_span_relative": dict(robust.PRECISION_LIMITS), "structured_residual_alpha": .05}


def trace():
    times = np.linspace(0, 8, 161)
    strain = .025 * np.minimum(np.clip(times / .4, 0, 1), np.clip((5 - times) / .6, 0, 1))
    stress = v2.stress_response(times, strain, np.array([4800., .42, .65]))
    return times, strain, stress


def test_policy_preserves_frozen_v2_parameters_intervals_and_residual_gate(model):
    t, e, s = trace()
    original = v2.predict_history(model, t, e, s)
    snapshot = json.dumps(original, sort_keys=True)
    updated = robust.apply_policy(model, policy(), t, e, s, original)
    assert updated["accepted_for_application"]
    assert updated["version"] == v2.VERSION
    assert updated["application_policy_version"] == robust.POLICY_VERSION
    for field in ("parameters", "parameter_intervals_90", "within_synthetic_fit_gate", "fitted_stress_pa"):
        assert updated[field] == original[field]
    assert json.dumps(original, sort_keys=True) == snapshot
    assert updated["application_diagnostics"]["structured_residual_conformal_p_value"] == 1


def test_unclipped_precision_span_exposes_prior_truncation(model):
    t, e, s = trace()
    original = v2.predict_history(model, t, e, s)
    broad_model = {**model, "calibration": {"quantiles_90": [300., 300., 300.]}}
    updated = robust.apply_policy(broad_model, policy(), t, e, s, original)
    diag = updated["application_diagnostics"]
    assert all(diag["displayed_interval_truncated_by_prior"].values())
    assert not updated["accepted_for_application"]
    assert diag["unclipped_sensitivity_span_relative"]["young_pa"] > 100
    assert "young_pa_precision_insufficient" in updated["rejection_reasons"]
    assert "relaxation_time_s_precision_insufficient" in updated["rejection_reasons"]
    assert diag["recommended_next_steps"]
    assert original["accepted_for_application"]


def test_low_residual_does_not_hide_structured_model_error(model):
    t, e, _ = trace()
    one = v2.stress_response(t, e, np.array([4800., .42, .09]))
    two = v2.stress_response(t, e, np.array([4800., .42, 1.7]))
    stress = .45 * one + .55 * two
    base = v2.predict_history(model, t, e, stress)
    assert base["within_synthetic_fit_gate"]
    updated = robust.apply_policy(model, policy(), t, e, stress, base)
    assert "structured_residual_not_explained" in updated["rejection_reasons"]
    assert not updated["accepted_for_application"]
    assert updated["within_synthetic_fit_gate"]  # Residual gate retains its meaning.


def test_good_fit_with_weak_excitation_keeps_original_rejection(model):
    t, _, _ = trace(); e = .025 * t / t[-1]
    stress = v2.stress_response(t, e, np.array([4800., .42, .65]))
    base = v2.predict_history(model, t, e, stress)
    updated = robust.apply_policy(model, policy(), t, e, stress, base)
    assert "insufficient_loading_and_unloading" in updated["rejection_reasons"]
    assert not updated["accepted_for_application"]


def test_noisy_valid_response_is_not_automatically_structured_mismatch(model):
    t, e, stress = trace(); rng = np.random.default_rng(201007)
    stress += rng.normal(0, .02, len(t)) * np.max(stress); stress[0] = 0
    result = robust.predict_history(model, policy(), t, e, stress)
    assert result["application_diagnostics"]["structured_residual_passed"]
    assert "structured_residual_not_explained" not in result["rejection_reasons"]


def test_conformal_rank_uses_matching_predeclared_noise_stratum(model):
    t, e, stress = trace(); rng = np.random.default_rng(9017)
    stress += rng.normal(0, .02, len(t)) * np.max(stress); stress[0] = 0
    configuration = policy()
    configuration["residual_calibration_scores"] = [1e9] * 600
    configuration["residual_calibration_strata"] = [[1e9] * 200, [1e9] * 200, [0.] * 200]
    result = robust.predict_history(model, configuration, t, e, stress)
    diag = result["application_diagnostics"]
    assert diag["residual_calibration_noise_stratum"] == 2
    assert diag["structured_residual_conformal_p_value"] == pytest.approx(1 / 201)
    assert not diag["structured_residual_passed"]


def test_declared_linear_sensor_drift_is_not_a_constitutive_branch(model):
    t, e, stress = trace(); rng = np.random.default_rng(40107)
    peak = np.max(stress)
    stress += peak * (.003 * t / t[-1] + rng.normal(0, .0005, len(t)))
    stress[0] = 0
    result = robust.predict_history(model, policy(), t, e, stress)
    diagnostic = result["application_diagnostics"]
    assert diagnostic["structural_test_nuisance_directions"] == ["linear_force_sensor_drift"]
    assert diagnostic["structured_residual_passed"]
    assert result["within_synthetic_fit_gate"]


def write_policy(path, value):
    raw = (json.dumps(value) + "\n").encode()
    (path / "application-policy.json").write_bytes(raw)
    (path / "policy-manifest.json").write_text(json.dumps({"policy_sha256": hashlib.sha256(raw).hexdigest()}))


def test_policy_checksum_and_model_identity_are_enforced(tmp_path):
    write_policy(tmp_path, policy())
    loaded, _ = robust.load_policy(tmp_path, "unit-test-digest")
    assert loaded["version"] == robust.POLICY_VERSION
    with pytest.raises(ValueError, match="different physics model"):
        robust.load_policy(tmp_path, "different-digest")
    (tmp_path / "application-policy.json").write_text("{}")
    with pytest.raises(ValueError, match="checksum"):
        robust.load_policy(tmp_path, "unit-test-digest")


@pytest.mark.parametrize("change", [{"residual_calibration_scores": [0.] * 2},
                                    {"residual_calibration_strata": [[0.] * 100] * 2},
                                    {"noise_stratum_boundaries": [.01, .02]},
                                    {"structured_residual_alpha": .8},
                                    {"maximum_unclipped_span_relative": {"young_pa": -1}},
                                    {"score_version": "unknown"}])
def test_invalid_policy_contract_is_rejected(tmp_path, change):
    write_policy(tmp_path, {**policy(), **change})
    with pytest.raises(ValueError):
        robust.load_policy(tmp_path, "unit-test-digest")


def test_output_does_not_mutate_policy_configuration(model):
    t, e, s = trace(); configuration = policy()
    result = robust.predict_history(model, configuration, t, e, s)
    result["application_diagnostics"]["maximum_unclipped_span_relative"]["young_pa"] = 0
    assert configuration["maximum_unclipped_span_relative"]["young_pa"] == .25


def test_optional_wrapper_keeps_v2_observation_units_and_provenance(model, tmp_path):
    _, digest = v2.load_model(MODEL); write_policy(tmp_path, policy(digest))
    t, e, s = trace()
    args = {"times_s": t.tolist(), "force_n": (s * 100e-6).tolist(), "displacement_mm": (e * 20).tolist(),
            "reference_length_mm": 20., "reference_area_mm2": 100., "provenance": "Synthetic regression experiment; no measured tissue"}
    result = robust.infer_observation(MODEL, policy_directory=tmp_path, **args)
    assert result["model_id"] == digest and result["application_policy_id"]
    assert result["observation_provenance"] == args["provenance"]
    np.testing.assert_allclose(list(result["parameters"].values()), [4800, .42, .65], rtol=.002)
