"""Deterministic surface vessel appearance shared with Studio's WebGL shader.

This is a procedural design layer, not a patient vascular reconstruction or a
physiological perfusion simulation. Coordinates and radii are in template mm.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

VESSEL_VERSION = "surface-vessels-design-1.0.0"
ARTERY_LINEAR = np.array([0.1626471937, 0.0134117489, 0.0196066485])
VEIN_LINEAR = np.array([0.0732389559, 0.0196066485, 0.0396819095])
MAX_SEGMENTS = 20000


def _number(value: Any, minimum: float, maximum: float) -> bool:
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value) and minimum <= value <= maximum


def _vector(value: Any, bound: float) -> bool:
    return isinstance(value, list) and len(value) == 3 and all(_number(v, -bound, bound) for v in value)


def validate_network(network: Any) -> dict[str, Any]:
    """Validate the serialized contract before any 4K allocation or GPU upload."""
    if not isinstance(network, dict) or network.get("version") != VESSEL_VERSION:
        raise ValueError("Unsupported surface vessel network version.")
    if not isinstance(network.get("organ_id"), str) or not network["organ_id"] or len(network["organ_id"]) > 200:
        raise ValueError("Surface vessels require an organ identity.")
    if not _number(network.get("seed"), 0, 4294967295) or int(network["seed"]) != network["seed"]:
        raise ValueError("Surface vessels require an unsigned integer seed.")
    if network.get("provenance") != "procedural-surface-design-not-patient-vasculature":
        raise ValueError("Surface vessels require their procedural design provenance.")
    settings = network.get("settings")
    if not isinstance(settings, dict) or not _number(settings.get("density"), 0, 1) or not _number(settings.get("visibility"), 0, 1) or not _number(settings.get("radius_scale"), 0.4, 2.5):
        raise ValueError("Surface vessel settings are outside the supported range.")
    segments = network.get("segments")
    if not isinstance(segments, list) or len(segments) > MAX_SEGMENTS:
        raise ValueError("Surface vessel segment count exceeds the supported budget.")
    for segment in segments:
        if not isinstance(segment, dict) or not _vector(segment.get("a_mm"), 100000) or not _vector(segment.get("b_mm"), 100000) or not _vector(segment.get("normal"), 1.00001):
            raise ValueError("Surface vessels require finite endpoints and surface normals.")
        normal_length = sum(v * v for v in segment["normal"])
        if abs(normal_length - 1) > 0.005 or sum((b - a) ** 2 for a, b in zip(segment["a_mm"], segment["b_mm"])) <= 1e-12:
            raise ValueError("Surface vessel normals must be unit length and segments nondegenerate.")
        if not _number(segment.get("radius_a_mm"), 0.000001, 20) or not _number(segment.get("radius_b_mm"), 0.000001, 20) or not _number(segment.get("depth_mm"), 0.01, 10) or type(segment.get("kind")) is not int or segment["kind"] not in (0, 1):
            raise ValueError("Surface vessel radii, depth, or palette are invalid.")
        for key in ("a_anchor", "b_anchor"):
            anchor = segment.get(key)
            if not isinstance(anchor, dict) or type(anchor.get("triangle")) is not int or not 0 <= anchor["triangle"] <= 10000000 or not _vector(anchor.get("weights"), 1.00001) or min(anchor["weights"]) < -0.00001 or abs(sum(anchor["weights"]) - 1) > 0.00001:
                raise ValueError("Surface vessels require valid triangle and barycentric attachments.")
    return network


def sample_vessels(rest_mm: np.ndarray, normal_rest: np.ndarray, network: dict[str, Any], footprint_mm: float | np.ndarray = 0.0) -> dict[str, np.ndarray]:
    """Evaluate compact, depth-softened fields with conservative spatial culling.

    MAX union (not addition) keeps connected junctions from forming dark blobs.
    Opposite-facing surfaces suppress through-wall projection. The two Gaussian
    widths are an appearance approximation, not a calibrated scattering model.
    The returned gradient is the radial bump gradient (radius variation is not
    differentiated), deliberately matching the preview shader.
    """
    points = np.asarray(rest_mm, dtype=np.float64)
    normals = np.asarray(normal_rest, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 3 or normals.shape != points.shape or not np.isfinite(points).all() or not np.isfinite(normals).all():
        raise ValueError("Vessel samples need finite Nx3 rest points and rest normals.")
    n = len(points)
    output = {"artery": np.zeros(n), "vein": np.zeros(n), "core": np.zeros(n), "height_mm": np.zeros(n), "gradient_rest": np.zeros((n, 3))}
    visibility = network["settings"]["visibility"]
    segments = network["segments"]
    if not n or not segments or not visibility:
        return output
    footprint = np.broadcast_to(np.asarray(footprint_mm, dtype=np.float64), (n,))
    if not np.isfinite(footprint).all() or np.any(footprint < 0):
        raise ValueError("Vessel sample footprints must be finite and nonnegative.")
    # Query sample points in a conservative sphere around each segment. The exact
    # capsule support and facing tests follow below; no nearest-k truncation.
    a = np.asarray([s["a_mm"] for s in segments])
    b = np.asarray([s["b_mm"] for s in segments])
    ra = np.asarray([s["radius_a_mm"] for s in segments])
    rb = np.asarray([s["radius_b_mm"] for s in segments])
    depths = np.asarray([s["depth_mm"] for s in segments])
    supports = 2 * (np.maximum(ra, rb) * 2.3 + 0.7 * depths)
    candidates = cKDTree(points).query_ball_point((a + b) * 0.5, np.linalg.norm(b - a, axis=1) * 0.5 + supports)
    for i, rows in enumerate(candidates):
        if not rows:
            continue
        ids = np.asarray(rows, dtype=np.intp)
        segment = segments[i]
        axis = b[i] - a[i]
        offset = points[ids] - a[i]
        t = np.clip(offset @ axis / max(float(axis @ axis), 1e-12), 0, 1)
        delta = offset - t[:, None] * axis
        d2 = np.einsum("ij,ij->i", delta, delta)
        radius = ra[i] * (1 - t) + rb[i] * t
        depth = depths[i]
        halo_width = radius * 2.3 + 0.7 * depth
        alignment = np.clip((normals[ids] @ np.asarray(segment["normal"]) - 0.15) / 0.4, 0, 1)
        alignment = alignment * alignment * (3 - 2 * alignment)
        valid = (d2 <= 4 * halo_width * halo_width) & (alignment > 0)
        if not np.any(valid):
            continue
        ids, delta, d2, radius, halo_width, alignment = (v[valid] for v in (ids, delta, d2, radius, halo_width, alignment))
        w = radius + 0.2 * depth
        w2 = w * w + 0.2 * footprint[ids] ** 2
        core = np.exp(-2 * d2 / w2 - 0.8 * depth) * alignment * w / np.sqrt(w2)
        halo = np.exp(-2 * d2 / (halo_width * halo_width) - 0.8 * depth) * alignment
        opacity = visibility * (0.62 * core + 0.12 * halo)
        palette = "artery" if segment["kind"] == 0 else "vein"
        output[palette][ids] = np.maximum(output[palette][ids], opacity)
        output["core"][ids] = np.maximum(output["core"][ids], core * visibility)
        height = 0.1 * radius * core * visibility
        higher = height > output["height_mm"][ids]
        selected = ids[higher]
        output["height_mm"][selected] = height[higher]
        output["gradient_rest"][selected] = -4 * delta[higher] * (height[higher] / w2[higher])[:, None]
    return output


def apply_vessel_appearance(base_linear: np.ndarray, roughness: np.ndarray, rest_mm: np.ndarray, normal_rest: np.ndarray,
                            network: dict[str, Any], footprint_mm: float | np.ndarray = 0.0) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return (linear RGB, roughness, relief mm, radial rest gradient)."""
    fields = sample_vessels(rest_mm, normal_rest, network, footprint_mm)
    artery, vein = fields["artery"][:, None], fields["vein"][:, None]
    color = np.asarray(base_linear) * (1 - artery) + ARTERY_LINEAR * artery
    color = color * (1 - vein) + VEIN_LINEAR * vein
    rough = np.clip(np.asarray(roughness) - 0.035 * fields["core"], 0.16, 0.9)
    return color, rough, fields["height_mm"], fields["gradient_rest"]
