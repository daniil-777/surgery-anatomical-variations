"""Independent, validated wording adapters and context-aware bounded edit plans."""

from __future__ import annotations

import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

from . import atlas_model_registry as registry

FORMAT = "viscera-atlas-wording-adapter-v2"
SNAPSHOT_FORMAT = "viscera-atlas-wording-snapshot-v1"
PREFIX = "viscera-wording-weights/"
SCOPE = "context-aware shape, appearance and disease design instructions"
_LOCK = threading.RLock()
_CACHE: dict[str, Any] = {}


def clear_cache() -> None:
    with _LOCK:
        _CACHE.clear()


def _validate_evaluation_contract(root: Path, directory: Path) -> None:
    """Bind optional accelerated evaluation to its pre-training release policy.

    Existing releases without an execution contract retain their original
    verifier. Artifact hashes and quality gates are independently checked by
    the frozen adapter verifier before this additional provenance check.
    """
    release = registry._read_json(directory / "dataset_release.json")
    if "evaluation_contract" not in release:
        return
    expected = {
        "helper_sha256": registry.digest(root / "scripts/wording_batched_evaluation.py"),
        "method": "left_padded_greedy_batch_v1", "batch_size": 8,
        "validation_parity_rows": 16, "audit_limit": 512,
        "fallback": "original_sequential_on_any_parity_mismatch",
    }
    if release["evaluation_contract"] != expected:
        raise ValueError("Wording evaluation execution contract or helper source changed")
    evaluation = registry._read_json(directory / "evaluation.json")
    if evaluation.get("evaluation_contract") != expected:
        raise ValueError("Wording evaluation contract differs from the frozen dataset release")
    execution = evaluation.get("generation_execution")
    if not isinstance(execution, dict) or (
        execution.get("helper_sha256") != expected["helper_sha256"]
        or execution.get("requested_batch_size") != expected["batch_size"]
        or execution.get("parity_rows") != expected["validation_parity_rows"]
        or execution.get("parity_checked_before_opening_audit") is not True
        or execution.get("maximum_new_tokens") != 384
        or execution.get("do_sample") is not False
    ):
        raise ValueError("Wording evaluation did not follow its fixed generation contract")
    identifiers = {}
    challenge_count = release.get("counts", {}).get("challenge")
    if type(challenge_count) is not int or challenge_count < 40:
        raise ValueError("Wording evaluation must declare its complete challenge size")
    for name, value, count in (
        ("parity", execution.get("parity_example_ids"), expected["validation_parity_rows"]),
        ("audit", evaluation.get("audit_example_ids"), expected["audit_limit"]),
        ("challenge", evaluation.get("challenge_example_ids"), challenge_count),
    ):
        if (not isinstance(value, list) or len(value) != count
                or not all(isinstance(item, str) and item for item in value)
                or len(set(value)) != count):
            raise ValueError("Wording evaluation requires complete distinct " + name + " identities")
        identifiers[name] = set(value)
    if (identifiers["parity"] & (identifiers["audit"] | identifiers["challenge"])
            or identifiers["audit"] & identifiers["challenge"]):
        raise ValueError("Wording evaluation partitions overlap")
    for name, count in (("audit", expected["audit_limit"]), ("challenge", challenge_count)):
        if any(evaluation.get(prefix + name, {}).get("rows") != count for prefix in ("", "runtime_")):
            raise ValueError("Wording evaluation metrics omit declared " + name + " cases")
    matches = execution.get("exact_output_matches")
    if type(matches) is not int or not 0 <= matches <= expected["validation_parity_rows"]:
        raise ValueError("Invalid exact generation parity result")
    method = ("left_padded_greedy_batch" if matches == expected["validation_parity_rows"]
              else "original_sequential_after_parity_mismatch")
    if execution.get("method") != method:
        raise ValueError("Wording evaluation did not use the required parity fallback")


def _validate(root: Path, directory: Path) -> dict[str, Any]:
    from pipelines.train.viscera_train.atlas_wording import verify_adapter

    manifest = registry._read_json(directory / "manifest.json")
    if manifest.get("format") not in {FORMAT, SNAPSHOT_FORMAT} or manifest.get("promoted") is not True:
        raise ValueError("Only wording adapters that passed evaluation may activate")
    hashes = manifest.get("artifact_hashes")
    registry._verify_files(directory, hashes)
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()}
    if actual != set(hashes) | {"manifest.json"}:
        raise ValueError("Wording archive contains unmanifested files")
    if any(Path(name).suffix not in {".json", ".safetensors", ".txt", ".md", ".jinja"} for name in actual):
        raise ValueError("Wording archives accept only inert tensors and metadata")
    if manifest["format"] == SNAPSHOT_FORMAT:
        from pipelines.train.viscera_train.atlas_wording_snapshot import verify_adapter

    verified = verify_adapter(directory, root=root, require_promoted=True)
    _validate_evaluation_contract(root, directory)
    return verified


def active(root: Path) -> tuple[dict[str, Any], Path | None]:
    pointer = registry.store_root(root) / "active-wording.json"
    state = registry._read_json(pointer) if pointer.exists() else {
        "version": 1, "active_bundle": None,
    }
    if state.get("version") != 1 or "active_bundle" not in state:
        raise ValueError("Invalid wording model selection; restore defaults")
    identifier = state["active_bundle"]
    if identifier is None:
        return state, None
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{64}", identifier):
        raise ValueError("Invalid wording model checksum")
    directory = registry.store_root(root) / "wording-bundles" / identifier
    if registry.digest(directory / "manifest.json") != state.get("manifest_sha256"):
        raise ValueError("Active wording manifest changed; restore defaults")
    manifest = _validate(root, directory)
    return {**state, "format": manifest["format"]}, directory


def status(root: Path) -> dict[str, Any]:
    state, directory = active(root)
    snapshot = state.get("format") == SNAPSHOT_FORMAT
    return {
        "bundle_sha256": state["active_bundle"],
        "lane": {
            "status": "active" if directory else "available",
            "method": "Qwen2.5_LoRA_early_stop_semantic_plans" if snapshot else "Qwen2.5_LoRA_semantic_plans" if directory else "built_in_semantic_plans",
            "scope": SCOPE + ("; evaluated early-stopped checkpoint, planned training not complete" if snapshot else ""),
        },
    }


def import_weights(root: Path, archive: Path, *, report_status: bool = True) -> dict[str, Any]:
    store = registry.store_root(root)
    store.mkdir(parents=True, exist_ok=True)
    with registry._LOCK, tempfile.TemporaryDirectory(prefix=".wording-staging-", dir=store) as tmp:
        directory = Path(tmp)
        registry._extract(archive, directory, prefix=PREFIX)
        _validate(root, directory)
        identifier = registry.digest(archive)
        destination = store / "wording-bundles" / identifier
        destination.parent.mkdir(exist_ok=True)
        if destination.exists():
            _validate(root, destination)
            if registry.digest(destination / "manifest.json") != registry.digest(directory / "manifest.json"):
                raise ValueError("Stored wording bundle differs from the validated archive")
        else:
            os.replace(directory, destination)
        registry._atomic_json(store / "active-wording.json", {
            "version": 1, "active_bundle": identifier,
            "manifest_sha256": registry.digest(destination / "manifest.json"),
        })
        clear_cache()
    if not report_status:
        # The watcher only needs confirmation of this committed selection. A
        # full model inventory may wait on unrelated cloud-backed joint assets
        # after the pointer is already active, or fail for an unrelated lane.
        return {"wording_bundle_sha256": identifier, "status": "active"}
    return registry.model_status(root)


def compile_request(
    root: Path, templates: Path, text: str, spec: Any, legacy_result: dict[str, Any],
) -> dict[str, Any]:
    from viscera_core import atlas_semantic as semantic

    context = semantic.context_from_spec(spec)
    guarded = semantic.request_guard(text, context)
    if guarded is not None:
        return {**guarded, "policy_version": semantic.POLICY_VERSION}
    state, directory = active(root)
    if directory is None:
        if legacy_result.get("status") == "accepted":
            return legacy_result
        return semantic.compile_text(templates, text, spec)
    from pipelines.train.viscera_train.atlas_wording import load_adapter, predict_plan

    if state.get("format") == SNAPSHOT_FORMAT:
        from pipelines.train.viscera_train.atlas_wording_snapshot import load_adapter

    identity = (str(directory.resolve()), state["manifest_sha256"])
    stage = "load"
    try:
        with _LOCK:
            if _CACHE.get("identity") != identity:
                # A download watcher is a separate process. Release this API
                # process's old model before allocating the newly selected base.
                _CACHE.clear()
                model, tokenizer = load_adapter(directory, device="auto")
                _CACHE.update(identity=identity, model=model, tokenizer=tokenizer)
            stage = "predict"
            plan = predict_plan(_CACHE["model"], _CACHE["tokenizer"], context, text)
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        # Metadata validation deliberately does not download a base model. A
        # first request can therefore encounter a cold/offline cache or a device
        # failure. Invalid generated JSON is another recoverable inference error.
        # Only these failures use the independent bounded compiler. A valid
        # model refusal below never falls through to an alternative edit.
        result = (
            dict(legacy_result)
            if legacy_result.get("status") == "accepted"
            else semantic.compile_text(templates, text, spec)
        )
        result["message"] = (
            result.get("message", "")
            + " The trained wording model was unavailable; the built-in compiler handled this request."
        ).strip()
        result["wording_model"] = {
            "bundle_sha256": state["active_bundle"],
            "method": "built_in_fallback",
            "inference_executed": stage == "predict",
            "model_failure_stage": stage,
            "fallback_reason": str(error)[:500],
        }
        return result
    checked = semantic.validate_plan(plan, context, text=text)
    result = semantic.apply_plan(templates, spec, checked, text=text)
    result["wording_model"] = {
        "bundle_sha256": state["active_bundle"],
        "method": "Qwen2.5_LoRA_semantic_plans", "inference_executed": True,
        "training_complete": state.get("format") != SNAPSHOT_FORMAT,
    }
    return result
