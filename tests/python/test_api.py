import asyncio
import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient

from services.api.app import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "studio.sqlite")) as local:
        yield local


def test_generate_snapshot_and_stale_commit(client):
    response = client.post("/api/generate", json={"spec": {"seed": 20}, "resolution": "low"})
    assert response.status_code == 200
    scene = response.json()
    assert scene["gate"]["passed"] and scene["metadata"]["review_status"] == "unreviewed"
    snapshot = scene["snapshot"]["id"]
    assert client.get(f"/api/snapshots/{snapshot}").json()["spec"]["seed"] == 20
    commit = {
        "project_id": "local-pilot",
        "title": "Pilot",
        "snapshot_id": snapshot,
        "expected_revision": 0,
    }
    assert client.post("/api/projects/commit", json=commit).status_code == 200
    assert client.post("/api/projects/commit", json=commit).status_code == 409
    assert client.get("/api/projects").json()[0]["revision"] == 1


def test_export_actual_geometry_and_units(client):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    result = client.post(
        "/api/export", json={"snapshot_id": scene["snapshot"]["id"], "format": "viscera"}
    )
    assert result.status_code == 200
    with zipfile.ZipFile(io.BytesIO(result.content)) as archive:
        assert "organs/0/surface-mm.ply" in archive.namelist()
        assert b'"units": "mm"' in archive.read("manifest.json")
    glb = client.post("/api/export", json={"snapshot_id": scene["snapshot"]["id"], "format": "glb"})
    assert glb.status_code == 200 and glb.content[:4] == b"glTF"
    decoded = trimesh.load(io.BytesIO(glb.content), file_type="glb", force="scene")
    liver = decoded.geometry["liver"]
    authoring = np.asarray(scene["organs"][0]["positions"]).reshape(-1, 3)
    expected = authoring[:, [0, 2, 1]] * [0.001, 0.001, -0.001]
    assert np.allclose(liver.vertices, expected, atol=1e-7)
    assert liver.volume > 0


def test_invalid_geometry_not_exported_with_forged_pass(client):
    scene = {
        "organs": [{"positions": [0, 0, 0, 1, 0, 0, 0, 1, 0], "indices": [0, 1, 2]}],
        "gate": {"passed": True},
    }
    response = client.post("/api/export", json={"scene": scene, "format": "glb"})
    assert response.status_code == 422


def test_explicit_rejection_of_unknown_schema_and_text(client):
    assert (
        client.post("/api/generate", json={"spec": {"pathology": "cirrhosis"}}).status_code == 422
    )
    result = client.post(
        "/api/compile", json={"text": "liver width 260 mm and make it blue"}
    ).json()
    assert result["status"] == "unsupported" and result["spec"] is None


def test_snapshot_edit_is_bound_to_exact_base(client):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    payload = {
        "base_snapshot_id": scene["snapshot"]["id"],
        "expected_content_hash": "0" * 64,
        "spec": scene["spec"],
        "resolution": "low",
    }
    assert client.post("/api/edit", json=payload).status_code == 409
    payload["expected_content_hash"] = scene["snapshot"]["content_hash"]
    payload["locked_organ_ids"] = ["liver"]
    payload["spec"]["parameters"]["liver_width_mm"] = 260
    assert client.post("/api/edit", json=payload).status_code == 422


def test_variation_seed_changes_shape_params(client):
    first = client.get("/api/variation/1").json()["parameters"]
    second = client.get("/api/variation/2").json()["parameters"]
    assert first != second
    assert client.get("/api/variation/-1").status_code == 422


def test_realized_snapshot_preserves_untouched_sculpt_and_blocks_replacement(client):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    liver = scene["organs"][0]
    liver["metadata"]["editor_modified"] = True
    # A small upward translation creates a real edit and increases organ clearance.
    liver["positions"] = [
        v * (1.02 if i % 3 == 0 else 1) + (2 if i % 3 == 2 else 0)
        for i, v in enumerate(liver["positions"])
    ]
    saved = client.post("/api/snapshots", json={"scene": scene})
    assert saved.status_code == 200
    snapshot = saved.json()
    realized = client.get(f"/api/snapshots/{snapshot['id']}").json()
    assert "simulation" not in realized and not realized["gate"]["simulation_verified"]
    spec = scene["spec"]
    spec["parameters"]["gallbladder_length_mm"] = 65
    edited = client.post(
        "/api/edit",
        json={
            "base_snapshot_id": snapshot["id"],
            "expected_content_hash": snapshot["content_hash"],
            "spec": spec,
            "resolution": "low",
        },
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["scene"]["organs"][0]["positions"] == liver["positions"]
    assert edited.json()["scene"]["measurements"]["liver_width_mm"] == pytest.approx(
        scene["spec"]["parameters"]["liver_width_mm"] * 1.02
    )
    assert "landmarks" not in realized["organs"][0]
    spec["parameters"]["liver_width_mm"] = 255
    replaced = client.post(
        "/api/edit",
        json={
            "base_snapshot_id": snapshot["id"],
            "expected_content_hash": snapshot["content_hash"],
            "spec": spec,
            "resolution": "low",
        },
    )
    assert (
        replaced.status_code == 422 and replaced.json()["detail"]["code"] == "LOCAL_EDIT_CONFLICT"
    )


def test_snapshot_rechecks_instead_of_trusting_uploaded_gate(client):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    scene["organs"][0]["indices"][0] = -1
    assert client.post("/api/snapshots", json={"scene": scene}).status_code == 422


def test_export_rejects_single_reversed_face(client):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    indices = scene["organs"][0]["indices"]
    indices[0], indices[1] = indices[1], indices[0]
    assert client.post("/api/export", json={"scene": scene, "format": "glb"}).status_code == 422


def test_show_vessels_keeps_exact_surfaces_and_rebuilds_matching_dependencies(client):
    scene = client.post(
        "/api/generate", json={"spec": {"include_vessels": False}, "resolution": "low"}
    ).json()
    spec = {**scene["spec"], "include_vessels": True}
    result = client.post(
        "/api/edit",
        json={
            "base_snapshot_id": scene["snapshot"]["id"],
            "expected_content_hash": scene["snapshot"]["content_hash"],
            "spec": spec,
            "resolution": "medium",
        },
    )
    assert result.status_code == 200, result.text
    edited = result.json()["scene"]
    assert len(edited["vessels"]) == 5
    assert edited["organs"][0]["positions"] == scene["organs"][0]["positions"]
    assert "simulation" in edited


def test_edit_does_not_accept_failed_generation_gate(client, monkeypatch):
    import copy

    from services.api import app as api

    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    failed = copy.deepcopy(scene)
    failed["gate"]["passed"] = False
    monkeypatch.setattr(api, "generate_scene", lambda *args: failed)
    spec = {**scene["spec"], "seed": 567}
    response = client.post(
        "/api/edit",
        json={
            "base_snapshot_id": scene["snapshot"]["id"],
            "expected_content_hash": scene["snapshot"]["content_hash"],
            "spec": spec,
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "GEOMETRY_GATE_FAILED"


@pytest.mark.parametrize("index_offset", [2**32, 2**63])
def test_export_rejects_indices_before_integer_overflow(client, index_offset):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    organ = scene["organs"][0]
    organ["indices"] = [index + index_offset for index in organ["indices"]]
    result = client.post("/api/export", json={"scene": scene, "format": "glb"})
    assert result.status_code == 422
    assert "out-of-range" in result.json()["detail"]["message"]


@pytest.mark.parametrize("organs", [[None], ["liver"], {"id": "liver"}, 123])
def test_malformed_export_containers_return_validation_error(client, organs):
    result = client.post("/api/export", json={"scene": {"organs": organs}})
    assert result.status_code == 422


def test_unmarked_sculpt_invalidates_derived_geometry_and_cannot_be_overwritten(client):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    liver = scene["organs"][0]
    liver["metadata"]["editor_modified"] = False
    liver["positions"] = [v + (2 if i % 3 == 2 else 0) for i, v in enumerate(liver["positions"])]
    result = client.post("/api/snapshots", json={"scene": scene})
    assert result.status_code == 200, result.text
    saved = result.json()
    realized = client.get(f"/api/snapshots/{saved['id']}").json()
    assert realized["organs"][0]["metadata"]["editor_modified"] is True
    assert "landmarks" not in realized["organs"][0]
    assert "semantic_regions" not in realized["organs"][0]
    assert "lumen" in realized["organs"][1]  # The exact trusted gallbladder is preserved.
    spec = scene["spec"]
    spec["parameters"]["liver_width_mm"] = 245
    edited = client.post(
        "/api/edit",
        json={
            "base_snapshot_id": saved["id"],
            "expected_content_hash": saved["content_hash"],
            "spec": spec,
            "resolution": "low",
        },
    )
    assert edited.status_code == 422
    assert edited.json()["detail"]["code"] == "LOCAL_EDIT_CONFLICT"


def test_unchanged_upload_restores_trusted_derived_data_and_recomputes_normals(client):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    expected = scene["organs"][0]["landmarks"]
    scene["organs"][0]["landmarks"] = {"invented": [0, 0, 0]}
    scene["organs"][0]["normals"] = [0]
    saved = client.post("/api/snapshots", json={"scene": scene}).json()
    organ = client.get(f"/api/snapshots/{saved['id']}").json()["organs"][0]
    assert organ["landmarks"] == expected
    assert organ["metadata"]["editor_modified"] is False
    normals = np.asarray(organ["normals"]).reshape(-1, 3)
    assert len(normals) * 3 == len(organ["positions"])
    assert np.allclose(np.linalg.norm(normals, axis=1), 1)


@pytest.mark.parametrize("field,value", [("metadata", None), ("uv", [0]), ("colors", [1])])
def test_snapshot_rejects_malformed_organ_attributes(client, field, value):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    scene["organs"][0][field] = value
    result = client.post("/api/snapshots", json={"scene": scene})
    assert result.status_code == 422
    assert result.json()["detail"]["code"] == "SNAPSHOT_REJECTED"


def test_snapshot_rejects_unexecutable_resolution_metadata(client):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    scene["metadata"]["resolution"] = "invented-resolution"
    assert client.post("/api/snapshots", json={"scene": scene}).status_code == 422


@pytest.mark.parametrize("seed", [True, "42", 42.0])
def test_learned_seed_contract_matches_procedural_seed_contract(client, seed):
    assert client.post("/api/sample-learned", json={"seed": seed}).status_code == 422


@pytest.mark.parametrize("headers", [[], [(b"content-length", b"1")]])
def test_request_limit_stops_reading_chunked_or_misreported_bodies(headers):
    from services.api.app import BoundedRequestMiddleware

    messages = [
        {"type": "http.request", "body": b"123456", "more_body": True},
        {"type": "http.request", "body": b"789", "more_body": True},
        {"type": "http.request", "body": b"unread", "more_body": False},
    ]
    sent = []
    calls = []

    async def receive():
        return messages.pop(0)

    async def send(message):
        sent.append(message)

    async def downstream(scope, receive, send):
        calls.append(True)

    middleware = BoundedRequestMiddleware(downstream, max_bytes=8)
    asyncio.run(middleware({"type": "http", "method": "POST", "headers": headers}, receive, send))
    assert sent[0]["status"] == 413
    assert (b"x-content-type-options", b"nosniff") in sent[0]["headers"]
    assert len(messages) == 1 and calls == []


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity"])
@pytest.mark.parametrize("route", ["generate", "sample-learned"])
def test_nonfinite_request_values_are_validation_errors_not_server_errors(client, value, route):
    body = (
        '{"spec":{"parameters":{"liver_width_mm":' + value + "}}}"
        if route == "generate"
        else '{"conditions":{"liver_volume_ml":' + value + "}}"
    )
    result = client.post(
        f"/api/{route}", content=body, headers={"Content-Type": "application/json"}
    )
    assert result.status_code == 422
    assert result.json()["detail"][0]["type"] == "finite_number"


def test_bundled_high_resolution_scene_is_editable_without_a_database_reference(client):
    scene = json.loads(
        (Path(__file__).parents[2] / "apps/studio/public/default-scene.json").read_text()
    )
    assert "snapshot" not in scene
    result = client.post("/api/snapshots", json={"scene": scene})
    assert result.status_code == 200, result.text
    snapshot = result.json()
    spec = scene["spec"]
    spec["parameters"]["liver_width_mm"] = 245
    edit = client.post(
        "/api/edit",
        json={
            "base_snapshot_id": snapshot["id"],
            "expected_content_hash": snapshot["content_hash"],
            "spec": spec,
            "resolution": "medium",
        },
    )
    assert edit.status_code == 200, edit.text
    assert edit.json()["scene"]["measurements"]["liver_width_mm"] == pytest.approx(245)


@pytest.mark.parametrize("field,value", [("units", "m"), ("coordinate_frame", "LPS+")])
def test_snapshot_rejects_conflicting_coordinate_conventions(client, field, value):
    scene = client.post("/api/generate", json={"resolution": "low"}).json()
    scene["metadata"][field] = value
    assert client.post("/api/snapshots", json={"scene": scene}).status_code == 422
