"""Failure-oriented contract tests for the independent atlas learning workflow."""

import json
from dataclasses import replace

import numpy as np
import pytest
import torch

from pipelines.train.viscera_train import atlas_shape as atlas


def conditions(x, organ):
    values = np.array(
        [
            100 + 12 * x[0],
            90 + 9 * x[1],
            60 + 6 * x[2],
            1000 + 80 * (x[0] + x[1]),
            50 + 5 * (x[0] + x[1] + x[2]),
            0.6 + 0.03 * x[3],
        ]
    )
    mask = np.array([True] * 5 + [organ == 0])
    values[~mask] = np.nan
    return values, mask


def fixture(root):
    root.mkdir()
    rng = np.random.default_rng(112)
    for split, n in (("train", 24), ("val", 6), ("audit", 5)):
        rows = []
        for template, organ in (("liver-f", 0), ("liver-m", 0), ("kidney-l", 1)):
            for i in range(n):
                x = rng.uniform(-0.8, 0.8, 7)
                c, m = conditions(x, organ)
                rows.append((x, c, m, template, organ, f"{split}-{template}-{i}"))
        np.savez(
            root / f"{split}.npz",
            controls=np.array([r[0] for r in rows]),
            conditions=np.array([r[1] for r in rows]),
            condition_mask=np.array([r[2] for r in rows]),
            template_ids=np.array([r[3] for r in rows]),
            organ_ids=np.array([r[4] for r in rows]),
            sample_ids=np.array([r[5] for r in rows]),
            group_ids=np.array([r[5] for r in rows]),
            organ_names=np.array(["liver", "kidney"]),
            control_names=np.array(atlas.CONTROL_NAMES),
            condition_names=np.array(
                ["x_mm", "y_mm", "z_mm", "area_mm2", "volume_ml", "compactness"]
            ),
        )
    refresh(root)


def refresh(root):
    (root / "release.json").write_text(
        json.dumps(
            {
                "artifact_hashes": {
                    f"{s}.npz": atlas.digest(root / f"{s}.npz") for s in ("train", "val", "audit")
                }
            }
        )
    )


@pytest.fixture
def data(tmp_path):
    root = tmp_path / "dataset"
    fixture(root)
    return root


@pytest.fixture
def trained(data, tmp_path):
    out = tmp_path / "run"
    atlas.train(
        data,
        out,
        atlas.TrainConfig(steps=4, batch_size=12, hidden=16, checkpoint_every=2),
    )
    return atlas.load_model(out / "model.pt"), out


def test_resume_bit_exact_and_audit_is_never_opened(data, tmp_path):
    # Deliberately corrupted, still sealed. Training may not inspect it even to hash.
    (data / "audit.npz").write_bytes(b"audit sealed until model freeze")
    cfg = atlas.TrainConfig(steps=9, batch_size=11, hidden=16, checkpoint_every=4)
    full, resumed = tmp_path / "full", tmp_path / "resumed"
    atlas.train(data, full, cfg)
    assert atlas.train(data, resumed, cfg, stop_after=3)["status"] == "interrupted"
    atlas.train(data, resumed, cfg, resume=True)
    a, b = (
        atlas.safe_load(full / "checkpoint.pt"),
        atlas.safe_load(resumed / "checkpoint.pt"),
    )
    assert a["losses"] == b["losses"]
    assert a["history"] == b["history"]
    assert a["numpy_rng_json"] == b["numpy_rng_json"]
    for key in a["model_state"]:
        assert torch.equal(a["model_state"][key], b["model_state"][key]), key
    assert atlas.load_model(full / "model.pt")["promotion"]["audit_accessed"] is False
    with pytest.raises(ValueError, match="config"):
        atlas.train(data, resumed, replace(cfg, lr=0.2), resume=True)


def test_missing_labels_do_not_become_zero_and_stats_are_train_only(data):
    train = atlas.read_split(data, "train")
    p = atlas.fit_preprocessing(train)
    kidney = p["templates"].index("kidney-l")
    assert p["condition_available"][kidney][-1] is False
    _, z, m = atlas.encode_conditions(
        p, train["template_ids"], train["conditions"], train["condition_mask"]
    )
    assert np.isfinite(z).all()
    assert np.all(m[train["organ_ids"] == 1, -1] == 0)
    val = atlas.read_split(data, "val")
    val["conditions"] *= 100000
    np.savez(data / "val.npz", **val)
    refresh(data)
    assert atlas.fit_preprocessing(atlas.read_split(data, "train")) == p
    train["conditions"][0, 0] = np.nan
    with pytest.raises(ValueError, match="Observed"):
        atlas.validate_data(train)


@pytest.mark.parametrize("field", ["sample_ids", "group_ids"])
def test_derivative_leakage_fails(data, field):
    a, b = atlas.read_split(data, "train"), atlas.read_split(data, "val")
    b[field] = b[field].astype("U100")
    b[field][0] = a[field][0]
    with pytest.raises(ValueError, match="leakage"):
        atlas.audit_splits(a, b)


def test_reassigned_and_unseen_templates_fail(data):
    a, b = atlas.read_split(data, "train"), atlas.read_split(data, "val")
    b["organ_ids"][b["template_ids"] == "liver-f"] = 1
    with pytest.raises(ValueError, match="reassigned"):
        atlas.audit_splits(a, b)
    b["template_ids"] = np.full(len(b["controls"]), "new-patient")
    with pytest.raises(ValueError, match="Unknown"):
        atlas.audit_splits(a, b)


def test_sampling_is_bounded_reproducible_template_specific_and_varied(trained):
    model, _ = trained
    a = atlas.sample_controls(model, "liver-f", {"x_mm": 102}, count=64, seed=12, method="ridge")
    b = atlas.sample_controls(model, "liver-f", {"x_mm": 102}, count=64, seed=12, method="ridge")
    np.testing.assert_array_equal(a, b)
    assert np.all(np.abs(a) <= 1)
    assert a[:, 3:].std(0).min() > 0.1
    assert np.abs(a[:, 0].mean() - 2 / 12) < 0.08
    unconditional = atlas.sample_controls(model, "kidney-l", count=64)
    rows = atlas._train_data(model)
    support = rows["controls"][rows["template_ids"] == "kidney-l"]
    assert all(np.any(np.all(support == x, axis=1)) for x in unconditional)
    with pytest.raises(ValueError, match="Unsupported"):
        atlas.sample_controls(model, "brain-never-seen")
    with pytest.raises(ValueError, match="no observed"):
        atlas.sample_controls(model, "kidney-l", {"compactness": 0.5})
    with pytest.raises(ValueError, match="Unknown condition"):
        atlas.sample_controls(model, "liver-f", {"made_up": 8})


def test_decoded_metrics_use_actual_callback_and_frozen_audit(data, trained):
    model, out = trained
    calls = []

    def decoder(template, controls):
        calls.append(template)
        return conditions(controls, 1 if template.startswith("kidney") else 0)

    report = atlas.evaluate(data, out / "model.pt", "audit", decoder)
    assert len(calls) == 15
    assert report["model_frozen"] is True
    assert report["decoded_geometry"]["status"] == "MEASURED"
    assert report["decoded_geometry"]["conditions"]["compactness"]["observed_rows"] == 10
    assert report["decoded_geometry"]["conditions"]["x_mm"]["mae_original_units"] < 3
    assert report["model_sha256"] == atlas.digest(out / "model.pt")
    assert model["selected_method"] != "mlp"  # Deliberately undertrained model cannot self-promote.


def test_organ_balancing_does_not_overweight_two_liver_templates(data):
    train = atlas.read_split(data, "train")
    indices = atlas.balanced_indices(train, np.random.default_rng(0), 3000)
    assert abs(np.mean(train["organ_ids"][indices] == 1) - 0.5) < 0.04


def test_corruption_and_finite_state_validation(trained):
    model, out = trained
    first = next(iter(model["model_state"]))
    model["model_state"][first].flatten()[0] = float("nan")
    atlas.atomic_torch(out / "bad.pt", model)
    with pytest.raises(ValueError, match="non-finite"):
        atlas.load_model(out / "bad.pt")
    (out / "model.pt").write_bytes((out / "model.pt").read_bytes() + b"corrupt")
    with pytest.raises(ValueError, match="checksum"):
        atlas.load_model(out / "model.pt")


def test_schema_masks_and_bounds_fail_closed(data):
    train = atlas.read_split(data, "train")
    train["condition_mask"] = train["condition_mask"].astype(np.int64)
    with pytest.raises(ValueError, match="boolean"):
        atlas.validate_data(train)
    train = atlas.read_split(data, "train")
    train["controls"][0, 0] = 1.01
    with pytest.raises(ValueError, match="bounded"):
        atlas.validate_data(train)


def test_real_decoder_refinement_meets_targets_and_reports_infeasible(trained):
    model, _ = trained

    def decoder(template, x):
        return conditions(x, 0)

    refined = atlas.refine_controls(
        model, "liver-f", np.zeros(7), {"x_mm": 107.2, "z_mm": 57.0}, decoder
    )
    assert refined["status"] == "matched"
    assert np.abs(refined["controls"]).max() <= 1
    assert refined["measurements"]["x_mm"]["absolute_error"] < 0.1
    failed = atlas.refine_controls(model, "liver-f", np.zeros(7), {"x_mm": 200}, decoder)
    assert failed["status"] == "unmet_constraints"
    assert failed["measurements"]["x_mm"]["absolute_error"] > 80
    assert np.abs(failed["controls"]).max() <= 1


def test_partial_missing_rows_do_not_make_requested_feature_disappear(trained):
    model, _ = trained
    rows = model["training_rows"]
    # Remove one target; ridge must use remaining observed rows, not drop X entirely.
    rows["condition_mask"][0, 0] = False
    rows["conditions"][0, 0] = float("nan")
    a = atlas.sample_controls(model, "liver-f", {"x_mm": 102}, count=32, method="ridge")
    assert np.abs(a[:, 0].mean() - 2 / 12) < 0.08
    with pytest.raises(ValueError, match="exceeds training support"):
        atlas.sample_controls(model, "liver-f", {"x_mm": 10000})
