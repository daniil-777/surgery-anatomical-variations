"""Honest early-stop provenance and unchanged quality gates; no real model claims."""
import json
import zipfile
from dataclasses import asdict
from pathlib import Path

import pytest

from pipelines.train.viscera_train import atlas_wording as old
from pipelines.train.viscera_train import atlas_wording_snapshot as snapshot


def fixture(out):
    adapter = out / "adapter"
    adapter.mkdir(parents=True)
    for name, content in {
        "adapter_model.safetensors": b"metadata-fixture-never-loaded",
        "adapter_config.json": old.canonical({"base_model_name_or_path": old.BASE_MODEL,
            "peft_type": "LORA", "task_type": "CAUSAL_LM", "r": 16, "lora_alpha": 32}).encode(),
        "tokenizer.json": b"{}", "tokenizer_config.json": b"{}",
    }.items():
        (adapter / name).write_bytes(content)
    old.atomic_json(out / "dataset_release.json", {"counts": {"train": 192000}, "challenge": {"rows": 81}})
    identity = {"format": old.FORMAT, "tiny_fixture": False, "base_model": old.BASE_MODEL,
        "base_revision": old.BASE_REVISION, "source_hashes": old.source_hashes(),
        "config": asdict(old.WordingConfig()), "dataset_release_sha256": old.digest(out / "dataset_release.json")}
    report = {"identity": identity, "steps": 9900, "planned_steps": 12000,
        "training_rows": 192000, "examples_seen": 316800, "training_complete": False,
        "stopped_early": True, "stop_reason": "Deadline candidate selected before evaluation",
        "pretrained_base_loaded": True, "parent_checkpoint_sha256": "a" * 64,
        "status": "early_stopped_checkpoint_candidate", "snapshot_policy": snapshot.POLICY,
        "snapshot_helper_sha256": snapshot.helper_sha()}
    old.atomic_json(out / "training_report.json", report)
    hashes = {str(p.relative_to(out)): old.digest(p) for p in out.rglob("*") if p.is_file()}
    old.atomic_json(out / "manifest.json", {"format": snapshot.FORMAT, "identity": identity,
        "snapshot_policy": snapshot.POLICY, "snapshot_helper_sha256": snapshot.helper_sha(),
        "promoted": False, "artifact_hashes": hashes})
    metric = {"rows": 512, "valid_fraction": 1.0, "status_accuracy": 1.0,
        "operations_accuracy": 1.0, "false_accepts": 0, "nonaccepted_rows": 100,
        "per_organ": {"liver": {"rows": 512, "correct": 512}}}
    challenge = {**metric, "rows": 81, "nonaccepted_rows": 20}
    gates = old.promotion_gates(metric, challenge)
    gates.update({"runtime_" + k: v for k, v in list(gates.items())})
    evaluation = {"format": snapshot.FORMAT, "snapshot_helper_sha256": snapshot.helper_sha(),
        "parent_checkpoint_sha256": report["parent_checkpoint_sha256"],
        "adapter_artifact_hashes": {k: v for k, v in hashes.items() if k.startswith("adapter/")},
        "training_report_sha256": old.digest(out / "training_report.json"),
        "source_hashes": identity["source_hashes"], "dataset_release_sha256": identity["dataset_release_sha256"],
        "passed": True, "gates": gates, "audit": metric, "challenge": challenge,
        "runtime_audit": metric, "runtime_challenge": challenge,
        "audit_example_ids": [str(i) for i in range(512)], "challenge_example_ids": [str(i) for i in range(81)]}
    old.atomic_json(out / "evaluation.json", evaluation)
    return report, evaluation


def test_early_stop_is_explicit_and_cannot_impersonate_a_full_run(tmp_path):
    report, _ = fixture(tmp_path)
    assert snapshot.verify_adapter(tmp_path, require_promoted=False)["promoted"] is False
    with pytest.raises(ValueError, match="not passed"):
        snapshot.verify_adapter(tmp_path)
    with pytest.raises(ValueError, match="provenance"):
        old.verify_adapter(tmp_path)
    assert report["steps"] == 9900 and report["planned_steps"] == 12000
    assert report["training_complete"] is False


@pytest.mark.parametrize("change", [
    {"steps": 12000}, {"examples_seen": 192000}, {"planned_steps": 9900},
    {"training_complete": True}, {"stopped_early": False}, {"stop_reason": ""},
])
def test_inconsistent_or_falsely_complete_snapshot_is_rejected(tmp_path, change):
    report, _ = fixture(tmp_path)
    report.update(change)
    release = old.strict_json((tmp_path / "dataset_release.json").read_text())
    with pytest.raises(ValueError, match="provenance"):
        snapshot._checkpoint_contract(report["identity"], report, release)


def test_passing_snapshot_export_retains_actual_steps_and_inert_payload(tmp_path):
    out = tmp_path / "candidate"
    fixture(out)
    destination = snapshot.export(out, tmp_path / "weights.zip")
    assert snapshot.verify_adapter(out)["promoted"] is True
    with zipfile.ZipFile(destination) as archive:
        assert all(name.startswith("viscera-wording-weights/") for name in archive.namelist())
        assert not any(name.endswith(".pt") for name in archive.namelist())
        report = json.loads(archive.read("viscera-wording-weights/training_report.json"))
        assert report["steps"] == 9900 and report["training_complete"] is False


def test_failed_generation_gate_cannot_export_and_restores_unpromoted_manifest(tmp_path):
    _, evaluation = fixture(tmp_path)
    evaluation["runtime_audit"]["operations_accuracy"] = .5
    old.atomic_json(tmp_path / "evaluation.json", evaluation)
    with pytest.raises(ValueError, match="thresholds"):
        snapshot.export(tmp_path, tmp_path / "weights.zip")
    assert not (tmp_path / "weights.zip").exists()
    assert old.strict_json((tmp_path / "manifest.json").read_text())["promoted"] is False


def test_evaluation_for_changed_weights_is_rejected(tmp_path):
    fixture(tmp_path)
    path = tmp_path / "adapter/adapter_model.safetensors"
    path.write_bytes(b"different-metadata-fixture")
    manifest = old.strict_json((tmp_path / "manifest.json").read_text())
    manifest["artifact_hashes"]["adapter/adapter_model.safetensors"] = old.digest(path)
    old.atomic_json(tmp_path / "manifest.json", manifest)
    with pytest.raises(ValueError, match="different weights"):
        snapshot.export(tmp_path, tmp_path / "weights.zip")


def test_audit_cannot_be_shortened_below_original_gate(tmp_path):
    with pytest.raises(ValueError, match="512"):
        snapshot.evaluate(tmp_path, tmp_path, limit=511)


def test_snapshot_import_uses_separate_verifier_and_preserves_early_stop_status(tmp_path, monkeypatch):
    from services.api import atlas_wording_model as serving

    root = Path(__file__).resolve().parents[2]
    monkeypatch.setenv("VISCERA_MODEL_STORE", str(tmp_path / "store"))
    out = tmp_path / "candidate"
    fixture(out)
    archive = snapshot.export(out, tmp_path / "weights.zip")
    result = serving.import_weights(root, archive, report_status=False)
    assert result["status"] == "active"
    state, directory = serving.active(root)
    assert state["format"] == snapshot.FORMAT
    assert directory is not None
    status = serving.status(root)
    assert "early_stop" in status["lane"]["method"]
    assert "planned training not complete" in status["lane"]["scope"]


def test_snapshot_inference_selects_snapshot_loader_and_discloses_incomplete_training(tmp_path, monkeypatch):
    from viscera_core.atlas_semantic import make_plan

    from services.api import atlas_wording_model as serving
    from services.api.atlas import LegacyAtlasSpec

    root = Path(__file__).resolve().parents[2]
    serving.clear_cache()
    state = {"active_bundle": "a" * 64, "manifest_sha256": "b" * 64, "format": snapshot.FORMAT}
    monkeypatch.setattr(serving, "active", lambda root: (state, tmp_path))
    calls = []

    def load(*args, **kwargs):
        calls.append(True)
        return object(), object()

    monkeypatch.setattr(snapshot, "load_adapter", load)
    monkeypatch.setattr(old, "load_adapter", lambda *a, **k: pytest.fail("Wrong full-run loader"))
    monkeypatch.setattr(old, "predict_plan", lambda *a: make_plan(status="clarify", message="Specify the edit"))
    result = serving.compile_request(root, root / "datasets/atlas/cohort-v2/templates", "healthier", LegacyAtlasSpec(template_id="hra-liver-female"), {"status": "unsupported"})
    assert calls == [True]
    assert result["wording_model"]["training_complete"] is False
    assert result["wording_model"]["inference_executed"] is True
    serving.clear_cache()


def test_actual_tensor_conversion_preserves_lora_and_does_not_modify_checkpoint(tmp_path, monkeypatch):
    """Tiny mocked base exercises tensor conversion only; never eligible quality evidence."""
    import torch
    from peft import LoraConfig, get_peft_model
    from safetensors.torch import load_file

    data = tmp_path / "data"
    data.mkdir()
    for split in ("train", "val"):
        (data / (split + ".jsonl")).write_text("fixture bytes\n")
    old.atomic_json(data / "release.json", {"counts": {"train": 10000}, "challenge": {"rows": 81},
        "artifact_hashes": {s + ".jsonl": old.digest(data / (s + ".jsonl")) for s in ("train", "val")}})
    cfg = old.WordingConfig()
    identity = {"format": old.FORMAT, "tiny_fixture": False, "base_model": old.BASE_MODEL,
        "base_revision": old.BASE_REVISION, "source_hashes": old.source_hashes(),
        "config": asdict(cfg), "dataset_release_sha256": old.digest(data / "release.json"),
        **{s + "_sha256": old.digest(data / (s + ".jsonl")) for s in ("train", "val")}}

    class Tokenizer:
        def save_pretrained(self, out):
            for name in ("tokenizer.json", "tokenizer_config.json"):
                (out / name).write_text("{}")

    def tiny(config, device):
        model, _ = old._tiny_factory(config, device)
        model.name_or_path = old.BASE_MODEL
        return model, Tokenizer()

    base, _ = tiny(cfg, "cpu")
    model = get_peft_model(base, LoraConfig(task_type="CAUSAL_LM", r=16, lora_alpha=32,
        lora_dropout=0, target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]))
    adapter = {k: v.detach().cpu().clone() for k, v in model.state_dict().items() if "lora_" in k}
    checkpoint = tmp_path / "checkpoint.pt"
    torch.save({"identity": identity, "step": 400, "examples_seen": 12800, "losses": [1.0], "adapter": adapter}, checkpoint)
    before = old.digest(checkpoint)
    monkeypatch.setattr(old, "_factory", tiny)
    monkeypatch.setattr("peft.utils.save_and_load.check_file_exists_on_hf_hub", lambda *a, **k: False)
    report = snapshot.freeze(data, checkpoint, tmp_path / "out", "Tensor conversion test with mocked tiny base", "cpu")
    assert report["steps"] == 400 and report["planned_steps"] == 625
    assert old.digest(checkpoint) == before
    saved = load_file(tmp_path / "out/adapter/adapter_model.safetensors")
    assert saved.keys() == {k.replace(".default", "") for k in adapter}
    assert all(torch.equal(value, saved[key.replace(".default", "")]) for key, value in adapter.items())
