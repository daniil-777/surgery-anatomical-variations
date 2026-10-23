"""Derive a Studio material study from one learned tile, with every channel's provenance stated.

Base colour is the generated, illumination-flattened RGB. Height and normal
come from a luminance band-pass at an authored millimetre amplitude; roughness
is the authored organ value with a bounded detail modulation. None of these
are measurements. The manifest uses the same contract as the authored library.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image, PngImagePlugin
from scipy import ndimage

from . import GENERATOR, SCHEMA_SAMPLE
from .captions import MUCOSA_FAMILIES
from .imaging import LUMA, srgb_to_linear

AUTHORED_PX_PER_MM = 10.0  # DSAD/HyperKvasir frames are uncalibrated; this is a stated working scale
# (dry roughness, relief amplitude mm) copied from the authored library profiles; art-directed, not measured.
FAMILY_SURFACE = {"liver": (0.36, 0.065), "spleen": (0.38, 0.075), "stomach": (0.34, 0.13),
                  "small_bowel": (0.32, 0.10), "large_bowel": (0.36, 0.16), "pancreas": (0.44, 0.32),
                  "colonic_mucosa": (0.34, 0.25), "gastric_mucosa": (0.34, 0.62)}
LABELS = {"liver": "Liver capsule", "spleen": "Spleen capsule", "stomach": "Stomach serosa",
          "small_bowel": "Small bowel serosa", "large_bowel": "Large bowel serosa", "pancreas": "Pancreas lobules",
          "colonic_mucosa": "Colonic mucosa", "gastric_mucosa": "Gastric mucosa"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _periodic_gaussian(array: np.ndarray, sigma: float) -> np.ndarray:
    return ndimage.gaussian_filter(array, sigma, mode="wrap")


def derive_channels(rgb_u8: np.ndarray, family: str) -> dict[str, np.ndarray]:
    """Float maps in [0, 1] (height centred at 0.5) from a seamless sRGB tile."""
    if rgb_u8.ndim != 3 or rgb_u8.shape[2] != 3 or rgb_u8.dtype != np.uint8 or rgb_u8.shape[0] != rgb_u8.shape[1]:
        raise ValueError("expected a square HxWx3 uint8 tile")
    if family not in FAMILY_SURFACE:
        raise ValueError(f"unsupported family: {family}")
    size = rgb_u8.shape[0]
    luminance = srgb_to_linear(rgb_u8) @ LUMA
    log_l = np.log(np.maximum(luminance, 1e-4))
    band = _periodic_gaussian(log_l, 1.5 * size / 512) - _periodic_gaussian(log_l, 14 * size / 512)
    scale = max(float(np.percentile(np.abs(band), 97)), 1e-4)
    height = np.clip(0.5 + 0.5 * band / scale, 0, 1).astype(np.float32)  # darker crevices sit lower
    detail = np.abs(log_l - _periodic_gaussian(log_l, 3 * size / 512))
    detail = detail / max(float(np.percentile(detail, 97)), 1e-4)
    base_roughness = FAMILY_SURFACE[family][0]
    roughness = np.clip(base_roughness + 0.12 * (np.clip(detail, 0, 1) - 0.5), 0.2, 0.7).astype(np.float32)
    return {"base_color": rgb_u8, "height": height, "roughness": roughness}


def normal_from_height(height_mm: np.ndarray, pixel_mm: float) -> np.ndarray:
    """Periodic central differences; PNG rows down; OpenGL tangent +Y up (same as the authored library)."""
    dx = (np.roll(height_mm, -1, 1) - np.roll(height_mm, 1, 1)) / (2 * pixel_mm)
    dy = (np.roll(height_mm, -1, 0) - np.roll(height_mm, 1, 0)) / (2 * pixel_mm)
    normal = np.stack((-dx, dy, np.ones_like(height_mm)), -1)
    return normal / np.linalg.norm(normal, axis=-1, keepdims=True)


def _write_png(path: Path, array: np.ndarray, *, srgb: bool, bits: int = 8, size: int) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    if array.dtype == np.uint8:
        quantized = array
    else:
        top = 65535 if bits == 16 else 255
        quantized = np.rint(np.clip(array, 0, 1) * top).astype(np.uint16 if bits == 16 else np.uint8)
    if quantized.ndim == 3 and quantized.shape[-1] == 1:
        quantized = quantized[..., 0]
    info = PngImagePlugin.PngInfo()
    if srgb:
        info.add(b"sRGB", b"\x00")
    else:
        info.add(b"gAMA", (100000).to_bytes(4, "big"))
    Image.fromarray(quantized).save(path, pnginfo=info)
    with Image.open(path) as check:
        check.load()
        if check.size != (size, size):
            raise ValueError("PNG read-back dimensions differ")
    return {"sha256": sha256_file(path), "bytes": path.stat().st_size}


def diagnostics(maps: dict[str, np.ndarray]) -> dict:
    report = {}
    for key, value in maps.items():
        value = np.asarray(value, dtype=np.float32)
        value = value / 255 if key == "base_color" else value
        adjacent = np.concatenate((np.abs(np.diff(value, axis=0)).ravel(), np.abs(np.diff(value, axis=1)).ravel()))
        seam = np.concatenate((np.abs(value[0] - value[-1]).ravel(), np.abs(value[:, 0] - value[:, -1]).ravel()))
        report[key] = {"min": float(value.min()), "max": float(value.max()), "mean": float(value.mean()),
                       "std": float(value.std()), "seam_mean_abs": float(seam.mean()),
                       "interior_neighbor_mean_abs": float(adjacent.mean()),
                       "seam_to_neighbor_ratio": float(seam.mean() / max(float(adjacent.mean()), 1e-8))}
    return report


def export_study(sample_dir: Path, output: Path, *, wetness: float = 0.6, px_per_mm: float = AUTHORED_PX_PER_MM,
                 rights: dict | None = None, allow_resampled: bool = False) -> dict:
    """Write a complete viscera.tissue-materials/v1 study from a sampled tile directory. Output must be new."""
    sample_dir, output = Path(sample_dir), Path(output)
    receipt = json.loads((sample_dir / "sample.json").read_text())
    if receipt.get("schema") != SCHEMA_SAMPLE:
        raise ValueError("not a learned tile sample")
    if not 0 <= wetness <= 1 or not 1 <= px_per_mm <= 100:
        raise ValueError("invalid export parameters")
    tile = sample_dir / "tile.png"
    if sha256_file(tile) != receipt["tile_sha256"]:
        raise ValueError("tile differs from its sample receipt")
    with Image.open(tile) as image:
        rgb = np.asarray(image.convert("RGB"))
    family = receipt["family"]
    maps = derive_channels(rgb, family)
    size = rgb.shape[0]
    native = int(receipt["native_size"])
    if size != native and not allow_resampled:
        raise ValueError("resampled (hires) tiles are not exported as studies: the browser importer requires "
                         "native_resolution == resolution; pass allow_resampled=True for a review-only export")
    roughness_base, relief_mm = FAMILY_SURFACE[family]
    # Physical extent follows the NATIVE tile; a 2x hires pass adds pixels, not millimetres.
    tile_mm = native / px_per_mm
    pixel_mm = tile_mm / size
    height_mm = (maps["height"] - 0.5) * relief_mm
    normal = normal_from_height(height_mm, pixel_mm) * 0.5 + 0.5
    output.mkdir(parents=True, exist_ok=False)
    zero = np.zeros((size, size), np.float32)
    rgba = np.zeros((size, size, 4), np.float32)
    channels = {}
    for key, array, srgb, bits, extra in (
        ("substrate", rgb, True, 8, {"role": "learned appearance; illumination-flattened observed RGB distribution, not measured albedo"}),
        ("base_color", rgb, True, 8, {"role": "same as substrate; no semantic layers are separable"}),
        ("normal", normal, False, 8, {"convention": "OpenGL +Y", "role": "derived from luminance band-pass height at authored mm amplitude"}),
        ("roughness", maps["roughness"], False, 8, {"role": f"authored organ roughness {roughness_base} with bounded luminance-detail modulation; not measured"}),
        ("height", maps["height"], False, 16, {"unit": "mm", "decode_range": [-relief_mm / 2, relief_mm / 2], "role": "luminance band-pass; authored amplitude; darker = lower; not measured"}),
        ("thickness", np.full_like(zero, 1 / 6), False, 16, {"unit": "mm", "decode_range": [0, 6], "role": "constant authored 1 mm placeholder"}),
        ("transition", zero, False, 8, {}),
        ("metallic", zero, False, 8, {"role": "dielectric tissue; zero"}),
    ):
        name = f"{key}.png"
        channels[key] = {"file": name, "color_space": "srgb" if srgb else "linear", "bit_depth": bits, **extra,
                         **_write_png(output / name, array, srgb=srgb, bits=bits, size=size)}
    layers = []
    for key in ("vessels", "fascia", "adipose"):
        name = f"overlays/{key}.png"
        layers.append({"id": key, "file": name, "opacity": 0, "alpha": "straight, linear coverage",
                       "color_space": "srgb", "bit_depth": 8,
                       "role": "empty authored overlay; generated features are inseparable in substrate",
                       **_write_png(output / name, rgba, srgb=True, size=size)})
    # A uniform authored wet coat so the Studio wetness control works; coverage is not learned.
    coat = np.ones((size, size, 4), np.float32)
    layers.append({"id": "wet_film", "file": "overlays/wet_film.png", "opacity": wetness, "alpha": "straight, linear coverage",
                   "color_space": "srgb", "bit_depth": 8, "role": "clearcoat_coverage",
                   "meaning": "uniform authored wet coat (coverage 1, opacity = recipe wetness); not a learned or measured film",
                   **_write_png(output / "overlays/wet_film.png", coat, srgb=True, size=size)})
    report = diagnostics({"base_color": rgb, "height": maps["height"], "roughness": maps["roughness"]})
    (output / "diagnostics.json").write_text(json.dumps(report, indent=2) + "\n")
    label = f"{LABELS[family]} · learned" + (f" ({receipt['condition']})" if receipt.get("condition") else "")
    manifest = {"schema": "viscera.tissue-materials/v1", "generator": GENERATOR, "label": label,
                "resolution": [size, size], "physical_size_mm": [tile_mm, tile_mm], "pixel_size_mm": pixel_mm,
                "recipe": {"organ": family, "seed": str(receipt["seed"]), "tile_size_mm": tile_mm, "wetness": wetness,
                           "vessel_opacity": 0, "fascia_opacity": 0, "adipose_opacity": 0,
                           "condition": receipt.get("condition")},
                "channels": channels, "layers": layers,
                "composition": {"space": "linear RGB", "opacity_semantics": "area coverage"},
                "provenance": {"schema": SCHEMA_SAMPLE, "executed": True, "sample": receipt,
                               "native_resolution": [native, native],
                               "training_profile": receipt.get("training_profile"), "training_rights": receipt.get("rights"),
                               "run_id": receipt.get("run_id"),
                               "scale_policy": f"authored {px_per_mm} px/mm working scale; source frames are uncalibrated",
                               "rights": rights or {}, "luminal": family in MUCOSA_FAMILIES},
                "diagnostics": report,
                "limitations": ["Learned from illumination-flattened surgical RGB; base colour is not measured albedo",
                                f"Native learned detail is {receipt['native_size']}² at about {px_per_mm:g} px/mm; larger maps add no measured detail",
                                "Height, normal and roughness are derived or authored, not measured",
                                "No vessel/fascia/adipose layer separation; overlays are empty",
                                "No subsurface scattering recovery; wet coat is a rendering approximation",
                                "Not clinically qualified; no surgeon review"],
                "qualification": "learned appearance pilot; visual and held-out review required"}
    for asset in [*channels.values(), *layers]:
        path = output / asset["file"]
        if path.stat().st_size != asset["bytes"] or sha256_file(path) != asset["sha256"]:
            raise ValueError("export changed during verification")
    with (output / "manifest.json").open("x") as handle:
        json.dump(manifest, handle, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    return manifest


def browser_bundle(study: Path) -> Path:
    """Reuse the reviewed data-only bundle writer of the pretrained pilot (same manifest contract)."""
    from viscera_core.tissue_diffusion.contract import write_browser_bundle

    study = Path(study)
    manifest = json.loads((study / "manifest.json").read_text())
    if manifest["provenance"]["native_resolution"] != manifest["resolution"]:
        raise ValueError("browser bundles require native_resolution == resolution (pbrBundle.ts)")
    return write_browser_bundle(study, manifest)
