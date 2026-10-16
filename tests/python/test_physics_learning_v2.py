"""Contract, identifiability and shared preprocessing checks for physics AI v2."""
import json
import os
from pathlib import Path

import numpy as np
import pytest

from viscera_core.physics_learning import TIMES, sls_stress, standard_strain
from viscera_core.physics_learning_v2 import (
    BOUNDS, VERSION, decode_parameters, infer_observation, load_model,
    observation_features, stress_response,
)

MODEL = Path(os.environ.get("VISCERA_PHYSICS_V2_TEST_MODEL", Path(__file__).parents[2] / "artifacts/physics/liver-network-v2"))


def observation(duration=6.0):
    t = np.linspace(0, duration, 97)
    strain = .025 * np.minimum(np.clip(t / (.1 * duration), 0, 1), np.clip((.7 * duration - t) / (.1 * duration), 0, 1))
    stress = stress_response(t, strain, np.array([4800, .42, .65]))
    return {"times_s": t.tolist(), "force_n": (stress * 100e-6).tolist(), "displacement_mm": (strain * 20).tolist(),
            "reference_length_mm": 20., "reference_area_mm2": 100., "provenance": "Synthetic unit-test material, not tissue measurement"}


def test_piecewise_linear_convolution_matches_independent_recurrence():
    rng = np.random.default_rng(924)
    t = np.r_[0, np.cumsum(rng.uniform(.02, .1, 80))]
    strain = .02 * (1 - np.cos(t * 2)) / 2
    for parameters in ([500, .05, .05], [4800, .42, .65], [20000, .75, 2]):
        np.testing.assert_allclose(stress_response(t, strain, np.array(parameters)), sls_stress(t, strain, np.array(parameters)), rtol=1e-12, atol=1e-10)


def test_strict_parameter_bound_roundtrip():
    np.testing.assert_allclose(decode_parameters(np.zeros(3)), BOUNDS[:, 0], atol=1e-12)
    assert np.all(decode_parameters(np.zeros(3)) >= BOUNDS[:, 0])
    np.testing.assert_allclose(decode_parameters(np.ones(3)), BOUNDS[:, 1], atol=1e-12)
    assert np.all(decode_parameters(np.ones(3)) <= BOUNDS[:, 1])


def test_shared_features_retain_absolute_scale_time_and_strain():
    strain = standard_strain(); stress = sls_stress(TIMES, strain, np.array([4800, .42, .65]))
    first = observation_features(TIMES, strain, stress)
    scaled = observation_features(TIMES, strain, stress * 2)
    np.testing.assert_allclose(first[:-2], scaled[:-2]); assert scaled[-2] - first[-2] == pytest.approx(np.log(2))
    changed_time = observation_features(TIMES * 1.5, strain, stress)
    np.testing.assert_allclose(first[:-1], changed_time[:-1], atol=1e-12); assert changed_time[-1] - first[-1] == pytest.approx(np.log(1.5))


@pytest.mark.parametrize("duration", [2.0, 6.0, 10.0])
def test_variable_rate_inference_recovers_calibrated_parameters(duration):
    fit = infer_observation(MODEL, **observation(duration))
    assert fit["version"] == VERSION and fit["accepted_for_application"]
    assert fit["within_synthetic_fit_gate"] and fit["stress_nrmse"] < 1e-5
    np.testing.assert_allclose(list(fit["parameters"].values()), [4800, .42, .65], rtol=.002)
    assert not fit["human_liver_validated"]
    for name, value in fit["parameters"].items():
        assert fit["parameter_intervals_90"][name]["lower"] <= value <= fit["parameter_intervals_90"][name]["upper"]


def test_calibrated_force_area_units_preserve_material_inference():
    one = observation(); two = {**one, "force_n": (np.array(one["force_n"]) * 4).tolist(), "reference_area_mm2": 400.}
    assert infer_observation(MODEL, **one)["parameters"] == infer_observation(MODEL, **two)["parameters"]


def test_good_fit_does_not_authorize_weak_excitation():
    data = observation(); t = np.array(data["times_s"]); strain = .025 * t / t[-1]
    data["displacement_mm"] = (20 * strain).tolist(); data["force_n"] = (stress_response(t, strain, np.array([4800, .42, .65])) * 100e-6).tolist()
    result = infer_observation(MODEL, **data)
    assert result["within_synthetic_fit_gate"]
    assert not result["accepted_for_application"]
    assert "insufficient_loading_and_unloading" in result["rejection_reasons"]


def test_mismatched_response_is_rejected_without_hiding_parameters():
    data = observation(); t = np.array(data["times_s"]); force = np.array(data["force_n"])
    force += .4 * np.max(abs(force)) * np.sin(2 * np.pi * 7 * t / t[-1]); data["force_n"] = force.tolist()
    result = infer_observation(MODEL, **data)
    assert not result["accepted_for_application"] and not result["within_synthetic_fit_gate"]
    assert "observed_response_not_reproduced" in result["rejection_reasons"]
    assert len(result["fitted_stress_pa"]) == len(t)


@pytest.mark.parametrize("field,value", [("reference_area_mm2", 0.), ("reference_length_mm", float("nan")), ("provenance", "none")])
def test_invalid_calibration_rejected(field, value):
    data = observation(); data[field] = value
    with pytest.raises(ValueError): infer_observation(MODEL, **data)


def test_nonfinite_nonmonotonic_and_unsupported_strain_rejected():
    for field, index, value in [("times_s", 10, -.1), ("force_n", 10, float("nan")), ("displacement_mm", 10, 10.)]:
        data = observation(); data[field][index] = value
        with pytest.raises(ValueError): infer_observation(MODEL, **data)


def test_manifest_checksum_prevents_stale_or_tampered_model(tmp_path):
    (tmp_path / "manifest.json").write_text(json.dumps({"model_sha256": "incorrect"}))
    (tmp_path / "model.json").write_text("{}")
    with pytest.raises(ValueError, match="checksum"): load_model(tmp_path)
