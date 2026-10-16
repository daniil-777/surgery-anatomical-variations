"""Deterministic authored liver and gallbladder surface construction.

This is one original synthetic design lineage, not observed anatomy. Mesh validity
and anatomical truth are deliberately different outputs. RAS+, millimetres.
"""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from typing import Any, Callable, cast

import numpy as np

from .schema import (
    CONDITION_KEYS,
    DEFAULT_PARAMETERS,
    PARAMETER_BOUNDS,
    PARAMETER_KEYS,
    SceneRequest,
    ShapeParameters,
)

__all__ = [
    "CONDITION_KEYS",
    "DEFAULT_PARAMETERS",
    "PARAMETER_BOUNDS",
    "PARAMETER_KEYS",
    "GENERATOR_VERSION",
    "LINEAGE_ID",
    "RESOLUTIONS",
    "DEFAULT_SAMPLER_PROFILE",
    "SAMPLER_PROFILES",
    "canonical_hash",
    "create_simulation_proxy",
    "generate_scene",
    "mesh_metrics",
    "parameter_vector",
    "parameters_from_vector",
    "sample_parameters",
    "scene_clearance",
    "vertical_surface_clearance",
]

GENERATOR_VERSION = "original-abdomen-0.1.0"
LINEAGE_ID = "authored-abdominal-construction-v1"
RESOLUTIONS = {"low": (32, 64), "medium": (64, 128), "high": (96, 192)}
DEFAULT_SAMPLER_PROFILE = "adult_design_v1"
SAMPLER_PROFILES: dict[str, dict[str, Any]] = {
    "broad_control_v0": {
        "version": "0.1.0",
        "role": "broad_control_stress_coverage",
        "distribution": "legacy_shared_uniform_size_with_uniform_residuals",
        "volume_band_ml": None,
    },
    "adult_design_v1": {
        "version": "1.0.0",
        "role": "bounded_adult_authoring_design",
        "distribution": "registry_truncated_correlated_gaussian_dimensions",
        "dimension_keys": ["liver_width_mm", "liver_height_mm", "liver_depth_mm"],
        "means_mm": [235.0, 145.0, 125.0],
        "standard_deviations_mm": [18.0, 12.0, 9.0],
        "pretruncation_pairwise_correlation": 0.49,
        "volume_band_ml": [1200.0, 2600.0],
        "evidence": "authored_engineering_design_band_not_clinical_norm_or_prevalence",
    },
}


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def parameter_vector(parameters: dict[str, float] | ShapeParameters) -> np.ndarray:
    values = (
        parameters.model_dump()
        if isinstance(parameters, ShapeParameters)
        else ShapeParameters.model_validate(parameters).model_dump()
    )
    return np.asarray([values[key] for key in PARAMETER_KEYS], dtype=np.float32)


def parameters_from_vector(vector: Any) -> dict[str, float]:
    values = np.asarray(vector, dtype=np.float64)
    if values.shape != (len(PARAMETER_KEYS),):
        raise ValueError(f"expected {len(PARAMETER_KEYS)} construction parameters")
    return ShapeParameters.model_validate(
        dict(zip(PARAMETER_KEYS, values.tolist(), strict=True))
    ).model_dump()


def sample_parameters(
    seed: int, profile: str = DEFAULT_SAMPLER_PROFILE, *, enforce_volume_band: bool = True
) -> dict[str, float]:
    """Sample a versioned synthetic design distribution, never prevalence.

    The registry truncation rejects parameter proposals instead of clamping.
    Interactive sampling measures the medium-resolution liver before accepting
    its volume band. The factory disables this inner filter so every constructed
    candidate, including volume-band rejections, remains in its external ledger.
    """
    if profile not in SAMPLER_PROFILES:
        raise ValueError(f"unknown sampler profile {profile!r}")
    rng = np.random.Generator(np.random.PCG64(seed))
    if profile == "adult_design_v1":
        for _ in range(1000):
            common = rng.normal()
            residuals = rng.normal(size=3)
            dimensions = np.asarray([235.0, 145.0, 125.0]) + np.asarray([18.0, 12.0, 9.0]) * (
                0.7 * common + np.sqrt(0.51) * residuals
            )
            keys = ("liver_width_mm", "liver_height_mm", "liver_depth_mm")
            if all(
                PARAMETER_BOUNDS[key][0] <= value <= PARAMETER_BOUNDS[key][1]
                for key, value in zip(keys, dimensions, strict=True)
            ):
                values = dict(zip(keys, dimensions.tolist(), strict=True))
                values.update(
                    {
                        "left_lobe_ratio": rng.uniform(0.33, 0.75),
                        "inferior_concavity": rng.uniform(0.13, 0.52),
                        "fissure_depth_mm": rng.uniform(3, 11),
                        "gallbladder_length_mm": rng.uniform(58, 106),
                        "gallbladder_radius_mm": rng.uniform(10.5, 21),
                    }
                )
                validated = ShapeParameters.model_validate(values).model_dump()
                if enforce_volume_band:
                    surface, faces, *_ = _liver(validated, 64, 128)
                    volume_ml = _signed_volume(surface, faces) / 1000
                    if not 1200.0 <= volume_ml <= 2600.0:
                        continue
                return validated
        raise ValueError("SAMPLER_PARAMETER_REJECTION_EXHAUSTED")
    size = rng.uniform(-0.75, 0.75)
    values = {
        "liver_width_mm": 250 + 48 * size + rng.uniform(-9, 9),
        "liver_height_mm": 155 + 30 * size + rng.uniform(-9, 9),
        "liver_depth_mm": 165 + 32 * size + rng.uniform(-9, 9),
        "left_lobe_ratio": rng.uniform(0.33, 0.75),
        "inferior_concavity": rng.uniform(0.13, 0.52),
        "fissure_depth_mm": rng.uniform(3, 11),
        "gallbladder_length_mm": rng.uniform(58, 106),
        "gallbladder_radius_mm": rng.uniform(10.5, 21),
    }
    return ShapeParameters.model_validate(values).model_dump()


@lru_cache(maxsize=8)
def _sphere_topology(rings: int, segments: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Closed, welded latitude mesh with two unique poles and stable indices."""
    phi = np.repeat(np.arange(1, rings, dtype=np.float64) * np.pi / rings, segments)
    theta = np.tile(np.arange(segments, dtype=np.float64) * 2 * np.pi / segments, rings - 1)
    uv = np.column_stack((theta / (2 * np.pi), phi / np.pi))
    parameters = np.column_stack((phi, theta))
    parameters = np.vstack(([0, 0], parameters, [np.pi, 0]))
    uv = np.vstack(([0.5, 0], uv, [0.5, 1]))
    faces: list[tuple[int, int, int]] = []
    for j in range(segments):
        faces.append((0, 1 + j, 1 + (j + 1) % segments))
    for i in range(rings - 2):
        for j in range(segments):
            a = 1 + i * segments + j
            b = 1 + i * segments + (j + 1) % segments
            c = a + segments
            d = b + segments
            faces.extend(((a, c, b), (b, c, d)))
    last = len(parameters) - 1
    base = 1 + (rings - 2) * segments
    for j in range(segments):
        faces.append((base + j, last, base + (j + 1) % segments))
    return parameters, np.asarray(faces, dtype=np.int32), uv


def _gaussian(x: np.ndarray, mean: float, width: float) -> np.ndarray:
    return np.exp(-0.5 * ((x - mean) / width) ** 2)


def _smoothstep(a: float, b: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def _normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    tri = vertices[faces]
    face_normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    normals = np.zeros_like(vertices)
    for axis in range(3):
        np.add.at(normals, faces[:, axis], face_normals)
    return np.asarray(normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-15))


def _signed_volume(vertices: np.ndarray, faces: np.ndarray) -> float:
    centred = vertices - vertices.mean(axis=0)
    triangles = centred[faces]
    return float(
        np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum() / 6
    )


def _orient(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    return faces[:, [0, 2, 1]].copy() if _signed_volume(vertices, faces) < 0 else faces.copy()


def _liver(
    parameters: dict[str, float], rings: int, segments: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, np.ndarray], dict[str, np.ndarray]]:
    angles, triangles, uv = _sphere_topology(rings, segments)
    phi, theta = angles.T
    x = -np.cos(phi)
    radial = np.sin(phi)
    leftness = 1 - _smoothstep(-0.85, -0.10, x)
    left_thickness = 1 - (1 - parameters["left_lobe_ratio"]) * leftness
    y0 = radial * np.sin(theta) * left_thickness
    z0 = radial * np.cos(theta) * left_thickness
    inferior = _smoothstep(0.02, 0.58, -np.cos(theta))
    anterior = _smoothstep(-0.15, 0.75, np.sin(theta))
    posterior = _smoothstep(-0.15, 0.75, -np.sin(theta))

    # The right dome and thinner left wedge share one continuous volume.
    y = y0 * parameters["liver_depth_mm"] * 0.50
    z = z0 * parameters["liver_height_mm"] * 0.52
    z = np.where(z < 0, z * (0.61 + 0.10 * x), z)
    y += (8 * leftness + 3 * x) * radial
    z += 7 * leftness * radial
    concavity = parameters["inferior_concavity"]
    fissure = parameters["fissure_depth_mm"]

    fossa = _gaussian(x, 0.23, 0.16) * _gaussian(y0, 0.30, 0.26) * inferior
    porta = _gaussian(x, -0.02, 0.21) * _gaussian(y0, -0.23, 0.27) * inferior
    teres = _gaussian(x, -0.30, 0.055) * inferior * (0.45 + 0.55 * anterior)
    gastric = _gaussian(x, -0.48, 0.26) * inferior * posterior
    renal = _gaussian(x, 0.47, 0.21) * inferior * posterior
    ivc = _gaussian(x, 0.13, 0.095) * posterior
    caudate = _gaussian(x, -0.08, 0.13) * posterior * _gaussian(np.cos(theta), -0.40, 0.32)
    z += (7 + 24 * concavity) * fossa + (5 + 14 * concavity) * porta
    z += fissure * teres + 5 * concavity * gastric + 7 * concavity * renal
    y += fissure * 0.95 * ivc - 5 * caudate
    z -= 4.5 * caudate
    vertices = np.column_stack((x * parameters["liver_width_mm"] * 0.5, y, z))
    # Stated dimensions are RAS extents, not PCA bounds or clinical measurements.
    extents = np.ptp(vertices, axis=0)
    requested = np.asarray(
        [parameters["liver_width_mm"], parameters["liver_depth_mm"], parameters["liver_height_mm"]]
    )
    vertices = (
        (vertices - (vertices.max(axis=0) + vertices.min(axis=0)) * 0.5) * requested / extents
    )
    vertices += np.array([35.0, 0.0, 90.0])
    triangles = _orient(vertices, triangles)
    masks = {
        "gallbladder_fossa": fossa,
        "porta_hepatis": porta,
        "teres_notch": teres,
        "ivc_groove": ivc,
        "gastric_impression": gastric,
        "renal_impression": renal,
        "caudate_surface": caudate,
        "falciform_zone": _gaussian(x, -0.25, 0.09) * np.maximum(np.cos(theta), 0),
    }
    landmarks = {name: vertices[int(np.argmax(mask))] for name, mask in masks.items()}
    landmarks.update(
        {
            "right_lobe_lateral_tip": vertices[np.argmax(vertices[:, 0])],
            "left_lobe_lateral_tip": vertices[np.argmin(vertices[:, 0])],
            "dome_apex": vertices[np.argmax(vertices[:, 2])],
            "inferior_margin": vertices[np.argmin(vertices[:, 2])],
        }
    )
    return vertices, triangles, uv.copy(), landmarks, masks


def _clip_triangle(subject: np.ndarray, clip: np.ndarray) -> np.ndarray:
    """Convex 2D polygon intersection using oriented half-planes."""
    ab, ac = clip[1] - clip[0], clip[2] - clip[0]
    if ab[0] * ac[1] - ab[1] * ac[0] < 0:
        clip = clip[::-1]
    polygon = [p for p in subject]
    for a, b in zip(clip, np.roll(clip, -1, axis=0), strict=True):
        if not polygon:
            break
        result = []
        direction = b - a

        def side(point: np.ndarray) -> float:
            offset = point - a
            return float(direction[0] * offset[1] - direction[1] * offset[0])

        previous = polygon[-1]
        previous_side = side(previous)
        for current in polygon:
            current_side = side(current)
            if (current_side >= -1e-9) != (previous_side >= -1e-9):
                denominator = previous_side - current_side
                if abs(denominator) > 1e-14:
                    result.append(previous + (current - previous) * previous_side / denominator)
            if current_side >= -1e-9:
                result.append(current)
            previous, previous_side = current, current_side
        polygon = result
    return np.asarray(polygon)


def vertical_surface_clearance(
    lower_body: np.ndarray, lower_faces: np.ndarray, upper_body: np.ndarray, upper_faces: np.ndarray
) -> float:
    """Minimum upper-body underside minus lower-body top clearance in mm.

    It computes the full projected-triangle arrangement, not vertex-only probes.
    For our liver-above-gallbladder configuration, a positive value certifies
    vertical separation of the represented triangle solids to float tolerance.
    """
    liver_tri = upper_body[upper_faces]
    gb_tri = lower_body[lower_faces]
    liver_n = np.cross(liver_tri[:, 1] - liver_tri[:, 0], liver_tri[:, 2] - liver_tri[:, 0])
    gb_n = np.cross(gb_tri[:, 1] - gb_tri[:, 0], gb_tri[:, 2] - gb_tri[:, 0])
    liver_tri = liver_tri[liver_n[:, 2] < -1e-9]
    gb_tri = gb_tri[gb_n[:, 2] > 1e-9]
    grid: dict[tuple[int, int], list[int]] = {}
    cell_mm = 12.0
    coefficients = []
    for index, triangle in enumerate(liver_tri):
        coefficients.append(
            np.linalg.solve(np.column_stack((triangle[:, :2], np.ones(3))), triangle[:, 2])
        )
        lo = np.floor(triangle[:, :2].min(axis=0) / cell_mm).astype(int)
        hi = np.floor(triangle[:, :2].max(axis=0) / cell_mm).astype(int)
        for x in range(lo[0], hi[0] + 1):
            for y in range(lo[1], hi[1] + 1):
                grid.setdefault((x, y), []).append(index)
    minimum = float("inf")
    for triangle in gb_tri:
        lo = np.floor(triangle[:, :2].min(axis=0) / cell_mm).astype(int)
        hi = np.floor(triangle[:, :2].max(axis=0) / cell_mm).astype(int)
        candidates: set[int] = set()
        for x in range(lo[0], hi[0] + 1):
            for y in range(lo[1], hi[1] + 1):
                candidates.update(grid.get((x, y), ()))
        gb_coeff = np.linalg.solve(np.column_stack((triangle[:, :2], np.ones(3))), triangle[:, 2])
        t_min, t_max = triangle[:, :2].min(axis=0), triangle[:, :2].max(axis=0)
        for candidate in candidates:
            other = liver_tri[candidate]
            if np.any(t_max < other[:, :2].min(axis=0)) or np.any(other[:, :2].max(axis=0) < t_min):
                continue
            polygon = _clip_triangle(triangle[:, :2], other[:, :2])
            if len(polygon) < 3:
                continue
            gap = np.column_stack((polygon, np.ones(len(polygon)))) @ (
                coefficients[candidate] - gb_coeff
            )
            minimum = min(minimum, float(gap.min()))
    return minimum


def _gallbladder(
    parameters: dict[str, float],
    rings: int,
    segments: int,
    wall_mm: float,
    liver: np.ndarray,
    liver_faces: np.ndarray,
    fossa: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, np.ndarray], np.ndarray, dict[str, float]]:
    angles, faces, uv = _sphere_topology(rings, segments)
    phi, theta = angles.T
    t = (1 - np.cos(phi)) / 2  # neck to fundus along the long axis
    length, radius = parameters["gallbladder_length_mm"], parameters["gallbladder_radius_mm"]
    radial = np.sin(phi)
    neck_taper = 0.27 + 0.73 * _smoothstep(0.0, 0.47, t)
    body_taper = 1 - 0.16 * _smoothstep(0.70, 1.0, t)
    r = radius * radial * neck_taper * body_taper
    # The sac lies along the visceral surface, with the fundus anterior and
    # slightly inferior; a near-vertical axis would create a pendant-like organ.
    axis = np.asarray([0.18, 0.97, -0.16])
    axis /= np.linalg.norm(axis)
    u = np.cross(axis, [0, 1, 0])
    u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    centreline = length * t[:, None] * axis
    centreline += (5 * np.sin(np.pi * t) * t)[:, None] * u
    vertices = centreline + r[:, None] * (
        np.cos(theta)[:, None] * u + 0.88 * np.sin(theta)[:, None] * v
    )
    # Place the sac against the authored fossa and resolve *surface* separation,
    # rather than detaching it below the entire organ's bounding box.
    origin = fossa + np.asarray([0.0, -38.0, -8.0])
    vertices += origin
    faces = _orient(vertices, faces)
    initial_gap = vertical_surface_clearance(vertices, faces, liver, liver_faces)
    if not np.isfinite(initial_gap):
        raise ValueError("gallbladder has no projected overlap with the liver fossa")
    translation_z = initial_gap - 0.8
    vertices[:, 2] += translation_z
    # Homothetic nested inner sac guarantees positive separation near the neck poles.
    # It is an explicit effective-wall approximation, not constant physical thickness.
    centre = vertices.mean(axis=0)
    shrink = 1 - min(wall_mm / radius, 0.25)
    inner = centre + (vertices - centre) * shrink
    thickness = np.linalg.norm(vertices - inner, axis=1)
    indices = {
        "neck": int(np.argmin(t)),
        "fundus": int(np.argmax(t)),
        "body": int(np.argmin(abs(t - 0.60) + 0.12 * abs(np.sin(theta)))),
        "infundibulum": int(np.argmin(abs(t - 0.20) + 0.12 * abs(np.sin(theta)))),
        "anterior_body": int(np.argmax(vertices[:, 1])),
        "inferior_pole": int(np.argmin(vertices[:, 2])),
    }
    landmarks = {name: vertices[index] for name, index in indices.items()}
    extra = {
        "requested_wall_scale_mm": wall_mm,
        "wall_correspondence_thickness_min_mm": float(thickness.min()),
        "wall_correspondence_thickness_max_mm": float(thickness.max()),
        "lumen_volume_ml": abs(_signed_volume(inner, faces)) / 1000,
        "wall_volume_ml": (_signed_volume(vertices, faces) - _signed_volume(inner, faces)) / 1000,
        "neck_to_fundus_distance_mm": float(np.linalg.norm(vertices[-1] - vertices[0])),
        "centreline_length_mm": float(
            np.linalg.norm(
                np.diff(
                    np.vstack((centreline[0], centreline[1:-1:segments], centreline[-1])), axis=0
                ),
                axis=1,
            ).sum()
        ),
        "liver_clearance_mm": float(initial_gap - translation_z),
        "placement_adjustment_mm": float(translation_z),
    }
    return vertices, faces, uv.copy(), landmarks, inner, extra


def mesh_metrics(vertices: Any, faces: Any) -> dict[str, Any]:
    vertices = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    faces = np.asarray(faces, dtype=np.int32).reshape(-1, 3)
    if not len(vertices) or not len(faces):
        raise ValueError("empty surface")
    if faces.min() < 0 or faces.max() >= len(vertices):
        raise ValueError("out-of-range face index")
    triangles = vertices[faces]
    cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    areas = np.linalg.norm(cross, axis=1) / 2
    edges = np.sort(np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]])), axis=1)
    unique_edges, counts = np.unique(edges, axis=0, return_counts=True)
    extents = np.ptp(vertices, axis=0)
    signed_volume = _signed_volume(vertices, faces)
    return {
        "vertex_count": len(vertices),
        "triangle_count": len(faces),
        "finite": bool(np.isfinite(vertices).all()),
        "watertight": bool(np.all(counts == 2)),
        "boundary_edge_count": int(np.count_nonzero(counts == 1)),
        "nonmanifold_edge_count": int(np.count_nonzero(counts > 2)),
        "euler_characteristic": int(len(vertices) - len(unique_edges) + len(faces)),
        "degenerate_triangle_count": int(np.count_nonzero(areas < 1e-10)),
        "signed_volume_ml": signed_volume / 1000,
        "volume_ml": abs(signed_volume) / 1000,
        "surface_area_mm2": float(areas.sum()),
        "bounds_mm": [vertices.min(axis=0).tolist(), vertices.max(axis=0).tolist()],
        "width_mm": float(extents[0]),
        "depth_mm": float(extents[1]),
        "height_mm": float(extents[2]),
        "minimum_triangle_area_mm2": float(areas.min()),
        "measurement_definition": "closed_outer_envelope_ras_extents_v1",
        "reference_configuration": "authored_unloaded_geometry_not_known_stress_free",
    }


def scene_clearance(scene: dict[str, Any]) -> dict[str, Any]:
    """Audit actual edited liver/GB surfaces independently of contact-pair lists.

    This supported scene relation places gallbladder below liver. Other scene
    configurations need a general 3D intersection audit, not a fabricated pass.
    """
    organs = {organ["id"]: organ for organ in scene["organs"]}
    liver, gb = organs["liver"], organs["gallbladder"]
    gap = vertical_surface_clearance(
        np.asarray(gb["positions"]).reshape(-1, 3),
        np.asarray(gb["indices"]).reshape(-1, 3),
        np.asarray(liver["positions"]).reshape(-1, 3),
        np.asarray(liver["indices"]).reshape(-1, 3),
    )
    return {
        "passed": bool(gap >= -1e-6),
        "minimum_vertical_clearance_mm": gap if np.isfinite(gap) else None,
        "projection_overlap": bool(np.isfinite(gap)),
        "method": "projected_triangle_arrangement_v1",
        "scope": "liver_above_gallbladder_no_display_tube_physics",
    }


def create_simulation_proxy(
    parameters: dict[str, float] | None = None, render_positions: Any = None
) -> dict[str, Any]:
    """Positive-volume coarse star fan for an explicitly approximate preview.

    The Chebyshev kernel point satisfies all oriented face halfspaces. It does
    not create histological layers or provide a converged tissue discretization.
    """
    from scipy.optimize import linprog

    params = ShapeParameters.model_validate(parameters or {}).model_dump()
    surface, faces, *_ = _liver(params, 12, 24)
    triangles = surface[faces]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    result = linprog(
        np.asarray([0, 0, 0, -1]),
        A_ub=np.column_stack((normals, np.ones(len(normals)))),
        b_ub=np.einsum("ij,ij->i", normals, triangles[:, 0]),
        bounds=[(None, None)] * 4,
        method="highs",
    )
    if not result.success or result.x[3] <= 1e-6:
        raise ValueError(
            "liver does not have a verified positive star kernel; remeshing is required"
        )
    centre = result.x[:3]
    positions = np.vstack((surface, centre))
    tets = np.column_stack((np.full(len(faces), len(surface), dtype=np.int32), faces))
    corners = positions[tets]
    signed = (
        np.einsum(
            "ij,ij->i",
            corners[:, 1] - corners[:, 0],
            np.cross(corners[:, 2] - corners[:, 0], corners[:, 3] - corners[:, 0]),
        )
        / 6
    )
    if np.any(signed <= 0):
        raise ValueError("nonpositive fan tetrahedron")
    edges = np.unique(
        np.sort(
            tets[:, np.asarray([[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]])].reshape(-1, 2),
            axis=1,
        ),
        axis=0,
    )
    density = 1050.0
    masses = np.zeros(len(positions))
    for i in range(4):
        np.add.at(masses, tets[:, i], signed * 1e-9 * density / 4)
    pinned = np.flatnonzero(
        (positions[:, 1] < np.quantile(surface[:, 1], 0.18))
        & (positions[:, 2] > np.quantile(surface[:, 2], 0.56))
    )
    proxy: dict[str, Any] = {
        "schema_version": "0.1.0",
        "organ_id": "liver",
        "positions_mm": np.round(positions, 9).reshape(-1).tolist(),
        "tets": tets.reshape(-1).tolist(),
        "surface_indices": faces.reshape(-1).tolist(),
        "masses_kg": masses.tolist(),
        "density_kg_m3": density,
        "density_evidence": "design_heuristic",
        "rest_volumes_mm3": signed.tolist(),
        "edges": edges.reshape(-1).tolist(),
        "rest_lengths_mm": np.linalg.norm(
            positions[edges[:, 0]] - positions[edges[:, 1]], axis=1
        ).tolist(),
        "pinned_nodes": pinned.tolist(),
        "pinning_evidence": "authored_posterior_support_preview_not_ligament_anatomy",
        "kernel_margin_mm": float(result.x[3]),
        "minimum_tet_volume_mm3": float(signed.min()),
        "volume_ml": float(signed.sum() / 1000),
        "coarse_surface_error": "not_a_converged_tissue_mesh",
        "physics_profile": "development_preview",
        "reference_state": "authored_geometry_assumed_rest_for_preview",
        "limitations": [
            "Single central fan has anisotropic coarse elements and no mesh-converged tissue response.",
            "No capsule, vessels, lesions or heterogeneous tissue layers are represented.",
            "Support nodes and density are explicit preview assumptions; no physiological validation.",
        ],
    }
    if render_positions is not None:
        from scipy.spatial import cKDTree
        from trimesh.triangles import closest_point, points_to_barycentric

        render = np.asarray(render_positions, dtype=np.float64).reshape(-1, 3)
        k = min(12, len(triangles))
        _, candidates = cKDTree(triangles.mean(axis=1)).query(render, k=k)
        expanded = triangles[candidates.reshape(-1)]
        repeated = np.repeat(render, k, axis=0)
        closest_point_typed = cast(Callable[[np.ndarray, np.ndarray], np.ndarray], closest_point)
        barycentric_typed = cast(
            Callable[[np.ndarray, np.ndarray], np.ndarray], points_to_barycentric
        )
        closest = closest_point_typed(expanded, repeated).reshape(-1, k, 3)
        selection = np.argmin(np.sum((closest - render[:, None, :]) ** 2, axis=2), axis=1)
        selected_faces = candidates[np.arange(len(render)), selection]
        surface_points = closest[np.arange(len(render)), selection]
        weights_surface = barycentric_typed(triangles[selected_faces], surface_points)
        weights = np.column_stack((np.zeros(len(render)), weights_surface))
        residual = render - surface_points
        reconstructed = np.einsum("ij,ijk->ik", weights, positions[tets[selected_faces]]) + residual
        if not np.allclose(reconstructed, render, rtol=0, atol=1e-7):
            raise ValueError("simulation embedding failed reconstruction")
        proxy["embedding"] = {
            "contract": "affine_f_v1",
            "tet_indices": selected_faces.tolist(),
            "weights": np.round(weights, 12).reshape(-1).tolist(),
            "rest_residuals_mm": np.round(residual, 9).reshape(-1).tolist(),
            "max_rest_residual_mm": float(np.linalg.norm(residual, axis=1).max()),
            "reconstruction_max_error_mm": float(
                np.linalg.norm(reconstructed - render, axis=1).max()
            ),
            "rule": "x_render=sum(weights*x_tet)+F_tet*rest_residual; residual rotates/deforms with tetrahedron",
        }
    return proxy


def _mesh_output(
    identifier: str,
    name: str,
    vertices: np.ndarray,
    faces: np.ndarray,
    uv: np.ndarray,
    color: str,
    landmarks: dict[str, np.ndarray],
    seed: int,
    masks: dict[str, np.ndarray] | None = None,
) -> dict[str, Any]:
    metrics = mesh_metrics(vertices, faces)
    normals = _normals(vertices, faces)
    rng = np.random.Generator(np.random.PCG64(seed))
    phase = rng.uniform(0, 2 * np.pi, 3)
    # Low-amplitude intrinsic pigment variation, not geometry or histology.
    pigment = (
        0.96
        + 0.025 * np.sin(vertices[:, 0] / 8 + phase[0]) * np.cos(vertices[:, 1] / 7 + phase[1])
        + 0.015 * np.sin(vertices[:, 2] / 3 + phase[2])
    )
    base_color = np.array([int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)])
    colors = np.clip(base_color[None, :] * pigment[:, None], 0, 1)
    result: dict[str, Any] = {
        "id": identifier,
        "name": name,
        "kind": identifier.split("-")[0],
        "color": color,
        "positions": np.round(vertices, 6).reshape(-1).tolist(),
        "indices": faces.reshape(-1).tolist(),
        "normals": np.round(normals, 6).reshape(-1).tolist(),
        "uv": np.round(uv, 6).reshape(-1).tolist(),
        "colors": np.round(colors, 5).reshape(-1).tolist(),
        "landmarks": {k: np.round(v, 6).tolist() for k, v in landmarks.items()},
        "metadata": {
            "metrics": metrics,
            "topology_id": f"{identifier}-radial-{len(vertices)}-{len(faces)}-v1",
            "representation": "closed_outer_surface",
            "anatomical_review": "unreviewed",
            "units": "mm",
            "evidence": {
                "geometry": "procedural",
                "appearance": "procedural",
                "mechanics": "unknown",
            },
            "uv_seam": "periodic_u_seam_requires_wrap_aware_sampling_not_flat_interpolation",
            "limitations": [
                "Original authored approximation; independent anatomical review pending.",
                "Surface validity does not establish anatomy, thickness or physiological mechanics.",
            ],
        },
    }
    if masks:
        result["semantic_regions"] = {
            name: np.flatnonzero(mask > max(float(mask.max()) * 0.45, 0.05)).tolist()
            for name, mask in masks.items()
        }
    return result


def _tube(points: list[list[float]], radius: float, identifier: str, color: str) -> dict[str, Any]:
    """Closed individual display tube. Separate tubes are NOT joined fluid lumens."""
    from scipy.interpolate import CubicSpline

    controls = np.asarray(points, dtype=np.float64)
    distance = np.concatenate(([0.0], np.cumsum(np.linalg.norm(np.diff(controls, axis=0), axis=1))))
    count = max(12, int(distance[-1] / 2))
    curve = CubicSpline(distance, controls, axis=0)(np.linspace(0, distance[-1], count))
    tangents = np.gradient(curve, axis=0)
    tangents /= np.linalg.norm(tangents, axis=1, keepdims=True)
    angle = np.arange(12) * 2 * np.pi / 12
    vertices = []
    for p, tangent in zip(curve, tangents, strict=True):
        reference = (
            np.array([0.0, 0.0, 1.0]) if abs(tangent[2]) < 0.9 else np.array([0.0, 1.0, 0.0])
        )
        u = np.cross(tangent, reference)
        u /= np.linalg.norm(u)
        v = np.cross(tangent, u)
        vertices.extend(p + radius * (np.cos(angle)[:, None] * u + np.sin(angle)[:, None] * v))
    faces: list[tuple[int, int, int]] = []
    for i in range(count - 1):
        for j in range(12):
            a, b = i * 12 + j, i * 12 + (j + 1) % 12
            faces.extend(((a, a + 12, b), (b, a + 12, b + 12)))
    vertices.extend((curve[0], curve[-1]))
    for j in range(12):
        faces.extend(
            (
                (count * 12, (j + 1) % 12, j),
                (count * 12 + 1, (count - 1) * 12 + j, (count - 1) * 12 + (j + 1) % 12),
            )
        )
    positions = np.asarray(vertices)
    triangles = _orient(positions, np.asarray(faces, dtype=np.int32))
    result = _mesh_output(
        identifier,
        identifier.replace("-", " ").title(),
        positions,
        triangles,
        np.zeros((len(positions), 2)),
        color,
        {},
        0,
    )
    result["metadata"].update(
        {
            "representation": "embedded_display",
            "physics_role": "none",
            "lumen_connectivity": "not_implemented",
            "radius_mm": radius,
        }
    )
    result["centreline_mm"] = np.round(curve, 6).tolist()
    return result


def _display_graph(
    liver_landmarks: dict[str, np.ndarray], gb_landmarks: dict[str, np.ndarray]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    porta = liver_landmarks["porta_hepatis"]
    common = porta + np.array([0, -5, -24])
    distal = common + np.array([-4, 3, -35])
    neck = gb_landmarks["neck"]
    branches = [
        ("common-hepatic-duct", [porta, common], 2.5, "#9ba65c"),
        ("common-bile-duct", [common, common + [0, 3, -15], distal], 2.7, "#9ba65c"),
        ("cystic-duct", [neck, neck + [-8, -8, 3], common], 1.7, "#c8bc77"),
        (
            "portal-vein-trunk",
            [porta + [-5, -12, -40], porta + [-3, -9, -15], porta + [-3, -7, 2]],
            5.5,
            "#697ab5",
        ),
        (
            "proper-hepatic-artery",
            [porta + [8, 7, -38], porta + [5, 6, -12], porta + [5, 4, 2]],
            2.5,
            "#bc5c52",
        ),
    ]
    meshes = [
        _tube(np.asarray(points).tolist(), radius, name, color)
        for name, points, radius, color in branches
    ]
    graph = {
        "representation": "named_extrahepatic_display_scaffold",
        "review_status": "unreviewed",
        "flow_model": "none",
        "nodes": [
            {"id": "porta", "position_mm": porta.tolist()},
            {"id": "cystic-junction", "position_mm": common.tolist()},
            {"id": "gallbladder-neck", "position_mm": neck.tolist()},
            {"id": "distal-duct-cutoff", "position_mm": distal.tolist()},
        ],
        "edges": [
            {"id": "common-hepatic-duct", "from": "porta", "to": "cystic-junction"},
            {"id": "cystic-duct", "from": "gallbladder-neck", "to": "cystic-junction"},
            {"id": "common-bile-duct", "from": "cystic-junction", "to": "distal-duct-cutoff"},
        ],
        "limitations": [
            "Individual display tubes have artificial endpoint caps.",
            "Branches are not unioned lumen/wall geometry.",
            "No intraparenchymal tree, Michels variant, duodenal entry, perfusion or transport model is represented.",
        ],
    }
    return meshes, graph


def generate_scene(
    spec: dict[str, Any] | SceneRequest | None = None,
    resolution: str = "medium",
    *,
    include_simulation: bool = True,
) -> dict[str, Any]:
    """Return JSON-safe original surface assets with measurements and scoped QA."""
    request = spec if isinstance(spec, SceneRequest) else SceneRequest.model_validate(spec or {})
    if resolution not in RESOLUTIONS:
        raise ValueError(f"resolution must be one of {tuple(RESOLUTIONS)}")
    rings, segments = RESOLUTIONS[resolution]
    parameters = request.parameters.model_dump()
    vertices, faces, uv, landmarks, masks = _liver(parameters, rings, segments)
    liver = _mesh_output(
        "liver", "Liver", vertices, faces, uv, "#99544b", landmarks, request.seed, masks
    )
    gb_vertices, gb_faces, gb_uv, gb_lm, lumen, wall = _gallbladder(
        parameters,
        rings // 2,
        segments // 2,
        request.wall_thickness_mm,
        vertices,
        faces,
        landmarks["gallbladder_fossa"],
    )
    gb = _mesh_output(
        "gallbladder",
        "Gallbladder",
        gb_vertices,
        gb_faces,
        gb_uv,
        "#8d9870",
        gb_lm,
        request.seed + 1,
    )
    gb["lumen"] = {
        "positions": np.round(lumen, 6).reshape(-1).tolist(),
        "indices": gb_faces[:, [0, 2, 1]].reshape(-1).tolist(),
        "semantic": "sealed_authored_lumen_approximation",
    }
    gb["metadata"]["metrics"].update(wall)
    gb["metadata"]["representation"] = "outer_and_homothetic_inner_surfaces"
    gb["metadata"]["limitations"].extend(
        [
            "Effective homogeneous wall; requested wall value is a shrink scale, not constant thickness.",
            "Lumen sealed by authored neck cap; no fluid/pressure solver or duct junction.",
            "Authored fossa placement has 0.8 mm geometric clearance; real attachment anatomy is unreviewed.",
        ]
    )
    organs = [liver, gb]
    vessel_meshes, graph = (
        _display_graph(landmarks, gb_lm) if request.include_vessels else ([], None)
    )
    checks = []
    for organ in organs:
        m = organ["metadata"]["metrics"]
        checks.append(
            {
                "id": f"surface-validity:{organ['id']}",
                "result": "PASS"
                if m["watertight"]
                and m["finite"]
                and m["signed_volume_ml"] > 0
                and not m["degenerate_triangle_count"]
                else "FAIL",
                "scope": "finite_indexed_oriented_closed_surface",
                "metrics": m,
            }
        )
    gap = wall["liver_clearance_mm"]
    checks.append(
        {
            "id": "organ-surface-separation",
            "result": "PASS" if gap >= 0 else "FAIL",
            "value_mm": gap,
            "method": "full_projected_triangle_overlap_arrangement_vertical_clearance_v1",
            "scope": "liver_gallbladder_only_excludes_display_tubes",
            "numerical_tolerance_mm": 1e-6,
        }
    )
    checks.extend(
        [
            {"id": "independent-anatomical-review", "result": "NOT_RUN"},
            {"id": "self-intersection-exact-predicates", "result": "NOT_RUN"},
            {"id": "simulation-readiness", "result": "NOT_RUN"},
        ]
    )
    passed = all(c["result"] != "FAIL" for c in checks)
    lm = liver["metadata"]["metrics"]
    gm = gb["metadata"]["metrics"]
    measurements = {
        "liver_volume_ml": lm["volume_ml"],
        "liver_width_mm": lm["width_mm"],
        "liver_height_mm": lm["height_mm"],
        "liver_depth_mm": lm["depth_mm"],
        "gallbladder_enclosed_ml": gm["volume_ml"],
        "gallbladder_lumen_ml": gm["lumen_volume_ml"],
        "gallbladder_length_mm": wall["neck_to_fundus_distance_mm"],
        "organ_clearance_mm": gap,
    }
    scene: dict[str, Any] = {
        "schemaVersion": "0.1.0",
        "spec": request.model_dump(),
        "parameters": parameters,
        "organs": organs,
        "vessels": vessel_meshes,
        "anatomical_graph": graph,
        "measurements": measurements,
        "gate": {
            "profile": "development_preview",
            "passed": passed,
            "checks": checks,
            "anatomical_validity": "not_evaluated",
            "simulation_verified": False,
        },
        "qa": {"passed": passed, "profile": "development_preview"},
        "metadata": {
            "generator_version": GENERATOR_VERSION,
            "lineage_id": LINEAGE_ID,
            "resolution": resolution,
            "coordinate_frame": "RAS+",
            "units": "mm",
            "origin": "authored_scene_anchor",
            "profile": "development_preview",
            "review_status": "unreviewed",
            "source": "original_procedural_construction",
            "seed": request.seed,
            "supported_families": ["liver", "gallbladder"],
            "independent_design_count": 1,
            "scientific_claim": "Deterministic original surface-geometry pilot; no empirical or expert validation.",
            "feature_limitations": [
                "Anatomical feature names denote authored targets, not verified homology.",
                "No Couinaud segmentation, microanatomy or validated physical organ model is supplied.",
                "UVs are parameter coordinates with a periodic seam, not a distortion-validated atlas.",
            ],
        },
    }
    if include_simulation:
        scene["simulation"] = create_simulation_proxy(parameters, liver["positions"])
        scene["metadata"]["simulation_representation"] = (
            "coarse_positive_star_fan_for_approximate_preview"
        )
    scene["content_hash"] = canonical_hash(scene)
    return scene
