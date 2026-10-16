from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from services.api.app import create_app

ROOT = Path(__file__).resolve().parents[2]
RENDERER_RECIPES = [
    pytest.param({}, id="legacy"),
    pytest.param({"renderer_version": "disease-v2"}, id="v2-baseline"),
    pytest.param(
        {
            "renderer_version": "disease-v2",
            "disease": {"profile_id": "liver-capsular-cyst", "severity": 0.7},
        },
        id="v2-disease",
    ),
]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("VISCERA_PHYSICS_MODEL", str(ROOT / "artifacts/physics/liver-network-v1"))
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(ROOT / "datasets/atlas/cohort-v2/templates"))
    return TestClient(create_app(tmp_path / "physics.sqlite"))


def test_physics_model_status_and_independent_inference(client):
    status = client.get("/api/physics/status").json()
    if status["status"] != "ready":
        pytest.skip("Run physics training script")
    assert status["human_liver_validated"] is False
    observation = client.get("/api/physics/demo-observation").json()
    request = {
        k: observation[k]
        for k in (
            "times_s",
            "force_n",
            "displacement_mm",
            "reference_length_mm",
            "reference_area_mm2",
        )
    }
    response = client.post(
        "/api/physics/infer", json={**request, "provenance": observation["evidence"]}
    )
    assert response.status_code == 200
    assert response.json()["within_synthetic_fit_gate"]
    assert response.json()["human_liver_validated"] is False
    assert (
        client.post(
            "/api/physics/infer",
            json={**request, "reference_area_mm2": 0, "provenance": "invalid area"},
        ).status_code
        == 422
    )


def test_bad_run_requests_rejected_before_solver(client):
    spec = {"template_id": "hra-liver-male"}
    for extra in [
        {"protocol": "invented"},
        {"amplitude_mm": 50},
        {"amplitude_mm": True},
        {"parameters": {"young_pa": 5000}},
        {"parameter_source": "manual", "parameters": {"young_pa": -1}},
        {"parameter_source": "manual", "parameters": {"poisson": 0.5}},
    ]:
        assert client.post("/api/physics/run", json={"spec": spec, **extra}).status_code == 422


@pytest.mark.parametrize("renderer_recipe", RENDERER_RECIPES)
def test_run_binds_actual_displayed_liver_and_rejects_other_organs(
    client, monkeypatch, renderer_recipe
):
    from viscera_core import liver_physics

    calls = []

    def simulate(positions, faces, parameters, **kwargs):
        calls.append((positions, faces, parameters, kwargs))
        return {
            "frames": [
                {"time_s": 0.0, "tool_force_n": [0.0, 0.0, 0.0]},
                {"time_s": 1.0, "tool_force_n": [0.0, 1.0, 0.0]},
            ],
            "metrics": {"finite_state": True},
        }

    monkeypatch.setattr(liver_physics, "run_liver_experiment", simulate)
    generated = client.post(
        "/api/atlas/generate",
        json={"template_id": "hra-liver-male", "controls": {"bend": 0.2}, **renderer_recipe},
    )
    assert generated.status_code == 200, generated.text
    generation = generated.json()
    response = client.post(
        "/api/physics/run", json={"spec": generation["spec"], "parameter_source": "manual"}
    )
    assert response.status_code == 200, response.text
    np.testing.assert_array_equal(
        calls[0][0].ravel(), generation["scene"]["organs"][0]["positions"]
    )
    assert response.json()["source"]["realized_id"] == generation["spec"]["realized_id"]
    assert response.json()["source"]["spec"] == generation["spec"]
    assert (
        response.json()["source"]["geometry_sha256"]
        == generation["scene"]["metadata"]["geometry_sha256"]
    )
    assert response.json()["reference_validation"]["status"] == "NOT_RUN"
    assert response.json()["assessment"]["status"] == "NOT_RUN"
    invalid = {**generation["spec"], "realized_id": "0" * 64}
    assert (
        client.post(
            "/api/physics/run", json={"spec": invalid, "parameter_source": "manual"}
        ).status_code
        == 422
    )
    catalog = client.get("/api/atlas/catalog").json()
    other = next(o["templates"][0]["id"] for o in catalog["organs"] if o["id"] != "liver")
    assert (
        client.post(
            "/api/physics/run", json={"spec": {"template_id": other}, "parameter_source": "manual"}
        ).status_code
        == 422
    )
    if client.get("/api/physics/status").json()["status"] == "ready":
        demo = client.get("/api/physics/demo-observation").json()
        observed = {
            k: demo[k]
            for k in (
                "times_s",
                "force_n",
                "displacement_mm",
                "reference_length_mm",
                "reference_area_mm2",
            )
        }
        observed["force_n"] = (np.array(demo["force_n"]) * 1.5).tolist()
        observed["provenance"] = "API test: synthetic stiffer specimen, calibrated known dimensions"
        fit = client.post("/api/physics/infer", json=observed).json()
        response = client.post(
            "/api/physics/run",
            json={
                "spec": generation["spec"],
                "parameter_source": "learned",
                "observation": observed,
            },
        )
        assert response.status_code == 200, response.text
        assert calls[-1][2]["young_pa"] == pytest.approx(fit["parameters"]["young_pa"])
        assert (
            response.json()["learning"]["observation_origin"]
            == "user_supplied_calibration_unverified"
        )
        assert response.json()["learning"]["observation_provenance"] == observed["provenance"]


def test_reference_assessment_endpoint_and_units(client):
    simulation = {"time_s": [0, 1, 2], "force_n": [[0, 0, 0], [0, 1, 0], [0, 0, 0]]}
    response = client.post(
        "/api/physics/assess", json={"simulation": simulation, "reference": simulation}
    )
    assert response.status_code == 200, response.text
    assert response.json()["metrics"]["force"]["nrmse"] == 0
    assert response.json()["physical_validation"]["status"] == "NOT_ESTABLISHED"
    assert (
        client.post(
            "/api/physics/assess",
            json={"simulation": simulation, "reference": {**simulation, "time_s": [3, 4, 5]}},
        ).status_code
        == 422
    )


@pytest.mark.parametrize("renderer_recipe", RENDERER_RECIPES)
def test_playground_binds_displayed_mesh_without_pins_and_preserves_material(
    client, renderer_recipe
):
    generated = client.post(
        "/api/atlas/generate",
        json={"template_id": "hra-liver-female", "controls": {"bend": 0.2}, **renderer_recipe},
    )
    assert generated.status_code == 200, generated.text
    generation = generated.json()
    response = client.post(
        "/api/physics/playground",
        json={
            "spec": generation["spec"],
            "parameter_source": "manual",
            "parameters": {"young_pa": 7300, "density_kg_m3": 1100},
        },
    )
    assert response.status_code == 200, response.text
    prepared = response.json()
    assert prepared["schema_version"] == "liver-physics-playground-1.0.0"
    assert prepared["source"]["realized_id"] == generation["spec"]["realized_id"]
    assert prepared["source"]["spec"] == generation["spec"]
    assert (
        prepared["source"]["geometry_sha256"]
        == generation["scene"]["metadata"]["geometry_sha256"]
    )
    assert prepared["parameters"]["young_pa"] == 7300
    assert prepared["learning"]["source"] == "manual"
    assert prepared["room"] == {"floor_y_mm": 0, "gravity_m_s2": 9.81}
    assert prepared["simulation"]["human_liver_validated"] is False
    assert prepared["simulation"]["contact_model"] == "projected_augmented_lagrangian_sphere_triangle"
    assert prepared["simulation"]["floor_friction"] == {"method": "estimated_reaction_split_coulomb", "coefficient": 0.6}
    assert prepared["simulation"]["contact_accuracy"] == "finite_budget_needs_force_refinement"
    mesh = prepared["mesh"]
    assert mesh["pinned_nodes"] == []
    assert mesh["mass_kg"] == pytest.approx(mesh["cage_volume_ml"] * 1e-6 * 1100)
    vertices = np.asarray(mesh["reference_positions_mm"]).reshape(-1, 3)
    tets = np.asarray(mesh["tets"]).reshape(-1, 4)
    assert (
        np.min(np.linalg.det(np.swapaxes(vertices[tets[:, 1:]] - vertices[tets[:, :1]], 1, 2))) > 0
    )
    weights = np.asarray(mesh["embedding"]["weights"]).reshape(-1, 4)
    cells = tets[np.asarray(mesh["embedding"]["tet_indices"])]
    embedded = np.einsum("ni,nij->nj", weights, vertices[cells])
    expected = np.asarray(generation["scene"]["organs"][0]["positions"]).reshape(-1, 3)
    np.testing.assert_allclose(embedded, expected, atol=1e-7)
    assert mesh["source_vertex_count"] == len(expected)


@pytest.mark.parametrize("endpoint", ["run", "playground"])
def test_physics_preserves_renderer_validation_and_never_falls_back_from_v2(
    client, tmp_path, monkeypatch, endpoint
):
    request = {"spec": {"template_id": "hra-liver-male"}, "parameter_source": "manual"}
    unknown_version = {
        **request,
        "spec": {**request["spec"], "renderer_version": "unknown-v3"},
    }
    assert client.post(f"/api/physics/{endpoint}", json=unknown_version).status_code == 422
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES_V2", str(tmp_path / "missing-v2-templates"))
    versioned = {**request, "spec": {**request["spec"], "renderer_version": "disease-v2"}}
    response = client.post(f"/api/physics/{endpoint}", json=versioned)
    assert response.status_code == 422, response.text
    assert "Template hra-liver-male is unavailable" in response.json()["detail"]


def test_playground_uses_calibration_and_rejects_unsupported_source(client, monkeypatch):
    from services.api import physics

    generation = client.post("/api/atlas/generate", json={"template_id": "hra-liver-male"}).json()
    spec = generation["spec"]
    if client.get("/api/physics/status").json()["status"] == "ready":
        demo = client.get("/api/physics/demo-observation").json()
        observation = {
            key: demo[key]
            for key in [
                "times_s",
                "force_n",
                "displacement_mm",
                "reference_length_mm",
                "reference_area_mm2",
            ]
        }
        observation["force_n"] = (np.asarray(observation["force_n"]) * 1.5).tolist()
        observation["provenance"] = "Synthetic API test: known force increased by 50 percent"
        inferred = client.post("/api/physics/infer", json=observation).json()
        response = client.post(
            "/api/physics/playground", json={"spec": spec, "observation": observation}
        )
        assert response.status_code == 200, response.text
        assert response.json()["parameters"]["young_pa"] == pytest.approx(
            inferred["parameters"]["young_pa"]
        )
        assert (
            response.json()["learning"]["observation_origin"]
            == "user_supplied_calibration_unverified"
        )
    for request in [
        {"spec": {**spec, "realized_id": "0" * 64}, "parameter_source": "manual"},
        {"spec": {"template_id": "hra-heart-male"}, "parameter_source": "manual"},
        {"spec": spec, "protocol": "cut"},
        {"spec": spec, "parameter_source": "learned", "parameters": {"young_pa": 7000}},
    ]:
        assert client.post("/api/physics/playground", json=request).status_code == 422
    physics._solve_lock.acquire()
    try:
        busy = client.post("/api/physics/playground", json={"spec": spec})
        assert busy.status_code == 503
        assert busy.headers["retry-after"] == "2"
    finally:
        physics._solve_lock.release()
    monkeypatch.setattr(physics, "status", lambda: {"status": "unavailable"})
    assert client.post("/api/physics/playground", json={"spec": spec}).status_code == 503
    assert not physics._solve_lock.locked()
