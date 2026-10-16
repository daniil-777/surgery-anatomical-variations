"""Optional atlas-specific text-to-spec LoRA research workflow.

Proposals are data, never commands. The deterministic atlas compiler remains the
semantic authority. No pretrained download occurs on import or during CPU tests.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from collections.abc import Callable
from dataclasses import asdict, dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any, cast

import numpy as np
import torch

from . import atlas_shape as storage

BASE_MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
BASE_REVISION = "c89bee90d9f811437d9735454613c35b4a3c4dc8"
FORMAT = "viscera-atlas-language-adapter-v1"
SYSTEM = """Return only a JSON object with exactly status and spec. status is accepted or unsupported.
Accepted spec is a complete AtlasSpec: template_id, uint32 seed, all seven controls
(scale_x,scale_y,scale_z,bend,twist,taper,asymmetry) within [-1,1], appearance
(tissue,source,clay), template_sha256 and realized_id (normally null). Unsupported
requests must return spec:null. Respect the supplied current state. Only licensed
atlas organs and bounded design edits are supported; disease, cutting, invented
organs, negation, and conflicting constraints are unsupported. Never diagnose.
The deterministic compiler independently validates every proposal before use."""
SPEC_KEYS = {"template_id", "seed", "controls", "appearance", "template_sha256", "realized_id"}


@dataclass(frozen=True)
class LanguageConfig:
    model_id: str = BASE_MODEL
    revision: str = BASE_REVISION
    steps: int = 200
    seed: int = 8139
    lr: float = 0.0002
    rank: int = 8
    alpha: int = 16
    maximum_tokens: int = 2048
    checkpoint_every: int = 25
    device: str = "auto"
    validation_limit: int = 24


DEFAULT_CONFIG = LanguageConfig()


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def strict_json(value: str) -> dict[str, Any]:
    """Reject duplicate keys, nonfinite JSON numbers, non-objects and prose wrappers."""

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = item
        return result

    def constant(value: str) -> Any:
        raise ValueError(f"Nonfinite JSON number: {value}")

    result = json.loads(value, object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(result, dict):
        raise ValueError("Proposal must be a JSON object")
    return cast(dict[str, Any], result)


def validate_output(value: Any) -> dict[str, Any]:
    """Validate the atlas-specific output schema, without changing any geometry."""
    from viscera_core.atlas_scene import AtlasSpec

    if not isinstance(value, dict) or set(value) != {"status", "spec"}:
        raise ValueError("Expected exactly status and spec")
    if not isinstance(value["status"], str) or value["status"] not in {"accepted", "unsupported"}:
        raise ValueError("Invalid proposal status")
    if value["status"] == "unsupported":
        if value["spec"] is not None:
            raise ValueError("Unsupported proposals cannot include partial edits")
        return {"status": "unsupported", "spec": None}
    spec = value["spec"]
    if not isinstance(spec, dict) or set(spec) != SPEC_KEYS:
        raise ValueError("Accepted proposals require the complete AtlasSpec contract")
    if not isinstance(spec["controls"], dict) or set(spec["controls"]) != set(
        storage.CONTROL_NAMES
    ):
        raise ValueError("Every bounded atlas control is required")
    return {"status": "accepted", "spec": AtlasSpec.model_validate(spec).model_dump()}


def target(row: dict[str, Any]) -> dict[str, Any]:
    return validate_output({"status": row["expected_status"], "spec": row["target_spec"]})


def messages(row: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM},
        {
            "role": "user",
            "content": canonical({"current": row["context_spec"], "request": row["text"]}),
        },
    ]


def read_split(data: Path, split: str) -> list[dict[str, Any]]:
    """Read only one individually hashed split; never parse combined audit records."""
    if split not in ("train", "val", "audit"):
        raise ValueError("Invalid language split")
    release = json.loads((data / "release.json").read_text())
    path = data / f"{split}.jsonl"
    if release.get("artifact_hashes", {}).get(path.name) != storage.digest(path):
        raise ValueError("Language split integrity mismatch")
    rows = [strict_json(line) for line in path.read_text().splitlines() if line.strip()]
    if not rows:
        raise ValueError("Empty language split")
    ids: set[str] = set()
    for row in rows:
        if row.get("split") != split or not all(
            isinstance(row.get(k), str) and row[k]
            for k in ("example_id", "group_id", "parent_sample_id", "text")
        ):
            raise ValueError("Invalid language identity or split")
        if row["example_id"] in ids:
            raise ValueError("Duplicate language example")
        ids.add(row["example_id"])
        validate_output({"status": "accepted", "spec": row["context_spec"]})
        target(row)
    return rows


def audit_groups(train: list[dict[str, Any]], val: list[dict[str, Any]]) -> None:
    for key in ("example_id", "group_id", "parent_sample_id"):
        if {row[key] for row in train} & {row[key] for row in val}:
            raise ValueError(f"Language derivative leakage: {key}")


def verify_contract(data: Path, parent: Path) -> dict[str, Any]:
    """Check pinned parent/source identities; raw audit bytes need not be opened."""
    from viscera_core.atlas_language import _code_hashes

    release = json.loads((data / "release.json").read_text())
    recipe = release.get("recipe", {})
    if recipe.get("parent_release_sha256") != storage.digest(parent / "release.json"):
        raise ValueError("Language parent release mismatch")
    if recipe.get("semantic_code_hashes") != _code_hashes():
        raise ValueError("Language compiler semantic source drift")
    return cast(dict[str, Any], release)


def encode_row(tokenizer: Any, row: dict[str, Any], maximum_tokens: int) -> dict[str, list[int]]:
    prefix = tokenizer.apply_chat_template(messages(row), tokenize=True, add_generation_prompt=True)
    full = tokenizer.apply_chat_template(
        messages(row) + [{"role": "assistant", "content": canonical(target(row))}],
        tokenize=True,
        add_generation_prompt=False,
    )
    if full[: len(prefix)] != prefix:
        raise ValueError("Chat template does not preserve assistant prefix")
    if len(full) > maximum_tokens or len(full) <= len(prefix):
        raise ValueError("Complete target does not fit token budget; truncation is forbidden")
    return {"input_ids": full, "labels": [-100] * len(prefix) + full[len(prefix) :]}


def guard_proposal(
    proposal: str | dict[str, Any], template_root: Path, text: str, context: dict[str, Any]
) -> dict[str, Any]:
    """Validate structure and exact compiler semantics before any realization."""
    from viscera_core.atlas_scene import AtlasSpec
    from viscera_core.atlas_text import compile_text

    candidate = validate_output(strict_json(proposal) if isinstance(proposal, str) else proposal)
    current = validate_output({"status": "accepted", "spec": context})["spec"]
    expected = compile_text(template_root, text, AtlasSpec.model_validate(current))
    authoritative = validate_output({"status": expected["status"], "spec": expected.get("spec")})
    if candidate["status"] != authoritative["status"]:
        raise ValueError("Proposal status disagrees with supported compiler semantics")
    if candidate["status"] == "accepted":
        a, b = candidate["spec"], authoritative["spec"]
        if any(a[key] != b[key] for key in SPEC_KEYS - {"controls"}):
            raise ValueError("Proposal changes an unauthorized template or state field")
        if any(
            abs(a["controls"][key] - b["controls"][key]) > 1e-8 for key in storage.CONTROL_NAMES
        ):
            raise ValueError("Proposal controls disagree with validated intent")
    return authoritative


def realize_checked(
    proposal: str | dict[str, Any], template_root: Path, text: str, context: dict[str, Any]
) -> Any:
    """Only a completely validated accepted proposal may reach geometry generation."""
    from viscera_core.atlas import generate
    from viscera_core.atlas_scene import get_template

    checked = guard_proposal(proposal, template_root, text, context)
    if checked["status"] != "accepted":
        return None
    spec = checked["spec"]
    sample = generate(
        get_template(template_root, spec["template_id"]), spec["controls"], spec["seed"]
    )
    if not sample.qa["passed"]:
        raise ValueError("Validated proposal failed surface geometry QA")
    return sample


def score(rows: list[dict[str, Any]], predictions: list[str], templates: Path) -> dict[str, Any]:
    if len(rows) != len(predictions) or not rows:
        raise ValueError("Aligned nonempty language predictions required")
    valid = correct = guard_pass = false_accept = 0
    groups: dict[str, dict[str, int]] = {}
    for row, prediction in zip(rows, predictions, strict=True):
        name = str(row.get("organ", "unspecified"))
        group = groups.setdefault(name, {"rows": 0, "schema_valid": 0, "semantic_match": 0})
        group["rows"] += 1
        try:
            parsed = validate_output(strict_json(prediction))
            valid += 1
            group["schema_valid"] += 1
            correct += parsed["status"] == row["expected_status"]
            false_accept += (
                parsed["status"] == "accepted" and row["expected_status"] == "unsupported"
            )
            guard_proposal(parsed, templates, row["text"], row["context_spec"])
            guard_pass += 1
            group["semantic_match"] += 1
        except (ValueError, TypeError, KeyError):
            continue
    return {
        "rows": len(rows),
        "valid_json_schema_fraction": valid / len(rows),
        "status_accuracy": correct / len(rows),
        "compiler_semantic_match_fraction": guard_pass / len(rows),
        "false_accept_count": false_accept,
        "applied_geometry_count": 0,
        "per_organ_counts": groups,
        "scope": "Synthetic paired atlas intents; no human-language or clinical generalization claim",
    }


def validation_subset(rows: list[dict[str, Any]], count: int, seed: int) -> list[dict[str, Any]]:
    """Deterministic organ/status coverage, selected without looking at model errors."""
    buckets: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        buckets[(str(row.get("organ", "unspecified")), row["expected_status"])].append(row)
    rng = np.random.default_rng(seed)
    for bucket in buckets.values():
        rng.shuffle(bucket)
    selected: list[dict[str, Any]] = []
    while len(selected) < min(count, len(rows)):
        for key in sorted(buckets):
            if buckets[key] and len(selected) < count:
                selected.append(buckets[key].pop())
    return selected


def predictions(model: Any, tokenizer: Any, rows: list[dict[str, Any]], device: str) -> list[str]:
    model.eval()
    output = []
    with torch.inference_mode():
        for row in rows:
            ids = tokenizer.apply_chat_template(
                messages(row), tokenize=True, add_generation_prompt=True
            )
            inputs = torch.tensor([ids], dtype=torch.long, device=device)
            generated = model.generate(
                input_ids=inputs,
                attention_mask=torch.ones_like(inputs),
                max_new_tokens=768,
                do_sample=False,
                use_cache=True,
                pad_token_id=tokenizer.pad_token_id,
            )
            output.append(tokenizer.decode(generated[0, len(ids) :], skip_special_tokens=True))
    return output


def _default_factory(cfg: LanguageConfig, device: str) -> tuple[Any, Any]:
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer_factory: Any = AutoTokenizer
    model_factory: Any = AutoModelForCausalLM
    tokenizer = tokenizer_factory.from_pretrained(
        cfg.model_id, revision=cfg.revision, trust_remote_code=False
    )
    tokenizer.pad_token = tokenizer.eos_token
    base = model_factory.from_pretrained(
        cfg.model_id,
        revision=cfg.revision,
        trust_remote_code=False,
        use_safetensors=True,
        torch_dtype=torch.float32,
    ).to(device)
    return base, tokenizer


def train_lora(
    data: Path,
    parent: Path,
    out: Path,
    cfg: LanguageConfig = DEFAULT_CONFIG,
    *,
    resume: bool = False,
    stop_after: int | None = None,
    factory: Callable[[LanguageConfig, str], tuple[Any, Any]] | None = None,
    generate_validation: bool = True,
) -> dict[str, Any]:
    """Fit a separate atlas-schema LoRA. The audit split is never read by training."""
    from peft import LoraConfig, get_peft_model

    if cfg.model_id != BASE_MODEL or cfg.revision != BASE_REVISION:
        raise ValueError("Only the reviewed immutable Apache-2.0 base revision is supported")
    if (
        min(
            cfg.steps,
            cfg.rank,
            cfg.alpha,
            cfg.maximum_tokens,
            cfg.checkpoint_every,
            cfg.validation_limit,
        )
        < 1
    ):
        raise ValueError("Language training counts must be positive")
    if not np.isfinite(cfg.lr) or cfg.lr <= 0:
        raise ValueError("Invalid language learning rate")
    verify_contract(data, parent)
    train, val = read_split(data, "train"), read_split(data, "val")
    audit_groups(train, val)
    selected_val = validation_subset(val, cfg.validation_limit, cfg.seed)
    device = (
        "cuda"
        if cfg.device == "auto" and torch.cuda.is_available()
        else "cpu"
        if cfg.device == "auto"
        else cfg.device
    )
    if device not in {"cpu", "cuda"}:
        raise ValueError("Supported devices: cpu, cuda, auto")
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(cfg.seed)
    if device == "cuda":
        torch.cuda.manual_seed_all(cfg.seed)
    rng = np.random.default_rng(cfg.seed)
    base, tokenizer = (factory or _default_factory)(cfg, device)
    base.config.use_cache = False
    model = get_peft_model(
        base,
        LoraConfig(
            task_type="CAUSAL_LM",
            r=cfg.rank,
            lora_alpha=cfg.alpha,
            lora_dropout=0.0,
            target_modules=["q_proj", "v_proj"],
        ),
    )
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=cfg.lr)
    encoded = [encode_row(tokenizer, row, cfg.maximum_tokens) for row in train]
    # Validate every validation row's token contract, without opening audit.
    for row in val:
        encode_row(tokenizer, row, cfg.maximum_tokens)
    identity = {
        "format": FORMAT,
        "config": asdict(cfg),
        "source_sha256": storage.digest(Path(__file__)),
        "language_release_sha256": storage.digest(data / "release.json"),
        "parent_release_sha256": storage.digest(parent / "release.json"),
        "train_sha256": storage.digest(data / "train.jsonl"),
        "val_sha256": storage.digest(data / "val.jsonl"),
        "runtime": storage._runtime(torch.device(device)),
        "language_dependencies": {
            name: version(name)
            for name in ("transformers", "peft", "tokenizers", "safetensors", "accelerate")
        },
        "tiny_fixture": factory is not None,
        "validation_generation": generate_validation,
    }
    out.mkdir(parents=True, exist_ok=True)
    if (out / "checkpoint.pt").exists() and not resume:
        raise ValueError("Choose a fresh output or resume the identical run")
    step = cursor = 0
    order = rng.permutation(len(encoded))
    losses: list[float] = []
    if resume:
        state = storage.safe_load(out / "checkpoint.pt")
        if state["identity"] != identity:
            raise ValueError("Language resume identity changed")
        missing, unexpected = model.load_state_dict(state["adapter"], strict=False)
        if unexpected or any("lora_" in key for key in missing):
            raise ValueError("Adapter checkpoint keys mismatch")
        optimizer.load_state_dict(state["optimizer"])
        rng.bit_generator.state = json.loads(state["numpy_rng_json"])
        torch.set_rng_state(state["torch_rng"])
        if device == "cuda":
            torch.cuda.set_rng_state_all(state["cuda_rng"])
        step, cursor = state["step"], state["cursor"]
        order, losses = np.asarray(state["order"]), state["losses"]
    elif generate_validation:
        baseline = predictions(model, tokenizer, selected_val, device)
        storage.atomic_json(
            out / "frozen_base_validation.json",
            score(selected_val, baseline, parent / "templates"),
        )
    for step in range(step + 1, cfg.steps + 1):
        model.train()
        if cursor == len(order):
            order, cursor = rng.permutation(len(encoded)), 0
        item = encoded[int(order[cursor])]
        cursor += 1
        inputs = {
            key: torch.tensor([value], dtype=torch.long, device=device)
            for key, value in item.items()
        }
        inputs["attention_mask"] = torch.ones_like(inputs["input_ids"])
        optimizer.zero_grad(set_to_none=True)
        loss = model(**inputs).loss
        if not torch.isfinite(loss):
            raise ValueError("Nonfinite language loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        losses.append(float(loss.detach().cpu()))
        if step % cfg.checkpoint_every == 0 or step == cfg.steps or step == stop_after:
            adapter = {
                key: value.detach().cpu().clone()
                for key, value in model.state_dict().items()
                if "lora_" in key
            }
            storage.atomic_torch(
                out / "checkpoint.pt",
                {
                    "format": storage.FORMAT,
                    "identity": identity,
                    "adapter": adapter,
                    "optimizer": optimizer.state_dict(),
                    "numpy_rng_json": json.dumps(rng.bit_generator.state),
                    "torch_rng": torch.get_rng_state(),
                    "cuda_rng": torch.cuda.get_rng_state_all() if device == "cuda" else [],
                    "step": step,
                    "cursor": cursor,
                    "order": order.tolist(),
                    "losses": losses,
                },
            )
        if step == stop_after and step < cfg.steps:
            return {"status": "interrupted", "step": step}
    model.save_pretrained(str(out / "adapter"), safe_serialization=True)
    tokenizer.save_pretrained(out / "adapter")
    report = {
        "status": "tiny_cpu_training_smoke" if factory else "unpromoted_research_adapter",
        "identity": identity,
        "steps": step,
        "losses": losses,
        "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "training_rows": len(train),
        "validation_rows": len(val),
        "validation_example_ids": [row["example_id"] for row in selected_val],
        "audit_opened": False,
        "runtime_integrated": False,
        "pretrained_base_loaded": factory is None,
        "full_base_weights_updated": False,
        "adapter_training_executed": True,
        "validation": score(
            selected_val,
            predictions(model, tokenizer, selected_val, device),
            parent / "templates",
        )
        if generate_validation
        else {"status": "NOT_RUN", "reason": "Tiny model tests exercise training only"},
    }
    storage.atomic_json(out / "training_report.json", report)
    files = {
        str(path.relative_to(out)): storage.digest(path)
        for path in sorted((out / "adapter").rglob("*"))
        if path.is_file()
    }
    storage.atomic_json(
        out / "adapter_manifest.json", {"artifact_hashes": files, "identity": identity}
    )
    return report


def load_adapter(data: Path, parent: Path, out: Path, device: str = "cpu") -> tuple[Any, Any]:
    """Load only a provenance-bound, integrity-checked research adapter."""
    from peft import PeftModel

    verify_contract(data, parent)
    manifest = json.loads((out / "adapter_manifest.json").read_text())
    identity = manifest["identity"]
    if (
        identity.get("format") != FORMAT
        or identity.get("tiny_fixture") is not False
        or identity.get("source_sha256") != storage.digest(Path(__file__))
        or identity.get("language_release_sha256") != storage.digest(data / "release.json")
        or identity.get("parent_release_sha256") != storage.digest(parent / "release.json")
    ):
        raise ValueError("Adapter provenance or source mismatch")
    hashes = manifest.get("artifact_hashes", {})
    if not hashes or "adapter/adapter_model.safetensors" not in hashes:
        raise ValueError("Adapter manifest lacks safe weights")
    actual = {str(p.relative_to(out)) for p in (out / "adapter").rglob("*") if p.is_file()}
    if actual != set(hashes):
        raise ValueError("Adapter file set changed")
    for name, expected in hashes.items():
        path = out / name
        if not path.resolve().is_relative_to((out / "adapter").resolve()) or path.is_symlink():
            raise ValueError("Unsafe adapter artifact path")
        if storage.digest(path) != expected:
            raise ValueError("Adapter artifact integrity mismatch")
    cfg = LanguageConfig(**identity["config"])
    if cfg.model_id != BASE_MODEL or cfg.revision != BASE_REVISION:
        raise ValueError("Unreviewed base model")
    base, tokenizer = _default_factory(cfg, device)
    model = PeftModel.from_pretrained(base, out / "adapter", is_trainable=False).to(device)
    model.eval()
    return model, tokenizer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--parent", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--steps", default=200, type=int)
    parser.add_argument("--device", default="auto", choices=("cpu", "cuda", "auto"))
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    report = train_lora(
        args.data,
        args.parent,
        args.out,
        LanguageConfig(steps=args.steps, device=args.device),
        resume=args.resume,
    )
    print(
        json.dumps(
            {key: report[key] for key in ("status", "steps", "audit_opened") if key in report}
        )
    )


if __name__ == "__main__":
    main()
