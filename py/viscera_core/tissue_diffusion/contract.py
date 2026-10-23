"""Validate a general-domain diffusion sample and export an honest tissue study.

The model has no tissue calibration. Preserve its raw five predictions, use a
declared authored height scale to derive conventional OpenGL normals, suppress
metalness, and publish only after independent bytes/dimensions checks. No output
is promoted to the production catalog by this module.
"""

from __future__ import annotations

import hashlib
import base64
import json
import math
import os
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from PIL import Image, PngImagePlugin

FAMILIES = frozenset(("liver", "kidney", "heart", "lung", "spleen", "stomach",
    "small_bowel", "large_bowel", "pancreas", "gallbladder", "bladder", "uterus",
    "muscle", "fascia", "peritoneum", "mesentery", "gastric_mucosa",
    "intestinal_mucosa", "colonic_mucosa"))
NATIVE_RESOLUTION = 512
SCHEMA = "viscera.tissue-diffusion-pilot/v1"
DEFAULT_NEGATIVE = "metal, metallic, painted lighting, specular highlight, cast shadow, text, watermark, cartoon, illustration, black background"


@dataclass(frozen=True)
class PilotRequest:
    organ: str = "liver"
    seed: int = 42
    prompt: str = "Close-up homogeneous liver capsule tissue material, muted reddish brown, fine irregular mottling, delicate connective membrane, smooth fine grain, diffuse evenly lit, no organs, no objects"
    negative_prompt: str = DEFAULT_NEGATIVE
    steps: int = 50
    guidance: float = 7.5
    tile_size_mm: float = 80.0
    height_scale_mm: float = 0.08

    def __post_init__(self):
        if self.organ not in FAMILIES:
            raise ValueError("unsupported tissue family")
        if type(self.seed) is not int or not 0 <= self.seed < 2**64:
            raise ValueError("seed must be an unsigned 64-bit integer")
        if type(self.steps) is not int or not 1 <= self.steps <= 100:
            raise ValueError("steps must be 1..100")
        for key in ("prompt", "negative_prompt"):
            text = getattr(self, key)
            if not isinstance(text, str) or not text.strip() or len(text) > 1600 or "\x00" in text:
                raise ValueError(f"{key} must be a nonempty bounded string")
        for key, low, high in (("guidance", 1.01, 20), ("tile_size_mm", 10, 500),
                               ("height_scale_mm", 0.001, 1)):
            value = getattr(self, key)
            if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f"invalid {key}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validated_maps(maps: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    result = {}
    for key, channels in (("basecolor", 3), ("normal", 3), ("height", 1),
                          ("roughness", 1), ("metallic", 1)):
        value = np.asarray(maps.get(key))
        expected = (NATIVE_RESOLUTION, NATIVE_RESOLUTION, channels)
        if channels == 1 and value.shape == expected[:2]:
            value = value[..., None]
        if value.shape != expected or not np.issubdtype(value.dtype, np.floating):
            raise ValueError(f"{key} must be a native512 float HWC map")
        if not np.isfinite(value).all() or value.min() < 0 or value.max() > 1:
            raise ValueError(f"{key} contains invalid/out-of-range values")
        result[key] = value.astype(np.float32, copy=True)
    rgb = result["basecolor"]
    spatial_std = np.std(rgb, axis=(0, 1), dtype=np.float64)
    if float(spatial_std.max()) < 0.002 or float((rgb < .005).all(-1).mean()) > .9:
        raise ValueError("degenerate diffusion sample; no publishable color variation")
    return result


def normal_from_height(height: np.ndarray, pixel_mm: float) -> np.ndarray:
    """Periodic central differences, PNG rows down, OpenGL tangent +Y up."""
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2 * pixel_mm)
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / (2 * pixel_mm)
    normal = np.stack((-dx, dy, np.ones_like(height)), -1)
    return normal / np.linalg.norm(normal, axis=-1, keepdims=True)


def _write_png(path: Path, array: np.ndarray, *, srgb=False, bits=8) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    quantized = np.rint(np.clip(array, 0, 1) * (65535 if bits == 16 else 255)).astype(np.uint16 if bits == 16 else np.uint8)
    if quantized.ndim == 3 and quantized.shape[-1] == 1:
        quantized = quantized[..., 0]
    info = PngImagePlugin.PngInfo()
    info.add(b"sRGB", b"\x00") if srgb else info.add(b"gAMA", (100000).to_bytes(4, "big"))
    Image.fromarray(quantized).save(path, pnginfo=info)
    with Image.open(path) as check:
        check.load()
        if check.size != (NATIVE_RESOLUTION, NATIVE_RESOLUTION):
            raise ValueError("PNG read-back dimensions differ")
    return {"sha256": sha256_file(path), "bytes": path.stat().st_size}


def diagnostics(maps: dict[str, np.ndarray]) -> dict:
    report = {}
    for key, value in maps.items():
        # A large seam relative to local variation is diagnostic, not a claim of
        # biological realism or proof that every derivative is continuous.
        adjacent = np.concatenate((np.abs(np.diff(value, axis=0)).ravel(), np.abs(np.diff(value, axis=1)).ravel()))
        seam = np.concatenate((np.abs(value[0] - value[-1]).ravel(), np.abs(value[:, 0] - value[:, -1]).ravel()))
        report[key] = {"min": float(value.min()), "max": float(value.max()), "mean": float(value.mean()),
            "std": float(value.std()), "seam_mean_abs": float(seam.mean()),
            "spatial_std_per_channel": np.std(value, axis=(0, 1), dtype=np.float64).tolist(),
            "interior_neighbor_mean_abs": float(adjacent.mean()),
            "seam_to_neighbor_ratio": float(seam.mean() / max(float(adjacent.mean()), 1e-8))}
    return report


def export_material_bundle(maps: dict[str, np.ndarray], request: PilotRequest,
                           output: Path, provenance: dict) -> dict:
    """Create a new, complete review-only study; never overwrite an existing run.

    manifest.json is written last. A failed run is intentionally retained without
    a manifest, never mistaken for a complete bundle or silently deleted.
    """
    if not isinstance(request, PilotRequest):
        raise TypeError("validated PilotRequest required")
    values = validated_maps(maps)
    if provenance.get("schema") != SCHEMA or provenance.get("executed") is not True:
        raise ValueError("actual inference provenance required")
    if provenance.get("native_resolution") != [512, 512]:
        raise ValueError("native model resolution must be declared")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    raw = {}
    for key, value in values.items():
        name = f"raw/{key}.png"
        raw[key] = {"file": name, "color_space": "srgb" if key == "basecolor" else "linear",
            **_write_png(output / name, value, srgb=key == "basecolor", bits=16 if key == "height" else 8)}
    height_mm = (values["height"][..., 0] - .5) * request.height_scale_mm
    normal = normal_from_height(height_mm, request.tile_size_mm / 512) * .5 + .5
    roughness = values["roughness"][..., 0]
    zero = np.zeros((512, 512), np.float32)
    rgba = np.zeros((512, 512, 4), np.float32)
    channels = {}
    for key, array, srgb, bits, extra in (
        ("substrate", values["basecolor"], True, 8, {}),
        ("base_color", values["basecolor"], True, 8, {}),
        ("normal", normal, False, 8, {"convention": "OpenGL +Y", "role": "derived from model height at authored mm scale; raw predicted normal preserved separately"}),
        ("roughness", roughness, False, 8, {"role": "model predicted perceptual roughness; no wet-film multiplier"}),
        ("height", values["height"], False, 16, {"unit": "mm", "decode_range": [-request.height_scale_mm / 2, request.height_scale_mm / 2], "role": "authored physical scaling of inferred relative height; not measured"}),
        ("thickness", np.full_like(zero, 1 / 6), False, 16, {"unit": "mm", "decode_range": [0, 6], "role": "constant authored 1 mm placeholder; not used as measured optical thickness"}),
        ("transition", zero, False, 8, {}),
        ("metallic", zero, False, 8, {"role": "forced dielectric zero; original predicted metalness preserved in raw/"}),
    ):
        name = f"{key}.png"
        channels[key] = {"file": name, "color_space": "srgb" if srgb else "linear", "bit_depth": bits,
            **extra, **_write_png(output / name, array, srgb=srgb, bits=bits)}
    layers = []
    for key in ("vessels", "fascia", "adipose", "wet_film"):
        name = f"overlays/{key}.png"
        layers.append({"id": key, "file": name, "opacity": 0, "alpha": "straight, linear coverage",
            "color_space": "srgb", "bit_depth": 8, "role": "empty authored overlay; generated features are inseparable in substrate",
            **_write_png(output / name, rgba, srgb=True)})
    report = diagnostics(values)
    (output / "diagnostics.json").write_text(json.dumps(report, indent=2) + "\n")
    receipt = {**provenance, "request": {**asdict(request), "seed": str(request.seed)}, "raw_predictions": raw,
        "qualification": "general-domain pretrained pilot; visual review required; no tissue fine-tuning or clinical validation",
        "normal_policy": "height-derived OpenGL; upstream predicted-normal convention is unverified",
        "license": "upstream model card declares openrail without a full LICENSE file; preserve restriction uncertainty", "automatic_promotion": False}
    (output / "inference.json").write_text(json.dumps(receipt, indent=2) + "\n")
    manifest = {"schema": "viscera.tissue-materials/v1", "generator": SCHEMA,
        "label": f"{request.organ.replace('_', ' ').title()} · pretrained PBR pilot",
        "resolution": [512, 512], "physical_size_mm": [request.tile_size_mm] * 2,
        "pixel_size_mm": request.tile_size_mm / 512,
        "recipe": {"organ": request.organ, "seed": str(request.seed), "tile_size_mm": request.tile_size_mm,
                   "wetness": 0, "vessel_opacity": 0, "fascia_opacity": 0, "adipose_opacity": 0},
        "channels": channels, "layers": layers, "composition": {"space": "linear RGB", "opacity_semantics": "area coverage"},
        "provenance": receipt, "diagnostics": report,
        "limitations": ["General-domain model, no trained tissue specialization", "Native512 predictions; no released refiner or native4K claim",
            "Layer separation is unavailable; empty overlays intentionally do not invent it",
            "Height millimetres and thickness are authored", "Surface is opaque nonmetal", "No subsurface scattering recovery", "Not clinically qualified"]}
    # Independent read-back of all files referenced by the material contract.
    for asset in [*channels.values(), *layers, *raw.values()]:
        path = output / asset["file"]
        if path.stat().st_size != asset["bytes"] or sha256_file(path) != asset["sha256"]:
            raise ValueError("export changed during verification")
    with (output / "manifest.json").open("x") as handle:
        json.dump(manifest, handle, indent=2, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    write_browser_bundle(output, manifest)
    return manifest


def write_browser_bundle(output: Path, manifest: dict) -> Path:
    """Portable data-only maps for Studio; never embeds weights or Python code."""
    declarations = {}
    for asset in [*manifest["channels"].values(), *manifest["layers"]]:
        name = asset["file"]
        if name in declarations and declarations[name] != asset:
            raise ValueError("conflicting map declarations")
        declarations[name] = asset
    files = []
    for name, asset in sorted(declarations.items()):
        raw = (output / name).read_bytes()
        if hashlib.sha256(raw).hexdigest() != asset["sha256"] or len(raw) != asset["bytes"]:
            raise ValueError("map changed before browser bundle export")
        files.append({"file": name, "pngBase64": base64.b64encode(raw).decode("ascii")})
    bundle = {"schema": "viscera.tissue-pbr-bundle/v1", "manifest": manifest, "files": files}
    raw = (json.dumps(bundle, separators=(",", ":"), allow_nan=False) + "\n").encode()
    if len(raw) > 32 * 1024**2:
        raise ValueError("browser bundle exceeds the 32 MiB import budget")
    path = output / f"{manifest['recipe']['organ']}-seed{manifest['recipe']['seed']}.tissue-pbr.json"
    with path.open("xb") as handle:
        handle.write(raw)
    return path


def preserve_rejected_sample(maps: dict[str, np.ndarray], request: PilotRequest,
                             output: Path, provenance: dict, reason: str) -> Path:
    """Keep diagnostic floats and viewable raw maps without a Studio manifest."""
    target = Path(str(output) + "-rejected")
    target.mkdir(parents=True, exist_ok=False)
    # NumPy numeric arrays only; never an object array or pickle payload.
    numerical = {key: np.asarray(value, dtype=np.float32) for key, value in maps.items()
                 if key in ("basecolor", "normal", "height", "roughness", "metallic")}
    np.savez_compressed(target / "raw-predictions.npz", **numerical)
    for key, value in numerical.items():
        if value.shape[:2] == (512, 512) and np.isfinite(value).all():
            _write_png(target / f"{key}-preview.png", value, srgb=key == "basecolor")
    (target / "rejection.json").write_text(json.dumps({"schema": SCHEMA, "status": "rejected",
        "reason": reason, "request": {**asdict(request), "seed": str(request.seed)}, "provenance": provenance,
        "preview_policy": "clipped display PNGs; exact float arrays retained in raw-predictions.npz",
        "automatic_promotion": False}, indent=2, allow_nan=False) + "\n")
    return target
