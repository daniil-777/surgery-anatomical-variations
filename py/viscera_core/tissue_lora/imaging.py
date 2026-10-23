"""Native-pixel crop selection, glint handling and illumination flattening.

These are documented heuristics on observed surgical RGB. They remove smooth
lighting gradients and clipped highlights so a generator learns tissue
appearance rather than lamp falloff; they do not recover measured albedo.
"""

from __future__ import annotations

import numpy as np
from scipy import ndimage

CROP_SIZES = (512, 448, 384, 320, 256)
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def srgb_to_linear(u8: np.ndarray) -> np.ndarray:
    x = np.asarray(u8, dtype=np.float32) / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb_u8(linear: np.ndarray) -> np.ndarray:
    x = np.clip(np.asarray(linear, dtype=np.float32), 0.0, 1.0)
    s = np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    return np.rint(np.clip(s, 0, 1) * 255).astype(np.uint8)


def glint_mask(rgb_u8: np.ndarray, *, neutral_max: int = 245, neutral_min: int = 180,
               neutral_spread: float = 0.35, luminance_u8: int = 236, dilate: int = 2,
               local_contrast: bool = False, speck_sigma: float = 6.0, speck_delta: float = 40.0,
               speck_floor_u8: int = 150) -> np.ndarray:
    """Clipped neutral highlights plus very bright pixels, dilated; True = glint.

    glint-v2 (local_contrast=True) also flags small wet specks: pixels brighter than their
    Gaussian-local mean by speck_delta and above speck_floor_u8. The v1 pilot learned to paint
    such specks because they survived the clipped-only rule.
    """
    rgb = np.asarray(rgb_u8)
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
        raise ValueError("expected an HxWx3 uint8 image")
    high, low = rgb.max(axis=2).astype(np.int32), rgb.min(axis=2).astype(np.int32)
    neutral = (high >= neutral_max) & (low >= neutral_min) & ((high - low) <= neutral_spread * np.maximum(high, 1))
    luminance = rgb.astype(np.float32) @ LUMA
    mask = neutral | (luminance >= luminance_u8)
    if local_contrast:
        local = ndimage.gaussian_filter(luminance, speck_sigma)
        mask |= (luminance >= speck_floor_u8) & (luminance - local >= speck_delta)
    if dilate > 0 and mask.any():
        mask = ndimage.binary_dilation(mask, iterations=dilate)
    return mask


def window_sums(mask: np.ndarray, size: int) -> np.ndarray:
    if type(size) is not int or size < 1 or min(mask.shape) < size:
        raise ValueError("window exceeds mask dimensions")
    integral = np.pad(mask.astype(np.int32), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    return integral[size:, size:] - integral[:-size, size:] - integral[size:, :-size] + integral[:-size, :-size]


def candidate_windows(valid: np.ndarray, *, sizes: tuple[int, ...] = CROP_SIZES,
                      min_valid: float = 0.92, max_windows: int = 4) -> list[dict]:
    """Greedy, non-overlapping square windows at native pixels, largest size first."""
    if valid.dtype != bool or valid.ndim != 2:
        raise ValueError("valid mask must be a 2-D boolean array")
    if not 0 < min_valid <= 1 or max_windows < 1 or any(type(s) is not int or s < 16 for s in sizes):
        raise ValueError("invalid window policy")
    remaining, occupied = valid.copy(), np.zeros(valid.shape, bool)
    found: list[dict] = []
    for size in sorted(set(sizes), reverse=True):
        if min(remaining.shape) < size:
            continue
        while len(found) < max_windows:
            sums = window_sums(remaining, size)
            if found:
                sums[window_sums(occupied, size) > 0] = -1  # strict non-overlap
            index = int(np.argmax(sums))
            y, x = divmod(index, sums.shape[1])
            fraction = float(sums[y, x]) / (size * size)
            if fraction < min_valid:
                break
            found.append({"box_xyxy": [int(x), int(y), int(x + size), int(y + size)], "size": size,
                          "valid_fraction": fraction})
            remaining[y:y + size, x:x + size] = False
            occupied[y:y + size, x:x + size] = True
        if len(found) >= max_windows:
            break
    return found


def inpaint_normalized(rgb_linear: np.ndarray, valid: np.ndarray, *, sigmas=(2.0, 4.0, 8.0, 16.0, 32.0)) -> np.ndarray:
    """Fill invalid pixels by normalized convolution with growing support. Returns a new array."""
    out = np.array(rgb_linear, dtype=np.float32, copy=True)
    known = valid.copy()
    out[~known] = 0.0
    for sigma in sigmas:
        if known.all():
            break
        weight = ndimage.gaussian_filter(known.astype(np.float32), sigma)
        filled = np.stack([ndimage.gaussian_filter(out[..., c] * known, sigma) for c in range(3)], -1)
        ok = (~known) & (weight > 1e-3)
        out[ok] = filled[ok] / weight[ok][:, None]
        known = known | ok
    if not known.all():
        out[~known] = out[known].mean(axis=0)
    return out


def flatten_illumination(rgb_linear: np.ndarray, valid: np.ndarray, *, degree: int = 2,
                         gain_clip: tuple[float, float] = (0.5, 2.0)) -> tuple[np.ndarray, dict]:
    """Divide by a low-order polynomial fit of log-luminance over valid pixels.

    A degree-2 surface follows lamp vignetting and distance falloff without
    following lobules or vessels. It is unbiased at crop borders, unlike a
    Gaussian estimate, and cannot remove detail finer than the fitted surface.
    """
    if type(degree) is not int or not 1 <= degree <= 3 or gain_clip[0] <= 0 or gain_clip[0] >= gain_clip[1]:
        raise ValueError("invalid flattening policy")
    height, width = rgb_linear.shape[:2]
    luminance = np.maximum(rgb_linear @ LUMA, 1e-4)
    ys, xs = np.meshgrid(np.linspace(-1, 1, height, dtype=np.float32),
                         np.linspace(-1, 1, width, dtype=np.float32), indexing="ij")
    columns = [np.ones_like(xs)]
    for total in range(1, degree + 1):
        for px in range(total, -1, -1):
            columns.append(xs ** px * ys ** (total - px))
    design = np.stack([c.ravel() for c in columns], 1).astype(np.float64)
    target = np.log(luminance).ravel().astype(np.float64)
    select = valid.ravel() if valid.any() else np.ones(target.shape, bool)
    coefficients, *_ = np.linalg.lstsq(design[select], target[select], rcond=None)
    fitted = (design @ coefficients).reshape(height, width)
    reference = float(fitted[valid].mean()) if valid.any() else float(fitted.mean())
    gain = np.clip(np.exp(reference - fitted), gain_clip[0], gain_clip[1]).astype(np.float32)
    return rgb_linear * gain[..., None], {"degree": degree, "gain_min": float(gain.min()),
                                          "gain_max": float(gain.max()),
                                          "reference_luminance": float(np.exp(reference))}


def exposure_gain(rgb_linear: np.ndarray, valid: np.ndarray, target_luminance: float,
                  clip: tuple[float, float] = (0.5, 2.0)) -> float:
    mean = float((rgb_linear @ LUMA)[valid].mean()) if valid.any() else float((rgb_linear @ LUMA).mean())
    return float(np.clip(target_luminance / max(mean, 1e-4), clip[0], clip[1]))


def sharpness(rgb_u8: np.ndarray, valid: np.ndarray | None = None) -> float:
    """Variance of the Laplacian of luminance at native scale; relative, not calibrated."""
    gray = np.asarray(rgb_u8, dtype=np.float32) @ LUMA
    lap = ndimage.laplace(gray)
    if valid is not None:
        inner = ndimage.binary_erosion(valid, iterations=2)
        if inner.sum() > 64:
            lap = lap[inner]
    return float(lap.var())


def dark_fraction(rgb_u8: np.ndarray, threshold_u8: int = 20) -> float:
    return float(((np.asarray(rgb_u8, dtype=np.float32) @ LUMA) < threshold_u8).mean())
