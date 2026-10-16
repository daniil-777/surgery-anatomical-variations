"""Explicit, parity-checked batching for the frozen wording evaluation contract.

No training or semantic source is patched. Validation establishes exact greedy
output parity before either final test partition is opened. A mismatch uses the
original sequential generator and is retained in the execution report.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import torch

from pipelines.train.viscera_train import atlas_wording as original


def predictions_batched(model, tokenizer, rows, device, batch_size=8, maximum_new_tokens=384):
    if type(batch_size) is not int or not 1 <= batch_size <= 32:
        raise ValueError("Generation batch size must be 1..32")
    if tokenizer.pad_token_id is None:
        raise ValueError("A defined padding token is required")
    result = []
    model.eval()
    with torch.inference_mode():
        for start in range(0, len(rows), batch_size):
            chunk = rows[start:start + batch_size]
            encoded = [tokenizer.apply_chat_template(
                original.messages(row), tokenize=True, add_generation_prompt=True,
            ) for row in chunk]
            width = max(map(len, encoded))
            inputs = torch.full((len(chunk), width), tokenizer.pad_token_id,
                                dtype=torch.long, device=device)
            attention = torch.zeros_like(inputs)
            for index, ids in enumerate(encoded):
                inputs[index, width - len(ids):] = torch.tensor(ids, device=device)
                attention[index, width - len(ids):] = 1
            outputs = model.generate(
                input_ids=inputs, attention_mask=attention,
                max_new_tokens=maximum_new_tokens, do_sample=False, use_cache=True,
                pad_token_id=tokenizer.pad_token_id,
            )
            result.extend(tokenizer.decode(row[width:], skip_special_tokens=True) for row in outputs)
            print(f"Generated {len(result)}/{len(rows)} held-out plans (batch {batch_size})", flush=True)
    return result


def evaluate(data: Path, out: Path, *, limit=512, device="cuda", batch_size=8, parity_count=16):
    from viscera_core.atlas_semantic import validate_plan

    if limit < 512 or parity_count < 16:
        raise ValueError("Retain at least 512 audit cases and 16 pre-audit parity cases")
    if (out / "evaluation.json").exists():
        raise ValueError("Preserve the existing evaluation; do not rerun or overwrite it")
    manifest = original.verify_adapter(out, require_promoted=False)
    report = original.strict_json((out / "training_report.json").read_text())
    identity = report["identity"]
    release = original.strict_json((data / "release.json").read_text())
    expected_execution = {
        "helper_sha256": original.digest(Path(__file__)),
        "method": "left_padded_greedy_batch_v1", "batch_size": batch_size,
        "validation_parity_rows": parity_count, "audit_limit": limit,
        "fallback": "original_sequential_on_any_parity_mismatch",
    }
    if release.get("evaluation_contract") != expected_execution:
        raise ValueError("Evaluation execution differs from the pre-training frozen release")
    if (identity.get("tiny_fixture") is not False
            or identity != manifest["identity"]
            or report.get("pretrained_base_loaded") is not True
            or report.get("steps") != report.get("required_steps")
            or report.get("training_rows", 0) < 10000
            or report.get("examples_seen", 0) < report.get("training_rows", 0)
            or original.digest(data / "release.json") != identity["dataset_release_sha256"]):
        raise ValueError("Complete real pretrained training and unchanged release required")
    train, validation = (original.read_split(data, name) for name in ("train", "val"))
    original.audit_disjoint(train, validation)
    parity_rows = original.subset(validation, parity_count, identity["config"]["seed"] + 901)
    model, tokenizer = original.load_adapter(out, device, require_promoted=False)
    sequential = original.predictions(model, tokenizer, parity_rows, device)
    batched = predictions_batched(model, tokenizer, parity_rows, device, batch_size)
    agreement = [a == b for a, b in zip(sequential, batched, strict=True)]
    execution = {
        "method": "left_padded_greedy_batch" if all(agreement) else "original_sequential_after_parity_mismatch",
        "helper_sha256": original.digest(Path(__file__)), "requested_batch_size": batch_size,
        "maximum_new_tokens": 384, "do_sample": False,
        "parity_checked_before_opening_audit": True,
        "parity_example_ids": [row["id"] for row in parity_rows],
        "parity_rows": len(parity_rows), "exact_output_matches": sum(agreement),
        "parity_scope": "Exact decoded text on fixed validation cases; not universal numerical equivalence",
    }
    original.atomic_json(out / "generation-parity.json", execution)
    print(original.canonical(execution), flush=True)
    # These partitions are opened only after the acceleration decision is fixed.
    audit, challenge = (original.read_split(data, name) for name in ("audit", "challenge"))
    original.audit_disjoint(train, validation, audit, challenge)
    original.validate_gold_rows(audit)
    original.validate_gold_rows(challenge)
    selected = original.subset(audit, limit, identity["config"]["seed"] + 1)
    del train, validation, audit
    def generate(rows):
        return (predictions_batched(model, tokenizer, rows, device, batch_size)
                if all(agreement) else original.predictions(model, tokenizer, rows, device))
    audit_outputs, challenge_outputs = generate(selected), generate(challenge)
    def guarded(rows, values):
        checked = []
        for row, value in zip(rows, values, strict=True):
            try:
                original.normalized_plan(original.strict_json(value), row["context"])
                checked.append(original.canonical(validate_plan(
                    original.strict_json(value), row["context"], text=row["text"],
                )))
            except (ValueError, TypeError, KeyError):
                checked.append("{}")
        return original.score(rows, checked)
    raw_audit, raw_challenge = original.score(selected, audit_outputs), original.score(challenge, challenge_outputs)
    runtime_audit, runtime_challenge = guarded(selected, audit_outputs), guarded(challenge, challenge_outputs)
    gates = original.promotion_gates(raw_audit, raw_challenge)
    gates.update({"runtime_" + k: v for k, v in original.promotion_gates(runtime_audit, runtime_challenge).items()})
    result = {
        "format": original.FORMAT, "passed": all(gates.values()), "gates": gates,
        "audit": raw_audit, "challenge": raw_challenge,
        "runtime_audit": runtime_audit, "runtime_challenge": runtime_challenge,
        "adapter_artifact_hashes": {k: v for k, v in manifest["artifact_hashes"].items() if k.startswith("adapter/")},
        "training_report_sha256": original.digest(out / "training_report.json"),
        "source_hashes": original.source_hashes(),
        "audit_example_ids": [row["id"] for row in selected],
        "challenge_example_ids": [row["id"] for row in challenge],
        "dataset_release_sha256": identity["dataset_release_sha256"],
        "generation_execution": execution,
        "evaluation_contract": expected_execution,
        "selection": "Original fixed organ/status stratifier; complete fresh challenge; no gradient updates",
        "scope": "Synthetic visual-authoring language benchmark; not clinical or unrestricted language validation",
    }
    original.atomic_json(out / "evaluation.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()
    result = evaluate(args.data, args.out, device=args.device, batch_size=args.batch_size)
    print(original.canonical({"passed": result["passed"], "gates": result["gates"]}), flush=True)
