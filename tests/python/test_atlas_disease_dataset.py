"""Patient, coordinate, license and integrity boundaries for disease source releases."""

import json
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
import trimesh
from skimage.measure import marching_cubes
from viscera_core.atlas_disease_dataset import (
    FEATURE_NAMES,
    create_dataset,
    digest,
    load_case,
    read_split,
    verify_release,
)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def build_fixture(root: Path) -> Path:
    """Small known aligned label volumes exercise actual NIfTI + glTF ingestion."""
    (root / "models").mkdir(parents=True)
    (root / "provenance/source-labels").mkdir(parents=True)
    write_json(root / "provenance/pancreas-zenodo-record.json", {"license": "CC-BY-4.0"})
    write_json(root / "provenance/kits19-selected-clinical.json", [])
    (root / "provenance/kits19-data-LICENSE.txt").write_text("CC BY-NC-SA 4.0 fixture")
    rows = []
    ids = [
        "PDA-C3L-00622",
        "PDA-C3L-00401",
        "PDA-C3L-00395",
        "kits19_case_00000",
        "kits19_case_00008",
        "kits19_case_00017",
        "kits19_case_00019",
    ]
    rotation = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float)
    for index, case in enumerate(ids):
        kits = case.startswith("kits19")
        affine = np.array(
            [[1.25, 0, 0, -12 + index], [0, 1.5, 0, -20], [0, 0, 2.5, -30], [0, 0, 0, 1.0]]
        )
        data = np.zeros((12, 12, 12), dtype=np.uint8)
        data[2:10, 3:9, 2:8] = 1
        lesion = np.zeros_like(data)
        lesion[7:10, 5:8, 5:9] = 1
        if kits:
            data[lesion > 0] = 2
        labels = []
        parts = []
        combined = trimesh.Scene()
        for role in ("organ", "tumor"):
            raw = data if kits or role == "organ" else lesion
            label_value = 2 if kits and role == "tumor" else 1
            labelpath = f"provenance/source-labels/{case}_{'seg' if kits else role}.nii.gz"
            image = nib.Nifti1Image(raw, affine)
            if not kits:
                image.header.set_xyzt_units("mm")
            nib.save(image, root / labelpath)
            vertices, faces, *_ = marching_cubes((raw == label_value).astype(float), 0.5)
            vertices = vertices @ affine[:3, :3].T + affine[:3, 3]
            if not kits:
                vertices = vertices @ rotation.T
            mesh = trimesh.Trimesh(vertices=vertices / 1000, faces=faces)
            trimesh.repair.fix_normals(mesh)
            meshpath = f"models/{case}_{role}.glb"
            mesh.export(root / meshpath)
            combined.add_geometry(mesh, geom_name=role)
            parts.append({"role": role, "path": meshpath, "sha256": digest(root / meshpath)})
            labels.append(
                {
                    "role": role,
                    "source_file": labelpath,
                    "sha256": digest(root / labelpath),
                    "voxel_to_RAS_mm": image.affine.tolist(),
                }
            )
        combinedpath = f"models/{case}.glb"
        combined.export(root / combinedpath)
        row = {
            "id": case,
            "organ": "kidney" if kits else "pancreas",
            "status": "downloaded",
            "license": "CC BY-NC-SA 4.0 (data and derived mesh)" if kits else "CC BY 4.0",
            "license_url": "https://creativecommons.org",
            "creator": "test fixture",
            "source_url": "https://example.org/fixture",
            "ref": f"M{index}",
            "disease": "test fixture",
            "clinical_evidence": "fixture",
            "limitations": "fixture is not medical evidence",
            "local_path": combinedpath,
            "sha256": digest(root / combinedpath),
            "parts": parts,
        }
        if kits:
            row.update(
                source_label_path=labels[0]["source_file"],
                source_sha256=labels[0]["sha256"],
                coordinate_system="NIfTI RAS mm scaled to m",
            )
        else:
            row["provenance"] = {
                "source_labels": labels,
                "rotation_RAS_to_Yup": rotation.tolist(),
                "display_transform": "RAS mm to Y-up m",
            }
        rows.append(row)
    # Must never ingest viewer-only geometry or photographs as paired 3D training targets.
    rows.append({"id": "viewer-only", "status": "external viewer", "license": "CC BY 4.0"})
    photo = {
        "id": "pancreas-cancer",
        "ref": "I01",
        "organ": "pancreas",
        "disease": "cancer",
        "source_url": "https://example.org/photo",
        "creator": "fixture",
        "license": "CC BY 4.0",
        "license_url": "https://creativecommons.org",
        "sha256": "a" * 64,
        "image_kind": "gross pathology",
        "caption": "review reference",
        "morphology_targets": ["tumor extent"],
        "limitations": "not a paired image",
    }
    write_json(root / "catalog.json", {"models": rows, "images": [photo]})
    return root


@pytest.fixture(scope="module")
def fixture_gallery(tmp_path_factory):
    return build_fixture(tmp_path_factory.mktemp("source-gallery"))


@pytest.fixture()
def release(fixture_gallery, tmp_path):
    path = tmp_path / "release"
    create_dataset(fixture_gallery, path, point_count=64)
    return path


def test_license_lanes_and_source_split_stability(fixture_gallery, tmp_path):
    default = tmp_path / "ccby"
    mixed = tmp_path / "nc"
    a = create_dataset(fixture_gallery, default, point_count=64)
    b = create_dataset(fixture_gallery, mixed, allow_noncommercial=True, point_count=64)
    assert a["case_count"] == 3 and b["case_count"] == 7
    assert a["split_counts"] == {"train": 1, "val": 1, "audit": 1}
    assert b["split_counts"] == {"train": 3, "val": 2, "audit": 2}
    assert not a["rights"]["contains_noncommercial"] and b["rights"]["contains_noncommercial"]
    for group, split in a["recipe"]["split_assignments"].items():
        assert b["recipe"]["split_assignments"][group] == split
    assert not list(default.rglob("*kits19*"))
    registry = json.loads((default / "reference_registry.json").read_text())
    assert not registry["references"][0]["training_label_eligible"]
    assert registry["references"][0]["numeric_parameter_ranges"] is None
    assert not list(default.rglob("*.jpg"))


def test_canonical_coordinates_exact_masks_and_shared_normalization(release):
    row, geometry = load_case(release, "PDA-C3L-00622")
    assert row["units"] == "mm" and row["coordinate_frame"] == "RAS"
    measured = json.loads((release / row["measurements_path"]).read_text())
    assert measured["organ"]["header_spatial_units"] == "mm"
    assert measured["organ"]["half_voxel_alignment_error"] < 0.001
    assert measured["lesion"]["volume_ml"] == pytest.approx(3 * 3 * 4 * 1.25 * 1.5 * 2.5 / 1000)
    # Mesh from x voxels 1.5 to9.5, affine 1.25x-12; catches wrong rotation and metres/mm.
    assert geometry["organ_vertices_mm"][:, 0].min() == pytest.approx(1.5 * 1.25 - 12, abs=1e-5)
    with np.load(release / row["points_path"]) as points:
        assert points["feature_names"].tolist() == list(FEATURE_NAMES)
        for role in ("organ", "lesion"):
            restored = points[role + "_points"] * points["scale_mm"] + points["center_mm"]
            np.testing.assert_allclose(restored, points[role + "_points_mm"], atol=2e-5)
            np.testing.assert_allclose(
                np.linalg.norm(points[role + "_normals"], axis=1), 1, atol=1e-6
            )
    for mask in row["source_masks"]:
        assert digest(release / mask["path"]) == mask["sha256"]


def test_frozen_releases_deterministic_and_refuse_recipe_changes(
    fixture_gallery, release, tmp_path
):
    a = verify_release(release)
    b = create_dataset(fixture_gallery, tmp_path / "same", point_count=64)
    assert a == b
    assert create_dataset(fixture_gallery, release, point_count=64) == a
    with pytest.raises(ValueError, match="differs"):
        create_dataset(fixture_gallery, release, point_count=128)


def test_tampered_artifact_rejected(release):
    with (release / "train.npz").open("ab") as stream:
        stream.write(b"tampered")
    with pytest.raises(ValueError, match="integrity"):
        verify_release(release)


def test_semantic_patient_leakage_rejected_even_with_updated_artifact_hash(release):
    rows = [json.loads(line) for line in (release / "manifest.jsonl").read_text().splitlines()]
    rows[1]["group_id"] = rows[0]["group_id"]
    (release / "manifest.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
    metadata = json.loads((release / "release.json").read_text())
    metadata["artifact_hashes"]["manifest.jsonl"] = digest(release / "manifest.jsonl")
    write_json(release / "release.json", metadata)
    with pytest.raises(ValueError, match="leakage|split differs"):
        verify_release(release)


def test_semantic_license_gate_rejected(release):
    metadata = json.loads((release / "release.json").read_text())
    metadata["rights"]["contains_noncommercial"] = True
    write_json(release / "release.json", metadata)
    with pytest.raises(ValueError, match="license lane"):
        verify_release(release)


def test_symlink_dependency_rejected(release, tmp_path):
    target = tmp_path / "escaped.npz"
    (release / "train.npz").replace(target)
    (release / "train.npz").symlink_to(target)
    with pytest.raises(ValueError, match="Unsafe artifact"):
        verify_release(release)


def test_invalid_split_and_case_are_explicit(release):
    with pytest.raises(ValueError, match="Unknown disease split"):
        read_split(release, "test")
    with pytest.raises(ValueError, match="Unknown disease case"):
        load_case(release, "does-not-exist")


def test_source_mesh_shift_detected_even_when_voxel_grid_and_hash_are_valid(
    fixture_gallery, tmp_path
):
    import shutil

    source = tmp_path / "shifted"
    shutil.copytree(fixture_gallery, source)
    catalog = json.loads((source / "catalog.json").read_text())
    part = catalog["models"][0]["parts"][0]
    path = source / part["path"]
    mesh = trimesh.load(path, force="mesh")
    mesh.apply_translation(
        [0.00125, 0, 0]
    )  # One whole voxel: grid alignment alone cannot catch this.
    mesh.export(path)
    part["sha256"] = digest(path)
    write_json(source / "catalog.json", catalog)
    with pytest.raises(ValueError, match="physical bounds"):
        create_dataset(source, tmp_path / "bad-release", point_count=64)
    assert not (tmp_path / "bad-release").exists()


def test_shared_normalization_cannot_be_replaced_by_independent_lesion_frame(release):
    from viscera_core.dataset import _deterministic_npz

    arrays = read_split(release, "train")
    arrays["lesion_points"] += 0.1
    _deterministic_npz(release / "train.npz", **arrays)
    metadata = json.loads((release / "release.json").read_text())
    metadata["artifact_hashes"]["train.npz"] = digest(release / "train.npz")
    write_json(release / "release.json", metadata)
    with pytest.raises(ValueError, match="shared physical frame"):
        verify_release(release)
