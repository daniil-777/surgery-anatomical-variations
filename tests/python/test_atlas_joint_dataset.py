"""Actual paired renderer targets, anatomical anchors and split-family boundaries."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from viscera_core.atlas_disease import disease_catalog
from viscera_core.atlas_disease_scene import DiseaseAtlasSpec, realize
from viscera_core.atlas_joint import read_split, verify_release
from viscera_core.atlas_joint_dataset import SPLITS, anchors, build_release
from viscera_core.atlas_materials import MaterialRecipe, sample_material
from viscera_core.atlas_scene import get_template
from viscera_core.atlas_surface_scene import material_regions

TEMPLATE = "hra-liver-female"
TEMPLATE_ROOT = Path(__file__).resolve().parents[2] / "datasets/atlas/cohort-v2/templates"


@pytest.fixture(scope="module")
def actual_templates():
    if not (TEMPLATE_ROOT / (TEMPLATE + ".npz")).is_file():
        pytest.skip("Actual attributed atlas templates are not installed")
    return TEMPLATE_ROOT


@pytest.fixture(scope="module")
def paired_releases(tmp_path_factory, actual_templates):
    parent = tmp_path_factory.mktemp("joint-actual-renderer")
    result = {}
    for lane in ("baseline", "disease"):
        root = parent / lane
        build_release(
            actual_templates,
            root,
            lane=lane,
            count=8,
            point_count=16,
            seed=217,
            workers=1,
            template_ids=[TEMPLATE],
        )
        result[lane] = root
    return result


def records(root):
    return [json.loads(row) for row in (root / "manifest.jsonl").read_text().splitlines()]


def test_anchors_retain_all_actual_liver_components_and_source_identity(actual_templates):
    template = get_template(actual_templates, TEMPLATE)
    before = template.vertices_mm.copy()
    selected = anchors(template, count=16, seed=173)
    assert len(selected) == len(np.unique(selected)) == 16
    assert set(template.component_ids[selected]) == set(template.component_ids)
    np.testing.assert_array_equal(selected, anchors(template, count=16, seed=173))
    np.testing.assert_array_equal(template.vertices_mm, before)


@pytest.mark.parametrize("lane", ["baseline", "disease"])
def test_stored_observations_replay_actual_mesh_colour_and_roughness(
    paired_releases, actual_templates, lane
):
    root = paired_releases[lane]
    catalog = json.loads((root / "catalog.json").read_text())
    ids = np.asarray(catalog["anchor_vertex_ids"][TEMPLATE])
    template = get_template(actual_templates, TEMPLATE)
    # Replay one exact held-out recipe, including the disease's realised mesh and RGB.
    row = next(r for r in records(root) if r["split"] == "audit")
    spec = DiseaseAtlasSpec.model_validate(row["spec"])
    result = realize(actual_templates, spec)
    organ = result["scene"]["organs"][0]
    split = read_split(root, "audit")
    index = split["sample_ids"].tolist().index(row["sample_id"])
    observed = split["observations"][index]
    positions = np.asarray(organ["positions"]).reshape(-1, 3)[ids]
    np.testing.assert_allclose(
        observed[:, :3] * template.metadata["normalization_mm"], positions, rtol=1e-6, atol=1e-5
    )
    # Forward conversion proves the target channels are linear colour, not display sRGB.
    linear = observed[:, 3:6]
    srgb = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)
    np.testing.assert_allclose(
        srgb, np.asarray(organ["colors"]).reshape(-1, 3)[ids], rtol=2e-6, atol=2e-7
    )
    # Evaluate full template first, then select, to catch coordinate/anchor mismatch.
    material = sample_material(
        MaterialRecipe.model_validate(row["spec"]["material"]),
        template.vertices_mm,
        region_ids=material_regions(template),
    )
    np.testing.assert_allclose(observed[:, 6], material.roughness[ids], rtol=1e-6, atol=1e-7)
    assert result["scene"]["metadata"]["geometry_sha256"] == row["geometry_sha256"]
    assert result["spec"] == row["spec"]


def test_baseline_and_every_disease_keep_parent_families_in_one_split(paired_releases):
    baseline_rows = records(paired_releases["baseline"])
    baseline_roles = {r["group_id"]: r["split"] for r in baseline_rows}
    baseline_controls = {r["group_id"]: r["spec"]["controls"] for r in baseline_rows}
    assert len(baseline_roles) == 8
    seen_samples = set()
    for lane, root in paired_releases.items():
        split_groups = {}
        for split in SPLITS:
            split_groups[split] = set(read_split(root, split)["group_ids"])
        assert not split_groups["train"] & split_groups["val"]
        assert not split_groups["train"] & split_groups["audit"]
        assert not split_groups["val"] & split_groups["audit"]
        for row in records(root):
            assert row["group_id"] in baseline_roles
            assert row["split"] == baseline_roles[row["group_id"]]
            assert row["spec"]["controls"] == baseline_controls[row["group_id"]]
            assert row["sample_id"] not in seen_samples
            seen_samples.add(row["sample_id"])
            if lane == "baseline":
                assert row["profile_id"] == "baseline" and not row["spec"].get("disease")
            else:
                assert row["profile_id"] == row["spec"]["disease"]["profile_id"]
                assert row["spec"]["disease"]["severity"] >= 0.15 - 1e-6
    supported_liver = {
        r["id"] for r in disease_catalog()["profiles"] if r["organ"] == "liver" and r["supported"]
    }
    assert {r["profile_id"] for r in records(paired_releases["disease"])} == supported_liver


def test_both_geometry_and_colour_vary_without_claiming_measured_supervision(paired_releases):
    for root in paired_releases.values():
        data = read_split(root, "train")
        for condition in np.unique(data["condition_ids"]):
            rows = data["observations"][data["condition_ids"] == condition]
            assert np.max(np.ptp(rows[:, :, :3], axis=0)) > 1e-3
            assert np.max(np.ptp(rows[:, :, 3:6], axis=0)) > 1e-3
        card = json.loads((root / "dataset_card.json").read_text())
        assert card["independent_patient_count"] == 0
        assert "authored" in card["scope"]
        assert "shared atlases" in card["split_track"]
        assert "baseline does not certify healthy anatomy" in card["limitations"]
        assert all(r["evidence"] == "authored_paired_renderer_observations_not_patient_ground_truth" for r in records(root))


def test_modified_paired_targets_fail_release_integrity(paired_releases, tmp_path):
    import shutil

    destination = tmp_path / "modified"
    shutil.copytree(paired_releases["baseline"], destination)
    path = destination / "audit.npz"
    with np.load(path, allow_pickle=False) as source:
        arrays = {key: source[key] for key in source.files}
    arrays["observations"][0, 0, 3] = 0.0
    np.savez_compressed(path, **arrays)
    with pytest.raises(ValueError, match="checksum"):
        verify_release(destination)


def test_anchor_budget_exactly_covers_all_brain_components_and_rejects_truncation(actual_templates):
    template = get_template(actual_templates, "hra-brain-female")
    components = np.unique(template.component_ids)
    assert len(components) > 100  # Exercises the largest existing template's small components.
    selected = anchors(template, count=len(components), seed=14)
    assert len(selected) == len(components)
    assert set(template.component_ids[selected]) == set(components)
    with pytest.raises(ValueError, match="every anatomical component"):
        anchors(template, count=len(components) - 1, seed=14)


def test_existing_empty_output_builds_and_verified_rerun_preserves_release(actual_templates, tmp_path):
    output = tmp_path / "already-created-output"
    output.mkdir()
    arguments = {
        "lane": "baseline", "count": 8, "point_count": 8,
        "seed": 193, "workers": 1, "template_ids": ["bp3d-gallbladder-male"],
    }
    first = build_release(actual_templates, output, **arguments)
    original = {path.name: path.read_bytes() for path in output.iterdir() if path.is_file()}
    assert first["format"] == "viscera-joint-dataset-v1"
    assert len(read_split(output, "train")["sample_ids"]) == 6
    assert build_release(actual_templates, output, **arguments) == first
    assert original == {path.name: path.read_bytes() for path in output.iterdir() if path.is_file()}
    with pytest.raises(ValueError, match="different recipe"):
        build_release(actual_templates, output, **{**arguments, "seed": 194})
    assert original == {path.name: path.read_bytes() for path in output.iterdir() if path.is_file()}
