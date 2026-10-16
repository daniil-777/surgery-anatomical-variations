"""V2 bounded flow invertibility, mixed controls, source integrity and resume."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pytest
from viscera_core import atlas_joint_v2 as joint
from viscera_core.atlas_disease_recipe_dataset import write_json

from pipelines.train.viscera_train.joint_v2 import Config, load_datasets, torch_classes, train


def conditions(profile="baseline"):
    return [
        {
            "renderer_version": "disease-v2",
            "template_id": "test-liver",
            "organ": "liver",
            "profile_id": profile,
            "material_preset": "balanced",
        }
    ]


def profile():
    from viscera_core.atlas_disease_v2 import disease_catalog

    return next(
        p["id"] for p in disease_catalog()["profiles"] if p["supported"] and p["organ"] == "liver"
    )


def release(root: Path, profile_id="baseline", sizes=(12, 6, 6)) -> Path:
    root.mkdir()
    cs = conditions(profile_id)
    write_json(
        root / "catalog.json",
        {
            "conditions": cs,
            "control_names": list(joint.CONTROL_NAMES),
            "observation_names": list(joint.OBSERVATION_NAMES),
        },
    )
    rng = np.random.default_rng(51)
    for split, per in zip(("train", "val", "audit"), sizes, strict=True):
        sid = np.repeat([0] if profile_id == "baseline" else [1, 2, 3], per).astype(np.int64)
        n = len(sid)
        x = rng.uniform(-0.85, 0.85, (n, 22)).astype(np.float32)
        for band, (lo, hi) in joint.SEVERITY_BANDS.items():
            x[sid == band, 13] = 2 * rng.uniform(lo, hi, np.sum(sid == band)) - 1
        x[:, 18] = np.rint((x[:, 18] + 1) * 3.5) / 3.5 - 1
        x[sid == 0, 13:] = 0
        rest = rng.uniform(-0.5, 0.5, (n, 8, 3)).astype(np.float32)
        obs = np.concatenate(
            (
                rest + x[:, :3, None].transpose(0, 2, 1) * 0.04,
                np.broadcast_to(0.5 + x[:, 7:10, None].transpose(0, 2, 1) * 0.1, (n, 8, 3)),
                np.broadcast_to((0.5 + x[:, 10] * 0.1)[:, None, None], (n, 8, 1)),
            ),
            -1,
        ).astype(np.float32)
        phases = rng.integers(0, 2**32, (n, 2), dtype=np.uint32)
        np.savez_compressed(
            root / (split + ".npz"),
            controls=x,
            observations=obs,
            rest_points=rest,
            region_ids=np.zeros((n, 8), dtype=np.uint8),
            condition_ids=np.zeros(n, dtype=np.int64),
            severity_ids=sid,
            renderer_seeds=phases,
            spatial_features=joint.spatial_features(phases),
            sample_ids=np.asarray([f"{profile_id}-{split}-{i}" for i in range(n)]),
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


def test_spline_analytic_inverse_jacobian_and_torch_numpy_parity():
    torch, _, _, spline = torch_classes()
    torch.set_num_threads(1)
    rng = np.random.default_rng(31)
    x = rng.uniform(-0.999, 0.999, (16, 11)).astype(np.float32)
    parameters = rng.normal(0, 0.5, (16, 11, 23)).astype(np.float32)
    tx = torch.tensor(x, requires_grad=True)
    tp = torch.tensor(parameters)
    ty, ld = spline(tx, tp, 8)
    derivative = torch.autograd.grad(ty.sum(), tx)[0].detach().numpy()
    y, nld = joint.rational_quadratic_spline(x, parameters, 8)
    back, ild = joint.rational_quadratic_spline(y, parameters, 8, True)
    np.testing.assert_allclose(y, ty.detach().numpy(), atol=2e-6)
    np.testing.assert_allclose(nld, ld.detach().numpy(), atol=1e-5)
    np.testing.assert_allclose(np.exp(nld), derivative, atol=2e-5, rtol=2e-5)
    np.testing.assert_allclose(back, x, atol=3e-6)
    np.testing.assert_allclose(nld + ild, 0, atol=2e-5)
    assert np.all(derivative > 0)


@pytest.mark.parametrize("context_gain", [0.0, 0.2])
def test_full_coupling_stack_numpy_torch_parity_and_inverse(context_gain):
    torch, Flow, _, _ = torch_classes()
    torch.manual_seed(79)
    c = Config(layers=4, hidden=32, embedding=8, blocks=1, context_gain=context_gain)
    meta = {
        "templates": ["test-liver"],
        "profiles": ["baseline"],
        "organs": ["liver"],
        "conditions": conditions(),
        "config": asdict(c),
    }
    flow = Flow(meta, c).eval()
    with torch.no_grad():
        for coupling in flow.couplings:
            coupling.output.weight.normal_(0, 0.04)
            coupling.output.bias.normal_(0, 0.02)
    rng = np.random.default_rng(3)
    x = rng.uniform(-0.98, 0.98, (9, 22)).astype(np.float32)
    phase = rng.uniform(-1, 1, (9, 8)).astype(np.float32)
    ids = np.zeros(9, dtype=np.int64)
    with torch.no_grad():
        context = flow.context_features(*[torch.from_numpy(ids)] * 4, torch.from_numpy(phase))
        expected, ld = flow.transform(torch.from_numpy(x), context)
    model = {**meta, "arrays": {k: v.detach().numpy() for k, v in flow.state_dict().items()}}
    actual, nld = joint.flow_transform(model, x, ids, ids, phase)
    independent, _ = joint.flow_transform(model, x, ids, ids, -phase)
    np.testing.assert_array_equal(actual, independent)
    # Pooled density ignores organ/profile identity and physical design-band labels.
    if context_gain == 0:
        altered = {**model, "arrays": {k: v.copy() for k, v in model["arrays"].items()}}
        for name in (
            "template_embedding.weight",
            "profile_embedding.weight",
            "organ_embedding.weight",
        ):
            altered["arrays"][name] += 100
        np.testing.assert_array_equal(actual, joint.flow_transform(altered, x, ids, ids, phase)[0])
    mild = joint.flow_transform(model, x, ids, np.ones(9, dtype=int), phase)[0]
    severe = joint.flow_transform(model, x, ids, np.full(9, 3), phase)[0]
    np.testing.assert_array_equal(mild, severe)
    back, ild = joint.flow_transform(model, actual, ids, ids, phase, True)
    np.testing.assert_allclose(actual, expected.numpy(), atol=2e-6)
    np.testing.assert_allclose(nld, ld.numpy(), atol=1e-5)
    np.testing.assert_allclose(back, x, atol=3e-6)
    np.testing.assert_allclose(nld + ild, 0, atol=2e-5)


def test_mixed_count_severity_transform_roundtrip_and_baseline_nuisance():
    x = np.zeros((25, 22), dtype=np.float32)
    sid = np.r_[np.zeros(1, dtype=int), np.repeat([1, 2, 3], 8)]
    x[1:, 18] = np.tile(np.arange(8) / 3.5 - 1, 3)
    for band, (lo, hi) in joint.SEVERITY_BANDS.items():
        x[sid == band, 13] = 2 * np.linspace(lo + 0.001, hi - 0.001, 8) - 1
    local = joint.to_flow_controls(x, sid, np.random.default_rng(53))
    assert np.std(local[0, 13:]) > 0.1
    back = joint.from_flow_controls(local, sid)
    np.testing.assert_allclose(back, x, atol=2e-6)
    assert np.all(back[0, 13:] == 0)
    boundaries = np.zeros((3, 22))
    boundaries[:, 13] = [-1, 0, 1]
    b = joint.from_flow_controls(boundaries, np.array([1, 2, 3]))
    np.testing.assert_allclose((b[:, 13] + 1) / 2, [0.1, 0.525, 1], atol=1e-6)


def test_seed_features_exact_and_invalid_values_rejected():
    seeds = np.array([[0, 2**32 - 1], [0x04030201, 0x08070605]], dtype=np.uint32)
    encoded = joint.spatial_features(seeds)
    reconstructed = np.rint((encoded + 1) * 127.5).astype(np.uint64).reshape(-1, 2, 4)
    reconstructed = (reconstructed << np.array([0, 8, 16, 24], dtype=np.uint64)).sum(-1)
    np.testing.assert_array_equal(seeds, reconstructed)
    with pytest.raises(ValueError):
        joint.spatial_features(np.array([True, False]))
    with pytest.raises(ValueError):
        joint.spatial_features(np.array([-1, 0]))


def test_split_checks_leakage_seed_context_and_band(tmp_path):
    a = release(tmp_path / "baseline")
    b = release(tmp_path / "disease", profile())
    meta, d = load_datasets([a, b])
    bad = {k: v.copy() for k, v in d["train"].items()}
    bad["spatial_features"][0, 0] += 0.1
    with pytest.raises(ValueError, match="spatial seed"):
        joint.validate_split(bad, meta["conditions"])
    bad = {k: v.copy() for k, v in d["train"].items()}
    ix = np.flatnonzero(bad["severity_ids"] == 3)[0]
    bad["controls"][ix, 13] = -1
    with pytest.raises(ValueError, match="strength"):
        joint.validate_split(bad, meta["conditions"])
    raw = joint.read_split(a, "val")
    raw["group_ids"] = raw["group_ids"].astype("U32")
    raw["group_ids"][0] = "train-0"
    np.savez_compressed(a / "val.npz", **raw)
    r = json.loads((a / "release.json").read_text())
    r["artifact_hashes"]["val.npz"] = joint.digest(a / "val.npz")
    write_json(a / "release.json", r)
    with pytest.raises(ValueError, match="split leakage"):
        load_datasets([a, b])


@pytest.mark.parametrize("interrupt_stage", ["optimizer", "finalization"])
def test_real_training_export_seed_replay_and_safe_checkpoint_resume(
    tmp_path, monkeypatch, interrupt_stage
):
    baseline = release(tmp_path / "baseline")
    disease = release(tmp_path / "disease", profile())
    cfg = Config(
        steps=6,
        surrogate_steps=4,
        batch_size=16,
        query_points=4,
        layers=2,
        hidden=32,
        embedding=8,
        blocks=1,
        field_hidden=32,
        threads=1,
        profile="smoke",
        device="cpu",
        checkpoint_every=2,
    )
    full = train([baseline, disease], tmp_path / "full", cfg)
    original = Path.replace
    checkpoint = tmp_path / "resume" / "checkpoint.pt"

    def interrupt_after_valid_checkpoint(self, target):
        result = original(self, target)
        if interrupt_stage == "optimizer" and Path(target) == checkpoint:
            torch, *_ = torch_classes()
            saved = torch.load(checkpoint, weights_only=True, map_location="cpu")
            if saved["phase"] == "flow" and saved["step"] == 2:
                raise InterruptedError("simulated Colab disconnection")
        if (
            interrupt_stage == "finalization"
            and Path(target) == tmp_path / "resume/training_report.json"
        ):
            assert not (tmp_path / "resume/model.npz").exists()
            raise InterruptedError("simulated disconnect before final model commit")
        return result

    monkeypatch.setattr(Path, "replace", interrupt_after_valid_checkpoint)
    with pytest.raises(InterruptedError):
        train([baseline, disease], tmp_path / "resume", cfg)
    monkeypatch.setattr(Path, "replace", original)
    resumed = train([baseline, disease], tmp_path / "resume", cfg)
    assert resumed["seed_replay_passed"] and resumed["checkpoint_resume_supported"]
    assert not (tmp_path / "resume/.finalizing").exists()
    assert resumed["validation"] == full["validation"]
    assert resumed["audit"] == full["audit"]
    a = joint.load_model(tmp_path / "full/model.npz")
    b = joint.load_model(tmp_path / "resume/model.npz")
    for key in a["arrays"]:
        np.testing.assert_array_equal(a["arrays"][key], b["arrays"][key])
    assert full["numpy_decoder_max_abs_error"] < 5e-4
    assert full["validation_acceptance"]["export_eligible"] is False  # smoke stays nonreleasable
    assert (
        full["validation_acceptance"]["selected_nll"]
        <= full["validation_acceptance"]["uniform_nll"] + 1e-6
    )
    assert any(item.get("identity_baseline") for item in full["history"])
    for severity, (lo, hi) in zip(
        ("mild", "moderate", "severe"), joint.SEVERITY_BANDS.values(), strict=True
    ):
        sample = joint.sample_joint(b, "test-liver", profile(), 83, severity=severity)
        assert lo - 1e-6 <= sample["disease"]["severity"] <= hi + 1e-6
        assert sample == joint.sample_joint(b, "test-liver", profile(), 83, severity=severity)
        assert sample["renderer_version"] == "disease-v2"
        assert sample["disease"]["count"] in range(1, 9)
    assert joint.sample_joint(b, "test-liver", None, 17)["disease"] is None
    first = joint.sample_joint(
        b, "test-liver", profile(), 83, severity="severe", renderer_seeds=[1, 2]
    )
    second = joint.sample_joint(
        b, "test-liver", profile(), 83, severity="severe", renderer_seeds=[3, 4]
    )
    assert first["controls"] == second["controls"]
    assert first["material"]["seed"] == 1 and second["material"]["seed"] == 3
    assert first["disease"]["seed"] == 2 and second["disease"]["seed"] == 4
    with pytest.raises(ValueError, match="baseline"):
        joint.sample_joint(b, "test-liver", None, 17, severity="severe")
    with pytest.raises(ValueError, match="absent"):
        joint.sample_joint(b, "test-liver", "invalid", 17)
    with pytest.raises(ValueError, match="temperature"):
        joint.sample_joint(b, "test-liver", None, 17, temperature=float("nan"))
    with pytest.raises(ValueError, match="seed"):
        joint.sample_joint(b, "test-liver", None, True)
    p = tmp_path / "resume/model.npz"
    p.write_bytes(p.read_bytes() + b"corrupt")
    with pytest.raises(ValueError, match="checksum"):
        joint.load_model(p)


def test_smoke_cannot_be_labeled_full(tmp_path):
    with pytest.raises(ValueError, match="full training"):
        train([], tmp_path / "bad", Config(steps=2, surrogate_steps=2))


def test_flow_learns_bounded_correlated_multimodal_distribution(tmp_path):
    directory = release(tmp_path / "bimodal", sizes=(512, 128, 128))
    rng = np.random.default_rng(884)
    for split in ("train", "val", "audit"):
        data = joint.read_split(directory, split)
        x = rng.uniform(-0.65, 0.65, data["controls"].shape).astype(np.float32)
        mode = rng.choice([-1.0, 1.0], len(x))
        x[:, 0] = mode * 0.68 + rng.normal(0, 0.055, len(x))
        x[:, 7] = 0.75 * x[:, 0] + rng.normal(0, 0.06, len(x))
        x[:, 13:] = 0
        data["controls"] = x
        data["observations"][..., :3] = data["rest_points"] + x[:, None, :3] * 0.04
        data["observations"][..., 3:6] = 0.5 + x[:, None, 7:10] * 0.1
        data["observations"][..., 6] = 0.5 + x[:, None, 10] * 0.1
        np.savez_compressed(directory / (split + ".npz"), **data)
        release_meta = json.loads((directory / "release.json").read_text())
        release_meta["artifact_hashes"][split + ".npz"] = joint.digest(directory / (split + ".npz"))
        write_json(directory / "release.json", release_meta)
    result = train(
        [directory],
        tmp_path / "flow",
        Config(
            steps=500,
            surrogate_steps=2,
            batch_size=64,
            query_points=4,
            layers=4,
            hidden=48,
            embedding=8,
            blocks=1,
            field_hidden=16,
            threads=1,
            profile="smoke",
            device="cpu",
            field_weight=0,
            learning_rate=0.001,
            checkpoint_every=500,
        ),
    )
    metrics = result["validation"]["density"]["macro"]
    assert (
        metrics["flow_nll_per_active_dimension"]
        < metrics["truncated_diagonal_gaussian_nll_per_active_dimension"] - 0.05
    )
