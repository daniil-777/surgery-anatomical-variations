"""Bounded, deterministic photo segmentation and robust observed-colour analysis."""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import warnings
from typing import Any

import numpy as np
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, model_validator
from scipy import ndimage
from skimage.segmentation import random_walker

from .reference_color import ReferenceColor, UnitFloat, gamut_srgb, to_oklab

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_PIXELS = 24_000_000
ANALYSIS_SIDE = 1024
SEGMENT_SIDE = 256
Point = tuple[UnitFloat, UnitFloat]


class RegionSelection(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    box: tuple[UnitFloat, UnitFloat, UnitFloat, UnitFloat]
    foreground_points: list[Point] = Field(default_factory=list, max_length=32)
    background_points: list[Point] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def ordered_box(self) -> RegionSelection:
        x0, y0, x1, y1 = self.box
        if x1 - x0 < .01 or y1 - y0 < .01:
            raise ValueError("Draw an organ region at least 1% wide and high")
        if any(not (x0 < x < x1 and y0 < y < y1) for x, y in self.foreground_points):
            raise ValueError("Foreground points must be inside the selected region")
        if set(self.foreground_points) & set(self.background_points):
            raise ValueError("Foreground and background points must be distinct")
        return self


def decode_base64(value: str) -> bytes:
    if len(value) > (MAX_IMAGE_BYTES * 4 // 3 + 4):
        raise ValueError("Image exceeds the 12 MiB limit")
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Image must be valid raw base64") from exc
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Image is empty or exceeds the 12 MiB limit")
    return raw


def decode_photo(raw: bytes) -> tuple[Image.Image, tuple[int, int], list[str]]:
    notices: list[str] = []
    try:
        with Image.open(io.BytesIO(raw), formats=["PNG", "JPEG", "WEBP"]) as opened:
            if opened.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("Use a PNG, JPEG or WebP image")
            if opened.width * opened.height > MAX_PIXELS or min(opened.size) < 16:
                raise ValueError("Image must be at least 16 pixels per side and at most 24 megapixels")
            if getattr(opened, "n_frames", 1) != 1:
                raise ValueError("Use a still image, not an animation")
            image = ImageOps.exif_transpose(opened)
            # Transparency has no unambiguous observed colour; reject it, do not
            # turn a cutout background black and accidentally sample it.
            if "A" in image.getbands() or "transparency" in image.info:
                if np.asarray(image.convert("RGBA"))[..., 3].min() < 255:
                    raise ValueError("Use an opaque reference photo; upload cutouts as masks")
            profile = opened.info.get("icc_profile")
            if profile:
                try:
                    image = ImageCms.profileToProfile(
                        image, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                        ImageCms.createProfile("sRGB"), outputMode="RGB",
                    )
                except (OSError, ValueError, ImageCms.PyCMSError) as exc:
                    raise ValueError("The embedded colour profile could not be converted to sRGB") from exc
            else:
                notices.append("No colour profile: sRGB is assumed; camera white balance remains in the colour.")
            image = image.convert("RGB")
            original_size = image.size
            image.thumbnail((ANALYSIS_SIDE, ANALYSIS_SIDE), Image.Resampling.LANCZOS)
            return image.copy(), original_size, notices
    except (UnidentifiedImageError, OSError, SyntaxError, IndexError, EOFError, Image.DecompressionBombError) as exc:
        raise ValueError("The reference image could not be decoded safely") from exc


def png_base64(array: np.ndarray) -> str:
    out = io.BytesIO()
    Image.fromarray(array).save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode("ascii")


def decode_mask(raw: bytes, original_size: tuple[int, int], size: tuple[int, int]) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(raw), formats=["PNG"]) as image:
            if image.format != "PNG" or image.size not in {original_size, size}:
                raise ValueError("Mask must be a PNG matching the oriented photo or analysis dimensions")
            if image.width * image.height > MAX_PIXELS:
                raise ValueError("Mask exceeds the pixel limit")
            if getattr(image, "n_frames", 1) != 1:
                raise ValueError("Mask must be a still PNG")
            # Explicit binary luminance convention, never infer alpha meaning.
            pixels = np.asarray(image.convert("RGB"))
            if not np.all(pixels[..., 0] == pixels[..., 1]) or not np.all(pixels[..., 1] == pixels[..., 2]):
                raise ValueError("Mask must be black background and white foreground")
            if not np.isin(pixels[..., 0], [0, 255]).all():
                raise ValueError("Mask must contain only black (0) and white (255)")
            if ("A" in image.getbands() or "transparency" in image.info) and np.asarray(image.convert("RGBA"))[..., 3].min() < 255:
                raise ValueError("Mask must be opaque black and white")
            return np.asarray(image.convert("L").resize(size, Image.Resampling.NEAREST)) > 127
    except (UnidentifiedImageError, OSError, SyntaxError, IndexError, EOFError, Image.DecompressionBombError) as exc:
        raise ValueError("Mask PNG could not be decoded safely") from exc


def local_segment(image: Image.Image, selection: RegionSelection) -> tuple[np.ndarray, dict[str, Any]]:
    small = image.copy()
    small.thumbnail((SEGMENT_SIDE, SEGMENT_SIDE), Image.Resampling.BILINEAR)
    data = ndimage.gaussian_filter(np.asarray(small, dtype=float) / 255., (0.6, 0.6, 0))
    h, w = data.shape[:2]
    x0, y0, x1, y1 = selection.box
    left, top = int(x0 * (w - 1)), int(y0 * (h - 1))
    right, bottom = int(np.ceil(x1 * (w - 1))), int(np.ceil(y1 * (h - 1)))
    if right - left < 4 or bottom - top < 4:
        raise ValueError("Select a larger organ region")
    labels = np.ones((h, w), dtype=np.int32)
    labels[top + 1:bottom, left + 1:right] = 0
    points = selection.foreground_points or [((x0 + x1) / 2, (y0 + y1) / 2)]
    seed_pixels: list[tuple[int, int]] = []
    for x, y in points:
        px, py = round(x * (w - 1)), round(y * (h - 1))
        if not (left < px < right and top < py < bottom):
            raise ValueError("Place the tissue point farther from the region border")
        labels[py, px] = 2
        seed_pixels.append((py, px))
    for x, y in selection.background_points:
        px, py = round(x * (w - 1)), round(y * (h - 1))
        if (py, px) in seed_pixels:
            raise ValueError("Foreground and background points overlap at analysis resolution")
        labels[py, px] = 1
    if np.max(np.std(data, axis=(0, 1))) < 1e-6:
        raise ValueError("The image has no contrast for segmentation; use a reviewed mask")
    # Sparse point markers otherwise lose to the much longer background border.
    # Expand only connected pixels with a clear foreground/background colour
    # margin. This is an appearance trimap, not a learned anatomical prior.
    lab = to_oklab(data)
    fg_colors = np.asarray([np.median(lab[max(0, y-1):y+2, max(0, x-1):x+2], axis=(0, 1))
                            for y, x in seed_pixels])
    border_colors = lab[labels == 1]
    # Border colour quantiles retain multiple surrounding colour families.
    bg_colors = np.quantile(border_colors, [.1, .5, .9], axis=0)
    fg_distance = np.min(np.linalg.norm(lab[..., None, :] - fg_colors, axis=-1), axis=-1)
    bg_distance = np.min(np.linalg.norm(lab[..., None, :] - bg_colors, axis=-1), axis=-1)
    confident = (labels != 1) & (fg_distance < .06) & (bg_distance > 2 * fg_distance + .025)
    for y, x in seed_pixels:
        confident[y, x] = True
    regions, _ = ndimage.label(confident)
    connected = np.isin(regions, [regions[y, x] for y, x in seed_pixels]) & (regions > 0)
    labels[connected & (labels == 0)] = 2
    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        segmented = random_walker(data, labels, beta=130, mode="bf", channel_axis=-1) == 2
    # Keep only components connected to supplied foreground prompts.
    components, _ = ndimage.label(segmented)
    keep = [components[y, x] for y, x in seed_pixels if components[y, x] > 0]
    segmented = np.isin(components, keep) & (components > 0)
    mask = np.asarray(Image.fromarray(segmented).resize(image.size, Image.Resampling.NEAREST))
    return mask, {"method": "local-random-walker", "learned": False,
                  "semantic_identity": "user_assigned", "review_required": True,
                  "default_center_seed": not bool(selection.foreground_points),
                  "working_size": [w, h]}


def extract_observed_color(rgb: np.ndarray, mask: np.ndarray) -> dict[str, Any]:
    """Reject boundaries/glare/shadows and robust chroma outliers; no albedo claim."""
    selected = int(mask.sum())
    if selected < 100:
        raise ValueError("Too little selected tissue; select at least 100 analysis pixels")
    core = ndimage.binary_erosion(mask, iterations=2)
    if core.sum() < 64:
        raise ValueError("The selected tissue is too thin after excluding its boundary")
    pixels = np.asarray(rgb, dtype=float) / 255.
    lab = to_oklab(pixels)
    lightness, chroma = lab[..., 0], np.linalg.norm(lab[..., 1:], axis=-1)
    clipped = (pixels.max(axis=-1) >= 250 / 255)
    glare = (lightness > .80) & (chroma < .055)
    dark = (lightness < .22) | (pixels.max(axis=-1) < 35 / 255)
    usable = core & ~(clipped | glare | dark)
    if usable.sum() < 64:
        raise ValueError("Too little usable tissue after excluding glare and shadows")
    # Central brightness band reduces acquisition shading; strict inequalities
    # deliberately retain uniform tissue. Never call this intrinsic albedo.
    lo, hi = np.quantile(lightness[usable], [.10, .90])
    usable &= (lightness >= lo) & (lightness <= hi)
    ab = lab[usable, 1:]
    center = np.median(ab, axis=0)
    mad = np.maximum(1.4826 * np.median(np.abs(ab - center), axis=0), .008)
    chroma_distance = np.sqrt(np.sum(((lab[..., 1:] - center) / mad) ** 2, axis=-1))
    accepted = usable & (chroma_distance <= 3.5)
    count = int(accepted.sum())
    if count < 64 or count / selected < .10:
        raise ValueError("Insufficient consistent tissue colour; refine the mask or use another photo")
    sample = lab[accepted]
    representative = np.median(sample, axis=0)
    order = sample[np.argsort(sample[:, 0], kind="stable")]
    palette = [gamut_srgb(np.median(part, axis=0)).tolist() for part in np.array_split(order, 3)]
    notices = ["Organ identity is assigned by you. Check the mask for other organs, blood, fat and instruments.",
               "This transfers observed colour, not calibrated albedo, tissue optics or physical properties."]
    if count / selected < .4:
        notices.append("Most selected pixels were excluded; a better-lit, cleaner tissue region is recommended.")
    spread = np.quantile(sample, .90, axis=0) - np.quantile(sample, .10, axis=0)
    if np.linalg.norm(spread[1:]) > .12:
        notices.append("The region contains diverse colours; separate different tissues before applying.")
    return {"observed_color_srgb": gamut_srgb(representative).tolist(),
            "palette_srgb": palette, "accepted_mask": accepted, "warnings": notices,
            "quality": {"selected_pixels": selected, "accepted_pixels": count,
                        "accepted_fraction": count / selected,
                        "boundary_excluded_pixels": selected - int(core.sum()),
                        "glare_or_clipped_pixels": int((core & (glare | clipped)).sum()),
                        "deep_shadow_pixels": int((core & dark).sum()),
                        "oklab_spread_10_90": spread.tolist(),
                        "semantic_confidence": None, "optical_calibration": False}}


def analyze_image(image: Image.Image, mask: np.ndarray, organ: str, source_sha256: str,
                  segmentation: dict[str, Any], notices: list[str]) -> dict[str, Any]:
    if mask.shape != (image.height, image.width):
        raise ValueError("Segmentation does not align with the photo")
    rgb = np.asarray(image)
    mask = np.asarray(mask, dtype=bool)
    result = extract_observed_color(rgb, mask)
    accepted = result.pop("accepted_mask")
    mask_png = png_base64(mask.astype(np.uint8) * 255)
    digest = hashlib.sha256(base64.b64decode(mask_png)).hexdigest()
    overlay = rgb.copy().astype(float)
    overlay[mask] = .62 * overlay[mask] + .38 * np.array([255, 176, 55])
    overlay[accepted] = .62 * rgb[accepted] + .38 * np.array([62, 220, 160])
    reference = ReferenceColor(organ=organ, source_sha256=source_sha256,
                               mask_sha256=digest, observed_srgb=result["observed_color_srgb"])
    return {"version": "reference-analysis-1", "organ": organ, "source_sha256": source_sha256,
            "mask_sha256": digest, "width": image.width, "height": image.height,
            "mask_png_base64": mask_png,
            "overlay_png_base64": png_base64(np.rint(overlay).astype(np.uint8)),
            **result, "warnings": notices + result["warnings"], "segmentation": segmentation,
            "reference_color": reference.model_dump(mode="json")}
