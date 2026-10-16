"""Actual optimizer/resume, data leakage and promotion boundaries for wording v2."""

import copy

import pytest
from viscera_core.atlas_semantic import make_plan, operation

from pipelines.train.viscera_train import atlas_wording as wording


@pytest.fixture
def corpus(tmp_path):
    data = tmp_path / "dataset"
    data.mkdir()
    context = {
        "organ": "liver",
        "disease": None,
        "controls": {},
        "material": None,
        "appearance": "tissue",
    }
    hashes = {}
    for split, count in [("train", 4), ("val", 2)]:
        rows = [
            {
                "id": f"{split}-{i}",
                "split": split,
                "family_id": f"{split}-family-{i}",
                "text": f"{split} authored shape request {i}",
                "context": context,
                "target": make_plan(
                    [operation("control_set", "twist", 0.1)], message="Twist the authored shape."
                ),
            }
            for i in range(count)
        ]
        path = data / f"{split}.jsonl"
        path.write_text("\n".join(wording.canonical(row) for row in rows) + "\n")
        hashes[path.name] = wording.digest(path)
    wording.atomic_json(data / "release.json", {"artifact_hashes": hashes})
    return data


def test_real_cpu_lora_smoke_and_exact_resume(corpus, tmp_path):
    report = wording.smoke(corpus, tmp_path / "smoke")
    assert report["passed"] and report["actual_optimizer_steps"] == 8
    assert report["adapter_updated"] and report["loss_decreased"] and report["exact_resume"]
    assert not report["eligible_for_export"]
    with pytest.raises(ValueError, match="provenance"):
        wording.verify_adapter(tmp_path / "smoke/full")
    assert not (corpus / "audit.jsonl").exists()  # Training has no audit dependency.


def test_complete_target_mask_no_truncation(corpus):
    row = wording.read_split(corpus, "train")[0]
    value = wording.encode_row(wording._ByteTokenizer(), row, 8192)
    prefix = value["labels"].count(-100)
    assert 0 < prefix < len(value["labels"])
    assert value["input_ids"][prefix:] == value["labels"][prefix:]
    with pytest.raises(ValueError, match="truncation"):
        wording.encode_row(wording._ByteTokenizer(), row, 16)


def test_partition_hash_and_phrase_leakage(corpus):
    train, val = wording.read_split(corpus, "train"), wording.read_split(corpus, "val")
    wording.audit_disjoint(train, val)
    leaked = copy.deepcopy(val)
    leaked[0]["family_id"] = train[0]["family_id"]
    with pytest.raises(ValueError, match="leakage"):
        wording.audit_disjoint(train, leaked)
    with (corpus / "train.jsonl").open("a") as handle:
        handle.write("\n")
    with pytest.raises(ValueError, match="checksum"):
        wording.read_split(corpus, "train")


def test_invalid_plan_not_counted_as_correct_refusal(corpus):
    row = wording.read_split(corpus, "train")[0]
    row["target"] = make_plan(status="unsupported", message="No topology edits.")
    score = wording.score([row], ["{}"])
    assert score["valid"] == score["operations_correct"] == 0
    evil = make_plan([operation("control_set", "twist", 900)], message="Invalid")
    score = wording.score([row], [wording.canonical(evil)])
    assert score["valid"] == score["operations_correct"] == 0


def test_semantic_comparison_ignores_prose_order(corpus):
    row = wording.read_split(corpus, "train")[0]
    row["target"]["operations"].append(operation("control_set", "bend", 0.2))
    actual = copy.deepcopy(row["target"])
    actual["message"] = "Different correct explanatory prose."
    actual["operations"].reverse()
    score = wording.score([row], [wording.canonical(actual)])
    assert score["operations_accuracy"] == 1


def test_export_cannot_promote_tiny_or_failed_run(tmp_path):
    wording.atomic_json(tmp_path / "manifest.json", {"identity": {"tiny_fixture": True}})
    wording.atomic_json(tmp_path / "training_report.json", {"pretrained_base_loaded": False})
    wording.atomic_json(tmp_path / "evaluation.json", {"passed": True, "gates": {"fake": True}})
    with pytest.raises(ValueError, match="real pretrained"):
        wording.export(tmp_path, tmp_path / "weights.zip")


def test_duplicates_and_nonfinite_json_rejected():
    with pytest.raises(ValueError, match="Duplicate"):
        wording.strict_json('{"status":"accepted","status":"unsupported"}')
    with pytest.raises(ValueError, match="Nonfinite"):
        wording.strict_json('{"value":NaN}')


def _contract_fixture(out):
    """Synthetic metadata fixture; it is never loaded or used as a model."""
    adapter = out / "adapter"
    adapter.mkdir(parents=True)
    for name, content in {
        "adapter_model.safetensors": b"contract-test-not-a-model",
        "adapter_config.json": wording.canonical(
            {
                "base_model_name_or_path": wording.BASE_MODEL,
                "peft_type": "LORA",
                "task_type": "CAUSAL_LM",
            }
        ).encode(),
        "tokenizer.json": b"{}",
        "tokenizer_config.json": b"{}",
        "chat_template.jinja": b"{{ messages }}",
        "README.md": b"test model card",
    }.items():
        (adapter / name).write_bytes(content)
    wording.atomic_json(out / "dataset_release.json", {"contract_fixture": True})
    identity = {
        "format": wording.FORMAT,
        "base_model": wording.BASE_MODEL,
        "base_revision": wording.BASE_REVISION,
        "tiny_fixture": False,
        "source_hashes": wording.source_hashes(),
        "dataset_release_sha256": wording.digest(out / "dataset_release.json"),
    }
    report = {
        "identity": identity,
        "pretrained_base_loaded": True,
        "training_rows": 10000,
        "steps": 1000,
        "required_steps": 1000,
        "examples_seen": 20000,
    }
    wording.atomic_json(out / "training_report.json", report)
    adapter_hashes = {str(p.relative_to(out)): wording.digest(p) for p in adapter.iterdir()}
    metric = {
        "rows": 1024,
        "valid_fraction": 1.0,
        "status_accuracy": 1.0,
        "operations_accuracy": 1.0,
        "false_accepts": 0,
        "nonaccepted_rows": 100,
        "per_organ": {"liver": {"rows": 1024, "correct": 1024}},
    }
    gates = wording.promotion_gates(metric, metric)
    gates.update({"runtime_" + k: v for k, v in list(gates.items())})
    evaluation = {
        "passed": True,
        "gates": gates,
        "audit": metric,
        "challenge": metric,
        "runtime_audit": metric,
        "runtime_challenge": metric,
        "dataset_release_sha256": identity["dataset_release_sha256"],
        "source_hashes": identity["source_hashes"],
        "adapter_artifact_hashes": adapter_hashes,
        "training_report_sha256": wording.digest(out / "training_report.json"),
    }
    wording.atomic_json(out / "evaluation.json", evaluation)
    hashes = {
        **adapter_hashes,
        **{
            n: wording.digest(out / n)
            for n in ("training_report.json", "evaluation.json", "dataset_release.json")
        },
    }
    manifest = {
        "format": wording.FORMAT,
        "identity": identity,
        "promoted": True,
        "artifact_hashes": hashes,
    }
    wording.atomic_json(out / "manifest.json", manifest)
    return manifest


def test_real_tokenizer_artifact_names_and_weight_bound_evaluation(tmp_path):
    manifest = _contract_fixture(tmp_path)
    assert wording.verify_adapter(tmp_path)["promoted"]
    # Even an internally checksum-consistent adapter cannot borrow another run's evaluation.
    target = tmp_path / "adapter/adapter_model.safetensors"
    target.write_bytes(b"changed-contract-fixture")
    manifest["artifact_hashes"]["adapter/adapter_model.safetensors"] = wording.digest(target)
    wording.atomic_json(tmp_path / "manifest.json", manifest)
    with pytest.raises(ValueError, match="different weights"):
        wording.verify_adapter(tmp_path)


def test_runtime_generation_scores_are_independently_gated(tmp_path):
    manifest = _contract_fixture(tmp_path)
    evaluation = wording.strict_json((tmp_path / "evaluation.json").read_text())
    evaluation["runtime_audit"]["operations_accuracy"] = 0.2
    wording.atomic_json(tmp_path / "evaluation.json", evaluation)
    manifest["artifact_hashes"]["evaluation.json"] = wording.digest(tmp_path / "evaluation.json")
    wording.atomic_json(tmp_path / "manifest.json", manifest)
    with pytest.raises(ValueError, match="thresholds failed"):
        wording.verify_adapter(tmp_path)
