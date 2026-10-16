"""Paired rendered geometry/colour cohorts for the bounded joint CVAE.

Every row has corresponding surface observations from the actual Studio decoder.
The baseline and disease archives are separate; shared synthetic parent families
have the same split in both. These are authored examples, not patient samples.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import time
from pathlib import Path
from typing import Any

import numpy as np
from scipy.stats import qmc

from .atlas import list_templates
from .atlas_dataset import content_hash, split_assignments, sub_seed
from .atlas_disease import disease_catalog
from .atlas_disease_scene import DiseaseAtlasSpec, realize
from .atlas_joint import (
    CONTROL_NAMES, DATASET_FORMAT, OBSERVATION_NAMES, RENDERER_PATHS,
    decode_controls, digest, encode_controls, validate_split, verify_release,
)
from .atlas_materials import MaterialRecipe, sample_material
from .atlas_scene import get_template
from .atlas_surface_scene import material_regions
from .dataset import _deterministic_npz, _json_write

SPLITS = ("train", "val", "audit")


def anchors(template: Any, count: int, seed: int) -> np.ndarray:
    """Coverage-aware fixed vertex anchors, including every anatomical component."""
    v = template.vertices_mm
    rng = np.random.default_rng(seed)
    candidates = np.unique(np.r_[rng.choice(len(v), min(8192, len(v)), replace=False),
                                  np.argmin(v, axis=0), np.argmax(v, axis=0)])
    selected = [int(candidates[0])]
    # Keep small components from disappearing behind the largest organ surface.
    for component in np.unique(template.component_ids):
        ids = np.flatnonzero(template.component_ids == component)
        if len(selected) < count:
            selected.append(int(ids[len(ids) // 2]))
    selected = list(dict.fromkeys(selected))
    distance = np.full(len(candidates), np.inf)
    for index in selected:
        distance = np.minimum(distance, ((v[candidates] - v[index]) ** 2).sum(1))
    while len(selected) < min(count, len(v)):
        index = int(candidates[np.argmax(distance)])
        if index in selected:
            break
        selected.append(index)
        distance = np.minimum(distance, ((v[candidates] - v[index]) ** 2).sum(1))
    if len(selected) != count:
        raise ValueError("Template has insufficient distinct surface anchors")
    return np.asarray(selected, dtype=np.int32)


def sample_controls(condition: dict[str, Any], count: int, seed: int) -> np.ndarray:
    """Space-filling authored controls with explicit, modest cross-modal coupling.

    Coupling coefficients are design heuristics, never disease-population labels.
    The baseline and disease geometry/material controls share a parent draw.
    """
    x = qmc.LatinHypercube(22, seed=seed).random(count) * 2 - 1
    # Conservative mass/appearance variation with independent residuals retained.
    x[:, :7] *= 0.85
    shared = x[:, 0].copy()
    x[:, 7] = np.clip(0.82 * x[:, 7] + 0.18 * shared, -1, 1)
    x[:, 8] = np.clip(0.80 * x[:, 8] + 0.20 * x[:, 6], -1, 1)
    if condition["profile_id"] == "baseline":
        x[:, 13:] = 0
    else:
        # Localized and diffuse patterns keep profile identity as an input label.
        intensity = x[:, 13].copy()
        x[:, 14] = 0.75 * x[:, 14] + 0.25 * intensity
        x[:, 17] = 0.65 * x[:, 17] + 0.35 * intensity
        x[:, 8] = np.clip(0.75 * x[:, 8] + 0.25 * intensity, -1, 1)
        x[:, 12] = np.clip(0.8 * x[:, 12] + 0.2 * x[:, 16], -1, 1)
        x[:, 18] = np.rint((x[:, 18] + 1) * 3.5) / 3.5 - 1
        # Avoid requesting essentially absent lesions in disease-labelled examples.
        x[:, 13] = -0.7 + (x[:, 13] + 1) * 0.85
    return x.astype(np.float32)


def _render(task: tuple[Any, ...]) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    template_root, condition, controls, seed, anchor_ids, sample_id, group_id, split = task
    decoded = decode_controls(condition, controls, seed)
    spec = DiseaseAtlasSpec.model_validate({"template_id": condition["template_id"],
        "seed": seed, "appearance": "tissue", **decoded})
    result = realize(template_root, spec)
    template = get_template(template_root, condition["template_id"])
    organ = result["scene"]["organs"][0]
    positions = np.asarray(organ["positions"]).reshape(-1, 3)[anchor_ids]
    srgb = np.asarray(organ["colors"]).reshape(-1, 3)[anchor_ids]
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    fields = sample_material(MaterialRecipe.model_validate(decoded["material"]),
                             template.vertices_mm[anchor_ids],
                             region_ids=material_regions(template)[anchor_ids])
    norm = float(template.metadata["normalization_mm"])
    observation = np.column_stack((positions / norm, linear, fields.roughness)).astype(np.float32)
    controls = encode_controls(decoded["controls"], decoded["material"], decoded["disease"])
    metadata = {"sample_id": sample_id, "group_id": group_id, "split": split,
        "template_id": condition["template_id"], "profile_id": condition["profile_id"],
        "seed": seed, "spec": result["spec"], "extent_mm": result["summary"]["extent_mm"],
        "geometry_sha256": result["scene"]["metadata"]["geometry_sha256"],
        "normalization_mm": norm,
        "displacement_fraction": result["summary"].get("disease", {}).get("applied_displacement_fraction", 1),
        "evidence": "authored_paired_renderer_observations_not_patient_ground_truth"}
    return metadata, controls, observation


def build_release(template_root: Path, output: Path, *, lane: str, count: int = 96,
                  point_count: int = 128, seed: int = 20261007, workers: int = 3,
                  template_ids: list[str] | None = None) -> dict[str, Any]:
    if lane not in ("baseline", "disease") or type(count) is not int or not 8 <= count <= 4096:
        raise ValueError("Expected baseline/disease lane and count in [8,4096]")
    if type(point_count) is not int or not 8 <= point_count <= 1024:
        raise ValueError("Expected point count in [8,1024]")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Seed must be uint32")
    if type(workers) is not int or not 1 <= workers <= 8:
        raise ValueError("Workers must be in [1,8]")
    template_root, output = Path(template_root).resolve(), Path(output)
    if (output / "release.json").exists():
        existing = verify_release(output)
        if existing["recipe"] != {"lane": lane, "count_per_condition": count,
             "point_count": point_count, "seed": seed, "template_ids": template_ids}:
            raise ValueError("Existing joint release uses a different recipe")
        return existing
    if output.exists() and any(output.iterdir()):
        raise ValueError("Choose an empty joint release output")
    output.mkdir(parents=True)
    templates = sorted(list_templates(template_root), key=lambda row: row["template_id"])
    if template_ids:
        templates = [row for row in templates if row["template_id"] in template_ids]
        if len(templates) != len(set(template_ids)):
            raise ValueError("Unknown template selection")
    if not templates or any(not row.get("cohort_eligible") for row in templates):
        raise ValueError("Only eligible, attributed reference templates are supported")
    profiles = [p for p in disease_catalog()["profiles"] if p.get("supported")]
    conditions, anchor_map = [], {}
    for template in templates:
        tid = template["template_id"]
        t = get_template(template_root, tid)
        anchor_map[tid] = anchors(t, point_count, sub_seed(seed, tid, "anchors")).tolist()
        ids = ["baseline"] if lane == "baseline" else [p["id"] for p in profiles if p["organ"] == template["organ"]]
        for profile_id in ids:
            conditions.append({"template_id": tid, "organ": template["organ"],
                "profile_id": profile_id, "material_preset": "balanced",
                "renderer_seed": sub_seed(seed, tid, profile_id, "renderer")})
    project = Path(__file__).resolve().parents[2]
    renderer_hashes = {name: digest(project / name) for name in RENDERER_PATHS}
    template_hashes = {row["template_id"]: digest(template_root / (row["template_id"] + ".npz")) for row in templates}
    metadata_hashes = {row["template_id"]: digest(template_root / (row["template_id"] + ".json")) for row in templates}
    catalog = {"conditions": conditions, "control_names": list(CONTROL_NAMES),
        "observation_names": list(OBSERVATION_NAMES), "anchor_vertex_ids": anchor_map,
        "template_hashes": template_hashes, "template_metadata_hashes": metadata_hashes,
        "normalization": "positions_mm / template.normalization_mm; linear RGB; unit roughness",
        "renderer_phase_policy": "fixed material/disease phase per condition; latent varies morphology and material controls"}
    _json_write(output / "catalog.json", catalog)
    _json_write(output / "reference_catalog.json", {"templates": templates})
    groups: dict[str, list[Any]] = {key: [] for key in SPLITS}
    tasks = []
    for condition_id, condition in enumerate(conditions):
        tid = condition["template_id"]
        roles = split_assignments(count, sub_seed(seed, tid, "joint-family-splits"))
        controls = sample_controls(condition, count, sub_seed(seed, tid, "joint-family-controls"))
        for i, (values, split) in enumerate(zip(controls, roles, strict=True)):
            group = content_hash([seed, tid, "joint-parent", i])[:24]
            sample_id = content_hash([group, condition["profile_id"]])[:24]
            row_seed = sub_seed(seed, tid, condition["profile_id"], str(i))
            task = (str(template_root), condition, values, row_seed,
                    np.asarray(anchor_map[tid]), sample_id, group, split)
            tasks.append((condition_id, task))
    started = time.monotonic()
    records = []
    executor = concurrent.futures.ProcessPoolExecutor(max_workers=workers) if workers > 1 else None
    try:
        iterator = executor.map(_render, (t for _, t in tasks), chunksize=1) if executor else map(_render, (t for _, t in tasks))
        with (output / "manifest.jsonl").open("w") as manifest:
            for i, (metadata, controls, obs) in enumerate(iterator):
                condition_id = tasks[i][0]
                groups[metadata["split"]].append((metadata, controls, obs, condition_id))
                manifest.write(json.dumps(metadata, sort_keys=True, allow_nan=False) + "\n")
                records.append(metadata)
                if i % 24 == 0 or i + 1 == len(tasks):
                    manifest.flush()
                    print(f"{lane}: {i+1}/{len(tasks)} paired surfaces, {time.monotonic()-started:.1f}s", flush=True)
    finally:
        if executor:
            executor.shutdown(cancel_futures=True)
    for split, rows in groups.items():
        arrays = {"controls": np.stack([r[1] for r in rows]),
            "observations": np.stack([r[2] for r in rows]),
            "condition_ids": np.asarray([r[3] for r in rows], dtype=np.int32),
            "sample_ids": np.asarray([r[0]["sample_id"] for r in rows]),
            "group_ids": np.asarray([r[0]["group_id"] for r in rows]),
            "seeds": np.asarray([r[0]["seed"] for r in rows], dtype=np.uint32)}
        validate_split(arrays, conditions)
        _deterministic_npz(output / (split + ".npz"), **arrays)
    split_groups = {k: sorted({r[0]["group_id"] for r in v}) for k, v in groups.items()}
    for a, b in (("train", "val"), ("train", "audit"), ("val", "audit")):
        if set(split_groups[a]) & set(split_groups[b]):
            raise ValueError("Synthetic parent family leakage")
    _json_write(output / "split_manifest.json", split_groups)
    _json_write(output / "dataset_card.json", {"lane": lane, "sample_count": len(records),
        "conditions": len(conditions), "templates": len(templates), "points_per_surface": point_count,
        "splits": {k: len(v) for k, v in groups.items()}, "independent_patient_count": 0,
        "scope": "paired authored geometry and colour samples from the frozen Studio renderer",
        "coupling": "documented heuristic design correlation; not measured disease physiology",
        "split_track": "within-generator grouped synthetic parents; shared atlases across splits",
        "limitations": ["not donor-held-out clinical validation", "not measured tissue albedo or physics",
            "same-topology outer-surface deformations only", "source mesh limitations retained",
            "fixed spatial field phase within each condition", "baseline does not certify healthy anatomy"],
        "displacement_limited_count": sum(r["displacement_fraction"] < 1 for r in records),
        "attribution": "See reference_catalog.json for per-template CC BY attribution"})
    recipe = {"lane": lane, "count_per_condition": count, "point_count": point_count,
              "seed": seed, "template_ids": template_ids}
    release = {"format": DATASET_FORMAT, "recipe": recipe,
        "release_id": content_hash([recipe, renderer_hashes, template_hashes])[:20],
        "renderer_hashes": renderer_hashes, "template_hashes": template_hashes,
        "template_metadata_hashes": metadata_hashes,
        "builder_sha256": digest(Path(__file__)),
        "artifact_hashes": {p.name: digest(p) for p in sorted(output.iterdir()) if p.is_file()},
        "scope": "synthetic paired renderer observations, no independent patients"}
    _json_write(output / "release.json", release)
    return verify_release(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--templates", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--lane", choices=("baseline", "disease"), required=True)
    parser.add_argument("--count", type=int, default=96)
    parser.add_argument("--points", type=int, default=128)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--seed", type=int, default=20261007)
    parser.add_argument("--template", action="append")
    args = parser.parse_args()
    build_release(args.templates, args.out, lane=args.lane, count=args.count,
                  point_count=args.points, seed=args.seed, workers=args.workers,
                  template_ids=args.template)


if __name__ == "__main__":
    main()
