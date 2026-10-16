"""Reproducible original pilot release with explicit within-generator splits."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import numpy as np

from .geometry import (
    CONDITION_KEYS,
    GENERATOR_VERSION,
    LINEAGE_ID,
    PARAMETER_KEYS,
    RESOLUTIONS,
    SAMPLER_PROFILES,
    canonical_hash,
    generate_scene,
    parameter_vector,
    sample_parameters,
)


def _json_write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
    temporary.replace(path)


def _deterministic_npz(path: Path, **arrays: np.ndarray) -> None:
    """NPZ with fixed ZIP metadata; canonical hashes survive deterministic reruns."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with zipfile.ZipFile(
        temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
    ) as archive:
        for key, value in sorted(arrays.items()):
            buffer = io.BytesIO()
            np.lib.format.write_array(buffer, np.asarray(value), allow_pickle=False)
            info = zipfile.ZipInfo(f"{key}.npy", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, buffer.getvalue())
    temporary.replace(path)


def _read_frozen_release(output: Path, recipe: dict[str, Any]) -> dict[str, Any]:
    """Verify an existing release without regenerating or replacing its artifacts."""
    release = json.loads((output / "release.json").read_text())
    if not isinstance(release, dict) or release.get("recipe") != recipe:
        raise ValueError("output contains a different release; choose a new directory")
    if release.get("release_id") != canonical_hash(recipe)[:16]:
        raise ValueError("Existing release identity is corrupt; choose a new directory")
    hashes = release.get("artifact_hashes")
    required = {
        "train.npz",
        "val.npz",
        "test.npz",
        "manifest.jsonl",
        "language.jsonl",
        "rejections.jsonl",
    }
    if not isinstance(hashes, dict) or not required.issubset(hashes):
        raise ValueError("Existing release has an incomplete artifact manifest")
    for name, digest in hashes.items():
        path = output / name
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or Path(name).is_absolute()
            or not path.resolve().is_relative_to(output.resolve())
            or path.is_symlink()
            or not path.is_file()
            or hashlib.sha256(path.read_bytes()).hexdigest() != digest
        ):
            raise ValueError(f"Existing release artifact failed integrity verification: {name}")
    card_path = output / "dataset_card.json"
    if not card_path.is_file():
        raise ValueError("Existing release is missing its dataset card")
    card = json.loads(card_path.read_text())
    if not isinstance(card, dict) or card.get("release_id") != release["release_id"]:
        raise ValueError("Existing dataset card belongs to a different release")
    records = [json.loads(line) for line in (output / "manifest.jsonl").read_text().splitlines()]
    accepted = [row for row in records if row.get("status") == "accepted_development_preview"]
    if len(records) != release.get("attempted") or len(accepted) != release.get("accepted"):
        raise ValueError("Existing release counts do not match its candidate ledger")
    if any(hashes.get(row.get("artifact")) != row.get("artifact_sha256") for row in accepted):
        raise ValueError("Existing release geometry manifest is inconsistent")
    return release


def create_dataset(
    output: str | Path,
    count: int = 128,
    seed: int = 20261006,
    resolution: str = "medium",
    *,
    sampler_profile: str = "broad_control_v0",
) -> dict[str, Any]:
    """Create a measured geometry pilot; train/val/test artifacts are isolated.

    Every candidate stays in the ledger. There is one construction lineage, so
    this is expressly *not* an independent-anatomy split or reviewed release.
    """
    if type(count) is not int or not 3 <= count <= 100000:
        raise ValueError("count must lie between 3 and 100000")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("seed must be a uint32 integer")
    if resolution not in RESOLUTIONS:
        raise ValueError(f"resolution must be one of {tuple(RESOLUTIONS)}")
    if sampler_profile not in SAMPLER_PROFILES:
        raise ValueError(f"unknown sampler profile {sampler_profile!r}")
    bounded_release = sampler_profile == "adult_design_v1"
    max_attempts = count * 3 if bounded_release else count
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    recipe: dict[str, Any] = {
        "generator_version": GENERATOR_VERSION,
        "count": count,
        "seed": seed,
        "resolution": resolution,
        "track": "within_generator",
        "split_policy": "seeded_permutation_70_15_15_v1",
    }
    if bounded_release:
        recipe["sampler_profile"] = sampler_profile
        recipe["sampler"] = SAMPLER_PROFILES[sampler_profile]
        recipe["count_role"] = "accepted_target"
        recipe["maximum_attempts"] = max_attempts
        recipe["split_policy"] = "presplit_accepted_slots_with_logged_retries_70_15_15_v1"
    release_id = canonical_hash(recipe)[:16]
    if (output / "release.json").exists():
        return _read_frozen_release(output, recipe)
    rng = np.random.Generator(np.random.PCG64(seed))
    order = rng.permutation(count)
    n_train = max(1, int(count * 0.70))
    n_val = max(1, int(count * 0.15))
    roles = np.full(count, "test", dtype="<U5")
    roles[order[:n_train]] = "train"
    roles[order[n_train : n_train + n_val]] = "val"
    records: list[dict[str, Any]] = []
    pairs: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    grouped: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": []}
    hashes = {}
    for index in range(max_attempts):
        if bounded_release and len(pairs) >= count:
            break
        role_index = len(pairs) if bounded_release else index
        sample_seed = int((seed + index * 104729) % 2**32)
        params = sample_parameters(sample_seed, profile=sampler_profile, enforce_volume_band=False)
        sample_id = f"abd-{canonical_hash({'recipe': release_id, 'seed': sample_seed})[:16]}"
        spec = {
            "seed": sample_seed,
            "parameters": params,
            "include_vessels": False,
            "title": f"Original anatomy {index + 1}",
        }
        record: dict[str, Any] = {
            "sample_id": sample_id,
            "split": str(roles[role_index]),
            "split_track": "within_generator",
            "split_group_id": sample_id,
            "lineage_id": LINEAGE_ID,
            "lineage_root_ids": [LINEAGE_ID],
            "construction_family": GENERATOR_VERSION,
            "base_design_id": LINEAGE_ID,
            "seed": sample_seed,
            "requested_spec": spec,
            "parameters": params,
            "evidence": {
                "geometry": "procedural",
                "appearance": "procedural",
                "mechanics": "unknown",
            },
            "review_status": "unreviewed",
            "rights": {"origin": "original_code_authored", "external_geometry_assets": []},
        }
        if bounded_release:
            record["sampler_profile"] = sampler_profile
            record["planned_split_slot"] = role_index
        try:
            scene = generate_scene(spec, resolution, include_simulation=False)
            volume = scene["measurements"]["liver_volume_ml"]
            if bounded_release and not 1200.0 <= volume <= 2600.0:
                record.update(
                    {
                        "content_hash": scene["content_hash"],
                        "measurements": scene["measurements"],
                        "qa": {
                            "passed": False,
                            "profile": "development_preview",
                            "surface_checks_passed": scene["qa"]["passed"],
                        },
                        "status": "rejected",
                        "rejection_reason": "AUTHORING_VOLUME_BAND",
                        "design_constraint": {
                            "measurement": "liver_volume_ml",
                            "bounds_ml": [1200.0, 2600.0],
                            "evidence": "authoring_design_band_not_clinical_norm",
                        },
                    }
                )
                rejected.append(record)
                records.append(record)
                continue
            record.update(
                {
                    "content_hash": scene["content_hash"],
                    "measurements": scene["measurements"],
                    "qa": scene["qa"],
                    "status": "accepted_development_preview"
                    if scene["qa"]["passed"]
                    else "rejected",
                }
            )
            if not scene["qa"]["passed"]:
                record["rejection_reason"] = [
                    item for item in scene["gate"]["checks"] if item["result"] == "FAIL"
                ]
                rejected.append(record)
                records.append(record)
                continue
            arrays = {
                "parameters": parameter_vector(params),
                "conditions": np.asarray(
                    [scene["measurements"][key] for key in CONDITION_KEYS], dtype=np.float32
                ),
                "parameter_names": np.asarray(PARAMETER_KEYS),
                "condition_names": np.asarray(CONDITION_KEYS),
            }
            for organ in scene["organs"]:
                prefix = organ["id"]
                arrays[f"{prefix}_positions_mm"] = np.asarray(
                    organ["positions"], dtype=np.float32
                ).reshape(-1, 3)
                arrays[f"{prefix}_faces"] = np.asarray(organ["indices"], dtype=np.int32).reshape(
                    -1, 3
                )
                arrays[f"{prefix}_uv"] = np.asarray(organ["uv"], dtype=np.float32).reshape(-1, 2)
                arrays[f"{prefix}_normals"] = np.asarray(
                    organ["normals"], dtype=np.float32
                ).reshape(-1, 3)
                arrays[f"{prefix}_colors"] = np.asarray(organ["colors"], dtype=np.float32).reshape(
                    -1, 3
                )
                if "lumen" in organ:
                    arrays[f"{prefix}_lumen_positions_mm"] = np.asarray(
                        organ["lumen"]["positions"], dtype=np.float32
                    ).reshape(-1, 3)
                record.setdefault("geometry", {})[prefix] = {
                    "topology_id": organ["metadata"]["topology_id"],
                    "metrics": organ["metadata"]["metrics"],
                    "landmarks": organ["landmarks"],
                }
            artifact = output / "geometry" / f"{sample_id}.npz"
            _deterministic_npz(artifact, **arrays)
            digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
            record["artifact"] = artifact.relative_to(output).as_posix()
            record["artifact_sha256"] = digest
            hashes[record["artifact"]] = digest
            grouped[str(roles[role_index])].append(
                {
                    "record": record,
                    "parameters": arrays["parameters"],
                    "conditions": arrays["conditions"],
                }
            )
            m = scene["measurements"]
            caption = f"Authored synthetic liver: outer envelope {m['liver_volume_ml']:.1f} mL; RAS width {m['liver_width_mm']:.1f} mm, height {m['liver_height_mm']:.1f} mm and depth {m['liver_depth_mm']:.1f} mm. Gallbladder outer envelope {m['gallbladder_enclosed_ml']:.1f} mL with neck-to-fundus distance {m['gallbladder_length_mm']:.1f} mm. Anatomical review pending."
            pairs.append(
                {
                    "sample_id": sample_id,
                    "split": record["split"],
                    "split_group_id": sample_id,
                    "lineage_id": LINEAGE_ID,
                    "asset_hash": record["content_hash"],
                    "caption": caption,
                    "caption_origin": "measured_rule_template_v1",
                    "label_basis": "measurement_of_generated_asset",
                    "request": f"Set liver width to {params['liver_width_mm']:.6f} mm, height to {params['liver_height_mm']:.6f} mm and depth to {params['liver_depth_mm']:.6f} mm. Set gallbladder length to {params['gallbladder_length_mm']:.6f} mm.",
                    "expected_parameters": {
                        key: params[key]
                        for key in (
                            "liver_width_mm",
                            "liver_height_mm",
                            "liver_depth_mm",
                            "gallbladder_length_mm",
                        )
                    },
                    "outcome": "ready",
                    "generalization_scope": "within_generator_synthetic_language",
                }
            )
            records.append(record)
        except (ValueError, FloatingPointError) as error:
            record.update(
                {"status": "rejected", "rejection_reason": f"{type(error).__name__}: {error}"}
            )
            records.append(record)
            rejected.append(record)
    for name, rows in grouped.items():
        path = output / f"{name}.npz"
        _deterministic_npz(
            path,
            parameters=np.stack([r["parameters"] for r in rows])
            if rows
            else np.empty((0, len(PARAMETER_KEYS)), dtype=np.float32),
            conditions=np.stack([r["conditions"] for r in rows])
            if rows
            else np.empty((0, len(CONDITION_KEYS)), dtype=np.float32),
            parameter_names=np.asarray(PARAMETER_KEYS),
            condition_names=np.asarray(CONDITION_KEYS),
            sample_ids=np.asarray([r["record"]["sample_id"] for r in rows], dtype="<U24"),
            group_ids=np.asarray([r["record"]["split_group_id"] for r in rows], dtype="<U24"),
            lineage_ids=np.asarray([LINEAGE_ID for _ in rows], dtype="<U64"),
            splits=np.asarray([name for _ in rows], dtype="<U5"),
        )
        hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    for name, rows in (
        ("manifest.jsonl", records),
        ("language.jsonl", pairs),
        ("rejections.jsonl", rejected),
    ):
        temporary = output / (name + ".tmp")
        temporary.write_text(
            "".join(
                json.dumps(row, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"
                for row in rows
            )
        )
        temporary.replace(output / name)
        hashes[name] = hashlib.sha256((output / name).read_bytes()).hexdigest()
    release = {
        "schema_version": "0.1.0",
        "release_id": release_id,
        "recipe": recipe,
        "profile": "development_preview",
        "review_status": "unreviewed",
        "attempted": len(records),
        "accepted": len(pairs),
        "rejected": len(rejected),
        "split_counts": {k: len(v) for k, v in grouped.items()},
        "independent_design_count": 1,
        "independent_anatomy_holdout": "unavailable_single_recipe",
        "parameter_names": list(PARAMETER_KEYS),
        "condition_names": list(CONDITION_KEYS),
        "rights_status": "original_procedural_outputs_no_external_mesh_sources",
        "artifact_hashes": hashes,
    }
    if bounded_release:
        release["sampler_profile"] = sampler_profile
        release["completion_status"] = (
            "complete" if len(pairs) == count else "attempt_limit_reached"
        )
        quantiles = {}
        for status, subset in (
            ("proposed", records),
            ("accepted", [r for r in records if r["status"] != "rejected"]),
        ):
            values = [r["measurements"]["liver_volume_ml"] for r in subset if "measurements" in r]
            quantiles[status] = (
                dict(
                    zip(
                        ("min", "p05", "median", "p95", "max"),
                        np.quantile(values, [0, 0.05, 0.5, 0.95, 1]).tolist(),
                        strict=True,
                    )
                )
                if values
                else None
            )
        release["liver_volume_quantiles_ml"] = quantiles
    _json_write(
        output / "dataset_card.json",
        {
            "name": "Original abdominal surface pilot",
            "release_id": release_id,
            **(
                {
                    "sampler_profile": sampler_profile,
                    "sampling_design": SAMPLER_PROFILES[sampler_profile],
                    "sampling_revision_reason": "The preserved pilot-v0 is broad control stress coverage (median liver approximately 2849 mL). The adult_design_v1 profile centres correlated dimensions on authored defaults and gates measured outer-envelope volume to 1200–2600 mL. These are engineering authoring bounds, not clinical normal ranges, diagnosed disease or population prevalence. All rejected construction candidates remain in the ledger.",
                }
                if bounded_release
                else {}
            ),
            "anatomy": {
                "families": ["liver", "gallbladder"],
                "status": "unreviewed_procedural",
                "independent_recipes": 1,
            },
            "language": {
                "status": "rule_generated_measured_captions",
                "human_test": "not_available",
            },
            "mechanics": {
                "status": "not_included",
                "reason": "No validated tissue model or experimental observations attached to these surface assets.",
            },
            "appearance": {
                "status": "procedural_intrinsic_vertex_color_and_uv",
                "empirical_material_calibration": "not_available",
            },
            "split_policy": "Same-recipe interpolation by seed. Per-sample derivatives stay together; no independent-lineage validation is claimed.",
            "limitations": [
                "Unreviewed original construction is not expert-reviewed synthetic anatomy or acquired anatomy.",
                "No Couinaud territories, intraparenchymal trees, tet meshes, histology or empirical mechanical labels.",
                "Gallbladder lumen is a sealed homothetic approximation; not a flow-ready duct system.",
                "Mesh-edge checks do not establish exact global self-intersection freedom.",
                "Synthetic design ranges and sampling density are not human prevalence.",
            ],
        },
    )
    # The release file commits completion only after the card and all artifacts exist.
    _json_write(output / "release.json", release)
    return release


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("datasets/original/pilot-v1"))
    parser.add_argument("--count", type=int, default=128)
    parser.add_argument("--seed", type=int, default=20261006)
    parser.add_argument("--resolution", choices=("low", "medium", "high"), default="medium")
    parser.add_argument(
        "--sampler-profile", choices=tuple(SAMPLER_PROFILES), default="adult_design_v1"
    )
    args = parser.parse_args()
    release = create_dataset(
        args.output, args.count, args.seed, args.resolution, sampler_profile=args.sampler_profile
    )
    print(
        json.dumps(
            {
                key: release[key]
                for key in (
                    "release_id",
                    "attempted",
                    "accepted",
                    "rejected",
                    "split_counts",
                    "profile",
                )
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
