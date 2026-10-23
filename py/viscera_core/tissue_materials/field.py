"""Periodic multiscale tissue fields and independent straight-alpha appearance layers.

All palette values are illustrative. Thickness is a rendering proxy, not a measured
optical path, wall thickness or source of biomechanics. No training data are used.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from scipy.ndimage import map_coordinates

from .appearance import ChromaticFields, profile_appearance
from .recipe import ORGAN_PROFILES, TissueRecipe
from .vascular import vessel_tiles


def srgb_to_linear(value: np.ndarray) -> np.ndarray:
    value = np.asarray(value, dtype=np.float32)
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(value: np.ndarray) -> np.ndarray:
    value = np.clip(value, 0, 1)
    return np.where(value <= 0.0031308, 12.92 * value, 1.055 * value ** (1 / 2.4) - 0.055)


def over_linear(base: np.ndarray, rgba_srgb: np.ndarray, opacity: float = 1.0) -> np.ndarray:
    """Composite straight sRGB RGB with linear coverage onto a linear RGB base."""
    alpha = rgba_srgb[..., 3:4] * opacity
    return base * (1 - alpha) + srgb_to_linear(rgba_srgb[..., :3]) * alpha


def _smooth(a: float, b: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


@lru_cache(maxsize=96)
def _lattice(seed: int, count: int, salt: int) -> np.ndarray:
    # SeedSequence consumes all 64 seed bits. No JS-style float coercion or truncation.
    rng = np.random.default_rng(np.random.SeedSequence([seed, salt]))
    result = rng.uniform(-1, 1, (count, count)).astype(np.float32)
    result.setflags(write=False)
    return result


def _noise(u: np.ndarray, v: np.ndarray, count: int, seed: int, salt: int) -> np.ndarray:
    x = np.remainder(u, 1) * count
    y = np.remainder(v, 1) * count
    ix, iy = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
    fx, fy = x - ix, y - iy
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    grid = _lattice(seed, count, salt)
    a, b = grid[iy % count, ix % count], grid[iy % count, (ix + 1) % count]
    c, d = grid[(iy + 1) % count, ix % count], grid[(iy + 1) % count, (ix + 1) % count]
    return ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy).astype(np.float32)


def _cells(u: np.ndarray, v: np.ndarray, count: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Periodic jittered Voronoi cells: nearest distance and inter-cell gap."""
    x, y = np.remainder(u, 1) * count, np.remainder(v, 1) * count
    ix, iy = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
    first = np.full(x.shape, 9.0, dtype=np.float32)
    second = first.copy()
    jitter_x, jitter_y = _lattice(seed, count, 81), _lattice(seed, count, 82)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cx, cy = (ix + dx) % count, (iy + dy) % count
            px = ix + dx + 0.5 + 0.38 * jitter_x[cy, cx]
            py = iy + dy + 0.5 + 0.38 * jitter_y[cy, cx]
            dist = ((x - px) ** 2 + (y - py) ** 2).astype(np.float32)
            second = np.minimum(second, np.maximum(first, dist))
            first = np.minimum(first, dist)
    return np.sqrt(first), np.sqrt(second) - np.sqrt(first)


def _smooth_tufts(u: np.ndarray, v: np.ndarray, count: int, seed: int) -> np.ndarray:
    """Periodic C2 compact-support bumps, without nearest-site slope switches.

    Each jittered site lies in [.12,.88] of its cell. A support radius of one
    cell means every contributing site is in the 3x3 stencil; excluded sites
    remain at least 1.12 cells away when the floor/stencil changes. The cubic
    kernel and its first two derivatives vanish at the support boundary.
    """
    u, v = np.broadcast_arrays(np.asarray(u, dtype=np.float64), np.asarray(v, dtype=np.float64))
    x, y = np.remainder(u, 1) * count, np.remainder(v, 1) * count
    ix, iy = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
    total = np.zeros(x.shape, dtype=np.float64)
    jitter_x, jitter_y = _lattice(seed, count, 81), _lattice(seed, count, 82)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cx, cy = (ix + dx) % count, (iy + dy) % count
            px = ix + dx + 0.5 + 0.38 * jitter_x[cy, cx]
            py = iy + dy + 0.5 + 0.38 * jitter_y[cy, cx]
            distance_squared = (x - px) ** 2 + (y - py) ** 2
            total += np.maximum(1 - distance_squared, 0) ** 3
    # Smooth bounding preserves the derivative at overlapping tufts; hard
    # clipping or selecting the nearest site would reintroduce crease normals.
    return -np.expm1(-1.3 * total)


def _sample_tile(tile: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    coordinates = np.stack(
        (np.remainder(v, 1) * tile.shape[0] - 0.5, np.remainder(u, 1) * tile.shape[1] - 0.5)
    )
    return map_coordinates(
        tile, coordinates.reshape(2, -1), order=1, mode="grid-wrap", prefilter=False
    ).reshape(u.shape)


@dataclass
class TissueFields:
    substrate_linear: np.ndarray
    base_color_linear: np.ndarray
    roughness: np.ndarray
    height_mm: np.ndarray
    thickness_mm: np.ndarray
    layers: dict[str, np.ndarray]
    transition: np.ndarray
    substrate_height_mm: np.ndarray
    layer_height_mm: dict[str, np.ndarray]
    substrate_roughness: np.ndarray


def sample_tissue(
    recipe: TissueRecipe, u: np.ndarray, v: np.ndarray, *, footprint_mm: float = 0.0
) -> TissueFields:
    """Sample arbitrary matching/broadcast UV arrays; output colors are linear.

    The tile repeats in U and V. Pixel centers are the export convention. Lower
    frequencies survive coarse previews; subpixel detail is smoothly attenuated.
    Consumers should batch large point sets to bound temporary allocations.
    """
    if not isinstance(recipe, TissueRecipe):
        raise TypeError("recipe must be a TissueRecipe")
    if not np.isfinite(footprint_mm) or footprint_mm < 0:
        raise ValueError("footprint_mm must be finite and nonnegative")
    u, v = np.broadcast_arrays(np.asarray(u, dtype=np.float64), np.asarray(v, dtype=np.float64))
    if not (np.isfinite(u).all() and np.isfinite(v).all()):
        raise ValueError("UV coordinates must be finite")
    # Reducing to the torus first preserves translations and avoids huge integer indexes.
    u, v = np.remainder(u, 1).astype(np.float32), np.remainder(v, 1).astype(np.float32)
    seed, scale = recipe.seed, recipe.tile_size_mm
    macro = 0.68 * _noise(u, v, 4, seed, 1) + 0.32 * _noise(u, v, 9, seed, 2)
    wu = u + 0.022 * _noise(u, v, 5, seed, 3) + 0.012 * _noise(u, v, 19, seed, 14)
    wv = v + 0.020 * _noise(u, v, 6, seed, 4) + 0.012 * _noise(u, v, 17, seed, 15)
    meso = _noise(wu, wv, max(8, round(scale / 2.4)), seed, 5)
    micro_count = max(16, min(768, round(scale / 0.22)))
    attenuation = float(np.clip(scale / micro_count / max(footprint_mm * 3, 1e-8), 0, 1))
    micro = _noise(wu, wv, micro_count, seed, 6) * attenuation
    micro += 0.30 * _noise(u, v, min(1024, micro_count * 2), seed, 7) * attenuation**2
    # Integer transforms preserve periodicity without artificial sinusoidal
    # contour tracks. Warped anisotropic noise supplies interrupted fibers.
    fiber = _noise(11 * u + 2 * v + 0.2 * macro, v + 0.1 * meso, 12, seed, 31)
    fiber *= attenuation
    chromatic = ChromaticFields(
        0.55 * _noise(wu, wv, 6, seed, 101)
        + 0.30 * _noise(wu, wv, 17, seed, 102)
        + 0.15 * _noise(wu, wv, 49, seed, 103),
        0.65 * _noise(wu, wv, 9, seed, 104) + 0.35 * _noise(wu, wv, 29, seed, 105),
        0.70 * _noise(wu, wv, 5, seed, 106) + 0.30 * _noise(wu, wv, 23, seed, 107),
    )
    folds = np.sin(2 * np.pi * (4 * u + 2 * v) + 1.6 * _noise(u, v, 7, seed, 32))
    folds = 0.65 * folds + 0.35 * _noise(wu, wv, 13, seed, 33)
    pits = (
        _smooth(0.18, 0.80, _noise(wu, wv, max(24, min(512, round(scale / 0.55))), seed, 34))
        * attenuation
    )
    primary = ORGAN_PROFILES[recipe.organ]
    cell_count = max(5, min(128, round(scale / primary.lobule_mm)))
    radius, gap = _cells(wu, wv, cell_count, seed)
    tufts = _smooth_tufts(wu, wv, cell_count, seed) if primary.structure == "villi" else None
    substrate_srgb, height = profile_appearance(
        primary,
        macro,
        meso,
        micro,
        fiber,
        folds,
        pits,
        gap,
        radius,
        chromatic,
        recipe.detail,
        tufts=tufts,
    )
    substrate = srgb_to_linear(substrate_srgb)
    transition = np.zeros(u.shape, dtype=np.float32)
    roughness = np.full(u.shape, primary.roughness, dtype=np.float32)
    thickness = primary.thickness_mm * (1 + 0.15 * macro + 0.06 * meso)
    vascularity = np.full(u.shape, primary.vascularity, dtype=np.float32)
    if recipe.transition_organ:
        other = ORGAN_PROFILES[recipe.transition_organ]
        boundary = 0.5 + 0.5 * np.sin(2 * np.pi * u + 0.35 * _noise(u, v, 3, seed, 12))
        transition = _smooth(0.5 - recipe.transition_width, 0.5 + recipe.transition_width, boundary)
        other_radius, other_gap = _cells(
            wu, wv, max(5, min(128, round(scale / other.lobule_mm))), seed
        )
        other_tufts = (
            _smooth_tufts(wu, wv, max(5, min(128, round(scale / other.lobule_mm))), seed)
            if other.structure == "villi"
            else None
        )
        other_srgb, other_height = profile_appearance(
            other,
            macro,
            meso,
            micro,
            fiber,
            folds,
            pits,
            other_gap,
            other_radius,
            chromatic,
            recipe.detail,
            tufts=other_tufts,
        )
        other_color = srgb_to_linear(other_srgb)
        substrate = substrate * (1 - transition[..., None]) + other_color * transition[..., None]
        height = height * (1 - transition) + other_height * transition
        roughness += (other.roughness - primary.roughness) * transition
        thickness = (
            thickness * (1 - transition)
            + other.thickness_mm * (1 + 0.15 * macro + 0.06 * meso) * transition
        )
        vascularity += (other.vascularity - primary.vascularity) * transition

    # Stable per-family salt avoids identical vascular layouts across all organs.
    vascular_seed = seed ^ int.from_bytes(
        hashlib.sha256(recipe.organ.encode()).digest()[:8], "little"
    )
    artery_tile, vein_tile, relief_tile = vessel_tiles(vascular_seed)
    artery, vein = _sample_tile(artery_tile, u, v), _sample_tile(vein_tile, u, v)
    vessel_alpha = np.clip((artery + vein) * vascularity * 0.82, 0, 0.85)
    # Embedded absorption is relative to local tissue chroma: no black painted
    # twig lines, highlights, or assumption that camera RGB is diffuse albedo.
    mix = vein / np.maximum(artery + vein, 1e-6)
    vessel_color = linear_to_srgb(substrate) * (
        np.array([0.96, 0.64, 0.66], dtype=np.float32) * (1 - mix[..., None])
        + np.array([0.79, 0.71, 0.88], dtype=np.float32) * mix[..., None]
    )
    vessels = np.concatenate((vessel_color, vessel_alpha[..., None]), axis=-1)
    vessel_relief = _sample_tile(relief_tile, u, v) * vascularity

    fascia_patches = _smooth(
        -0.02, 0.55, _noise(u, v, 13, seed, 38) + 0.3 * _noise(u, v, 37, seed, 39)
    )
    fascia_alpha = np.clip(
        _smooth(0.05, 0.65, fiber) * fascia_patches * 0.42 + 0.025 * _smooth(-0.3, 0.7, macro),
        0,
        1,
    )
    fascia_color = np.broadcast_to(np.array([0.89, 0.84, 0.75], dtype=np.float32), (*u.shape, 3))
    fascia = np.concatenate((fascia_color, fascia_alpha[..., None]), axis=-1)

    adipose_radius, adipose_gap = _cells(wu, wv, max(5, min(100, round(scale / 4.0))), seed + 41)
    adipose_septa = np.exp(-adipose_gap * 15)
    adipose_alpha = _smooth(-0.12, 0.35, _noise(u, v, 5, seed, 44)) * (
        0.74 + 0.20 * (1 - adipose_septa)
    )
    adipose_color = np.empty((*u.shape, 3), dtype=np.float32)
    adipose_color[:] = np.array([0.90, 0.75, 0.45], dtype=np.float32)
    adipose_color += (0.045 * meso + 0.065 * adipose_septa - 0.025 * adipose_radius)[..., None]
    adipose = np.concatenate((np.clip(adipose_color, 0, 1), adipose_alpha[..., None]), axis=-1)

    wet_coverage = np.clip(0.77 + 0.15 * macro + 0.08 * meso, 0, 1)
    wet = np.concatenate(
        (np.ones((*u.shape, 3), dtype=np.float32), wet_coverage[..., None]), axis=-1
    )
    layers = {"vessels": vessels, "adipose": adipose, "fascia": fascia, "wet_film": wet}
    composite = substrate.copy()
    for name, opacity in (
        ("vessels", recipe.vessel_opacity),
        ("adipose", recipe.adipose_opacity),
        ("fascia", recipe.fascia_opacity),
    ):
        composite = over_linear(composite, layers[name], opacity)
    substrate_height = height.copy()
    layer_height = {
        "vessels": vessel_relief * 0.035,
        "fascia": fascia_alpha * 0.035,
        "adipose": adipose_alpha * np.clip(1 - adipose_radius, 0, 1) * 0.45,
    }
    height += recipe.vessel_opacity * layer_height["vessels"]
    height += recipe.fascia_opacity * layer_height["fascia"]
    height += recipe.adipose_opacity * layer_height["adipose"]
    roughness += 0.025 * meso + 0.009 * micro
    substrate_roughness = roughness.copy()
    roughness += 0.10 * fascia_alpha * recipe.fascia_opacity
    roughness *= 1 - 0.57 * recipe.wetness * wet_coverage
    return TissueFields(
        substrate,
        composite,
        np.clip(roughness, 0.075, 0.85),
        height,
        np.clip(thickness + recipe.adipose_opacity * adipose_alpha * 0.9, 0.1, 6),
        layers,
        transition,
        substrate_height,
        layer_height,
        substrate_roughness,
    )
