"""Immutable paired organ/lesion reference cases; photographs are metadata-only evidence.

This small source-case cohort is not a population disease distribution. Every derivative
inherits its source/patient split and rights. Canonical geometry uses NIfTI RAS millimetres.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import trimesh

from .dataset import _deterministic_npz, _json_write

DATASET_VERSION = "atlas-disease-cases-1.0.0"
SPLITS = ("train", "val", "audit")
FEATURE_NAMES = (
    "organ_extent_x_mm",
    "organ_extent_y_mm",
    "organ_extent_z_mm",
    "organ_volume_ml",
    "lesion_extent_x_mm",
    "lesion_extent_y_mm",
    "lesion_extent_z_mm",
    "lesion_volume_ml",
    "lesion_center_x_relative",
    "lesion_center_y_relative",
    "lesion_center_z_relative",
    "lesion_to_organ_volume_ratio",
)
_DISEASE_CODES = {
    "kits19_case_00000": "clear_cell_renal_cell_carcinoma",
    "kits19_case_00008": "clear_cell_renal_cell_carcinoma",
    "kits19_case_00017": "angiomyolipoma",
    "kits19_case_00019": "oncocytoma",
}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def content_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def _safe(root: Path, name: str) -> Path:
    if not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError(f"Unsafe artifact path: {name!r}")
    result = root / name
    if result.is_symlink() or not result.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Unsafe artifact path: {name!r}")
    if any(p.is_symlink() for p in result.parents if p != root and p.is_relative_to(root)):
        raise ValueError(f"Symlink ancestor in artifact path: {name!r}")
    if not result.is_file():
        raise ValueError(f"Missing artifact: {name}")
    return result


def _labels(row: dict[str, Any]) -> list[dict[str, Any]]:
    if row["id"].startswith("kits19_"):
        return [
            {
                "role": role,
                "source_file": row["source_label_path"],
                "sha256": row["source_sha256"],
                "label_value": label,
            }
            for role, label in (("organ", 1), ("tumor", 2))
        ]
    return [{**label, "label_value": 1} for label in row["provenance"]["source_labels"]]


def _selection(catalog: dict[str, Any], allow_noncommercial: bool) -> list[dict[str, Any]]:
    selected = []
    for row in catalog["models"]:
        if row.get("status") != "downloaded" or not row.get("parts"):
            continue  # A licensed preview or public viewer is not a geometry download.
        if row["id"].startswith("PDA-") and row["license"] == "CC BY 4.0":
            if not re.fullmatch(r"PDA-C3L-\d{5}", row["id"]):
                raise ValueError("Invalid pancreatic source-case identifier")
            selected.append(row)
        elif row["id"] in _DISEASE_CODES:
            if not row["license"].startswith("CC BY-NC-SA 4.0"):
                raise ValueError("KiTS source license is inconsistent")
            if allow_noncommercial:
                selected.append(row)
        else:
            raise ValueError(f"Unreviewed local source adapter: {row['id']}")
    return sorted(selected, key=lambda row: row["id"])


def _source_id(row: dict[str, Any]) -> str:
    return "kits19" if row["id"].startswith("kits19_") else "zenodo_5510650"


def _group_id(row: dict[str, Any]) -> str:
    return (
        "kits19:" + str(row["id"]).removeprefix("kits19_")
        if _source_id(row) == "kits19"
        else "tcia:" + str(row["id"]).removeprefix("PDA-").replace("-", "_")
    )


def _splits(rows: list[dict[str, Any]], seed: int) -> dict[str, str]:
    """Source-stratified patient groups; changing an unrelated license lane cannot resplit."""
    assignments = {}
    for source in sorted({_source_id(row) for row in rows}):
        groups = sorted(
            {_group_id(row) for row in rows if _source_id(row) == source},
            key=lambda group: content_hash([seed, source, group]),
        )
        if len(groups) < 3:
            raise ValueError(f"At least three independent source cases required for {source}")
        # Tiny pilot: always reserve one validation and one audit patient per source.
        for i, group in enumerate(groups):
            assignments[group] = "val" if i == 0 else "audit" if i == 1 else "train"
    return assignments


def _mesh(path: Path, row: dict[str, Any]) -> trimesh.Trimesh:
    loaded = trimesh.load(path, force="scene", process=False)
    mesh = loaded.to_geometry() if isinstance(loaded, trimesh.Scene) else loaded
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        raise ValueError(f"Source contains no triangle mesh: {path}")
    vertices = np.asarray(mesh.vertices, dtype=np.float64) * 1000.0
    if _source_id(row) == "zenodo_5510650":
        rotation = np.asarray(row["provenance"]["rotation_RAS_to_Yup"], dtype=float)
        if rotation.shape != (3, 3) or not np.allclose(rotation @ rotation.T, np.eye(3)):
            raise ValueError("Invalid source display rotation")
        vertices = vertices @ rotation  # Undo row-vector RAS -> display transform.
    result = trimesh.Trimesh(vertices=vertices, faces=mesh.faces.copy(), process=False)
    if not np.isfinite(vertices).all() or not result.is_watertight or result.volume <= 0:
        raise ValueError(f"Nonfinite, open or inverted source surface: {path.name}")
    return result


def _sample(mesh: trimesh.Trimesh, count: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    triangles = np.asarray(mesh.vertices)[np.asarray(mesh.faces)]
    crosses = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    weights = np.linalg.norm(crosses, axis=1)
    if not np.isfinite(weights).all() or weights.sum() <= 0:
        raise ValueError("Surface sampling requires finite positive triangle area")
    rng = np.random.default_rng(seed)
    ids = rng.choice(len(triangles), count, p=weights / weights.sum())
    uv = rng.random((count, 2))
    s = np.sqrt(uv[:, 0])
    bary = np.column_stack((1 - s, s * (1 - uv[:, 1]), s * uv[:, 1]))
    return (
        np.einsum("ni,nij->nj", bary, triangles[ids]).astype(np.float32),
        (crosses[ids] / weights[ids, None]).astype(np.float32),
    )


def _label_measurements(
    path: Path, label: dict[str, Any], row: dict[str, Any], mesh: trimesh.Trimesh
) -> dict[str, Any]:
    try:
        import nibabel as nib
    except ImportError as exc:
        raise RuntimeError("Disease source ingestion requires nibabel>=5,<6") from exc
    image = nib.load(path)
    spatial_unit = image.header.get_xyzt_units()[0]
    if spatial_unit != "mm" and not (_source_id(row) == "kits19" and spatial_unit == "unknown"):
        raise ValueError(f"Unsupported NIfTI spatial units: {spatial_unit}")
    affine = np.asarray(image.affine, dtype=np.float64)
    if (
        affine.shape != (4, 4)
        or not np.isfinite(affine).all()
        or abs(np.linalg.det(affine[:3, :3])) <= 0
    ):
        raise ValueError("Invalid source affine")
    if "voxel_to_RAS_mm" in label and not np.allclose(affine, label["voxel_to_RAS_mm"], atol=1e-6):
        raise ValueError("Source affine differs from recorded provenance")
    data = np.asanyarray(image.dataobj)
    allowed = (0, 1, 2) if _source_id(row) == "kits19" else (0, 1)
    if not np.isin(data, allowed).all():
        raise ValueError("Unexpected source annotation labels")
    coords = np.nonzero(data == label["label_value"])
    count = len(coords[0])
    if count == 0:
        raise ValueError("Empty source annotation")
    centroid_voxel = np.asarray([axis.mean() for axis in coords])
    centroid_mm = affine[:3, :3] @ centroid_voxel + affine[:3, 3]
    volume_mm3 = count * abs(np.linalg.det(affine[:3, :3]))
    expected_bounds = np.empty((2, 3), dtype=np.float64)
    for axis in range(3):
        projected = sum(affine[axis, j] * coords[j] for j in range(3)) + affine[axis, 3]
        half_step = 0.5 * np.max(np.abs(affine[axis, :3]))
        expected_bounds[:, axis] = [projected.min() - half_step, projected.max() + half_step]
    if not np.allclose(mesh.bounds, expected_bounds, atol=0.002, rtol=1e-6):
        raise ValueError("Source mesh physical bounds disagree with its annotation")
    # Marching-cubes samples must map back onto half-voxel positions. This detects
    # double conversion, discarded glTF transforms, or the wrong pancreas rotation.
    voxel_vertices = (np.asarray(mesh.vertices) - affine[:3, 3]) @ np.linalg.inv(affine[:3, :3]).T
    half_voxel_error = float(np.max(np.abs(2 * voxel_vertices - np.rint(2 * voxel_vertices))))
    if half_voxel_error > 0.01:
        raise ValueError("Source mesh and NIfTI affine are not aligned")
    return {
        "voxel_to_RAS_mm": affine.tolist(),
        "shape": list(image.shape),
        "header_spatial_units": spatial_unit,
        "coordinate_units": "mm",
        "units_basis": (
            "NIfTI header"
            if spatial_unit == "mm"
            else "KiTS19 physical-coordinate convention; header unit field is unknown"
        ),
        "voxel_spacing_mm": np.linalg.norm(affine[:3, :3], axis=0).tolist(),
        "label_value": label["label_value"],
        "voxel_count": count,
        "volume_ml": float(volume_mm3 / 1000),
        "centroid_mm": centroid_mm.tolist(),
        "mesh_volume_ml": float(mesh.volume / 1000),
        "surface_area_mm2": float(mesh.area),
        "extent_mm": mesh.extents.tolist(),
        "bounds_mm": mesh.bounds.tolist(),
        "source_mask_surface_bounds_mm": expected_bounds.tolist(),
        "watertight": bool(mesh.is_watertight),
        "half_voxel_alignment_error": half_voxel_error,
    }


def _registry(catalog: dict[str, Any]) -> dict[str, Any]:
    refs = []
    for row in catalog["images"]:
        refs.append(
            {
                "id": row["id"],
                "reference_id": row["ref"],
                "organ": row["organ"],
                "disease": row["disease"],
                "source_url": row["source_url"],
                "creator": row["creator"],
                "license": row["license"],
                "license_url": row["license_url"],
                "source_image_sha256": row["sha256"],
                "evidence_domain": row["image_kind"],
                "visible_morphology": row["caption"],
                "candidate_controls_for_specialist_annotation": row["morphology_targets"],
                "numeric_parameter_ranges": None,
                "measured_mechanics": None,
                "paired_3d_case": None,
                "expert_review_status": "unreviewed",
                "limits": row["limitations"],
                "training_label_eligible": False,
            }
        )
    return {
        "schema": "disease-morphology-reference-registry-1.0.0",
        "purpose": "Source-linked review guidance, not measured geometry, texture or mechanics labels",
        "image_files_included": False,
        "references": refs,
    }


def create_dataset(
    gallery_root: str | Path,
    output: str | Path,
    *,
    allow_noncommercial: bool = False,
    point_count: int = 2048,
    seed: int = 20261007,
) -> dict[str, Any]:
    if type(allow_noncommercial) is not bool:
        raise ValueError("allow_noncommercial must be a boolean")
    if type(point_count) is not int or not 32 <= point_count <= 32768:
        raise ValueError("point_count must lie in [32,32768]")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("seed must be uint32")
    source = Path(gallery_root).resolve()
    output = Path(output)
    catalog = json.loads(_safe(source, "catalog.json").read_text())
    rows = _selection(catalog, allow_noncommercial)
    if not rows or len({_group_id(row) for row in rows}) != len(rows):
        raise ValueError("Missing or duplicate source patient identities")
    assignments = _splits(rows, seed)
    inputs = {"catalog.json": digest(source / "catalog.json")}
    for row in rows:
        for asset in (
            [{"path": row["local_path"], "sha256": row["sha256"]}]
            + row["parts"]
            + [{"path": v["source_file"], "sha256": v["sha256"]} for v in _labels(row)]
        ):
            path = _safe(source, asset["path"])
            actual = digest(path)
            if actual != asset["sha256"]:
                raise ValueError(f"Source integrity failure: {asset['path']}")
            inputs[asset["path"]] = actual
    provenance_files = ["provenance/pancreas-zenodo-record.json"]
    if allow_noncommercial:
        provenance_files += [
            "provenance/kits19-selected-clinical.json",
            "provenance/kits19-data-LICENSE.txt",
        ]
    for name in provenance_files:
        inputs[name] = digest(_safe(source, name))
    recipe = {
        "dataset_version": DATASET_VERSION,
        "point_count": point_count,
        "seed": seed,
        "allow_noncommercial": allow_noncommercial,
        "source_hashes": inputs,
        "code_sha256": digest(Path(__file__)),
        "generator_snapshot_path": "provenance/atlas_disease_dataset.py",
        "shared_dataset_helpers_sha256": digest(Path(__file__).with_name("dataset.py")),
        "software_versions": {
            "python": platform.python_version(),
            **{name: importlib.metadata.version(name) for name in ("numpy", "trimesh", "nibabel")},
        },
        "feature_names": list(FEATURE_NAMES),
        "split_policy": "source-stratified patient groups; one val + one audit per source; remaining train",
        "split_assignments": assignments,
        "augmentation_policy": "none; all future derivatives inherit patient split",
        "coordinates": "NIfTI RAS millimetres",
        "feature_volume_basis": "annotation voxel count times affine determinant",
    }
    if (output / "release.json").exists():
        existing = verify_release(output)
        if existing["recipe"] != recipe:
            raise ValueError("Existing release differs; choose a new immutable release directory")
        return existing
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Output is nonempty/incomplete; choose a new directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".disease-release-", dir=output.parent))
    try:
        records = []
        grouped: dict[str, list[tuple[dict[str, Any], dict[str, np.ndarray]]]] = {
            s: [] for s in SPLITS
        }
        for row in rows:
            cid = row["id"]
            base = temporary / "cases" / cid
            base.mkdir(parents=True)
            geometry = {}
            points = {}
            measured: dict[str, Any] = {}
            masks = []
            for label in _labels(row):
                role = "lesion" if label["role"] == "tumor" else "organ"
                part = next(p for p in row["parts"] if p["role"] == label["role"])
                mesh = _mesh(_safe(source, part["path"]), row)
                geometry[role + "_vertices_mm"] = np.asarray(mesh.vertices, dtype=np.float64)
                geometry[role + "_faces"] = np.asarray(mesh.faces, dtype=np.int32)
                measured[role] = _label_measurements(
                    _safe(source, label["source_file"]), label, row, mesh
                )
                pseed = int(content_hash([seed, cid, role])[:8], 16)
                points[role + "_points_mm"], points[role + "_normals"] = _sample(
                    mesh, point_count, pseed
                )
                dest_mesh = f"cases/{cid}/{role}.glb"
                shutil.copy2(source / part["path"], temporary / dest_mesh)
                dest_label = f"cases/{cid}/source_{role}.nii.gz"
                # KiTS organ + tumor live in the same source label volume; retain one exact copy.
                if _source_id(row) == "kits19":
                    dest_label = f"cases/{cid}/source_segmentation.nii.gz"
                if not (temporary / dest_label).exists():
                    shutil.copy2(source / label["source_file"], temporary / dest_label)
                masks.append(
                    {
                        "role": role,
                        "path": dest_label,
                        "sha256": label["sha256"],
                        "label_value": label["label_value"],
                        "voxel_to_RAS_mm": measured[role]["voxel_to_RAS_mm"],
                        "header_spatial_units": measured[role]["header_spatial_units"],
                    }
                )
            organ = measured["organ"]
            lesion = measured["lesion"]
            center = np.mean(organ["bounds_mm"], axis=0)
            extent = np.asarray(organ["extent_mm"])
            scale = float(extent.max())
            relative = (np.asarray(lesion["centroid_mm"]) - center) / extent
            features = np.asarray(
                [
                    *extent,
                    organ["volume_ml"],
                    *lesion["extent_mm"],
                    lesion["volume_ml"],
                    *relative,
                    lesion["volume_ml"] / organ["volume_ml"],
                ],
                dtype=np.float32,
            )
            points.update(
                center_mm=center.astype(np.float64),
                scale_mm=np.asarray(scale),
                organ_points=(points["organ_points_mm"] - center).astype(np.float32) / scale,
                lesion_points=(points["lesion_points_mm"] - center).astype(np.float32) / scale,
                features=features,
                feature_names=np.asarray(FEATURE_NAMES),
            )
            _deterministic_npz(base / "geometry.npz", **geometry)
            _deterministic_npz(base / "points.npz", **points)
            measured.update(
                {
                    "coordinate_frame": "RAS",
                    "units": "mm",
                    "features": dict(zip(FEATURE_NAMES, features.tolist())),
                    "center_mm": center.tolist(),
                    "scale_mm": scale,
                    "volume_basis": "Source annotation voxel count, not fitted mesh volume",
                    "lesion_center_relative_definition": "(source-mask lesion centroid - organ bounding-box center) / organ XYZ extent",
                    "organ_scope": "bilateral_kidneys"
                    if row["organ"] == "kidney"
                    else "single_pancreas",
                    "self_intersections": "not evaluated",
                    "measured_material_properties": None,
                    "measured_surface_texture": None,
                }
            )
            _json_write(base / "measurements.json", measured)
            lane = "noncommercial_sharealike" if _source_id(row) == "kits19" else "attribution"
            record = {
                "case_id": cid,
                "group_id": _group_id(row),
                "source_id": _source_id(row),
                "organ": row["organ"],
                "disease_code": _DISEASE_CODES.get(cid, "pancreatic_ductal_adenocarcinoma"),
                "disease": row["disease"],
                "split": assignments[_group_id(row)],
                "license_spdx": "CC-BY-NC-SA-4.0"
                if lane.startswith("noncommercial")
                else "CC-BY-4.0",
                "license_lane": lane,
                "license_url": row["license_url"],
                "creator": row["creator"],
                "source_url": row["source_url"],
                "source_reference": row["ref"],
                "clinical_evidence": row["clinical_evidence"],
                "limitations": row["limitations"],
                "organ_scope": measured["organ_scope"],
                "coordinate_frame": "RAS",
                "units": "mm",
                "geometry_path": f"cases/{cid}/geometry.npz",
                "points_path": f"cases/{cid}/points.npz",
                "measurements_path": f"cases/{cid}/measurements.json",
                "source_masks": masks,
                "mesh_paths": {role: f"cases/{cid}/{role}.glb" for role in ("organ", "lesion")},
                "mesh_display_transform": row.get(
                    "coordinate_system", row.get("provenance", {}).get("display_transform")
                ),
                "source_mesh_sha256": row["sha256"],
                "review_status": "source_annotation_retained; local clinical review pending",
                "texture_evidence": "none",
                "mechanics_evidence": "none",
                "paired_healthy_geometry": False,
                "augmentation": False,
                "feature_names": list(FEATURE_NAMES),
                "features": features.tolist(),
            }
            records.append(record)
            grouped[record["split"]].append((record, points))
        for split, items in grouped.items():
            arrays = {
                key: np.stack([p[key] for _, p in items])
                for key in (
                    "organ_points_mm",
                    "lesion_points_mm",
                    "organ_normals",
                    "lesion_normals",
                    "organ_points",
                    "lesion_points",
                    "center_mm",
                    "scale_mm",
                    "features",
                )
            }
            arrays.update(
                {
                    "feature_names": np.asarray(FEATURE_NAMES),
                    "feature_mask": np.ones((len(items), len(FEATURE_NAMES)), dtype=bool),
                }
            )
            for key, record_key in (
                ("case_ids", "case_id"),
                ("group_ids", "group_id"),
                ("source_ids", "source_id"),
                ("organ_names", "organ"),
                ("disease_codes", "disease_code"),
                ("license_lanes", "license_lane"),
            ):
                arrays[key] = np.asarray([r[record_key] for r, _ in items])
            _deterministic_npz(temporary / f"{split}.npz", **arrays)
        (temporary / "manifest.jsonl").write_text(
            "".join(json.dumps(r, sort_keys=True, allow_nan=False) + "\n" for r in records)
        )
        _json_write(temporary / "reference_registry.json", _registry(catalog))
        _json_write(
            temporary / "split_manifest.json",
            {
                "policy": recipe["split_policy"],
                "groups": assignments,
                "inheritance": "Every crop, view, mesh resample, synthetic edit and texture derivative inherits this patient split",
            },
        )
        for name in provenance_files:
            dest = temporary / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, dest)
        shutil.copy2(Path(__file__), temporary / "provenance/atlas_disease_dataset.py")
        shutil.copy2(
            Path(__file__).with_name("dataset.py"), temporary / "provenance/dataset_helpers.py"
        )
        release_id = content_hash(recipe)[:20]
        rights = {
            "contains_noncommercial": allow_noncommercial,
            "license_lanes": sorted({r["license_lane"] for r in records}),
            "no_blanket_license": True,
            "commercial_use": "excluded when noncommercial lane present"
            if allow_noncommercial
            else "CC-BY attribution conditions apply",
        }
        _json_write(
            temporary / "dataset_card.json",
            {
                "release_id": release_id,
                "dataset_version": DATASET_VERSION,
                "purpose": "Small paired clinical geometry pilot; source-case retrieval and engineering validation",
                "case_count": len(records),
                "independent_patient_count": len(records),
                "reference_image_count": len(catalog["images"]),
                "training_images_included": 0,
                "unpaired_external_viewer_models_included": 0,
                "rights": rights,
                "split_counts": {s: len(grouped[s]) for s in SPLITS},
                "limits": [
                    "Not enough patients to learn disease prevalence, realistic population variation or histology",
                    "No healthy/disease paired scans, source surgical textures or measured mechanics",
                    "KiTS masks contain both kidneys; kidney volume features are bilateral",
                    "Pancreas age is not recorded in this source metadata; do not assert confirmed adult status",
                    "Annotation boundaries retain voxel steps; do not interpret sub-voxel detail as anatomy",
                    "Images guide review only; morphology proposals and numeric controls are not clinical labels",
                ],
                "augmentation_policy": recipe["augmentation_policy"],
                "feature_names": list(FEATURE_NAMES),
            },
        )
        hashes = {
            p.relative_to(temporary).as_posix(): digest(p)
            for p in sorted(temporary.rglob("*"))
            if p.is_file()
        }
        release = {
            "dataset_version": DATASET_VERSION,
            "release_id": release_id,
            "recipe": recipe,
            "artifact_hashes": hashes,
            "case_count": len(records),
            "rights": rights,
            "split_counts": {s: len(grouped[s]) for s in SPLITS},
        }
        _json_write(temporary / "release.json", release)
        verify_release(temporary)
        if output.exists():
            output.rmdir()
        temporary.replace(output)
        return release
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def verify_release(root: str | Path) -> dict[str, Any]:
    root = Path(root).resolve()
    release: dict[str, Any] = json.loads(_safe(root, "release.json").read_text())
    if release.get("dataset_version") != DATASET_VERSION:
        raise ValueError("Unsupported disease dataset schema")
    if release.get("release_id") != content_hash(release["recipe"])[:20]:
        raise ValueError("Disease release identity mismatch")
    required = {
        "manifest.jsonl",
        "dataset_card.json",
        "reference_registry.json",
        "split_manifest.json",
        *(f"{s}.npz" for s in SPLITS),
    }
    if not required.issubset(release["artifact_hashes"]):
        raise ValueError("Incomplete disease release manifest")
    for name, sha in release["artifact_hashes"].items():
        if digest(_safe(root, name)) != sha:
            raise ValueError(f"Disease release integrity failure: {name}")
    snapshot_path = release["recipe"].get("generator_snapshot_path")
    if (
        snapshot_path
        and release["artifact_hashes"].get(snapshot_path) != release["recipe"]["code_sha256"]
    ):
        raise ValueError("Frozen disease generator differs from its recipe source hash")
    helper_hash = release["recipe"].get("shared_dataset_helpers_sha256")
    if (
        helper_hash
        and release["artifact_hashes"].get("provenance/dataset_helpers.py") != helper_hash
    ):
        raise ValueError("Frozen disease dataset helpers differ from their recipe source hash")
    records = [json.loads(line) for line in (root / "manifest.jsonl").read_text().splitlines()]
    if len(records) != release["case_count"] or len({r["case_id"] for r in records}) != len(
        records
    ):
        raise ValueError("Disease case identity/count mismatch")
    groups: dict[str, str] = {}
    any_nc = False
    for row in records:
        if (
            row["split"] not in SPLITS
            or groups.setdefault(row["group_id"], row["split"]) != row["split"]
        ):
            raise ValueError("Patient leakage between disease splits")
        if row["split"] != release["recipe"]["split_assignments"][row["group_id"]]:
            raise ValueError("Disease split differs from frozen recipe")
        if row["license_lane"] not in ("attribution", "noncommercial_sharealike"):
            raise ValueError("Unknown source license lane")
        any_nc |= row["license_lane"] == "noncommercial_sharealike"
        for name in (
            row["geometry_path"],
            row["points_path"],
            row["measurements_path"],
            *row["mesh_paths"].values(),
            *(m["path"] for m in row["source_masks"]),
        ):
            if name not in release["artifact_hashes"]:
                raise ValueError("Unhashed case dependency")
        for mask in row["source_masks"]:
            if mask["sha256"] != release["artifact_hashes"][mask["path"]]:
                raise ValueError("Source mask checksum differs from source-case provenance")
    if (
        any_nc != release["rights"]["contains_noncommercial"]
        or any_nc != release["recipe"]["allow_noncommercial"]
    ):
        raise ValueError("Disease license lane differs from release rights")
    seen: set[str] = set()
    for split in SPLITS:
        data = read_split(root, split, verify=False)
        expected = [r for r in records if r["split"] == split]
        if data["case_ids"].tolist() != [r["case_id"] for r in expected]:
            raise ValueError("Disease split tensors differ from source manifest")
        if list(data["feature_names"]) != list(FEATURE_NAMES):
            raise ValueError("Disease feature schema mismatch")
        n, count = len(expected), release["recipe"]["point_count"]
        for key in (
            "organ_points_mm",
            "lesion_points_mm",
            "organ_normals",
            "lesion_normals",
            "organ_points",
            "lesion_points",
        ):
            if data[key].shape != (n, count, 3) or not np.isfinite(data[key]).all():
                raise ValueError(f"Invalid disease tensor: {key}")
        if (
            data["features"].shape != (n, len(FEATURE_NAMES))
            or not np.isfinite(data["features"]).all()
        ):
            raise ValueError("Invalid measured disease features")
        if not np.array_equal(
            data["features"], np.asarray([r["features"] for r in expected], dtype=np.float32)
        ):
            raise ValueError("Disease features differ from measured source manifest")
        if data["feature_mask"].shape != (n, len(FEATURE_NAMES)) or not data["feature_mask"].all():
            raise ValueError("Disease feature validity mask differs from measured source manifest")
        if (
            data["center_mm"].shape != (n, 3)
            or data["scale_mm"].shape != (n,)
            or not np.isfinite(data["center_mm"]).all()
            or not np.isfinite(data["scale_mm"]).all()
            or np.any(data["scale_mm"] <= 0)
        ):
            raise ValueError("Invalid common organ/lesion normalization frame")
        for role in ("organ", "lesion"):
            restored = (
                data[role + "_points"] * data["scale_mm"][:, None, None]
                + data["center_mm"][:, None, :]
            )
            if not np.allclose(restored, data[role + "_points_mm"], atol=0.0001, rtol=0):
                raise ValueError("Organ and lesion point clouds lost their shared physical frame")
            if not np.allclose(np.linalg.norm(data[role + "_normals"], axis=2), 1, atol=1e-5):
                raise ValueError("Invalid surface normal in disease point cloud")
        for key, record_key in (
            ("group_ids", "group_id"),
            ("source_ids", "source_id"),
            ("organ_names", "organ"),
            ("disease_codes", "disease_code"),
            ("license_lanes", "license_lane"),
        ):
            if data[key].tolist() != [r[record_key] for r in expected]:
                raise ValueError(f"Disease metadata mismatch: {key}")
        if seen.intersection(data["group_ids"].tolist()):
            raise ValueError("Patient leakage in tensor split")
        seen.update(data["group_ids"].tolist())
    return release


def read_split(root: str | Path, split: str, *, verify: bool = True) -> dict[str, np.ndarray]:
    if split not in SPLITS:
        raise ValueError(f"Unknown disease split: {split}")
    root = Path(root).resolve()
    if verify:
        verify_release(root)
    with np.load(_safe(root, f"{split}.npz"), allow_pickle=False) as arrays:
        return {name: arrays[name] for name in arrays.files}


def load_case(
    root: str | Path, case_id: str, *, verify: bool = True
) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    root = Path(root).resolve()
    if verify:
        verify_release(root)
    records = [json.loads(line) for line in _safe(root, "manifest.jsonl").read_text().splitlines()]
    row = next((r for r in records if r["case_id"] == case_id), None)
    if row is None:
        raise ValueError(f"Unknown disease case: {case_id}")
    with np.load(_safe(root, row["geometry_path"]), allow_pickle=False) as arrays:
        return row, {name: arrays[name] for name in arrays.files}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--gallery", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--allow-noncommercial", action="store_true")
    build.add_argument("--point-count", type=int, default=2048)
    build.add_argument("--seed", type=int, default=20261007)
    check = commands.add_parser("verify")
    check.add_argument("release", type=Path)
    args = parser.parse_args()
    result = (
        create_dataset(
            args.gallery,
            args.output,
            allow_noncommercial=args.allow_noncommercial,
            point_count=args.point_count,
            seed=args.seed,
        )
        if args.command == "build"
        else verify_release(args.release)
    )
    print(
        json.dumps(
            {
                key: result[key]
                for key in ("dataset_version", "release_id", "case_count", "split_counts", "rights")
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
