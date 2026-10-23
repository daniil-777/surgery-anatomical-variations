"""V2 authored external phenotypes with bounded, continuous same-topology maps.

Compact displacement supports are disjoint in rest space. Each update has a
strict Lipschitz bound below one, followed by positive global axis scaling.
This certifies the continuous map, not discrete mesh collisions or diagnosis.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, cast

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator
from scipy.spatial import cKDTree

from .atlas_disease import _eligible_vertices
from .atlas_disease import apply_disease_color as apply_disease_color
from .atlas_disease import evaluate_mask as evaluate_mask

VERSION = "disease-morphology-design-2.0.0"
PROFILE_PATH = Path(__file__).with_name("disease_profiles_v2.json")
_PROFILES = json.loads(PROFILE_PATH.read_text())["profiles"]
PROFILES = {p["id"]: p for p in _PROFILES}
CONTROL_NAMES = ("severity", "size", "spread", "irregularity", "contrast", "count")
# Exact maximum of 6*t*(1-t*t)^2 is 96/(25*sqrt(5)).
KERNEL_GRADIENT_MAX = 96.0 / (25.0 * np.sqrt(5.0))


class DiseaseSpecV2(BaseModel):
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
        if value not in PROFILES or not PROFILES[value]["supported"]:
            raise ValueError("Unknown or internal-only disease-v2 surface profile")
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
            raise ValueError("Location must be three finite coordinates in [-1,1]")
        return value


DiseaseSpec = DiseaseSpecV2


def disease_catalog() -> dict[str, Any]:
    defaults: dict[str, Any] = {}
    for p in _PROFILES:
        if p["supported"] and p["organ"] not in defaults:
            defaults[p["organ"]] = DiseaseSpecV2(profile_id=p["id"]).model_dump(mode="json")
    return {
        "version": VERSION,
        "renderer_version": "disease-v2",
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
            for k, label in zip(
                CONTROL_NAMES,
                (
                    "Morphology strength",
                    "Region size",
                    "Region spread",
                    "Pattern irregularity",
                    "Color contrast",
                    "Pattern sites",
                ),
                strict=True,
            )
        ],
        "scope": "authored_external_phenotypes_not_clinical_stage",
        "profile_sha256": hashlib.sha256(PROFILE_PATH.read_bytes()).hexdigest(),
    }


def _source_cache(template: Any) -> dict[str, Any]:
    from .atlas import _prepare_cache
    from .atlas_scene import display_normals
    from .atlas_surface_normals import repair_display_normals

    cache = _prepare_cache(template)
    if "disease_v2" not in cache:
        v = np.asarray(template.vertices_mm, dtype=np.float64)
        normals = display_normals(v, template.faces, template.metadata["organ"])[0]
        normals = repair_display_normals(v, template.faces, normals)[0]
        eligible = np.flatnonzero(
            _eligible_vertices(template, {"organ": template.metadata["organ"]})
        )
        if template.metadata["organ"] == "kidney":
            capsule_ids = [
                i
                for i, c in enumerate(template.metadata["components"])
                if "capsule" in c.get("name", "").lower()
            ]
            if capsule_ids:
                eligible = eligible[np.isin(template.component_ids[eligible], capsule_ids)]
        # Double-wall capsules contain inward-facing inner surfaces. Lesion
        # anchors use outward-facing support; normals themselves are untouched.
        organ_center = (v[eligible].min(0) + v[eligible].max(0)) / 2
        radial = v[eligible] - organ_center
        radial /= np.maximum(np.linalg.norm(radial, axis=1)[:, None], 1e-30)
        outward = np.einsum("ij,ij->i", normals[eligible], radial) > 0.15
        eligible = eligible[outward]
        if not len(eligible):
            raise ValueError("No outward-facing external support for disease design")
        # Fixed candidate thinning is independent of recipe and preserves extrema.
        rng = np.random.default_rng(20873)
        pool = np.unique(
            np.r_[
                rng.choice(eligible, min(8192, len(eligible)), replace=False),
                eligible[np.argmin(v[eligible], axis=0)],
                eligible[np.argmax(v[eligible], axis=0)],
            ]
        )
        cache["disease_v2"] = {
            "normals": normals,
            "face_centers": v[template.faces].mean(1),
            "face_normals": cache["cross"] / np.maximum(cache["area2"][:, None], 1e-300),
            "face_tree": cKDTree(v[template.faces].mean(1)),
            "minimum_support_radius_mm": float(3 * np.quantile(cache["edge_lengths"], 0.9)),
            "eligible": eligible,
            "pool": pool,
            "tree": cKDTree(v),
            "eligible_tree": cKDTree(v[eligible]),
        }
    return cast(dict[str, Any], cache["disease_v2"])


def source_safe_shape_controls(
    template: Any, controls: dict[str, float]
) -> tuple[dict[str, float], float]:
    """Deterministic per-family source-safe projection, shared across both lanes."""
    cache = _source_cache(template)
    memo = cache.setdefault("v2_safe_shape_controls", {})
    key = tuple(controls.items())
    if key in memo:
        cached_controls, cached_fraction = memo[key]
        return dict(cached_controls), float(cached_fraction)
    for attempt in range(16):
        fraction = 2.0 ** (-attempt)
        projected = {k: float(v * fraction) for k, v in controls.items()}
        vertices = transform_points(template, projected, template.vertices_mm, None)
        qa = mesh_qa(template, vertices, None, projected)
        if (
            qa["passed"]
            and qa["minimum_all_precision_alignment"] > 0.1
            and qa["area_ratio_min"] > 0.02
            and qa["area_ratio_max"] < 20
        ):
            memo[key] = (projected, fraction)
            return projected, fraction
    raise ValueError("Source template cannot satisfy full discrete baseline QA")


def disease_field(
    template: Any, spec: DiseaseSpecV2, controls: Any | None = None
) -> dict[str, Any]:
    profile = PROFILES[spec.profile_id]
    if profile["organ"] != template.metadata["organ"]:
        raise ValueError("Disease profile must match selected organ")
    v = np.asarray(template.vertices_mm, dtype=np.float64)
    cache = _source_cache(template)
    eligible, normals = cache["eligible"], cache["normals"]
    points = v[eligible]
    center = (points.min(0) + points.max(0)) / 2
    extent = np.ptp(points, axis=0)
    diagonal = max(float(np.linalg.norm(extent)), 1.0)
    target = center + np.asarray(spec.location) * extent * 0.5
    first = int(eligible[cache["eligible_tree"].query(target)[1]])
    rng = np.random.default_rng(spec.seed)
    radius = diagonal * (
        profile["radius_min_fraction"] + profile["radius_range_fraction"] * spec.size
    )
    requested_radius = radius
    radius = max(radius, cache["minimum_support_radius_mm"])
    count = min(profile["maximum_sites"], spec.count * profile["count_multiplier"])
    anchors = [first]
    order = rng.permutation(cache["pool"])
    order = order[
        np.linalg.norm(v[order] - v[first], axis=1) <= diagonal * (0.18 + 0.82 * spec.spread)
    ]
    for index in order:
        if len(anchors) >= count:
            break
        if np.min(np.linalg.norm(v[anchors] - v[index], axis=1)) > 2 * radius * 1.001:
            anchors.append(int(index))
    fields = []
    for index in anchors:
        normal = np.array(normals[index], dtype=float, copy=True)
        normal /= np.linalg.norm(normal)
        outward = v[index] - center
        outward /= max(float(np.linalg.norm(outward)), 1e-30)
        normal += 0.35 * outward
        normal /= np.linalg.norm(normal)
        # Irregularity changes amplitude/site selection, not uncertified high-frequency geometry.
        ratio = (
            min(abs(profile["amplitude_ratio"]), 0.70 / profile["steps"])
            * spec.severity
            * (1 - 0.35 * spec.irregularity * rng.random())
        )
        fields.append(
            {
                "center_mm": v[index].tolist(),
                "radius_mm": float(radius),
                "direction": (normal * np.sign(profile["amplitude_ratio"])).tolist(),
                "amplitude_mm": float(radius * ratio),
                "anchor_vertex_id": index,
            }
        )
    bound = max(
        (s["amplitude_mm"] / s["radius_mm"] * KERNEL_GRADIENT_MAX for s in fields), default=0.0
    )
    if not 0 <= bound < 0.5:
        raise ValueError("Disease-v2 continuous derivative bound exceeded")
    global_log = np.asarray(profile["global_log_scale"], dtype=float) * spec.severity
    field = {
        "version": VERSION,
        "renderer_version": "disease-v2",
        "profile_id": spec.profile_id,
        "requested_morphology_strength": spec.severity,
        "pattern": profile["pattern"],
        "mechanism": profile["mechanism"],
        "fields": fields,
        "steps": int(profile["steps"]),
        "global_center_mm": center.tolist(),
        "global_log_scale": global_log.tolist(),
        "global_scale": np.exp(global_log).tolist(),
        "target_srgb": profile["target_srgb"],
        "color_strength": float(spec.severity * spec.contrast),
        "requested_sites": count,
        "requested_support_radius_mm": float(requested_radius),
        "effective_support_radius_mm": float(radius),
        "minimum_support_policy": "radius >=3 times source90th-percentile edge length; no invented tessellation",
        "realized_sites": len(fields),
        "gradient_bound_per_step": float(bound),
        "continuous_jacobian_lower_bound": float(
            np.exp(global_log.sum()) * (1 - bound) ** profile["steps"]
        ),
        "surface_site_frame": "undeformed-atlas-Y-up-mm",
        "clinical_stage": None,
        "visibility": profile["visibility"],
        "applied_displacement_fraction": 1.0,
        "normal_policy": "inverse-transpose-continuous-map-source-normal-v2",
        "site_policy": "outward-facing support; kidney capsule preferred; source normals untouched",
    }
    _limit_discrete_field(template, controls, field)
    return field


def _limit_discrete_field(template: Any, controls: Any | None, field: dict[str, Any]) -> None:
    """Certify the whole tessellated source, including global-map sliver faces.

    Capacity is established at unit requested strength, independently of the
    current severity. Requested geometry is relative to that source capacity.
    Float32 quantization can invalidate an intermediate strength independently;
    explicit deterministic backoffs then find a safe actual strength, or fail.
    The recorded effective strength is authoritative, not the requested label.
    """
    from .atlas import CONTROL_NAMES as SHAPE_NAMES

    if controls is None:
        controls = dict.fromkeys(SHAPE_NAMES, 0.0)
    cache = _source_cache(template)
    requested = float(field["requested_morphology_strength"])
    initial = [site["amplitude_mm"] for site in field["fields"]]
    if requested == 0:
        vertices = transform_points(
            template, controls, template.vertices_mm, field, tree=cache["tree"]
        )
        qa = mesh_qa(template, vertices, field, controls)
        if not qa["passed"]:
            raise ValueError("Source/shape combination fails full discrete face orientation QA")
        field["full_mesh_qa"] = qa
        field["effective_morphology_strength"] = 0.0
        return
    unit_amplitudes = np.asarray(initial) / requested
    unit_log = np.asarray(field["global_log_scale"]) / requested
    unit_gradient = float(field["gradient_bound_per_step"]) / requested

    def apply(level: float) -> None:
        for site, amplitude in zip(field["fields"], unit_amplitudes, strict=True):
            site["amplitude_mm"] = float(amplitude * level)
        field["global_log_scale"] = (unit_log * level).tolist()
        field["global_scale"] = np.exp(unit_log * level).tolist()
        field["gradient_bound_per_step"] = unit_gradient * level
        field["continuous_jacobian_lower_bound"] = float(
            np.exp(unit_log.sum() * level) * (1 - unit_gradient * level) ** field["steps"]
        )

    capacity = 1.0
    for _ in range(16):
        apply(capacity)
        vertices = transform_points(
            template, controls, template.vertices_mm, field, tree=cache["tree"]
        )
        qa = mesh_qa(template, vertices, field, controls)
        if (
            qa["passed"]
            and qa["minimum_all_precision_alignment"] > 0.025
            and qa["area_ratio_min"] > 0.01
            and qa["area_ratio_max"] < 25
        ):
            break
        capacity *= 0.5
    else:
        raise ValueError("No nonzero disease field passes full-source transported-face QA")
    # Keep a margin after a source-driven capacity reduction. This cap depends
    # on profile/layout/base controls but not the requested severity.
    if capacity < 1:
        capacity *= 0.9
    effective = requested * capacity
    intermediate_rejected_strengths = []
    for actual_backoffs in range(16):
        apply(effective)
        vertices = transform_points(
            template, controls, template.vertices_mm, field, tree=cache["tree"]
        )
        qa = mesh_qa(template, vertices, field, controls)
        if qa["passed"]:
            break
        intermediate_rejected_strengths.append(effective)
        effective *= 0.5
    else:
        raise ValueError("No requested-strength fallback passes full discrete precision QA")
    field["full_mesh_qa"] = qa
    field["effective_morphology_strength"] = effective
    field["applied_displacement_fraction"] = effective / requested
    field["discrete_guard"] = {
        "policy": "all original faces compared with exact inverse-transpose normal at original triangle centroid; every final recipe checked",
        "face_count": len(template.faces),
        "local_amplitude_fraction": effective / requested,
        "global_envelope_fraction": effective / requested,
        "strength_capacity": capacity,
        "strength_mapping": "requested_strength_times_source_capacity_then_explicit_precision_backoff",
        "actual_strength_backoffs": actual_backoffs,
        "intermediate_rejected_strengths": intermediate_rejected_strengths,
        "source_limited": effective < requested,
        "requested_max_step_amplitude_mm": max(initial, default=0.0),
        "effective_max_step_amplitude_mm": float(unit_amplitudes.max() * effective),
        "minimum_transported_face_alignment": qa["minimum_transported_face_alignment"],
        "opposed_transported_face_normals": 0,
    }


def deform_disease(
    points: Any, field: dict[str, Any], *, jacobian: bool = False, tree: Any | None = None
) -> Any:
    """Evaluate the exact same continuous map on meshes or arbitrary rest queries.

    Disjoint supports and an injective compact update ensure points cannot enter
    another support. Evaluating only the initial support is therefore exact.
    """
    result = np.asarray(points, dtype=np.float64).copy()
    if result.ndim != 2 or result.shape[1] != 3 or not np.isfinite(result).all():
        raise ValueError("Coordinates must be finite N x 3")
    jac = np.broadcast_to(np.eye(3), (len(result), 3, 3)).copy() if jacobian else None
    for site in field["fields"]:
        if site["amplitude_mm"] == 0:
            continue
        center = np.asarray(site["center_mm"])
        radius = float(site["radius_mm"])
        ids = (
            np.asarray(tree.query_ball_point(center, radius), dtype=np.intp)
            if tree is not None
            else np.flatnonzero(np.sum((result - center) ** 2, axis=1) < radius * radius)
        )
        q = result[ids].copy()
        a = np.asarray(site["direction"]) * site["amplitude_mm"]
        for _ in range(field["steps"]):
            delta = q - center
            wbase = np.maximum(1 - np.sum(delta * delta, axis=1) / (radius * radius), 0.0)
            if jac is not None:
                grad = -6 * wbase[:, None] ** 2 * delta / (radius * radius)
                update = np.eye(3)[None] + a[None, :, None] * grad[:, None, :]
                jac[ids] = update @ jac[ids]
            q += wbase[:, None] ** 3 * a
        result[ids] = q
    scale = np.asarray(field["global_scale"])
    center = np.asarray(field["global_center_mm"])
    if np.any(scale != 1):
        result = center + (result - center) * scale
    if jac is not None:
        jac *= scale[None, :, None]
        return result, jac
    return result


def transform_points(
    template: Any,
    controls: Any,
    points: Any,
    field: dict[str, Any] | None,
    *,
    normals: Any | None = None,
    tree: Any | None = None,
) -> Any:
    """Exact continuous transport, using analytic covectors without batched solves."""
    from .atlas import CONTROL_NAMES as SHAPE_NAMES
    from .atlas import deform_vertices

    p = np.asarray(points, dtype=float)
    if normals is None:
        q = deform_disease(p, field, tree=tree) if field else p.copy()
        return deform_vertices(
            q, controls, template.metadata["control_limits"], template.metadata["normalization_mm"]
        )
    q = p.copy()
    n = np.asarray(normals, dtype=float).copy()
    if field:
        for site in field["fields"]:
            if site["amplitude_mm"] == 0:
                continue
            center = np.asarray(site["center_mm"])
            radius = float(site["radius_mm"])
            ids = (
                np.asarray(tree.query_ball_point(center, radius), dtype=np.intp)
                if tree is not None
                else np.flatnonzero(np.sum((p - center) ** 2, axis=1) < radius * radius)
            )
            a = np.asarray(site["direction"]) * site["amplitude_mm"]
            local = q[ids].copy()
            covector = n[ids].copy()
            for _ in range(field["steps"]):
                delta = local - center
                w = np.maximum(1 - np.sum(delta * delta, axis=1) / (radius * radius), 0.0)
                grad = -6 * w[:, None] ** 2 * delta / (radius * radius)
                # (I+a grad^T)^-T n, Sherman-Morrison. The denominator is
                # strictly positive under the certified per-step derivative bound.
                denominator = 1 + grad @ a
                covector -= grad * ((covector @ a) / denominator)[:, None]
                local += w[:, None] ** 3 * a
            q[ids] = local
            n[ids] = covector
        scale = np.asarray(field["global_scale"])
        center = np.asarray(field["global_center_mm"])
        if np.any(scale != 1):
            q = center + (q - center) * scale
            n /= scale
    result = deform_vertices(
        q, controls, template.metadata["control_limits"], template.metadata["normalization_mm"]
    )
    c = np.asarray([controls[k] for k in SHAPE_NAMES]) * template.metadata["control_limits"]
    normalization = float(template.metadata["normalization_mm"])
    q /= normalization
    s = np.exp(c[:3])
    q *= s
    n /= s
    tz = np.tanh(q[:, 2])
    taper = np.exp(c[5] * tz)
    k = c[5] * (1 - tz * tz)
    n[:, 2] -= k * (q[:, 0] * n[:, 0] + q[:, 1] * n[:, 1])
    n[:, :2] /= taper[:, None]
    q[:, :2] *= taper[:, None]
    cs = np.cos(c[4] * tz)
    sn = np.sin(c[4] * tz)
    da = c[4] * (1 - tz * tz)
    x = cs * q[:, 0] - sn * q[:, 1]
    y = sn * q[:, 0] + cs * q[:, 1]
    nx = cs * n[:, 0] - sn * n[:, 1]
    ny = sn * n[:, 0] + cs * n[:, 1]
    n[:, 2] += da * (y * nx - x * ny)
    n[:, 0] = nx
    n[:, 1] = ny
    q[:, 0] = x
    q[:, 1] = y
    n[:, 2] -= 2 * c[3] * tz * (1 - tz * tz) * n[:, 0]
    q[:, 0] += c[3] * tz * tz
    n[:, 0] -= c[6] * (1 - np.tanh(q[:, 0]) ** 2) * n[:, 2]
    q[:, 2] += c[6] * np.tanh(q[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1)[:, None], 1e-300)
    return result, n


def mesh_qa(
    template: Any, vertices: Any, field: dict[str, Any] | None, controls: Any
) -> dict[str, Any]:
    from .atlas import CONTROL_NAMES as SHAPE_NAMES
    from .atlas import _prepare_cache

    v = np.asarray(vertices)
    cache = _prepare_cache(template)
    tri = v[template.faces]
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    areas = np.linalg.norm(cross, axis=1)
    valid = cache["area2"] > 2e-12
    ratios = areas[valid] / cache["area2"][valid]
    dots = np.einsum("ij,ij->i", cross[valid], cache["cross"][valid]) / np.maximum(
        areas[valid] * cache["area2"][valid], 1e-300
    )
    c = np.asarray([controls[k] for k in SHAPE_NAMES]) * template.metadata["control_limits"]
    lower = float(np.exp(c[:3].sum() - 2 * abs(c[5]))) * (
        field["continuous_jacobian_lower_bound"] if field else 1.0
    )
    bad = int(np.count_nonzero(areas[valid] <= 2e-12))
    source = _source_cache(template)
    _, transported = transform_points(
        template,
        controls,
        source["face_centers"],
        field,
        normals=source["face_normals"],
        tree=source["face_tree"],
    )
    alignment = np.einsum("ij,ij->i", cross[valid], transported[valid]) / np.maximum(
        areas[valid], 1e-300
    )
    opposed = int(np.count_nonzero(alignment <= 0.001))
    precision = {}
    for name, quantized in (
        ("studio_float32_mm", v.astype(np.float32).astype(np.float64)),
        ("gltf_float32_m", (v / 1000).astype(np.float32).astype(np.float64) * 1000),
    ):
        qt = quantized[template.faces]
        qc = np.cross(qt[:, 1] - qt[:, 0], qt[:, 2] - qt[:, 0])
        qa = np.linalg.norm(qc, axis=1)
        agreement = np.einsum("ij,ij->i", qc[valid], transported[valid]) / np.maximum(
            qa[valid], 1e-300
        )
        precision[name] = {
            "new_degenerate_faces": int(np.count_nonzero(qa[valid] <= 2e-12)),
            "opposed_transported_face_normals": int(np.count_nonzero(agreement <= 0.001)),
            "minimum_transported_face_alignment": float(agreement.min()),
            "maximum_vertex_roundtrip_error_mm": float(np.linalg.norm(quantized - v, axis=1).max()),
            "finite": bool(np.isfinite(qa).all() and np.isfinite(agreement).all()),
        }
    precision_passed = all(
        q["finite"]
        and q["new_degenerate_faces"] == 0
        and q["opposed_transported_face_normals"] == 0
        for q in precision.values()
    )
    passed = bool(
        np.isfinite(v).all()
        and np.isfinite(areas).all()
        and np.isfinite(alignment).all()
        and not bad
        and not opposed
        and lower > 0
        and precision_passed
        and np.all(valid)
    )
    return {
        "passed": passed,
        "status": "PASS" if passed else "FAIL",
        "topology_preserved": True,
        "scope": "all source faces in float64-mm, float32-mm Studio and float32-metre glTF coordinates finite/nondegenerate and positively aligned with exact transported face normals; continuous positive Jacobian bound",
        "precision_checks": precision,
        "source_face_count": len(template.faces),
        "tested_source_face_count": int(np.count_nonzero(valid)),
        "ignored_degenerate_source_faces": int(np.count_nonzero(~valid)),
        "minimum_all_precision_alignment": min(
            float(alignment.min()),
            *[float(q["minimum_transported_face_alignment"]) for q in precision.values()],
        ),
        "new_degenerate_faces": bad,
        "opposed_transported_face_normals": opposed,
        "minimum_transported_face_alignment": float(alignment.min()),
        "area_ratio_min": float(ratios.min()),
        "area_ratio_max": float(ratios.max()),
        "normal_turns_over_90_degrees": int(np.count_nonzero(dots <= 0)),
        "min_normal_dot": float(dots.min()),
        "normal_turn_interpretation": "relative rotation diagnostic, not proof of a discrete inverted element",
        "continuous_jacobian_lower_bound": lower,
        "source_topology": template.metadata.get("topology_audit", {}),
        "self_intersection": {"status": "NOT_RUN"},
        "anatomical_plausibility": {"status": "NOT_RUN"},
        "mechanical_validation": {"status": "NOT_RUN"},
        "surface_area_mm2": float(areas.sum() / 2),
    }
