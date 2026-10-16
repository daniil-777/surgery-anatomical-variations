"""Photo-derived detail tiles for the organ studio's tissue shader.

From the licensed surgical photographs the studio ships (DSAD, CC BY 4.0; DRENDS colon views), each with a reviewed
organ mask, this writes per organ one small tile that the GPU shader lays over the procedural tissue without repetition:

  1. the mask is eroded and glare, clipped and deep-shadow pixels are excluded with the same rule the studio's colour
     analysis uses (viscera_core.reference_analysis.extract_observed_color);
  2. acquisition shading is flattened: the low-frequency log-luminance over the valid pixels is removed, chroma and the
     global mean are kept (this is detail, not albedo: the photograph's lighting and camera are unknown);
  3. the largest square inside the valid region is cut, holes filled by normalised convolution, resized to at most
     512 px, and made seamless by the offset-and-blend construction;
  4. the tile is Gaussianised per channel and its inverse lookup written (Heitz & Neyret 2018, histogram-preserving
     blending), which is what lets the shader blend three randomly offset hex tiles (Mikkelsen 2022) without the
     contrast loss of plain blending.

Outputs: apps/studio/public/textures/<organ>/{albedo,gauss,lut}.png and textures/manifest.json with provenance, the
tile's mean colour (the shader divides by it, so the organ's base colour and any transferred reference colour stay
exactly what they were) and quality numbers. Run from viscera/: PYTHONPATH=py .venv/bin/python -m pipelines.textures.photo_tiles
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.special import ndtr, ndtri

from viscera_core.reference_color import from_linear, to_linear, to_oklab

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "apps/studio/public"
OUT = PUBLIC / "textures"
VERSION = "photo-detail-tiles-1.0.0"
# the physical size one tile covers on the organ, in mm: a design choice (the photographs carry no scale), chosen so
# the visible mottling has the size of the API's mottle_scale_mm defaults
TILE_MM = {"liver": 48.0, "stomach": 52.0, "spleen": 44.0, "pancreas": 40.0, "small-intestine": 36.0, "large-intestine": 44.0, "kidney": 40.0}


def erode(mask: np.ndarray, px: int) -> np.ndarray:
    return ndimage.binary_erosion(mask, iterations=px) if px > 0 else mask


def usable_pixels(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """The studio's rule: no boundary, glare, clipped or deep-shadow pixels."""
    pixels = rgb.astype(np.float64) / 255.0
    lab = to_oklab(pixels)
    lightness, chroma = lab[..., 0], np.linalg.norm(lab[..., 1:], axis=-1)
    clipped = pixels.max(axis=-1) >= 250 / 255
    glare = (lightness > 0.80) & (chroma < 0.055)
    dark = (lightness < 0.22) | (pixels.max(axis=-1) < 35 / 255)
    # small specular blobs survive the studio's rule (they keep some chroma): a white top-hat finds bright spots
    # smaller than ~17 px against their surroundings; they are excluded with a margin and filled later
    tophat = np.maximum(ndimage.white_tophat(lightness, size=17), ndimage.white_tophat(lightness, size=41))
    spots = ndimage.binary_dilation(tophat > 0.05, iterations=3)
    return erode(mask, 6) & ~(clipped | glare | dark | spots)


def normalized_blur(values: np.ndarray, weight: np.ndarray, sigma: float) -> np.ndarray:
    num = ndimage.gaussian_filter(values * weight, sigma)
    den = ndimage.gaussian_filter(weight, sigma)
    return num / np.maximum(den, 1e-6)


def flatten_shading(linear: np.ndarray, valid: np.ndarray, sigma: float) -> np.ndarray:
    """Remove low-frequency luminance over the valid pixels; keep chroma and the mean."""
    lum = np.maximum(linear @ np.array([0.2126, 0.7152, 0.0722]), 1e-4)
    log_lum = np.log(lum)
    shading = normalized_blur(log_lum, valid.astype(np.float64), sigma)
    gain = np.exp(np.mean(log_lum[valid]) - shading)
    return linear * gain[..., None]


def largest_square(valid: np.ndarray, mask: np.ndarray, hole_px: int = 400) -> tuple[int, int, int]:
    """Centre and half-side of the largest axis-aligned square inside the organ that avoids the large excluded patches
    (glare areas, shadows, instruments); excluded spots smaller than `hole_px` may lie inside and are filled later."""
    excluded = mask & ~valid
    labels, count = ndimage.label(excluded)
    if count:
        sizes = ndimage.sum(excluded, labels, index=np.arange(1, count + 1))
        large = np.isin(labels, 1 + np.flatnonzero(sizes > hole_px))
    else:
        large = np.zeros_like(mask)
    region = erode(mask, 6) & ~ndimage.binary_dilation(large, iterations=3)
    distance = ndimage.distance_transform_cdt(region, metric="chessboard")
    cy, cx = np.unravel_index(int(np.argmax(distance)), distance.shape)
    return int(cy), int(cx), int(distance[cy, cx])


def fill_holes(tile: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Normalised-convolution inpainting of the excluded pixels, coarse to fine."""
    out = tile.copy()
    weight = valid.astype(np.float64)
    for sigma in (24.0, 8.0, 3.0):
        for c in range(3):
            filled = normalized_blur(out[..., c], weight, sigma)
            out[..., c] = np.where(valid, out[..., c], filled)
        weight = np.ones_like(weight)
    return out


def seamless(tile: np.ndarray, band: float = 0.09) -> np.ndarray:
    """Four-image offset blend. The half-rolled tile B is seamless at the edges but carries a centre cross of seams;
    the cross is covered by copies rolled along one axis only (D: rows, E: columns), which are continuous there and
    still seamless at the edges, and the centre square by the original A. Cosine weights; the doubled content inside
    the bands is hidden by stochastic tissue."""
    h, w = tile.shape[:2]
    a = tile
    b = np.roll(np.roll(a, h // 2, axis=0), w // 2, axis=1)
    d = np.roll(a, h // 2, axis=0)
    e = np.roll(a, w // 2, axis=1)
    fy = np.clip(1 - np.abs(np.arange(h) - h / 2) / (band * h), 0, 1)
    fx = np.clip(1 - np.abs(np.arange(w) - w / 2) / (band * w), 0, 1)
    wy = (0.5 * (1 - np.cos(np.pi * fy)))[:, None, None]
    wx = (0.5 * (1 - np.cos(np.pi * fx)))[None, :, None]
    return a * (wx * wy) + d * (wx * (1 - wy)) + e * (wy * (1 - wx)) + b * ((1 - wx) * (1 - wy))


def gaussianize(tile8: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per channel: the tile mapped to a Gaussian (mean .5, std 1/6) and the 256-entry inverse lookup."""
    gauss = np.zeros_like(tile8)
    lut = np.zeros((256, 3), dtype=np.uint8)
    for c in range(3):
        v = tile8[..., c].astype(np.float64).ravel()
        order = np.argsort(v, kind="stable")
        ranks = np.empty_like(order)
        ranks[order] = np.arange(v.size)
        u = (ranks + 0.5) / v.size
        g = np.clip(0.5 + ndtri(u) / 6.0, 0, 1)
        gauss[..., c] = np.rint(g.reshape(tile8.shape[:2]) * 255).astype(np.uint8)
        bins = (np.arange(256) / 255.0 - 0.5) * 6.0
        lut[:, c] = np.rint(np.quantile(v, np.clip(ndtr(bins), 0, 1))).astype(np.uint8)
    return gauss, lut


def build_tile(photo: Path, mask_png: Path | None, mask_array: np.ndarray | None, organ: str, source: dict[str, Any], size: int = 512) -> dict[str, Any] | None:
    image = Image.open(photo).convert("RGB")
    rgb = np.asarray(image)
    if mask_array is None:
        mask_array = np.asarray(Image.open(mask_png).convert("L")) > 127
    if mask_array.shape != rgb.shape[:2]:
        raise ValueError(f"{photo.name}: mask {mask_array.shape} does not match the photo {rgb.shape[:2]}")
    valid = usable_pixels(rgb, mask_array)
    linear = to_linear(rgb.astype(np.float64) / 255.0)
    flat = flatten_shading(linear, valid, sigma=0.035 * rgb.shape[1])
    cy, cx, r = largest_square(valid, mask_array)
    if 2 * r < 96:
        return {"organ": organ, "skipped": f"largest usable square is {2 * r} px; 96 needed", "source": source}
    crop = flat[cy - r:cy + r, cx - r:cx + r]
    crop_valid = valid[cy - r:cy + r, cx - r:cx + r]
    crop = fill_holes(crop, crop_valid)
    # a second, local flattening on the crop itself: medium-scale shading the frame-wide pass leaves behind would
    # otherwise show as brightness patches once the tile is offset-blended and repeated
    crop = flatten_shading(crop, np.ones(crop.shape[:2], dtype=bool), sigma=crop.shape[0] / 3)
    side = min(size, 2 * r)
    if side != 2 * r:
        crop = np.asarray(Image.fromarray(np.rint(from_linear(crop) * 255).astype(np.uint8)).resize((side, side), Image.Resampling.BOX))
        crop = to_linear(crop.astype(np.float64) / 255.0)
    tile = np.clip(seamless(crop), 0, 1)
    mean_linear = tile.reshape(-1, 3).mean(axis=0)
    lum = tile @ np.array([0.2126, 0.7152, 0.0722])
    tile8 = np.rint(from_linear(tile) * 255).astype(np.uint8)
    gauss, lut = gaussianize(tile8)
    folder = OUT / organ
    folder.mkdir(parents=True, exist_ok=True)
    Image.fromarray(tile8).save(folder / "albedo.png", optimize=True)
    Image.fromarray(gauss).save(folder / "gauss.png", optimize=True)
    Image.fromarray(lut[None, :, :]).save(folder / "lut.png", optimize=True)
    # the seam check: the wrapped edge difference against the typical neighbour difference inside the tile
    inner = np.mean(np.abs(np.diff(tile, axis=1)))
    wrap = np.mean(np.abs(tile[:, 0] - tile[:, -1])) / max(inner, 1e-6)
    wrap_v = np.mean(np.abs(tile[0, :] - tile[-1, :])) / max(np.mean(np.abs(np.diff(tile, axis=0))), 1e-6)
    return {
        "organ": organ, "files": {"albedo": f"{organ}/albedo.png", "gauss": f"{organ}/gauss.png", "lut": f"{organ}/lut.png"},
        "side_px": int(side), "crop_px": int(2 * r), "tile_mm": TILE_MM.get(organ, 44.0),
        "mean_linear": [float(v) for v in mean_linear], "mean_srgb": [float(v) for v in from_linear(mean_linear)],
        "luminance_std_relative": float(lum.std() / max(lum.mean(), 1e-6)),
        "valid_fraction_of_crop": float(crop_valid.mean()), "seam_ratio_x": float(wrap), "seam_ratio_y": float(wrap_v),
        "source": {**source, "photo_sha256": hashlib.sha256(photo.read_bytes()).hexdigest()},
        "method": "eroded mask; glare/clipped/shadow excluded (studio rule) plus small specular spots (white top-hat at 17 and 41 px); a second flattening at a third of the crop; log-luminance shading flattened (σ 3.5 % of width); largest clean square; normalised-convolution fill; offset-and-blend seamless; per-channel Gaussianisation with inverse LUT",
        "evidence": "observed photograph detail with its lighting flattened; not calibrated albedo, not tissue optics",
    }


def api_mask(photo: Path, organ: str, selection: dict[str, Any], api: str, mask_png: Path | None = None) -> tuple[np.ndarray, dict[str, Any]]:
    """The studio's own segmentation and colour analysis of a region (viscera_core.reference_analysis through the API):
    the mask it would show the user (the reviewed one when given), and the observed colour with its quality numbers."""
    import base64
    import io
    import urllib.request

    body = {"image_base64": base64.b64encode(photo.read_bytes()).decode(), "organ": organ, "segmentation": "local", "selection": selection}
    if mask_png is not None:
        body["mask_base64"] = base64.b64encode(mask_png.read_bytes()).decode()
    request = urllib.request.Request(f"{api}/api/atlas/reference-material/analyze", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=900) as response:
        analysis = json.load(response)
    mask_image = Image.open(io.BytesIO(base64.b64decode(analysis["mask_png_base64"]))).convert("L")
    with Image.open(photo) as original:   # the API analyses at a working size; the mask comes back at it
        if mask_image.size != original.size:
            mask_image = mask_image.resize(original.size, Image.Resampling.NEAREST)
    return np.asarray(mask_image) > 127, analysis


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--api", default="http://127.0.0.1:8000", help="the VISCERA API, for masks of box-selected sources and the observed colours")
    parser.add_argument("--sources", default=str(PUBLIC / "textures/sources.json"), help="extra photographs: [{organ, file, box, foreground_points, background_points, credit, license, license_url, source_url, collection}]")
    args = parser.parse_args()
    catalog = json.load(open(PUBLIC / "body-reference/catalog.json"))
    results: list[dict[str, Any]] = []
    def api_ok() -> bool:
        import urllib.request
        try:
            return urllib.request.urlopen(f"{args.api}/api/health", timeout=5).status == 200
        except Exception:
            return False
    online = api_ok()
    for src in catalog["sources"]:
        photo = PUBLIC / "body-reference" / Path(src["src"]).name
        for region in src["regions"]:
            mask = PUBLIC / "body-reference" / f"{region['id']}-mask.png"
            if not mask.exists():
                results.append({"organ": region["organ"], "skipped": "no reviewed mask", "source": {"id": src["id"]}})
                continue
            source = {"collection": "DSAD", "id": src["id"], "region": region["id"], "credit": src.get("credit"), "license": src.get("license"), "license_url": src.get("license_url"), "source_url": src.get("source_url"), "photo": src["src"]}
            tile = build_tile(photo, mask, None, region["organ"], source, args.size)
            if tile and "skipped" not in tile and online:
                try:   # the observed colour of the same reviewed region, as the studio measures it
                    _, analysis = api_mask(photo, region["organ"], dict(region["selection"]), args.api, mask)
                    tile["reference_color"] = analysis["reference_color"]
                    tile["color_quality"] = {k: analysis["quality"][k] for k in ("accepted_fraction", "accepted_pixels")}
                except Exception as error:
                    tile["color_note"] = f"colour analysis failed: {str(error)[:100]}"
            results.append(tile)
    # box-selected photographs (Commons and the studio's own examples): the API segments the region and measures its colour
    extra = Path(args.sources)
    if extra.exists():
        if not online:
            print(f"{extra.name}: the API at {args.api} is not reachable; these sources need it for their masks")
        else:
            for entry in json.load(open(extra)):
                photo = PUBLIC / entry["file"]
                selection = {"box": entry["box"], "foreground_points": entry.get("foreground_points", []), "background_points": entry.get("background_points", [])}
                try:
                    mask, analysis = api_mask(photo, entry["organ"], selection, args.api)
                except Exception as error:
                    results.append({"organ": entry["organ"], "skipped": f"segmentation failed: {str(error)[:120]}", "source": {"id": entry.get("id", photo.name)}})
                    continue
                source = {k: entry.get(k) for k in ("collection", "id", "credit", "license", "license_url", "source_url")} | {"photo": "/" + entry["file"], "region": entry.get("id", photo.stem), "selection": selection, "identity": "assigned by the build author from the photograph's description; not clinically reviewed"}
                tile = build_tile(photo, None, mask, entry["organ"], source, args.size)
                if tile and "skipped" not in tile:
                    tile["reference_color"] = analysis["reference_color"]
                    tile["color_quality"] = {k: analysis["quality"][k] for k in ("accepted_fraction", "accepted_pixels")}
                results.append(tile)
    # one tile per organ: the larger clean square wins
    best: dict[str, dict[str, Any]] = {}
    for r in results:
        if "skipped" in r:
            continue
        if r["organ"] not in best or r["crop_px"] > best[r["organ"]]["crop_px"]:
            best[r["organ"]] = r
    manifest = {"version": VERSION, "organs": best, "candidates": [{k: v for k, v in r.items() if k != "files"} for r in results],
                "shader": "hex-tiled triplanar, histogram-preserving blending (Heitz & Neyret 2018; Mikkelsen 2022), mean-preserving modulation of the tissue colour"}
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.iterdir():   # an organ that lost its tile keeps no folder behind
        if stale.is_dir() and stale.name not in best:
            shutil.rmtree(stale)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    for organ, r in best.items():
        print(f"{organ:18s} crop {r['crop_px']:4d} px → tile {r['side_px']} px · valid {r['valid_fraction_of_crop']:.2f} · lum std {r['luminance_std_relative']:.3f} · seams x {r['seam_ratio_x']:.2f} y {r['seam_ratio_y']:.2f} · {r['source']['region']}")
    for r in results:
        if "skipped" in r:
            print(f"{r['organ']:18s} skipped: {r['skipped']}")


if __name__ == "__main__":
    main()
