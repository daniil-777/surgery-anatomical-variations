"""Source-referenced outer-surface morphology, never a disease diagnosis or FEM model.

Compact C2 displacement fields are composed with a global Lipschitz bound < 1
per step. This prevents folds in the continuous map, not collisions already in
the source mesh or an anatomical-validity guarantee for the discretized surface.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator

VERSION = "disease-morphology-design-1.0.0"
PROFILE_PATH = Path(__file__).with_name("disease_profiles.json")
_PROFILES = json.loads(PROFILE_PATH.read_text())["profiles"]
PROFILES = {p["id"]: p for p in _PROFILES}
CONTROL_NAMES = ("severity", "size", "spread", "irregularity", "contrast", "count")


class DiseaseSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    profile_id: str = Field(min_length=1, max_length=100)
    seed: int = Field(default=42, ge=0, le=2**32 - 1, strict=True)
    severity: float = Field(default=0.55, ge=0, le=1)
    size: float = Field(default=0.5, ge=0, le=1)
    spread: float = Field(default=0.5, ge=0, le=1)
    irregularity: float = Field(default=0.35, ge=0, le=1)
    contrast: float = Field(default=0.45, ge=0, le=1)
    count: int = Field(default=3, ge=1, le=8, strict=True)
    location: tuple[float, float, float] = (0.25, 0.15, 0.8)

    @field_validator("profile_id")
    @classmethod
    def profile(cls, value: str) -> str:
        if value not in PROFILES:
            raise ValueError("Unknown disease profile")
        if not PROFILES[value]["supported"]:
            raise ValueError(PROFILES[value]["unavailable_reason"])
        return value

    @field_validator("severity", "size", "spread", "irregularity", "contrast", mode="before")
    @classmethod
    def strict_number(cls, value: Any) -> Any:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Disease controls must be numeric")
        return value

    @field_validator("location", mode="before")
    @classmethod
    def location_bounds(cls, value: Any) -> Any:
        if (
            not isinstance(value, (list, tuple))
            or len(value) != 3
            or any(
                isinstance(x, bool)
                or not isinstance(x, (float, int))
                or not -1 <= x <= 1
                for x in value
            )
        ):
            raise ValueError("Location must be three finite authoring-frame coordinates in [-1,1]")
        return value


def disease_catalog() -> dict[str, Any]:
    defaults = {}
    for p in _PROFILES:
        if p["supported"] and p["organ"] not in defaults:
            defaults[p["organ"]] = DiseaseSpec(profile_id=p["id"]).model_dump(mode="json")
    labels = [
        "Morphology strength",
        "Region size",
        "Region spread",
        "Pattern irregularity",
        "Color contrast",
        "Pattern sites",
    ]
    return {
        "version": VERSION,
        "profiles": json.loads(json.dumps(_PROFILES)),
        "defaults": defaults,
        "controls": [
            {
                "key": k,
                "label": label,
                "min": 1 if k == "count" else 0,
                "max": 8 if k == "count" else 1,
                "default": 3 if k == "count" else 0.5,
            }
            for k, label in zip(CONTROL_NAMES, labels, strict=True)
        ],
        "scope": "authored_morphology_design_not_clinical_stage",
        "profile_sha256": hashlib.sha256(PROFILE_PATH.read_bytes()).hexdigest(),
    }


def sample_disease(profile_id: str, seed: int, strength: float = 1) -> DiseaseSpec:
    base = DiseaseSpec(profile_id=profile_id, seed=seed)
    if isinstance(strength, bool) or not np.isfinite(strength) or not 0 <= strength <= 1:
        raise ValueError("Variation strength must be in [0,1]")
    rng = np.random.default_rng(seed)
    values = base.model_dump()
    for name in CONTROL_NAMES[:-1]:
        values[name] = float(values[name] * (1 - strength) + rng.uniform(0.1, 0.9) * strength)
    values["count"] = int(np.clip(round(3 * (1 - strength) + rng.integers(1, 9) * strength), 1, 8))
    values["location"] = [
        float(x * (1 - strength) + y * strength)
        for x, y in zip(base.location, rng.uniform(-0.85, 0.85, 3), strict=True)
    ]
    return DiseaseSpec.model_validate(values)


def _eligible_vertices(template: Any, profile: dict[str, Any]) -> np.ndarray:
    """Exclude named attachments; use explicitly named target regions where available."""
    components = template.metadata["components"]
    names = [str(c.get("name", "")).lower() for c in components]
    preferred = {
        "liver": "capsule",
        "heart": "left_ventricle",
        "small-intestine": "jejunum",
        "large-intestine": "sigmoid",
    }.get(profile["organ"])
    ids = [i for i, n in enumerate(names) if preferred and preferred in n]
    if not ids:
        ids = [
            i
            for i, n in enumerate(names)
            if not any(t in n for t in ("ligament", "artery", "vein", "ureter", "duct"))
        ]
    if not ids:
        ids = list(range(len(names)))
    return np.isin(template.component_ids, ids)


def disease_field(template: Any, spec: DiseaseSpec) -> dict[str, Any]:
    profile = PROFILES[spec.profile_id]
    if profile["organ"] != template.metadata["organ"]:
        raise ValueError("Disease profile must match the selected organ")
    vertices = np.asarray(template.vertices_mm, dtype=np.float64)
    from .atlas import _prepare_cache
    from .atlas_scene import display_normals

    # The legacy decoder treats a nonempty cache as fully initialized. Populate
    # its geometry entries before adding a namespaced display-normal entry.
    _prepare_cache(template)

    if "disease_normals" not in template._cache:
        template._cache["disease_normals"] = display_normals(
            vertices, template.faces, profile["organ"]
        )[0]
    normals = template._cache["disease_normals"]
    eligible = np.flatnonzero(_eligible_vertices(template, profile))
    eligible = eligible[np.linalg.norm(normals[eligible], axis=1) > 0.5]
    if not len(eligible):
        raise ValueError("Selected source has no supported anatomy for this profile")
    points = vertices[eligible]
    center = (points.max(axis=0) + points.min(axis=0)) / 2
    extent = np.ptp(points, axis=0)
    scale = max(float(np.linalg.norm(extent)), 1.0)
    target = center + np.asarray(spec.location) * extent * 0.5
    rng = np.random.default_rng(spec.seed)
    pattern = profile["pattern"]
    radius = scale * (0.035 + 0.065 * spec.size)
    if pattern in ("nodular", "cysts", "pouches"):
        radius *= 0.30 if pattern == "nodular" else 0.45
    if pattern in ("inflammation", "dilation", "fibrosis", "scar", "infiltrative"):
        radius *= 2
    count = min(48, spec.count * (12 if pattern == "nodular" else 2 if pattern == "cysts" else 1))
    # Surface anchors are selected by surface distance, never arbitrary off-organ coordinates.
    anchors = [int(eligible[np.argmin(np.linalg.norm(points - target, axis=1))])]
    order = rng.permutation(eligible)
    target_distance = np.linalg.norm(vertices[order] - vertices[anchors[0]], axis=1)
    order = order[target_distance <= scale * (0.15 + 0.85 * spec.spread)]
    for index in order:
        if len(anchors) >= count:
            break
        # Disjoint compact supports permit a max, rather than a sum, gradient bound.
        if np.linalg.norm(vertices[anchors] - vertices[index], axis=1).min() >= 2 * radius * 1.001:
            anchors.append(int(index))
    sign = -1 if pattern in ("scar", "fibrosis") else 1
    colors = {
        "scar": [0.64, 0.53, 0.43],
        "fibrosis": [0.60, 0.48, 0.36],
        "cyst": [0.49, 0.38, 0.26],
        "cysts": [0.48, 0.37, 0.27],
        "mass": [0.67, 0.45, 0.32],
        "multifocal": [0.68, 0.46, 0.34],
        "nodular": [0.45, 0.26, 0.13],
        "inflammation": [0.46, 0.055, 0.045],
        "pouches": [0.53, 0.29, 0.24],
        "infiltrative": [0.45, 0.25, 0.20],
        "dilation": [0.51, 0.35, 0.31],
    }
    fields = []
    for index in anchors:
        normal = np.array(normals[index], dtype=float, copy=True)
        normal /= max(float(np.linalg.norm(normal)), 1e-12)
        # ||grad (1-r²)^3|| <= 1.718 / radius. A .20r displacement has bound < .344.
        amplitude = (
            radius
            * 0.20
            * spec.severity
            * (1 - spec.irregularity * 0.3 + rng.random() * spec.irregularity * 0.3)
        )
        # Retraction/inflammation are shallow regional changes, not tumor-like
        # protrusions. These gains remain engineering design choices, not stages.
        amplitude *= {
            "scar": 0.125,
            "fibrosis": 0.175,
            "inflammation": 0.25,
            "dilation": 0.325,
            "infiltrative": 0.5,
            "nodular": 0.6,
        }.get(pattern, 1.0)
        fields.append(
            {
                "center_mm": vertices[index].tolist(),
                "radius_mm": radius,
                "direction": (normal * sign).tolist(),
                "amplitude_mm": float(amplitude),
            }
        )
    return {
        "version": VERSION,
        "profile_id": spec.profile_id,
        "pattern": pattern,
        "fields": fields,
        "steps": 3,
        "target_srgb": colors[pattern],
        "color_strength": spec.severity * spec.contrast,
        "requested_sites": count,
        "realized_sites": len(fields),
        "gradient_bound_per_step": 0.344 * spec.severity,
        "surface_site_frame": "undeformed-atlas-Y-up-mm",
        "clinical_stage": None,
    }


def evaluate_mask(points: Any, field: dict[str, Any]) -> np.ndarray:
    points = np.asarray(points, dtype=float)
    mask = np.zeros(len(points))
    for site in field["fields"]:
        d2 = np.sum((points - np.asarray(site["center_mm"])) ** 2, axis=1) / site["radius_mm"] ** 2
        mask = np.maximum(mask, np.maximum(1 - d2, 0) ** 3)
    return mask


def deform_disease(points: Any, field: dict[str, Any]) -> np.ndarray:
    result = np.asarray(points, dtype=float).copy()
    for _ in range(field["steps"]):
        delta = np.zeros_like(result)
        for site in field["fields"]:
            d2 = (
                np.sum((result - np.asarray(site["center_mm"])) ** 2, axis=1)
                / site["radius_mm"] ** 2
            )
            weight = np.maximum(1 - d2, 0) ** 3
            delta += weight[:, None] * np.asarray(site["direction"]) * site["amplitude_mm"]
        result += delta
    return result


def apply_disease_color(rgb_srgb: Any, points: Any, field: dict[str, Any]) -> np.ndarray:
    rgb = np.asarray(rgb_srgb, dtype=float)
    amount = evaluate_mask(points, field)[:, None] * field["color_strength"]
    if not np.any(amount):
        return rgb.copy()
    target = np.asarray(field["target_srgb"], dtype=float)

    def linear(x: Any) -> np.ndarray:
        return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)

    mixed = linear(rgb) * (1 - amount) + linear(target) * amount
    return np.clip(
        np.where(
            mixed <= 0.0031308, mixed * 12.92, 1.055 * np.maximum(mixed, 0) ** (1 / 2.4) - 0.055
        ),
        0,
        1,
    )
