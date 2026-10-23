"""Separate authored chromatic variation from geometric tissue microstructure.

Reference photographs inform qualitative features only. Their illumination,
camera response, white balance, pathology and scale are not calibrated albedo.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .recipe import OrganProfile


@dataclass(frozen=True)
class ChromaticFields:
    perfusion: np.ndarray
    pale: np.ndarray
    cool: np.ndarray


def profile_appearance(
    profile: OrganProfile,
    macro: np.ndarray,
    meso: np.ndarray,
    micro: np.ndarray,
    fiber: np.ndarray,
    folds: np.ndarray,
    pits: np.ndarray,
    gap: np.ndarray,
    radius: np.ndarray,
    chromatic: ChromaticFields,
    detail: float,
    *,
    tufts: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Return sRGB diffuse color and millimeter relief, without baked lighting.

    The small relief amplitudes intentionally leave gross folds and organ shape
    to geometry. Chromatic channels are independent rather than tinted noise.
    """
    septa = np.exp(-gap * 19)
    bump = np.clip(1 - radius, 0, 1)
    structure = profile.structure
    tone = 0.065 * macro + 0.025 * meso + 0.007 * micro
    if structure == "mucosa":
        tone += 0.009 * folds - 0.009 * pits
        relief = 0.14 * folds + 0.035 * meso - 0.018 * pits + 0.007 * micro
    elif structure == "villi":
        if tufts is None:
            raise ValueError("Villi appearance requires the smooth periodic tuft field")
        tone += 0.020 * tufts + 0.007 * folds
        relief = 0.21 * tufts + 0.10 * folds + 0.012 * micro
    elif structure == "glandular":
        lobules = np.exp(-radius * radius * 2.8)
        tone += 0.028 * lobules - 0.006 * septa
        relief = 0.32 * lobules - 0.025 * septa + 0.025 * micro
    elif structure == "lung":
        tone -= 0.038 * septa
        relief = 0.25 * bump - 0.06 * septa + 0.025 * micro
    elif structure == "muscle":
        tone += 0.030 * fiber
        relief = 0.24 * fiber + 0.10 * meso + 0.020 * micro
    elif structure == "fascia":
        tone = 0.035 * macro + 0.018 * meso + 0.030 * fiber + 0.004 * micro
        relief = 0.22 * fiber + 0.07 * meso + 0.018 * micro
    elif structure == "serosa":
        relief = 0.08 * fiber + 0.11 * meso + 0.014 * micro
    else:
        tone -= 0.006 * septa
        relief = 0.12 * bump + 0.12 * meso + 0.018 * micro

    color = np.asarray(profile.color, dtype=np.float32) + tone[..., None] * np.array(
        [0.95, 0.83, 0.77], dtype=np.float32
    )
    # Non-collinear warm blood-rich, pale cream and cool undertone axes. They
    # are authored RGB variation, not absorption coefficients or perfusion data.
    chroma_strength = 0.6 if structure == "fascia" else 1.0
    color += chroma_strength * (
        chromatic.perfusion[..., None] * np.array([0.065, -0.032, -0.022], dtype=np.float32)
        + chromatic.pale[..., None] * np.array([0.045, 0.063, 0.032], dtype=np.float32)
        + chromatic.cool[..., None] * np.array([-0.012, -0.014, 0.043], dtype=np.float32)
    )
    return np.clip(color, 0.025, 0.95), relief * profile.relief_mm * detail
