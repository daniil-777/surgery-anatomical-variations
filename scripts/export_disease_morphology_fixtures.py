"""The disease-v2 morphology for the browser: per-template support sets, and fixtures recorded from the Python renderer.

    .venv/bin/python scripts/export_disease_morphology_fixtures.py

Writes apps/studio/public/models/disease-v2/index.json and <template_id>.bin for every template of
datasets/anatomy-templates/templates-v3 (the library the API's disease-v2 renderer binds): the vertices a disease may
anchor on (viscera_core.atlas_disease_v2._source_cache's `eligible` — the organ's preferred or non-attachment
components, the kidney's capsule only, facing outward by the trimesh source normals) and the recipe-independent
candidate pool drawn from them with numpy's generator seeded 20873 (8192 without replacement, plus the six axis
extremes; only the set matters, np.unique sorts it), both as bitmasks over the template's vertices, with the minimum
support radius (three times the 90th-percentile edge length over all triangle edges). The browser cannot derive the
first two: the component names are not bundled. Everything else — source normals, site placement, the displacement
map and its discrete QA — apps/studio/src/atlasDiseaseLocal.ts computes itself.

Also writes apps/studio/src/__fixtures__/disease-v2.json: for the test's cases, the Python renderer's own outputs —
the field (anchors, amplitudes, directions, the generator's draws), the discrete guard, the QA, displacement
statistics, hashes and sampled vertices — which atlasDiseaseLocal.test.ts replays without the API.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "py"), str(ROOT)]

from viscera_core import atlas_disease_v2 as d2  # noqa: E402
from viscera_core.atlas import CONTROL_NAMES  # noqa: E402
from viscera_core.atlas_disease_scene_v2 import DiseaseAtlasSpecV2, realize  # noqa: E402
from viscera_core.atlas_materials import material_catalog  # noqa: E402
from viscera_core.atlas_scene import display_normals, get_template  # noqa: E402

TEMPLATES = ROOT / "datasets/anatomy-templates/templates-v3"
OUT = ROOT / "apps/studio/public/models/disease-v2"
FIXTURES = ROOT / "apps/studio/src/__fixtures__/disease-v2.json"
FORMAT = "viscera-disease-v2-support"
POOL_SEED, POOL_SIZE = 20873, 8192

# The test grid: two liver references with four profiles between them, the kidney (capsule-only support, a profile
# with a negative amplitude ratio and one with five steps), two seeds, one severity per band. The extras exercise
# the source-capacity reduction (the gallbladder carcinoma runs at 45 %), the lung's welded normals, nonzero shape
# controls under a disease and a zero severity.
GRID: dict[str, list[str]] = {
    "hra-liver-female": ["liver-cirrhosis", "liver-hcc", "liver-metastases", "liver-steatotic-enlargement"],
    "hra-liver-male": ["liver-cirrhosis", "liver-hcc"],
    "hra-kidney-male-left": ["kidney-cancer", "kidney-cortical-scarring", "kidney-atrophy"],
}
SEEDS = (7, 1729)
SEVERITIES = (0.2, 0.55, 0.9)
ZERO = dict.fromkeys(CONTROL_NAMES, 0.0)
BENT = {**ZERO, "bend": 0.5, "taper": -0.4, "twist": 0.3}
EXTRAS: list[tuple[str, str, int, float, dict[str, float]]] = [
    *[("bp3d-gallbladder-male", "gallbladder-carcinoma", 7, s, ZERO) for s in SEVERITIES],
    ("bp3d-gallbladder-male", "gallbladder-cholecystitis", 1729, 0.55, ZERO),
    ("hra-lung-male", "lung-emphysema", 7, 0.55, ZERO),
    ("hra-liver-female", "liver-cirrhosis", 7, 0.55, BENT),
    ("hra-kidney-male-left", "kidney-cancer", 1729, 0.9, BENT),
    ("hra-liver-female", "liver-metastases", 7, 0.0, ZERO),
]


def f32_sha256(values: Any) -> str:
    return hashlib.sha256(np.asarray(values, dtype="<f4").tobytes()).hexdigest()


def bitmask(indices: Any, count: int) -> bytes:
    mask = np.zeros(count, dtype=bool)
    mask[indices] = True
    return np.packbits(mask, bitorder="little").tobytes()


def export_support() -> dict[str, Any]:
    catalog = json.loads((TEMPLATES / "catalog.json").read_text())
    index: dict[str, Any] = {
        "format": FORMAT,
        "version": d2.VERSION,
        "template_root": str(TEMPLATES.relative_to(ROOT)),
        "pool_seed": POOL_SEED,
        "pool_size": POOL_SIZE,
        "layout": "eligible bitmask, then pool bitmask; ceil(vertex_count / 8) bytes each; vertex i is bit i & 7 of byte i >> 3",
        "source_normals": "trimesh 4.12.2 angle-weighted vertex normals of the source (lung: welded at 1e-8 mm), repaired where zero",
        "templates": {},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for entry in sorted(catalog["templates"], key=lambda row: row["template_id"]):
        tid = entry["template_id"]
        template = get_template(TEMPLATES, tid)
        cache = d2._source_cache(template)
        count = len(template.vertices_mm)
        data = bitmask(cache["eligible"], count) + bitmask(cache["pool"], count)
        (OUT / f"{tid}.bin").write_bytes(data)
        index["templates"][tid] = {
            "organ": template.metadata["organ"],
            "vertex_count": count,
            "face_count": len(template.faces),
            "geometry_sha256": template.metadata["geometry_sha256"],
            "template_sha256": template.metadata["artifact_sha256"],
            "eligible_count": int(len(cache["eligible"])),
            "pool_count": int(len(cache["pool"])),
            "minimum_support_radius_mm": float(cache["minimum_support_radius_mm"]),
            "normals_policy": display_normals(template.vertices_mm, template.faces, template.metadata["organ"])[1]["policy"],
            "source_normals_sha256": f32_sha256(cache["normals"]),
            "file": f"{tid}.bin",
            "bytes": len(data),
        }
    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    total = sum(row["bytes"] for row in index["templates"].values())
    print(f"support: {len(index['templates'])} templates, {total} B of bitmasks + index.json ({(OUT / 'index.json').stat().st_size} B)")
    return index


def template_fixture(tid: str, index: dict[str, Any]) -> dict[str, Any]:
    template = get_template(TEMPLATES, tid)
    cache = d2._source_cache(template)
    v = np.asarray(template.vertices_mm)
    points = v[cache["eligible"]]
    center = (points.min(0) + points.max(0)) / 2
    extent = np.ptp(points, axis=0)
    sample = np.linspace(0, len(v) - 1, 8).astype(int).tolist()
    return {
        **index["templates"][tid],
        "normalization_mm": template.metadata["normalization_mm"],
        "control_limits": template.metadata["control_limits"],
        "eligible_center_mm": center.tolist(),
        "eligible_extent_mm": extent.tolist(),
        "pool_head": cache["pool"][:16].tolist(),
        "normals_sample_ids": sample,
        "normals_sample": cache["normals"][sample].tolist(),
    }


def case_fixture(tid: str, pid: str, seed: int, severity: float, controls: dict[str, float], materials: dict[str, Any]) -> dict[str, Any]:
    template = get_template(TEMPLATES, tid)
    organ = template.metadata["organ"]
    recipe = {"profile_id": pid, "seed": seed, "severity": severity, "size": 0.5, "spread": 0.5, "irregularity": 0.35, "contrast": 0.45, "count": 3, "location": [0.25, 0.15, 0.8]}
    spec = DiseaseAtlasSpecV2(renderer_version="disease-v2", template_id=tid, seed=42, controls=controls, appearance="tissue", material=materials[organ], disease=recipe)
    result = realize(TEMPLATES, spec)
    healthy = realize(TEMPLATES, spec.model_copy(update={"disease": None}))
    item = result["scene"]["organs"][0]
    field = item["metadata"]["disease_field"]
    positions = np.asarray(item["positions"]).reshape(-1, 3)
    normals = np.asarray(item["normals"]).reshape(-1, 3)
    colors = np.asarray(item["colors"]).reshape(-1, 3)
    base_colors = np.asarray(healthy["scene"]["organs"][0]["colors"]).reshape(-1, 3)
    baseline = np.asarray(healthy["scene"]["organs"][0]["positions"]).reshape(-1, 3)
    displacement = np.linalg.norm(positions - baseline, axis=1)
    anchors = [site["anchor_vertex_id"] for site in field["fields"]]
    sample = sorted({*np.linspace(0, len(positions) - 1, 4).astype(int).tolist(), int(displacement.argmax()), anchors[0]})
    # the generator's draws as the renderer takes them: the pool's permutation, then one double per realized anchor
    cache = d2._source_cache(template)
    rng = np.random.default_rng(seed)
    permutation = rng.permutation(cache["pool"])
    draws = [rng.random() for _ in field["fields"]]
    eligible = cache["eligible"]
    points = np.asarray(template.vertices_mm)[eligible]
    center = (points.min(0) + points.max(0)) / 2
    target = center + np.asarray(recipe["location"]) * np.ptp(points, axis=0) * 0.5
    distances = np.sort(np.linalg.norm(points - target, axis=1))
    qa = result["scene"]["metadata"]["qa"]
    disease = result["scene"]["metadata"]["disease"]
    guard = field.get("discrete_guard")
    return {
        "template_id": tid,
        "profile_id": pid,
        "recipe": recipe,
        "controls": controls,
        "applied_controls": disease["shape_control_projection"]["applied_controls"],
        "shape_fraction": disease["shape_control_projection"]["applied_fraction"],
        "rng": {"permutation_head": permutation[:8].tolist(), "draws": draws},
        "first_anchor_margin_mm": float(distances[1] - distances[0]) if len(distances) > 1 else None,
        "field": {
            "anchor_vertex_ids": anchors,
            "amplitudes_mm": [site["amplitude_mm"] for site in field["fields"]],
            "directions": [site["direction"] for site in field["fields"][:3]],
            "radius_mm": field["effective_support_radius_mm"],
            "requested_radius_mm": field["requested_support_radius_mm"],
            "requested_sites": field["requested_sites"],
            "realized_sites": field["realized_sites"],
            "global_center_mm": field["global_center_mm"],
            "global_log_scale": field["global_log_scale"],
            "global_scale": field["global_scale"],
            "color_strength": field["color_strength"],
            "gradient_bound_per_step": field["gradient_bound_per_step"],
            "continuous_jacobian_lower_bound": field["continuous_jacobian_lower_bound"],
            "effective_morphology_strength": field["effective_morphology_strength"],
            "applied_displacement_fraction": field["applied_displacement_fraction"],
            "discrete_guard": {k: guard[k] for k in ("strength_capacity", "actual_strength_backoffs", "intermediate_rejected_strengths", "source_limited", "requested_max_step_amplitude_mm", "effective_max_step_amplitude_mm", "minimum_transported_face_alignment")} if guard else None,
        },
        "qa": {
            **{k: qa[k] for k in ("passed", "minimum_all_precision_alignment", "minimum_transported_face_alignment", "opposed_transported_face_normals", "new_degenerate_faces", "area_ratio_min", "area_ratio_max", "normal_turns_over_90_degrees", "min_normal_dot", "continuous_jacobian_lower_bound", "surface_area_mm2", "tested_source_face_count")},
            "precision_checks": {name: {k: check[k] for k in ("minimum_transported_face_alignment", "maximum_vertex_roundtrip_error_mm")} for name, check in qa["precision_checks"].items()},
        },
        "disease": {k: disease[k] for k in ("max_displacement_mm", "rms_displacement_mm", "requested_sites", "realized_sites", "applied_displacement_fraction", "effective_morphology_strength", "displacement_limited_by_source_mesh", "actual_strength_backoffs")},
        "extent_mm": result["summary"]["extent_mm"],
        "normal_repair": {k: result["scene"]["metadata"]["normal_repair"][k] for k in ("repaired_vertex_count", "area_weighted_incident_count", "largest_incident_face_fallback_count")},
        "geometry_sha256": result["scene"]["metadata"]["geometry_sha256"],
        "display_normals_sha256": result["scene"]["metadata"]["display_normals"]["sha256"],
        "samples": {
            "vertex_ids": sample,
            "positions": positions[sample].tolist(),
            "normals": normals[sample].tolist(),
            "base_colors": base_colors[sample].tolist(),
            "colors": colors[sample].tolist(),
        },
    }


def export_fixtures(index: dict[str, Any]) -> None:
    materials = material_catalog()["defaults"]
    cases = [(tid, pid, seed, severity, ZERO) for tid, profiles in GRID.items() for pid in profiles for seed in SEEDS for severity in SEVERITIES] + EXTRAS
    templates = {tid: template_fixture(tid, index) for tid in sorted({tid for tid, *_ in cases})}
    rows = [case_fixture(*case, materials) for case in cases]
    profile_fields = ("id", "organ", "pattern", "mechanism", "radius_min_fraction", "radius_range_fraction", "amplitude_ratio", "steps", "count_multiplier", "maximum_sites", "global_log_scale", "target_srgb", "visibility")
    profiles = {pid: {k: d2.PROFILES[pid][k] for k in profile_fields} for pid in sorted({pid for _, pid, *_ in cases})}
    FIXTURES.parent.mkdir(parents=True, exist_ok=True)
    compact = lambda value: json.dumps(value, separators=(",", ":"), allow_nan=False)  # noqa: E731
    body = (
        '{"version":' + compact(d2.VERSION) + ',\n"kernel_gradient_max":' + compact(float(d2.KERNEL_GRADIENT_MAX))
        + ',\n"profiles":' + compact(profiles) + ',\n"templates":' + compact(templates)
        + ',\n"cases":[\n' + ",\n".join(compact(row) for row in rows) + "\n]}\n"
    )
    FIXTURES.write_text(body)
    limited = sum(row["disease"]["displacement_limited_by_source_mesh"] for row in rows)
    print(f"fixtures: {len(rows)} cases over {len(templates)} templates and {len(profiles)} profiles ({limited} source-limited) → {FIXTURES.relative_to(ROOT)} ({FIXTURES.stat().st_size} B)")


if __name__ == "__main__":
    export_fixtures(export_support())
