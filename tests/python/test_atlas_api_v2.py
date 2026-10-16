"""Exercise real versioned API geometry, grammar and GLB exports; no model weights."""

from __future__ import annotations

import io
import json
import struct
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi import FastAPI
from fastapi.testclient import TestClient
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec
from viscera_core.atlas_disease_scene import realize as legacy_realize
from viscera_core.atlas_materials import make_recipe

from services.api import atlas
from services.api.atlas_joint_registry import select_generation

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = ROOT / "datasets/atlas/cohort-v2/templates"
TEMPLATE = "bp3d-gallbladder-male"


@pytest.fixture
def client(tmp_path, monkeypatch):
    if not (TEMPLATES / (TEMPLATE + ".npz")).is_file():
        pytest.skip("Attributed organ templates are unavailable")
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "models"))
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(TEMPLATES))
    app = FastAPI()
    app.include_router(atlas.router)
    with TestClient(app) as test_client:
        yield test_client


def test_v2_compile_generate_and_textured_export_preserve_realized_geometry(client):
    spec = {
        "template_id": TEMPLATE,
        "renderer_version": "disease-v2",
        "seed": 2027,
        "material": make_recipe("gallbladder", seed=19).model_dump(mode="json"),
    }
    edited = client.post(
        "/api/atlas/compile",
        json={"spec": spec, "text": "gallbladder-distension severity 0.84 size 0.75"},
    )
    assert edited.status_code == 200, edited.text
    compiled = edited.json()
    assert compiled["status"] == "accepted" and compiled["spec"]["renderer_version"] == "disease-v2"
    assert compiled["spec"]["disease"]["profile_id"] == "gallbladder-distension"
    generated = client.post("/api/atlas/generate", json=compiled["spec"])
    assert generated.status_code == 200, generated.text
    result = generated.json()
    assert result["spec"]["renderer_version"] == "disease-v2"
    assert result["scene"]["metadata"]["disease"]["renderer_version"] == "disease-v2"
    assert result["scene"]["metadata"]["qa"]["passed"] is True
    assert result["summary"]["disease"]["internal_anatomy_generated"] is False
    vertices = np.asarray(result["scene"]["organs"][0]["positions"]).reshape(-1, 3)
    assert np.isfinite(vertices).all()
    exported = client.post(
        "/api/atlas/export", json={"spec": result["spec"], "texture_resolution": 512}
    )
    assert exported.status_code == 200, exported.text[:300]
    assert exported.headers["content-type"] == "model/gltf-binary"
    raw = exported.content
    assert raw[:4] == b"glTF"
    header = json.loads(raw[20 : 20 + struct.unpack("<I", raw[12:16])[0]])
    metadata = header["scenes"][0]["extras"]
    assert metadata["spec"]["renderer_version"] == "disease-v2"
    assert metadata["geometry_sha256"] == result["scene"]["metadata"]["geometry_sha256"]
    assert header["images"] and header["textures"]
    mesh = trimesh.load(io.BytesIO(raw), file_type="glb", force="scene").to_geometry()
    np.testing.assert_allclose(mesh.extents, np.ptp(vertices, axis=0) / 1000, rtol=2e-6)
    replay = client.post("/api/atlas/generate", json=result["spec"]).json()
    assert replay["spec"]["realized_id"] == result["spec"]["realized_id"]


def test_v2_export_rejects_unbound_or_changed_recipe_and_stage_claim(client):
    spec = {
        "template_id": TEMPLATE,
        "renderer_version": "disease-v2",
        "disease": {"profile_id": "gallbladder-distension", "severity": 0.8},
    }
    assert (
        client.post("/api/atlas/export", json={"spec": spec, "texture_resolution": 512}).status_code
        == 422
    )
    result = client.post("/api/atlas/generate", json=spec).json()
    result["spec"]["disease"]["severity"] = 0.2
    stale = client.post(
        "/api/atlas/export", json={"spec": result["spec"], "texture_resolution": 512}
    )
    assert stale.status_code == 422 and "displayed specimen" in stale.json()["detail"]
    clinical = client.post(
        "/api/atlas/compile", json={"spec": spec, "text": "gallbladder distension stage 4"}
    )
    assert clinical.status_code == 200
    assert clinical.json()["status"] == "unsupported" and "spec" not in clinical.json()
    wrong_version = {**spec, "renderer_version": "unknown-v3"}
    assert client.post("/api/atlas/generate", json=wrong_version).status_code == 422


def test_old_spec_stays_on_exact_original_renderer_when_v2_catalog_selected(client):
    # Selecting a catalog generation creates no weights and cannot enable sampling.
    select_generation(ROOT, 2)
    catalog = client.get("/api/atlas/catalog")
    assert catalog.status_code == 200
    assert catalog.json()["renderer_version"] == "disease-v2"
    assert sum(p["supported"] for p in catalog.json()["diseases"]["profiles"]) == 60
    old = DiseaseAtlasSpec(
        template_id=TEMPLATE,
        seed=71,
        disease={"profile_id": "gallbladder-cholecystitis", "severity": 0.62},
    )
    expected = legacy_realize(TEMPLATES, old)
    actual = client.post("/api/atlas/generate", json=old.model_dump(mode="json"))
    assert actual.status_code == 200
    value = actual.json()
    assert "renderer_version" not in value["spec"]
    assert (
        value["scene"]["metadata"]["geometry_sha256"]
        == expected["scene"]["metadata"]["geometry_sha256"]
    )
    np.testing.assert_array_equal(
        value["scene"]["organs"][0]["positions"], expected["scene"]["organs"][0]["positions"]
    )
    exported = client.post(
        "/api/atlas/export", json={"spec": value["spec"], "texture_resolution": 512}
    )
    assert exported.status_code == 200 and exported.content[:4] == b"glTF"
    edited = client.post(
        "/api/atlas/compile", json={"spec": value["spec"], "text": "slightly wider"}
    ).json()
    assert edited["status"] == "accepted" and "renderer_version" not in edited["spec"]
    assert edited["spec"]["disease"] == value["spec"]["disease"]
    missing = client.post(
        "/api/atlas/sample-joint",
        json={"spec": {"template_id": TEMPLATE, "renderer_version": "disease-v2"}, "seed": 42},
    )
    assert missing.status_code == 422 and "Import" in missing.json()["detail"]


def test_v2_shape_edit_keeps_disease_and_clear_keeps_renderer_version(client):
    spec = {
        "template_id": TEMPLATE,
        "renderer_version": "disease-v2",
        "disease": {"profile_id": "gallbladder-contraction", "severity": 0.9},
    }
    edited = client.post("/api/atlas/compile", json={"spec": spec, "text": "slightly wider"}).json()
    assert edited["status"] == "accepted"
    assert edited["spec"]["renderer_version"] == "disease-v2"
    assert edited["spec"]["disease"]["profile_id"] == "gallbladder-contraction"
    assert edited["spec"]["disease"]["severity"] == 0.9
    baseline = client.post(
        "/api/atlas/compile", json={"spec": edited["spec"], "text": "baseline"}
    ).json()
    assert baseline["status"] == "accepted"
    assert baseline["spec"]["renderer_version"] == "disease-v2"
    assert baseline["spec"].get("disease") is None


def test_missing_v2_references_do_not_fall_back_or_break_v1(client, tmp_path, monkeypatch):
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES_V2", str(tmp_path / "missing-v2-templates"))
    spec = {"template_id": TEMPLATE, "seed": 71}
    assert client.post("/api/atlas/generate", json=spec).status_code == 200
    versioned = {**spec, "renderer_version": "disease-v2"}
    assert client.post("/api/atlas/generate", json=versioned).status_code == 404
    assert (
        client.post(
            "/api/atlas/compile", json={"spec": versioned, "text": "slightly wider"}
        ).status_code
        == 404
    )
    select_generation(ROOT, 2)
    assert client.get("/api/atlas/catalog").status_code == 503
