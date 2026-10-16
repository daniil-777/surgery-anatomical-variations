"""Serving gates remain authoritative even when a curve fits numerically."""
import json
from types import SimpleNamespace
import pytest
from pydantic import ValidationError
from services.api import physics


def test_legacy_artifact_is_routed_explicitly(tmp_path, monkeypatch):
    (tmp_path / "manifest.json").write_text(json.dumps({"version": "liver-inverse-sls-1.0.0"}))
    monkeypatch.setenv("VISCERA_PHYSICS_MODEL", str(tmp_path))
    assert physics.model_backend().VERSION == "liver-inverse-sls-1.0.0"
    (tmp_path / "manifest.json").write_text(json.dumps({"version": "unexpected-version"}))
    with pytest.raises(ValueError, match="Unsupported"):
        physics.model_backend()


def test_application_refuses_unidentifiable_material_despite_small_residual(monkeypatch):
    result = {"within_synthetic_fit_gate": True, "accepted_for_application": False,
              "rejection_reasons": ["Relaxation time is not identifiable"], "parameters": {"young_pa": 4800.0}}
    monkeypatch.setattr(physics, "model_backend", lambda: SimpleNamespace(infer_observation=lambda *args, **kwargs: result))
    with pytest.raises(ValueError, match="not identifiable"):
        physics.learned_parameters()


def test_variable_calibration_shape_is_accepted_without_silently_truncating():
    request = dict(times_s=[i * 0.2 for i in range(41)], force_n=[0.0] * 41,
                   displacement_mm=[0.0] * 41, reference_length_mm=20.0,
                   reference_area_mm2=100.0, provenance="Synthetic routing fixture")
    assert len(physics.ObservationRequest(**request).times_s) == 41
    for count in [15, 258]:
        with pytest.raises(ValidationError):
            physics.ObservationRequest(**{**request, "times_s": [0.0] * count})


def test_v2_real_artifact_varied_history_applies_same_inferred_material(tmp_path, monkeypatch):
    import numpy as np
    from pathlib import Path
    from fastapi.testclient import TestClient
    from services.api.app import create_app
    from viscera_core.physics_learning_v2 import stress_response
    root = Path(__file__).resolve().parents[2]
    monkeypatch.setenv("VISCERA_PHYSICS_MODEL", str(root / "artifacts/physics/liver-network-v2"))
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(root / "datasets/atlas/cohort-v2/templates"))
    client = TestClient(create_app(tmp_path / "physics-v2.sqlite"))
    status = client.get("/api/physics/status").json()
    assert status["status"] == "ready", status
    assert status["model_version"] == "liver-inverse-sls-2.0.0"
    assert status["calibration_contract"]["sample_count"] == {"min": 16, "max": 257}
    times = 8 * (np.arange(65) / 64) ** 1.1
    strain = .035 * np.minimum(np.clip(times / .8, 0, 1), np.clip((5.6 - times) / 1.1, 0, 1))
    truth = np.array([7400., .38, .8])
    observation = dict(times_s=times.tolist(), force_n=(stress_response(times, strain, truth) * 1e-4).tolist(),
                       displacement_mm=(strain * 20).tolist(), reference_length_mm=20., reference_area_mm2=100.,
                       provenance="Synthetic independent API integration: known SLS material with varied history")
    response = client.post("/api/physics/infer", json=observation)
    assert response.status_code == 200, response.text
    fit = response.json()
    assert fit["accepted_for_application"] is True
    np.testing.assert_allclose(list(fit["parameters"].values()), truth, rtol=.001)
    generated = client.post("/api/atlas/generate", json={"template_id": "hra-liver-male"}).json()
    response = client.post("/api/physics/playground", json={"spec": generated["spec"], "observation": observation})
    assert response.status_code == 200, response.text
    prepared = response.json()
    for key, value in fit["parameters"].items():
        assert prepared["parameters"][key] == pytest.approx(value)
    assert prepared["learning"]["parameter_intervals_90"] == fit["parameter_intervals_90"]
    assert prepared["learning"]["observation_origin"] == "user_supplied_calibration_unverified"
    assert prepared["source"]["realized_id"] == generated["spec"]["realized_id"]


def test_v2_weak_excitation_is_inspectable_but_cannot_move_the_liver(tmp_path, monkeypatch):
    import numpy as np
    from pathlib import Path
    from fastapi.testclient import TestClient
    from services.api.app import create_app
    from viscera_core.physics_learning_v2 import stress_response
    root = Path(__file__).resolve().parents[2]
    monkeypatch.setenv("VISCERA_PHYSICS_MODEL", str(root / "artifacts/physics/liver-network-v2"))
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(root / "datasets/atlas/cohort-v2/templates"))
    client = TestClient(create_app(tmp_path / "rejected.sqlite"))
    times = np.linspace(0, 6, 81); strain = .025 * times / 6
    observed = dict(times_s=times.tolist(), displacement_mm=(20 * strain).tolist(),
                    force_n=(stress_response(times, strain, np.array([5000., .4, .7])) * 1e-4).tolist(),
                    reference_length_mm=20., reference_area_mm2=100., provenance="Synthetic monotonic ramp without unloading")
    response = client.post("/api/physics/infer", json=observed)
    assert response.status_code == 200, response.text
    fit = response.json()
    assert fit["within_synthetic_fit_gate"] is True
    assert fit["accepted_for_application"] is False
    assert fit["rejection_reasons"]
    response = client.post("/api/physics/playground", json={"spec": {"template_id": "hra-liver-male"}, "observation": observed})
    assert response.status_code == 422
    assert "needs review" in response.json()["detail"]
