"""Independent export checks: skewed deformations, mirrored UVs and work bounds."""

from __future__ import annotations

import json
import struct
import threading
from typing import Any

import numpy as np
import pytest
from viscera_core import atlas_material_bake as bake
from viscera_core.atlas_materials import make_recipe, sample_material


def _quad() -> tuple[Any, Any, Any, Any]:
    rest = np.array([[0.0, 0, 0], [12.0, 0, 0], [12.0, 12, 0], [0.0, 12, 0]])
    faces = np.array([[0, 1, 2], [0, 2, 3]])
    normals = np.tile([0.0, 0, 1], (4, 1))
    return rest, faces, normals, np.zeros(4)


@pytest.mark.parametrize("mirrored", [False, True])
def test_deformed_normal_map_matches_displaced_surface_cross_product(
    mirrored: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    rest, faces, _, regions = _quad()
    transform = np.array([[1.7, 0.4, 0.3], [0.2, 0.65, -0.1], [0.25, -0.35, 1.2]])
    positions = rest @ transform.T + [15.0, -9.0, 4.0]
    n = np.linalg.inv(transform).T @ [0.0, 0, 1]
    n /= np.linalg.norm(n)
    normals = np.tile(n, (4, 1))
    uv = np.array([[0.08, 0.1], [0.91, 0.18], [0.79, 0.91], [0.12, 0.79]])
    if mirrored:
        uv[:, 0] = 1 - uv[:, 0]
    monkeypatch.setattr(bake, "unwrap", lambda *args: (np.arange(4), faces, uv))
    recipe = make_recipe("pancreas", "rich", 271, fine_detail=1.0)
    maps = bake.bake_maps(rest, positions, normals, faces, regions, recipe, 256)
    for tri in faces:
        delta = uv[tri][1:] - uv[tri][:1]
        inv = np.linalg.inv(delta)
        dr = inv @ (rest[tri][1:] - rest[tri][:1])
        dp = inv @ (positions[tri][1:] - positions[tri][:1])
        footprint = np.max(np.linalg.norm(dr, axis=1)) / 256
        for chosen_bary in ([0.2, 0.3, 0.5], [0.6, 0.25, 0.15]):
            pixel = np.floor(np.array(chosen_bary) @ uv[tri] * 256).astype(int)
            ab = ((pixel + 0.5) / 256 - uv[tri[0]]) @ inv
            bary = np.r_[1 - ab.sum(), ab]
            fields = sample_material(recipe, (bary @ rest[tri])[None], footprint_mm=footprint)
            dh = fields.height_gradient_drest_mm[0] @ dr.T
            # Independent differential construction of P(u,v) + h(u,v) * n.
            expected = np.cross(dp[0] + dh[0] * n, dp[1] + dh[1] * n)
            expected *= np.sign(expected @ n)
            expected /= np.linalg.norm(expected)
            tangent = bary @ maps["tangents"][tri, :3]
            tangent -= n * (tangent @ n)
            tangent /= np.linalg.norm(tangent)
            bitangent = np.cross(n, tangent) * maps["tangents"][tri[0], 3]
            encoded = maps["normal"][pixel[1], pixel[0]] / 255 * 2 - 1
            reconstructed = tangent * encoded[0] + bitangent * encoded[1] + n * encoded[2]
            reconstructed /= np.linalg.norm(reconstructed)
            np.testing.assert_allclose(reconstructed, expected, atol=0.0069)
            np.testing.assert_allclose(
                maps["base_color"][pixel[1], pixel[0]] / 255,
                fields.rgb_srgb[0],
                atol=0.5 / 255 + 1e-8,
            )


def test_glb_uv_and_tangent_buffers_keep_baked_top_left_convention() -> None:
    rest, faces, normals, regions = _quad()
    recipe = make_recipe("heart", "rich", 72)
    maps = bake.bake_maps(rest, rest, normals, faces, regions, recipe, 128)
    result = {
        "spec": {},
        "scene": {
            "metadata": {},
            "organs": [
                {
                    "rest_positions": rest.reshape(-1).tolist(),
                    "positions": rest.reshape(-1).tolist(),
                    "normals": normals.reshape(-1).tolist(),
                    "indices": faces.reshape(-1).tolist(),
                    "material_regions": regions.tolist(),
                }
            ],
        },
    }
    binary = bake.export_material_glb(result, recipe, 128)
    length, kind = struct.unpack_from("<II", binary, 12)
    assert kind == 0x4E4F534A
    tree = json.loads(binary[20 : 20 + length])
    blob = binary[28 + length :]
    attrs = tree["meshes"][0]["primitives"][0]["attributes"]
    material = tree["materials"][0]
    assert (
        material["extensions"]["KHR_materials_clearcoat"]["clearcoatNormalTexture"]
        == material["normalTexture"]
    )

    def read_attribute(name: str, size: int) -> Any:
        accessor = tree["accessors"][attrs[name]]
        assert accessor["componentType"] == 5126
        view = tree["bufferViews"][accessor["bufferView"]]
        assert "byteStride" not in view
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return np.frombuffer(
            blob, dtype="<f4", count=size * accessor["count"], offset=offset
        ).reshape(-1, size)

    np.testing.assert_array_equal(read_attribute("TEXCOORD_0", 2), maps["uv"].astype(np.float32))
    np.testing.assert_array_equal(read_attribute("TANGENT", 4), maps["tangents"])
    tangent = read_attribute("TANGENT", 4)
    np.testing.assert_allclose(np.linalg.norm(tangent[:, :3], axis=1), 1, atol=1e-7)
    assert set(tangent[:, 3]) <= {-1.0, 1.0}


def test_unwrap_cache_is_bounded_read_only_and_keyed_by_rest_geometry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rest, faces, _, _ = _quad()
    calls = []

    def fake(points: Any, indices: Any, resolution: int) -> tuple[Any, Any, Any]:
        calls.append(resolution)
        return np.arange(4), indices.astype(np.int64), points[:, :2].astype(float) / 12

    monkeypatch.setattr(bake, "_unwrap_uncached", fake)
    monkeypatch.setattr(bake, "_UNWRAP_CACHE", bake.OrderedDict())
    monkeypatch.setattr(bake, "_UNWRAP_CACHE_MAX_ITEMS", 2)
    one = bake.unwrap(rest, faces, 128)
    assert bake.unwrap(rest.copy(), faces.copy(), 128) is one
    assert len(calls) == 1
    assert all(not a.flags.writeable for a in one)
    bake.unwrap(rest + [0, 0, 0.1], faces, 128)
    bake.unwrap(rest, faces, 256)
    assert len(bake._UNWRAP_CACHE) == 2
    bake.unwrap(rest, faces, 128)
    assert len(calls) == 4
    monkeypatch.setattr(bake, "_UNWRAP_CACHE_MAX_BYTES", 1)
    bake._UNWRAP_CACHE.clear()
    bake.unwrap(rest, faces, 128)
    assert not bake._UNWRAP_CACHE


def test_busy_bake_fails_without_allocating_or_unwrapping(monkeypatch: pytest.MonkeyPatch) -> None:
    entered = threading.Event()
    release = threading.Event()

    def hold_slot() -> None:
        with bake._bake_slot():
            entered.set()
            release.wait(timeout=5)

    worker = threading.Thread(target=hold_slot)
    worker.start()
    assert entered.wait(timeout=2)
    try:
        monkeypatch.setattr(bake, "unwrap", lambda *args: pytest.fail("busy bake must not unwrap"))
        rest, faces, normals, regions = _quad()
        with pytest.raises(bake.MaterialBakeBusyError, match="progress"):
            bake.bake_maps(rest, rest, normals, faces, regions, make_recipe("liver"), 128)
    finally:
        release.set()
        worker.join(timeout=2)
    assert not worker.is_alive()


def test_invalid_mesh_and_batch_work_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    rest, faces, normals, regions = _quad()
    recipe = make_recipe("liver")
    with pytest.raises(ValueError, match="integer"):
        bake.bake_maps(rest, rest, normals, faces.astype(float), regions, recipe, 128)
    with pytest.raises(ValueError, match="outside"):
        bake.bake_maps(rest, rest, normals, faces + 8, regions, recipe, 128)
    bad = rest.copy()
    bad[0, 0] = np.nan
    with pytest.raises(ValueError, match="finite"):
        bake.bake_maps(bad, rest, normals, faces, regions, recipe, 128)
    original = bake.sample_material
    batch_sizes = []

    def record(recipe: Any, positions: Any, **kwargs: Any) -> Any:
        batch_sizes.append(len(positions))
        return original(recipe, positions, **kwargs)

    monkeypatch.setattr(bake, "sample_material", record)
    monkeypatch.setattr(bake, "_FIELD_BATCH_SIZE", 128)
    result = bake.bake_maps(rest, rest, normals, faces, regions, recipe, 128)
    assert max(batch_sizes) <= 128
    assert len(batch_sizes) == result["metadata"]["field_evaluation_batches"]
    assert result["metadata"]["triangles_without_texel_center"] == 0


def test_mixed_tangent_signs_split_shading_seams_without_changing_triangles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rest, faces, normals, regions = _quad()
    normals[0] *= -1
    uv = np.array([[0.0717, 0.0967], [0.9139, 0.1721], [0.7813, 0.9161], [0.1177, 0.7931]])
    monkeypatch.setattr(bake, "unwrap", lambda *args: (np.arange(4), faces, uv))
    maps = bake.bake_maps(rest, rest, normals, faces, regions, make_recipe("liver"), 128)
    assert maps["metadata"]["tangent_handedness_seam_faces"] == 2
    assert maps["metadata"]["tangent_handedness_seam_vertices_added"] == 6
    np.testing.assert_array_equal(maps["mapping"][maps["faces"]], faces)
    assert (np.ptp(maps["tangents"][maps["faces"], 3], axis=1) == 0).all()


def test_collapsed_uv_face_gets_an_isolated_chart_without_geometry_loss(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rest = np.array([[0.0, 0, 0], [12, 0, 0], [0, 12, 0], [0, 0, 1], [0.001, 0, 1], [0, 0.001, 1]])
    faces = np.array([[0, 1, 2], [3, 4, 5]])
    normals = np.tile([0.0, 0, 1], (6, 1))
    uv = np.array([[0.1, 0.1], [0.4, 0.1], [0.1, 0.4], [0.7, 0.7], [0.7, 0.7], [0.7, 0.7]])
    raw = (np.arange(6), faces, uv)
    repaired = bake._repair_uv_charts(rest, raw, 128)
    assert repaired.metadata["fallback_face_indices"] == [1]
    np.testing.assert_array_equal(repaired.mapping[repaired.faces], faces)
    assert repaired.uv[repaired.faces[1], 0].min() > repaired.uv[repaired.faces[0], 0].max()
    for tri in repaired.uv[repaired.faces]:
        assert abs(np.linalg.det(tri[1:] - tri[:1])) > 1e-16
    monkeypatch.setattr(bake, "unwrap", lambda *args: repaired)
    maps = bake.bake_maps(rest, rest, normals, faces, np.zeros(6), make_recipe("heart"), 128)
    assert maps["metadata"]["uv_fallback"]["fallback_face_count"] == 1
    assert maps["metadata"]["triangles_without_texel_center"] == 0
    np.testing.assert_array_equal(rest[maps["mapping"][maps["faces"]]], rest[faces])


def test_singular_frame_uses_editor_cosine_guard_and_reports_omitted_micro_normals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rest, faces, normals, regions = _quad()
    # A pathological source shading normal lies in the face plane. The editor
    # keeps that normal; the exporter must not invent a surface-gradient inverse.
    normals[:] = [1, 0, 0]
    uv = np.array([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]])
    monkeypatch.setattr(bake, "unwrap", lambda *args: (np.arange(4), faces, uv))
    maps = bake.bake_maps(rest, rest, normals, faces, regions, make_recipe("heart"), 128)
    metadata = maps["metadata"]
    assert metadata["singular_frame_cosine_threshold"] == 1e-7
    assert metadata["singular_frame_micro_normal_omission_faces"] == [0, 1]
    assert metadata["singular_frame_micro_normal_omission_texels"] >= maps["coverage"].sum()
    assert metadata["cancelled_tangent_basis_fallback_vertices"] == 4
    assert np.all(maps["normal"][maps["coverage"]] == [128, 128, 255])
    assert np.isfinite(maps["tangents"]).all()
    np.testing.assert_array_equal(maps["mapping"][maps["faces"]], faces)
