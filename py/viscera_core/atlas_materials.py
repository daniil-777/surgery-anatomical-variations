"""Continuous authored tissue materials, independent of frozen atlas geometry.

These are bounded visual design controls, not measured optics, histology,
vascular anatomy, disease labels, or constitutive material parameters.
CPU and WebGL2 evaluate the same field at arbitrary template-rest millimetres.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import numpy.typing as npt
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializationInfo,
    SerializerFunctionWrapHandler,
    field_validator,
    model_serializer,
    model_validator,
)

from .reference_color import ReferenceColor, transfer_base_color

MATERIAL_VERSION: Literal["atlas-material-2.0.0"] = "atlas-material-2.0.0"
SHADER_VERSION = "atlas-material-field-glsl-2.0.0"
FloatArray = npt.NDArray[np.float64]

# Scales, palettes and amplitudes below are explicit artistic heuristics.  In
# particular, "lobular" and "directional" never claim measured tissue structure.
PROFILES: dict[str, dict[str, Any]] = {
    "liver": {
        "color": "#793f37",
        "roughness": 0.43,
        "pigment": 0.36,
        "fine_mm": 0.48,
        "height_mm": 0.024,
        "structure_mm": 2.4,
        "structure": "soft",
    },
    "gallbladder": {
        "color": "#777953",
        "roughness": 0.40,
        "pigment": 0.25,
        "fine_mm": 0.42,
        "height_mm": 0.014,
        "structure_mm": 2.0,
        "structure": "soft",
    },
    "stomach": {
        "color": "#b58a80",
        "roughness": 0.48,
        "pigment": 0.24,
        "fine_mm": 0.52,
        "height_mm": 0.020,
        "structure_mm": 2.5,
        "structure": "soft",
    },
    "pancreas": {
        "color": "#bc9b80",
        "roughness": 0.56,
        "pigment": 0.30,
        "fine_mm": 0.55,
        "height_mm": 0.032,
        "structure_mm": 1.5,
        "structure": "lobular",
    },
    "spleen": {
        "color": "#713e52",
        "roughness": 0.44,
        "pigment": 0.34,
        "fine_mm": 0.45,
        "height_mm": 0.020,
        "structure_mm": 2.0,
        "structure": "soft",
    },
    "kidney": {
        "color": "#a15c50",
        "roughness": 0.42,
        "pigment": 0.28,
        "fine_mm": 0.42,
        "height_mm": 0.018,
        "structure_mm": 1.8,
        "structure": "soft",
    },
    "small-intestine": {
        "color": "#c09a89",
        "roughness": 0.45,
        "pigment": 0.22,
        "fine_mm": 0.46,
        "height_mm": 0.018,
        "structure_mm": 1.8,
        "structure": "soft",
    },
    "large-intestine": {
        "color": "#b89784",
        "roughness": 0.48,
        "pigment": 0.24,
        "fine_mm": 0.50,
        "height_mm": 0.020,
        "structure_mm": 2.0,
        "structure": "soft",
    },
    "heart": {
        "color": "#9d5e58",
        "roughness": 0.48,
        "pigment": 0.28,
        "fine_mm": 0.50,
        "height_mm": 0.026,
        "structure_mm": 1.4,
        "structure": "directional",
    },
    "lung": {
        "color": "#b5979b",
        "roughness": 0.54,
        "pigment": 0.22,
        "fine_mm": 0.40,
        "height_mm": 0.021,
        "structure_mm": 1.2,
        "structure": "lobular",
    },
    "brain": {
        "color": "#b8ada1",
        "roughness": 0.56,
        "pigment": 0.16,
        "fine_mm": 0.38,
        "height_mm": 0.012,
        "structure_mm": 1.6,
        "structure": "soft",
    },
    "urinary-bladder": {
        "color": "#b9958b",
        "roughness": 0.48,
        "pigment": 0.22,
        "fine_mm": 0.45,
        "height_mm": 0.018,
        "structure_mm": 2.0,
        "structure": "soft",
    },
}
PRESETS: dict[str, dict[str, Any]] = {
    "balanced": {
        "label": "Balanced",
        "description": "Subtle pigment and moist surface detail.",
        "color_multiplier": [1, 1, 1],
        "tint": 0.0,
        "pigment_contrast": 0.55,
        "mottle_scale_mm": 16.0,
        "wetness": 0.5,
        "fine_detail": 0.5,
        "structure_strength": 0.3,
    },
    "soft": {
        "label": "Soft",
        "description": "Lighter, quieter pigment with a softer sheen.",
        "color_multiplier": [1.08, 1.10, 1.10],
        "tint": -0.12,
        "pigment_contrast": 0.30,
        "mottle_scale_mm": 23.0,
        "wetness": 0.3,
        "fine_detail": 0.32,
        "structure_strength": 0.18,
    },
    "rich": {
        "label": "Rich pigment",
        "description": "Deeper organ-specific color with varied mottling.",
        "color_multiplier": [0.85, 0.81, 0.84],
        "tint": 0.12,
        "pigment_contrast": 0.78,
        "mottle_scale_mm": 10.0,
        "wetness": 0.45,
        "fine_detail": 0.62,
        "structure_strength": 0.45,
    },
    "moist": {
        "label": "Moist",
        "description": "A stronger wet sheen with restrained pigment contrast.",
        "color_multiplier": [0.98, 0.96, 0.96],
        "tint": 0.04,
        "pigment_contrast": 0.40,
        "mottle_scale_mm": 18.0,
        "wetness": 0.85,
        "fine_detail": 0.38,
        "structure_strength": 0.24,
    },
}
CONTROL_DEFINITIONS = (
    ("tint", "Warmth", -1.0, 1.0, 0.01),
    ("pigment_contrast", "Pigment contrast", 0.0, 1.0, 0.01),
    ("mottle_scale_mm", "Pattern size (mm)", 2.0, 40.0, 0.1),
    ("wetness", "Surface sheen", 0.0, 1.0, 0.01),
    ("fine_detail", "Fine surface detail", 0.0, 1.0, 0.01),
    ("structure_strength", "Tissue grain", 0.0, 1.0, 0.01),
)
CONTROL_NAMES = tuple(c[0] for c in CONTROL_DEFINITIONS)


class MaterialRecipe(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)
    version: Literal["atlas-material-2.0.0"] = MATERIAL_VERSION
    organ: str
    preset: Literal["balanced", "soft", "rich", "moist"] = "balanced"
    seed: int = Field(default=42, strict=True, ge=0, le=2**32 - 1)
    tint: float = Field(default=0.0, ge=-1, le=1)
    pigment_contrast: float = Field(default=0.55, ge=0, le=1)
    mottle_scale_mm: float = Field(default=16.0, ge=2, le=40)
    wetness: float = Field(default=0.5, ge=0, le=1)
    fine_detail: float = Field(default=0.5, ge=0, le=1)
    structure_strength: float = Field(default=0.3, ge=0, le=1)
    reference_color: ReferenceColor | None = None

    @model_validator(mode="after")
    def reference_matches_organ(self) -> MaterialRecipe:
        if self.reference_color is not None and self.reference_color.organ != self.organ:
            raise ValueError("Reference colour must match the selected material organ")
        return self

    @model_serializer(mode="wrap")
    def serialize_reference(
        self, handler: SerializerFunctionWrapHandler, info: SerializationInfo
    ) -> dict[str, Any]:
        result: dict[str, Any] = handler(self)
        if self.reference_color is None:
            result.pop("reference_color", None)
        return result

    @field_validator("organ")
    @classmethod
    def valid_organ(cls, value: str) -> str:
        if value not in PROFILES:
            raise ValueError("Material organ is not in the declared atlas library")
        return value

    @field_validator(*CONTROL_NAMES, mode="before")
    @classmethod
    def strict_finite_controls(cls, value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Material controls must be finite numeric values")
        try:
            result = float(value)
        except OverflowError as error:
            raise ValueError("Material controls must be finite numeric values") from error
        if not np.isfinite(result):
            raise ValueError("Material controls must be finite numeric values")
        return result


@dataclass(frozen=True)
class MaterialSample:
    rgb_linear: FloatArray
    rgb_srgb: FloatArray
    roughness: FloatArray
    height_mm: FloatArray
    height_gradient_drest_mm: FloatArray
    metadata: dict[str, Any]

    def __getitem__(self, key: str) -> Any:
        """Support the baker's mapping-style access as well as typed attributes."""
        if key not in self.__dataclass_fields__:
            raise KeyError(key)
        return getattr(self, key)


def _canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def _rgb(value: str) -> FloatArray:
    return np.array([int(value[i : i + 2], 16) / 255 for i in (1, 3, 5)], dtype=np.float64)


def srgb_to_linear(rgb: Any) -> FloatArray:
    x = np.asarray(rgb, dtype=np.float64)
    return np.asarray(
        np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4), dtype=np.float64
    )


def linear_to_srgb(rgb: Any) -> FloatArray:
    x = np.clip(np.asarray(rgb, dtype=np.float64), 0, 1)
    return np.asarray(
        np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055), dtype=np.float64
    )


def make_recipe(
    organ: str, preset: str = "balanced", seed: int = 42, **overrides: Any
) -> MaterialRecipe:
    if preset not in PRESETS:
        raise ValueError("Unknown material preset")
    defaults = {key: PRESETS[preset][key] for key in CONTROL_NAMES}
    return MaterialRecipe.model_validate(
        {"organ": organ, "preset": preset, "seed": seed, **defaults, **overrides}
    )


def material_presets(organ: str) -> list[dict[str, Any]]:
    return [
        {
            "id": name,
            "label": preset["label"],
            "description": preset["description"],
            "recipe": make_recipe(organ, name).model_dump(),
        }
        for name, preset in PRESETS.items()
    ]


def material_catalog() -> dict[str, Any]:
    return {
        "version": MATERIAL_VERSION,
        "shader_version": SHADER_VERSION,
        "presets": [
            {"id": key, "label": p["label"], "description": p["description"]}
            for key, p in PRESETS.items()
        ],
        "defaults": {organ: make_recipe(organ).model_dump() for organ in PROFILES},
        "organ_presets": {
            organ: {
                preset: {
                    "recipe": make_recipe(organ, preset).model_dump(),
                    "swatches": [
                        "#" + "".join(f"{int(np.clip(round(c * 255), 0, 255)):02x}" for c in rgb)
                        for rgb in (
                            resolve_material(make_recipe(organ, preset))["base_color_srgb"],
                            np.asarray(
                                resolve_material(make_recipe(organ, preset))["base_color_srgb"]
                            )
                            * 0.88,
                        )
                    ],
                }
                for preset in PRESETS
            }
            for organ in PROFILES
        },
        "controls": [
            {"key": key, "label": label, "min": low, "max": high, "step": step}
            for key, label, low, high, step in CONTROL_DEFINITIONS
        ],
        "organ_profiles": {
            organ: {
                "base_color_srgb": _rgb(p["color"]).tolist(),
                "structure_label": {
                    "soft": "Soft grain",
                    "lobular": "Lobular mottling",
                    "directional": "Directional grain",
                }[p["structure"]],
                "presets": material_presets(organ),
            }
            for organ, p in PROFILES.items()
        },
        "evidence": "design_heuristic",
        "optical_validation": "NOT_RUN",
        "geometry_modified": False,
        "clinical_state_labels": False,
    }


def resolve_material(recipe: MaterialRecipe | dict[str, Any]) -> dict[str, Any]:
    r = recipe if isinstance(recipe, MaterialRecipe) else MaterialRecipe.model_validate(recipe)
    profile, preset = PROFILES[r.organ], PRESETS[r.preset]
    # Tint is a small organ-relative artistic shift in sRGB, then converted once.
    base = np.clip(
        _rgb(profile["color"]) * np.array(preset["color_multiplier"])
        + r.tint * np.array([0.032, -0.008, -0.026]),
        0.02,
        0.94,
    )
    ligament = np.clip(_rgb("#beb09b") + r.tint * np.array([0.018, -0.004, -0.014]), 0.02, 0.94)
    if r.reference_color is not None:
        base = transfer_base_color(base, r.reference_color)
    mode = {"soft": 0, "directional": 1, "lobular": 2}[profile["structure"]]
    uniforms = {
        "uAtlasSeed": r.seed,
        "uAtlasBaseColor": srgb_to_linear(base).tolist(),
        "uAtlasLigamentColor": srgb_to_linear(ligament).tolist(),
        "uAtlasPigmentContrast": r.pigment_contrast,
        "uAtlasMottleScaleMm": r.mottle_scale_mm,
        "uAtlasWetness": r.wetness,
        "uAtlasFineDetail": r.fine_detail,
        "uAtlasStructureStrength": r.structure_strength,
        "uAtlasRoughnessBase": float(profile["roughness"]),
        "uAtlasPigmentAmplitude": float(profile["pigment"]),
        "uAtlasFineScaleMm": float(profile["fine_mm"]),
        "uAtlasHeightAmplitudeMm": float(profile["height_mm"]),
        "uAtlasStructureScaleMm": float(profile["structure_mm"]),
        "uAtlasStructureMode": mode,
        "uAtlasStructureStretch": [1.8, 0.24, 1.25] if mode == 1 else [1.0, 1.0, 1.0],
    }
    return {
        "version": MATERIAL_VERSION,
        "shader_version": SHADER_VERSION,
        "recipe": r.model_dump(),
        "recipe_sha256": _canonical_hash(r.model_dump()),
        "uniforms": uniforms,
        "base_color_srgb": base.tolist(),
        "ligament_color_srgb": ligament.tolist(),
        "clearcoat": 0.06 + 0.54 * r.wetness,
        "clearcoat_roughness": 0.48 - 0.30 * r.wetness,
        "metalness": 0.0,
        "coordinates": "template_rest_mm",
        "height_units": "mm",
        "normal_gradient": "d(height_mm)/d(template_rest_mm); apply as shading only",
        "region_ids": {"0": "tissue", "1": "ligament"},
        "evidence": "observed_reference_color; design_heuristic" if r.reference_color else "design_heuristic",
        **({"reference_color": r.reference_color.model_dump(mode="json"),
            "reference_scope": "observed tissue colour only; user-assigned identity; no optical or mechanical inference"}
           if r.reference_color else {}),
        "optical_validation": "NOT_RUN",
        "geometry_modified": False,
        "vascular_ground_truth": False,
        "structure_interpretation": "authored "
        + profile["structure"]
        + " grain, not measured microanatomy or fiber orientation",
        "shader_sha256": hashlib.sha256(MATERIAL_GLSL.encode()).hexdigest(),
    }


def resolved_material(recipe: MaterialRecipe | dict[str, Any]) -> dict[str, Any]:
    """Spelling alias retained for the initially proposed integration contract."""
    return resolve_material(recipe)


def material_region_ids(
    component_ids: Any, components: list[dict[str, Any]]
) -> npt.NDArray[np.int64]:
    ids = np.asarray(component_ids)
    if (
        ids.ndim != 1
        or not np.issubdtype(ids.dtype, np.integer)
        or (ids < 0).any()
        or (ids >= len(components)).any()
    ):
        raise ValueError("Component IDs must index the declared components")
    regions = np.array(
        [int("ligament" in c.get("name", "").lower()) for c in components], dtype=np.int64
    )
    return np.asarray(regions[ids], dtype=np.int64)


def _lattice(cell: npt.NDArray[np.int64], seed: int) -> FloatArray:
    mask = np.uint64(0xFFFFFFFF)
    q = cell.astype(np.uint64) & mask
    h = (
        (q[:, 0] * np.uint64(73856093))
        ^ (q[:, 1] * np.uint64(19349663))
        ^ (q[:, 2] * np.uint64(83492791))
        ^ np.uint64(seed)
    ) & mask
    h ^= h >> np.uint64(16)
    h = (h * np.uint64(2246822519)) & mask
    h ^= h >> np.uint64(13)
    h = (h * np.uint64(3266489917)) & mask
    h ^= h >> np.uint64(16)
    # Top 24 bits are exactly representable in a highp GLSL float.
    return np.asarray((h >> np.uint64(8)).astype(np.float64) / 16777215.0, dtype=np.float64)


def _noise_gradient(
    points: FloatArray, inv_scale: FloatArray, seed: int
) -> tuple[FloatArray, FloatArray]:
    q = points * inv_scale
    cell = np.floor(q).astype(np.int64)
    f = q - cell
    s = f * f * f * (f * (f * 6 - 15) + 10)
    ds = 30 * f * f * (f - 1) * (f - 1)
    value = np.zeros(len(points), dtype=np.float64)
    gradient = np.zeros_like(points)
    for x in (0, 1):
        for y in (0, 1):
            for z in (0, 1):
                c = np.array([x, y, z], dtype=np.int64)
                w = np.where(c, s, 1 - s)
                dw = np.where(c, ds, -ds)
                lattice = _lattice(cell + c, seed)
                value += lattice * np.prod(w, axis=1)
                gradient += lattice[:, None] * np.column_stack(
                    [
                        dw[:, 0] * w[:, 1] * w[:, 2],
                        w[:, 0] * dw[:, 1] * w[:, 2],
                        w[:, 0] * w[:, 1] * dw[:, 2],
                    ]
                )
    return value * 2 - 1, gradient * (2 * inv_scale)


def _attenuation(scale: float, footprint: FloatArray) -> FloatArray:
    t = np.clip((footprint / scale - 0.35) / 0.9, 0, 1)
    return np.asarray(1 - t * t * (3 - 2 * t), dtype=np.float64)


def _sample_chunk(
    uniforms: dict[str, Any], points: FloatArray, region: FloatArray, footprint: FloatArray
) -> tuple[FloatArray, FloatArray, FloatArray, FloatArray]:
    u = uniforms
    seed, scale, fine = u["uAtlasSeed"], u["uAtlasMottleScaleMm"], u["uAtlasFineScaleMm"]

    def scalar(x: float) -> FloatArray:
        return np.full(3, 1 / x, dtype=np.float64)

    coarse, _ = _noise_gradient(points, scalar(scale), seed ^ 137)
    meso, _ = _noise_gradient(points, scalar(scale * 0.24), seed ^ 509)
    grain, dg = _noise_gradient(points, scalar(fine), seed ^ 2017)
    micro, dm = _noise_gradient(points, scalar(fine * 0.37), seed ^ 7919)
    stretch = np.asarray(u["uAtlasStructureStretch"])
    structure, dst = _noise_gradient(points, stretch / u["uAtlasStructureScaleMm"], seed ^ 3571)
    if u["uAtlasStructureMode"] == 2:
        dst *= (1.5 - 1.5 * structure * structure)[:, None]
        structure *= 1.5 - 0.5 * structure * structure
    coarse *= _attenuation(scale, footprint)
    meso *= _attenuation(scale * 0.24, footprint)
    ag = _attenuation(fine, footprint)
    am = _attenuation(fine * 0.37, footprint)
    ast = _attenuation(u["uAtlasStructureScaleMm"] / float(np.max(stretch)), footprint)
    grain *= ag
    dg *= ag[:, None]
    micro *= am
    dm *= am[:, None]
    structure *= ast
    dst *= ast[:, None]
    attenuation = 1 - 0.7 * region
    base = (1 - region[:, None]) * np.array(u["uAtlasBaseColor"]) + region[:, None] * np.array(
        u["uAtlasLigamentColor"]
    )
    field = (
        0.56 * coarse
        + 0.30 * meso
        + 0.09 * u["uAtlasFineDetail"] * grain
        + 0.05 * u["uAtlasStructureStrength"] * structure
    )
    color = np.clip(
        base
        * (
            1
            + (u["uAtlasPigmentAmplitude"] * u["uAtlasPigmentContrast"] * attenuation * field)[
                :, None
            ]
            * np.array([1, 0.82, 0.70])
        ),
        0.001,
        0.98,
    )
    roughness = np.clip(
        u["uAtlasRoughnessBase"]
        + 0.13
        - 0.26 * u["uAtlasWetness"]
        + 0.07 * region
        + 0.045 * u["uAtlasFineDetail"] * grain
        + 0.025 * u["uAtlasPigmentContrast"] * meso,
        0.16,
        0.82,
    )
    amp = u["uAtlasHeightAmplitudeMm"] * u["uAtlasFineDetail"] * attenuation
    height = amp * (0.63 * grain + 0.25 * micro + 0.12 * u["uAtlasStructureStrength"] * structure)
    gradient = amp[:, None] * (0.63 * dg + 0.25 * dm + 0.12 * u["uAtlasStructureStrength"] * dst)
    return color, roughness, height, gradient


def sample_material(
    recipe: MaterialRecipe | dict[str, Any],
    rest_points_mm: Any,
    region_ids: Any = None,
    footprint_mm: Any = 0.0,
    *,
    chunk_size: int = 32768,
) -> MaterialSample:
    """Evaluate continuous material fields, including analytic shading gradients.

    `footprint_mm` is the local sampling diameter in rest mm. Filtering assumes
    a locally constant footprint; it attenuates unresolved frequencies rather
    than allowing seed-dependent high-frequency shimmer. This is an artistic
    band limit, not a measured tissue optical model.
    """
    r = recipe if isinstance(recipe, MaterialRecipe) else MaterialRecipe.model_validate(recipe)
    resolved = resolve_material(r)
    points = np.asarray(rest_points_mm, dtype=np.float64)
    if (
        points.ndim != 2
        or points.shape[1] != 3
        or not np.isfinite(points).all()
        or np.max(np.abs(points), initial=0) > 100000
    ):
        raise ValueError(
            "Rest sample coordinates must be finite N by 3 millimetres within +/-100000"
        )
    if type(chunk_size) is not int or not 1 <= chunk_size <= 65536:
        raise ValueError("chunk_size must be an integer in [1,65536]")
    regions = (
        np.zeros(len(points), dtype=np.float64)
        if region_ids is None
        else np.asarray(region_ids, dtype=np.float64)
    )
    if (
        regions.shape != (len(points),)
        or not np.isfinite(regions).all()
        or (regions < -1e-6).any()
        or (regions > 1 + 1e-6).any()
    ):
        raise ValueError(
            "Material regions must be aligned blend weights in [0,1], tissue to ligament"
        )
    regions = np.clip(regions, 0, 1)
    footprint = np.asarray(footprint_mm, dtype=np.float64)
    if footprint.ndim == 0:
        footprint = np.full(len(points), float(footprint), dtype=np.float64)
    if (
        footprint.shape != (len(points),)
        or not np.isfinite(footprint).all()
        or (footprint < 0).any()
    ):
        raise ValueError("Pixel footprints must be finite nonnegative rest-mm diameters")
    color = np.empty_like(points)
    roughness = np.empty(len(points))
    height = np.empty(len(points))
    gradient = np.empty_like(points)
    for start in range(0, len(points), chunk_size):
        sl = slice(start, start + chunk_size)
        color[sl], roughness[sl], height[sl], gradient[sl] = _sample_chunk(
            resolved["uniforms"], points[sl], regions[sl], footprint[sl]
        )
    return MaterialSample(color, linear_to_srgb(color), roughness, height, gradient, resolved)


# All constants and arithmetic match the CPU sampler.  Caller supplies highp
# precision and the listed uniforms; output is LINEAR RGB, never sRGB vertex RGB.
MATERIAL_GLSL = r"""
uniform highp uint uAtlasSeed;
uniform vec3 uAtlasBaseColor;
uniform vec3 uAtlasLigamentColor;
uniform float uAtlasPigmentContrast;
uniform float uAtlasMottleScaleMm;
uniform float uAtlasWetness;
uniform float uAtlasFineDetail;
uniform float uAtlasStructureStrength;
uniform float uAtlasRoughnessBase;
uniform float uAtlasPigmentAmplitude;
uniform float uAtlasFineScaleMm;
uniform float uAtlasHeightAmplitudeMm;
uniform float uAtlasStructureScaleMm;
uniform int uAtlasStructureMode;
uniform vec3 uAtlasStructureStretch;
struct AtlasMaterialSample {
  vec3 colorLinear;
  float roughness;
  float heightMm;
  vec3 heightGradientRest;
  float clearcoat;
  float clearcoatRoughness;
};
float atlasLattice(ivec3 cell, uint seed) {
  uvec3 q = uvec3(cell);
  uint h = (q.x*73856093u) ^ (q.y*19349663u) ^ (q.z*83492791u) ^ seed;
  h ^= h >> 16u; h *= 2246822519u; h ^= h >> 13u;
  h *= 3266489917u; h ^= h >> 16u;
  return float(h >> 8u)/16777215.0;
}
vec4 atlasNoiseGradient(vec3 p, vec3 invScale, uint seed) {
  vec3 q = p*invScale;
  ivec3 cell = ivec3(floor(q));
  vec3 f = q-vec3(cell);
  vec3 s = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec3 ds = 30.0*f*f*(f-1.0)*(f-1.0);
  vec4 outValue = vec4(0.0);
  for (int x=0; x<2; x++) for (int y=0; y<2; y++) for (int z=0; z<2; z++) {
    vec3 c=vec3(float(x),float(y),float(z));
    vec3 w=mix(1.0-s,s,c), dw=mix(-ds,ds,c);
    float v=atlasLattice(cell+ivec3(x,y,z),seed);
    outValue.x += v*w.x*w.y*w.z;
    outValue.yzw += v*vec3(dw.x*w.y*w.z,w.x*dw.y*w.z,w.x*w.y*dw.z);
  }
  return vec4(outValue.x*2.0-1.0,outValue.yzw*(2.0*invScale));
}
float atlasAttenuation(float scaleMm,float footprintMm) {
  float t=clamp((footprintMm/scaleMm-0.35)/0.9,0.0,1.0);
  return 1.0-t*t*(3.0-2.0*t);
}
AtlasMaterialSample atlasSampleMaterial(vec3 restMm,float region,float footprintMm) {
  region=clamp(region,0.0,1.0);
  float scale=uAtlasMottleScaleMm, fine=uAtlasFineScaleMm;
  vec4 coarse=atlasNoiseGradient(restMm,vec3(1.0/scale),uAtlasSeed ^ 137u);
  vec4 meso=atlasNoiseGradient(restMm,vec3(1.0/(scale*0.24)),uAtlasSeed ^ 509u);
  vec4 grain=atlasNoiseGradient(restMm,vec3(1.0/fine),uAtlasSeed ^ 2017u);
  vec4 micro=atlasNoiseGradient(restMm,vec3(1.0/(fine*0.37)),uAtlasSeed ^ 7919u);
  vec4 structure=atlasNoiseGradient(restMm,uAtlasStructureStretch/uAtlasStructureScaleMm,uAtlasSeed ^ 3571u);
  if (uAtlasStructureMode==2) {
    structure.yzw *= 1.5-1.5*structure.x*structure.x;
    structure.x *= 1.5-0.5*structure.x*structure.x;
  }
  coarse *= atlasAttenuation(scale,footprintMm);
  meso *= atlasAttenuation(scale*0.24,footprintMm);
  grain *= atlasAttenuation(fine,footprintMm);
  micro *= atlasAttenuation(fine*0.37,footprintMm);
  structure *= atlasAttenuation(uAtlasStructureScaleMm/max(max(uAtlasStructureStretch.x,uAtlasStructureStretch.y),uAtlasStructureStretch.z),footprintMm);
  float attenuation=1.0-0.7*region;
  vec3 base=mix(uAtlasBaseColor,uAtlasLigamentColor,region);
  float field=0.56*coarse.x+0.30*meso.x+0.09*uAtlasFineDetail*grain.x+0.05*uAtlasStructureStrength*structure.x;
  AtlasMaterialSample result;
  result.colorLinear=clamp(base*(1.0+uAtlasPigmentAmplitude*uAtlasPigmentContrast*attenuation*field*vec3(1.0,0.82,0.70)),vec3(0.001),vec3(0.98));
  result.roughness=clamp(uAtlasRoughnessBase+0.13-0.26*uAtlasWetness+0.07*region+0.045*uAtlasFineDetail*grain.x+0.025*uAtlasPigmentContrast*meso.x,0.16,0.82);
  float amp=uAtlasHeightAmplitudeMm*uAtlasFineDetail*attenuation;
  result.heightMm=amp*(0.63*grain.x+0.25*micro.x+0.12*uAtlasStructureStrength*structure.x);
  result.heightGradientRest=amp*(0.63*grain.yzw+0.25*micro.yzw+0.12*uAtlasStructureStrength*structure.yzw);
  result.clearcoat=0.06+0.54*uAtlasWetness;
  result.clearcoatRoughness=0.48-0.30*uAtlasWetness;
  return result;
}
"""


def material_shader_contract() -> dict[str, Any]:
    return {
        "version": SHADER_VERSION,
        "glsl": MATERIAL_GLSL,
        "sha256": hashlib.sha256(MATERIAL_GLSL.encode()).hexdigest(),
        "requirements": "WebGL2 / GLSL ES 3 integer arithmetic; highp float and highp int",
        "entry_point": "AtlasMaterialSample atlasSampleMaterial(vec3 restMm, float region, float footprintMm)",
        "input_coordinates": "Interpolated undeformed canonical atlas Y-up centered mm",
        "input_region": "0 tissue / 1 ligament; keep one region per surface component, never infer from pigment",
        "output_color_space": "linear-sRGB",
        "height_units": "mm",
        "normal_gradient_units": "height mm per rest-position mm",
        "geometry_policy": "Use height/gradient for fragment normal perturbation only; never displace vertices",
        "filtering": "footprintMm is a local rest-mm sampling diameter; analytic gradients assume locally constant footprint",
        "precision_policy": "Hash values use 24 high bits exactly representable in float32; field arithmetic is tolerance-tested, not byte-identical CPU float64/GPU float32",
    }
