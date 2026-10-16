"""The Run-all coordinator must not silently reuse tampered or partial weights."""

from __future__ import annotations

import json
import zipfile

import pytest

from scripts import final_train as runner


def test_completed_stage_reused_only_after_checksum_verification(tmp_path):
    calls = []

    def train(out):
        calls.append(out)
        (out / "weights.bin").write_bytes(b"learned coefficients")
        return {"selected": "candidate"}

    stage, _ = runner._stage(tmp_path, "shape", train)
    again, _ = runner._stage(tmp_path, "shape", train)
    assert again == stage and len(calls) == 1
    (stage / "weights.bin").write_bytes(b"corrupted coefficients")
    with pytest.raises(ValueError, match="integrity"):
        runner._stage(tmp_path, "shape", train)
    assert len(calls) == 1


def test_interrupted_stage_preserved_and_restarted_in_new_attempt(tmp_path):
    def fail(out):
        (out / "partial.bin").write_bytes(b"incomplete")
        raise RuntimeError("simulated interrupted training")

    with pytest.raises(RuntimeError, match="interrupted"):
        runner._stage(tmp_path, "disease", fail)
    failed = tmp_path / "stages/disease/attempt-001"
    assert (failed / "partial.bin").read_bytes() == b"incomplete"
    assert json.loads((failed / "failure.json").read_text())["type"] == "RuntimeError"

    def finish(out):
        (out / "model.npz").write_bytes(b"complete")
        return {"selected": "empirical"}

    stage, _ = runner._stage(tmp_path, "disease", finish)
    assert stage.name == "attempt-002"
    assert (failed / "partial.bin").read_bytes() == b"incomplete"


def test_export_zip_roundtrip_is_exact_and_reproducible(tmp_path):
    export = tmp_path / "export"
    (export / "shape").mkdir(parents=True)
    (export / "shape/model.pt").write_bytes(b"weights")
    (export / "README.txt").write_text("Synthetic controls, no calibrated physics.\n")
    first, second = tmp_path / "first.zip", tmp_path / "second.zip"
    runner._write_zip(export, first)
    runner._write_zip(export, second)
    assert runner.sha256(first) == runner.sha256(second)
    with zipfile.ZipFile(first) as archive:
        assert archive.read("viscera-weights/shape/model.pt") == b"weights"
        assert archive.testzip() is None


@pytest.mark.parametrize(
    "name",
    [
        "../model.pt",
        "/tmp/model.pt",
        "shape/../../model.pt",
        "shape//model.pt",
        "shape/./model.pt",
        "shape\\model.pt",
        "C:model.pt",
    ],
)
def test_manifest_parent_escape_rejected(tmp_path, name):
    with pytest.raises(ValueError, match="Unsafe"):
        runner.checked_path(tmp_path, name)


def test_empty_hash_manifest_is_not_a_successful_verification(tmp_path):
    with pytest.raises(ValueError, match="Empty"):
        runner.verify_hashes(tmp_path, {})


def test_artifact_directory_symlink_cannot_escape_manifest_root(tmp_path):
    root, outside = tmp_path / "bundle", tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    artifact = outside / "model.pt"
    artifact.write_bytes(b"known bytes but outside the trusted bundle")
    (root / "shape").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="integrity"):
        runner.verify_hashes(root, {"shape/model.pt": runner.sha256(artifact)})
