"""Clean generated tiles into renderer-ready base colour, preserving seamless wrap-around.

The renderer adds its own light and wet coat, so light baked into a generated tile is an
artifact: small specular glints (often with a blue-purple halo), dark non-red specks and
broad shading. These operations are periodic (wrap mode) so a cleaned tile stays seamless.
Colour matching moves a tile's CIELAB statistics toward the real crops of its family.
Every operation is recorded; none of this recovers measured albedo.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy import ndimage

from .imaging import LUMA, linear_to_srgb_u8, srgb_to_linear

_XYZ = np.array([[0.4124564, 0.3575761, 0.1804375],
                 [0.2126729, 0.7151522, 0.0721750],
                 [0.0193339, 0.1191920, 0.9503041]], dtype=np.float64)
_WHITE = np.array([0.95047, 1.0, 1.08883])
POLICY = {
    "version": "tile-clean-v11",
    "glint": "white top-hat of L* (9 px periodic opening) > 9 and chroma < 0.9 x local, or 17 px top-hat > 12.6 and chroma < 0.75 x local",
    "purple": "signed distance from the local hue line in a*b* < -8 (or < -4 with an L* closing dip > 4), grown through connected pixels < -2.7",
    "hysteresis": "glints grow through connected pixels with top-hat > 4.5 and chroma below local (periodic)",
    "halo": "b* closing residual (9 px) > 6 and b* < local b* - 3 within 6 px of a glint, or residual > 12 and b* < local b* - 6 anywhere; never redder than local",
    "protect": "pixels redder than local (a* > local a* + 4) are never masked, so vessels survive dilation",
    "speck": "periodic closing residual of L* (9 px) > 12 and a* < local a* (darker but not redder: vessels stay)",
    "mask": "union dilated 3 px, periodic normalized-convolution fill from typical pixels only (|hue shift| < 3, top-hat < 4.5 within 8 px of the mask are re-derived too), then a second pass",
    "local_sheen": "min-channel sheen removal (strength 0.9) only within a feathered 12 px neighbourhood of detected glints",
    "sheen": "min-channel excess over its periodic lower envelope (31 px opening, sigma 8) removed at strength 0.8",
    "shading": "log-luminance minus its periodic Gaussian low-pass (sigma = size/8), strength 0.7, gain clipped to [0.6, 1.6]",
    "colour": "per-channel CIELAB mean shift (strength 0.8) and std scaling (strength 0.5) toward the family's real-crop statistics",
}


def srgb_u8_to_lab(rgb_u8: np.ndarray) -> np.ndarray:
    xyz = srgb_to_linear(rgb_u8).astype(np.float64) @ _XYZ.T / _WHITE
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack((116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])), -1)


def lab_to_srgb_u8(lab: np.ndarray) -> np.ndarray:
    fy = (lab[..., 0] + 16) / 116
    f = np.stack((fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200), -1)
    xyz = np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * _WHITE
    linear = xyz @ np.linalg.inv(_XYZ).T
    return linear_to_srgb_u8(np.clip(linear, 0, 1).astype(np.float32))


def _grow(seed: np.ndarray, weak: np.ndarray) -> np.ndarray:
    """Hysteresis on a torus: keep weak pixels 8-connected to a seed (tiled 3x3 so growth wraps)."""
    if not seed.any():
        return seed
    h, w = seed.shape
    grown = ndimage.binary_propagation(np.tile(seed, (3, 3)), structure=np.ones((3, 3), bool), mask=np.tile(weak | seed, (3, 3)))
    centre = grown[h:2 * h, w:2 * w]
    # A component that crosses the tile edge is reached from the neighbouring copy, so OR all nine copies.
    for i in range(3):
        for j in range(3):
            centre = centre | grown[i * h:(i + 1) * h, j * w:(j + 1) * w]
    return centre


def artifact_mask(rgb_u8: np.ndarray, *, size: int = 9, dilate: int = 2, bright: float = 9.0, blue: float = 6.0,
                  dark: float = 12.0, purple_shift: float = 8.0) -> tuple[np.ndarray, dict]:
    """True where the tile carries baked glints, their blue halos or dark non-red specks.

    Periodic grey-scale morphology (wrap mode) isolates features narrower than `size` px:
    a white top-hat on L* finds glints even inside glint clusters, a closing residual on b*
    finds blue/purple fringes, a closing residual on L* finds dark specks; dark features
    that are redder than their surroundings (vessels) are kept.
    """
    lab = srgb_u8_to_lab(rgb_u8)
    l_star, a_star, b_star = lab[..., 0], lab[..., 1], lab[..., 2]
    footprint = (size, size)
    chroma = np.hypot(a_star, b_star)
    local_chroma = ndimage.gaussian_filter(chroma, size, mode="wrap")
    local_a = ndimage.gaussian_filter(a_star, size, mode="wrap")
    local_b = ndimage.gaussian_filter(b_star, size, mode="wrap")
    tophat = l_star - ndimage.grey_opening(l_star, size=footprint, mode="wrap")
    broad = l_star - ndimage.grey_opening(l_star, size=(2 * size - 1, 2 * size - 1), mode="wrap")
    glint = ((tophat > bright) & (chroma < 0.9 * local_chroma)) | ((broad > 1.4 * bright) & (chroma < 0.75 * local_chroma))
    glint = _grow(glint, (tophat > bright / 2) & (chroma < local_chroma))
    # Signed distance from the local hue line in the a*b* plane; negative = shifted toward blue/purple.
    hue = np.arctan2(local_b, local_a)
    shift = b_star * np.cos(hue) - a_star * np.sin(hue)
    dark_dip = ndimage.grey_closing(l_star, size=footprint, mode="wrap") - l_star
    # Strongly purple pixels, or pixels that are both a little darker and a little purple (speck cores).
    purple = _grow((shift < -purple_shift) | ((shift < -purple_shift / 2) & (dark_dip > 4)), shift < -purple_shift / 3)
    residual_b = ndimage.grey_closing(b_star, size=footprint, mode="wrap") - b_star
    not_red = a_star <= local_a + 3
    # Weak blue dips count only as fringes next to a glint; isolated ones must be strongly blue
    # (dark tones make b* noisy, so a lone weak dip is usually noise, not a speck).
    h, w = glint.shape
    near_glint = ndimage.binary_dilation(np.tile(glint, (3, 3)), iterations=6)[h:2 * h, w:2 * w] if glint.any() else glint
    halo = ((residual_b > blue) & (b_star < local_b - blue / 2) & not_red & near_glint) | (
        (residual_b > 2 * blue) & (b_star < local_b - blue) & not_red)
    speck = (ndimage.grey_closing(l_star, size=footprint, mode="wrap") - l_star > dark) & (a_star < local_a)
    mask = glint | halo | speck | purple
    if dilate and mask.any():
        h, w = mask.shape
        mask = ndimage.binary_dilation(np.tile(mask, (3, 3)), iterations=dilate)[h:2 * h, w:2 * w]
    # Red features (vessels, petechiae) are anatomy, not lighting: dilation never paints over them.
    mask &= ~(a_star > local_a + 4)
    return mask, {"glint_px": int(glint.sum()), "halo_px": int(halo.sum()), "speck_px": int(speck.sum()),
                  "purple_px": int(purple.sum()),
                  "masked_fraction": float(mask.mean())}


def typical_pixels(rgb_u8: np.ndarray, *, size: int = 9, shift_limit: float = 3.0, bright: float = 4.5) -> np.ndarray:
    """Pixels safe to borrow colour from: on the local hue line and not locally bright (no fringe, no sheen)."""
    lab = srgb_u8_to_lab(rgb_u8)
    local_a = ndimage.gaussian_filter(lab[..., 1], size, mode="wrap")
    local_b = ndimage.gaussian_filter(lab[..., 2], size, mode="wrap")
    hue = np.arctan2(local_b, local_a)
    shift = lab[..., 2] * np.cos(hue) - lab[..., 1] * np.sin(hue)
    tophat = lab[..., 0] - ndimage.grey_opening(lab[..., 0], size=(size, size), mode="wrap")
    return (np.abs(shift) < shift_limit) & (tophat < bright)


def periodic_fill(linear: np.ndarray, valid: np.ndarray, sigmas=(1.5, 3.0, 6.0, 12.0, 24.0)) -> np.ndarray:
    out = np.array(linear, dtype=np.float32, copy=True)
    known = valid.copy()
    out[~known] = 0
    for sigma in sigmas:
        if known.all():
            break
        weight = ndimage.gaussian_filter(known.astype(np.float32), sigma, mode="wrap")
        filled = np.stack([ndimage.gaussian_filter(out[..., c] * known, sigma, mode="wrap") for c in range(3)], -1)
        ok = (~known) & (weight > 1e-3)
        out[ok] = filled[ok] / weight[ok][:, None]
        known |= ok
    if not known.all():
        out[~known] = out[known].mean(axis=0)
    return out


def remove_sheen(linear: np.ndarray, *, envelope: int = 31, smooth: float = 8.0, strength: float = 0.8,
                 weight: np.ndarray | None = None) -> tuple[np.ndarray, dict]:
    """Subtract the specular (white) excess of the minimum channel over its periodic lower envelope.

    Under the dichromatic model a specular lobe adds roughly equal light to every channel, so it
    raises min(R, G, B). The lower envelope (periodic grey opening, then smoothing) tracks the diffuse
    minimum; the excess above it is removed from all channels. Genuinely pale tissue changes too,
    which is why the strength is partial and recorded.
    """
    if not 0 <= strength <= 1 or envelope < 3:
        raise ValueError("invalid sheen policy")
    minimum = linear.min(axis=2)
    base = ndimage.gaussian_filter(ndimage.grey_opening(minimum, size=(envelope, envelope), mode="wrap"), smooth, mode="wrap")
    excess = np.clip(minimum - base, 0, None)
    if weight is not None:
        excess = excess * weight
    out = np.clip(linear - strength * excess[..., None], 0, 1).astype(np.float32)
    return out, {"excess_mean": float(excess.mean()), "excess_p99": float(np.percentile(excess, 99))}


def flatten_shading(linear: np.ndarray, *, sigma_fraction: float = 1 / 8, strength: float = 0.7,
                    clip: tuple[float, float] = (0.6, 1.6)) -> tuple[np.ndarray, dict]:
    if not 0 <= strength <= 1 or not 0.02 <= sigma_fraction <= 0.5:
        raise ValueError("invalid shading policy")
    log_l = np.log(np.maximum(linear @ LUMA, 1e-4))
    low = ndimage.gaussian_filter(log_l, sigma_fraction * min(linear.shape[:2]), mode="wrap")
    gain = np.clip(np.exp(strength * (low.mean() - low)), clip[0], clip[1]).astype(np.float32)
    return linear * gain[..., None], {"gain_min": float(gain.min()), "gain_max": float(gain.max())}


def lab_stats(rgb_u8: np.ndarray, valid: np.ndarray | None = None) -> dict:
    lab = srgb_u8_to_lab(rgb_u8)
    pixels = lab[valid] if valid is not None else lab.reshape(-1, 3)
    return {"mean": pixels.mean(0).tolist(), "std": pixels.std(0).tolist(), "pixels": int(len(pixels))}


def match_colour(rgb_u8: np.ndarray, target: dict, *, mean_strength: float = 0.8, std_strength: float = 0.5) -> np.ndarray:
    lab = srgb_u8_to_lab(rgb_u8)
    mean, std = lab.reshape(-1, 3).mean(0), lab.reshape(-1, 3).std(0)
    t_mean, t_std = np.asarray(target["mean"]), np.asarray(target["std"])
    scale = 1 + std_strength * (np.clip(t_std / np.maximum(std, 1e-3), 0.5, 2.0) - 1)
    new_mean = mean + mean_strength * (t_mean - mean)
    out = (lab - mean) * scale + new_mean
    out[..., 0] = np.clip(out[..., 0], 0, 100)
    return lab_to_srgb_u8(out)


MODES = {
    # Measured on the second run's 24 tiles against held-out crops (docs: "Inference improvements"):
    # removing discrete glints/halos/specks plus colour matching keeps KID within noise of the raw tiles
    # and improves liver/spleen; also removing sheen and shading moved KID from 60 to 85 and cut diversity.
    "clean": {"artifacts": True, "sheen": False, "shading": False, "colour": False},
    "clean-colour": {"artifacts": True, "sheen": False, "shading": False, "colour": True},
    "delit-colour": {"artifacts": True, "sheen": True, "shading": True, "colour": True},
}


def clean_tile(rgb_u8: np.ndarray, *, colour_target: dict | None = None, artifacts: bool = True,
               sheen: bool = False, shading: bool = False) -> tuple[np.ndarray, dict]:
    """Return a cleaned uint8 tile and a receipt of what was changed (sheen/shading removal is opt-in)."""
    if rgb_u8.ndim != 3 or rgb_u8.shape[2] != 3 or rgb_u8.dtype != np.uint8 or rgb_u8.shape[0] != rgb_u8.shape[1]:
        raise ValueError("expected a square HxWx3 uint8 tile")
    receipt: dict = {"policy": POLICY["version"], "steps": []}
    linear = srgb_to_linear(rgb_u8)
    if artifacts:
        # Two passes: the first (dilated 3 px) removes glints and their fringes; the second catches
        # residual fringe pixels that the first fill pulled in from just outside its mask.
        mask, stats = artifact_mask(rgb_u8, dilate=3)
        # Borrow colour only from typical tissue: masked pixels and atypical pixels near them (purple
        # fringes, sheen) are both re-derived, so a glint is never refilled with its own fringe colour.
        h, w = mask.shape
        neighbourhood = ndimage.binary_dilation(np.tile(mask, (3, 3)), iterations=8)[h:2 * h, w:2 * w] if mask.any() else mask
        source = ~mask & ~(neighbourhood & ~typical_pixels(rgb_u8))
        linear = periodic_fill(linear, source)
        current = linear_to_srgb_u8(linear)
        mask2, stats2 = artifact_mask(current, dilate=2)
        near2 = ndimage.binary_dilation(np.tile(mask2, (3, 3)), iterations=8)[h:2 * h, w:2 * w] if mask2.any() else mask2
        linear = periodic_fill(linear, ~mask2 & ~(near2 & ~typical_pixels(current)))
        # The soft specular lobe around glints: remove sheen only in a feathered 12 px neighbourhood of
        # detected glints (whole-tile sheen removal flattened real texture; see the delit mode).
        near = mask | mask2
        if near.any():
            h, w = near.shape
            region = ndimage.binary_dilation(np.tile(near, (3, 3)), iterations=12)[h:2 * h, w:2 * w]
            weight = np.clip(ndimage.gaussian_filter(region.astype(np.float32), 4, mode="wrap") * 1.5, 0, 1)
            linear, local = remove_sheen(linear, strength=0.9, weight=weight)
            stats = {**stats, "local_sheen_area": float((weight > 0.05).mean()), "local_sheen_excess_p99": local["excess_p99"]}
        receipt["artifacts"] = {**stats, "second_pass_masked_fraction": stats2["masked_fraction"]}
        receipt["steps"].append("artifacts")
    if sheen:
        linear, stats = remove_sheen(linear)
        receipt["sheen"] = stats
        receipt["steps"].append("sheen")
    if shading:
        linear, stats = flatten_shading(linear)
        receipt["shading"] = stats
        receipt["steps"].append("shading")
    out = linear_to_srgb_u8(linear)
    if colour_target is not None:
        before = lab_stats(out)
        out = match_colour(out, colour_target)
        receipt["colour"] = {"before_mean": before["mean"], "after_mean": lab_stats(out)["mean"],
                             "target_mean": colour_target["mean"]}
        receipt["steps"].append("colour")
    return out, receipt


def family_colour_stats(crop_root: Path, *, split: str = "train", max_per_family: int = 400, seed: int = 0) -> dict:
    """CIELAB mean/std of valid pixels per family from a crop release (random crops, all sizes)."""
    from PIL import Image

    from .data import CropDataset

    dataset = CropDataset(crop_root, split=split)
    rng = np.random.default_rng(seed)
    by_family: dict[str, list[int]] = {}
    for index, row in enumerate(dataset.records):
        by_family.setdefault(row["family"], []).append(index)
    result = {}
    for family, indices in sorted(by_family.items()):
        if len(indices) > max_per_family:
            indices = [indices[int(i)] for i in rng.choice(len(indices), max_per_family, replace=False)]
        pixels = []
        for index in indices:
            rgb, valid, _ = dataset.load(index)
            lab = srgb_u8_to_lab(rgb)[valid]
            pixels.append(lab[rng.choice(len(lab), min(len(lab), 4096), replace=False)])
        stacked = np.concatenate(pixels)
        result[family] = {"mean": stacked.mean(0).tolist(), "std": stacked.std(0).tolist(), "crops": len(indices),
                          "pixels": int(len(stacked))}
    del Image
    return {"schema": "viscera.tissue-colour-stats/v1", "crop_release_sha256": dataset.release_sha256,
            "split": split, "space": "CIELAB D65 from sRGB", "families": result}


def load_colour_stats(path: Path) -> dict:
    data = json.loads(Path(path).read_text())
    if data.get("schema") != "viscera.tissue-colour-stats/v1":
        raise ValueError("unsupported colour statistics")
    return data


def clean_samples(samples: Path, output: Path, *, mode: str = "clean-colour", colour_stats: dict | None = None,
                  reclean: bool = False) -> dict:
    """Write cleaned copies of sampled tiles in the sampler's own layout (raw.png kept, receipt extended).

    reclean=True re-derives already post-processed tiles from their verified raw.png (newer policy).
    """
    import shutil

    from PIL import Image

    from .data import sha256_file
    from .model import seam_ratio

    if mode not in MODES:
        raise ValueError(f"mode must be one of {sorted(MODES)}")
    if MODES[mode]["colour"] and not colour_stats:
        raise ValueError("clean-colour needs family colour statistics")
    samples, output = Path(samples), Path(output)
    if output.exists():
        raise FileExistsError(f"{output} exists")
    output.mkdir(parents=True)
    done = []
    for receipt_path in sorted(samples.glob("*/sample.json")):
        receipt = json.loads(receipt_path.read_text())
        previous = receipt.get("postprocess")
        if previous and not reclean:
            raise ValueError(f"already post-processed: {receipt_path.parent.name} (use reclean)")
        if previous:
            source = receipt_path.parent / "raw.png"
            if not source.is_file() or sha256_file(source) != previous["raw_sha256"]:
                raise ValueError(f"raw tile missing or differs from its receipt: {receipt_path.parent.name}")
            receipt = {**receipt, "previous_postprocess": {k: previous.get(k) for k in ("mode", "policy", "steps")}}
        else:
            source = receipt_path.parent / "tile.png"
            if sha256_file(source) != receipt["tile_sha256"]:
                raise ValueError(f"tile differs from its receipt: {receipt_path.parent.name}")
        target = output / receipt_path.parent.name
        target.mkdir()
        shutil.copyfile(source, target / "raw.png")
        with Image.open(source) as image:
            rgb = np.asarray(image.convert("RGB"))
        stats = colour_stats["families"][receipt["family"]] if MODES[mode]["colour"] else None
        cleaned, post = clean_tile(rgb, colour_target=stats, sheen=MODES[mode]["sheen"], shading=MODES[mode]["shading"])
        Image.fromarray(cleaned).save(target / "tile.png")
        for extra in ("guide.png", "native.png"):
            if (receipt_path.parent / extra).is_file():
                shutil.copyfile(receipt_path.parent / extra, target / extra)
        receipt = {**receipt, "postprocess": {"mode": mode, **post, "raw_sha256": sha256_file(target / "raw.png"),
                                              "source_sample": str(receipt_path.parent)},
                   "tile_sha256": sha256_file(target / "tile.png"), "seam_ratio": seam_ratio(cleaned)}
        (target / "sample.json").write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n")
        done.append(target.name)
    return {"cleaned": len(done), "mode": mode, "policy": POLICY["version"], "output": str(output)}
