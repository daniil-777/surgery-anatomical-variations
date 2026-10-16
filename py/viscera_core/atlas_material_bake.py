"""Bake the v2 rest-space material field into portable, geometry-preserving PBR maps.

UV chart seams duplicate vertices only. Explicit glTF tangents bind normal-map
orientation; maps sample the same field as the editor, with texel-footprint filtering.
"""

from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, cast

import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import distance_transform_edt

from .atlas_materials import MaterialRecipe, resolve_material, sample_material
from .atlas_surface_normals import NORMAL_FRAME_RELATIVE_THRESHOLD

BAKE_VERSION = "atlas-material-bake-2.0.0"
_BAKE_LOCK = threading.RLock()
_UNWRAP_LOCK = threading.Lock()
_UNWRAP_CACHE: OrderedDict[str, UnwrappedUV] = OrderedDict()
_UNWRAP_CACHE_MAX_BYTES = 96 * 1024 * 1024
_UNWRAP_CACHE_MAX_ITEMS = 4
_FIELD_BATCH_SIZE = 32768
SURFACE_FRAME_COSINE_EPSILON = NORMAL_FRAME_RELATIVE_THRESHOLD


@dataclass(frozen=True)
class UnwrappedUV:
    mapping: Any
    faces: Any
    uv: Any
    metadata: dict[str, Any]

    def __iter__(self) -> Iterator[Any]:
        # Preserve the simple mapping, faces, uv unpacking interface.
        yield self.mapping
        yield self.faces
        yield self.uv


class MaterialBakeBusyError(RuntimeError):
    """An existing CPU bake owns this process's bounded-memory work slot."""


@contextmanager
def _bake_slot() -> Iterator[None]:
    # FastAPI may dispatch many synchronous requests concurrently. A single 4K
    # atlas already holds several large images: do not multiply this by threads.
    if not _BAKE_LOCK.acquire(timeout=1.0):
        raise MaterialBakeBusyError("Another material export is in progress; retry shortly")
    try:
        yield
    finally:
        _BAKE_LOCK.release()


def _unit(v: Any) -> Any:
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-20)


def unwrap(rest: Any, faces: Any, resolution: int) -> UnwrappedUV:
    """Reuse the exact rest-space unwrap across recipes and shape variations.

    The cache holds read-only arrays, is bounded by both bytes and entries, and
    hashes the float32 coordinates actually consumed by xatlas.
    """
    points = np.ascontiguousarray(rest, dtype=np.float32)
    triangles = np.ascontiguousarray(faces, dtype=np.uint32)
    digest = hashlib.sha256(f"xatlas-0.0.11;pad8;bilinear;fallback-strip1;{resolution}".encode())
    for data in (points, triangles):
        digest.update(str(data.shape).encode())
        digest.update(data.tobytes())
    key = digest.hexdigest()
    with _UNWRAP_LOCK:
        cached = _UNWRAP_CACHE.get(key)
        if cached is not None:
            _UNWRAP_CACHE.move_to_end(key)
            return cached
    raw = _unwrap_uncached(points, triangles, resolution)
    result = _repair_uv_charts(np.asarray(rest, dtype=np.float64), raw, resolution)
    for array in result:
        array.setflags(write=False)
    result_bytes = sum(array.nbytes for array in result)
    if result_bytes <= _UNWRAP_CACHE_MAX_BYTES:
        with _UNWRAP_LOCK:
            _UNWRAP_CACHE[key] = result
            while (
                len(_UNWRAP_CACHE) > _UNWRAP_CACHE_MAX_ITEMS
                or sum(a.nbytes for entry in _UNWRAP_CACHE.values() for a in entry)
                > _UNWRAP_CACHE_MAX_BYTES
            ):
                _UNWRAP_CACHE.popitem(last=False)
    return result


def _repair_uv_charts(rest: Any, raw: tuple[Any, Any, Any], resolution: int) -> UnwrappedUV:
    mapping, triangles, uv = raw
    u = uv[triangles]
    det = np.linalg.det(u[:, 1:] - u[:, :1])
    invalid = np.flatnonzero(np.abs(det) < 1e-16)
    metadata: dict[str, Any] = {
        "policy": "explicit-degenerate-UV-face-strip-1.0.0",
        "fallback_face_count": len(invalid),
        "fallback_face_indices": invalid.tolist(),
        "geometry_modified": False,
    }
    if not len(invalid):
        return UnwrappedUV(mapping, triangles, uv, metadata)
    # xatlas can collapse a tiny, positive-area source face's UVs to one point.
    # Put only those faces into separate, padded face charts. Reserve a disjoint
    # strip by scaling the original UV atlas; never move or discard geometry.
    cell = 8
    rows = resolution // cell
    columns = (len(invalid) + rows - 1) // rows
    strip = columns * cell
    gap = 8
    available = resolution - strip - gap
    if available < resolution * 0.4:
        raise ValueError(
            f"{len(invalid)} source faces need explicit UV charts; use a higher texture resolution"
        )
    corners = triangles[invalid].reshape(-1)
    first = len(mapping)
    new_uv = np.empty((len(invalid), 3, 2), dtype=np.float64)
    for slot in range(len(invalid)):
        x = available + gap + (slot // rows) * cell
        y = (slot % rows) * cell
        # Three-pixel right triangles, 2.5-pixel inset, with a cell gutter.
        new_uv[slot] = (
            np.array([[x + 2.5, y + 2.5], [x + 5.5, y + 2.5], [x + 2.5, y + 5.5]]) / resolution
        )
    uv = uv.copy()
    uv[:, 0] *= available / resolution
    uv = np.concatenate((uv, new_uv.reshape(-1, 2)))
    mapping = np.concatenate((mapping, mapping[corners]))
    triangles = triangles.copy()
    triangles[invalid] = np.arange(first, len(mapping)).reshape(-1, 3)
    used, remapped = np.unique(triangles, return_inverse=True)
    unused_uv_vertices = len(mapping) - len(used)
    mapping, uv, triangles = mapping[used], uv[used], remapped.reshape(-1, 3)
    xyz = rest[mapping[triangles[invalid]]]
    area = np.linalg.norm(np.cross(xyz[:, 1] - xyz[:, 0], xyz[:, 2] - xyz[:, 0]), axis=1) * 0.5
    metadata.update(
        {
            "fallback_source_area_mm2_min_max": [float(area.min()), float(area.max())],
            "fallback_source_area_mm2_sum": float(area.sum()),
            "reserved_strip_texels": strip,
            "reserved_strip_fraction": strip / resolution,
            "original_atlas_minimum_width_fraction": 0.4,
            "unused_uv_vertices_removed": unused_uv_vertices,
            "strip_gap_texels": gap,
            "fallback_cell_texels": cell,
            "original_atlas_scale_u": available / resolution,
            "limitation": "Tiny source faces use isolated face charts; texture resolution does not increase anatomical geometry detail",
        }
    )
    return UnwrappedUV(mapping, triangles, uv, metadata)


def _unwrap_uncached(rest: Any, faces: Any, resolution: int) -> tuple[Any, Any, Any]:
    import xatlas

    atlas = xatlas.Atlas()
    atlas.add_mesh(np.asarray(rest, dtype=np.float32), np.asarray(faces, dtype=np.uint32))
    options = xatlas.PackOptions()
    options.resolution = resolution
    options.padding = 8
    options.bilinear = True
    atlas.generate(pack_options=options)
    if atlas.atlas_count != 1:
        raise ValueError("Material unwrap did not produce a single atlas")
    mapping, indices, uv = atlas[0]
    if not np.array_equal(mapping[indices], faces):
        raise ValueError("UV unwrap changed triangle identity or winding")
    return mapping, indices.astype(np.int64), uv.astype(np.float64)


def bake_maps(
    rest: Any,
    positions: Any,
    normals: Any,
    faces: Any,
    regions: Any,
    recipe: MaterialRecipe,
    resolution: int = 2048,
) -> dict[str, Any]:
    with _bake_slot():
        return _bake_maps(rest, positions, normals, faces, regions, recipe, resolution)


def _bake_maps(
    rest: Any,
    positions: Any,
    normals: Any,
    faces: Any,
    regions: Any,
    recipe: MaterialRecipe,
    resolution: int,
    disease_field: dict[str, Any] | None = None,
    vessel_network: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if isinstance(resolution, bool) or resolution not in (128, 256, 512, 1024, 2048, 4096):
        raise ValueError("Unsupported material bake resolution")
    rest, positions, normals = [np.asarray(a, dtype=np.float64) for a in (rest, positions, normals)]
    raw_faces = np.asarray(faces)
    if raw_faces.dtype.kind not in "iu":
        raise ValueError("Material faces must contain integer vertex indices")
    faces = raw_faces.astype(np.int64)
    regions = np.asarray(regions, dtype=np.float64)
    if (
        rest.ndim != 2
        or rest.shape[1] != 3
        or len(rest) < 3
        or positions.shape != rest.shape
        or normals.shape != rest.shape
        or faces.ndim != 2
        or faces.shape[1] != 3
        or len(faces) == 0
        or regions.shape != (len(rest),)
    ):
        raise ValueError("Invalid material mesh array dimensions")
    if not all(np.isfinite(a).all() for a in (rest, positions, normals, regions)):
        raise ValueError("Material mesh arrays must be finite")
    if faces.min() < 0 or faces.max() >= len(rest):
        raise ValueError("Material face index is outside the vertex array")
    # Source-preserving cleanup retains unused vertices after zero-area faces are
    # removed. Their display normals may legitimately be zero; xatlas drops them.
    used = np.unique(faces)
    if np.any((regions < 0) | (regions > 1)) or np.any(
        np.linalg.norm(normals[used], axis=1) < 1e-12
    ):
        raise ValueError("Invalid material region weights or zero normals")
    normals = _unit(normals)
    unwrapped = unwrap(rest, faces, resolution)
    mapping, triangles, uv = unwrapped
    uv_fallback = getattr(unwrapped, "metadata", {})
    p, r, n = positions[mapping], rest[mapping], normals[mapping]
    uv_tri = uv[triangles]
    delta = uv_tri[:, 1:] - uv_tri[:, :1]
    det = delta[:, 0, 0] * delta[:, 1, 1] - delta[:, 0, 1] * delta[:, 1, 0]
    if np.any(np.abs(det) < 1e-16):
        raise ValueError("Degenerate UV triangle in material export")
    inverse = np.linalg.inv(delta)
    # UV rows hold du,dv; solve [du,dv] @ [dP/du,dP/dv] = edge vectors.
    dp = np.einsum("fij,fjk->fik", inverse, p[triangles[:, 1:]] - p[triangles[:, :1]])
    dr = np.einsum("fij,fjk->fik", inverse, r[triangles[:, 1:]] - r[triangles[:, :1]])
    t_sum = np.zeros_like(p)
    b_sum = np.zeros_like(p)
    weights = np.linalg.norm(
        np.cross(p[triangles[:, 1]] - p[triangles[:, 0]], p[triangles[:, 2]] - p[triangles[:, 0]]),
        axis=1,
    )
    if np.any(weights <= 1e-18):
        raise ValueError("Degenerate geometry triangle in material export")
    for corner in range(3):
        np.add.at(t_sum, triangles[:, corner], dp[:, 0] * weights[:, None])
        np.add.at(b_sum, triangles[:, corner], dp[:, 1] * weights[:, None])
    tangents = _unit(t_sum - n * np.sum(t_sum * n, axis=1, keepdims=True))
    tangent_fallback = np.flatnonzero(np.linalg.norm(tangents, axis=1) < 0.99)
    if len(tangent_fallback):
        # A valid normal map can use any explicit orthonormal tangent basis, as
        # long as the bake and exported TANGENT use the identical basis. Tiny
        # overlapping source faces may cancel UV tangents exactly; choose a
        # deterministic least-aligned axis rather than emit a zero TANGENT.
        axis = np.eye(3)[np.argmin(np.abs(n[tangent_fallback]), axis=1)]
        tangents[tangent_fallback] = _unit(np.cross(axis, n[tangent_fallback]))
    handedness = np.where(np.sum(np.cross(n, tangents) * b_sum, axis=1) < 0, -1.0, 1.0)
    if np.any(np.linalg.norm(tangents, axis=1) < 0.99):
        raise ValueError("Degenerate tangent frame in material export")
    mixed_handedness = np.flatnonzero(np.ptp(handedness[triangles], axis=1) != 0)
    if len(mixed_handedness):
        # glTF leaves interpolation of opposite tangent.w signs undefined.
        # Split only those triangle corners, retaining their exact position,
        # normal and UV. Either constant sign is a valid orthonormal basis when
        # the normal map is baked in that same basis; use the majority sign.
        corners = triangles[mixed_handedness].reshape(-1)
        face_sign = np.where(handedness[triangles[mixed_handedness]].sum(axis=1) < 0, -1.0, 1.0)
        first = len(mapping)
        mapping = np.concatenate((mapping, mapping[corners]))
        uv = np.concatenate((uv, uv[corners]))
        p, r, n = [np.concatenate((a, a[corners])) for a in (p, r, n)]
        tangents = np.concatenate((tangents, tangents[corners]))
        handedness = np.concatenate((handedness, np.repeat(face_sign, 3)))
        triangles = triangles.copy()
        triangles[mixed_handedness] = np.arange(first, len(mapping)).reshape(-1, 3)
    del t_sum, b_sum
    size = resolution
    base = np.zeros((size, size, 3), dtype=np.uint8)
    orm = np.zeros_like(base)
    normal_map = np.zeros_like(base)
    covered = np.zeros((size, size), dtype=bool)
    face_texels = np.zeros(len(triangles), dtype=np.int64)
    footprints: list[float] = []
    pending_pixels: list[Any] = []
    pending_bary: list[Any] = []
    pending_faces: list[Any] = []
    pending_count = 0
    field_batches = 0
    singular_frame_texels = 0
    singular_frame_faces: set[int] = set()

    def flush() -> None:
        nonlocal pending_count, field_batches, singular_frame_texels
        if not pending_count:
            return
        pixel = np.concatenate(pending_pixels)
        bary = np.concatenate(pending_bary)
        ids = np.concatenate(pending_faces)
        tris = triangles[ids]
        rp = np.einsum("ni,nij->nj", bary, r[tris])
        region = np.einsum("ni,ni->n", bary, regions[mapping[tris]])
        footprint = np.max(np.linalg.norm(dr[ids], axis=2), axis=1) / size
        fields = sample_material(recipe, rp, region_ids=region, footprint_mm=footprint)
        rgb = fields["rgb_srgb"]
        roughness = fields["roughness"]
        height_gradient = fields["height_gradient_drest_mm"]
        if disease_field is not None:
            from .atlas_disease import apply_disease_color

            rgb = apply_disease_color(rgb, rp, disease_field)
        if vessel_network is not None:
            from .atlas_surface_vessels import apply_vessel_appearance

            rest_tri = r[tris]
            rest_normal = _unit(
                np.cross(rest_tri[:, 1] - rest_tri[:, 0], rest_tri[:, 2] - rest_tri[:, 0])
            )
            linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
            linear, roughness, _height, vessel_gradient = apply_vessel_appearance(
                linear,
                roughness,
                rp,
                rest_normal,
                vessel_network,
                footprint_mm=footprint,
            )
            rgb = np.where(
                linear <= 0.0031308,
                linear * 12.92,
                1.055 * np.maximum(linear, 0) ** (1 / 2.4) - 0.055,
            )
            height_gradient = height_gradient + vessel_gradient
        nn = _unit(np.einsum("ni,nij->nj", bary, n[tris]))
        tt = np.einsum("ni,nij->nj", bary, tangents[tris])
        tt = _unit(tt - nn * np.sum(tt * nn, axis=1, keepdims=True))
        if np.any(np.linalg.norm(nn, axis=1) < 0.99) or np.any(np.linalg.norm(tt, axis=1) < 0.99):
            raise ValueError("Degenerate interpolated normal/tangent frame in material export")
        sign = np.where(np.einsum("ni,ni->n", bary, handedness[tris]) < 0, -1.0, 1.0)
        bb = np.cross(nn, tt) * sign[:, None]
        dh = np.einsum("ni,nji->nj", height_gradient, dr[ids])
        reciprocal_u = np.cross(dp[ids, 1], nn)
        reciprocal_v = np.cross(nn, dp[ids, 0])
        determinant = np.sum(dp[ids, 0] * reciprocal_u, axis=1)
        frame_area = np.linalg.norm(np.cross(dp[ids, 0], dp[ids, 1]), axis=1)
        # Match the editor's scale-invariant singular-frame guard. No finite
        # tangent gradient is defined when the shading normal lies in the face
        # plane. Retain that source normal, omit micro-bump at these texels, and
        # report every affected face rather than fabricate an inverse.
        singular = np.abs(determinant) <= frame_area * SURFACE_FRAME_COSINE_EPSILON
        singular_frame_texels += int(singular.sum())
        singular_frame_faces.update(int(face) for face in np.unique(ids[singular]))
        surface_gradient = np.zeros_like(nn)
        np.divide(
            reciprocal_u * dh[:, :1] + reciprocal_v * dh[:, 1:],
            determinant[:, None],
            out=surface_gradient,
            where=~singular[:, None],
        )
        perturbed = _unit(nn - surface_gradient)
        tangent_normal = np.column_stack(
            (
                np.sum(perturbed * tt, axis=1),
                np.sum(perturbed * bb, axis=1),
                np.sum(perturbed * nn, axis=1),
            )
        )
        yy, xx = pixel[:, 1], pixel[:, 0]
        base[yy, xx] = np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
        orm[yy, xx, 0] = 255  # no baked occlusion
        orm[yy, xx, 1] = np.rint(np.clip(roughness, 0, 1) * 255).astype(np.uint8)
        normal_map[yy, xx] = np.rint(np.clip(tangent_normal * 0.5 + 0.5, 0, 1) * 255).astype(
            np.uint8
        )
        covered[yy, xx] = True
        field_batches += 1
        pending_pixels.clear()
        pending_bary.clear()
        pending_faces.clear()
        pending_count = 0

    # Rasterization is independent of lighting and deformed surface colour.
    # Tile large triangle boxes and batch accepted texels across small triangles:
    # no per-triangle procedural-noise call and no full-atlas float raster buffer.
    for face_id, _tri in enumerate(triangles):
        q = uv_tri[face_id] * size - 0.5
        lo = np.maximum(np.ceil(q.min(axis=0)).astype(int), 0)
        hi = np.minimum(np.floor(q.max(axis=0)).astype(int), size - 1)
        if np.any(hi < lo):
            continue
        width = int(hi[0] - lo[0] + 1)
        rows_per_tile = max(1, _FIELD_BATCH_SIZE // width)
        footprint = float(np.max(np.linalg.norm(dr[face_id], axis=1)) / size)
        for y0 in range(int(lo[1]), int(hi[1]) + 1, rows_per_tile):
            x, y = np.meshgrid(
                np.arange(lo[0], hi[0] + 1), np.arange(y0, min(y0 + rows_per_tile, hi[1] + 1))
            )
            pixel = np.column_stack((x.ravel(), y.ravel()))
            ab = ((pixel + 0.5) / size - uv_tri[face_id, 0]) @ inverse[face_id]
            bary = np.column_stack((1 - ab.sum(axis=1), ab))
            inside = np.all(bary >= -1e-8, axis=1)
            if not inside.any():
                continue
            pixel, bary = pixel[inside], bary[inside]
            if pending_count + len(pixel) > _FIELD_BATCH_SIZE:
                flush()
            pending_pixels.append(pixel)
            pending_bary.append(bary)
            pending_faces.append(np.full(len(pixel), face_id, dtype=np.int64))
            pending_count += len(pixel)
            face_texels[face_id] += len(pixel)
            if pending_count >= _FIELD_BATCH_SIZE or len(pending_pixels) >= 2048:
                flush()
        if face_texels[face_id]:
            footprints.append(footprint)
    flush()
    if not covered.any():
        raise ValueError("UV atlas contains no rasterized surface")
    # Extend colour/roughness/normal into chart gutters for bilinear and mip sampling.
    nearest = distance_transform_edt(~covered, return_distances=False, return_indices=True)
    for target in (base, orm, normal_map):
        target[~covered] = target[nearest[0][~covered], nearest[1][~covered]]
    metadata = {
        "version": BAKE_VERSION,
        "field_evaluation_batches": field_batches,
        "field_batch_max_texels": _FIELD_BATCH_SIZE,
        "concurrency": "one bake per process; busy requests fail after 1 second",
        "resolution": [size, size],
        "uv_unwrapper": "xatlas-0.0.11",
        "uv_fallback": uv_fallback,
        "padding_requested_texels": 8,
        "covered_texels": int(covered.sum()),
        "coverage_fraction": float(covered.mean()),
        "triangles_without_texel_center": int(np.sum(face_texels == 0)),
        "texel_footprint_mm_p50_p95_max": np.percentile(footprints, [50, 95, 100]).tolist(),
        "normal_convention": "glTF tangent-space +Y; explicit TANGENT attribute",
        "geometry_policy": "UV/tangent seam vertex duplication only; triangle positions/winding preserved",
        "tangent_handedness_seam_faces": len(mixed_handedness),
        "tangent_handedness_seam_vertices_added": len(mixed_handedness) * 3,
        "cancelled_tangent_basis_fallback_vertices": len(tangent_fallback),
        "singular_frame_cosine_threshold": SURFACE_FRAME_COSINE_EPSILON,
        "singular_frame_micro_normal_omission_texels": singular_frame_texels,
        "singular_frame_micro_normal_omission_faces": sorted(singular_frame_faces),
        "singular_frame_policy": "same as editor: keep source normal, omit undefined micro-normal; no source topology/detail repair",
        "base_color_encoding": "sRGB uint8",
        "surface_vessels_baked": vessel_network is not None,
        "metallic_roughness_encoding": "linear G roughness/B=0",
        "filtering": "rest-mm texel-footprint field filtering; nearest-surface chart gutters",
        "maps_sha256": {
            key: hashlib.sha256(value.tobytes()).hexdigest()
            for key, value in (
                ("base_color", base),
                ("metallic_roughness", orm),
                ("normal", normal_map),
            )
        },
    }
    return {
        "mapping": mapping,
        "faces": triangles,
        "uv": uv,
        "tangents": np.column_stack((tangents, handedness)).astype(np.float32),
        "base_color": base,
        "metallic_roughness": orm,
        "normal": normal_map,
        "coverage": covered,
        "metadata": metadata,
    }


def export_material_glb(
    result: dict[str, Any], recipe: MaterialRecipe, resolution: int = 2048
) -> bytes:
    with _bake_slot():
        return _export_material_glb(result, recipe, resolution)


def _export_material_glb(result: dict[str, Any], recipe: MaterialRecipe, resolution: int) -> bytes:
    item = result["scene"]["organs"][0]
    rest, positions, normals = [
        np.asarray(item[k]).reshape(-1, 3) for k in ("rest_positions", "positions", "normals")
    ]
    normals = _unit(normals)
    faces = np.asarray(item["indices"]).reshape(-1, 3)
    baked = _bake_maps(
        rest,
        positions,
        normals,
        faces,
        item["material_regions"],
        recipe,
        resolution,
        disease_field=item.get("metadata", {}).get("disease_field"),
        vessel_network=item.get("metadata", {}).get("surface_vessels"),
    )
    mapping = baked["mapping"]
    mesh = trimesh.Trimesh(
        vertices=positions[mapping] / 1000,
        faces=baked["faces"],
        vertex_normals=normals[mapping],
        process=False,
    )
    # Trimesh flips V on glTF export; supply the inverse to retain our top-left atlas UVs.
    uv = baked["uv"].copy()
    uv[:, 1] = 1 - uv[:, 1]
    material = cast(Any, trimesh.visual.material.PBRMaterial)(
        name="Atlas organ material v2",
        baseColorFactor=[255, 255, 255, 255],
        baseColorTexture=Image.fromarray(baked["base_color"]),
        metallicRoughnessTexture=Image.fromarray(baked["metallic_roughness"]),
        normalTexture=Image.fromarray(baked["normal"]),
        metallicFactor=0.0,
        roughnessFactor=1.0,
        doubleSided=True,
    )
    mesh.visual = cast(Any, trimesh.visual.TextureVisuals)(uv=uv, material=material)
    mesh.vertex_attributes["TANGENT"] = baked["tangents"]
    scene = trimesh.Scene(mesh)
    scene.metadata.update(result["scene"]["metadata"])
    scene.metadata.update(
        {
            "spec": result["spec"],
            "unit": "m",
            "source_unit": "mm",
            "coordinate_frame": "glTF-Y-up",
            "material_bake": baked["metadata"],
            "export_scope": "visual_surface_not_simulation_domain",
        }
    )
    resolved = resolve_material(recipe)

    def finish(tree: dict[str, Any]) -> None:
        for m in tree["meshes"]:
            for primitive in m["primitives"]:
                attrs = primitive["attributes"]
                attrs["TANGENT"] = attrs.pop("_TANGENT")
        tree.setdefault("extensionsUsed", []).append("KHR_materials_clearcoat")
        for m in tree["materials"]:
            m.setdefault("extensions", {})["KHR_materials_clearcoat"] = {
                "clearcoatFactor": resolved["clearcoat"],
                "clearcoatRoughnessFactor": resolved["clearcoat_roughness"],
                "clearcoatNormalTexture": dict(m["normalTexture"]),
            }

    return cast(
        bytes, cast(Any, trimesh.exchange.gltf.export_glb)(scene, tree_postprocessor=finish)
    )
