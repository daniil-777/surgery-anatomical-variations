"""Fixture-based contracts for dataset replay, atomic text edits and GLB fidelity."""

from __future__ import annotations

import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi import FastAPI
from fastapi.testclient import TestClient
from viscera_core.atlas import _ingest_one
from viscera_core.atlas_dataset import create_dataset, replay_record, verify_release
from viscera_core.atlas_scene import AtlasSpec, export_glb, realize
from viscera_core.atlas_text import compile_text


@pytest.fixture
def library(tmp_path: Path) -> Path:
    root = tmp_path / "templates"
    root.mkdir()
    scene = trimesh.Scene()
    scene.add_geometry(
        trimesh.creation.icosphere(subdivisions=1, radius=0.08), node_name="liver_capsule"
    )
    source = tmp_path / "source.glb"
    source.write_bytes(scene.export(file_type="glb"))
    meta = {
        "template_id": "fixture-liver",
        "organ": "liver",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "source_collection": "HRA",
        "sex_label": "unknown",
        "laterality": None,
        "source_group_id": "fixture",
        "source_url": "https://example.org/fixture",
        "license": "fixture",
        "attribution": "Test fixture, not clinical anatomy",
        "source_to_authoring_rotation": np.eye(3).tolist(),
    }
    item = _ingest_one(root, source, meta, 1000)
    (root / "catalog.json").write_text(json.dumps({"templates": [item]}))
    (root / "attribution").mkdir()
    (root / "attribution" / "license.html").write_text("Fixture licensing evidence")
    return root


def test_dataset_reproducible_grouped_and_tamper_evident(library: Path, tmp_path: Path) -> None:
    a = tmp_path / "a"
    b = tmp_path / "b"
    first = create_dataset(library, a, count_per_template=8, point_count=32)
    second = create_dataset(library, b, count_per_template=8, point_count=32)
    assert first == second
    assert "attribution/license.html" in first["template_hashes"]
    assert verify_release(a)["accepted"] == 8
    rows = [json.loads(line) for line in (a / "manifest.jsonl").read_text().splitlines()]
    assert len({r["group_id"] for r in rows}) == 8
    assert {r["split"] for r in rows} == {"train", "val", "audit"}
    for row in rows:
        assert replay_record(a, row).metadata["geometry_sha256"] == row["geometry_sha256"]
    with np.load(a / "train.npz", allow_pickle=False) as data:
        assert not data["condition_mask"][:, 4:].any()
        assert np.isnan(data["conditions"][:, 4:]).all()
        np.testing.assert_allclose(np.linalg.norm(data["point_normals"], axis=-1), 1, atol=1e-6)
    assert create_dataset(library, a, count_per_template=8, point_count=32) == first
    (b / "templates/attribution/license.html").write_text("corrupted")
    with pytest.raises(ValueError, match="integrity"):
        verify_release(b)
    (a / "language.jsonl").write_text("corrupted")
    with pytest.raises(ValueError, match="integrity"):
        verify_release(a)


def test_measured_text_edit_is_atomic_and_bounded(library: Path) -> None:
    spec = AtlasSpec(template_id="fixture-liver")
    baseline = realize(library, spec)["summary"]["extent_mm"][0]
    result = compile_text(library, "Make the liver slightly wider and less tapered", spec)
    assert result["status"] == "accepted"
    assert result["measured_extent_mm"][0] == pytest.approx(baseline * 1.03, rel=1e-4)
    assert not any(spec.controls.values())
    little = compile_text(library, "liver a little wider", spec)
    assert little["measured_extent_mm"][0] == pytest.approx(baseline * 1.03, rel=1e-4)
    bent = compile_text(
        library, "more bent", AtlasSpec(template_id="fixture-liver", controls={"bend": -0.6})
    )
    assert bent["spec"]["controls"]["bend"] == pytest.approx(-0.8)
    for text in [
        "clay tissue appearance",
        "liver scale_x -1 width 160 mm",
        "liver 900 mm wide",
        "liver and kidney",
        "not wider",
        "liver with a tumor",
        "wider and shiny freckles",
        "taller and 3% taller",
    ]:
        denied = compile_text(library, text, spec)
        assert denied["status"] == "unsupported", text
        assert "spec" not in denied
    absolute = compile_text(
        library, f"width {baseline * 1.02:g} mm and height {baseline * 0.97:g} mm", spec
    )
    assert absolute["status"] == "accepted"
    assert absolute["max_dimension_relative_error"] < 1e-4


def test_export_is_display_bound_and_uses_metres_and_materials(library: Path) -> None:
    spec = AtlasSpec(template_id="fixture-liver", controls={"bend": 0.2})
    result = realize(library, spec)
    bound = AtlasSpec.model_validate(result["spec"])
    with pytest.raises(ValueError, match="bound"):
        export_glb(library, spec)
    wrong = bound.model_copy(update={"controls": {**bound.controls, "bend": 0.8}})
    with pytest.raises(ValueError, match="does not match"):
        export_glb(library, wrong)
    binary = export_glb(library, bound)
    header = json.loads(binary[20 : 20 + struct.unpack("<I", binary[12:16])[0]])
    assert header["materials"][0]["pbrMetallicRoughness"]["roughnessFactor"] == 0.38
    assert (
        header["materials"][0]["extensions"]["KHR_materials_clearcoat"]["clearcoatFactor"] == 0.28
    )
    assert "COLOR_0" in header["meshes"][0]["primitives"][0]["attributes"]
    mesh = trimesh.load(io.BytesIO(binary), file_type="glb", force="scene").to_geometry()
    np.testing.assert_allclose(
        mesh.extents, np.array(result["summary"]["extent_mm"]) / 1000, rtol=2e-7
    )
    rgb = np.array(result["scene"]["organs"][0]["colors"]).reshape(-1, 3)
    expected = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    accessor = header["accessors"][header["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"]]
    view = header["bufferViews"][accessor["bufferView"]]
    offset = (
        20
        + struct.unpack("<I", binary[12:16])[0]
        + 8
        + view.get("byteOffset", 0)
        + accessor.get("byteOffset", 0)
    )
    assert accessor["componentType"] == 5121 and accessor["normalized"]
    exported = np.frombuffer(
        binary, dtype=np.uint8, count=accessor["count"] * 4, offset=offset
    ).reshape(-1, 4)
    np.testing.assert_allclose(exported[:, :3] / 255, expected, atol=1 / 510 + 1e-8)
    assert header["scenes"][0]["extras"]["source"]["license"] == "fixture"


def test_router_contract_and_validation(library: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from services.api.atlas import router

    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(library))
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    assert client.get("/api/atlas/catalog").json()["release"]["template_count"] == 1
    assert (
        client.post(
            "/api/atlas/generate", json={"template_id": "fixture-liver", "controls": {"scale_x": 2}}
        ).status_code
        == 422
    )
    result = client.post("/api/atlas/generate", json={"template_id": "fixture-liver"})
    assert result.status_code == 200
    response = client.post(
        "/api/atlas/export", json={"spec": result.json()["spec"], "format": "glb"}
    )
    assert response.status_code == 200 and response.content[:4] == b"glTF"
    assert (
        client.post(
            "/api/atlas/compile", json={"spec": result.json()["spec"], "text": "liver 3% wider"}
        ).json()["status"]
        == "accepted"
    )


def test_lung_patch_normals_join_without_changing_geometry() -> None:
    from viscera_core.atlas_scene import display_normals

    v = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.1],
            [0.0, 1.0, 0.0],
        ]
    )
    f = np.array([[0, 1, 2], [3, 4, 5]])
    before = v.copy()
    triangles = f.copy()
    normals, meta = display_normals(v, f, "lung")
    np.testing.assert_array_equal(v, before)
    np.testing.assert_array_equal(f, triangles)
    np.testing.assert_allclose(normals[1], normals[3])
    np.testing.assert_allclose(normals[2], normals[5])
    assert not meta["geometry_modified"] and meta["weld_precision_mm"] == 1e-8
    assert meta["sha256"] == hashlib.sha256(np.asarray(normals, dtype="<f4").tobytes()).hexdigest()


def test_learned_sampling_keeps_identity_dimensions_and_rejects_stale_template(
    library: Path, tmp_path: Path
):
    pytest.importorskip("torch")
    from pipelines.train.viscera_train.atlas_shape import TrainConfig, train
    from services.api.atlas_model import sample_model

    data = tmp_path / "cohort"
    model = tmp_path / "model"
    create_dataset(library, data, count_per_template=16, point_count=32)
    train(data, model, TrainConfig(steps=4, hidden=16, batch_size=8, checkpoint_every=2))
    spec = AtlasSpec(template_id="fixture-liver", seed=14, appearance="clay")
    result = sample_model(library, model / "model.pt", data, spec)
    again = sample_model(library, model / "model.pt", data, spec)
    assert result["spec"] == again["spec"]
    assert result["spec"]["seed"] == 14 and result["spec"]["appearance"] == "clay"
    assert result["summary"]["model"]["refinement_status"] == "matched"
    np.testing.assert_allclose(
        result["summary"]["extent_mm"], realize(library, spec)["summary"]["extent_mm"], rtol=0.001
    )
    with pytest.raises(ValueError, match="reference changed"):
        sample_model(
            library, model / "model.pt", data, spec.model_copy(update={"template_sha256": "0" * 64})
        )
    weights = model / "model.pt"
    weights.write_bytes(weights.read_bytes() + b"corruption")
    with pytest.raises(ValueError, match="checksum"):
        sample_model(library, weights, data, spec)


def test_warm_sampler_rechecks_release_and_missing_source_is_structured(
    library, tmp_path, monkeypatch
):
    from pipelines.train.viscera_train.atlas_shape import TrainConfig, train
    from services.api.atlas import router
    from services.api.atlas_model import sample_model

    data, model = tmp_path / "cohort", tmp_path / "model"
    create_dataset(library, data, count_per_template=8, point_count=32)
    train(data, model, TrainConfig(steps=2, hidden=16, batch_size=8, checkpoint_every=2))
    spec = AtlasSpec(template_id="fixture-liver")
    sample_model(library, model / "model.pt", data, spec, match_dimensions=False)
    (data / "train.npz").write_bytes(b"corrupt paired release")
    with pytest.raises(ValueError, match="integrity"):
        sample_model(library, model / "model.pt", data, spec, match_dimensions=False)
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(library))
    (library / "fixture-liver.npz").unlink()
    app = FastAPI()
    app.include_router(router)
    result = TestClient(app).post("/api/atlas/generate", json={"template_id": "fixture-liver"})
    assert result.status_code == 404 and "detail" in result.json()
