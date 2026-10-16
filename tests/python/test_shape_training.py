import json
from dataclasses import replace

import numpy as np
import pytest
import torch

from pipelines.train.viscera_train import shape


def write_fixture(path):
    path.mkdir()
    rng = np.random.default_rng(83)
    for split, n in (("train", 36), ("val", 8), ("test", 8)):
        c = rng.normal(size=(n, 2))
        x = np.column_stack((c[:, 0] * 2 + 0.2 * rng.normal(size=n), c[:, 1], rng.normal(size=n)))
        np.savez(
            path / f"{split}.npz",
            parameters=x,
            conditions=c,
            parameter_names=np.array(["a", "b", "c"]),
            condition_names=np.array(["d", "e"]),
            sample_ids=np.array([f"{split}-{i}" for i in range(n)]),
            group_ids=np.array([f"{split}-{i}" for i in range(n)]),
        )
    refresh_manifest(path)


def refresh_manifest(path):
    (path / "release.json").write_text(
        json.dumps(
            {
                "artifact_hashes": {
                    f"{s}.npz": shape.digest(path / f"{s}.npz") for s in ("train", "val", "test")
                }
            }
        )
    )


def test_resume_equals_uninterrupted_and_never_reads_test(tmp_path, monkeypatch):
    data = tmp_path / "data"
    write_fixture(data)
    # Test file is deliberately corrupt: training must not open it.
    (data / "test.npz").write_bytes(b"sealed test unavailable to training")
    monkeypatch.setattr(shape, "evaluate_arrays", lambda *a, **kw: {"fixture_evaluation": True})
    cfg = shape.TrainConfig(
        steps=17,
        hidden=24,
        batch_size=11,
        checkpoint_every=5,
        device="cpu",
        parameter_transform="identity",
    )
    uninterrupted = tmp_path / "uninterrupted"
    resumed = tmp_path / "resumed"
    shape.train(data, uninterrupted, cfg)
    interrupted = shape.train(data, resumed, cfg, stop_after=7)
    assert interrupted["status"] == "interrupted"
    shape.train(data, resumed, cfg, resume=True)
    a, b = (
        shape.safe_load(uninterrupted / "checkpoint.pt"),
        shape.safe_load(resumed / "checkpoint.pt"),
    )
    assert a["cursor"] == b["cursor"]
    assert torch.equal(a["permutation"], b["permutation"])
    for key in a["model"]:
        assert torch.equal(a["model"][key], b["model"][key]), key
    with pytest.raises(ValueError, match="configuration"):
        shape.train(data, resumed, replace(cfg, lr=0.2), resume=True)


def test_train_only_basis_and_corrupt_checkpoint(tmp_path, monkeypatch):
    data = tmp_path / "data"
    write_fixture(data)
    before = shape.fit_preprocessing(
        shape.read_split(data, "train"), 3, parameter_transform="identity"
    )
    val = shape.read_split(data, "val")
    val["parameters"] *= 10000
    np.savez(data / "val.npz", **val)
    refresh_manifest(data)
    after = shape.fit_preprocessing(
        shape.read_split(data, "train"), 3, parameter_transform="identity"
    )
    for key in before:
        np.testing.assert_array_equal(before[key], after[key])
    monkeypatch.setattr(shape, "evaluate_arrays", lambda *a, **kw: {})
    out = tmp_path / "model"
    shape.train(
        data,
        out,
        shape.TrainConfig(steps=2, hidden=12, device="cpu", parameter_transform="identity"),
    )
    p = out / "model.pt"
    p.write_bytes(p.read_bytes() + b"corrupt")
    with pytest.raises(ValueError, match="checksum"):
        shape.safe_load(p)


def test_split_audit_rejects_shared_derivative_groups(tmp_path):
    data = tmp_path / "data"
    write_fixture(data)
    train, val = shape.read_split(data, "train"), shape.read_split(data, "val")
    val["group_ids"] = val["group_ids"].astype("<U32")
    val["group_ids"][0] = train["group_ids"][0]
    with pytest.raises(ValueError, match="leakage"):
        shape.audit_splits(train, val)


def test_bounded_logit_is_invertible_and_never_clips_endpoints():
    from viscera_core.schema import PARAMETER_BOUNDS

    names = list(PARAMETER_BOUNDS)
    lo = np.array([PARAMETER_BOUNDS[k][0] for k in names])
    hi = np.array([PARAMETER_BOUNDS[k][1] for k in names])
    rng = np.random.default_rng(61)
    x = lo + (hi - lo) * rng.uniform(0.02, 0.98, (32, len(names)))
    data = {"parameters": x, "parameter_names": np.array(names), "conditions": x[:, :3]}
    p = shape.fit_preprocessing(data, len(names))
    np.testing.assert_allclose(shape.decode(shape.encode(x, p), p), x, rtol=1e-12, atol=1e-12)
    generated = shape.decode(rng.normal(size=(100, len(names))) * 20, p)
    assert np.all(generated >= lo) and np.all(generated <= hi)
    endpoint = x.copy()
    endpoint[0, 0] = lo[0]
    with pytest.raises(ValueError, match="exact endpoints"):
        shape.encode(endpoint, p)
    data["parameters"] = endpoint
    with pytest.raises(ValueError, match="never clamped"):
        shape.fit_preprocessing(data, len(names))


@pytest.mark.parametrize("key", ["sample_ids", "group_ids"])
def test_split_rejects_identifiers_that_do_not_cover_rows(tmp_path, key):
    data = tmp_path / "data"
    write_fixture(data)
    train = shape.read_split(data, "train")
    train[key] = train[key][:-1]
    np.savez(data / "train.npz", **train)
    refresh_manifest(data)
    with pytest.raises(ValueError, match="align"):
        shape.read_split(data, "train")


def test_evaluation_rejects_reordered_feature_labels_before_sampling(tmp_path):
    data = tmp_path / "data"
    write_fixture(data)
    reference = shape.read_split(data, "val")
    artifact = {key: reference[key].tolist() for key in ("parameter_names", "condition_names")}
    reference["condition_names"] = reference["condition_names"][::-1]
    with pytest.raises(ValueError, match="schema mismatch"):
        shape.evaluate_arrays(artifact, reference, "val")


def test_resume_rejects_changed_resolved_runtime_and_invalid_dropout(tmp_path, monkeypatch):
    data, out = tmp_path / "data", tmp_path / "run"
    write_fixture(data)
    monkeypatch.setattr(shape, "evaluate_arrays", lambda *a, **kw: {})
    cfg = shape.TrainConfig(steps=2, hidden=12, device="cpu", parameter_transform="identity")
    shape.train(data, out, cfg, stop_after=1)
    checkpoint = shape.safe_load(out / "checkpoint.pt")
    checkpoint["runtime_identity"]["device_type"] = "cuda"
    shape.atomic_torch(out / "checkpoint.pt", checkpoint)
    with pytest.raises(ValueError, match="runtime"):
        shape.train(data, out, cfg, resume=True)
    with pytest.raises(ValueError, match="dropout"):
        shape.train(data, out, replace(cfg, condition_dropout=float("nan")))
