"""Material prior correctness without changing frozen atlas geometry artifacts."""

from __future__ import annotations

import json

import numpy as np
import pytest
import torch
from viscera_core import atlas_material_dataset as data
from viscera_core.atlas_dataset import content_hash, digest
from viscera_core.atlas_materials import make_recipe

from pipelines.train.viscera_train import atlas_material as model


@pytest.fixture
def corpus(tmp_path):
    root = tmp_path / "material-data"
    root.mkdir()
    points = np.random.default_rng(83).uniform(-40, 40, (64, 3))
    np.savez_compressed(
        root / "surface_anchors.npz",
        template_ids=np.asarray(["fixture-liver", "fixture-kidney"]),
        points_mm=np.stack([points, points]),
        normals=np.zeros((2, 64, 3)),
    )
    for split, count in [("train", 10), ("val", 3), ("audit", 3)]:
        rows = []
        for organ, preset in [("liver", "balanced"), ("kidney", "soft")]:
            rng = np.random.default_rng(sum(map(ord, split + organ)))
            for i in range(count):
                controls = np.clip(
                    data.recipe_controls(make_recipe(organ, preset, 1)) + rng.normal(0, 0.15, 6),
                    -0.95,
                    0.95,
                )
                seed = int(rng.integers(0, 2**32))
                summary, fields = data.evaluate_controls(organ, preset, seed, controls, points)
                rows.append(
                    dict(
                        controls=controls,
                        conditions=summary,
                        field_values=fields.astype(np.float32),
                        sample_ids=f"{split}-{organ}-{i}",
                        group_ids=f"{split}-{organ}-{i}",
                        organ_names=organ,
                        presets=preset,
                        template_ids=f"fixture-{organ}",
                        seeds=seed,
                    )
                )
        arrays = {key: np.asarray([r[key] for r in rows]) for key in rows[0]}
        np.savez_compressed(
            root / f"{split}.npz",
            **arrays,
            control_names=np.asarray(data.CONTROL_NAMES),
            condition_names=np.asarray(data.CONDITION_NAMES),
            field_names=np.asarray(data.FIELD_NAMES),
        )
    recipe = {"code_hashes": data.code_hashes(), "fixture": True}
    release = {
        "version": data.VERSION,
        "recipe": recipe,
        "release_id": content_hash(recipe)[:20],
        "artifact_hashes": {p.name: digest(p) for p in root.glob("*.npz")},
    }
    (root / "release.json").write_text(json.dumps(release))
    return root


def test_material_code_roundtrip_and_frozen_coordinates():
    rng = np.random.default_rng(231)
    points = rng.normal(size=(80, 3)) * 30
    before = points.copy()
    c = np.asarray([-0.6, 0.1, 0.8, 0.4, -0.2, 0.5])
    recipe = data.controls_recipe("liver", "rich", 123, c)
    assert np.allclose(data.recipe_controls(recipe), c, atol=1e-12)
    summary, fields = data.evaluate_controls("liver", "rich", 123, c, points)
    assert np.array_equal(before, points)
    assert fields.shape == (80, 8) and np.isfinite(summary).all()
    other = data.evaluate_controls("liver", "rich", 124, c, points)[1]
    assert not np.array_equal(fields, other)
    with pytest.raises(ValueError, match="uint32"):
        data.controls_recipe("liver", "rich", True, c)


def test_group_leakage_and_hash_fail_closed(corpus):
    train, val = data.read_split(corpus, "train"), data.read_split(corpus, "val")
    model.ensure_groups(train, val)
    val["group_ids"] = val["group_ids"].astype("U100")
    val["group_ids"][0] = train["group_ids"][0]
    with pytest.raises(ValueError, match="cross"):
        model.ensure_groups(train, val)
    with (corpus / "val.npz").open("ab") as f:
        f.write(b"corruption")
    with pytest.raises(ValueError, match="integrity"):
        data.read_split(corpus, "val")


def test_resume_safe_inference_and_frozen_audit(corpus, tmp_path, monkeypatch):
    full, partial = tmp_path / "full", tmp_path / "partial"
    cfg = model.Config(steps=8, width=12, batch_size=8, checkpoint_every=4)
    original = data.read_split
    splits = []

    def tracked(root, split):
        splits.append(split)
        return original(root, split)

    monkeypatch.setattr(data, "read_split", tracked)
    report = model.train(corpus, full, cfg)
    model.train(corpus, partial, cfg, stop_after=4)
    resumed = model.train(corpus, partial, cfg, resume=True)
    assert report["losses"] == resumed["losses"]
    a, b = (
        model._load_checkpoint(full / "checkpoint.pt"),
        model._load_checkpoint(partial / "checkpoint.pt"),
    )
    assert all(torch.equal(a["network"][k], b["network"][k]) for k in a["network"])
    assert "audit" not in splits
    loaded = model.load_model(full / "model.npz")
    proposal = model.sample_recipe(loaded, "liver", "balanced", 551)
    assert proposal == model.sample_recipe(loaded, "liver", "balanced", 551)
    assert proposal["geometry_modified"] is False
    with pytest.raises(ValueError, match="Unsupported"):
        model.sample_recipe(loaded, "invented", "balanced", 551)
    with pytest.raises(ValueError, match="support"):
        model.sample_recipe(loaded, "liver", "balanced", 551, {"roughness_mean": 1e6})
    with pytest.raises(ValueError, match="Freeze"):
        model.evaluate(corpus, full / "model.npz", "audit")
    model.write_json(full / "freeze.json", {"model_sha256": model.digest(full / "model.npz")})
    audit = model.evaluate(corpus, full / "model.npz", "audit", freeze=full / "freeze.json")
    assert audit["rows"] == 6
    with (full / "model.npz").open("ab") as file:
        file.write(b"x")
    with pytest.raises(ValueError, match="integrity"):
        model.load_model(full / "model.npz")


def test_numpy_serving_matches_torch_network(corpus):
    train = data.read_split(corpus, "train")
    fitted = model.fit_baselines(train, model.Config())
    x = model.features(fitted, train["conditions"], model.group_names(train))
    network = model.Prior(x.shape[1], 12)
    fitted.update(
        {f"nn_{k}": v.detach().numpy().astype(np.float64) for k, v in network.state_dict().items()}
    )
    actual_mean, actual_logstd = model.mlp_numpy(fitted, x)
    with torch.no_grad():
        expected_mean, expected_logstd = network(torch.tensor(x, dtype=torch.float32))
    assert np.allclose(actual_mean, expected_mean.numpy(), atol=1e-6)
    assert np.allclose(actual_logstd, expected_logstd.numpy(), atol=1e-6)
