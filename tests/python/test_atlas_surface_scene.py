"""Cross-layer material-v2 contracts: shape independence, text atomicity and portable maps."""

from __future__ import annotations

import hashlib
import io
import json
import struct
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import trimesh
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from viscera_core.atlas_material_bake import bake_maps
from viscera_core.atlas_material_text import compile_text
from viscera_core.atlas_materials import make_recipe, sample_material
from viscera_core.atlas_scene import AtlasSpec
from viscera_core.atlas_scene import realize as legacy_realize
from viscera_core.atlas_surface_scene import SurfaceAtlasSpec, export_glb, realize

pytest_plugins = ["test_atlas_integration"]


def _glb(binary: bytes) -> tuple[dict[str, Any], bytes]:
    length, kind = struct.unpack_from("<II", binary, 12)
    assert kind == 0x4E4F534A
    tree = json.loads(binary[20 : 20 + length])
    return tree, binary[28 + length :]


def test_v1_exact_contract_and_material_geometry_independence(library: Path) -> None:
    legacy = AtlasSpec(template_id="fixture-liver", controls={"bend": 0.15})
    plain = SurfaceAtlasSpec.model_validate(legacy.model_dump())
    assert plain.model_dump() == legacy.model_dump()
    assert realize(library, plain) == legacy_realize(library, legacy)
    spec = SurfaceAtlasSpec(**legacy.model_dump(), material=make_recipe("liver"))
    first = realize(library, spec)
    second = realize(
        library, spec.model_copy(update={"material": make_recipe("liver", "rich", 913)})
    )
    for key in ("positions", "indices", "normals", "rest_positions"):
        assert first["scene"]["organs"][0][key] == second["scene"]["organs"][0][key]
    assert (
        first["scene"]["metadata"]["geometry_sha256"]
        == second["scene"]["metadata"]["geometry_sha256"]
    )
    assert first["spec"]["realized_id"] != second["spec"]["realized_id"]
    assert first["scene"]["organs"][0]["colors"] != second["scene"]["organs"][0]["colors"]
    with pytest.raises(ValueError, match="match"):
        realize(library, spec.model_copy(update={"material": make_recipe("kidney")}))
    with pytest.raises(ValueError, match="tissue"):
        SurfaceAtlasSpec(
            template_id="fixture-liver", material=make_recipe("liver"), appearance="clay"
        )


def test_material_text_composes_atomically_and_preserves_shape(library: Path) -> None:
    spec = SurfaceAtlasSpec(
        template_id="fixture-liver", controls={"bend": 0.25}, material=make_recipe("liver")
    )
    original = spec.model_dump()
    texture = compile_text(library, "rich texture with wetness 0.7 and texture seed 91", spec)
    assert texture["status"] == "accepted"
    assert texture["spec"]["controls"] == spec.controls
    assert texture["spec"]["material"]["preset"] == "rich"
    assert texture["spec"]["material"]["wetness"] == 0.7
    assert texture["spec"]["material"]["seed"] == 91
    for verb in ("create", "show", "use", "generate", "select"):
        assert compile_text(library, verb + " rich texture", spec)["status"] == "accepted"
    shape = compile_text(library, "liver slightly wider", spec)
    assert shape["status"] == "accepted"
    assert shape["spec"]["material"] == spec.material.model_dump()
    both = compile_text(library, "liver slightly wider and wetter", spec)
    assert both["status"] == "accepted"
    assert both["spec"]["material"]["wetness"] == 0.65
    for text in (
        "not wetter",
        "wetness 2",
        "wetter and drier",
        "wetness 0.2 wetness 0.8",
        "rich texture with a tumor",
        "rich texture and clay",
        "texture seed 1.4",
        "rich texture with random unknown detail",
    ):
        assert compile_text(library, text, spec)["status"] == "unsupported", text
    assert spec.model_dump() == original


def test_material_glb_binds_recipe_and_exports_real_maps(library: Path) -> None:
    result = realize(
        library,
        SurfaceAtlasSpec(template_id="fixture-liver", material=make_recipe("liver", "rich")),
    )
    spec = SurfaceAtlasSpec.model_validate(result["spec"])
    with pytest.raises(ValueError, match="match"):
        export_glb(
            library, spec.model_copy(update={"material": make_recipe("liver", "moist")}), 128
        )
    binary = export_glb(library, spec, 128)
    tree, blob = _glb(binary)
    material = tree["materials"][0]
    assert "normalTexture" in material
    pbr = material["pbrMetallicRoughness"]
    assert "baseColorTexture" in pbr and "metallicRoughnessTexture" in pbr
    assert pbr["metallicFactor"] == 0
    assert "TANGENT" in tree["meshes"][0]["primitives"][0]["attributes"]
    assert "COLOR_0" not in tree["meshes"][0]["primitives"][0]["attributes"]
    assert tree["scenes"][0]["extras"]["spec"] == spec.model_dump()
    assert len(tree["images"]) == 3
    diversity = []
    for entry in tree["images"]:
        view = tree["bufferViews"][entry["bufferView"]]
        png = blob[view.get("byteOffset", 0) : view.get("byteOffset", 0) + view["byteLength"]]
        pixels = np.asarray(Image.open(io.BytesIO(png)))
        assert pixels.shape == (128, 128, 3)
        diversity.append(np.unique(pixels.reshape(-1, 3), axis=0).shape[0])
    # A coarse texel footprint intentionally filters subpixel normal detail to flat.
    assert sum(n > 3 for n in diversity) >= 2
    loaded = trimesh.load(io.BytesIO(binary), file_type="glb", force="mesh", process=False)
    original = np.asarray(result["scene"]["organs"][0]["positions"]).reshape(-1, 3) / 1000
    original_faces = np.asarray(result["scene"]["organs"][0]["indices"]).reshape(-1, 3)
    np.testing.assert_allclose(loaded.vertices[loaded.faces], original[original_faces], atol=1e-8)


def test_baked_color_matches_cpu_field_and_normal_frame() -> None:
    points = np.array([[0, 0, 0], [12, 0, 0], [12, 12, 0], [0, 12, 0]], dtype=float)
    faces = np.array([[0, 1, 2], [0, 2, 3]])
    normals = np.tile([0.0, 0.0, 1.0], (4, 1))
    recipe = make_recipe("pancreas", "rich", 271)
    baked = bake_maps(points, points, normals, faces, np.zeros(4), recipe, 128)
    for tri in baked["faces"]:
        uv = baked["uv"][tri]
        pixel = np.floor(uv.mean(axis=0) * 128).astype(int)
        delta = uv[1:] - uv[:1]
        ab = ((pixel + 0.5) / 128 - uv[0]) @ np.linalg.inv(delta)
        bary = np.r_[1 - ab.sum(), ab]
        rest = points[baked["mapping"][tri]]
        dr = np.linalg.inv(delta) @ (rest[1:] - rest[:1])
        footprint = np.max(np.linalg.norm(dr, axis=1)) / 128
        fields = sample_material(recipe, (bary @ rest)[None], footprint_mm=footprint)
        yy, xx = pixel[1], pixel[0]
        np.testing.assert_allclose(
            baked["base_color"][yy, xx] / 255, fields.rgb_srgb[0], atol=0.5 / 255 + 1e-8
        )
        t = bary @ baked["tangents"][tri, :3]
        t /= np.linalg.norm(t)
        b = np.cross([0, 0, 1], t) * np.sign(bary @ baked["tangents"][tri, 3])
        target = np.r_[-fields.height_gradient_drest_mm[0, :2], 1.0]
        target /= np.linalg.norm(target)
        expected = np.array([target @ t, target @ b, target[2]]) * 0.5 + 0.5
        np.testing.assert_allclose(baked["normal"][yy, xx] / 255, expected, atol=0.5 / 255 + 1e-7)


def test_surface_routes_validate_and_preserve_material_during_shape_sampling(
    library: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services.api import atlas as api
    from services.api import atlas_model

    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)
    monkeypatch.setenv("VISCERA_ATLAS_TEMPLATES", str(library))
    monkeypatch.setenv("VISCERA_ATLAS_MATERIAL_MODEL", str(tmp_path / "unavailable.npz"))
    # an empty model store: a developer's active imported bundle would otherwise take precedence over the missing model
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "model-store"))
    spec = SurfaceAtlasSpec(
        template_id="fixture-liver", material=make_recipe("liver", "moist", 313)
    )
    response = client.post("/api/atlas/generate", json=spec.model_dump())
    assert response.status_code == 200
    displayed = response.json()
    assert "materials" in client.get("/api/atlas/catalog").json()
    for payload in (
        {**spec.model_dump(), "appearance": "clay"},
        {**spec.model_dump(), "material": {**spec.material.model_dump(), "wetness": True}},
    ):
        assert client.post("/api/atlas/generate", json=payload).status_code == 422
    assert (
        client.post(
            "/api/atlas/sample-material", json={"spec": displayed["spec"], "seed": 51}
        ).status_code
        == 503
    )
    assert (
        client.post(
            "/api/atlas/sample-material",
            json={"spec": displayed["spec"], "conditions": {"roughness_mean": True}},
        ).status_code
        == 422
    )

    def fake_shape_sampler(
        root: Path, model: Path, data: Path, request: AtlasSpec, match: bool
    ) -> dict[str, Any]:
        result = legacy_realize(
            root, request.model_copy(update={"controls": {**request.controls, "bend": 0.2}})
        )
        result["summary"]["model"] = {"method": "test-fixture"}
        result["scene"]["metadata"]["model"] = {"method": "test-fixture"}
        return result

    monkeypatch.setattr(atlas_model, "sample_model", fake_shape_sampler)
    response = client.post("/api/atlas/sample", json={"spec": displayed["spec"]})
    assert response.status_code == 200
    changed = response.json()
    assert changed["spec"]["material"] == displayed["spec"]["material"]
    assert changed["spec"]["controls"]["bend"] == 0.2
    assert changed["spec"]["realized_id"] != displayed["spec"]["realized_id"]

    def busy_export(*args: Any) -> bytes:
        from viscera_core.atlas_material_bake import MaterialBakeBusyError

        raise MaterialBakeBusyError("Another material export is in progress; retry shortly")

    monkeypatch.setattr(api, "export_glb", busy_export)
    response = client.post("/api/atlas/export", json={"spec": displayed["spec"]})
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "2"


def test_material_sampler_does_not_require_unrelated_templates(
    library: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from viscera_core import atlas_material_dataset as dataset

    from pipelines.train.viscera_train import atlas_material as prior
    from services.api import atlas_material_model as serving

    root = tmp_path / "material-data"
    root.mkdir()
    (root / "release.json").write_text("{}")
    (root / "dataset_card.json").write_text(
        json.dumps(
            {
                "source_templates": {
                    "fixture-liver": {"organ": "liver", "artifact_sha256": "a" * 64},
                    "missing-gallbladder": {"organ": "gallbladder", "artifact_sha256": "b" * 64},
                }
            }
        )
    )
    model = tmp_path / "model.npz"
    model.touch()
    model.with_suffix(".json").write_text("{}")
    monkeypatch.setattr(
        serving,
        "_load",
        lambda *a: {
            "metadata": {
                "identity": {"dataset_release_sha256": hashlib.sha256(b"{}").hexdigest()},
                "model_sha256": "c" * 64,
            }
        },
    )
    monkeypatch.setattr(dataset, "verify_material_release", lambda p: {})
    monkeypatch.setattr(
        prior, "sample_recipe", lambda m, o, p, s, c: {"recipe": make_recipe(o, p, s).model_dump()}
    )
    monkeypatch.setattr(
        prior,
        "load_anchors",
        lambda p: {
            "fixture-liver": np.arange(96, dtype=float).reshape(32, 3),
            "missing-gallbladder": np.zeros((32, 3)),
        },
    )
    result = serving.sample_material_model(
        library,
        model,
        root,
        SurfaceAtlasSpec(template_id="fixture-liver", material=make_recipe("liver")),
        37,
    )
    info = result["summary"]["material_model"]
    assert info["measured_anchor_template"] == "fixture-liver"
    assert info["measured_anchor_template_sha256"] == "a" * 64
    assert result["spec"]["material"]["seed"] == 37
