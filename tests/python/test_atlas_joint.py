"""Joint-model contract, decoder parity, train/export and leakage regression tests."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from viscera_core import atlas_joint as joint
from viscera_core.atlas_disease_recipe_dataset import write_json

from pipelines.train.viscera_train.joint import Config, load_datasets, torch_classes, train


def condition(profile: str = "baseline") -> dict:
    return {
        "template_id": "test-liver",
        "organ": "liver",
        "profile_id": profile,
        "material_preset": "balanced",
        "renderer_seed": 523,
    }


def release(root: Path, profile: str = "baseline") -> Path:
    root.mkdir()
    c = condition(profile)
    rng = np.random.default_rng(71)
    write_json(
        root / "catalog.json",
        {
            "conditions": [c],
            "control_names": list(joint.CONTROL_NAMES),
            "observation_names": list(joint.OBSERVATION_NAMES),
        },
    )
    for split, n in (("train", 24), ("val", 8), ("audit", 8)):
        x = rng.uniform(-0.8, 0.8, (n, 22)).astype(np.float32)
        if profile == "baseline":
            x[:, 13:] = 0
        else:
            x[:, 18] = np.rint((x[:, 18] + 1) * 3.5) / 3.5 - 1
        obs = np.zeros((n, 8, 7), dtype=np.float32)
        obs[:, :, :3] = x[:, :3, None].transpose(0, 2, 1) * 0.2
        obs[:, :, 3:6] = 0.4 + x[:, 7:10, None].transpose(0, 2, 1) * 0.1
        obs[:, :, 6] = 0.5 + x[:, 10, None] * 0.1
        np.savez_compressed(
            root / (split + ".npz"),
            controls=x,
            observations=obs,
            condition_ids=np.zeros(n, dtype=np.int64),
            sample_ids=np.asarray([f"{profile}-{split}-{i}" for i in range(n)]),
            group_ids=np.asarray([f"{split}-{i}" for i in range(n)]),
            seeds=np.arange(n, dtype=np.uint32),
        )
    write_json(
        root / "release.json",
        {
            "format": joint.DATASET_FORMAT,
            "artifact_hashes": {
                name: joint.digest(root / name)
                for name in ("catalog.json", "train.npz", "val.npz", "audit.npz")
            },
            "renderer_hashes": {name: "a" * 64 for name in joint.RENDERER_PATHS},
            "template_hashes": {"test-liver": "b" * 64},
            "template_metadata_hashes": {"test-liver": "c" * 64},
        },
    )
    return root


def supported_profile() -> str:
    from viscera_core.atlas_disease import disease_catalog

    return next(
        p["id"]
        for p in disease_catalog()["profiles"]
        if p.get("supported") and p["organ"] == "liver"
    )


def test_numpy_decoder_matches_torch_multimodal_heads():
    torch, VAE, _ = torch_classes()
    torch.manual_seed(51)
    cfg = Config(hidden=32, latent=8, embedding=4)
    model = VAE(2, 56, cfg).eval()
    ids = np.array([0, 1, 1], dtype=np.int64)
    z = np.random.default_rng(9).normal(size=(3, 8)).astype(np.float32)
    with torch.no_grad():
        expected = model.decode(torch.from_numpy(z), torch.from_numpy(ids))[0].numpy()
    actual = joint.decode_latents(
        {"arrays": {k: v.detach().numpy() for k, v in model.state_dict().items()}}, ids, z
    )
    np.testing.assert_allclose(actual, expected, rtol=2e-6, atol=1e-7)


def test_joint_control_roundtrip_and_fixed_spatial_phase():
    c = condition(supported_profile())
    x = np.linspace(-0.8, 0.8, 22)
    x[18] = 1 / 7
    recipe = joint.decode_controls(c, x, 1)
    assert recipe == joint.decode_controls(c, x, 99)  # latent seed is not unmodeled spatial noise
    observed = joint.encode_controls(recipe["controls"], recipe["material"], recipe["disease"])
    np.testing.assert_allclose(observed, x, atol=1e-6)
    baseline = joint.decode_controls(condition(), np.zeros(22), 4)
    assert baseline["disease"] is None


def test_condition_rejects_unsupported_disease_or_wrong_organ():
    with pytest.raises(ValueError, match="Unsupported disease"):
        joint.validate_conditions([condition("not-a-disease")])
    c = condition(supported_profile())
    c["organ"] = "kidney"
    with pytest.raises(ValueError, match="Unsupported disease"):
        joint.validate_conditions([c])


def test_split_checks_and_family_leakage(tmp_path):
    directory = release(tmp_path / "baseline")
    provenance, data = load_datasets([directory])
    assert len(provenance["conditions"]) == 1
    bad = {**data["train"], "controls": data["train"]["controls"].copy()}
    bad["controls"][0, 13] = 0.1
    with pytest.raises(ValueError, match="Baseline"):
        joint.validate_split(bad, provenance["conditions"])
    val = data["val"]
    val["group_ids"] = val["group_ids"].astype("U40")
    val["group_ids"][0] = "train-0"
    np.savez_compressed(directory / "val.npz", **val)
    meta = json.loads((directory / "release.json").read_text())
    meta["artifact_hashes"]["val.npz"] = joint.digest(directory / "val.npz")
    write_json(directory / "release.json", meta)
    with pytest.raises(ValueError, match="split leakage"):
        load_datasets([directory])


def test_training_export_replay_and_no_fallback(tmp_path):
    baseline = release(tmp_path / "baseline")
    disease = release(tmp_path / "disease", supported_profile())
    out = tmp_path / "weights"
    report = train(
        [baseline, disease],
        out,
        Config(
            steps=8,
            surrogate_steps=6,
            hidden=32,
            latent=6,
            embedding=4,
            batch_size=16,
            threads=1,
            profile="smoke",
            device="cpu",
        ),
    )
    assert report["seed_replay_passed"]
    assert report["selected_method"] == "joint_conditional_vae"
    assert report["training_profile"] == "smoke"
    model = joint.load_model(out / "model.npz")
    a = joint.sample_joint(model, "test-liver", supported_profile(), 42)
    assert a == joint.sample_joint(model, "test-liver", supported_profile(), 42)
    b = joint.sample_joint(model, "test-liver", supported_profile(), 43)
    assert a["controls"] != b["controls"]
    assert a["material"] != b["material"]
    assert a["disease"] != b["disease"]
    assert a["disease"]["profile_id"] == supported_profile()
    assert joint.sample_joint(model, "test-liver", None, 42)["disease"] is None
    for seed in (True, -1, 2**32, 1.2):
        with pytest.raises(ValueError, match="seed"):
            joint.sample_joint(model, "test-liver", None, seed)
    with pytest.raises(ValueError, match="not supported"):
        joint.sample_joint(model, "missing-liver", None, 42)
    with pytest.raises(ValueError, match="temperature"):
        joint.sample_joint(model, "test-liver", None, 42, float("nan"))
    raw = (out / "model.npz").read_bytes()
    (out / "model.npz").write_bytes(raw + b"corrupted")
    with pytest.raises(ValueError, match="checksum"):
        joint.load_model(out / "model.npz")


def test_full_profile_cannot_be_labeled_after_smoke_training(tmp_path):
    with pytest.raises(ValueError, match="Full profile"):
        train([], tmp_path / "bad", Config(steps=1, surrogate_steps=1))
