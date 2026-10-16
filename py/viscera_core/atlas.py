"""Versioned atlas surfaces and conservative, reversible shape design in millimetres.

Source meshes remain untouched. This module preserves selected component connectivity;
its output is an anatomical *display surface*, not a watertight simulation domain or a
sample from a measured population. The seven-control map is globally invertible in
continuous space. That does not certify source surfaces or discrete triangle collisions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

import numpy as np
import numpy.typing as npt
import trimesh

FloatArray = npt.NDArray[np.float64]
IntArray = npt.NDArray[np.int64]
Json = dict[str, Any]
TEMPLATE_VERSION = "atlas-display-1.1.0"
SUPPORTED_TEMPLATE_VERSIONS = {"atlas-display-1.0.0", TEMPLATE_VERSION}
DEFORMER_VERSION = "invertible-atlas-controls-1.0.0"
CONTROL_NAMES = ("scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry")
# Engineering design envelopes, NOT human population reference intervals.
CONTROL_LIMITS = {
    "liver": (0.10, 0.09, 0.10, 0.06, 0.09, 0.07, 0.04),
    "kidney": (0.08, 0.10, 0.08, 0.05, 0.08, 0.06, 0.04),
    "spleen": (0.10, 0.10, 0.08, 0.06, 0.10, 0.07, 0.04),
    "pancreas": (0.08, 0.08, 0.08, 0.05, 0.07, 0.05, 0.03),
    "stomach": (0.10, 0.10, 0.10, 0.06, 0.09, 0.07, 0.04),
    "gallbladder": (0.09, 0.12, 0.09, 0.06, 0.10, 0.08, 0.04),
    "small-intestine": (0.06, 0.06, 0.06, 0.035, 0.04, 0.035, 0.025),
    "large-intestine": (0.07, 0.07, 0.07, 0.04, 0.05, 0.04, 0.025),
    "heart": (0.06, 0.06, 0.06, 0.035, 0.05, 0.035, 0.025),
    "lung": (0.07, 0.07, 0.07, 0.035, 0.04, 0.035, 0.025),
    "brain": (0.035, 0.035, 0.035, 0.015, 0.02, 0.02, 0.01),
    "urinary-bladder": (0.09, 0.09, 0.09, 0.045, 0.06, 0.05, 0.03),
}
HRA_ORGANS = {key.replace("-", " ").title(): key for key in CONTROL_LIMITS}
HRA_ORGANS.pop("Stomach")
HRA_ORGANS.pop("Gallbladder")


@dataclass(frozen=True)
class AtlasTemplate:
    """Selected source components in a centered, explicitly declared authoring frame."""

    vertices_mm: FloatArray
    faces: IntArray
    colors: FloatArray
    component_ids: IntArray  # one ID per vertex; components never silently welded
    metadata: Json
    _cache: Json = field(default_factory=dict, compare=False, repr=False)


@dataclass(frozen=True)
class AtlasSample:
    """Realized geometry plus measurements and scoped numerical evidence."""

    vertices_mm: FloatArray
    faces: IntArray
    colors: FloatArray
    component_ids: IntArray
    controls: Json
    measurements: Json
    qa: Json
    metadata: Json


def _digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _json_write(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def _geometry_hash(vertices: FloatArray, faces: IntArray) -> str:
    digest = hashlib.sha256()
    digest.update(np.asarray(vertices, dtype="<f8").tobytes())
    digest.update(np.asarray(faces, dtype="<i8").tobytes())
    return digest.hexdigest()


def _validate_arrays(vertices: FloatArray, faces: IntArray) -> None:
    if vertices.ndim != 2 or vertices.shape[1] != 3 or len(vertices) < 3:
        raise ValueError("vertices_mm must be a nonempty N by 3 array")
    if faces.ndim != 2 or faces.shape[1] != 3 or len(faces) < 1:
        raise ValueError("faces must be a nonempty M by 3 triangle array")
    if not np.isfinite(vertices).all() or faces.min() < 0 or faces.max() >= len(vertices):
        raise ValueError("Mesh contains nonfinite coordinates or invalid triangle indices")
    if np.ptp(vertices, axis=0).max() <= 0:
        raise ValueError("Template must have nonzero extent")


def _readonly(array: npt.NDArray[Any]) -> None:
    array.setflags(write=False)


def _validate_controls(controls: Mapping[str, float] | Sequence[float] | FloatArray) -> FloatArray:
    if isinstance(controls, Mapping):
        unknown = set(controls) - set(CONTROL_NAMES)
        if unknown:
            raise ValueError(f"Unknown atlas controls: {sorted(unknown)}")
        result = np.asarray([controls.get(key, 0.0) for key in CONTROL_NAMES], dtype=np.float64)
    else:
        result = np.asarray(controls, dtype=np.float64)
    if result.shape != (7,) or not np.isfinite(result).all() or np.abs(result).max() > 1:
        raise ValueError("Atlas controls must be seven finite values in [-1, 1]")
    return result


def _validate_limits(limits: Sequence[float] | FloatArray) -> FloatArray:
    result = np.asarray(limits, dtype=np.float64)
    if result.shape != (7,) or not np.isfinite(result).all() or (result < 0).any():
        raise ValueError("Control limits must be seven finite nonnegative coefficients")
    if result.max() > 0.25:
        raise ValueError("Control limits exceed this version's conservative design envelope")
    return result


def deform_vertices(
    vertices_mm: FloatArray,
    controls: Mapping[str, float] | Sequence[float] | FloatArray,
    limits: Sequence[float] | FloatArray,
    normalization_mm: float,
    *,
    inverse: bool = False,
) -> FloatArray:
    """Apply/invert the v1 smooth bijection; normalization must be from the template.

    Scale -> z-conditioned positive xy taper -> z-conditioned xy twist -> x bend
    shear -> z asymmetry shear. All stages have explicit inverses. No randomness,
    remeshing, smoothing, feature removal or organ-specific anatomical relabeling.
    """
    c = _validate_controls(controls) * _validate_limits(limits)
    if not math.isfinite(normalization_mm) or normalization_mm <= 0:
        raise ValueError("normalization_mm must be positive and finite")
    raw = np.asarray(vertices_mm, dtype=np.float64)
    if not np.any(c):
        if raw.ndim != 2 or raw.shape[1] != 3 or not np.isfinite(raw).all():
            raise ValueError("Coordinates must be a finite N by 3 array")
        return raw.copy()
    q = raw.copy() / normalization_mm
    if q.ndim != 2 or q.shape[1] != 3 or not np.isfinite(q).all():
        raise ValueError("Coordinates must be a finite N by 3 array")
    if inverse:
        q[:, 2] -= c[6] * np.tanh(q[:, 0])
        q[:, 0] -= c[3] * np.tanh(q[:, 2]) ** 2
    else:
        q *= np.exp(c[:3])
        q[:, :2] *= np.exp(c[5] * np.tanh(q[:, 2]))[:, None]
    angle = c[4] * np.tanh(q[:, 2]) * (-1 if inverse else 1)
    cs, sn = np.cos(angle), np.sin(angle)
    x, y = q[:, 0].copy(), q[:, 1].copy()
    q[:, 0], q[:, 1] = cs * x - sn * y, sn * x + cs * y
    if inverse:
        q[:, :2] /= np.exp(c[5] * np.tanh(q[:, 2]))[:, None]
        q /= np.exp(c[:3])
    else:
        q[:, 0] += c[3] * np.tanh(q[:, 2]) ** 2
        q[:, 2] += c[6] * np.tanh(q[:, 0])
    return q * normalization_mm


def jacobian_determinants(
    vertices_mm: FloatArray,
    controls: Mapping[str, float] | Sequence[float] | FloatArray,
    limits: Sequence[float] | FloatArray,
    normalization_mm: float,
) -> FloatArray:
    """Exact determinant of the continuous composition at source positions."""
    c = _validate_controls(controls) * _validate_limits(limits)
    if not math.isfinite(normalization_mm) or normalization_mm <= 0:
        raise ValueError("normalization_mm must be positive and finite")
    z_scaled = np.asarray(vertices_mm)[:, 2] / normalization_mm * np.exp(c[2])
    return np.asarray(np.exp(c[:3].sum() + 2 * c[5] * np.tanh(z_scaled)), dtype=np.float64)


def _crosses(vertices: FloatArray, faces: IntArray) -> FloatArray:
    triangles = vertices[faces]
    return np.asarray(np.cross(triangles[:, 1] - triangles[:, 0],
                               triangles[:, 2] - triangles[:, 0]), dtype=np.float64)


def _topology_audit(vertices: FloatArray, faces: IntArray) -> Json:
    """Weld an audit copy only; the delivered mesh indexing remains unmodified."""
    mesh = trimesh.Trimesh(vertices=vertices.copy(), faces=faces.copy(), process=False)
    mesh.merge_vertices(digits_vertex=8)
    edge_counts = np.bincount(mesh.edges_unique_inverse)
    areas = np.linalg.norm(_crosses(vertices, faces), axis=1) / 2
    return {
        "method": "trimesh-geometric-weld-audit-copy-1.0",
        "weld_precision_mm": 1e-8,
        "watertight_after_audit_weld": bool(mesh.is_watertight),
        "winding_consistent_after_audit_weld": bool(mesh.is_winding_consistent),
        "boundary_edges_after_audit_weld": int(np.count_nonzero(edge_counts == 1)),
        "nonmanifold_edges_after_audit_weld": int(np.count_nonzero(edge_counts > 2)),
        "degenerate_faces": int(np.count_nonzero(areas <= 1e-12)),
        "zero_length_edges": int(np.count_nonzero(mesh.edges_unique_length <= 1e-9)),
        "connected_vertex_components": int(mesh.body_count),
        "self_intersection": {"status": "NOT_RUN", "reason": "No robust intersection backend"},
        "simulation_readiness": {"status": "NOT_RUN", "reason": "No volumetric domain/materials"},
    }


def _prepare_cache(template: AtlasTemplate) -> Json:
    if not template._cache:
        cross = _crosses(template.vertices_mm, template.faces)
        # All triangle edges, with multiplicity, avoid O(M log M) unique sorting per instance.
        edges = template.faces[:, (0, 1, 1, 2, 2, 0)].reshape(-1, 2)
        lengths = np.linalg.norm(template.vertices_mm[edges[:, 0]] -
                                 template.vertices_mm[edges[:, 1]], axis=1)
        template._cache.update(cross=cross, area2=np.linalg.norm(cross, axis=1),
                               edges=edges, edge_lengths=lengths)
    return template._cache


def generate(
    template: AtlasTemplate,
    controls: Mapping[str, float] | Sequence[float] | FloatArray,
    seed: int = 0,
) -> AtlasSample:
    """Generate one deterministic design variation with truthful preview-only QA.

    Seed is recorded for lineage; explicit controls fully determine this shape. Source
    pre-existing defects are reported, not hidden or silently repaired by generation.
    """
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**63:
        raise ValueError("seed must be an integer in [0, 2**63)")
    c = _validate_controls(controls)
    limits = _validate_limits(template.metadata["control_limits"])
    norm = float(template.metadata["normalization_mm"])
    vertices = deform_vertices(template.vertices_mm, c, limits, norm)
    jac = jacobian_determinants(template.vertices_mm, c, limits, norm)
    cache = _prepare_cache(template)
    crosses = _crosses(vertices, template.faces)
    areas2 = np.linalg.norm(crosses, axis=1)
    valid_faces = cache["area2"] > 2e-12
    area_ratios = areas2[valid_faces] / cache["area2"][valid_faces]
    dots = np.einsum("ij,ij->i", crosses[valid_faces], cache["cross"][valid_faces])
    dots /= np.maximum(areas2[valid_faces] * cache["area2"][valid_faces], 1e-300)
    edges = cache["edges"]
    edge_lengths = np.linalg.norm(vertices[edges[:, 0]] - vertices[edges[:, 1]], axis=1)
    valid_edges = cache["edge_lengths"] > 1e-9
    edge_ratios = edge_lengths[valid_edges] / cache["edge_lengths"][valid_edges]
    finite = bool(np.isfinite(vertices).all())
    new_degenerate = int(np.count_nonzero(valid_faces & (areas2 <= 2e-12)))
    normal_turns = int(np.count_nonzero(dots <= 0))
    passed = bool(finite and jac.min() > 0 and new_degenerate == 0 and normal_turns == 0
                  and edge_ratios.min() > 0.65 and edge_ratios.max() < 1.55
                  and area_ratios.min() > 0.5 and area_ratios.max() < 2.0)
    extent = np.ptp(vertices, axis=0)
    area = float(areas2.sum() / 2)
    # All imported assets are annotated display surfaces, often thin capsules/open
    # patches or internal interfaces. Their signed volume is NOT an organ envelope.
    measurements = {
        "extent_x_mm": float(extent[0]), "extent_y_mm": float(extent[1]),
        "extent_z_mm": float(extent[2]), "surface_area_mm2": area,
        "volume_ml": None, "compactness": None,
        "volume_status": "NOT_APPLICABLE",
        "volume_reason": "Display surface assembly is not a certified closed outer envelope",
        "surface_area_definition": "Sum of selected triangles including capsule/internal faces",
        "method": "atlas-triangle-measurements-1.0.0",
    }
    qa = {
        "passed": passed, "status": "PASS" if passed else "FAIL",
        "scope": "bounded deformation of the selected source display surfaces",
        "finite": finite, "min_jacobian": float(jac.min()), "max_jacobian": float(jac.max()),
        "new_degenerate_faces": new_degenerate, "normal_turns_over_90_degrees": normal_turns,
        "min_normal_dot": float(dots.min()),
        "edge_ratio_min": float(edge_ratios.min()), "edge_ratio_max": float(edge_ratios.max()),
        "area_ratio_min": float(area_ratios.min()), "area_ratio_max": float(area_ratios.max()),
        "topology_preserved": True,
        "source_topology": template.metadata.get("topology_audit", {}),
        "self_intersection": {"status": "NOT_RUN", "reason": "Continuous bijection does not certify discrete/source intersections"},
        "anatomical_plausibility": {"status": "NOT_RUN", "reason": "Requires independent anatomical review"},
        "mechanical_validation": {"status": "NOT_RUN", "reason": "No volumetric mechanics in this surface track"},
        "volume_ratio": None,
    }
    metadata = {
        "template_id": template.metadata["template_id"],
        "template_version": template.metadata.get("template_version", TEMPLATE_VERSION), "deformer_version": DEFORMER_VERSION,
        "source_geometry_sha256": template.metadata["geometry_sha256"],
        "geometry_sha256": _geometry_hash(vertices, template.faces),
        "seed": seed, "seed_shape_role": "none: explicit controls determine shape",
        "coordinate_frame": template.metadata["coordinate_frame"], "unit": "mm",
        "evidence_kind": "procedural", "profile": "development_preview",
        "review_status": "unreviewed", "variation_kind": "bounded_morphological_design_heuristic",
    }
    _readonly(vertices)
    return AtlasSample(vertices, template.faces, template.colors, template.component_ids,
                       dict(zip(CONTROL_NAMES, c.tolist(), strict=True)), measurements, qa, metadata)


def list_templates(template_dir: str | Path) -> list[Json]:
    """Read the portable catalog; returned IDs bind immutable source/version metadata."""
    catalog: Json = json.loads((Path(template_dir) / "catalog.json").read_text())
    return list(catalog["templates"])


def load_template(template_dir: str | Path, template_id: str) -> AtlasTemplate:
    """Load and hash-check a portable template; no source-library access is needed."""
    if not template_id or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in template_id):
        raise ValueError("Invalid template ID")
    root = Path(template_dir)
    metadata_path = root / f"{template_id}.json"
    meta: Json = json.loads(metadata_path.read_text())
    catalog_path = root / "catalog.json"
    if catalog_path.exists():
        records = json.loads(catalog_path.read_text())["templates"]
        entry = next((r for r in records if r["template_id"] == template_id), None)
        if entry is None:
            raise ValueError("Template is absent from its release catalog")
        if entry.get("metadata_sha256") and _digest(metadata_path) != entry["metadata_sha256"]:
            raise ValueError("Template metadata integrity failure")
    if meta["template_id"] != template_id or meta["template_version"] not in SUPPORTED_TEMPLATE_VERSIONS:
        raise ValueError("Template identity/version mismatch")
    path = root / f"{template_id}.npz"
    if _digest(path) != meta["artifact_sha256"]:
        raise ValueError("Template archive integrity failure")
    with np.load(path, allow_pickle=False) as archive:
        vertices = np.asarray(archive["vertices_mm"], dtype=np.float64)
        faces = np.asarray(archive["faces"], dtype=np.int64)
        colors = np.asarray(archive["colors"], dtype=np.float64)
        components = np.asarray(archive["component_ids"], dtype=np.int64)
    _validate_arrays(vertices, faces)
    if colors.shape != vertices.shape or not np.isfinite(colors).all() or (colors < 0).any() or (colors > 1).any():
        raise ValueError("Invalid source display colors")
    if components.shape != (len(vertices),) or components.min() < 0:
        raise ValueError("Invalid vertex component IDs")
    if _geometry_hash(vertices, faces) != meta["geometry_sha256"]:
        raise ValueError("Template geometry integrity failure")
    for array in (vertices, faces, colors, components):
        _readonly(array)
    return AtlasTemplate(vertices, faces, colors, components, meta)


def _select_component(organ: str, name: str) -> bool:
    """Explicit display selection avoids stacked shell/cortex/segment overlays."""
    name = name.lower()
    if organ == "liver":
        return "capsule" in name or "ligament" in name  # attachment surfaces, no lobe overlays
    if organ == "kidney":
        return "capsule" in name or "hilum_of_kidney" in name
    if organ == "heart":
        return "cardiac_atrium" in name or "ventricle" in name
    if organ == "lung":
        # Regions tile the displayed lung. Exclude internal bronchi/cartilage and
        # duplicate whole-hilum overlay, retain the per-lobe hilum patches.
        return "bronchopulmonary_seg" in name or any(
            token in name for token in ("hilum_upper", "hilum_middle", "hilum_lower"))
    if organ == "brain":
        return any(token in name for token in (
            "gyrus", "gyri", "_pole_", "lobule", "cuneus", "planum_", "operculum",
            "primary_motor_cortex", "limen_insula", "lateral_hemisphere_of_cerebellum",
            "paravermis_of_cerebellum", "cerebellar_vermis", "basilar_part_of_pons",
            "pyramidal_part_of_medulla", "tegmentum_of_medulla", "inferior_olive"))
    if organ == "urinary-bladder":
        return "fundus" in name or "neck_smooth_muscle" in name
    if organ == "small-intestine":
        return "sphincter" not in name and "papilla" not in name
    if organ == "large-intestine":
        return "ileocecal_valve" not in name
    return True  # pancreas/spleen explicitly partitioned source surfaces


def _source_scene(path: Path) -> trimesh.Scene:
    scene = trimesh.load(path, force="scene", process=False)
    if not isinstance(scene, trimesh.Scene):
        raise ValueError("Source did not load as a mesh scene")
    return scene


def _clean_triangles(vertices: FloatArray, source_faces: IntArray, node: str) -> tuple[IntArray, IntArray, npt.NDArray[np.bool_], Json]:
    """Remove zero-area triangles and minimize orientation reversals per component."""
    area2 = np.linalg.norm(_crosses(vertices, source_faces), axis=1)
    keep = area2 > 2e-12
    retained = np.flatnonzero(keep)
    faces = source_faces[keep].copy()
    if len(faces) == 0:
        raise ValueError(f"All source faces degenerate in {node}")
    audit = trimesh.Trimesh(vertices=vertices.copy(), faces=faces.copy(), process=False)
    audit.merge_vertices(digits_vertex=8)
    before_consistent = bool(audit.is_winding_consistent)
    before = np.asarray(audit.faces).copy()
    if not before_consistent:
        cast(Any, trimesh.repair.fix_winding)(audit)
    after = np.asarray(audit.faces)
    flipped = np.any(after != before, axis=1)
    if not np.array_equal(after[flipped], before[flipped, ::-1]):
        raise ValueError("Winding repair changed connectivity beyond orientation")
    if flipped.any():
        labels = np.asarray(cast(Any, trimesh.graph.connected_component_labels)(
            audit.face_adjacency, node_count=len(faces)), dtype=np.int64)
        counts = np.bincount(labels)
        flips = np.bincount(labels, weights=flipped.astype(int))
        flipped ^= (flips > counts / 2)[labels]
        corrected = before.copy()
        corrected[flipped] = before[flipped, ::-1]
        audit.faces = corrected
    faces[flipped] = faces[flipped, ::-1]
    record = {"component": node, "source_face_count": len(source_faces),
              "clean_face_count": len(faces), "removed_degenerate_faces": int((~keep).sum()),
              "reversed_faces": int(flipped.sum()), "winding_before": before_consistent,
              "winding_after": bool(audit.is_winding_consistent)}
    return faces, retained, flipped, record


def _ingest_one(output: Path, source: Path, metadata: Json, scale_mm: float) -> Json:
    if _digest(source) != metadata["source_sha256"]:
        raise ValueError(f"Source integrity failure: {source}")
    scene = _source_scene(source)
    vertices: list[FloatArray] = []
    faces: list[IntArray] = []
    colors: list[FloatArray] = []
    vertex_ids: list[IntArray] = []
    components: list[Json] = []
    excluded: list[str] = []
    cleaning: list[Json] = []
    original_faces: list[IntArray] = []
    clean_to_source: list[IntArray] = []
    orientation_flags: list[npt.NDArray[np.bool_]] = []
    offset = face_offset = source_face_offset = 0
    for node in sorted(scene.graph.nodes_geometry):
        raw_transform, geometry_name = scene.graph[node]
        transform = np.asarray(raw_transform, dtype=np.float64)
        mesh = scene.geometry[geometry_name]
        if not isinstance(mesh, trimesh.Trimesh):
            continue
        if metadata["source_collection"] == "HRA" and not _select_component(metadata["organ"], str(node)):
            excluded.append(str(node))
            continue
        verts = np.asarray(trimesh.transform_points(mesh.vertices, transform), dtype=np.float64) * scale_mm
        rotation = np.asarray(metadata["source_to_authoring_rotation"], dtype=np.float64)
        verts = verts @ rotation.T
        tris = np.asarray(mesh.faces, dtype=np.int64).copy()
        if np.linalg.det(transform[:3, :3]) < 0:
            # Compensate reflected scene transform, preserving source orientation.
            tris = tris[:, ::-1].copy()
        source_tris = tris.copy()
        tris, selected_source_faces, reversed_faces, cleaning_record = _clean_triangles(verts, source_tris, str(node))
        cleaning.append(cleaning_record)
        original_faces.append(source_tris + offset)
        clean_to_source.append(selected_source_faces + source_face_offset)
        orientation_flags.append(reversed_faces)
        source_face_offset += len(source_tris)
        rgba = np.array([185, 152, 135, 255])
        visual = cast(Any, mesh.visual)
        if visual is not None and hasattr(visual, "material"):
            rgba = np.asarray(visual.material.main_color)
        elif visual is not None and hasattr(visual, "vertex_colors") and len(visual.vertex_colors):
            rgba = np.asarray(visual.vertex_colors[0])
        rgb = rgba[:3].astype(float) / 255.0
        if visual is not None and isinstance(getattr(visual, "material", None), trimesh.visual.material.PBRMaterial):
            rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * rgb ** (1 / 2.4) - 0.055)
        colors.append(np.tile(rgb, (len(verts), 1)))
        vertices.append(verts)
        faces.append(tris + offset)
        vertex_ids.append(np.full(len(verts), len(components), dtype=np.int64))
        components.append({"name": str(node), "source_geometry": str(geometry_name),
                           "vertex_start": offset, "vertex_count": len(verts),
                           "face_start": face_offset, "face_count": len(tris),
                           "source_node_transform": transform.tolist(),
                           "source_uv_available": bool(getattr(visual, "uv", None) is not None)})
        offset += len(verts)
        face_offset += len(tris)
    if not vertices:
        raise ValueError(f"No display components selected: {source}")
    v = np.concatenate(vertices)
    f = np.concatenate(faces)
    color = np.concatenate(colors)
    ids = np.concatenate(vertex_ids)
    center = (v.min(axis=0) + v.max(axis=0)) / 2
    v -= center
    _validate_arrays(v, f)
    raw_faces = np.concatenate(original_faces)
    clean_face_map = np.concatenate(clean_to_source)
    source_face_map = np.full(len(raw_faces), -1, dtype=np.int64)
    source_face_map[clean_face_map] = np.arange(len(f))
    final_audit = _topology_audit(v, f)
    metadata.update({
        "template_version": TEMPLATE_VERSION, "deformer_version": DEFORMER_VERSION,
        "unit": "mm", "coordinate_frame": "atlas-display-Y-up-centered-mm-not-RAS",
        "organ_id": metadata["organ"], "generator_version": DEFORMER_VERSION,
        "colors_space": "sRGB",
        "colors_provenance": "Source schematic material colors; glTF linear factors converted to sRGB after trimesh 8-bit quantization",
        "source_to_mm_scale": scale_mm, "source_center_mm": center.tolist(),
        "inverse_coordinate_transform": "source_world = source_to_authoring_rotation.T @ (vertices_mm + source_center_mm) / source_to_mm_scale",
        "normalization_mm": float(np.ptp(v, axis=0).max() / 2),
        "components": components, "excluded_source_nodes": excluded,
        "selection_policy_version": "external-display-components-1.1.0",
        "cleaning_policy": "Drop triangles with area <=1e-12 mm2; repair winding per connected component on welded audit copy with minimum face reversals and transfer only face reversal. No vertex movement or connectivity additions.",
        "cleaning_components": cleaning,
        "removed_degenerate_faces": sum(row["removed_degenerate_faces"] for row in cleaning),
        "reversed_faces": sum(row["reversed_faces"] for row in cleaning),
        "cohort_eligible": all(row["winding_after"] for row in cleaning) and final_audit["winding_consistent_after_audit_weld"] and final_audit["degenerate_faces"] == 0,
        "source_geometry_sha256": _geometry_hash(v, raw_faces),
        "source_faces_sha256": hashlib.sha256(np.asarray(raw_faces, dtype="<i8").tobytes()).hexdigest(),
        "clean_faces_sha256": hashlib.sha256(np.asarray(f, dtype="<i8").tobytes()).hexdigest(),
        "face_map_keys": ["source_to_clean_face_indices", "clean_to_source_face_indices", "clean_face_orientation_reversed", "source_faces"],
        "source_topology_audit": _topology_audit(v, raw_faces),
        "mesh_role": "annotated_display_surface_assembly_not_organ_envelope",
        "control_names": list(CONTROL_NAMES),
        "control_limits": list(CONTROL_LIMITS[metadata["organ"]]),
        "control_limit_provenance": "design_heuristic; not measured population intervals",
        "vertex_count": len(v), "face_count": len(f),
        "extent_mm": np.ptp(v, axis=0).tolist(), "geometry_sha256": _geometry_hash(v, f),
        "topology_audit": final_audit,
        "evidence_kind": "expert_authored", "review_status": "unreviewed",
        "profile": "development_preview", "population_prevalence": None,
        "modifications": "Selected named display components, applied scene transforms, explicit units, bounding-box centering. Removed degenerate triangles and repaired winding with reversible face maps. No smoothing, decimation or remeshing.",
    })
    path = output / f'{metadata["template_id"]}.npz'
    np.savez_compressed(path, vertices_mm=v, faces=f, colors=color, component_ids=ids,
                        source_to_clean_face_indices=source_face_map,
                        clean_to_source_face_indices=clean_face_map, source_faces=raw_faces,
                        clean_face_orientation_reversed=np.concatenate(orientation_flags))
    metadata["artifact_sha256"] = _digest(path)
    _json_write(path.with_suffix(".json"), metadata)
    return {key: metadata[key] for key in (
        "template_id", "organ", "sex_label", "laterality", "source_collection", "source_group_id",
        "source_sha256", "artifact_sha256", "geometry_sha256", "vertex_count", "face_count",
        "extent_mm", "source_url", "license", "control_limits", "coordinate_frame", "organ_id", "cohort_eligible")}


def ingest_library(reference_root: str | Path, output_dir: str | Path) -> list[Json]:
    """Build 24 portable reference templates; original downloaded files are unchanged."""
    root, output = Path(reference_root), Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    if (output / "catalog.json").exists():
        raise FileExistsError("Template release exists; choose a new directory instead of overwriting")
    manifest = json.loads((root / "hra/download-manifest.json").read_text())
    catalog = []
    for record in manifest["records"]:
        if record["organ"] not in HRA_ORGANS:
            continue
        organ = HRA_ORGANS[record["organ"]]
        sex = "female" if "female" in record["alt"].lower() else "male"
        side = next((side for side in ("left", "right") if side in record["alt"].lower()), None)
        template_id = f"hra-{organ}-{sex}" + (f"-{side}" if side else "")
        source = root / "hra/models" / Path(record["path"]).name
        meta = {
            "template_id": template_id, "organ": organ, "sex_label": sex, "laterality": side,
            "source_collection": "HRA", "source_url": record["fileUrl"],
            "source_metadata_url": record["sourceDataUrl"], "source_sha256": record["sha256"],
            "source_group_id": "hra-allen-brain-shared-atlas" if organ == "brain" else f"hra-visible-human-{sex}",
            "source_group_reason": "Conservative atlas ancestry grouping; organ files are not independent donors",
            "source_release": manifest["release"], "license": "CC-BY-4.0",
            "license_url": record["license_url"],
            "attribution": "Human Reference Atlas / HuBMAP 3D Reference Object Library; source creators via linked digital object metadata",
            "units_evidence": "glTF 2.0 linear distances use metres; explicit multiplication by 1000",
            "source_up_axis": "Y (glTF convention); patient-axis interpretation not asserted",
            "source_to_authoring_rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        }
        catalog.append(_ingest_one(output, source, meta, 1000.0))
    bp = json.loads((root / "bodyparts3d/selected-manifest.json").read_text())
    for record in bp["selected"]:
        if record["selection"] not in ("stomach", "gallbladder"):
            continue
        organ = record["selection"]
        meta = {
            "template_id": f"bp3d-{organ}-male", "organ": organ, "sex_label": "male",
            "laterality": None, "source_collection": "BodyParts3D", "source_url": bp["archive_url"],
            "source_sha256": record["sha256"], "source_archive_sha256": bp["archive_sha256"],
            "source_member": record["archive_member"], "source_group_id": "bodyparts3d-adult-male-atlas",
            "source_group_reason": "Same authored atlas, not an independent sample per part",
            "source_release": "4.0; official 99% polygon-reduction archive", "license": bp["license"],
            "license_url": bp["license_url"], "attribution": bp["required_attribution"],
            "fma": record["fma"], "units_evidence": "Assumed millimetres from source coordinates/body scale; source OBJ has no explicit unit tag",
            "units_flag": "design_heuristic", "source_up_axis": "Z per source viewer; rotated -90 degrees X to display Y-up",
            "source_to_authoring_rotation": [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
            "resolution_limit": "Low polygon reference; subdivision cannot recover missing anatomy",
        }
        catalog.append(_ingest_one(output, root / "bodyparts3d" / record["file"], meta, 1.0))
    catalog.sort(key=lambda item: item["template_id"])
    _json_write(output / "catalog.json", {
        "schema_version": "1.0.0", "template_version": TEMPLATE_VERSION,
        "deformer_version": DEFORMER_VERSION, "control_names": list(CONTROL_NAMES),
        "profile": "development_preview", "templates": catalog,
        "limitations": ["Not all human organs or anatomical variations are covered.",
                        "Synthetic deformations do not add independent donor observations.",
                        "Source display surfaces have open boundaries/internal faces; not simulation domains.",
                        "Textures, physiology, prevalence, material parameters and pathology are not inferred.",
                        "BodyParts3D millimetre scale is an explicit assumption pending source-unit confirmation."],
    })
    return catalog


def clean_template_release(input_dir: str | Path, output_dir: str | Path) -> list[Json]:
    """Derive v1.1 face-cleaned templates from verified portable v1 source surfaces.

    This avoids any dependency on an online source library at training time. It keeps
    every vertex and source component index, stores original faces and both face maps,
    and binds each derived artifact to its parent archive/geometry hashes.
    """
    source_root, output = Path(input_dir), Path(output_dir)
    if source_root.resolve() == output.resolve():
        raise ValueError("Cleaning requires a new release directory")
    output.mkdir(parents=True, exist_ok=True)
    if (output / "catalog.json").exists():
        raise FileExistsError("Template release exists; use a new directory")
    catalog: list[Json] = []
    for entry in list_templates(source_root):
        template = load_template(source_root, entry["template_id"])
        if template.metadata["template_version"] != "atlas-display-1.0.0":
            raise ValueError("This cleaning migration requires the original v1.0 display selection")
        meta = json.loads(json.dumps(template.metadata))
        faces_list, maps, reversals, records = [], [], [], []
        components: list[Json] = []
        clean_offset = 0
        for component in meta["components"]:
            vs, vn = component["vertex_start"], component["vertex_count"]
            fs, fn = component["face_start"], component["face_count"]
            local_faces = template.faces[fs:fs + fn] - vs
            clean_faces, kept, flipped, record = _clean_triangles(
                template.vertices_mm[vs:vs + vn], local_faces, component["name"])
            faces_list.append(clean_faces + vs)
            maps.append(kept + fs)
            reversals.append(flipped)
            records.append(record)
            components.append(dict(component, face_start=clean_offset, face_count=len(clean_faces)))
            clean_offset += len(clean_faces)
        faces = np.concatenate(faces_list)
        clean_map = np.concatenate(maps)
        source_map = np.full(len(template.faces), -1, dtype=np.int64)
        source_map[clean_map] = np.arange(len(faces))
        audit = _topology_audit(template.vertices_mm, faces)
        meta.update({
            "template_version": TEMPLATE_VERSION, "selection_policy_version": "external-display-components-1.1.0",
            "components": components, "face_count": len(faces), "topology_audit": audit,
            "source_topology_audit": template.metadata["topology_audit"],
            "geometry_sha256": _geometry_hash(template.vertices_mm, faces),
            "source_geometry_sha256": template.metadata["geometry_sha256"],
            "source_faces_sha256": hashlib.sha256(np.asarray(template.faces, dtype="<i8").tobytes()).hexdigest(),
            "clean_faces_sha256": hashlib.sha256(np.asarray(faces, dtype="<i8").tobytes()).hexdigest(),
            "cleaning_policy": "Drop area <=1e-12 mm2 triangles; minimum per-component winding reversals; no moved vertices or added connectivity",
            "cleaning_components": records,
            "removed_degenerate_faces": sum(r["removed_degenerate_faces"] for r in records),
            "reversed_faces": sum(r["reversed_faces"] for r in records),
            "cohort_eligible": bool(audit["winding_consistent_after_audit_weld"] and audit["degenerate_faces"] == 0 and all(r["winding_after"] for r in records)),
            "face_map_keys": ["source_faces", "source_to_clean_face_indices", "clean_to_source_face_indices", "clean_face_orientation_reversed"],
            "parent_template_archive_sha256": template.metadata["artifact_sha256"],
            "parent_template_version": template.metadata["template_version"],
            "modifications": template.metadata["modifications"] + " v1.1 removes zero-area faces and repairs inconsistent winding with explicit original faces and transfer maps.",
        })
        path = output / (meta["template_id"] + ".npz")
        np.savez_compressed(path, vertices_mm=template.vertices_mm, faces=faces,
                            colors=template.colors, component_ids=template.component_ids,
                            source_faces=template.faces, source_to_clean_face_indices=source_map,
                            clean_to_source_face_indices=clean_map,
                            clean_face_orientation_reversed=np.concatenate(reversals))
        meta["artifact_sha256"] = _digest(path)
        _json_write(path.with_suffix(".json"), meta)
        catalog.append({key: meta[key] for key in (
            "template_id", "organ", "organ_id", "sex_label", "laterality", "source_collection",
            "source_group_id", "source_sha256", "artifact_sha256", "geometry_sha256", "vertex_count",
            "face_count", "extent_mm", "source_url", "license", "control_limits", "coordinate_frame", "cohort_eligible")})
        print(json.dumps({"template": meta["template_id"], "removed": meta["removed_degenerate_faces"],
                          "reversed": meta["reversed_faces"], "eligible": meta["cohort_eligible"]}), flush=True)
    parent_catalog = json.loads((source_root / "catalog.json").read_text())
    parent_catalog.update(template_version=TEMPLATE_VERSION, templates=catalog,
                          parent_catalog_sha256=_digest(source_root / "catalog.json"))
    _json_write(output / "catalog.json", parent_catalog)
    return catalog


def attach_hra_attributions(template_dir: str | Path, metadata_dir: str | Path) -> None:
    """Pin exact digital-object creators, citation and license from local JSON-LD.

    Fetch metadata from each source URL's parent + /metadata.jsonld into metadata_dir
    as <template_id>.jsonld first. This offline step validates object association and
    copies the unmodified source metadata into the portable release.
    """
    root, sources = Path(template_dir), Path(metadata_dir)
    catalog = json.loads((root / "catalog.json").read_text())
    evidence_dir = root / "attribution"
    evidence_dir.mkdir(exist_ok=True)
    attribution_lines = ["# Atlas source attribution", "", "Geometry is derived from the following CC BY 4.0 source objects. VISCERA selected display components, converted units/axes, removed zero-area triangles, and repaired one face orientation. Textures and controlled deformations are separate procedural additions.", ""]
    for entry in catalog["templates"]:
        path = root / (entry["template_id"] + ".json")
        meta = json.loads(path.read_text())
        if meta["source_collection"] == "HRA":
            source = sources / (entry["template_id"] + ".jsonld")
            doc = json.loads(source.read_text())
            raw = next(node for node in doc["@graph"] if node.get("@id", "").endswith("#raw-data"))
            if meta["source_url"].split("/")[-1] not in str(raw.get("dcat:distribution", "")):
                raise ValueError("Attribution metadata does not name this source model")
            if "https://creativecommons.org/licenses/by/4.0/" not in raw.get("dct:license", ""):
                raise ValueError("Expected exact CC BY 4.0 source license")
            by_id = {node["@id"]: node for node in doc["@graph"]}
            refs = raw["dct:creator"]
            if isinstance(refs, dict):
                refs = [refs]
            creators = [{"id": ref["@id"], "name": by_id[ref["@id"]]["schema1:name"]} for ref in refs]
            citation = raw["schema1:citation"]
            saved = evidence_dir / source.name
            saved.write_bytes(source.read_bytes())
            meta.update(attribution=citation, source_creators=creators,
                        source_title=raw["dct:title"], source_citation=citation,
                        source_overall_citation=raw.get("ccf:citation_overall"),
                        source_doi=raw.get("ccf:doi", {}).get("@id"),
                        source_derivation_description=raw.get("rdfs:comment"),
                        source_license_statement=raw["dct:license"],
                        source_metadata_url=meta["source_url"].split("/assets/")[0] + "/metadata.jsonld",
                        source_metadata_sha256=_digest(saved),
                        source_metadata_file="attribution/" + saved.name,
                        attribution_verified=True)
            attribution_lines.extend([f"## {entry['template_id']}", "", citation, "",
                                      "Creators: " + "; ".join(c["name"] + " (" + c["id"] + ")" for c in creators), "",
                                      "License: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/", ""])
        else:
            license_source = sources.parent.parent / "bodyparts3d/license.html"
            license_bytes = license_source.read_bytes()
            if b"creativecommons.org/licenses/by/4.0" not in license_bytes:
                raise ValueError("BodyParts3D license evidence must explicitly link CC BY 4.0")
            license_copy = evidence_dir / "bodyparts3d-official-license.html"
            license_copy.write_bytes(license_bytes)
            meta["source_license_evidence_file"] = "attribution/" + license_copy.name
            meta["source_license_evidence_sha256"] = _digest(license_copy)
            meta["source_license_evidence_url"] = meta["license_url"]
            meta["attribution_verified"] = True
            meta["source_creators"] = [{"name": "The Database Center for Life Science", "id": "https://dbcls.rois.ac.jp/"}]
            attribution_lines.extend([f"## {entry['template_id']}", "", meta["attribution"], "", meta["license_url"], ""])
        _json_write(path, meta)
        entry.update(attribution=meta["attribution"], attribution_verified=True,
                     metadata_sha256=_digest(path), source_creators=meta["source_creators"])
        if meta.get("source_doi"):
            entry["source_doi"] = meta["source_doi"]
    _json_write(root / "catalog.json", catalog)
    (root / "ATTRIBUTIONS.md").write_text("\n".join(attribution_lines))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    ingest = sub.add_parser("ingest")
    ingest.add_argument("--reference-root", type=Path, required=True)
    ingest.add_argument("--output", type=Path, required=True)
    clean = sub.add_parser("clean")
    clean.add_argument("--input", type=Path, required=True)
    clean.add_argument("--output", type=Path, required=True)
    attribute = sub.add_parser("attribute")
    attribute.add_argument("--templates", type=Path, required=True)
    attribute.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "attribute":
        attach_hra_attributions(args.templates, args.metadata)
        print("Verified and pinned exact source attributions")
        return
    catalog = (ingest_library(args.reference_root, args.output) if args.command == "ingest"
               else clean_template_release(args.input, args.output))
    print(json.dumps({"templates": len(catalog), "output": str(args.output),
                      "total_vertices": sum(r["vertex_count"] for r in catalog),
                      "total_faces": sum(r["face_count"] for r in catalog)}, indent=2))


if __name__ == "__main__":
    main()
