"""Materialized disease-design surfaces, bound to the exact editor replay decoder.

This is an authored within-generator cohort, not a clinical patient split. Full
resolution meshes replay from shared licensed templates plus frozen bound specs;
point clouds and realized measurements are stored directly for geometry training.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from . import atlas_disease_recipe_dataset as recipes
from .atlas_disease import DiseaseSpec, evaluate_mask
from .atlas_disease_scene import DiseaseAtlasSpec, realize
from .atlas_scene import get_template
from .dataset import _deterministic_npz, _json_write

FORMAT = "viscera-disease-realized-geometry-1.0.0"
SPLITS = ("train", "val", "audit")
FEATURE_NAMES = (
    "extent_x_mm",
    "extent_y_mm",
    "extent_z_mm",
    "surface_area_mm2",
    "max_displacement_mm",
    "applied_displacement_fraction",
)
DECODER_FILES = (
    "atlas.py",
    "atlas_scene.py",
    "atlas_appearance.py",
    "atlas_surface_scene.py",
    "atlas_surface_normals.py",
    "atlas_materials.py",
    "atlas_disease.py",
    "atlas_disease_scene.py",
    "disease_profiles.json",
    "atlas_disease_recipe_dataset.py",
    "atlas_disease_geometry_dataset.py",
    "dataset.py",
)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def content_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def _safe(root: Path, relative: str) -> Path:
    if (
        not isinstance(relative, str)
        or Path(relative).is_absolute()
        or ".." in Path(relative).parts
    ):
        raise ValueError("Unsafe disease geometry artifact path")
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f"Missing or unsafe disease geometry artifact: {relative}")
    if any(p.is_symlink() for p in path.parents if p != root and p.is_relative_to(root)):
        raise ValueError(f"Symlink ancestor in disease geometry artifact: {relative}")
    return path


def decoder_hashes() -> dict[str, str]:
    root = Path(__file__).parent
    return {name: digest(root / name) for name in DECODER_FILES}


def _features(result: dict[str, Any]) -> np.ndarray:
    summary = result["summary"]
    return np.asarray(
        [
            *summary["extent_mm"],
            summary["measurements"]["surface_area_mm2"],
            summary["disease"]["max_displacement_mm"],
            summary["disease"]["applied_displacement_fraction"],
        ],
        dtype=np.float64,
    )


def _samples(result: dict[str, Any], template: Any, count: int, seed: int) -> dict[str, np.ndarray]:
    item = result["scene"]["organs"][0]
    vertices = np.asarray(item["positions"], dtype=float).reshape(-1, 3)
    faces = np.asarray(item["indices"], dtype=np.int64).reshape(-1, 3)
    if not np.array_equal(faces, template.faces) or vertices.shape != template.vertices_mm.shape:
        raise ValueError("Disease realization changed source triangle/vertex indexing")
    tri = vertices[faces]
    crosses = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    areas = np.linalg.norm(crosses, axis=1)
    if not np.isfinite(areas).all() or areas.sum() <= 0:
        raise ValueError("Cannot sample nonfinite or empty realized geometry")
    rng = np.random.default_rng(seed)
    ids = rng.choice(len(faces), count, p=areas / areas.sum())
    uv = rng.random((count, 2))
    s = np.sqrt(uv[:, 0])
    bary = np.column_stack((1 - s, s * (1 - uv[:, 1]), s * uv[:, 1]))
    points = np.einsum("ni,nij->nj", bary, tri[ids])
    rest = np.einsum("ni,nij->nj", bary, template.vertices_mm[faces[ids]])
    face_normals = crosses[ids] / areas[ids, None]
    normal_vertices = np.asarray(item["normals"], dtype=float).reshape(-1, 3)
    normals = np.einsum("ni,nij->nj", bary, normal_vertices[faces[ids]])
    norm = np.linalg.norm(normals, axis=1)
    missing = norm <= 1e-10
    normals[~missing] /= norm[~missing, None]
    normals[missing] = face_normals[missing]
    vertex_srgb = np.asarray(item["colors"]).reshape(-1, 3)
    vertex_linear = np.where(
        vertex_srgb <= 0.04045, vertex_srgb / 12.92, ((vertex_srgb + 0.055) / 1.055) ** 2.4
    )
    linear = np.einsum("ni,nij->nj", bary, vertex_linear[faces[ids]])
    colors = np.clip(
        np.where(
            linear <= 0.0031308, linear * 12.92, 1.055 * np.maximum(linear, 0) ** (1 / 2.4) - 0.055
        ),
        0,
        1,
    )
    center = (vertices.min(axis=0) + vertices.max(axis=0)) / 2
    scale = float(np.ptp(vertices, axis=0).max())
    field = item["metadata"]["disease_field"]
    return {
        "points_mm": points.astype(np.float32),
        "point_normals": normals.astype(np.float32),
        "face_normals": face_normals.astype(np.float32),
        "colors_srgb": colors.astype(np.float32),
        "rest_points_mm": rest.astype(np.float32),
        "points": ((points - center) / scale).astype(np.float32),
        "center_mm": center,
        "scale_mm": np.asarray(scale),
        "surface_face_ids": ids.astype(np.int32),
        "barycentric_coordinates": bary,
        "disease_design_mask": evaluate_mask(rest, field).astype(np.float32),
        "normal_fallback_count": np.asarray(missing.sum(), dtype=np.int64),
    }


def build_release(
    recipe_root: str | Path,
    template_root: str | Path,
    output: str | Path,
    *,
    per_profile: tuple[int, int, int] = (6, 1, 1),
    point_count: int = 2048,
    seed: int = 20261007,
    profile_ids: list[str] | None = None,
) -> dict[str, Any]:
    if len(per_profile) != 3 or any(type(n) is not int or n < 1 for n in per_profile):
        raise ValueError("per_profile requires positive train/val/audit counts")
    if type(point_count) is not int or not 32 <= point_count <= 32768:
        raise ValueError("point_count must be in [32,32768]")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("seed must be uint32")
    parent = Path(recipe_root).resolve()
    source = Path(template_root).resolve()
    output = Path(output)
    parent_release = recipes.verify_release(parent)
    frozen_decoder = decoder_hashes()
    if parent_release["recipe"]["source_sha256"] != frozen_decoder["atlas_disease.py"]:
        raise ValueError("Parent recipe release uses a different disease decoder")
    if (
        parent_release["artifact_hashes"].get("provenance/disease_profiles.json")
        != frozen_decoder["disease_profiles.json"]
    ):
        raise ValueError("Parent recipe release uses different disease profiles")
    splits = {split: recipes.read_split(parent, split) for split in SPLITS}
    recipes.ensure_groups(splits["train"], splits["val"])
    recipes.ensure_groups(splits["train"], splits["audit"])
    recipes.ensure_groups(splits["val"], splits["audit"])
    available = sorted(set(splits["train"]["profile_ids"].tolist()))
    profiles = available if profile_ids is None else sorted(profile_ids)
    if not profiles or len(set(profiles)) != len(profiles) or set(profiles) - set(available):
        raise ValueError("Unknown, repeated or empty geometry profile selection")
    source_catalog = json.loads(_safe(source, "catalog.json").read_text())
    catalog_by_organ: dict[str, list[dict[str, Any]]] = {}
    for entry in sorted(source_catalog["templates"], key=lambda x: x["template_id"]):
        if not entry.get("cohort_eligible", False) or any(
            not entry.get(key)
            for key in ("license", "attribution", "source_group_id", "source_url")
        ):
            raise ValueError(
                "Source template requires geometry eligibility and explicit rights/lineage metadata"
            )
        catalog_by_organ.setdefault(entry["organ"], []).append(entry)
    if any(p.is_symlink() for base in (source, parent) for p in base.rglob("*")):
        raise ValueError("Shared template/recipe releases must not contain symlinks")
    template_hashes = {
        p.relative_to(source).as_posix(): digest(p)
        for p in sorted(source.rglob("*"))
        if p.is_file()
    }
    plan: dict[str, Any] = {
        "format": FORMAT,
        "parent_recipe_release_id": parent_release["release_id"],
        "parent_recipe_release_sha256": digest(parent / "release.json"),
        "parent_recipe_artifact_hashes": parent_release["artifact_hashes"],
        "template_hashes": template_hashes,
        "decoder_source_hashes": frozen_decoder,
        "profile_ids": profiles,
        "per_profile": list(per_profile),
        "point_count": point_count,
        "seed": seed,
        "selection_policy": "Deterministically ranked parent recipes, same existing group/split; cycle available organ templates; retain rejected geometry attempts",
        "shape_controls": "all zero; disease recipes act on referenced template forms",
        "split_track": "within_generator",
        "patient_count": 0,
        "shared_reference_lineages_across_splits": True,
        "point_sampling": "realized triangle-area weighted; shared barycentric positions/normals/colors/rest coordinates",
        "software_versions": {
            "python": platform.python_version(),
            **{
                name: importlib.metadata.version(name)
                for name in ("numpy", "trimesh", "scipy", "pydantic")
            },
        },
    }
    if (output / "release.json").exists():
        existing = verify_release(output)
        if existing["recipe"] != plan:
            raise ValueError("Frozen geometry cohort differs; choose a new output directory")
        return existing
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Geometry output is nonempty/incomplete")
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=".disease-geometry-", dir=output.parent))
    try:
        shutil.copytree(source, temp / "templates")
        shutil.copytree(parent, temp / "parent_recipes")
        for name in DECODER_FILES:
            target = temp / "decoder" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(Path(__file__).parent / name, target)
        grouped: dict[str, list[tuple[dict[str, Any], dict[str, np.ndarray]]]] = {
            split: [] for split in SPLITS
        }
        rows: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        for profile in profiles:
            offset = 0
            for split, required in zip(SPLITS, per_profile, strict=True):
                data = splits[split]
                candidates = np.flatnonzero(data["profile_ids"] == profile).tolist()
                candidates.sort(key=lambda i: content_hash([seed, str(data["sample_ids"][i])]))
                if len(candidates) < required:
                    raise ValueError(f"Insufficient {split} parent recipes for {profile}")
                accepted = 0
                for attempt, index in enumerate(candidates):
                    if accepted >= required:
                        break
                    group = str(data["group_ids"][index])
                    parent_id = str(data["sample_ids"][index])
                    organ = str(data["organ_names"][index])
                    if organ not in catalog_by_organ:
                        raise ValueError(f"No licensed source template for {organ}")
                    entries = catalog_by_organ[organ]
                    entry = entries[(offset + attempt) % len(entries)]
                    template_id = entry["template_id"]
                    disease = recipes.decode_recipe(
                        profile, data["features"][index], int(data["seeds"][index])
                    )
                    spec = DiseaseAtlasSpec(
                        template_id=template_id,
                        seed=int(data["seeds"][index]),
                        disease=DiseaseSpec.model_validate(disease),
                    )
                    sample_id = "dgeo-" + content_hash([parent_id, template_id])[:20]
                    try:
                        result = realize(temp / "templates", spec)
                        template = get_template(temp / "templates", template_id)
                        sample_seed = int(content_hash([seed, sample_id, "surface-points"])[:8], 16)
                        cloud = _samples(result, template, point_count, sample_seed)
                    except ValueError as exc:
                        rejected.append(
                            {
                                "parent_sample_id": parent_id,
                                "parent_group_id": group,
                                "split": split,
                                "profile_id": profile,
                                "template_id": template_id,
                                "reason": str(exc),
                            }
                        )
                        continue
                    geometry_hash = result["scene"]["metadata"]["geometry_sha256"]
                    normal_sha = result["scene"]["metadata"]["normal_repair"]["sha256"]
                    features = _features(result)
                    if not np.isfinite(features).all() or np.any(features[:4] <= 0):
                        raise ValueError("Nonfinite/nonpositive realized geometry measurement")
                    row = {
                        "sample_id": sample_id,
                        "group_id": group,
                        "parent_sample_id": parent_id,
                        "parent_recipe_index": index,
                        "split": split,
                        "split_track": "within_generator",
                        "profile_id": profile,
                        "organ": organ,
                        "template_id": template_id,
                        "source_group_id": entry["source_group_id"],
                        "source_url": entry["source_url"],
                        "source_license": entry["license"],
                        "source_attribution": entry["attribution"],
                        "source_template_geometry_sha256": entry["geometry_sha256"],
                        "source_template_artifact_sha256": entry["artifact_sha256"],
                        "spec": result["spec"],
                        "summary": result["summary"],
                        "geometry_sha256": geometry_hash,
                        "display_normal_sha256": normal_sha,
                        "realized_id": result["spec"]["realized_id"],
                        "point_sampling_seed": sample_seed,
                        "features": features.tolist(),
                        "recipe_features": data["features"][index].tolist(),
                        "point_count": point_count,
                        "vertex_count": len(template.vertices_mm),
                        "face_count": len(template.faces),
                        "normal_fallback_count": int(cloud["normal_fallback_count"]),
                        "coordinate_frame": "atlas-display-Y-up-centered-mm-not-RAS",
                        "units": "mm",
                        "disease_field": result["scene"]["organs"][0]["metadata"]["disease_field"],
                        "qa": result["scene"]["metadata"]["qa"],
                        "geometry_evidence": "authored_disease_surface_from_licensed_reference_template",
                        "appearance_evidence": "authored_vertex_color_not_measured_tissue_texture",
                        "mechanics_evidence": "none",
                        "clinical_review_status": "unreviewed",
                        "patient_id": None,
                        "path": f"records/{sample_id}.json",
                    }
                    _json_write(temp / row["path"], row)
                    cloud["features"] = features
                    cloud["recipe_features"] = data["features"][index].copy()
                    grouped[split].append((row, cloud))
                    rows.append(row)
                    accepted += 1
                if accepted != required:
                    raise ValueError(
                        f"Only {accepted}/{required} {split} geometries passed for {profile}"
                    )
                offset += required
        for split, items in grouped.items():
            arrays = {key: np.stack([cloud[key] for _, cloud in items]) for key in items[0][1]}
            arrays.update(
                {
                    "feature_names": np.asarray(FEATURE_NAMES),
                    "recipe_feature_names": np.asarray(recipes.FEATURE_NAMES),
                }
            )
            for key, record_key in (
                ("sample_ids", "sample_id"),
                ("group_ids", "group_id"),
                ("parent_sample_ids", "parent_sample_id"),
                ("profile_ids", "profile_id"),
                ("organ_names", "organ"),
                ("template_ids", "template_id"),
            ):
                arrays[key] = np.asarray([row[record_key] for row, _ in items])
            _deterministic_npz(temp / f"{split}.npz", **arrays)
        (temp / "manifest.jsonl").write_text(
            "".join(json.dumps(row, sort_keys=True, allow_nan=False) + "\n" for row in rows)
        )
        (temp / "rejections.jsonl").write_text(
            "".join(json.dumps(row, sort_keys=True) + "\n" for row in rejected)
        )
        release_id = content_hash(plan)[:20]
        _json_write(
            temp / "dataset_card.json",
            {
                "release_id": release_id,
                "format": FORMAT,
                "sample_count": len(rows),
                "organ_count": len({r["organ"] for r in rows}),
                "profile_count": len(profiles),
                "patient_count": 0,
                "split_track": "within_generator",
                "split_counts": {split: len(grouped[split]) for split in SPLITS},
                "rejected_attempt_count": len(rejected),
                "shared_reference_lineages_across_splits": True,
                "full_resolution_geometry": "Lossless source indexing replay through bound editor specs and frozen decoder; source templates copied once",
                "normal_definition": "Barycentric interpolated displayed vertex normal, renormalized; vanishing interpolation falls back to face normal with count recorded",
                "disease_design_mask": "Authored compact-support weight on the surface; NOT clinical lesion segmentation",
                "color_definition": "Editor vertex colors interpolated in linear RGB, stored in sRGB; display proxy, not calibrated surgical photographs",
                "volume_status": "NOT_APPLICABLE: source display surface assemblies are not certified organ envelopes",
                "limitations": [
                    "No patient-specific disease geometry or prevalence is inferred from these synthetic forms",
                    "Held-out recipes share reference anatomy lineages with training and do not test unseen patient generalization",
                    "Geometry acceptance filters failed source-face realizations; all rejections are recorded",
                    "No vasculature, lumen, internal lesion volume or FEM domain is generated",
                    "No measured optical or mechanical material properties; specialist anatomical review pending",
                ],
                "licenses": sorted({r["source_license"] for r in rows}),
                "attribution_path": "templates/attribution",
            },
        )
        if decoder_hashes() != frozen_decoder:
            raise ValueError(
                "Disease decoder changed during cohort generation; choose a new frozen build"
            )
        hashes = {
            p.relative_to(temp).as_posix(): digest(p)
            for p in sorted(temp.rglob("*"))
            if p.is_file()
        }
        release = {
            "format": FORMAT,
            "release_id": release_id,
            "recipe": plan,
            "artifact_hashes": hashes,
            "parent_recipe_release_id": parent_release["release_id"],
            "parent_recipe_release_sha256": plan["parent_recipe_release_sha256"],
            "parent_recipe_artifact_hashes": parent_release["artifact_hashes"],
            "decoder_source_hashes": frozen_decoder,
            "template_hashes": template_hashes,
            "sample_count": len(rows),
            "organ_count": len({r["organ"] for r in rows}),
            "profile_count": len(profiles),
            "patient_count": 0,
            "split_track": "within_generator",
            "shared_reference_lineages_across_splits": True,
            "split_counts": {split: len(grouped[split]) for split in SPLITS},
            "rejected_attempt_count": len(rejected),
        }
        _json_write(temp / "release.json", release)
        verify_release(temp)
        if output.exists():
            output.rmdir()
        temp.replace(output)
        return release
    except BaseException:
        shutil.rmtree(temp, ignore_errors=True)
        raise


def read_split(root: str | Path, split: str, *, verify: bool = True) -> dict[str, np.ndarray]:
    root = Path(root).resolve()
    if split not in SPLITS:
        raise ValueError("Unknown disease geometry split")
    if verify:
        verify_release(root)
    with np.load(_safe(root, f"{split}.npz"), allow_pickle=False) as data:
        return {key: data[key] for key in data.files}


def verify_release(root: str | Path, *, verify_decoder: bool = True) -> dict[str, Any]:
    root = Path(root).resolve()
    release: dict[str, Any] = json.loads(_safe(root, "release.json").read_text())
    if (
        release.get("format") != FORMAT
        or release.get("release_id") != content_hash(release["recipe"])[:20]
    ):
        raise ValueError("Disease geometry release identity mismatch")
    required = {
        "manifest.jsonl",
        "dataset_card.json",
        "rejections.jsonl",
        "templates/catalog.json",
        "parent_recipes/release.json",
        *(f"{s}.npz" for s in SPLITS),
    }
    if not required <= release["artifact_hashes"].keys():
        raise ValueError("Incomplete disease geometry release")
    for name, sha in release["artifact_hashes"].items():
        if digest(_safe(root, name)) != sha:
            raise ValueError(f"Disease geometry integrity failure: {name}")
    if release["decoder_source_hashes"] != release["recipe"]["decoder_source_hashes"]:
        raise ValueError("Disease geometry decoder declaration differs from frozen recipe")
    for name, sha in release["decoder_source_hashes"].items():
        if release["artifact_hashes"].get("decoder/" + name) != sha:
            raise ValueError("Missing/changed frozen disease geometry decoder")
    if verify_decoder and decoder_hashes() != release["decoder_source_hashes"]:
        raise ValueError(
            "Active disease geometry decoder differs; replay with the frozen source version"
        )
    for key in (
        "template_hashes",
        "parent_recipe_release_id",
        "parent_recipe_release_sha256",
        "parent_recipe_artifact_hashes",
    ):
        if release[key] != release["recipe"][key]:
            raise ValueError(f"Disease geometry provenance differs from frozen recipe: {key}")
    if (
        release["patient_count"] != 0
        or release["split_track"] != "within_generator"
        or not release["shared_reference_lineages_across_splits"]
    ):
        raise ValueError("Synthetic geometry must not claim patient-held-out validation")
    for name, sha in release["template_hashes"].items():
        if release["artifact_hashes"].get("templates/" + name) != sha:
            raise ValueError("Disease geometry template dependency differs")
    if digest(root / "parent_recipes/release.json") != release["parent_recipe_release_sha256"]:
        raise ValueError("Disease geometry parent release hash differs")
    parent = recipes.verify_release(root / "parent_recipes")
    if (
        parent["release_id"] != release["parent_recipe_release_id"]
        or parent["artifact_hashes"] != release["parent_recipe_artifact_hashes"]
    ):
        raise ValueError("Disease geometry parent recipe binding differs")
    rows = [json.loads(line) for line in (root / "manifest.jsonl").read_text().splitlines()]
    if len(rows) != release["sample_count"] or len({r["sample_id"] for r in rows}) != len(rows):
        raise ValueError("Disease geometry case identity/count mismatch")
    template_catalog = {
        entry["template_id"]: entry
        for entry in json.loads((root / "templates/catalog.json").read_text())["templates"]
    }
    seen: set[str] = set()
    for split in SPLITS:
        selected = [row for row in rows if row["split"] == split]
        data = read_split(root, split, verify=False)
        parents = recipes.read_split(root / "parent_recipes", split)
        n, count = len(selected), release["recipe"]["point_count"]
        if n != release["split_counts"][split]:
            raise ValueError("Disease geometry split count mismatch")
        required_count = release["recipe"]["per_profile"][SPLITS.index(split)]
        if any(
            sum(row["profile_id"] == profile for row in selected) != required_count
            for profile in release["recipe"]["profile_ids"]
        ):
            raise ValueError("Disease geometry per-profile split count mismatch")
        for key, record_key in (
            ("sample_ids", "sample_id"),
            ("group_ids", "group_id"),
            ("parent_sample_ids", "parent_sample_id"),
            ("profile_ids", "profile_id"),
            ("organ_names", "organ"),
            ("template_ids", "template_id"),
        ):
            if data[key].tolist() != [row[record_key] for row in selected]:
                raise ValueError(f"Disease geometry tensor/manifest mismatch: {key}")
        if len(set(data["group_ids"].tolist())) != n or seen & set(data["group_ids"].tolist()):
            raise ValueError("Disease geometry parent group leakage")
        seen.update(data["group_ids"].tolist())
        for key in (
            "points_mm",
            "point_normals",
            "face_normals",
            "colors_srgb",
            "rest_points_mm",
            "points",
        ):
            if data[key].shape != (n, count, 3) or not np.isfinite(data[key]).all():
                raise ValueError(f"Invalid realized disease tensor: {key}")
        for key in ("point_normals", "face_normals"):
            if not np.allclose(np.linalg.norm(data[key], axis=-1), 1, atol=2e-6):
                raise ValueError("Nonunit disease surface normals")
        if (
            data["barycentric_coordinates"].shape != (n, count, 3)
            or np.any(data["barycentric_coordinates"] < 0)
            or not np.allclose(data["barycentric_coordinates"].sum(axis=-1), 1)
        ):
            raise ValueError("Invalid disease surface barycentric coordinates")
        if (
            data["disease_design_mask"].shape != (n, count)
            or not np.isfinite(data["disease_design_mask"]).all()
            or np.any((data["disease_design_mask"] < 0) | (data["disease_design_mask"] > 1))
        ):
            raise ValueError("Invalid disease design support weights")
        if np.any((data["colors_srgb"] < 0) | (data["colors_srgb"] > 1)):
            raise ValueError("Invalid disease authoring colors")
        if (
            data["features"].shape != (n, len(FEATURE_NAMES))
            or data["feature_names"].tolist() != list(FEATURE_NAMES)
            or not np.isfinite(data["features"]).all()
        ):
            raise ValueError("Invalid disease geometry measurement features")
        if (
            data["recipe_features"].shape != (n, 9)
            or data["recipe_feature_names"].tolist() != recipes.FEATURE_NAMES
        ):
            raise ValueError("Invalid disease recipe conditioning features")
        if (
            data["center_mm"].shape != (n, 3)
            or data["scale_mm"].shape != (n,)
            or not np.isfinite(data["center_mm"]).all()
            or not np.isfinite(data["scale_mm"]).all()
            or np.any(data["scale_mm"] <= 0)
        ):
            raise ValueError("Invalid disease geometry normalization")
        restored = data["points"] * data["scale_mm"][:, None, None] + data["center_mm"][:, None, :]
        if not np.allclose(restored, data["points_mm"], atol=0.0001, rtol=0):
            raise ValueError("Disease geometry normalization loses physical units")
        if (
            data["normal_fallback_count"].shape != (n,)
            or data["normal_fallback_count"].dtype.kind not in "iu"
        ):
            raise ValueError("Invalid disease point-normal fallback provenance")
        for i, row in enumerate(selected):
            index = row["parent_recipe_index"]
            if (
                str(parents["sample_ids"][index]) != row["parent_sample_id"]
                or str(parents["group_ids"][index]) != row["group_id"]
                or str(parents["profile_ids"][index]) != row["profile_id"]
                or str(parents["organ_names"][index]) != row["organ"]
            ):
                raise ValueError("Disease geometry no longer inherits its original parent split")
            expected_disease = recipes.decode_recipe(
                row["profile_id"], parents["features"][index], int(parents["seeds"][index])
            )
            if row["spec"]["disease"] != expected_disease:
                raise ValueError("Bound disease geometry recipe differs from parent conditions")
            entry = template_catalog[row["template_id"]]
            if (
                row["spec"]["template_sha256"] != entry["artifact_sha256"]
                or row["source_template_artifact_sha256"] != entry["artifact_sha256"]
                or row["source_group_id"] != entry["source_group_id"]
                or row["source_license"] != entry["license"]
            ):
                raise ValueError("Disease geometry source template or rights differ")
            if (
                row["patient_id"] is not None
                or row["split_track"] != "within_generator"
                or row["units"] != "mm"
            ):
                raise ValueError("Disease geometry evidence/physical-unit claim differs")
            if (
                int(data["normal_fallback_count"][i]) != row["normal_fallback_count"]
                or not 0 <= row["normal_fallback_count"] <= count
            ):
                raise ValueError("Disease point-normal fallback count differs")
            if not np.array_equal(data["recipe_features"][i], parents["features"][index]):
                raise ValueError("Disease geometry recipe features differ from parent")
            if not np.array_equal(data["features"][i], np.asarray(row["features"])):
                raise ValueError("Disease geometry measurements differ from manifest")
            if (
                data["surface_face_ids"].shape != (n, count)
                or data["surface_face_ids"].dtype.kind not in "iu"
                or np.any(data["surface_face_ids"][i] < 0)
                or np.any(data["surface_face_ids"][i] >= row["face_count"])
            ):
                raise ValueError("Disease cloud refers to invalid source triangles")
            if (
                row["path"] not in release["artifact_hashes"]
                or json.loads(_safe(root, row["path"]).read_text()) != row
            ):
                raise ValueError("Disease geometry case record differs from manifest")
    return release


def replay_record(root: str | Path, sample_id: str, *, verify: bool = True) -> dict[str, Any]:
    root = Path(root).resolve()
    if verify:
        verify_release(root)
    rows = [json.loads(line) for line in _safe(root, "manifest.jsonl").read_text().splitlines()]
    row = next((r for r in rows if r["sample_id"] == sample_id), None)
    if row is None:
        raise ValueError("Unknown disease geometry sample")
    result = realize(root / "templates", DiseaseAtlasSpec.model_validate(row["spec"]))
    if (
        result["spec"]["realized_id"] != row["realized_id"]
        or result["scene"]["metadata"]["geometry_sha256"] != row["geometry_sha256"]
    ):
        raise ValueError(
            "Disease full-resolution replay differs from the displayed training surface"
        )
    if result["scene"]["metadata"]["normal_repair"]["sha256"] != row[
        "display_normal_sha256"
    ] or not np.array_equal(_features(result), row["features"]):
        raise ValueError("Disease replay normal/measurement provenance differs")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--recipes", type=Path, required=True)
    build.add_argument("--templates", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--point-count", type=int, default=2048)
    check = commands.add_parser("verify")
    check.add_argument("release", type=Path)
    args = parser.parse_args()
    result = (
        build_release(args.recipes, args.templates, args.output, point_count=args.point_count)
        if args.command == "build"
        else verify_release(args.release)
    )
    print(
        json.dumps(
            {
                key: result[key]
                for key in (
                    "format",
                    "release_id",
                    "sample_count",
                    "organ_count",
                    "profile_count",
                    "split_counts",
                    "rejected_attempt_count",
                )
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
