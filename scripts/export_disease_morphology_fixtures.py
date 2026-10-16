"""The disease-v2 morphology for the browser: per-template support sets, and fixtures recorded from the Python renderer.

    .venv/bin/python scripts/export_disease_morphology_fixtures.py

Writes apps/studio/public/models/disease-v2/index.json and <template_id>.bin for every template of
datasets/anatomy-templates/templates-v3 (the library the API's disease-v2 renderer binds): the vertices a disease may
anchor on (viscera_core.atlas_disease_v2._source_cache's `eligible` — the organ's preferred or non-attachment
components, the kidney's capsule only, facing outward by the trimesh source normals) and the recipe-independent
candidate pool drawn from them with numpy's generator seeded 20873 (8192 without replacement, plus the six axis
extremes; only the set matters, np.unique sorts it), both as bitmasks over the template's vertices, with the minimum
support radius (three times the 90th-percentile edge length over all triangle edges). The browser cannot derive the
first two: the component names are not bundled. A third bitmask settles the one thing the browser cannot know from
the geometry: the first anchor is cKDTree(v[eligible]).query(target)'s index, and where several eligible vertices
share exact coordinates (every pancreas vertex has a twin; the lungs, spleens, bladders, the stomach and the female
small intestine have some) they tie exactly, and scipy answers the twin its tree traversal meets first — the leaf
order its build left in `tree.indices`, strict `<` on equal distances — where a scan by vertex id answers the lowest
id, moving the realized site by millimetres. For every group of coincident eligible vertices this exporter queries
the tree at the shared position and at 130 perturbed targets around it (26 directions × a micron to 5 mm); when every
query that answers a member answers the same one, that member is the group's winner and its bit is set. A group whose
winner varied with the target would be reported as query-dependent and left unset (the browser then falls back to the
lowest id); none exists in templates-v3. Everything else — source normals, site placement, the displacement map and
its discrete QA — apps/studio/src/atlasDiseaseLocal.ts computes itself.

Also writes apps/studio/src/__fixtures__/disease-v2.json: for the test's cases, the Python renderer's own outputs —
the field (anchors, amplitudes, directions, the generator's draws), the discrete guard, the QA, displacement
statistics, hashes and sampled vertices — which atlasDiseaseLocal.test.ts replays without the API. Four cases place
the first anchor on a tie (the ones the browser-port sweep found), one of them the API's learned recipe proposal for
pancreatitis at request seed 0 (services.api.atlas_disease_model, which needs the paired disease model and release).
"""
from __future__ import annotations

import hashlib
import itertools
import json
import os
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
FORMAT_VERSION = 2  # 2: the tie-winner bitmask after the eligible and pool bitmasks
POOL_SEED, POOL_SIZE = 20873, 8192
# Probes around a shared position, the kind of target the renderer produces (a point of the eligible box, never a
# vertex itself): every direction of the ±1/0 cube at five radii from a micron to five millimetres.
TIE_PROBE_DIRECTIONS = np.array([d for d in itertools.product((-1.0, 0.0, 1.0), repeat=3) if any(d)])
TIE_PROBE_DIRECTIONS /= np.linalg.norm(TIE_PROBE_DIRECTIONS, axis=1)[:, None]
TIE_PROBE_RADII_MM = (1e-3, 1e-2, 0.1, 1.0, 5.0)

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


def coincident_groups(points: Any) -> list[np.ndarray]:
    """The index sets of rows that share exact coordinates (two or more), in ascending order of their first row."""
    _, inverse, counts = np.unique(points, axis=0, return_inverse=True, return_counts=True)
    inverse = inverse.reshape(-1)
    order = np.argsort(inverse, kind="stable")
    tied = np.flatnonzero(counts > 1)
    starts = np.searchsorted(inverse[order], tied)
    groups = [order[s : s + counts[g]] for s, g in zip(starts, tied, strict=True)]
    return sorted(groups, key=lambda g: int(g.min()))


def tie_winners(points: Any, tree: Any) -> tuple[list[int], list[np.ndarray], list[np.ndarray], int]:
    """For every group of coincident rows, the row cKDTree(points).query answers for its position: queried at the
    position itself and at the probes around it; a group is a winner's when every probe that answers a member answers
    the same one. Returns the winners (row indices), the groups, the query-dependent groups and how many winners are
    the member met first in the tree's leaf order (the structural explanation, which the probes confirm)."""
    groups = coincident_groups(points)
    if not groups:
        return [], [], [], 0
    offsets = (np.asarray(TIE_PROBE_RADII_MM)[:, None, None] * TIE_PROBE_DIRECTIONS[None]).reshape(-1, 3)
    offsets = np.vstack([np.zeros((1, 3)), offsets])
    targets = points[[int(g[0]) for g in groups]][:, None, :] + offsets[None]
    answers = tree.query(targets.reshape(-1, 3))[1].reshape(len(groups), len(offsets))
    leaf_position = np.empty(len(points), dtype=np.int64)
    leaf_position[tree.indices] = np.arange(len(points))
    winners: list[int] = []
    dependent: list[np.ndarray] = []
    leaf_first = 0
    for group, row in zip(groups, answers, strict=True):
        members = set(group.tolist())
        hits = {int(i) for i in row if int(i) in members}
        if len(hits) != 1:
            dependent.append(group)
            continue
        winner = hits.pop()
        winners.append(winner)
        leaf_first += winner == int(group[np.argmin(leaf_position[group])])
    return winners, groups, dependent, leaf_first


def export_support() -> dict[str, Any]:
    catalog = json.loads((TEMPLATES / "catalog.json").read_text())
    index: dict[str, Any] = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "version": d2.VERSION,
        "template_root": str(TEMPLATES.relative_to(ROOT)),
        "pool_seed": POOL_SEED,
        "pool_size": POOL_SIZE,
        "layout": "eligible bitmask, then pool bitmask, then tie-winner bitmask; ceil(vertex_count / 8) bytes each; vertex i is bit i & 7 of byte i >> 3",
        "source_normals": "trimesh 4.12.2 angle-weighted vertex normals of the source (lung: welded at 1e-8 mm), repaired where zero",
        "ties": f"a tie winner is the eligible vertex scipy's cKDTree(v[eligible]).query answers for a position several eligible vertices share exactly (the member met first in its leaf, strict < on equal distances), confirmed at the position and {len(TIE_PROBE_DIRECTIONS) * len(TIE_PROBE_RADII_MM)} probes around it; a group whose answer varied is query-dependent and has no winner (the browser falls back to the lowest id)",
        "templates": {},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    tie_report: list[str] = []
    for entry in sorted(catalog["templates"], key=lambda row: row["template_id"]):
        tid = entry["template_id"]
        template = get_template(TEMPLATES, tid)
        cache = d2._source_cache(template)
        count = len(template.vertices_mm)
        eligible = cache["eligible"]
        winners, groups, dependent, leaf_first = tie_winners(np.asarray(template.vertices_mm, dtype=np.float64)[eligible], cache["eligible_tree"])
        data = bitmask(eligible, count) + bitmask(cache["pool"], count) + bitmask(eligible[winners], count)
        (OUT / f"{tid}.bin").write_bytes(data)
        index["templates"][tid] = {
            "organ": template.metadata["organ"],
            "vertex_count": count,
            "face_count": len(template.faces),
            "geometry_sha256": template.metadata["geometry_sha256"],
            "template_sha256": template.metadata["artifact_sha256"],
            "eligible_count": int(len(eligible)),
            "pool_count": int(len(cache["pool"])),
            "minimum_support_radius_mm": float(cache["minimum_support_radius_mm"]),
            "normals_policy": display_normals(template.vertices_mm, template.faces, template.metadata["organ"])[1]["policy"],
            "source_normals_sha256": f32_sha256(cache["normals"]),
            "tie_groups": len(groups),
            "tied_vertices": int(sum(len(g) for g in groups)),
            "query_dependent_tie_groups": len(dependent),
            "file": f"{tid}.bin",
            "bytes": len(data),
        }
        if groups:
            sizes = sorted({len(g) for g in groups})
            tie_report.append(f"  {tid}: {len(groups)} coincident groups over {sum(len(g) for g in groups)} of {len(eligible)} eligible vertices (sizes {sizes}), {len(dependent)} query-dependent, {leaf_first}/{len(winners)} winners first in the tree's leaf order")
    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    total = sum(row["bytes"] for row in index["templates"].values())
    print(f"support: {len(index['templates'])} templates, {total} B of bitmasks + index.json ({(OUT / 'index.json').stat().st_size} B)")
    dependent_total = sum(row["query_dependent_tie_groups"] for row in index["templates"].values())
    print(f"ties: {sum(row['tie_groups'] for row in index['templates'].values())} coincident groups in {len(tie_report)} templates, {dependent_total} query-dependent" + (" — port the tree traversal for these:" if dependent_total else ""))
    print("\n".join(tie_report))
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


def default_recipe(pid: str, seed: int, severity: float, **overrides: Any) -> dict[str, Any]:
    """The studio's default recipe for a profile at a seed and strength, with any slider overridden."""
    return {"profile_id": pid, "seed": seed, "severity": severity, "size": 0.5, "spread": 0.5, "irregularity": 0.35, "contrast": 0.45, "count": 3, "location": [0.25, 0.15, 0.8], **overrides}


def learned_recipe(pid: str, seed: int) -> dict[str, Any]:
    """The recipe POST /api/atlas/sample-disease proposes for a profile at a request seed, as the API's route draws it
    (the paired disease model and recipe release resolved the way services.api does)."""
    from services.api.atlas_disease_model import sample_recipe_model
    from services.api.atlas_model_registry import resolve_model

    data = Path(os.environ.get("VISCERA_DISEASE_DATASET", ROOT / "disease-releases/recipes-v2"))
    return dict(sample_recipe_model(resolve_model(ROOT, "disease"), data, pid, seed)["disease"])


# The first anchor on an exact tie, as the browser-port sweep placed it: the sites at the lower corner of the eligible
# box with the organ bent and twisted, at the upper corner with the controls at their limits, and the learned proposal.
LOW_CORNER = {"size": 0.0, "spread": 0.0, "irregularity": 0.0, "contrast": 0.0, "location": [-1.0, -1.0, -1.0]}
HIGH_CORNER = {"size": 1.0, "spread": 1.0, "irregularity": 1.0, "contrast": 1.0, "location": [1.0, 1.0, 1.0]}
TIES: list[tuple[str, dict[str, Any], dict[str, float]]] = [
    ("hra-pancreas-female", default_recipe("pancreas-cancer", 0, 0.7, **LOW_CORNER), {**ZERO, "bend": 0.5, "twist": -0.5}),
    ("hra-pancreas-female", default_recipe("pancreas-pseudocyst", 2**32 - 1, 1.0, count=8, **HIGH_CORNER), {**ZERO, "scale_x": 1.0, "taper": 1.0, "asymmetry": -1.0}),
    ("hra-spleen-female", default_recipe("spleen-infarct", 2**32 - 1, 0.35, **HIGH_CORNER), ZERO),
]
LEARNED_TIES: list[tuple[str, str, int, dict[str, float]]] = [("hra-pancreas-female", "pancreas-pancreatitis", 0, ZERO)]


def case_fixture(tid: str, recipe: dict[str, Any], controls: dict[str, float], materials: dict[str, Any]) -> dict[str, Any]:
    template = get_template(TEMPLATES, tid)
    organ = template.metadata["organ"]
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
    rng = np.random.default_rng(recipe["seed"])
    permutation = rng.permutation(cache["pool"])
    draws = [rng.random() for _ in field["fields"]]
    eligible = cache["eligible"]
    points = np.asarray(template.vertices_mm)[eligible]
    center = (points.min(0) + points.max(0)) / 2
    target = center + np.asarray(recipe["location"]) * np.ptp(points, axis=0) * 0.5
    # the eligible vertices at the first anchor's exact position (an exact tie when more than one), and the margin of
    # that position over the next nearest one
    coincident = np.all(points == points[eligible == anchors[0]][0], axis=1)
    distances = np.linalg.norm(points - target, axis=1)
    qa = result["scene"]["metadata"]["qa"]
    disease = result["scene"]["metadata"]["disease"]
    guard = field.get("discrete_guard")
    return {
        "template_id": tid,
        "profile_id": recipe["profile_id"],
        "recipe": recipe,
        "controls": controls,
        "applied_controls": disease["shape_control_projection"]["applied_controls"],
        "shape_fraction": disease["shape_control_projection"]["applied_fraction"],
        "rng": {"permutation_head": permutation[:8].tolist(), "draws": draws},
        "first_anchor_ties": sorted(eligible[coincident].tolist()),
        "first_anchor_margin_mm": float(distances[~coincident].min() - distances[coincident].min()) if not coincident.all() else None,
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
    cases: list[tuple[str, dict[str, Any], dict[str, float]]] = [
        *[(tid, default_recipe(pid, seed, severity), ZERO) for tid, profiles in GRID.items() for pid in profiles for seed in SEEDS for severity in SEVERITIES],
        *[(tid, default_recipe(pid, seed, severity), controls) for tid, pid, seed, severity, controls in EXTRAS],
        *TIES,
        *[(tid, learned_recipe(pid, seed), controls) for tid, pid, seed, controls in LEARNED_TIES],
    ]
    templates = {tid: template_fixture(tid, index) for tid in sorted({tid for tid, *_ in cases})}
    rows = [case_fixture(*case, materials) for case in cases]
    ties = [row for row in rows if len(row["first_anchor_ties"]) > 1]
    if len(ties) < len(TIES) + len(LEARNED_TIES):
        raise SystemExit(f"only {len(ties)} cases place the first anchor on a tie; the tie cases no longer tie")
    profile_fields = ("id", "organ", "pattern", "mechanism", "radius_min_fraction", "radius_range_fraction", "amplitude_ratio", "steps", "count_multiplier", "maximum_sites", "global_log_scale", "target_srgb", "visibility")
    profiles = {pid: {k: d2.PROFILES[pid][k] for k in profile_fields} for pid in sorted({r["profile_id"] for _, r, _ in cases})}
    FIXTURES.parent.mkdir(parents=True, exist_ok=True)
    compact = lambda value: json.dumps(value, separators=(",", ":"), allow_nan=False)  # noqa: E731
    body = (
        '{"version":' + compact(d2.VERSION) + ',\n"kernel_gradient_max":' + compact(float(d2.KERNEL_GRADIENT_MAX))
        + ',\n"profiles":' + compact(profiles) + ',\n"templates":' + compact(templates)
        + ',\n"cases":[\n' + ",\n".join(compact(row) for row in rows) + "\n]}\n"
    )
    FIXTURES.write_text(body)
    limited = sum(row["disease"]["displacement_limited_by_source_mesh"] for row in rows)
    lowest = sum(row["field"]["anchor_vertex_ids"][0] != min(row["first_anchor_ties"]) for row in ties)
    print(f"fixtures: {len(rows)} cases over {len(templates)} templates and {len(profiles)} profiles ({limited} source-limited) → {FIXTURES.relative_to(ROOT)} ({FIXTURES.stat().st_size} B)")
    print(f"ties: {len(ties)} cases place the first anchor on an exact tie; the lowest id would be wrong in {lowest} of them")


if __name__ == "__main__":
    export_fixtures(export_support())
