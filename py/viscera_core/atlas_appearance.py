"""Deterministic, physically scaled *authored* appearance for atlas display meshes.

These profiles are art-direction heuristics. They do not estimate living-tissue
optics, disease state, stiffness, or specimen identity from atlas geometry.
Noise is evaluated on rest coordinates, so color follows the deformed surface.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import numpy.typing as npt

APPEARANCE_VERSION = "atlas-authored-tissue-1.0.0"
PROFILES: dict[str, dict[str, Any]] = {
    "liver": {"color": "#793f37", "variation": 0.065, "roughness": 0.38, "clearcoat": 0.28},
    "gallbladder": {"color": "#777953", "variation": 0.045, "roughness": 0.34, "clearcoat": 0.32},
    "stomach": {"color": "#b58a80", "variation": 0.045, "roughness": 0.43, "clearcoat": 0.22},
    "pancreas": {"color": "#bc9b80", "variation": 0.060, "roughness": 0.51, "clearcoat": 0.14},
    "spleen": {"color": "#713e52", "variation": 0.060, "roughness": 0.37, "clearcoat": 0.27},
    "kidney": {"color": "#a15c50", "variation": 0.055, "roughness": 0.36, "clearcoat": 0.28},
    "small-intestine": {
        "color": "#c09a89",
        "variation": 0.040,
        "roughness": 0.40,
        "clearcoat": 0.25,
    },
    "large-intestine": {
        "color": "#b89784",
        "variation": 0.040,
        "roughness": 0.43,
        "clearcoat": 0.22,
    },
    "heart": {"color": "#9d5e58", "variation": 0.050, "roughness": 0.42, "clearcoat": 0.20},
    "lung": {"color": "#b5979b", "variation": 0.035, "roughness": 0.50, "clearcoat": 0.15},
    "brain": {"color": "#b8ada1", "variation": 0.025, "roughness": 0.51, "clearcoat": 0.12},
    "urinary-bladder": {
        "color": "#b9958b",
        "variation": 0.040,
        "roughness": 0.42,
        "clearcoat": 0.23,
    },
}


def _rgb(hex_color: str) -> npt.NDArray[np.float64]:
    return np.array([int(hex_color[i : i + 2], 16) / 255 for i in (1, 3, 5)], dtype=np.float64)


def _lattice(x: npt.NDArray[np.int64], seed: int) -> npt.NDArray[np.float64]:
    # uint64 intermediates keep intentional 32-bit mixing away from overflow warnings.
    u = x.astype(np.uint64) & np.uint64(0xFFFFFFFF)
    h = (u[:, 0] * 73856093) ^ (u[:, 1] * 19349663) ^ (u[:, 2] * 83492791) ^ np.uint64(seed)
    h &= np.uint64(0xFFFFFFFF)
    h ^= h >> np.uint64(16)
    h = (h * np.uint64(2246822519)) & np.uint64(0xFFFFFFFF)
    h ^= h >> np.uint64(13)
    return np.asarray(h.astype(np.float64) / 4294967295.0, dtype=np.float64)


def value_noise(
    points: npt.NDArray[np.float64], scale_mm: float, seed: int
) -> npt.NDArray[np.float64]:
    q = points / scale_mm
    cell = np.floor(q).astype(np.int64)
    fraction = q - cell
    s = fraction * fraction * (3 - 2 * fraction)
    result = np.zeros(len(q), dtype=np.float64)
    for ix in (0, 1):
        for iy in (0, 1):
            for iz in (0, 1):
                corner = np.array([ix, iy, iz])
                weights = np.prod(np.where(corner, s, 1 - s), axis=1)
                result += _lattice(cell + corner, seed) * weights
    return result * 2 - 1


def appearance(
    organ: str,
    rest_vertices_mm: npt.NDArray[np.float64],
    source_colors: npt.NDArray[np.float64],
    seed: int,
    mode: str = "tissue",
    component_ids: npt.NDArray[np.int64] | None = None,
    components: list[dict[str, Any]] | None = None,
) -> tuple[npt.NDArray[np.float64], dict[str, Any]]:
    if organ not in PROFILES:
        raise ValueError(f"No declared appearance profile for {organ!r}")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Appearance seed must be uint32")
    vertices = np.asarray(rest_vertices_mm, dtype=np.float64)
    source = np.asarray(source_colors, dtype=np.float64)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or source.shape != vertices.shape:
        raise ValueError("Appearance arrays must align N by 3")
    if (
        not np.isfinite(vertices).all()
        or not np.isfinite(source).all()
        or ((source < 0) | (source > 1)).any()
    ):
        raise ValueError("Appearance requires finite coordinates and sRGB source colors in [0,1]")
    profile = PROFILES[organ]
    meta: dict[str, Any] = {
        "version": APPEARANCE_VERSION,
        "mode": mode,
        "seed": seed,
        "color_space": "sRGB",
        "coordinates": "template_rest_mm",
        "roughness": profile["roughness"],
        "clearcoat": profile["clearcoat"],
        "clearcoat_roughness": 0.28,
        "metalness": 0.0,
        "evidence": "design_heuristic",
        "optical_validation": "NOT_RUN",
        "detail_scales_mm": [18.0, 4.0, 0.7],
        "mechanical_parameters_inferred": False,
    }
    if mode == "source":
        return source.copy(), {
            **meta,
            "roughness": 0.5,
            "clearcoat": 0.0,
            "evidence": "source_display_colors; rendering_heuristic",
        }
    if mode == "clay":
        return np.tile(_rgb("#81928f"), (len(vertices), 1)), {
            **meta,
            "roughness": 0.85,
            "clearcoat": 0.0,
        }
    if mode != "tissue":
        raise ValueError("Appearance must be source, tissue, or clay")
    field = (
        0.55 * value_noise(vertices, 18, seed ^ 137)
        + 0.35 * value_noise(vertices, 4, seed ^ 509)
        + 0.10 * value_noise(vertices, 0.7, seed ^ 2017)
    )
    base = np.tile(_rgb(profile["color"]), (len(vertices), 1))
    if component_ids is not None and components:
        for i, comp in enumerate(components):
            if "ligament" in comp.get("name", "").lower():
                base[np.asarray(component_ids) == i] = _rgb("#beb09b")
    # Low amplitude colored variation, never geometric lesions or invented vessels.
    colors = np.clip(base + field[:, None] * profile["variation"] * np.array([1.0, 0.8, 0.7]), 0, 1)
    return colors, meta
