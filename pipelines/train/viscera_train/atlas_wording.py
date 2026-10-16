"""Wording v2: pretrained Qwen LoRA -> bounded, independently validated edit plans.

Training never reads the audit/challenge partitions. Export requires free-running
held-out generation; teacher-forced loss alone is not an acceptance test.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import shutil
import zipfile
from dataclasses import asdict, dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any, Callable

import numpy as np
import torch

BASE_MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
BASE_REVISION = "c89bee90d9f811437d9735454613c35b4a3c4dc8"
FORMAT = "viscera-atlas-wording-adapter-v2"
ARCHIVE_PREFIX = "viscera-wording-weights"
SYSTEM = """Translate anatomy-authoring requests into one JSON edit plan, without markdown.
Schema: {"schema_version":"atlas-semantic-1","status":"accepted|clarify|unsupported","operations":[],"message":"brief explanation","interpretation":"authored_visual_design_not_clinical_inference"}.
Operations: disease_relative, disease_clear, disease_set, shape_relative, shape_absolute, control_set, material_relative, material_set, appearance_set, preserve. Each has op and optional field/value. Relative numbers are fractions; shape_absolute is millimetres. Preserve unmentioned properties. Healthier means reduce existing authored disease features; a healthy baseline stays unchanged. Never infer pathology, treatment, resectability, diagnosis, or physical tissue mechanics from appearance. Ask to clarify ambiguous or conflicting edits. Unsupported cutting, resection, new topology and unmodelled features must never become an approximate shape edit. Output only operations supported by the supplied context and bounds."""
SOURCE_FILES = (
    "py/viscera_core/atlas_semantic.py",
    "py/viscera_core/disease_profiles_v2.json",
    "py/viscera_core/disease_profiles.json",
    "pipelines/train/viscera_train/atlas_wording.py",
)


def canonical(value: Any) -> str:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(canonical(value) + "\n")
    os.replace(temporary, path)


def strict_json(text: str) -> dict:
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("Duplicate JSON key")
            value[key] = item
        return value

    def constant(value):
        raise ValueError("Nonfinite JSON value")

    value = json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(value, dict):
        raise ValueError("Plan must be a JSON object")
    return value


def source_hashes(root: Path | None = None) -> dict[str, str]:
    root = root or Path(__file__).resolve().parents[3]
    return {name: digest(root / name) for name in SOURCE_FILES}


def normalized_plan(plan: dict, context: dict) -> dict:
    from viscera_core.atlas_semantic import plan_fingerprint, validate_plan

    if (
        not isinstance(plan, dict)
        or set(plan) != {"schema_version", "status", "operations", "message", "interpretation"}
        or not isinstance(plan["operations"], list)
    ):
        raise ValueError("Incomplete plan schema")
    if plan["status"] != "accepted" and plan["operations"]:
        raise ValueError("Refusal cannot contain partial operations")
    checked = validate_plan(plan, context)
    if plan_fingerprint(checked) != plan_fingerprint(plan):
        raise ValueError("Invalid plan was rejected or altered by the bound validator")
    result = {
        key: checked[key] for key in ("schema_version", "status", "operations", "interpretation")
    }
    result["operations"] = sorted(result["operations"], key=canonical)
    return result


def messages(row: dict) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": canonical({"context": row["context"], "request": row["text"]})},
    ]


def read_split(data: Path, split: str) -> list[dict]:
    if split not in {"train", "val", "audit", "challenge"}:
        raise ValueError("Unknown wording partition")
    release = strict_json((data / "release.json").read_text())
    filename = split + ".jsonl"
    if release.get("artifact_hashes", {}).get(filename) != digest(data / filename):
        raise ValueError("Dataset partition checksum mismatch: " + split)
    result, ids = [], set()
    with (data / filename).open() as handle:
        for line in handle:
            if not line.strip():
                continue
            row = strict_json(line)
            if row.get("split") != split or not all(
                isinstance(row.get(k), str) and row[k] for k in ("id", "family_id", "text")
            ):
                raise ValueError("Invalid wording partition identity")
            if row["id"] in ids:
                raise ValueError("Duplicate example identity")
            ids.add(row["id"])
            normalized_plan(row["target"], row["context"])
            result.append(row)
    if not result:
        raise ValueError("Empty wording partition")
    return result


def audit_disjoint(*partitions: list[dict]) -> None:
    for i, left in enumerate(partitions):
        for right in partitions[i + 1 :]:
            for key in ("id", "family_id"):
                if {r[key] for r in left} & {r[key] for r in right}:
                    raise ValueError("Partition leakage: " + key)
            if {r["text"].strip().casefold() for r in left} & {
                r["text"].strip().casefold() for r in right
            }:
                raise ValueError("Partition leakage: text")


def validate_gold_rows(rows: list[dict]) -> None:
    """Reject inconsistent supervision before GPU work; never rewrite a label."""
    from viscera_core.atlas_semantic import plan_fingerprint, validate_plan

    for row in rows:
        checked = validate_plan(row["target"], row["context"], text=row["text"])
        if plan_fingerprint(checked) != plan_fingerprint(row["target"]):
            raise ValueError(
                f"Gold/runtime contract mismatch for {row['id']}: {checked.get('message')}"
            )


def encode_row(tokenizer: Any, row: dict, maximum_tokens: int) -> dict:
    prefix = tokenizer.apply_chat_template(messages(row), tokenize=True, add_generation_prompt=True)
    target = dict(row["target"])
    full = tokenizer.apply_chat_template(
        messages(row) + [{"role": "assistant", "content": canonical(target)}],
        tokenize=True,
        add_generation_prompt=False,
    )
    if full[: len(prefix)] != prefix or len(full) <= len(prefix):
        raise ValueError("Tokenizer changed the assistant prefix")
    if len(full) > maximum_tokens:
        raise ValueError(
            f"Row {row['id']} requires {len(full)} tokens; target truncation is forbidden"
        )
    return {"input_ids": full, "labels": [-100] * len(prefix) + full[len(prefix) :]}


@dataclass(frozen=True)
class WordingConfig:
    model_id: str = BASE_MODEL
    revision: str = BASE_REVISION
    epochs: int = 2
    max_steps: int | None = None
    batch_size: int = 4
    accumulation: int = 8
    learning_rate: float = 0.0002
    rank: int = 16
    alpha: int = 32
    maximum_tokens: int = 1536
    checkpoint_every: int = 100
    seed: int = 20261007
    device: str = "auto"
    gradient_checkpointing: bool = True
    validation_limit: int = 256


def _factory(cfg: WordingConfig, device: str):
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(
        cfg.model_id, revision=cfg.revision, trust_remote_code=False
    )
    tokenizer.pad_token = tokenizer.eos_token
    dtype = (
        (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16)
        if device == "cuda"
        else torch.float32
    )
    model = AutoModelForCausalLM.from_pretrained(
        cfg.model_id,
        revision=cfg.revision,
        trust_remote_code=False,
        use_safetensors=True,
        torch_dtype=dtype,
    ).to(device)
    return model, tokenizer


def collate(encoded: list[dict], pad: int, device: str) -> dict:
    encoded = [
        {
            key: value.tolist() if isinstance(value, np.ndarray) else value
            for key, value in row.items()
        }
        for row in encoded
    ]
    length = max(len(row["input_ids"]) for row in encoded)
    return {
        "input_ids": torch.tensor(
            [r["input_ids"] + [pad] * (length - len(r["input_ids"])) for r in encoded],
            dtype=torch.long,
            device=device,
        ),
        "labels": torch.tensor(
            [r["labels"] + [-100] * (length - len(r["labels"])) for r in encoded],
            dtype=torch.long,
            device=device,
        ),
        "attention_mask": torch.tensor(
            [[1] * len(r["input_ids"]) + [0] * (length - len(r["input_ids"])) for r in encoded],
            dtype=torch.long,
            device=device,
        ),
    }


def subset(rows: list[dict], count: int, seed: int) -> list[dict]:
    """Round-robin status/organ coverage selected before seeing predictions."""
    buckets: dict[tuple, list[dict]] = {}
    for row in rows:
        key = (row["target"]["status"], row["context"].get("organ", "unknown"))
        buckets.setdefault(key, []).append(row)
    rng = np.random.default_rng(seed)
    for values in buckets.values():
        rng.shuffle(values)
    output = []
    while len(output) < min(count, len(rows)):
        for key in sorted(buckets):
            if buckets[key] and len(output) < count:
                output.append(buckets[key].pop())
    return output


def predictions(
    model: Any, tokenizer: Any, rows: list[dict], device: str, maximum_new_tokens: int = 384
) -> list[str]:
    model.eval()
    result = []
    with torch.inference_mode():
        for index, row in enumerate(rows):
            ids = tokenizer.apply_chat_template(
                messages(row), tokenize=True, add_generation_prompt=True
            )
            inputs = torch.tensor([ids], dtype=torch.long, device=device)
            output = model.generate(
                input_ids=inputs,
                attention_mask=torch.ones_like(inputs),
                max_new_tokens=maximum_new_tokens,
                do_sample=False,
                use_cache=True,
                pad_token_id=tokenizer.pad_token_id,
            )
            result.append(tokenizer.decode(output[0, len(ids) :], skip_special_tokens=True))
            if (index + 1) % 50 == 0:
                print(f"Generated {index + 1}/{len(rows)} held-out plans", flush=True)
    return result


def score(rows: list[dict], outputs: list[str]) -> dict:
    if not rows or len(rows) != len(outputs):
        raise ValueError("Aligned nonempty predictions required")
    counts = {
        "rows": len(rows),
        "valid": 0,
        "status_correct": 0,
        "operations_correct": 0,
        "false_accepts": 0,
        "nonaccepted_rows": 0,
    }
    per_organ, per_status, failures = {}, {}, []
    for row, output in zip(rows, outputs, strict=True):
        expected = normalized_plan(row["target"], row["context"])
        organ = row["context"].get("organ", "unknown")
        group = per_organ.setdefault(organ, {"rows": 0, "correct": 0})
        confusion = per_status.setdefault(expected["status"], {})
        group["rows"] += 1
        counts["nonaccepted_rows"] += expected["status"] != "accepted"
        actual, correct = None, False
        try:
            actual = normalized_plan(strict_json(output), row["context"])
            counts["valid"] += 1
            counts["status_correct"] += actual["status"] == expected["status"]
            counts["false_accepts"] += (
                actual["status"] == "accepted" and expected["status"] != "accepted"
            )
            correct = actual == expected
            counts["operations_correct"] += correct
            group["correct"] += correct
        except (ValueError, TypeError, KeyError):
            pass
        label = actual["status"] if actual else "invalid"
        confusion[label] = confusion.get(label, 0) + 1
        if not correct and len(failures) < 80:
            failures.append(
                {
                    "id": row["id"],
                    "text": row["text"],
                    "expected": expected,
                    "actual": actual,
                    "raw": output[:1600],
                }
            )
    return {
        **counts,
        "valid_fraction": counts["valid"] / len(rows),
        "status_accuracy": counts["status_correct"] / len(rows),
        "operations_accuracy": counts["operations_correct"] / len(rows),
        "per_organ": per_organ,
        "status_confusion": per_status,
        "failures": failures,
    }


def train(
    data: Path,
    out: Path,
    cfg: WordingConfig = WordingConfig(),
    *,
    resume: bool = False,
    stop_after: int | None = None,
    factory: Callable | None = None,
    generate_validation: bool = True,
) -> dict:
    from peft import LoraConfig, get_peft_model

    if cfg.model_id != BASE_MODEL or cfg.revision != BASE_REVISION:
        raise ValueError("Unreviewed pretrained base identity")
    if (
        min(
            cfg.epochs,
            cfg.batch_size,
            cfg.accumulation,
            cfg.rank,
            cfg.alpha,
            cfg.maximum_tokens,
            cfg.checkpoint_every,
            cfg.validation_limit,
        )
        < 1
        or cfg.learning_rate <= 0
        or not math.isfinite(cfg.learning_rate)
    ):
        raise ValueError("Invalid training configuration")
    if cfg.max_steps is not None and cfg.max_steps < 1:
        raise ValueError("max_steps must be positive")
    device = (
        ("cuda" if torch.cuda.is_available() else "cpu") if cfg.device == "auto" else cfg.device
    )
    if device not in {"cpu", "cuda"}:
        raise ValueError("Use cpu/cuda/auto")
    if factory is None and device != "cuda":
        raise ValueError(
            "Full wording training requires a Colab GPU; use smoke for CPU verification"
        )
    torch.set_num_threads(1 if device == "cpu" else 4)
    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed)
    release = strict_json((data / "release.json").read_text())
    if factory is None:
        recorded = release.get("source_hashes", {})
        actual_sources = source_hashes()
        required_sources = set(SOURCE_FILES) - {"pipelines/train/viscera_train/atlas_wording.py"}
        if not required_sources <= recorded.keys() or any(
            actual_sources.get(name) != expected for name, expected in recorded.items()
        ):
            raise ValueError("Dataset semantic source changed; rebuild the frozen release")
    rows, validation = read_split(data, "train"), read_split(data, "val")
    audit_disjoint(rows, validation)
    if factory is None:
        validate_gold_rows(rows)
        validate_gold_rows(validation)
    base, tokenizer = (factory or _factory)(cfg, device)
    base.config.use_cache = False
    model = get_peft_model(
        base,
        LoraConfig(
            task_type="CAUSAL_LM",
            r=cfg.rank,
            lora_alpha=cfg.alpha,
            lora_dropout=0.0,
            target_modules=[
                "q_proj",
                "k_proj",
                "v_proj",
                "o_proj",
                "gate_proj",
                "up_proj",
                "down_proj",
            ],
        ),
    )
    if cfg.gradient_checkpointing:
        model.enable_input_require_grads()
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad], lr=cfg.learning_rate
    )
    scaler = torch.amp.GradScaler(
        "cuda", enabled=device == "cuda" and not torch.cuda.is_bf16_supported()
    )
    identity = {
        "format": FORMAT,
        "config": asdict(cfg),
        "source_hashes": source_hashes(),
        "dataset_release_sha256": digest(data / "release.json"),
        "train_sha256": digest(data / "train.jsonl"),
        "val_sha256": digest(data / "val.jsonl"),
        "dependencies": {
            n: version(n)
            for n in (
                "torch",
                "transformers",
                "peft",
                "accelerate",
                "tokenizers",
                "safetensors",
                "numpy",
            )
        },
        "tiny_fixture": factory is not None,
        "base_model": BASE_MODEL,
        "base_revision": BASE_REVISION,
    }
    out.mkdir(parents=True, exist_ok=True)
    checkpoint = out / "checkpoint.pt"
    if checkpoint.exists() and not resume:
        raise ValueError("Existing run: request resume or choose a fresh output")
    # Validate all targets before any optimizer updates; preserve complete answers.
    encoded = [
        {
            key: np.asarray(value, dtype=np.int32)
            for key, value in encode_row(tokenizer, row, cfg.maximum_tokens).items()
        }
        for row in rows
    ]
    selected_validation = subset(validation, cfg.validation_limit, cfg.seed)
    for row in selected_validation:
        encode_row(tokenizer, row, cfg.maximum_tokens)
    training_rows = len(rows)
    del rows
    steps = math.ceil(training_rows * cfg.epochs / (cfg.batch_size * cfg.accumulation))
    if cfg.max_steps:
        steps = min(steps, cfg.max_steps)
    step, cursor, examples_seen = 0, 0, 0
    order, losses = rng.permutation(training_rows), []
    if resume:
        state = torch.load(checkpoint, map_location="cpu", weights_only=True)
        if state["identity"] != identity:
            raise ValueError(
                "Resume identity changed; dataset, source, configuration and dependency pins must match"
            )
        missing, unexpected = model.load_state_dict(state["adapter"], strict=False)
        if unexpected or any("lora_" in k for k in missing):
            raise ValueError("Invalid checkpoint adapter keys")
        optimizer.load_state_dict(state["optimizer"])
        scaler.load_state_dict(state["scaler"])
        rng.bit_generator.state = json.loads(state["numpy_rng"])
        torch.set_rng_state(state["torch_rng"])
        if device == "cuda":
            torch.cuda.set_rng_state_all(state["cuda_rng"])
        step, cursor, examples_seen = state["step"], state["cursor"], state["examples_seen"]
        order, losses = np.asarray(state["order"]), state["losses"]
    baseline_path = out / "baseline_validation.json"
    baseline_rows = selected_validation[: min(96, len(selected_validation))]
    if generate_validation and factory is None:
        if resume:
            baseline = strict_json(baseline_path.read_text())
            if baseline.get("identity") != identity or baseline.get("example_ids") != [
                r["id"] for r in baseline_rows
            ]:
                raise ValueError("Frozen-base comparison provenance changed")
        else:
            print(
                f"Measuring frozen pretrained baseline on {len(baseline_rows)} validation examples",
                flush=True,
            )
            baseline = {
                "identity": identity,
                "example_ids": [r["id"] for r in baseline_rows],
                "score": score(baseline_rows, predictions(model, tokenizer, baseline_rows, device)),
                "used_for_gradient_updates": False,
            }
            atomic_json(baseline_path, baseline)
    for step in range(step + 1, steps + 1):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        total_loss = 0.0
        for _ in range(cfg.accumulation):
            indices = []
            while len(indices) < cfg.batch_size:
                if cursor == len(order):
                    order, cursor = rng.permutation(training_rows), 0
                take = min(cfg.batch_size - len(indices), len(order) - cursor)
                indices.extend(order[cursor : cursor + take])
                cursor += take
            batch = collate([encoded[int(i)] for i in indices], tokenizer.pad_token_id, device)
            amp = (
                torch.autocast(
                    "cuda",
                    dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
                )
                if device == "cuda"
                else contextlib.nullcontext()
            )
            with amp:
                loss = model(**batch).loss / cfg.accumulation
            if not torch.isfinite(loss):
                raise ValueError("Nonfinite training loss")
            scaler.scale(loss).backward()
            total_loss += float(loss.detach().cpu())
            examples_seen += len(indices)
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        warmup = max(1, int(steps * 0.03))
        lr_factor = min(step / warmup, 1.0) * (
            0.1
            + 0.9 * 0.5 * (1 + math.cos(math.pi * max(0, step - warmup) / max(1, steps - warmup)))
        )
        for group in optimizer.param_groups:
            group["lr"] = cfg.learning_rate * lr_factor
        scaler.step(optimizer)
        scaler.update()
        losses.append(total_loss)
        if step % 10 == 0 or step == steps:
            print(
                f"Step {step}/{steps}; loss {total_loss:.5f}; examples {examples_seen}", flush=True
            )
        if step % cfg.checkpoint_every == 0 or step == steps or step == stop_after:
            state = {
                "identity": identity,
                "adapter": {
                    k: v.detach().cpu().clone()
                    for k, v in model.state_dict().items()
                    if "lora_" in k
                },
                "optimizer": optimizer.state_dict(),
                "scaler": scaler.state_dict(),
                "numpy_rng": canonical(rng.bit_generator.state),
                "torch_rng": torch.get_rng_state(),
                "cuda_rng": torch.cuda.get_rng_state_all() if device == "cuda" else [],
                "step": step,
                "cursor": cursor,
                "examples_seen": examples_seen,
                "order": order.tolist(),
                "losses": losses,
            }
            temporary = checkpoint.with_suffix(".tmp")
            torch.save(state, temporary)
            os.replace(temporary, checkpoint)
            atomic_json(
                out / "progress.json",
                {
                    "step": step,
                    "total_steps": steps,
                    "examples_seen": examples_seen,
                    "loss": total_loss,
                },
            )
        if step == stop_after and step < steps:
            return {"status": "interrupted", "step": step}
    model.save_pretrained(out / "adapter", safe_serialization=True)
    tokenizer.save_pretrained(out / "adapter")
    validation_outputs = (
        predictions(model, tokenizer, selected_validation, device) if generate_validation else None
    )
    comparison = {
        "status": "NOT_RUN",
        "reason": "Tiny CPU optimizer test is not a pretrained quality measurement",
    }
    if generate_validation and factory is None:
        matched = score(baseline_rows, validation_outputs[: len(baseline_rows)])
        comparison = {
            "example_ids": baseline["example_ids"],
            "frozen_base": baseline["score"],
            "fine_tuned": matched,
            "operations_accuracy_delta": matched["operations_accuracy"]
            - baseline["score"]["operations_accuracy"],
            "status_accuracy_delta": matched["status_accuracy"]
            - baseline["score"]["status_accuracy"],
            "scope": "Same stratified held-out validation prompts; audit untouched",
        }
    report = {
        "identity": identity,
        "status": "tiny_cpu_smoke" if factory else "awaiting_blind_evaluation",
        "steps": step,
        "required_steps": steps,
        "training_rows": training_rows,
        "validation_rows": len(validation),
        "examples_seen": examples_seen,
        "losses": losses,
        "audit_opened": False,
        "challenge_opened": False,
        "pretrained_base_loaded": factory is None,
        "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "baseline_comparison": comparison,
        "validation": score(selected_validation, validation_outputs)
        if generate_validation
        else {"status": "NOT_RUN", "reason": "CPU smoke exercises optimizer and resume only"},
    }
    shutil.copyfile(data / "release.json", out / "dataset_release.json")
    atomic_json(out / "training_report.json", report)
    atomic_json(
        out / "manifest.json",
        {
            "format": FORMAT,
            "identity": identity,
            "artifact_hashes": {
                str(p.relative_to(out)): digest(p)
                for p in sorted((out / "adapter").rglob("*"))
                if p.is_file()
            },
            "promoted": False,
        },
    )
    return report


def promotion_gates(audit: dict, challenge: dict) -> dict:
    return {
        "audit_size": audit["rows"] >= 512,
        "challenge_size": challenge["rows"] >= 40,
        "audit_json": audit["valid_fraction"] >= 0.99,
        "audit_status": audit["status_accuracy"] >= 0.98,
        "audit_operations": audit["operations_accuracy"] >= 0.92,
        "audit_no_false_accepts": audit["false_accepts"] == 0 and audit["nonaccepted_rows"] >= 50,
        "audit_each_organ": bool(audit["per_organ"])
        and all(
            g["rows"] > 0 and g["correct"] / g["rows"] >= 0.85 for g in audit["per_organ"].values()
        ),
        "challenge_operations": challenge["operations_accuracy"] >= 0.90,
        "challenge_no_false_accepts": challenge["false_accepts"] == 0
        and challenge["nonaccepted_rows"] >= 8,
    }


def verify_adapter(out: Path, root: Path | None = None, *, require_promoted: bool = True) -> dict:
    """Verify inert artifacts, source identity and recomputed promotion thresholds."""
    manifest = strict_json((out / "manifest.json").read_text())
    identity = manifest["identity"]
    if (
        manifest.get("format") != FORMAT
        or identity.get("format") != FORMAT
        or identity.get("tiny_fixture") is not False
        or identity.get("base_model") != BASE_MODEL
        or identity.get("base_revision") != BASE_REVISION
        or identity.get("source_hashes") != source_hashes(root)
    ):
        raise ValueError("Adapter provenance mismatch or tiny smoke weights")
    hashes = manifest.get("artifact_hashes", {})
    required = {
        "adapter/adapter_model.safetensors",
        "adapter/adapter_config.json",
        "adapter/tokenizer.json",
        "adapter/tokenizer_config.json",
    }
    if not required <= hashes.keys():
        raise ValueError("Missing inert adapter/tokenizer artifacts")
    actual = {str(p.relative_to(out)) for p in (out / "adapter").rglob("*") if p.is_file()}
    if actual != {name for name in hashes if name.startswith("adapter/")}:
        raise ValueError("Unexpected adapter file set")
    for name, expected in hashes.items():
        path = out / name
        if (
            not path.resolve().is_relative_to(out.resolve())
            or path.is_symlink()
            or path.suffix not in {".json", ".txt", ".safetensors", ".model", ".jinja", ".md"}
            or digest(path) != expected
        ):
            raise ValueError("Adapter checksum or path mismatch")
    config = strict_json((out / "adapter/adapter_config.json").read_text())
    if (
        config.get("base_model_name_or_path") != BASE_MODEL
        or config.get("peft_type") != "LORA"
        or config.get("task_type") != "CAUSAL_LM"
    ):
        raise ValueError("Adapter base/configuration mismatch")
    if require_promoted:
        if (
            manifest.get("promoted") is not True
            or not {"training_report.json", "evaluation.json", "dataset_release.json"}
            <= hashes.keys()
        ):
            raise ValueError("Adapter has not passed independent evaluation")
        report = strict_json((out / "training_report.json").read_text())
        evaluation = strict_json((out / "evaluation.json").read_text())
        if (
            report.get("identity") != identity
            or report.get("pretrained_base_loaded") is not True
            or report.get("training_rows", 0) < 10000
            or report.get("steps", 0) < 1
            or report.get("steps", 0) != report.get("required_steps")
            or report.get("examples_seen", 0) < report.get("training_rows", 0)
        ):
            raise ValueError("Incomplete pretrained training provenance")
        if (
            digest(out / "dataset_release.json") != identity["dataset_release_sha256"]
            or evaluation.get("dataset_release_sha256") != identity["dataset_release_sha256"]
        ):
            raise ValueError("Evaluation/dataset provenance mismatch")
        if (
            evaluation.get("adapter_artifact_hashes")
            != {k: v for k, v in hashes.items() if k.startswith("adapter/")}
            or evaluation.get("training_report_sha256") != digest(out / "training_report.json")
            or evaluation.get("source_hashes") != identity["source_hashes"]
        ):
            raise ValueError(
                "Evaluation was produced for different weights, source or training report"
            )
        gates = promotion_gates(evaluation["audit"], evaluation["challenge"])
        gates.update(
            {
                "runtime_" + k: v
                for k, v in promotion_gates(
                    evaluation["runtime_audit"], evaluation["runtime_challenge"]
                ).items()
            }
        )
        if (
            evaluation.get("passed") is not True
            or evaluation.get("gates") != gates
            or not all(gates.values())
        ):
            raise ValueError("Independent evaluation thresholds failed")
    return manifest


def inference_device(requested: str = "auto") -> str:
    if requested == "auto":
        return (
            "cuda"
            if torch.cuda.is_available()
            else "mps"
            if torch.backends.mps.is_available()
            else "cpu"
        )
    if requested not in {"cpu", "cuda", "mps"}:
        raise ValueError("Unsupported inference device")
    return requested


def load_adapter(out: Path, device: str = "auto", *, require_promoted: bool = True):
    from peft import PeftModel
    from transformers import AutoTokenizer

    verify_adapter(out, require_promoted=require_promoted)
    device = inference_device(device)
    base, _ = _factory(WordingConfig(), device)
    tokenizer = AutoTokenizer.from_pretrained(
        out / "adapter", trust_remote_code=False, local_files_only=True
    )
    return PeftModel.from_pretrained(base, out / "adapter", is_trainable=False).to(
        device
    ).eval(), tokenizer


def predict_plan(model: Any, tokenizer: Any, context: dict, text: str) -> dict:
    from viscera_core.atlas_semantic import validate_plan

    if not isinstance(text, str) or not 0 < len(text) <= 4000:
        raise ValueError("Invalid wording request length")
    row = {"context": context, "text": text}
    output = predictions(model, tokenizer, [row], str(next(model.parameters()).device))[0]
    return validate_plan(strict_json(output), context, text=text)


def evaluate(data: Path, out: Path, *, limit: int = 1024, device: str = "auto") -> dict:
    """Blind final evaluation; no training updates or tuning against these results."""
    device = ("cuda" if torch.cuda.is_available() else "cpu") if device == "auto" else device
    report = strict_json((out / "training_report.json").read_text())
    identity = report["identity"]
    if (
        identity.get("tiny_fixture") is not False
        or not report.get("pretrained_base_loaded")
        or report["steps"] != report["required_steps"]
        or report["training_rows"] < 10000
        or report.get("examples_seen", 0) < report["training_rows"]
    ):
        raise ValueError("Incomplete or smoke runs cannot be promoted")
    if digest(data / "release.json") != identity["dataset_release_sha256"]:
        raise ValueError("Evaluation dataset changed")
    train_rows, val_rows, audit_rows, challenge = (
        read_split(data, s) for s in ("train", "val", "audit", "challenge")
    )
    audit_disjoint(train_rows, val_rows, audit_rows, challenge)
    validate_gold_rows(audit_rows)
    validate_gold_rows(challenge)
    selected = subset(audit_rows, limit, identity["config"]["seed"] + 1)
    del train_rows, val_rows, audit_rows
    model, tokenizer = load_adapter(out, device, require_promoted=False)
    audit_outputs = predictions(model, tokenizer, selected, device)
    challenge_outputs = predictions(model, tokenizer, challenge, device)
    audit_result, challenge_result = (
        score(selected, audit_outputs),
        score(challenge, challenge_outputs),
    )
    from viscera_core.atlas_semantic import validate_plan

    def guarded(rows, outputs):
        result = []
        for row, output in zip(rows, outputs, strict=True):
            try:
                normalized_plan(strict_json(output), row["context"])
                result.append(
                    canonical(validate_plan(strict_json(output), row["context"], text=row["text"]))
                )
            except (ValueError, TypeError, KeyError):
                result.append("{}")
        return score(rows, result)

    guarded_audit, guarded_challenge = (
        guarded(selected, audit_outputs),
        guarded(challenge, challenge_outputs),
    )
    gates = promotion_gates(audit_result, challenge_result)
    gates.update(
        {"runtime_" + k: v for k, v in promotion_gates(guarded_audit, guarded_challenge).items()}
    )
    manifest = strict_json((out / "manifest.json").read_text())
    result = {
        "format": FORMAT,
        "passed": all(gates.values()),
        "gates": gates,
        "audit": audit_result,
        "challenge": challenge_result,
        "runtime_audit": guarded_audit,
        "runtime_challenge": guarded_challenge,
        "adapter_artifact_hashes": {
            k: v for k, v in manifest["artifact_hashes"].items() if k.startswith("adapter/")
        },
        "training_report_sha256": digest(out / "training_report.json"),
        "source_hashes": source_hashes(),
        "audit_example_ids": [r["id"] for r in selected],
        "challenge_example_ids": [r["id"] for r in challenge],
        "dataset_release_sha256": identity["dataset_release_sha256"],
        "scope": "Authored visual-design intent; not evidence of clinical validity or patient anatomy prediction",
        "selection": "Predeclared stratified held-out phrase families; independently agent-authored regression challenge; no gradient updates",
    }
    atomic_json(out / "evaluation.json", result)
    return result


def export(out: Path, destination: Path) -> Path:
    manifest = strict_json((out / "manifest.json").read_text())
    report = strict_json((out / "training_report.json").read_text())
    evaluation = strict_json((out / "evaluation.json").read_text())
    if (
        manifest["identity"].get("tiny_fixture") is not False
        or report.get("pretrained_base_loaded") is not True
        or evaluation.get("passed") is not True
        or not evaluation.get("gates")
        or not all(v is True for v in evaluation["gates"].values())
    ):
        raise ValueError("Export requires real pretrained training and all blind evaluation gates")
    if evaluation["dataset_release_sha256"] != manifest["identity"]["dataset_release_sha256"]:
        raise ValueError("Evaluation provenance mismatch")
    for name, expected in manifest["artifact_hashes"].items():
        if name.startswith("adapter/") and digest(out / name) != expected:
            raise ValueError("Adapter modified after training")
    original_manifest = json.loads(canonical(manifest))
    manifest["promoted"] = True
    manifest["artifact_hashes"].update(
        {
            name: digest(out / name)
            for name in ("training_report.json", "evaluation.json", "dataset_release.json")
        }
    )
    atomic_json(out / "manifest.json", manifest)
    try:
        verify_adapter(out)
    except Exception:
        atomic_json(out / "manifest.json", original_manifest)
        raise
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in sorted(["manifest.json", *manifest["artifact_hashes"]]):
            archive.write(out / name, f"{ARCHIVE_PREFIX}/{name}")
    os.replace(temporary, destination)
    atomic_json(
        destination.with_suffix(".sha256.json"),
        {"filename": destination.name, "sha256": digest(destination), "format": FORMAT},
    )
    return destination


class _ByteTokenizer:
    pad_token_id = 0

    def apply_chat_template(self, messages, tokenize=True, add_generation_prompt=False):
        text = "".join(f"<{m['role']}>\n{m['content']}\n</end>\n" for m in messages)
        if add_generation_prompt:
            text += "<assistant>\n"
        return [b + 2 for b in text.encode()] if tokenize else text

    def save_pretrained(self, path):
        atomic_json(Path(path) / "tiny_tokenizer.json", {"tiny_fixture": True})

    def decode(self, values, skip_special_tokens=True):
        return bytes(int(v) - 2 for v in values if 2 <= int(v) <= 257).decode(errors="replace")


def _tiny_factory(cfg, device):
    from transformers import Qwen2Config, Qwen2ForCausalLM

    model = Qwen2ForCausalLM(
        Qwen2Config(
            vocab_size=258,
            hidden_size=16,
            intermediate_size=32,
            num_hidden_layers=1,
            num_attention_heads=2,
            num_key_value_heads=2,
            max_position_embeddings=8192,
            pad_token_id=0,
            eos_token_id=1,
        )
    ).to(device)
    return model, _ByteTokenizer()


def smoke(data: Path, out: Path) -> dict:
    """Actual CPU LoRA updates + bitwise deterministic interrupted/resumed run."""
    rows, vals = read_split(data, "train")[:4], read_split(data, "val")[:2]
    out.mkdir(parents=True, exist_ok=True)
    fixture = out / "dataset"
    fixture.mkdir(exist_ok=True)
    hashes = {}
    for split, values in (("train", rows), ("val", vals)):
        path = fixture / f"{split}.jsonl"
        path.write_text("\n".join(canonical(r) for r in values) + "\n")
        hashes[path.name] = digest(path)
    atomic_json(fixture / "release.json", {"tiny_fixture": True, "artifact_hashes": hashes})
    cfg = WordingConfig(
        epochs=2,
        batch_size=1,
        accumulation=1,
        learning_rate=0.005,
        rank=2,
        alpha=4,
        maximum_tokens=8192,
        checkpoint_every=2,
        device="cpu",
        gradient_checkpointing=False,
        validation_limit=2,
    )
    full, resumed = out / "full", out / "resumed"
    # Safe rerun: only these explicitly named smoke outputs are recreated.
    for directory in (full, resumed):
        if directory.exists():
            shutil.rmtree(directory)
    a = train(fixture, full, cfg, factory=_tiny_factory, generate_validation=False)
    train(fixture, resumed, cfg, stop_after=4, factory=_tiny_factory, generate_validation=False)
    b = train(fixture, resumed, cfg, resume=True, factory=_tiny_factory, generate_validation=False)
    x = torch.load(full / "checkpoint.pt", weights_only=True, map_location="cpu")
    y = torch.load(resumed / "checkpoint.pt", weights_only=True, map_location="cpu")
    exact = a["losses"] == b["losses"] and all(
        torch.equal(value, y["adapter"][name]) for name, value in x["adapter"].items()
    )
    updated = any(
        "lora_B" in name and bool(torch.count_nonzero(value))
        for name, value in x["adapter"].items()
    )
    decreased = a["losses"][-1] < a["losses"][0]
    result = {
        "passed": exact and updated and decreased,
        "actual_optimizer_steps": a["steps"],
        "exact_resume": exact,
        "adapter_updated": updated,
        "loss_decreased": decreased,
        "first_loss": a["losses"][0],
        "last_loss": a["losses"][-1],
        "pretrained_base_loaded": False,
        "eligible_for_export": False,
        "audit_opened": False,
    }
    atomic_json(out / "smoke_report.json", result)
    if not result["passed"]:
        raise ValueError("CPU training smoke failed")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["smoke", "train", "evaluate", "export"])
    parser.add_argument("--data", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.action in {"smoke", "train", "evaluate"} and args.data is None:
        parser.error("--data is required")
    if args.action == "smoke":
        result = smoke(args.data, args.out)
    elif args.action == "train":
        result = train(
            args.data,
            args.out,
            WordingConfig(epochs=args.epochs, device=args.device),
            resume=args.resume,
        )
    elif args.action == "evaluate":
        result = evaluate(args.data, args.out, device=args.device)
    else:
        if args.destination is None:
            parser.error("--destination is required")
        result = {"archive": str(export(args.out, args.destination))}
    print(canonical(result), flush=True)


if __name__ == "__main__":
    main()
