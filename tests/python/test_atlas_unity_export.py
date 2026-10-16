"""Independent Unity map packing, coordinate-frame, and edited-export contracts."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import zipfile
from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from viscera_core.atlas_material_bake import bake_maps
from viscera_core.atlas_materials import make_recipe
from viscera_core.atlas_unity_export import (
    _package_unity,
    apply_surface_edits,
    bind_surface_vessels,
    pack_unity_mask,
    unity_mesh,
)


def fixture() -> tuple[dict[str, Any], Any, dict[str, Any]]:
    points = np.array([[0.0, 0, 0], [20.0, 0, 0], [20.0, 20, 0], [0.0, 20, 0]])
    normals = np.tile([0.0, 0, 1], (4, 1))
    faces = np.array([[0, 1, 2], [0, 2, 3]])
    recipe = make_recipe("heart", "rich", 31)
    baked = bake_maps(points, points, normals, faces, np.zeros(4), recipe, 128)
    item = {
        "id": "heart",
        "positions": points.reshape(-1).tolist(),
        "rest_positions": points.reshape(-1).tolist(),
        "normals": normals.reshape(-1).tolist(),
        "indices": faces.reshape(-1).tolist(),
        "metadata": {},
    }
    result = {"spec": {"template_id": "heart"}, "scene": {"metadata": {}, "organs": [item]}}
    return result, recipe, baked


def test_mask_uses_unity_smoothness_and_linear_occlusion_channels() -> None:
    orm = np.array([[[255, 0, 17], [71, 255, 255], [123, 101, 0]]], dtype=np.uint8)
    packed = pack_unity_mask(orm)
    np.testing.assert_array_equal(packed, [[[17, 255, 0, 255], [255, 71, 0, 0], [0, 123, 0, 154]]])


def test_unity_reflection_uv_normal_and_tangent_transform_preserve_shading() -> None:
    result, _, baked = fixture()
    item = result["scene"]["organs"][0]
    exported = unity_mesh(item, baked)
    p = np.array(exported["positions"]).reshape(-1, 3)
    n = np.array(exported["normals"]).reshape(-1, 3)
    t = np.array(exported["tangents"]).reshape(-1, 4)
    uv = np.array(exported["uv"]).reshape(-1, 2)
    faces = np.array(exported["indices"]).reshape(-1, 3)
    reflect = np.array([1.0, 1, -1])
    np.testing.assert_allclose(
        p, np.array(item["positions"]).reshape(-1, 3)[baked["mapping"]] * reflect / 1000, atol=1e-8
    )
    np.testing.assert_allclose(uv, baked["uv"] * [1, -1] + [0, 1], atol=1e-7)
    geometric = np.cross(p[faces[:, 1]] - p[faces[:, 0]], p[faces[:, 2]] - p[faces[:, 0]])
    assert np.all(np.sum(geometric * n[faces[:, 0]], axis=1) > 0)
    normal_sample = np.array([0.2, -0.3, np.sqrt(0.87)])
    original_t = baked["tangents"]
    original_n = np.tile([0.0, 0, 1], (len(t), 1))
    original_b = np.cross(original_n, original_t[:, :3]) * original_t[:, 3:]
    original_shading = (
        original_t[:, :3] * normal_sample[0]
        + original_b * normal_sample[1]
        + original_n * normal_sample[2]
    )
    unity_b = np.cross(n, t[:, :3]) * t[:, 3:]
    unity_shading = t[:, :3] * normal_sample[0] - unity_b * normal_sample[1] + n * normal_sample[2]
    np.testing.assert_allclose(unity_shading, original_shading * reflect, atol=1e-7)


def test_bundle_png_sizes_channels_hashes_and_exact_mesh() -> None:
    result, recipe, baked = fixture()
    package = _package_unity(result, recipe, baked)
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        manifest_path = next(p for p in archive.namelist() if p.endswith("manifest.json"))
        prefix = manifest_path.removesuffix("manifest.json")
        manifest = json.loads(archive.read(manifest_path))
        assert manifest["texture_resolution"] == [128, 128]
        assert manifest["unity_editor_execution"].startswith("NOT_RUN")
        for path, info in manifest["files"].items():
            payload = archive.read(prefix + path)
            assert hashlib.sha256(payload).hexdigest() == info["sha256"]
            if path.endswith(".png"):
                with Image.open(io.BytesIO(payload)) as image:
                    assert image.size == (128, 128)
        normal = np.array(
            Image.open(io.BytesIO(archive.read(prefix + "Textures/Viscera_Normal.png")))
        )
        np.testing.assert_array_equal(normal[:, :, 0], baked["normal"][:, :, 0])
        np.testing.assert_array_equal(normal[:, :, 1], 255 - baked["normal"][:, :, 1])
        mask = np.array(Image.open(io.BytesIO(archive.read(prefix + "Textures/Viscera_Mask.png"))))
        np.testing.assert_array_equal(mask, pack_unity_mask(baked["metallic_roughness"]))
        assert (
            json.loads(archive.read(prefix + "Anatomy.visceraunity"))["indices"]
            == unity_mesh(result["scene"]["organs"][0], baked)["indices"]
        )
        assert "Assets/VISCERA/Editor/VisceraUnityImporter.cs" in archive.namelist()


def test_edits_recompute_normals_but_preserve_rest_and_source_topology() -> None:
    result, _, _ = fixture()
    item = result["scene"]["organs"][0]
    rest, indices = copy.deepcopy(item["rest_positions"]), copy.deepcopy(item["indices"])
    positions = np.array(item["positions"]).reshape(-1, 3)
    positions[:, 2] = positions[:, 0] * 0.2
    apply_surface_edits(
        result, [{"organ_id": "heart", "positions": positions.reshape(-1).tolist()}]
    )
    assert item["rest_positions"] == rest
    assert item["indices"] == indices
    np.testing.assert_allclose(
        np.array(item["normals"]).reshape(-1, 3),
        np.tile(np.array([-0.2, 0, 1]) / np.sqrt(1.04), (4, 1)),
    )
    assert item["metadata"]["surface_edit"]["max_displacement_mm"] == 4


@pytest.mark.parametrize("kind", ["missing", "nan", "length", "collapse", "reverse", "duplicate"])
def test_invalid_edits_rejected(kind: str) -> None:
    result, _, _ = fixture()
    positions = list(result["scene"]["organs"][0]["positions"])
    name = "heart"
    if kind == "missing":
        name = "not-the-source"
    if kind == "nan":
        positions[0] = float("nan")
    if kind == "length":
        positions.pop()
    if kind == "collapse":
        positions[3:6] = positions[:3]
    if kind == "reverse":
        positions[3] = -20
    edits = [{"organ_id": name, "positions": positions}]
    if kind == "duplicate":
        edits *= 2
    with pytest.raises(ValueError):
        apply_surface_edits(result, edits)


def test_vessel_binding_checks_source_attachment_and_bakes_appearance() -> None:
    from viscera_core.atlas_material_bake import _bake_maps

    result, recipe, original = fixture()
    item = result["scene"]["organs"][0]
    network = {
        "version": "surface-vessels-design-1.0.0",
        "organ_id": "heart",
        "seed": 42,
        "provenance": "procedural-surface-design-not-patient-vasculature",
        "settings": {"density": 0.5, "visibility": 0.9, "radius_scale": 1.0},
        "segments": [
            {
                "a_mm": [10.0, 2.0, 0.0],
                "b_mm": [18.0, 10.0, 0.0],
                "normal": [0.0, 0.0, 1.0],
                "radius_a_mm": 0.8,
                "radius_b_mm": 0.4,
                "depth_mm": 0.2,
                "kind": 0,
                "a_anchor": {"triangle": 0, "weights": [0.5, 0.4, 0.1]},
                "b_anchor": {"triangle": 0, "weights": [0.1, 0.4, 0.5]},
            }
        ],
    }
    bind_surface_vessels(result, [{"organ_id": "heart", "network": network}])
    args = [
        np.array(item[k]).reshape(-1, 3)
        for k in ("rest_positions", "positions", "normals", "indices")
    ]
    baked = _bake_maps(*args, np.zeros(4), recipe, 128, vessel_network=network)
    assert baked["metadata"]["surface_vessels_baked"]
    assert np.any(baked["base_color"] != original["base_color"])
    assert np.any(baked["normal"] != original["normal"])
    assert np.any(baked["metallic_roughness"] != original["metallic_roughness"])
    for fault in ("point", "triangle"):
        invalid = copy.deepcopy(network)
        if fault == "point":
            invalid["segments"][0]["a_mm"][0] += 1
        else:
            invalid["segments"][0]["a_anchor"]["triangle"] = 10
        with pytest.raises(ValueError):
            bind_surface_vessels(result, [{"organ_id": "heart", "network": invalid}])


def test_api_unity_4096_passes_current_coordinates_to_exporter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from viscera_core import atlas_unity_export

    from services.api import atlas

    result, recipe, _ = fixture()
    spec = {
        "template_id": "heart",
        "template_sha256": "a" * 64,
        "realized_id": "b" * 64,
        "material": recipe.model_dump(),
    }
    result["spec"] = spec
    positions = np.array(result["scene"]["organs"][0]["positions"])
    positions[2::3] += 2
    monkeypatch.setattr(atlas, "realize", lambda *_: copy.deepcopy(result))
    calls = []

    def capture(scene: dict[str, Any], material: Any, resolution: int) -> bytes:
        calls.append((scene, resolution))
        return b"PK\x03\x04tested"

    monkeypatch.setattr(atlas_unity_export, "export_unity", capture)
    app = FastAPI()
    app.include_router(atlas.router)
    with TestClient(app) as client:
        response = client.post(
            "/api/atlas/export",
            json={
                "spec": spec,
                "format": "unity",
                "texture_resolution": 4096,
                "surface_edits": [{"organ_id": "heart", "positions": positions.tolist()}],
            },
        )
        assert response.status_code == 200, response.text
        assert response.headers["content-type"] == "application/zip"
        assert response.headers["content-disposition"].endswith('.unity.zip"')
        assert calls[0][1] == 4096
        assert calls[0][0]["scene"]["organs"][0]["positions"] == positions.tolist()
        assert (
            calls[0][0]["scene"]["organs"][0]["rest_positions"]
            == result["scene"]["organs"][0]["rest_positions"]
        )
        assert (
            client.post(
                "/api/atlas/export",
                json={"spec": spec, "format": "unity", "texture_resolution": 8192},
            ).status_code
            == 422
        )
        assert len(calls) == 1


def test_api_rejects_unbound_and_foreign_surface_edits_before_baking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from services.api import atlas

    result, recipe, _ = fixture()
    spec = {
        "template_id": "heart",
        "template_sha256": "a" * 64,
        "realized_id": "b" * 64,
        "material": recipe.model_dump(),
    }
    result["spec"] = spec
    monkeypatch.setattr(atlas, "realize", lambda *_: copy.deepcopy(result))
    app = FastAPI()
    app.include_router(atlas.router)
    with TestClient(app) as client:
        response = client.post(
            "/api/atlas/export",
            json={
                "spec": {"template_id": "heart", "material": recipe.model_dump()},
                "format": "unity",
            },
        )
        assert response.status_code == 422 and "bound spec" in response.json()["detail"]
        response = client.post(
            "/api/atlas/export",
            json={
                "spec": spec,
                "format": "unity",
                "surface_edits": [
                    {"organ_id": "foreign", "positions": result["scene"]["organs"][0]["positions"]}
                ],
            },
        )
        assert response.status_code == 422 and "unknown" in response.json()["detail"]
