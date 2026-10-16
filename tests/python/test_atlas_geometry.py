"""Evidence for the atlas deformer, import boundary and honest display-surface QA."""

from __future__ import annotations

import hashlib
import itertools
import json
from pathlib import Path

import numpy as np
import pytest
import trimesh
from viscera_core.atlas import (
    CONTROL_LIMITS,
    CONTROL_NAMES,
    DEFORMER_VERSION,
    AtlasTemplate,
    _geometry_hash,
    _ingest_one,
    deform_vertices,
    generate,
    jacobian_determinants,
    load_template,
)


def fixture_template() -> AtlasTemplate:
    mesh = trimesh.creation.icosphere(subdivisions=2, radius=30)
    v, f = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    return AtlasTemplate(
        v,
        f,
        np.ones_like(v) * 0.5,
        np.zeros(len(v), dtype=np.int64),
        {
            "template_id": "fixture",
            "control_limits": list(CONTROL_LIMITS["liver"]),
            "normalization_mm": 30,
            "geometry_sha256": _geometry_hash(v, f),
            "coordinate_frame": "fixture-Y-up",
            "topology_audit": {"fixture_only": True},
        },
    )


def test_identity_is_exact_and_does_not_mutate_template() -> None:
    template = fixture_template()
    before = template.vertices_mm.copy()
    result = generate(template, {}, seed=12)
    np.testing.assert_array_equal(result.vertices_mm, before)
    np.testing.assert_array_equal(template.vertices_mm, before)
    assert result.faces is template.faces
    assert result.qa["passed"]
    assert result.qa["min_jacobian"] == 1
    assert result.metadata["deformer_version"] == DEFORMER_VERSION
    assert result.measurements["volume_ml"] is None
    assert result.measurements["compactness"] is None
    assert result.qa["self_intersection"]["status"] == "NOT_RUN"
    assert result.qa["mechanical_validation"]["status"] == "NOT_RUN"
    assert not result.vertices_mm.flags.writeable


def test_all_control_box_corners_are_invertible_and_preserve_surface() -> None:
    template = fixture_template()
    for corner in itertools.product((-1.0, 1.0), repeat=7):
        sample = generate(template, corner)
        assert sample.qa["passed"], (corner, sample.qa)
        recovered = deform_vertices(
            sample.vertices_mm, corner, CONTROL_LIMITS["liver"], 30, inverse=True
        )
        np.testing.assert_allclose(recovered, template.vertices_mm, atol=3e-14, rtol=1e-14)
        np.testing.assert_array_equal(sample.faces, template.faces)


def test_analytic_jacobian_matches_independent_finite_difference() -> None:
    points = np.random.default_rng(91).uniform(-100, 100, (80, 3))
    controls = np.array([0.9, -0.8, 0.4, 0.7, -0.6, 0.85, -0.95])
    h = 1e-4
    columns = []
    for dimension in range(3):
        offset = np.eye(3)[dimension] * h
        columns.append(
            (
                deform_vertices(points + offset, controls, CONTROL_LIMITS["liver"], 35)
                - deform_vertices(points - offset, controls, CONTROL_LIMITS["liver"], 35)
            )
            / (2 * h)
        )
    numerical = np.linalg.det(np.stack(columns, axis=2))
    analytical = jacobian_determinants(points, controls, CONTROL_LIMITS["liver"], 35)
    np.testing.assert_allclose(analytical, numerical, rtol=1e-8, atol=1e-8)
    assert (analytical > 0).all()


def test_units_scaling_commutes_with_deformation() -> None:
    template = fixture_template()
    c = [0.6, -0.2, 0.4, -0.8, 0.9, 0.3, -0.7]
    in_mm = deform_vertices(template.vertices_mm, c, CONTROL_LIMITS["liver"], 30)
    in_m = deform_vertices(template.vertices_mm / 1000, c, CONTROL_LIMITS["liver"], 0.03)
    np.testing.assert_allclose(in_mm / 1000, in_m, atol=1e-16)


@pytest.mark.parametrize(
    "controls",
    [[0] * 6, [0] * 8, [2] * 7, [float("nan")] * 7, [float("inf")] * 7, {"unknown": 0.2}],
)
def test_invalid_controls_are_rejected(controls: object) -> None:
    with pytest.raises((ValueError, TypeError)):
        generate(fixture_template(), controls)  # type: ignore[arg-type]


def test_seed_is_lineage_only_and_controls_actually_change_geometry() -> None:
    template = fixture_template()
    a = generate(template, {"bend": 0.8}, 2)
    b = generate(template, {"bend": 0.8}, 5)
    np.testing.assert_array_equal(a.vertices_mm, b.vertices_mm)
    assert not np.array_equal(a.vertices_mm, template.vertices_mm)
    assert a.metadata["seed"] != b.metadata["seed"]
    for name in CONTROL_NAMES:
        sample = generate(template, {name: 0.8})
        assert np.linalg.norm(sample.vertices_mm - template.vertices_mm) > 0.1


def test_ingest_selects_components_applies_scene_transform_and_guards_hash(tmp_path: Path) -> None:
    scene = trimesh.Scene()
    transform = trimesh.transformations.translation_matrix([0.5, 0.7, 0.3])
    scene.add_geometry(
        trimesh.creation.box(extents=[0.20, 0.10, 0.05]),
        node_name="liver_capsule",
        geom_name="capsule",
        transform=transform,
    )
    scene.add_geometry(
        trimesh.creation.box(extents=[0.19, 0.09, 0.04]),
        node_name="right_lobe_overlay",
        geom_name="overlay",
        transform=transform,
    )
    source = tmp_path / "source.glb"
    source.write_bytes(scene.export(file_type="glb"))
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    meta = {
        "template_id": "fixture-liver",
        "organ": "liver",
        "source_sha256": source_hash,
        "source_collection": "HRA",
        "sex_label": "unknown",
        "laterality": None,
        "source_group_id": "fixture",
        "source_url": "fixture",
        "license": "fixture",
        "source_to_authoring_rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    }
    _ingest_one(tmp_path, source, meta, 1000)
    template = load_template(tmp_path, "fixture-liver")
    np.testing.assert_allclose(np.ptp(template.vertices_mm, axis=0), [200, 100, 50], atol=1e-5)
    np.testing.assert_allclose(template.metadata["source_center_mm"], [500, 700, 300], atol=1e-5)
    assert template.metadata["excluded_source_nodes"] == ["right_lobe_overlay"]
    assert len(template.metadata["components"]) == 1
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    assert not template.faces.flags.writeable
    meta_path = tmp_path / "fixture-liver.json"
    pristine_meta = meta_path.read_bytes()
    (tmp_path / "catalog.json").write_text(
        json.dumps(
            {
                "templates": [
                    {
                        "template_id": "fixture-liver",
                        "metadata_sha256": hashlib.sha256(pristine_meta).hexdigest(),
                    }
                ]
            }
        )
    )
    altered = json.loads(pristine_meta)
    altered["control_limits"][0] *= 2
    meta_path.write_text(json.dumps(altered))
    with pytest.raises(ValueError, match="metadata integrity"):
        load_template(tmp_path, "fixture-liver")
    meta_path.write_bytes(pristine_meta)
    archive = tmp_path / "fixture-liver.npz"
    archive.write_bytes(archive.read_bytes()[:-3] + b"bad")
    with pytest.raises(ValueError, match="integrity"):
        load_template(tmp_path, "fixture-liver")


def test_bodyparts_axis_rotation_has_exact_recorded_inverse(tmp_path: Path) -> None:
    source = tmp_path / "source.obj"
    mesh = trimesh.creation.box(extents=[40, 60, 100])
    mesh.apply_translation([30, 20, 1200])
    source.write_text(mesh.export(file_type="obj"))
    meta = {
        "template_id": "fixture-stomach",
        "organ": "stomach",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "source_collection": "BodyParts3D",
        "sex_label": "unknown",
        "laterality": None,
        "source_group_id": "fixture",
        "source_url": "fixture",
        "license": "fixture",
        "source_to_authoring_rotation": [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
    }
    _ingest_one(tmp_path, source, meta, 1)
    template = load_template(tmp_path, "fixture-stomach")
    np.testing.assert_allclose(np.ptp(template.vertices_mm, axis=0), [40, 100, 60])
    recovered = (template.vertices_mm + template.metadata["source_center_mm"]) @ np.asarray(
        template.metadata["source_to_authoring_rotation"]
    )
    np.testing.assert_allclose(recovered, mesh.vertices)
    assert template.metadata["coordinate_frame"] == "atlas-display-Y-up-centered-mm-not-RAS"


def test_invalid_template_path_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Invalid template ID"):
        load_template(tmp_path, "../../outside")


def test_portable_catalog_has_real_source_diversity_without_population_claim() -> None:
    root = Path(__file__).resolve().parents[2] / "datasets/atlas/cohort-v2/templates"
    if not (root / "catalog.json").exists():
        root = root.with_name("templates-v2")
    if not (root / "catalog.json").exists():
        pytest.skip("Downloaded atlas artifacts are optional, not fetched during unit tests")
    catalog = json.loads((root / "catalog.json").read_text())
    assert len(catalog["templates"]) == 24
    assert len({r["organ"] for r in catalog["templates"]}) == 12
    assert len({r["source_group_id"] for r in catalog["templates"]}) == 4
    assert all(r["license"] == "CC-BY-4.0" for r in catalog["templates"])


def test_degenerate_cleanup_and_winding_repair_have_reversible_face_maps(tmp_path: Path) -> None:
    original = trimesh.creation.box(extents=[100, 80, 60])
    damaged_faces = original.faces.copy()
    damaged_faces[3] = damaged_faces[3, ::-1]
    damaged_faces = np.vstack([damaged_faces, [0, 0, 1]])
    scene = trimesh.Scene()
    scene.add_geometry(
        trimesh.Trimesh(vertices=original.vertices, faces=damaged_faces, process=False),
        node_name="liver_capsule",
    )
    source = tmp_path / "damaged.glb"
    source.write_bytes(scene.export(file_type="glb"))
    meta = {
        "template_id": "damaged-fixture",
        "organ": "liver",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "source_collection": "HRA",
        "sex_label": "unknown",
        "laterality": None,
        "source_group_id": "fixture",
        "source_url": "fixture",
        "license": "fixture",
        "source_to_authoring_rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    }
    _ingest_one(tmp_path, source, meta, 1)
    template = load_template(tmp_path, "damaged-fixture")
    assert template.metadata["removed_degenerate_faces"] == 1
    assert template.metadata["reversed_faces"] == 1
    assert template.metadata["topology_audit"]["winding_consistent_after_audit_weld"]
    assert template.metadata["topology_audit"]["degenerate_faces"] == 0
    assert template.metadata["cohort_eligible"]
    np.testing.assert_array_equal(template.vertices_mm, original.vertices)
    np.testing.assert_array_equal(template.faces, original.faces)
    with np.load(tmp_path / "damaged-fixture.npz") as archive:
        source_faces = archive["source_faces"]
        inverse = archive["source_to_clean_face_indices"]
        forward = archive["clean_to_source_face_indices"]
        flip = archive["clean_face_orientation_reversed"]
        restored = template.faces.copy()
        restored[flip] = restored[flip, ::-1]
        np.testing.assert_array_equal(source_faces[forward], restored)
        np.testing.assert_array_equal(inverse[forward], np.arange(len(forward)))
        assert inverse[-1] == -1
