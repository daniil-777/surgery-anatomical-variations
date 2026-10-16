import json
from pathlib import Path

import numpy as np
import pytest
from viscera_core.physics_learning import (
    BOUNDS,
    PARAMETER_NAMES,
    TIMES,
    decode_parameters,
    demo_observation,
    encode_parameters,
    infer_observation,
    load_model,
    observation_features,
    predict,
    project_stiffness,
    sls_stress,
    standard_strain,
    synthetic_dataset,
)

MODEL = Path(__file__).resolve().parents[2] / "artifacts/physics/liver-network-v1"


def test_maxwell_recurrence_has_correct_ramp_hold_limit_and_linearity():
    t = np.array([0.0, 0.1, 0.6, 1.1, 1.6])
    e = np.array([0.0, 0.02, 0.02, 0.02, 0.02])
    p = np.array([5000.0, 0.4, 0.5])
    stress = sls_stress(t, e, p)
    equilibrium = 5000 * 0.6 * 0.02
    q_ramp = 5000 * 0.4 * 0.5 * (1 - np.exp(-0.1 / 0.5)) * 0.02 / 0.1
    np.testing.assert_allclose(
        stress[1:], equilibrium + q_ramp * np.exp(-(t[1:] - 0.1) / 0.5), rtol=1e-12
    )
    np.testing.assert_allclose(sls_stress(t, e, p * [2, 1, 1]), 2 * stress)
    assert np.all(np.diff(stress[1:]) < 0)
    assert np.all(stress[1:] > equilibrium)


def test_bounds_transform_and_exact_stiffness_projection():
    p = np.array([[500.0, 0.05, 0.05], [20000.0, 0.75, 2.0], [4800.0, 0.42, 0.65]])
    np.testing.assert_allclose(decode_parameters(encode_parameters(p)), p)
    stress = sls_stress(TIMES, standard_strain(), p)
    proposal = p.copy()
    proposal[:, 0] = 9999.0
    np.testing.assert_allclose(project_stiffness(proposal, stress), p, rtol=1e-12)
    features = observation_features(stress)
    assert features.shape == (3, 82)
    assert features[0, -1] != features[1, -1]


def test_no_time_or_parameter_leakage_across_synthetic_specimens():
    a, pa = synthetic_dataset(32, 7103)
    b, pb = synthetic_dataset(32, 19103)
    assert a.shape == b.shape == (32, 81)
    assert len({tuple(p) for p in pa} & {tuple(p) for p in pb}) == 0
    np.testing.assert_array_equal(a, synthetic_dataset(32, 7103)[0])
    for p in [pa, pb]:
        assert np.all((p >= BOUNDS[:, 0]) & (p <= BOUNDS[:, 1]))


def test_sls_rejects_nonphysical_inputs():
    for p in [[-1, 0.4, 0.5], [5000, 1, 0.5], [5000, 0.4, 0], [np.nan, 0.4, 0.5]]:
        with pytest.raises(ValueError):
            sls_stress(TIMES, standard_strain(), np.array(p))
    with pytest.raises(ValueError):
        sls_stress(TIMES[::-1], standard_strain(), np.array([5000, 0.4, 0.5]))


@pytest.mark.skipif(
    not (MODEL / "model.json").exists(), reason="Run the independent physics training script"
)
def test_frozen_network_runs_without_torch_and_recovers_demo_and_units():
    d = demo_observation()
    kwargs = {
        k: d[k]
        for k in (
            "times_s",
            "force_n",
            "displacement_mm",
            "reference_length_mm",
            "reference_area_mm2",
        )
    }
    result = infer_observation(MODEL, **kwargs, provenance=d["evidence"])
    assert result["within_synthetic_fit_gate"]
    assert result["human_liver_validated"] is False
    assert result["stress_nrmse"] < 0.015
    for k in PARAMETER_NAMES:
        assert result["parameters"][k] == pytest.approx(d["teacher_parameters"][k], rel=0.08)
    scaled = infer_observation(
        MODEL,
        **{**kwargs, "force_n": (np.array(d["force_n"]) * 2).tolist(), "reference_area_mm2": 200.0},
        provenance=d["evidence"],
    )
    assert scaled["parameters"] == result["parameters"]
    wrong = {**kwargs, "displacement_mm": (np.array(d["displacement_mm"]) * 10).tolist()}
    with pytest.raises(ValueError, match="Unsupported excitation"):
        infer_observation(MODEL, **wrong, provenance=d["evidence"])
    with pytest.raises(ValueError, match="tared"):
        infer_observation(MODEL, **{**kwargs, "force_n": [1.0] * 81}, provenance=d["evidence"])


@pytest.mark.skipif(not (MODEL / "model.json").exists(), reason="Run physics training first")
def test_model_integrity_and_out_of_distribution_fit_gate(tmp_path):
    raw = (MODEL / "model.json").read_bytes()
    (tmp_path / "model.json").write_bytes(raw + b" ")
    (tmp_path / "manifest.json").write_text((MODEL / "manifest.json").read_text())
    with pytest.raises(ValueError, match="checksum"):
        load_model(tmp_path)
    d = demo_observation()
    kwargs = {
        k: d[k]
        for k in (
            "times_s",
            "force_n",
            "displacement_mm",
            "reference_length_mm",
            "reference_area_mm2",
        )
    }
    kwargs["force_n"] = (np.array(d["force_n"]) * 1000).tolist()
    result = infer_observation(MODEL, **kwargs, provenance="out of domain synthetic test")
    assert result["within_synthetic_fit_gate"] is False
    assert result["parameters"]["young_pa"] <= 20000
    report = json.loads((MODEL / "evaluation.json").read_text())
    assert report["synthetic_gate_passed"]
    assert report["split_seeds"]["test"] == 19103
    assert predict(MODEL, np.array(d["stress_pa"]))["model_id"] == report["model_sha256"]


@pytest.mark.skipif(
    not (MODEL / "held_out_predictions.npz").exists(), reason="Run physics training first"
)
def test_numpy_serving_matches_frozen_torch_export():
    # Reproduce complete RNG draw so per-specimen noise also agrees with training.
    curves, actual = synthetic_dataset(1024, 19103)
    with np.load(MODEL / "held_out_predictions.npz", allow_pickle=False) as saved:
        np.testing.assert_array_equal(actual, saved["actual"])
        prediction = predict(MODEL, curves[:24])["parameters"]
        np.testing.assert_allclose(prediction, saved["predicted"][:24], rtol=3e-5, atol=1e-5)
