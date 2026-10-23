"""Bounded-memory PBR PNG exports with explicit units, provenance and content hashes."""

from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
import tempfile
import zlib
from contextlib import ExitStack
from numbers import Integral
from pathlib import Path

import numpy as np
import PIL
import scipy

from .field import linear_to_srgb, sample_tissue
from .recipe import ORGAN_PROFILES, VERSION, TissueRecipe


class _PngRows:
    """PNG scanline encoder: only one caller-supplied stripe is resident."""

    def __init__(self, path: Path, width: int, height: int, channels: int, bits: int, srgb: bool):
        self.file = path.open("wb")
        self.width, self.height, self.channels, self.bits = width, height, channels, bits
        self.rows = 0
        self.compressor = zlib.compressobj(level=6)
        self.file.write(b"\x89PNG\r\n\x1a\n")
        color_type = {1: 0, 3: 2, 4: 6}[channels]
        self._chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, bits, color_type, 0, 0, 0))
        if srgb:
            self._chunk(b"sRGB", b"\x00")
        else:
            self._chunk(b"gAMA", struct.pack(">I", 100000))

    def _chunk(self, kind: bytes, value: bytes) -> None:
        self.file.write(struct.pack(">I", len(value)))
        self.file.write(kind)
        self.file.write(value)
        self.file.write(struct.pack(">I", zlib.crc32(kind + value)))

    def write(self, values: np.ndarray) -> None:
        expected = (self.width,) if self.channels == 1 else (self.width, self.channels)
        if values.shape[1:] != expected or self.rows + len(values) > self.height:
            raise ValueError("PNG stripe shape does not match image")
        values = np.asarray(values, dtype=">u2" if self.bits == 16 else np.uint8)
        for row in values:
            data = self.compressor.compress(b"\x00" + row.tobytes())
            if data:
                self._chunk(b"IDAT", data)
        self.rows += len(values)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                if self.rows != self.height:
                    raise ValueError("PNG is incomplete")
                self._chunk(b"IDAT", self.compressor.flush())
                self._chunk(b"IEND", b"")
        finally:
            self.file.close()


def _u8(values: np.ndarray) -> np.ndarray:
    return np.rint(np.clip(values, 0, 1) * 255).astype(np.uint8)


def _u16(values: np.ndarray, low: float, high: float) -> np.ndarray:
    # Quantize in float64 so the error stays within half a 16-bit code, including
    # values close to a rounding threshold after applying a signed mm offset.
    return np.rint(np.clip((values.astype(np.float64) - low) / (high - low), 0, 1) * 65535).astype(
        np.uint16
    )


def _normal_from_height_halo(height: np.ndarray, pixel_mm: float) -> np.ndarray:
    """OpenGL tangent +Y points toward the image top; raster rows point down."""
    dx = (height[1:-1, 2:] - height[1:-1, :-2]) / (2 * pixel_mm)
    dy_down = (height[2:, 1:-1] - height[:-2, 1:-1]) / (2 * pixel_mm)
    normal = np.stack((-dx, dy_down, np.ones(dx.shape, dtype=np.float32)), axis=-1)
    return normal / np.linalg.norm(normal, axis=-1, keepdims=True)


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export_material(
    recipe: TissueRecipe,
    output_dir: str | Path,
    *,
    resolution: int = 4096,
    stripe_rows: int = 32,
    overwrite: bool = False,
) -> dict:
    """Export a seamless material set and return its JSON-compatible manifest.

    Work is staged in the destination directory. A complete manifest is published
    last. Existing files are protected unless overwrite is explicitly requested.
    A per-directory exclusive lock protects concurrent exporters. Pixel size and
    height are in millimeters; alpha is linear coverage, never tissue transmission.
    """
    if not isinstance(recipe, TissueRecipe):
        raise TypeError("recipe must be a TissueRecipe")
    for name, value, low, high in (
        ("resolution", resolution, 32, 4096),
        ("stripe_rows", stripe_rows, 1, 256),
    ):
        if isinstance(value, bool) or not isinstance(value, Integral) or not low <= value <= high:
            raise ValueError(f"{name} must be an integer in [{low}, {high}]")
    resolution, stripe_rows = int(resolution), int(stripe_rows)
    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    lock = target / ".tissue-export.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise RuntimeError(f"A tissue export already owns {target}") from None
    os.close(descriptor)
    try:
        files = [
            "substrate.png",
            "base_color.png",
            "normal.png",
            "substrate_normal.png",
            "layer_relief.png",
            "roughness.png",
            "substrate_roughness.png",
            "height.png",
            "thickness.png",
            "transition.png",
        ]
        files += [f"overlays/{name}.png" for name in ("vessels", "adipose", "fascia", "wet_film")]
        files.append("manifest.json")
        if not overwrite and any((target / name).exists() for name in files):
            raise FileExistsError(f"Material files already exist in {target}; pass overwrite=True")
        with tempfile.TemporaryDirectory(prefix=".tissue-stage-", dir=target) as temporary:
            stage = Path(temporary)
            (stage / "overlays").mkdir()
            manifest = _write_material(recipe, stage, resolution, stripe_rows)
            (target / "overlays").mkdir(exist_ok=True)
            # Invalidate the previous manifest before replacing its referenced files.
            # A failed update cannot present a stale manifest as a complete export.
            (target / "manifest.json").unlink(missing_ok=True)
            for filename in files:
                os.replace(stage / filename, target / filename)
        return manifest
    finally:
        lock.unlink(missing_ok=True)


def _write_material(recipe: TissueRecipe, stage: Path, resolution: int, stripe_rows: int) -> dict:
    channels = {
        "substrate": {
            "file": "substrate.png",
            "color_space": "srgb",
            "bit_depth": 8,
            "role": "unlit substrate before color overlays",
        },
        "base_color": {
            "file": "base_color.png",
            "color_space": "srgb",
            "bit_depth": 8,
            "role": "unlit composite diffuse reflectance approximation",
        },
        "normal": {
            "file": "normal.png",
            "color_space": "linear",
            "bit_depth": 8,
            "convention": "OpenGL +Y",
            "role": "tangent normal from physical height derivatives",
        },
        "substrate_normal": {
            "file": "substrate_normal.png",
            "color_space": "linear",
            "bit_depth": 8,
            "convention": "OpenGL +Y",
            "role": "tangent normal before all overlay relief; for editable layer composition",
        },
        "layer_relief": {
            "file": "layer_relief.png",
            "color_space": "linear",
            "bit_depth": 8,
            "unit": "mm",
            "packing": ["vessels", "adipose", "fascia"],
            "decode_scale_mm": [0.035, 0.45, 0.035],
            "decode_offset_mm": [0, 0, 0],
            "role": "RGB independent layer heights, coverage included, global opacity excluded",
        },
        "roughness": {
            "file": "roughness.png",
            "color_space": "linear",
            "bit_depth": 8,
            "role": "perceptual roughness",
        },
        "substrate_roughness": {
            "file": "substrate_roughness.png",
            "color_space": "linear",
            "bit_depth": 8,
            "role": "dry substrate perceptual roughness before fascia and wet-film controls",
        },
        "height": {
            "file": "height.png",
            "color_space": "linear",
            "bit_depth": 16,
            "unit": "mm",
            "decode_range": [-2.0, 2.0],
        },
        "thickness": {
            "file": "thickness.png",
            "color_space": "linear",
            "bit_depth": 16,
            "unit": "mm",
            "decode_range": [0.0, 6.0],
            "role": "uncalibrated subsurface path-length proxy; not measured anatomy",
        },
        "transition": {
            "file": "transition.png",
            "color_space": "linear",
            "bit_depth": 8,
            "role": "secondary surface family blending weight",
        },
    }
    layer_names = ("vessels", "adipose", "fascia", "wet_film")
    layer_opacities = (
        recipe.vessel_opacity,
        recipe.adipose_opacity,
        recipe.fascia_opacity,
        recipe.wetness,
    )
    layers = [
        {
            "id": name,
            "file": f"overlays/{name}.png",
            "opacity": opacity,
            "color_space": "srgb",
            "alpha": "straight, linear coverage",
            "bit_depth": 8,
            "role": "clearcoat_coverage" if name == "wet_film" else "color_overlay",
        }
        for name, opacity in zip(layer_names, layer_opacities)
    ]
    pixel_mm = recipe.tile_size_mm / resolution
    extrema = {
        name: [float("inf"), -float("inf")] for name in ("height_mm", "thickness_mm", "roughness")
    }
    normal_length_error = 0.0
    with ExitStack() as stack:
        writers = {}
        for name, channel in channels.items():
            count = (
                3
                if name in ("substrate", "base_color", "normal", "substrate_normal", "layer_relief")
                else 1
            )
            writers[name] = stack.enter_context(
                _PngRows(
                    stage / channel["file"],
                    resolution,
                    resolution,
                    count,
                    channel["bit_depth"],
                    channel["color_space"] == "srgb",
                )
            )
        for layer in layers:
            writers[layer["id"]] = stack.enter_context(
                _PngRows(stage / layer["file"], resolution, resolution, 4, 8, True)
            )
        # A one-pixel periodic halo makes stripe boundaries numerically identical
        # to a single full-image central difference. It also handles tile seams.
        u = (np.arange(-1, resolution + 1, dtype=np.float64)[None, :] + 0.5) / resolution
        for row in range(0, resolution, stripe_rows):
            end = min(row + stripe_rows, resolution)
            v = (np.arange(row - 1, end + 1, dtype=np.float64)[:, None] + 0.5) / resolution
            field = sample_tissue(recipe, u, v, footprint_mm=pixel_mm)
            interior = np.s_[1:-1, 1:-1]
            height = field.height_mm
            normal = _normal_from_height_halo(height, pixel_mm)
            normal_length_error = max(
                normal_length_error, float(np.max(np.abs(np.linalg.norm(normal, axis=-1) - 1)))
            )
            writers["substrate"].write(_u8(linear_to_srgb(field.substrate_linear[interior])))
            writers["base_color"].write(_u8(linear_to_srgb(field.base_color_linear[interior])))
            writers["normal"].write(_u8(normal * 0.5 + 0.5))
            substrate_normal = _normal_from_height_halo(field.substrate_height_mm, pixel_mm)
            writers["substrate_normal"].write(_u8(substrate_normal * 0.5 + 0.5))
            layer_relief = np.stack(
                [
                    field.layer_height_mm[name][interior] / scale
                    for name, scale in (("vessels", 0.035), ("adipose", 0.45), ("fascia", 0.035))
                ],
                axis=-1,
            )
            writers["layer_relief"].write(_u8(layer_relief))
            writers["roughness"].write(_u8(field.roughness[interior]))
            writers["substrate_roughness"].write(_u8(field.substrate_roughness[interior]))
            writers["height"].write(_u16(height[interior], -2, 2))
            writers["thickness"].write(_u16(field.thickness_mm[interior], 0, 6))
            writers["transition"].write(_u8(field.transition[interior]))
            for name in layer_names:
                writers[name].write(_u8(field.layers[name][interior]))
            for name in extrema:
                values = getattr(field, name)[interior]
                extrema[name][0] = min(extrema[name][0], float(values.min()))
                extrema[name][1] = max(extrema[name][1], float(values.max()))
    for asset in [*channels.values(), *layers]:
        path = stage / asset["file"]
        asset["sha256"], asset["bytes"] = _hash(path), path.stat().st_size
    manifest = {
        "schema": "viscera.tissue-materials/v1",
        "generator": VERSION,
        "label": ORGAN_PROFILES[recipe.organ].label,
        "recipe": recipe.to_dict(),
        "resolution": [resolution, resolution],
        "physical_size_mm": [recipe.tile_size_mm, recipe.tile_size_mm],
        "pixel_size_mm": pixel_mm,
        "uv": {
            "origin": "upper-left pixel center",
            "wrap": "repeat",
            "u": "right",
            "v": "down",
            "normal_derivative": "normalize(-dh/du_mm,+dh/dv_down_mm,1)",
            "normal_tangent_y": "toward PNG top; conventional OpenGL +Y with TextureLoader flipY=true",
        },
        "channels": channels,
        "layers": layers,
        "composition": {
            "space": "linear RGB",
            "order": ["substrate", "vessels", "adipose", "fascia"],
            "formula": "out = base * (1 - alpha * opacity) + decode_srgb(layer_rgb) * alpha * opacity",
            "wet_film": "clearcoat coverage only; never composite white highlights into albedo",
            "alpha_is_not": "physical transmission or optical tissue depth",
            "editable_relief": "Decode RGB layer_relief to mm; multiply by global layer opacity; add physical central-difference slopes to substrate_normal slopes before normalization. Do not add to already-combined normal.",
            "editable_roughness": "clamp((substrate_roughness + 0.10 * fascia_alpha * fascia_opacity) * (1 - 0.57 * wet_film_alpha * wetness), 0.075, 0.85); apply once",
        },
        "render_defaults": {
            "metalness": 0.0,
            "ior": 1.38,
            "clearcoat": recipe.wetness,
            "clearcoat_roughness": 0.11,
        },
        "measurement": {
            "field_ranges": extrema,
            "normal_unit_length_error_float32": normal_length_error,
            "height_clipped": extrema["height_mm"][0] < -2 or extrema["height_mm"][1] > 2,
        },
        "provenance": {
            "method": "deterministic procedural research baseline",
            "training_datasets": [],
            "trained_weights": None,
            "patient_specific": False,
            "clinically_validated": False,
            "parameters": "art-directed uncalibrated priors, not measurements",
            "seed_encoding": "uint64 integer; JSON consumers must preserve >2^53 seeds as decimal strings",
            "seed_decimal": str(recipe.seed),
            "network_raster_resolution": 2048,
            "vascular_graph": "Smooth continuous trunks with tangent-matched lateral branches, variable radius taper and authored depth-softening; seed XOR stable SHA256 organ-family salt; no patient graph or anatomical correspondence",
            "appearance": "Independent warm, pale and cool chromatic fields; relief and wet-film highlights separated from color. Qualitative reference observation, no photographic albedo fitting.",
            "physical_scale": "User-selected tile millimeters; pattern dimensions are authored approximations, not morphometry",
            "microstructure": "periodic analytic multiscale fields sampled at output resolution",
            "software": {
                "python": sys.version.split()[0],
                "numpy": np.__version__,
                "scipy": scipy.__version__,
                "pillow": PIL.__version__,
            },
            "source_sha256": {
                source.name: _hash(source) for source in sorted(Path(__file__).parent.glob("*.py"))
            },
        },
        "limitations": [
            "Surface appearance tiles do not reconstruct anatomy, organ interiors, mechanics, perfusion, cutting or pathology.",
            "A 4096 map describes pixel count, not photorealism, clinical accuracy or patient fidelity.",
            "Subsurface thickness is an artistic rendering proxy; no measured absorption or scattering coefficients.",
            "Vessel topology and transitions are illustrative; no patient-specific vascular adjacency or anatomical correspondence.",
            "Mucosa profiles approximate mesoscopic appearance; folds, villi geometry and histology require separate validated models.",
            "RGB compositing is a controllable appearance baseline, not spectral multilayer light transport.",
            "Morphology masks and physical feature frequencies are heuristic, with no surgeon evaluation.",
        ],
        "technical_sources": [
            "https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html",
            "https://pbr-book.org/4ed/Radiometry%2C_Spectra%2C_and_Color/Surface_Reflection",
            "https://pbr-book.org/3ed-2018/Light_Transport_II_Volume_Rendering/Subsurface_Scattering_Using_the_Diffusion_Equation",
        ],
    }
    (stage / "manifest.json").write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n")
    return manifest
