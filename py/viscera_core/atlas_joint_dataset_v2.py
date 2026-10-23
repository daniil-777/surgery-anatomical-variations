"""Paired v2 anchor observations with variable spatial phase and family isolation.

Builds disk-backed arrays, then streams standard NPZ archives. These are source
surface queries from a synthetic renderer, not scans or independently measured
patient meshes. Every accepted recipe passes all-source-triangle orientation QA.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any, cast

import numpy as np
from scipy.stats import qmc

from .atlas import list_templates
from .atlas_dataset import content_hash, split_assignments, sub_seed
from .atlas_disease_v2 import (
    PROFILES,
    DiseaseSpecV2,
    _source_cache,
    apply_disease_color,
    disease_field,
    evaluate_mask,
    mesh_qa,
    source_safe_shape_controls,
    transform_points,
)
from .atlas_joint import CONTROL_NAMES, OBSERVATION_NAMES, digest
from .atlas_joint_v2 import (
    DATASET_FORMAT,
    RENDERER_PATHS,
    SEVERITY_BANDS,
    SEVERITY_NAMES,
    decode_controls,
    encode_controls,
    spatial_features,
    validate_split,
    verify_release,
)
from .atlas_materials import MaterialRecipe, sample_material
from .atlas_scene import get_template
from .atlas_surface_scene import material_regions
from .dataset import _json_write

SPLITS = ("train", "val", "audit")


def family_splits(count: int, seed: int) -> list[str]:
    """All three design-strength bands have identical split proportions."""
    if count % 3 or count < 24:
        raise ValueError("V2 count must be divisible by three and at least24")
    roles = [""] * count
    for band in range(3):
        part = split_assignments(count // 3, sub_seed(seed, "band", str(band)))
        for i, value in enumerate(part):
            roles[3 * i + band] = value
    return roles


def sample_controls(condition: dict[str, Any], count: int, seed: int) -> np.ndarray:
    x = (qmc.LatinHypercube(22, seed=seed).random(count) * 2 - 1).astype(np.float32)
    x[:, :7] *= 0.95
    x[:, 7] = 0.85 * x[:, 7] + 0.15 * x[:, 0]
    x[:, 8] = 0.85 * x[:, 8] + 0.15 * x[:, 6]
    if condition["profile_id"] == "baseline":
        x[:, 13:] = 0
    else:
        for i in range(count):
            lo, hi = SEVERITY_BANDS[i % 3 + 1]
            # Open intervals avoid ambiguous floating-point band boundaries.
            severity = lo + 1e-5 + (hi - lo - 2e-5) * (float(x[i, 13]) + 1) / 2
            x[i, 13] = 2 * severity - 1
        x[:, 18] = np.rint((x[:, 18] + 1) * 3.5) / 3.5 - 1
    return cast(np.ndarray, x)


def anchors(template: Any, field: dict[str, Any] | None, count: int, seed: int) -> np.ndarray:
    """Unique source vertex queries; region/extent coverage plus lesion anchors."""
    v = template.vertices_mm
    if len(v) < count:
        raise ValueError("Too few source vertices for requested distinct queries")
    cache = _source_cache(template)
    rng = np.random.default_rng(seed)
    selected = list(map(int, np.r_[np.argmin(v, axis=0), np.argmax(v, axis=0)]))
    for component in np.unique(template.component_ids):
        ids = np.flatnonzero(template.component_ids == component)
        selected.append(int(ids[rng.integers(len(ids))]))
    if field:
        sites = field["fields"]
        selected.extend(s["anchor_vertex_id"] for s in sites)
        neighbors: list[int] = []
        for site in sites:
            near = cache["tree"].query_ball_point(site["center_mm"], site["radius_mm"] * 0.8)
            if near:
                take = min(len(near), max(2, count // (max(len(sites), 1) * 3)))
                neighbors.extend(map(int, rng.choice(near, take, replace=False)))
        selected.extend(neighbors)
    selected = list(dict.fromkeys(selected))[: count // 2]
    # Vertex-area sampling prevents dense source patches dominating the surface.
    if "vertex_area" not in cache:
        from .atlas import _prepare_cache

        areas = _prepare_cache(template)["area2"] / 6
        weights = np.bincount(
            template.faces.reshape(-1), weights=np.repeat(areas, 3), minlength=len(v)
        )
        cache["vertex_area"] = weights / weights.sum()
    candidates = rng.choice(len(v), min(count * 2, len(v)), replace=False, p=cache["vertex_area"])
    selected = list(dict.fromkeys([*selected, *map(int, candidates)]))[:count]
    if len(selected) < count:
        selected = list(dict.fromkeys([*selected, *map(int, rng.permutation(len(v)))]))[:count]
    return np.asarray(selected, dtype=np.int32)


def safe_shape_controls(
    template: Any, controls: dict[str, float]
) -> tuple[dict[str, float], float]:
    return source_safe_shape_controls(template, controls)


def _render(task: tuple[Any, ...]) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    (
        root,
        condition,
        values,
        row_seed,
        render_seeds,
        point_count,
        sample_id,
        group,
        split,
        band,
        _full_qa,
    ) = task
    template = get_template(root, condition["template_id"])
    decoded = decode_controls(
        condition, values, row_seed, np.asarray(render_seeds, dtype=np.uint32)
    )
    # Store and render the same float32 control roundtrip, including log material controls.
    canonical = encode_controls(decoded["controls"], decoded["material"], decoded["disease"])
    decoded = decode_controls(
        condition, canonical, row_seed, np.asarray(render_seeds, dtype=np.uint32)
    )
    decoded["controls"], shape_fraction = safe_shape_controls(template, decoded["controls"])
    disease = DiseaseSpecV2.model_validate(decoded["disease"]) if decoded["disease"] else None
    render_seeds = list(map(int, render_seeds))
    field = None
    layout_attempt = 0
    if disease is not None:
        for layout_attempt in range(16):
            try:
                field = disease_field(template, disease, decoded["controls"])
                break
            except ValueError as exc:
                if "discrete" not in str(exc) and "full-source" not in str(exc):
                    raise
                if layout_attempt == 15:
                    return {
                        "status": "rejected_source_triangle_or_precision_qa",
                        "sample_id": sample_id,
                        "group_id": group,
                        "split": split,
                        "seed": row_seed,
                        "template_id": condition["template_id"],
                        "profile_id": condition["profile_id"],
                        "severity_id": band,
                        "renderer_seeds": render_seeds,
                        "layout_attempts": 16,
                        "reason": str(exc),
                        "source_safe_shape_fraction": shape_fraction,
                        "controls": decoded["controls"],
                        "material": decoded["material"],
                        "disease": disease.model_dump(mode="json"),
                    }, {}
                render_seeds[1] = sub_seed(
                    int(task[4][1]), "source-safe-layout", str(layout_attempt + 1)
                )
                disease = disease.model_copy(update={"seed": render_seeds[1]})
        decoded["disease"] = disease.model_dump(mode="json")
    ids = anchors(template, field, point_count, sub_seed(row_seed, "anchor-queries"))
    cache = _source_cache(template)
    rest = template.vertices_mm[ids]
    regions = material_regions(template)[ids].astype(np.uint8)
    coords, normals = transform_points(
        template, decoded["controls"], rest, field, normals=cache["normals"][ids]
    )
    baseline_coords = transform_points(template, decoded["controls"], rest, None)
    material = MaterialRecipe.model_validate(decoded["material"])
    surface = sample_material(material, rest, region_ids=regions)
    rgb = apply_disease_color(surface["rgb_srgb"], rest, field) if field else surface["rgb_srgb"]
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    norm = template.metadata["normalization_mm"]
    observed = np.column_stack((coords / norm, linear, surface["roughness"]))
    base = np.column_stack((baseline_coords / norm, surface["rgb_linear"], surface["roughness"]))
    if not np.isfinite(observed).all() or not np.isfinite(normals).all():
        raise ValueError("Nonfinite anchor observation")
    full_vertices = transform_points(
        template, decoded["controls"], template.vertices_mm, field, tree=cache["tree"]
    )
    qa = (
        field["full_mesh_qa"]
        if field
        else mesh_qa(template, full_vertices, None, decoded["controls"])
    )
    if not qa["passed"]:
        raise ValueError(f"Full-source transported face QA failed {sample_id}: {qa}")
    if not np.allclose(coords, full_vertices[ids], atol=1e-11, rtol=0):
        raise ValueError("Anchor coordinates differ from the full source mesh")
    record = {
        "sample_id": sample_id,
        "group_id": group,
        "split": split,
        "seed": row_seed,
        "template_id": condition["template_id"],
        "profile_id": condition["profile_id"],
        "severity_id": band,
        "renderer_seeds": list(map(int, render_seeds)),
        "full_mesh_qa": qa,
        "source_safe_shape_fraction": shape_fraction,
        "layout_resampling_attempts": layout_attempt,
        "effective_morphology_strength": field["effective_morphology_strength"] if field else 0.0,
        "anchor_count": point_count,
        "max_anchor_displacement_mm": float(np.linalg.norm(coords - baseline_coords, axis=1).max()),
        "lesion_visible_anchor_count": int(np.count_nonzero(evaluate_mask(rest, field) > 0.01))
        if field
        else 0,
        "realized_sites": field["realized_sites"] if field else 0,
        "displacement_fraction": field["applied_displacement_fraction"] if field else 1.0,
        "status": "accepted_synthetic_anchor_observations",
    }
    arrays = {
        "controls": encode_controls(decoded["controls"], decoded["material"], decoded["disease"]),
        "observations": observed.astype(np.float32),
        "baseline_observations": base.astype(np.float32),
        "rest_points": (rest / norm).astype(np.float32),
        "region_ids": regions,
        "normals": normals.astype(np.float32),
        "anchor_vertex_ids": ids,
        "lesion_masks": (evaluate_mask(rest, field) if field else np.zeros(len(rest))).astype(
            np.float32
        ),
        "renderer_seeds": np.asarray(render_seeds, dtype=np.uint32),
        "spatial_features": spatial_features(np.asarray(render_seeds, dtype=np.uint32)),
    }
    return record, arrays


def _archive(path: Path, arrays: dict[str, np.ndarray]) -> None:
    """Fixed ZIP metadata and streaming array writes, no multi-GB BytesIO copy."""
    temp = path.with_suffix(".tmp")
    with zipfile.ZipFile(
        temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True
    ) as z:
        for key, value in sorted(arrays.items()):
            info = zipfile.ZipInfo(key + ".npy", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with z.open(info, "w", force_zip64=True) as stream:
                np.lib.format.write_array(stream, value, allow_pickle=False)
    temp.replace(path)


def build_release(
    template_root: Path,
    output: Path,
    *,
    lane: str,
    count: int = 576,
    point_count: int = 512,
    seed: int = 20261007,
    workers: int = 3,
    template_ids: list[str] | None = None,
) -> dict[str, Any]:
    if lane not in ("baseline", "disease") or type(count) is not int or count < 24 or count % 3:
        raise ValueError("V2 lane/count invalid; count divisible by3, at least24")
    if type(point_count) is not int or not 16 <= point_count <= 1024:
        raise ValueError("V2 query count must be16..1024")
    if (
        type(workers) is not int
        or not 1 <= workers <= 8
        or type(seed) is not int
        or not 0 <= seed < 2**32
    ):
        raise ValueError("Invalid workers/seed")
    template_root, output = Path(template_root).resolve(), Path(output)
    recipe = {
        "lane": lane,
        "count_per_condition": count,
        "point_count": point_count,
        "seed": seed,
        "template_ids": template_ids,
    }
    if (output / "release.json").exists():
        existing = verify_release(output)
        if existing["recipe"] != recipe:
            raise ValueError("Different immutable release already exists")
        return existing
    if output.exists() and any(output.iterdir()):
        raise ValueError("Choose an empty release directory")
    output.mkdir(parents=True, exist_ok=True)
    # Keep portable provenance keys while locating bytes in either wheel or checkout.
    package = Path(__file__).resolve().parent
    renderer_hashes = {p: digest(package / Path(p).name) for p in RENDERER_PATHS}
    builder_sha = digest(Path(__file__))
    templates = sorted(list_templates(template_root), key=lambda r: r["template_id"])
    if template_ids:
        templates = [r for r in templates if r["template_id"] in template_ids]
        if len(templates) != len(set(template_ids)):
            raise ValueError("Unknown template selection")
    if not templates or any(not r.get("cohort_eligible") for r in templates):
        raise ValueError("Only attributed eligible templates supported")
    conditions: list[dict[str, Any]] = []
    for t in templates:
        profiles = (
            ["baseline"]
            if lane == "baseline"
            else [p["id"] for p in PROFILES.values() if p["supported"] and p["organ"] == t["organ"]]
        )
        conditions.extend(
            {
                "renderer_version": "disease-v2",
                "template_id": t["template_id"],
                "organ": t["organ"],
                "profile_id": p,
                "material_preset": "balanced",
            }
            for p in profiles
        )
    template_hashes = {
        t["template_id"]: digest(template_root / (t["template_id"] + ".npz")) for t in templates
    }
    metadata_hashes = {
        t["template_id"]: digest(template_root / (t["template_id"] + ".json")) for t in templates
    }
    _json_write(
        output / "catalog.json",
        {
            "conditions": conditions,
            "control_names": list(CONTROL_NAMES),
            "observation_names": list(OBSERVATION_NAMES),
            "severity_names": list(SEVERITY_NAMES),
            "severity_bands": SEVERITY_BANDS,
            "points_per_sample": point_count,
            "template_hashes": template_hashes,
            "template_metadata_hashes": metadata_hashes,
            "normalization": "XYZ/restXYZ in mm divided by template normalization_mm; linearRGB; roughness[0,1]",
            "renderer_phase_policy": "two explicit per-row uint32 seeds, lossless little-endian byte context",
            "anchor_policy": "variable source vertex IDs; extent/component/area coverage and lesion-aware queries",
        },
    )
    _json_write(output / "reference_catalog.json", {"templates": templates})
    tasks, task_conditions = [], []
    for cid, condition in enumerate(conditions):
        tid = condition["template_id"]
        roles = family_splits(count, sub_seed(seed, tid, "joint-v2-family-splits"))
        values = sample_controls(condition, count, sub_seed(seed, tid, "joint-v2-family-controls"))
        for i in range(count):
            group = content_hash([seed, tid, "joint-v2-parent", i])[:24]
            sample_id = content_hash([group, condition["profile_id"]])[:24]
            row_seed = sub_seed(seed, tid, condition["profile_id"], str(i), "row")
            seeds = [
                sub_seed(seed, tid, str(i), "material-phase"),
                sub_seed(seed, tid, condition["profile_id"], str(i), "disease-phase"),
            ]
            band = 0 if lane == "baseline" else i % 3 + 1
            tasks.append(
                (
                    str(template_root),
                    condition,
                    values[i],
                    row_seed,
                    seeds,
                    point_count,
                    sample_id,
                    group,
                    roles[i],
                    band,
                    i < 3 or i % 64 == 0 or i >= count - 3,
                )
            )
            task_conditions.append(cid)
    split_counts = {s: sum(t[8] == s for t in tasks) for s in SPLITS}
    staging = output / ".arrays"
    staging.mkdir()
    arrays: dict[str, dict[str, np.ndarray]] = {s: {} for s in SPLITS}
    schema = {
        "controls": ((22,), "f4"),
        "observations": ((point_count, 7), "f4"),
        "baseline_observations": ((point_count, 7), "f4"),
        "rest_points": ((point_count, 3), "f4"),
        "region_ids": ((point_count,), "u1"),
        "normals": ((point_count, 3), "f4"),
        "anchor_vertex_ids": ((point_count,), "i4"),
        "lesion_masks": ((point_count,), "f4"),
        "renderer_seeds": ((2,), "u4"),
        "spatial_features": ((8,), "f4"),
        "condition_ids": ((), "i4"),
        "severity_ids": ((), "u1"),
        "seeds": ((), "u4"),
        "sample_ids": ((), "U24"),
        "group_ids": ((), "U24"),
    }
    for split in SPLITS:
        for key, (shape, dtype) in schema.items():
            arrays[split][key] = np.lib.format.open_memmap(
                staging / (split + "-" + key + ".npy"),
                mode="w+",
                dtype=dtype,
                shape=(split_counts[split], *shape),
            )
    cursor = dict.fromkeys(SPLITS, 0)
    qa_count = 0
    rejected_count = 0
    accepted_per_condition = np.zeros(len(conditions), dtype=int)
    started = time.monotonic()
    executor = concurrent.futures.ProcessPoolExecutor(max_workers=workers) if workers > 1 else None
    try:
        iterator = executor.map(_render, tasks, chunksize=8) if executor else map(_render, tasks)
        with (
            (output / "manifest.jsonl").open("w") as manifest,
            (output / "rejections.jsonl").open("w") as rejected,
        ):
            for index, (meta, row_arrays) in enumerate(iterator):
                if meta["status"] == "rejected_source_triangle_or_precision_qa":
                    rejected_count += 1
                    rejected.write(json.dumps(meta, sort_keys=True, allow_nan=False) + "\n")
                    rejected.flush()
                    continue
                accepted_per_condition[task_conditions[index]] += 1
                split = meta["split"]
                j = cursor[split]
                dest = arrays[split]
                for key, value in row_arrays.items():
                    dest[key][j] = value
                for key, value in {
                    "condition_ids": task_conditions[index],
                    "severity_ids": meta["severity_id"],
                    "seeds": meta["seed"],
                    "sample_ids": meta["sample_id"],
                    "group_ids": meta["group_id"],
                }.items():
                    dest[key][j] = value
                cursor[split] += 1
                qa_count += meta["full_mesh_qa"] is not None
                manifest.write(json.dumps(meta, sort_keys=True, allow_nan=False) + "\n")
                if index % 256 == 0 or index + 1 == len(tasks):
                    manifest.flush()
                    print(
                        f"{lane}: {index + 1}/{len(tasks)} anchor records, {qa_count} full meshes checked, {time.monotonic() - started:.1f}s",
                        flush=True,
                    )
    finally:
        if executor:
            executor.shutdown(cancel_futures=True)
    if np.any(accepted_per_condition < np.ceil(count * 0.95)):
        raise ValueError(
            "Insufficient source-safe coverage: a condition accepted fewer than95% of requested recipes"
        )
    split_counts = dict(cursor)
    for split in SPLITS:
        arrays[split] = {key: value[: cursor[split]] for key, value in arrays[split].items()}
        validate_split(arrays[split], conditions)
        _archive(output / (split + ".npz"), arrays[split])
    arrays.clear()
    shutil.rmtree(staging)
    _json_write(
        output / "dataset_card.json",
        {
            "lane": lane,
            "sample_count": qa_count,
            "requested_count": len(tasks),
            "rejected_count": rejected_count,
            "accepted_per_condition": accepted_per_condition.tolist(),
            "conditions": len(conditions),
            "templates": len(templates),
            "points_per_surface": point_count,
            "splits": split_counts,
            "independent_patient_count": 0,
            "full_mesh_qa_count": qa_count,
            "scope": "paired synthetic source-surface anchor observations; not one exported full mesh per row",
            "paired_baseline": "baseline_observations query identical source vertices with identical shape/material draw and material seed",
            "split_track": "within-generator synthetic parent families; shared atlases across splits; all profiles and baseline family stay together",
            "full_mesh_qa_policy": "every accepted recipe; all source triangles checked against exact transported source face normals, plus separate severe boundary audit",
            "normal_policy": "source smooth normals transported by exact inverse-transpose continuous Jacobian",
            "limitations": [
                "no donor-held-out clinical validation",
                "no measured tissue albedo or mechanics",
                "outer-surface proxies only; internal disease not generated",
                "no source/interpolated triangle intersection certification",
                "severity labels mean authored strength, not clinical stage",
                "observed photo palettes are unpaired context, not calibrated albedo",
            ],
            "attribution": "reference_catalog.json retains exact template CC BY attribution",
        },
    )
    if digest(Path(__file__)) != builder_sha or any(
        digest(package / Path(p).name) != sha for p, sha in renderer_hashes.items()
    ):
        raise ValueError("Renderer/builder source changed during generation; release not frozen")
    release = {
        "format": DATASET_FORMAT,
        "recipe": recipe,
        "release_id": content_hash([recipe, renderer_hashes, template_hashes])[:20],
        "samples": qa_count,
        "requested_samples": len(tasks),
        "rejected_samples": rejected_count,
        "split_counts": split_counts,
        "conditions": len(conditions),
        "points_per_sample": point_count,
        "full_mesh_qa_count": qa_count,
        "renderer_hashes": renderer_hashes,
        "template_hashes": template_hashes,
        "template_metadata_hashes": metadata_hashes,
        "builder_sha256": builder_sha,
        "artifact_hashes": {p.name: digest(p) for p in sorted(output.iterdir()) if p.is_file()},
        "scope": "paired synthetic renderer anchors; zero independent patients",
    }
    _json_write(output / "release.json", release)
    return verify_release(output)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--templates", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--lane", choices=("baseline", "disease"), required=True)
    p.add_argument("--count", type=int, default=576)
    p.add_argument("--points", type=int, default=512)
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--seed", type=int, default=20261007)
    p.add_argument("--template", action="append")
    a = p.parse_args()
    build_release(
        a.templates,
        a.out,
        lane=a.lane,
        count=a.count,
        point_count=a.points,
        workers=a.workers,
        seed=a.seed,
        template_ids=a.template,
    )


if __name__ == "__main__":
    main()
