"""Evaluate an explicitly early-stopped wording checkpoint without rewriting its run.

The frozen trainer and its completion contract remain unchanged. This separate
format records actual/planned work and requires the same generation quality gates.
"""
from __future__ import annotations

import argparse
import math
import os
import re
import shutil
import zipfile
from pathlib import Path

import torch

from . import atlas_wording as original

FORMAT = "viscera-atlas-wording-snapshot-v1"
POLICY = "explicit-early-stop-original-generation-gates-1"


def helper_sha() -> str:
    return original.digest(Path(__file__))


def _checkpoint_contract(identity: dict, report: dict, release: dict, root=None) -> None:
    cfg = identity.get("config", {})
    rows = release.get("counts", {}).get("train", 0)
    if (
        identity.get("format") != original.FORMAT
        or identity.get("tiny_fixture") is not False
        or identity.get("base_model") != original.BASE_MODEL
        or identity.get("base_revision") != original.BASE_REVISION
        or identity.get("source_hashes") != original.source_hashes(root)
        or cfg.get("model_id") != original.BASE_MODEL
        or cfg.get("revision") != original.BASE_REVISION
        or cfg.get("max_steps") is not None
        or rows < 10000
    ):
        raise ValueError("Snapshot requires a real unchanged full-profile training run")
    for key in ("batch_size", "accumulation", "epochs"):
        if type(cfg.get(key)) is not int or cfg[key] < 1:
            raise ValueError("Invalid parent training configuration")
    batch = cfg["batch_size"] * cfg["accumulation"]
    planned = math.ceil(rows * cfg["epochs"] / batch)
    step = report.get("steps")
    if (
        type(step) is not int or not 0 < step < planned
        or report.get("planned_steps") != planned
        or report.get("training_rows") != rows
        or report.get("examples_seen") != step * batch
        or report["examples_seen"] < rows
        or report.get("stopped_early") is not True
        or report.get("training_complete") is not False
        or report.get("pretrained_base_loaded") is not True
        or report.get("status") != "early_stopped_checkpoint_candidate"
        or not isinstance(report.get("stop_reason"), str)
        or not 1 <= len(report["stop_reason"].strip()) <= 1000
        or not re.fullmatch(r"[a-f0-9]{64}", report.get("parent_checkpoint_sha256", ""))
    ):
        raise ValueError("Snapshot actual/planned training provenance is inconsistent")


def freeze(data: Path, checkpoint: Path, out: Path, reason: str, device: str = "cuda") -> dict:
    """Convert a separately copied immutable checkpoint; never alter the parent run."""
    from peft import LoraConfig, get_peft_model

    if out.exists():
        raise ValueError("Snapshot output already exists; choose a new candidate directory")
    checkpoint_sha = original.digest(checkpoint)
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if original.digest(checkpoint) != checkpoint_sha:
        raise ValueError("Checkpoint changed during snapshot; copy a stable checkpoint first")
    identity = state["identity"]
    release = original.strict_json((data / "release.json").read_text())
    if original.digest(data / "release.json") != identity["dataset_release_sha256"]:
        raise ValueError("Parent dataset release changed")
    for split in ("train", "val"):
        actual = original.digest(data / (split + ".jsonl"))
        if actual != identity[split + "_sha256"] or actual != release["artifact_hashes"][split + ".jsonl"]:
            raise ValueError("Parent training partition changed")
    cfg = original.WordingConfig(**identity["config"])
    rows = release["counts"]["train"]
    report = {
        "identity": identity, "status": "early_stopped_checkpoint_candidate",
        "training_complete": False, "stopped_early": True, "stop_reason": reason,
        "steps": state["step"],
        "planned_steps": math.ceil(rows * cfg.epochs / (cfg.batch_size * cfg.accumulation)),
        "training_rows": rows, "examples_seen": state["examples_seen"],
        "pretrained_base_loaded": True, "parent_checkpoint_sha256": checkpoint_sha,
        "last_training_loss": state["losses"][-1],
        "snapshot_policy": POLICY, "snapshot_helper_sha256": helper_sha(),
        "parent_run_modified": False,
        "scope": "Early-stopped synthetic wording adapter; completion and clinical validity are not claimed",
    }
    _checkpoint_contract(identity, report, release)
    base, tokenizer = original._factory(cfg, original.inference_device(device))
    model = get_peft_model(base, LoraConfig(
        task_type="CAUSAL_LM", r=cfg.rank, lora_alpha=cfg.alpha, lora_dropout=0.0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    ))
    if not state["adapter"] or any(not torch.isfinite(t).all() for t in state["adapter"].values()):
        raise ValueError("Checkpoint adapter tensors are empty or nonfinite")
    missing, unexpected = model.load_state_dict(state["adapter"], strict=False)
    if unexpected or any("lora_" in name for name in missing):
        raise ValueError("Checkpoint adapter keys do not match the pinned model")
    out.mkdir(parents=True)
    model.save_pretrained(out / "adapter", safe_serialization=True)
    tokenizer.save_pretrained(out / "adapter")
    shutil.copyfile(data / "release.json", out / "dataset_release.json")
    original.atomic_json(out / "training_report.json", report)
    hashes = {str(p.relative_to(out)): original.digest(p) for p in (out / "adapter").rglob("*") if p.is_file()}
    hashes.update({name: original.digest(out / name) for name in ("training_report.json", "dataset_release.json")})
    original.atomic_json(out / "manifest.json", {
        "format": FORMAT, "identity": identity, "artifact_hashes": hashes,
        "promoted": False, "snapshot_policy": POLICY, "snapshot_helper_sha256": helper_sha(),
    })
    verify_adapter(out, require_promoted=False)
    return report


def verify_adapter(out: Path, root=None, *, require_promoted: bool = True) -> dict:
    manifest = original.strict_json((out / "manifest.json").read_text())
    if (manifest.get("format") != FORMAT or manifest.get("snapshot_policy") != POLICY
            or manifest.get("snapshot_helper_sha256") != helper_sha()):
        raise ValueError("Snapshot format/policy/helper identity mismatch")
    hashes = manifest.get("artifact_hashes", {})
    required = {"adapter/adapter_model.safetensors", "adapter/adapter_config.json", "adapter/tokenizer.json",
                "adapter/tokenizer_config.json", "training_report.json", "dataset_release.json"}
    if not required <= hashes.keys():
        raise ValueError("Snapshot is missing inert artifacts or provenance")
    actual = {str(p.relative_to(out)) for p in (out / "adapter").rglob("*") if p.is_file()}
    if actual != {name for name in hashes if name.startswith("adapter/")}:
        raise ValueError("Unexpected snapshot adapter files")
    for name, expected in hashes.items():
        path = out / name
        if (not path.resolve().is_relative_to(out.resolve()) or path.is_symlink()
                or path.suffix not in {".json", ".txt", ".safetensors", ".jinja", ".md"}
                or original.digest(path) != expected):
            raise ValueError("Snapshot artifact path or checksum mismatch")
    identity = manifest["identity"]
    report = original.strict_json((out / "training_report.json").read_text())
    release = original.strict_json((out / "dataset_release.json").read_text())
    if (report.get("identity") != identity or report.get("snapshot_policy") != POLICY
            or report.get("snapshot_helper_sha256") != helper_sha()
            or original.digest(out / "dataset_release.json") != identity["dataset_release_sha256"]):
        raise ValueError("Snapshot training/dataset provenance mismatch")
    _checkpoint_contract(identity, report, release, root)
    config = original.strict_json((out / "adapter/adapter_config.json").read_text())
    if (config.get("base_model_name_or_path") != original.BASE_MODEL
            or config.get("peft_type") != "LORA" or config.get("task_type") != "CAUSAL_LM"
            or config.get("r") != identity["config"]["rank"]
            or config.get("lora_alpha") != identity["config"]["alpha"]):
        raise ValueError("Snapshot adapter configuration mismatch")
    if require_promoted:
        if manifest.get("promoted") is not True or "evaluation.json" not in hashes:
            raise ValueError("Snapshot has not passed independent evaluation")
        evaluation = original.strict_json((out / "evaluation.json").read_text())
        if (evaluation.get("format") != FORMAT
                or evaluation.get("snapshot_helper_sha256") != helper_sha()
                or evaluation.get("parent_checkpoint_sha256") != report["parent_checkpoint_sha256"]
                or evaluation.get("adapter_artifact_hashes") != {k: v for k, v in hashes.items() if k.startswith("adapter/")}
                or evaluation.get("training_report_sha256") != original.digest(out / "training_report.json")
                or evaluation.get("source_hashes") != identity["source_hashes"]
                or evaluation.get("dataset_release_sha256") != identity["dataset_release_sha256"]):
            raise ValueError("Snapshot evaluation belongs to different weights or provenance")
        gates = original.promotion_gates(evaluation["audit"], evaluation["challenge"])
        gates.update({"runtime_" + k: v for k, v in original.promotion_gates(evaluation["runtime_audit"], evaluation["runtime_challenge"]).items()})
        if evaluation.get("passed") is not True or evaluation.get("gates") != gates or not all(gates.values()):
            raise ValueError("Original independent generation thresholds failed")
        if (evaluation["challenge"]["rows"] != release["challenge"]["rows"]
                or len(evaluation.get("audit_example_ids", [])) != evaluation["audit"]["rows"]
                or len(evaluation.get("challenge_example_ids", [])) != evaluation["challenge"]["rows"]):
            raise ValueError("Snapshot evaluation coverage is incomplete")
    return manifest


def load_adapter(out: Path, device: str = "auto", *, require_promoted: bool = True):
    from peft import PeftModel
    from transformers import AutoTokenizer

    verify_adapter(out, require_promoted=require_promoted)
    device = original.inference_device(device)
    base, _ = original._factory(original.WordingConfig(), device)
    tokenizer = AutoTokenizer.from_pretrained(out / "adapter", trust_remote_code=False, local_files_only=True)
    return PeftModel.from_pretrained(base, out / "adapter", is_trainable=False).to(device).eval(), tokenizer


def evaluate(data: Path, out: Path, *, limit: int = 512, device: str = "cuda") -> dict:
    from viscera_core.atlas_semantic import validate_plan

    if limit < 512:
        raise ValueError("Snapshot retains the original minimum 512-example audit")
    manifest = verify_adapter(out, require_promoted=False)
    identity = manifest["identity"]
    if original.digest(data / "release.json") != identity["dataset_release_sha256"]:
        raise ValueError("Evaluation dataset changed")
    partitions = [original.read_split(data, s) for s in ("train", "val", "audit", "challenge")]
    original.audit_disjoint(*partitions)
    audit, challenge = partitions[2:]
    original.validate_gold_rows(audit)
    original.validate_gold_rows(challenge)
    selected = original.subset(audit, limit, identity["config"]["seed"] + 1)
    del partitions, audit
    device = original.inference_device(device)
    model, tokenizer = load_adapter(out, device, require_promoted=False)
    outputs = original.predictions(model, tokenizer, selected, device)
    challenge_outputs = original.predictions(model, tokenizer, challenge, device)

    def guarded(rows, values):
        checked = []
        for row, value in zip(rows, values, strict=True):
            try:
                original.normalized_plan(original.strict_json(value), row["context"])
                checked.append(original.canonical(validate_plan(original.strict_json(value), row["context"], text=row["text"])))
            except (ValueError, TypeError, KeyError):
                checked.append("{}")
        return original.score(rows, checked)

    raw_audit, raw_challenge = original.score(selected, outputs), original.score(challenge, challenge_outputs)
    runtime_audit, runtime_challenge = guarded(selected, outputs), guarded(challenge, challenge_outputs)
    gates = original.promotion_gates(raw_audit, raw_challenge)
    gates.update({"runtime_" + k: v for k, v in original.promotion_gates(runtime_audit, runtime_challenge).items()})
    report = original.strict_json((out / "training_report.json").read_text())
    result = {
        "format": FORMAT, "snapshot_helper_sha256": helper_sha(), "passed": all(gates.values()), "gates": gates,
        "audit": raw_audit, "challenge": raw_challenge,
        "runtime_audit": runtime_audit, "runtime_challenge": runtime_challenge,
        "adapter_artifact_hashes": {k: v for k, v in manifest["artifact_hashes"].items() if k.startswith("adapter/")},
        "training_report_sha256": original.digest(out / "training_report.json"),
        "parent_checkpoint_sha256": report["parent_checkpoint_sha256"],
        "source_hashes": identity["source_hashes"], "dataset_release_sha256": identity["dataset_release_sha256"],
        "audit_example_ids": [r["id"] for r in selected], "challenge_example_ids": [r["id"] for r in challenge],
        "selection": "Original fixed stratified audit seed and complete challenge; no gradient updates or threshold changes",
        "scope": "Explicitly early-stopped synthetic wording model; not full training completion or clinical validation",
    }
    original.atomic_json(out / "evaluation.json", result)
    return result


def export(out: Path, destination: Path) -> Path:
    original_manifest = verify_adapter(out, require_promoted=False)
    manifest = original.strict_json(original.canonical(original_manifest))
    manifest["promoted"] = True
    manifest["artifact_hashes"]["evaluation.json"] = original.digest(out / "evaluation.json")
    original.atomic_json(out / "manifest.json", manifest)
    try:
        verify_adapter(out)
    except Exception:
        original.atomic_json(out / "manifest.json", original_manifest)
        raise
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in sorted(["manifest.json", *manifest["artifact_hashes"]]):
            archive.write(out / name, f"{original.ARCHIVE_PREFIX}/{name}")
    os.replace(temporary, destination)
    original.atomic_json(destination.with_suffix(".sha256.json"), {"format": FORMAT, "sha256": original.digest(destination), "filename": destination.name})
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("freeze", "evaluate", "export"))
    parser.add_argument("--data", type=Path)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--reason", default="Explicit early-stop candidate selected before held-out evaluation")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--limit", type=int, default=512)
    parser.add_argument("--destination", type=Path)
    args = parser.parse_args()
    if args.action == "freeze":
        if args.data is None or args.checkpoint is None:
            parser.error("freeze requires --data and --checkpoint")
        result = freeze(args.data, args.checkpoint, args.out, args.reason, args.device)
    elif args.action == "evaluate":
        if args.data is None:
            parser.error("evaluate requires --data")
        result = evaluate(args.data, args.out, limit=args.limit, device=args.device)
    else:
        if args.destination is None:
            parser.error("export requires --destination")
        result = {"archive": str(export(args.out, args.destination))}
    print(original.canonical(result), flush=True)


if __name__ == "__main__":
    main()
