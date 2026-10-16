"""Patient leakage, artifact integrity and train/serve behavior tests."""

import json
import shutil
from pathlib import Path

import numpy as np
import pytest
from viscera_core import atlas_disease_recipe_dataset as dataset

from pipelines.train.viscera_train import atlas_disease as training


@pytest.fixture(scope="module")
def recipe_run(tmp_path_factory):
    root = tmp_path_factory.mktemp("disease-recipes")
    data, out = root / "dataset", root / "model"
    dataset.build_release(data, per_profile=(4, 2, 2), seed=119)
    report = training.train_recipe(
        data, out, training.Config(steps=35, hidden=16, latent=3, embedding=4)
    )
    return data, out, report


def test_recipe_splits_are_disjoint_and_complete(recipe_run):
    data, _, _ = recipe_run
    release = dataset.verify_release(data)
    a, b, c = (dataset.read_split(data, name) for name in ("train", "val", "audit"))
    dataset.ensure_groups(a, b)
    dataset.ensure_groups(a, c)
    dataset.ensure_groups(b, c)
    assert len(set(a["organ_names"])) == 12
    assert release["patient_count"] == 0
    assert not set(release["reference_only_profile_ids"]) & set(a["profile_ids"])
    assert release["shared_reference_lineages_across_splits"] is True


def test_recipe_derivatives_cannot_cross_splits(recipe_run):
    data, _, _ = recipe_run
    a, b = dataset.read_split(data, "train"), dataset.read_split(data, "val")
    b["group_ids"][0] = a["group_ids"][0]
    with pytest.raises(ValueError, match="leakage"):
        dataset.ensure_groups(a, b)


def test_recipe_roundtrip_preserves_count_and_location():
    recipe = {
        "profile_id": "test",
        "seed": 3,
        "severity": 0.5,
        "size": 0.3,
        "spread": 0.2,
        "irregularity": 0.6,
        "contrast": 0.4,
        "count": 8,
        "location": [-1, 0, 1],
    }
    encoded = dataset.encode_recipe(recipe)
    decoded = dataset.decode_recipe("test", encoded, 3)
    assert decoded["count"] == 8
    assert decoded["location"] == [-1, 0, 1]
    with pytest.raises(ValueError, match="count"):
        dataset.encode_recipe({**recipe, "count": 2.5})


def test_trained_model_deployment_matches_and_has_explicit_scope(recipe_run):
    _, out, report = recipe_run
    model = training.load_recipe_model(out / "model.npz")
    assert report["deployment_max_absolute_error"] <= 2e-6
    assert model["patient_count"] == 0
    assert report["audit_opened"] is False
    assert model["selected_method"] in ("conditional_vae", "empirical_bootstrap")
    assert model["requires_geometry_validation"] is True


def test_recipe_sampling_replays_seed_and_changes_spatial_realization(recipe_run):
    _, out, _ = recipe_run
    model = training.load_recipe_model(out / "model.npz")
    profile = model["profiles"][0]
    a = training.sample_recipes(model, profile, 37, count=4)
    assert a == training.sample_recipes(model, profile, 37, count=4)
    b = training.sample_recipes(model, profile, 38, count=4)
    assert a != b
    for row in a + b:
        dataset.encode_recipe(row)
        assert row["profile_id"] == profile


def test_unseen_reference_only_profile_and_invalid_values_refused(recipe_run):
    _, out, _ = recipe_run
    model = training.load_recipe_model(out / "model.npz")
    with pytest.raises(ValueError, match="not supported"):
        training.sample_recipes(model, "brain-aneurysm", 5)
    for seed in (-1, 2**32, True):
        with pytest.raises(ValueError, match="uint32"):
            training.sample_recipes(model, model["profiles"][0], seed)
    with pytest.raises(ValueError, match="count"):
        training.sample_recipes(model, model["profiles"][0], 5, count=0)


def test_recipe_checksum_tampering_refused(recipe_run, tmp_path):
    _, out, _ = recipe_run
    model, manifest = tmp_path / "model.npz", tmp_path / "model.json"
    model.write_bytes((out / "model.npz").read_bytes() + b"corruption")
    manifest.write_bytes((out / "model.json").read_bytes())
    with pytest.raises(ValueError, match="checksum"):
        training.load_recipe_model(model)


def test_audit_requires_matching_frozen_model(recipe_run, tmp_path):
    data, out, _ = recipe_run
    with pytest.raises(ValueError, match="frozen"):
        training.evaluate_recipe(data, out / "model.npz")
    freeze = tmp_path / "freeze.json"
    freeze.write_text(json.dumps({"model_sha256": "not-the-model", "tuning_closed": True}))
    with pytest.raises(ValueError, match="match"):
        training.evaluate_recipe(data, out / "model.npz", freeze=freeze)
    result = training.evaluate_recipe(data, out / "model.npz", freeze=out / "freeze.json")
    assert result["split"] == "audit"
    assert result["patient_count"] == 0


def test_model_run_is_not_overwritten(recipe_run):
    data, out, _ = recipe_run
    with pytest.raises(ValueError, match="already contains"):
        training.train_recipe(data, out)


def source_prior():
    return {
        "format": training.SOURCE_FORMAT,
        "feature_names": ["lesion_volume_ml"],
        "training_group_ids": ["patient-A"],
        "training_case_ids": ["case-A"],
        "rights": {"contains_noncommercial": False},
        "groups": [
            {
                "organ": "pancreas",
                "disease_code": "pdac",
                "patient_count": 1,
                "case_ids": ["case-A"],
                "features": [[12.0]],
                "mean_features": [12.0],
            }
        ],
    }


def test_single_patient_does_not_invent_learned_variation():
    model = source_prior()
    rows = training.sample_source_cases(model, "pancreas", "pdac", count=50, seed=11)
    assert {r["case_id"] for r in rows} == {"case-A"}
    assert {r["measured_features"]["lesion_volume_ml"] for r in rows} == {12.0}
    assert all(r["observed_training_patients"] == 1 for r in rows)
    with pytest.raises(ValueError, match="outside observed"):
        training.sample_source_cases(model, "pancreas", "pdac", conditions={"lesion_volume_ml": 13})
    with pytest.raises(ValueError, match="No training patients"):
        training.sample_source_cases(model, "liver", "cirrhosis")


def test_source_patient_leakage_rejected_and_unknown_labels_not_silently_scored():
    model = source_prior()
    data = {
        "features": np.array([[15.0]]),
        "feature_names": np.array(["lesion_volume_ml"]),
        "case_ids": np.array(["case-B"]),
        "group_ids": np.array(["patient-A"]),
        "organ_names": np.array(["pancreas"]),
        "disease_codes": np.array(["pdac"]),
    }
    with pytest.raises(ValueError, match="leakage"):
        training._evaluate_source(model, data)
    data["group_ids"] = np.array(["patient-B"])
    data["disease_codes"] = np.array(["unknown"])
    report = training._evaluate_source(model, data)
    assert report["supported_patients"] == 0
    assert len(report["unsupported_patients"]) == 1
    assert report["feature_mae"] is None


def test_source_model_license_and_checksum_gate(tmp_path):
    model = source_prior()
    model["rights"]["contains_noncommercial"] = True
    path = tmp_path / "source_model.json"
    dataset.write_json(path, model)
    dataset.write_json(Path(str(path) + ".sha256.json"), {"sha256": dataset.digest(path)})
    with pytest.raises(ValueError, match="noncommercial"):
        training.load_source_model(path)
    assert (
        training.load_source_model(path, allow_noncommercial=True)["format"]
        == training.SOURCE_FORMAT
    )
    path.write_text(path.read_text() + " ")
    with pytest.raises(ValueError, match="checksum"):
        training.load_source_model(path, allow_noncommercial=True)


def test_warm_serving_cache_still_rejects_data_corruption(recipe_run, tmp_path):
    from services.api.atlas_disease_model import sample_recipe_model

    data, out, _ = recipe_run
    copy = tmp_path / "dataset"
    shutil.copytree(data, copy)
    profile = training.load_recipe_model(out / "model.npz")["profiles"][0]
    first = sample_recipe_model(out / "model.npz", copy, profile, 8)
    assert first["model"]["patient_count"] == 0
    train_path = copy / "train.npz"
    train_path.write_bytes(train_path.read_bytes() + b"corrupt")
    with pytest.raises(ValueError, match="hash mismatch"):
        sample_recipe_model(out / "model.npz", copy, profile, 8)


def test_changed_profile_definitions_rejected(recipe_run, tmp_path, monkeypatch):
    from viscera_core import atlas_disease as renderer

    from services.api.atlas_disease_model import sample_recipe_model

    data, out, _ = recipe_run
    altered = tmp_path / "profiles.json"
    altered.write_text(renderer.PROFILE_PATH.read_text() + " ")
    monkeypatch.setattr(renderer, "PROFILE_PATH", altered)
    profile = training.load_recipe_model(out / "model.npz")["profiles"][0]
    with pytest.raises(ValueError, match="profile definitions differ"):
        sample_recipe_model(out / "model.npz", data, profile, 9)
