"""Optional, capability-bounded LoRA compiler experiment; never an anatomy oracle.

No pretrained weights are downloaded on import or while preparing/evaluating data.
The supervised output is only {status, patches}. Its validator is mandatory before
any application; unseen natural language and expert validity remain unevaluated.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Callable, cast

import numpy as np
from viscera_core.schema import PARAMETER_BOUNDS

STATUSES = {"ready", "needs_clarification", "unsupported", "error"}
SYSTEM = """Compile a request for the implemented adult liver/gallbladder design.
Return ONLY JSON with exactly status and patches. Status: ready,
needs_clarification, unsupported, error. Patches are replace operations on
/parameters/<key>, /seed or /include_vessels. Omit unchanged fields. Non-ready
responses must have empty patches. Lengths require mm or cm; percentages require
an explicit relative direction and use CURRENT values. Ambiguous dimensions or
missing units require clarification. Diagnosis, disease, other organs, surgical
changes, texture and physics edits are unsupported. Never invent missing values.
Allowed numeric parameter bounds: """ + json.dumps(PARAMETER_BOUNDS, sort_keys=True)


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def validate_target(value: dict[str, Any]) -> dict[str, Any]:
    """Reject extra keys, nonfinite numbers, unsupported paths and partial failures."""
    if not isinstance(value, dict) or set(value) != {"status", "patches"}:
        raise ValueError("Expected exactly status and patches")
    if (
        not isinstance(value["status"], str)
        or value["status"] not in STATUSES
        or not isinstance(value["patches"], list)
    ):
        raise ValueError("Invalid status or patches")
    if value["status"] != "ready" and value["patches"]:
        raise ValueError("A failure cannot include partial changes")
    seen = set()
    if len(value["patches"]) > len(PARAMETER_BOUNDS) + 2:
        raise ValueError("Too many patches")
    for patch in value["patches"]:
        if not isinstance(patch, dict) or set(patch) != {"op", "path", "value"}:
            raise ValueError("Malformed patch")
        path, number = patch["path"], patch["value"]
        if patch["op"] != "replace" or not isinstance(path, str) or path in seen:
            raise ValueError("Only unique replace operations are accepted")
        seen.add(path)
        if path == "/include_vessels":
            if type(number) is not bool:
                raise ValueError("Vessel visibility must be boolean")
        elif path == "/seed":
            if type(number) is not int or not 0 <= number <= 2**32 - 1:
                raise ValueError("Seed must be uint32")
        elif path.startswith("/parameters/") and path[12:] in PARAMETER_BOUNDS:
            low, high = PARAMETER_BOUNDS[path[12:]]
            if (
                type(number) not in (int, float)
                or not low <= number <= high
                or not math.isfinite(number)
            ):
                raise ValueError("Parameter outside supported domain")
        else:
            raise ValueError("Unsupported path")
    return value


def prompt(row: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": SYSTEM},
        {
            "role": "user",
            "content": canonical({"current": row["current"], "request": row["request"]}),
        },
    ]


def prepare_data(
    output: Path, per_split: tuple[int, int, int] = (256, 48, 48), seed: int = 837
) -> dict[str, Any]:
    """Original authored templates with disjoint state and wording-family splits.

    This is a language-policy synthetic set, separate from the 3D parameter set.
    Known targets are constructed from operations, not inferred by an LLM teacher.
    """
    if len(per_split) != 3 or any(type(n) is not int or n < 1 for n in per_split):
        raise ValueError("Provide positive integer train, validation and test counts")
    if type(seed) is not int or not 0 <= seed <= 2**32 - 1:
        raise ValueError("Language dataset seed must be uint32")
    manifest_path = output / "release.json"
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text())
        if (
            existing.get("profile") != "synthetic_language_policy"
            or existing.get("seed") != seed
            or [
                existing.get("splits", {}).get(s, {}).get("count") for s in ("train", "val", "test")
            ]
            != list(per_split)
        ):
            raise ValueError(
                "Existing language release has a different recipe; use a new directory"
            )
        existing_rows = [read_rows(output, s) for s in ("train", "val", "test")]
        for i in range(len(existing_rows)):
            for j in range(i + 1, len(existing_rows)):
                audit_rows(existing_rows[i], existing_rows[j])
        return cast(dict[str, Any], existing)
    if output.exists() and any(output.iterdir()):
        raise ValueError("Refusing to overwrite an incomplete language release")
    output.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    wording = {
        "train": (
            "set {label} to {value} mm",
            "{label}: {value} mm",
            "increase {label} by {delta} mm",
        ),
        "val": (
            "please make {label} {value} mm",
            "change {label} to {value} mm",
            "decrease {label} by {delta} mm",
        ),
        "test": (
            "I need {label} of {value} mm",
            "use {label} {value} mm",
            "reduce {label} by {delta} mm",
        ),
    }
    unsupported = {
        "train": ("add a tumor", "create a kidney", "make tissue softer", "color the liver purple"),
        "val": (
            "generate liver cirrhosis",
            "show the pancreas",
            "increase tissue stiffness",
            "resect the lobe",
        ),
        "test": (
            "add a malignant metastasis",
            "include the spleen",
            "make it elastic",
            "model pediatric anatomy",
        ),
    }
    ambiguous = {
        "train": (
            "make it bigger",
            "liver width 220",
            "maybe increase width",
            "liver volume 1800 ml",
        ),
        "val": (
            "decrease the size",
            "gallbladder length 75",
            "either long or short gallbladder",
            "liver volume 2 litres",
        ),
        "test": (
            "make the organ smaller",
            "liver height 155",
            "if needed increase depth",
            "liver volume 1.8 liters",
        ),
    }
    lengths = [key for key in PARAMETER_BOUNDS if key.endswith("_mm")]
    manifest: dict[str, Any] = {
        "profile": "synthetic_language_policy",
        "seed": seed,
        "limits": "Authored template-family holdout; no human natural-language or anatomy validation.",
        "tracks": {
            "wording_family_holdout": True,
            "state_group_disjoint": True,
            "operation_family_holdout": False,
        },
        "splits": {},
    }
    for split, count in zip(("train", "val", "test"), per_split, strict=True):
        rows = []
        for i in range(count):
            current: dict[str, Any] = {
                "seed": int(rng.integers(0, 2**32)),
                "include_vessels": True,
                "parameters": {
                    k: float(rng.uniform(lo + 0.2 * (hi - lo), hi - 0.2 * (hi - lo)))
                    for k, (lo, hi) in PARAMETER_BOUNDS.items()
                },
            }
            kind = i % 8
            if kind < 4:
                key = lengths[i % len(lengths)]
                low, high = PARAMETER_BOUNDS[key]
                variant = i % len(wording[split])
                delta = round(0.05 * (high - low), 2)
                value = round(
                    float(rng.uniform(low + 0.1 * (high - low), high - 0.1 * (high - low))), 2
                )
                if variant == 2:
                    value = current["parameters"][key] + (delta if split == "train" else -delta)
                text = wording[split][variant].format(
                    label=key.removesuffix("_mm").replace("_", " "), value=value, delta=delta
                )
                target = {
                    "status": "ready",
                    "patches": [{"op": "replace", "path": f"/parameters/{key}", "value": value}],
                }
                family = f"{split}:length:{variant}"
            elif kind in (4, 5):
                index = (i // 8 * 2 + kind - 4) % len(unsupported[split])
                text, family = unsupported[split][index], f"{split}:unsupported:{index}"
                target = {"status": "unsupported", "patches": []}
            else:
                index = (i // 8 * 2 + kind - 6) % len(ambiguous[split])
                text, family = ambiguous[split][index], f"{split}:ambiguous:{index}"
                target = {"status": "needs_clarification", "patches": []}
            validate_target(target)
            group = hashlib.sha256(canonical(current).encode()).hexdigest()
            rows.append(
                {
                    "id": f"{split}-{i:06d}",
                    "split": split,
                    "group_id": group,
                    "wording_family": family,
                    "current": current,
                    "request": text,
                    "target": target,
                }
            )
        path = output / f"{split}.jsonl"
        path.write_text("".join(canonical(row) + "\n" for row in rows))
        manifest["splits"][split] = {
            "count": count,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
    (output / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def read_rows(root: Path, split: str) -> list[dict[str, Any]]:
    manifest = json.loads((root / "release.json").read_text())
    path = root / f"{split}.jsonl"
    if hashlib.sha256(path.read_bytes()).hexdigest() != manifest["splits"][split]["sha256"]:
        raise ValueError("Language split checksum mismatch")
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    if len(rows) != manifest["splits"][split]["count"] or any(r["split"] != split for r in rows):
        raise ValueError("Language split declaration mismatch")
    for row in rows:
        validate_target(row["target"])
    return rows


def audit_rows(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> None:
    for key in ("group_id", "wording_family"):
        if {r[key] for r in a} & {r[key] for r in b}:
            raise ValueError(f"Language split leakage: {key}")


def tokenize_row(tokenizer: Any, row: dict[str, Any], maximum: int = 1024) -> dict[str, Any]:
    prefix = tokenizer.apply_chat_template(prompt(row), tokenize=True, add_generation_prompt=True)
    # Tokenize the assistant suffix independently so loss never trains the prompt.
    suffix = tokenizer(canonical(row["target"]), add_special_tokens=False)["input_ids"] + [
        tokenizer.eos_token_id
    ]
    ids = prefix + suffix
    if len(ids) > maximum:
        raise ValueError("Example exceeds token limit; do not silently truncate targets")
    return {"input_ids": ids, "labels": [-100] * len(prefix) + suffix}


def score_predictions(rows: list[dict[str, Any]], predictions: list[str]) -> dict[str, Any]:
    if len(rows) != len(predictions) or not rows:
        raise ValueError("Predictions must cover every evaluation row")
    counts = {
        "attempted": len(rows),
        "valid_json_schema": 0,
        "correct_status": 0,
        "exact_target": 0,
        "unsafe_false_ready": 0,
    }
    failures = []
    for row, text in zip(rows, predictions, strict=True):
        try:
            result = validate_target(json.loads(text))
            counts["valid_json_schema"] += 1
            counts["correct_status"] += result["status"] == row["target"]["status"]
            # JSON number formatting (240 versus 240.0) is not an edit error.
            # Validation excludes booleans from numeric fields before comparison.
            exact = result == row["target"]
            counts["exact_target"] += exact
            counts["unsafe_false_ready"] += (
                result["status"] == "ready" and row["target"]["status"] != "ready"
            )
            if not exact:
                failures.append(
                    {
                        "id": row["id"],
                        "request": row["request"],
                        "target": row["target"],
                        "prediction": result,
                    }
                )
        except (ValueError, TypeError, KeyError):
            failures.append(
                {"id": row["id"], "reason": "invalid_json_or_schema", "prediction": text[:2000]}
            )
    return {**counts, "exact_target_rate": counts["exact_target"] / len(rows), "failures": failures}


def compiler_predictions(rows: list[dict[str, Any]]) -> list[str]:
    from services.api.compiler import compile_text

    return [
        canonical(
            {k: compile_text(row["request"], row["current"])[k] for k in ("status", "patches")}
        )
        for row in rows
    ]


def train_lora(
    data: Path,
    out: Path,
    model_id: str,
    revision: str,
    steps: int = 200,
    seed: int = 873,
    device: str = "auto",
    resume: bool = False,
    stop_after: int | None = None,
) -> dict[str, Any]:
    """Actual masked supervised causal-LM LoRA; optional HF dependencies loaded here."""
    import random
    import time

    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from .shape import atomic_json, atomic_torch, digest, restore_rng, rng_state, safe_load

    if not resume and out.exists() and any(out.iterdir()):
        raise ValueError("Existing language run: use --resume or choose a new output directory")
    if stop_after is not None and (type(stop_after) is not int or stop_after < 1):
        raise ValueError("stop_after must be a positive integer")
    train_rows, val_rows = read_rows(data, "train"), read_rows(data, "val")
    audit_rows(train_rows, val_rows)
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("Use an immutable 40-character model revision")
    if steps < 1:
        raise ValueError("steps must be positive")
    if not train_rows or not val_rows:
        raise ValueError("Nonempty training and validation splits are required")
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    target_device = (
        "cuda"
        if device == "auto" and torch.cuda.is_available()
        else ("cpu" if device == "auto" else device)
    )
    tokenizer = cast(Callable[..., Any], AutoTokenizer.from_pretrained)(
        model_id, revision=revision, trust_remote_code=False
    )
    tokenizer.pad_token = tokenizer.eos_token
    base = AutoModelForCausalLM.from_pretrained(
        model_id,
        revision=revision,
        torch_dtype=torch.float32,
        trust_remote_code=False,
        use_safetensors=True,
    )
    cast(torch.nn.Module, base).to(target_device)
    base.config.use_cache = False
    model = get_peft_model(
        base,
        LoraConfig(
            task_type="CAUSAL_LM",
            r=8,
            lora_alpha=16,
            lora_dropout=0.0,
            target_modules=["q_proj", "v_proj"],
        ),
    )
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=2e-4)
    encoded = [tokenize_row(tokenizer, row) for row in train_rows]
    identity = {
        "model_id": model_id,
        "revision": revision,
        "steps": steps,
        "seed": seed,
        "train_sha256": digest(data / "train.jsonl"),
        "val_sha256": digest(data / "val.jsonl"),
        "source_sha256": digest(Path(__file__)),
        "device": target_device,
    }
    out.mkdir(parents=True, exist_ok=True)
    step, cursor, order = 0, 0, torch.randperm(len(encoded))
    elapsed_before = 0.0
    losses = []
    if resume:
        state = safe_load(out / "checkpoint.pt")
        if state["identity"] != identity:
            raise ValueError("LoRA resume identity changed")
        missing, unexpected = model.load_state_dict(state["adapter"], strict=False)
        if unexpected or any("lora_" in key for key in missing):
            raise ValueError("Adapter checkpoint keys mismatch")
        optimizer.load_state_dict(state["optimizer"])
        step, cursor, order, losses = (
            state["step"],
            state["cursor"],
            state["order"],
            state["losses"],
        )
        elapsed_before = state.get("elapsed_s", 0.0)
        restore_rng(state["rng"])
    else:
        # Validation only; never open test during fitting or checkpoint selection.
        frozen = generate_predictions(model, tokenizer, val_rows, target_device)
        atomic_json(out / "frozen_validation.json", score_predictions(val_rows, frozen))
        atomic_json(
            out / "compiler_validation.json",
            score_predictions(val_rows, compiler_predictions(val_rows)),
        )
    model.train()
    started = time.perf_counter()
    goal = min(steps, stop_after) if stop_after is not None else steps
    if goal < step:
        raise ValueError("stop_after precedes the restored checkpoint")
    for step in range(step + 1, goal + 1):
        if cursor == len(order):
            order, cursor = torch.randperm(len(encoded)), 0
        row = encoded[int(order[cursor])]
        cursor += 1
        inputs = {
            k: torch.tensor([v], dtype=torch.long, device=target_device) for k, v in row.items()
        }
        inputs["attention_mask"] = torch.ones_like(inputs["input_ids"])
        optimizer.zero_grad(set_to_none=True)
        loss = model(**inputs).loss
        if not torch.isfinite(loss):
            raise RuntimeError("Nonfinite language loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        losses.append(float(loss.detach()))
        if step % 25 == 0 or step == goal:
            adapter = {k: v.detach().cpu() for k, v in model.state_dict().items() if "lora_" in k}
            atomic_torch(
                out / "checkpoint.pt",
                {
                    "identity": identity,
                    "adapter": adapter,
                    "optimizer": optimizer.state_dict(),
                    "rng": rng_state(),
                    "step": step,
                    "cursor": cursor,
                    "order": order,
                    "losses": losses,
                    "elapsed_s": elapsed_before + time.perf_counter() - started,
                },
            )
    complete = step == steps
    if complete:
        model.save_pretrained(str(out / "adapter"), safe_serialization=True)
        tokenizer.save_pretrained(out / "adapter")
        atomic_json(
            out / "adapter_manifest.json",
            {
                "files": {
                    p.relative_to(out / "adapter").as_posix(): digest(p)
                    for p in sorted((out / "adapter").rglob("*"))
                    if p.is_file()
                }
            },
        )
    report = {
        "status": "research_candidate" if complete else "interrupted",
        "identity": identity,
        "step": step,
        "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "wall_time_s": elapsed_before + time.perf_counter() - started,
        "losses": losses,
        "limits": "Synthetic policy templates only. No human/clinical language validation. Not integrated into runtime.",
    }
    if complete:
        report["validation"] = score_predictions(
            val_rows, generate_predictions(model, tokenizer, val_rows, target_device)
        )
    atomic_json(out / "training_report.json", report)
    (out / "MODEL_CARD.md").write_text(
        "# Optional compiler LoRA\n\nPredicts bounded JSON edit proposals from text plus the current procedural state. "
        "Separate from the 3D control-flow model. The deterministic validator and capability checks remain mandatory. "
        "Authored synthetic wording-family holdout does not establish human language, anatomical or tissue correctness. "
        "No automatic promotion. Compare frozen LM, deterministic compiler and adapter on sealed test.\n"
    )
    return report


def generate_predictions(
    model: Any, tokenizer: Any, rows: list[dict[str, Any]], device: str
) -> list[str]:
    import torch

    model.eval()
    predictions = []
    with torch.inference_mode():
        for row in rows:
            ids = tokenizer.apply_chat_template(
                prompt(row), tokenize=True, add_generation_prompt=True, return_tensors="pt"
            ).to(device)
            generated = model.generate(
                ids,
                attention_mask=torch.ones_like(ids),
                max_new_tokens=192,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
            )
            predictions.append(
                tokenizer.decode(generated[0, ids.shape[1] :], skip_special_tokens=True).strip()
            )
    return predictions


def evaluate_lora(data: Path, out: Path) -> dict[str, Any]:
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from .shape import atomic_json, digest

    report = json.loads((out / "training_report.json").read_text())
    identity = report["identity"]
    if report.get("status") != "research_candidate" or report["step"] != identity["steps"]:
        raise ValueError("Evaluation requires a complete trained adapter")
    for split in ("train", "val"):
        if digest(data / f"{split}.jsonl") != identity[f"{split}_sha256"]:
            raise ValueError("Evaluation dataset does not match the trained language release")
    manifest_path = out / "adapter_manifest.json"
    if not manifest_path.exists():
        raise ValueError("Adapter integrity manifest is required; do not evaluate unverified files")
    expected = json.loads(manifest_path.read_text())["files"]
    actual = {
        p.relative_to(out / "adapter").as_posix(): digest(p)
        for p in sorted((out / "adapter").rglob("*"))
        if p.is_file()
    }
    if actual != expected or "adapter_model.safetensors" not in actual:
        raise ValueError("Adapter or tokenizer checksum mismatch")
    rows = read_rows(data, "test")
    audit_rows(read_rows(data, "train"), rows)
    audit_rows(read_rows(data, "val"), rows)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tokenizer = cast(Callable[..., Any], AutoTokenizer.from_pretrained)(
        out / "adapter", trust_remote_code=False
    )
    base = AutoModelForCausalLM.from_pretrained(
        identity["model_id"],
        revision=identity["revision"],
        torch_dtype=torch.float32,
        trust_remote_code=False,
        use_safetensors=True,
    )
    cast(torch.nn.Module, base).to(device)
    frozen = score_predictions(rows, generate_predictions(base, tokenizer, rows, device))
    model = PeftModel.from_pretrained(base, out / "adapter")
    result = {
        "split": "test",
        "attempted": len(rows),
        "compiler": score_predictions(rows, compiler_predictions(rows)),
        "frozen": frozen,
        "adapter": score_predictions(rows, generate_predictions(model, tokenizer, rows, device)),
        "test_consumed": True,
        "promotion": "NONE; independent human-authored validation required",
    }
    atomic_json(out / "test_evaluation.json", result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "train", "evaluate"))
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--revision", default="c89bee90d9f811437d9735454613c35b4a3c4dc8")
    parser.add_argument("--steps", type=int, default=200)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--stop-after", type=int)
    args = parser.parse_args()
    if args.command == "prepare":
        print(json.dumps(prepare_data(args.data), indent=2))
    elif args.out is None:
        parser.error("--out is required for train/evaluate")
    elif args.command == "train":
        report = train_lora(
            args.data,
            args.out,
            args.model,
            args.revision,
            args.steps,
            resume=args.resume,
            stop_after=args.stop_after,
        )
        print(
            json.dumps(
                {k: report[k] for k in ("status", "step", "trainable_parameters", "wall_time_s")},
                indent=2,
            )
        )
    else:
        print(json.dumps(evaluate_lora(args.data, args.out), indent=2))


if __name__ == "__main__":
    main()
