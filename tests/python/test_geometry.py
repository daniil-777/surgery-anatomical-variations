"""Tests for geometric correctness; these do not certify anatomical realism."""

import json
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError
from viscera_core.dataset import create_dataset
from viscera_core.geometry import (
    DEFAULT_PARAMETERS,
    PARAMETER_BOUNDS,
    PARAMETER_KEYS,
    canonical_hash,
    create_simulation_proxy,
    generate_scene,
    mesh_metrics,
    parameter_vector,
    parameters_from_vector,
    sample_parameters,
    scene_clearance,
)
from viscera_core.schema import SceneRequest


def test_closed_oriented_surfaces_dimensions_and_measured_lumen():
    scene = generate_scene({}, "low", include_simulation=False)
    assert scene["qa"]["passed"]
    for organ in scene["organs"]:
        metrics = mesh_metrics(organ["positions"], organ["indices"])
        assert metrics["watertight"] and metrics["euler_characteristic"] == 2
        assert metrics["signed_volume_ml"] > 0 and metrics["degenerate_triangle_count"] == 0
        normals = np.asarray(organ["normals"]).reshape(-1, 3)
        assert np.max(np.abs(np.linalg.norm(normals, axis=1) - 1)) < 2e-6
    assert scene["measurements"]["liver_width_mm"] == pytest.approx(
        DEFAULT_PARAMETERS["liver_width_mm"]
    )
    gb = scene["organs"][1]
    inner = mesh_metrics(gb["lumen"]["positions"], gb["lumen"]["indices"])
    assert inner["signed_volume_ml"] < 0
    assert inner["volume_ml"] < gb["metadata"]["metrics"]["volume_ml"]
    assert inner["volume_ml"] == pytest.approx(
        gb["metadata"]["metrics"]["lumen_volume_ml"], abs=1e-5
    )


def test_contact_audit_uses_meshes_and_rejects_omitted_collision_pair():
    scene = generate_scene({}, "low", include_simulation=False)
    assert scene_clearance(scene)["minimum_vertical_clearance_mm"] == pytest.approx(0.8, abs=3e-6)
    # There is no solver pair list: move GB into liver and demand independent fail.
    moved = np.asarray(scene["organs"][1]["positions"]).reshape(-1, 3)
    moved[:, 2] += 12
    scene["organs"][1]["positions"] = moved.reshape(-1).tolist()
    assert not scene_clearance(scene)["passed"]


@pytest.mark.parametrize("key", PARAMETER_KEYS)
@pytest.mark.parametrize("which", [0, 1])
def test_control_boundaries_preserve_valid_surface_and_clearance(key, which):
    params = {**DEFAULT_PARAMETERS, key: PARAMETER_BOUNDS[key][which]}
    scene = generate_scene({"parameters": params}, "low", include_simulation=False)
    assert scene["qa"]["passed"]
    assert scene_clearance(scene)["passed"]
    proxy = create_simulation_proxy(params)
    assert min(proxy["rest_volumes_mm3"]) > 0


def test_simulation_embedding_positive_mass_and_affine_objectivity():
    scene = generate_scene({}, "low")
    proxy = scene["simulation"]
    p = np.asarray(proxy["positions_mm"]).reshape(-1, 3)
    tets = np.asarray(proxy["tets"]).reshape(-1, 4)
    embedding = proxy["embedding"]
    tet_index = np.asarray(embedding["tet_indices"])
    weights = np.asarray(embedding["weights"]).reshape(-1, 4)
    residual = np.asarray(embedding["rest_residuals_mm"]).reshape(-1, 3)
    vertices = np.asarray(scene["organs"][0]["positions"]).reshape(-1, 3)
    assert np.min(weights) > -1e-9
    assert np.allclose(weights.sum(axis=1), 1)
    reconstructed = np.einsum("ij,ijk->ik", weights, p[tets[tet_index]]) + residual
    assert np.max(np.linalg.norm(reconstructed - vertices, axis=1)) < 1e-6
    # An affine deformation must transform the residual as well as tet nodes.
    affine = np.array([[1.1, 0.05, 0], [0, 0.9, 0.1], [0.03, 0, 1.05]])
    translation = np.array([12, -7, 3])
    deformed = (
        np.einsum("ij,ijk->ik", weights, (p @ affine.T + translation)[tets[tet_index]])
        + residual @ affine.T
    )
    assert np.allclose(deformed, vertices @ affine.T + translation, atol=1e-6)
    assert np.all(np.asarray(proxy["masses_kg"]) > 0)
    assert sum(proxy["masses_kg"]) == pytest.approx(
        proxy["volume_ml"] * 1e-6 * proxy["density_kg_m3"]
    )


def test_nontrivial_semantic_controls_and_determinism():
    original = generate_scene({}, "low", include_simulation=False)
    repeat = generate_scene({}, "low", include_simulation=False)
    assert original["content_hash"] == repeat["content_hash"]
    modified = generate_scene(
        {"parameters": {"fissure_depth_mm": 12, "left_lobe_ratio": 0.3}},
        "low",
        include_simulation=False,
    )
    a = np.asarray(original["organs"][0]["positions"]).reshape(-1, 3)
    b = np.asarray(modified["organs"][0]["positions"]).reshape(-1, 3)
    assert np.max(np.linalg.norm(a - b, axis=1)) > 8
    assert len(original["organs"][0]["landmarks"]) >= 12
    assert original["organs"][0]["semantic_regions"]["teres_notch"]
    assert original["metadata"]["review_status"] == "unreviewed"
    unhashed = {k: v for k, v in original.items() if k != "content_hash"}
    assert canonical_hash(unhashed) == original["content_hash"]


def test_strict_spec_and_parameter_order():
    with pytest.raises(ValidationError):
        SceneRequest.model_validate({"parameters": {"liver_width_mm": -10}})
    with pytest.raises(ValidationError):
        SceneRequest.model_validate({"parameters": {"invented_anatomy": 5}})
    with pytest.raises(ValidationError):
        SceneRequest.model_validate({"seed": 1.2})
    with pytest.raises(ValidationError):
        SceneRequest.model_validate({"parameters": {"fissure_depth_mm": float("nan")}})
    params = sample_parameters(42)
    assert np.allclose(
        parameter_vector(parameters_from_vector(parameter_vector(params))), parameter_vector(params)
    )


def test_dataset_replay_and_explicit_single_lineage_holdout_limits(tmp_path: Path):
    first = create_dataset(tmp_path / "a", 3, seed=4, resolution="low")
    second = create_dataset(tmp_path / "b", 3, seed=4, resolution="low")
    assert first["artifact_hashes"] == second["artifact_hashes"]
    assert first["independent_anatomy_holdout"] == "unavailable_single_recipe"
    seen = set()
    for split in ("train", "val", "test"):
        with np.load(tmp_path / "a" / f"{split}.npz", allow_pickle=False) as data:
            current = set(data["sample_ids"].tolist())
            assert not seen.intersection(current)
            assert data["parameters"].shape[1] == len(PARAMETER_KEYS)
            seen.update(current)
    records = [
        json.loads(line) for line in (tmp_path / "a" / "manifest.jsonl").read_text().splitlines()
    ]
    assert {r["sample_id"] for r in records} == seen
    assert {r["lineage_id"] for r in records} == {records[0]["lineage_id"]}


def test_mesh_negative_fixtures_detect_hole_bad_index_and_reversal():
    scene = generate_scene({}, "low", include_simulation=False)
    organ = scene["organs"][0]
    faces = np.asarray(organ["indices"]).reshape(-1, 3)
    assert not mesh_metrics(organ["positions"], faces[:-1])["watertight"]
    assert mesh_metrics(organ["positions"], faces[:, [0, 2, 1]])["signed_volume_ml"] < 0
    with pytest.raises(ValueError):
        mesh_metrics(organ["positions"], [[0, 1, 10**9]])


def test_versioned_sampler_preserves_legacy_release_and_bounds_interactive_volume():
    fixture = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "assets/fixtures/broad-control-v0-seed-20261006.json"
        ).read_text()
    )
    assert sample_parameters(fixture["seed"], profile="broad_control_v0") == fixture["parameters"]
    # This particular raw adult-design proposal is oversized; interactive sampling
    # must reject it, not clamp its dimensions or relabel the generated volume.
    seed = 22250857
    raw = sample_parameters(seed, profile="adult_design_v1", enforce_volume_band=False)
    accepted = sample_parameters(seed, profile="adult_design_v1")
    assert raw != accepted
    scene = generate_scene(
        {"parameters": accepted, "include_vessels": False}, "medium", include_simulation=False
    )
    assert 1200 <= scene["measurements"]["liver_volume_ml"] <= 2600
    assert accepted == sample_parameters(seed, profile="adult_design_v1")


def test_adult_dataset_keeps_raw_rejections_and_measured_design_band(tmp_path: Path):
    release = create_dataset(
        tmp_path / "adult", 4, seed=22250857, resolution="medium", sampler_profile="adult_design_v1"
    )
    assert release["accepted"] == 4
    assert release["rejected"] >= 1
    assert release["attempted"] == release["accepted"] + release["rejected"]
    assert release["completion_status"] == "complete"
    records = [
        json.loads(line)
        for line in (tmp_path / "adult" / "manifest.jsonl").read_text().splitlines()
    ]
    rejected = [row for row in records if row["status"] == "rejected"]
    accepted = [row for row in records if row["status"] != "rejected"]
    assert rejected[0]["rejection_reason"] == "AUTHORING_VOLUME_BAND"
    assert rejected[0]["measurements"]["liver_volume_ml"] > 2600
    assert all(1200 <= row["measurements"]["liver_volume_ml"] <= 2600 for row in accepted)
    assert all(row["sampler_profile"] == "adult_design_v1" for row in records)
