"""Opt-in imported LoRA inference; a compiler must approve the exact proposal.

Importing this module or a weights ZIP does not load/download a base model. Cold
loading requires a separate explicit enable action. Disease and appearance are
never predicted: same-template shape edits preserve their existing recipes.
"""

from __future__ import annotations

import gc
import hashlib
import json
import sys
import threading
from pathlib import Path
from typing import Any

_LOCK = threading.RLock()
_CACHE: dict[str, Any] = {}


def _digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def clear_cache() -> None:
    """Release the enabled model when defaults are restored or explicitly disabled."""
    with _LOCK:
        _CACHE.clear()
        gc.collect()
        if "torch" in sys.modules:
            torch = sys.modules["torch"]
            if torch.cuda.is_available():
                torch.cuda.empty_cache()


def _verified_identity(
    adapter_dir: Path, language_data: Path, shape_data: Path, device: str
) -> tuple[str, dict[str, Any], str]:
    import torch

    from pipelines.train.viscera_train import atlas_language as language

    if device not in {"auto", "cpu", "cuda"}:
        raise ValueError("Unsupported text adapter device")
    resolved_device = "cuda" if device == "auto" and torch.cuda.is_available() else device
    if resolved_device == "auto":
        resolved_device = "cpu"
    if resolved_device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA is unavailable for the imported text adapter")
    language.verify_contract(language_data, shape_data)
    manifest_path = adapter_dir / "adapter_manifest.json"
    manifest = language.strict_json(manifest_path.read_text())
    identity = manifest.get("identity", {})
    cfg = identity.get("config", {})
    if (
        identity.get("format") != language.FORMAT
        or identity.get("tiny_fixture") is not False
        or identity.get("source_sha256") != _digest(Path(language.__file__))
        or identity.get("language_release_sha256") != _digest(language_data / "release.json")
        or identity.get("parent_release_sha256") != _digest(shape_data / "release.json")
        or cfg.get("model_id") != language.BASE_MODEL
        or cfg.get("revision") != language.BASE_REVISION
    ):
        raise ValueError("Imported text adapter provenance does not match this Studio")
    hashes = manifest.get("artifact_hashes", {})
    actual = {
        p.relative_to(adapter_dir).as_posix()
        for p in (adapter_dir / "adapter").rglob("*")
        if p.is_file()
    }
    if (
        not hashes
        or set(hashes) != actual
        or "adapter/adapter_model.safetensors" not in actual
        or adapter_dir.is_symlink()
        or (adapter_dir / "adapter").is_symlink()
    ):
        raise ValueError("Imported text adapter safe file set changed")
    for name, expected in hashes.items():
        path = adapter_dir / name
        if (
            not name.startswith("adapter/")
            or "\\" in name
            or ":" in name
            or any(part in {"", ".", ".."} for part in name.split("/"))
            or path.is_symlink()
            or not path.resolve().is_relative_to(adapter_dir.resolve())
            or _digest(path) != expected
        ):
            raise ValueError("Imported text adapter artifact integrity mismatch")
    fingerprint = json.dumps(
        [str(adapter_dir.resolve()), _digest(manifest_path), resolved_device], separators=(",", ":")
    )
    return fingerprint, identity, resolved_device


def is_adapter_enabled(
    adapter_dir: Path, language_data: Path, shape_data: Path, device: str = "auto"
) -> bool:
    """Distinguish persisted consent from a loaded model after process restart."""
    with _LOCK:
        if not _CACHE:
            return False
        try:
            key, _, _ = _verified_identity(adapter_dir, language_data, shape_data, device)
        except (OSError, ValueError, KeyError, TypeError, ImportError):
            return False
        return _CACHE.get("key") == key


def _default_loader(language_data: Path, shape_data: Path, adapter_dir: Path, device: str) -> Any:
    from pipelines.train.viscera_train import atlas_language as language

    return language.load_adapter(language_data, shape_data, adapter_dir, device=device)


def _enabled(
    adapter_dir: Path,
    language_data: Path,
    shape_data: Path,
    *,
    allow_model_download: bool,
    device: str,
) -> tuple[Any, Any, dict[str, Any], str]:
    key, identity, resolved_device = _verified_identity(
        adapter_dir, language_data, shape_data, device
    )
    if _CACHE.get("key") != key:
        if allow_model_download is not True:
            raise ValueError(
                "Enable the imported text adapter in Trained models first. A server restart requires enabling it again; loading may download the pinned Qwen base."
            )
        _CACHE.clear()
        model, tokenizer = _default_loader(language_data, shape_data, adapter_dir, resolved_device)
        _CACHE.update(key=key, model=model, tokenizer=tokenizer)
    return _CACHE["model"], _CACHE["tokenizer"], identity, resolved_device


def enable_adapter(
    template_root: Path,
    adapter_dir: Path,
    language_data: Path,
    shape_data: Path,
    *,
    allow_model_download: bool = False,
    device: str = "auto",
) -> dict[str, Any]:
    """Explicitly preload the reviewed base and imported adapter, never generate."""
    if not template_root.is_dir():
        raise ValueError("The Studio anatomy template library is unavailable")
    with _LOCK:
        _, _, identity, resolved_device = _enabled(
            adapter_dir,
            language_data,
            shape_data,
            allow_model_download=allow_model_download,
            device=device,
        )
    return {
        "status": "enabled_guarded_shape_adapter",
        "model_id": identity["config"]["model_id"],
        "revision": identity["config"]["revision"],
        "device": resolved_device,
        "scope": "bounded healthy atlas shape proposals; exact deterministic compiler agreement required",
        "adapter_manifest_sha256": _digest(adapter_dir / "adapter_manifest.json"),
    }


def compile_with_adapter(
    template_root: Path,
    adapter_dir: Path,
    language_data: Path,
    shape_data: Path,
    text: str,
    context: dict[str, Any],
    *,
    allow_model_download: bool = False,
    device: str = "auto",
) -> dict[str, Any]:
    """Return a fully guarded proposal or unsupported; never realize partial edits."""
    from viscera_core.atlas_disease_scene import DiseaseAtlasSpec
    from viscera_core.atlas_text import compile_text

    from pipelines.train.viscera_train import atlas_language as language

    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("Enter a bounded shape request of 1–4000 characters")
    current = DiseaseAtlasSpec.model_validate(context)
    geometry = current.geometry_spec()
    # Render/export identifiers describe the previous realization, not editable
    # anatomy. Training contexts have these fields null, and every compiler edit
    # invalidates them. Do not ask the adapter to copy stale output hashes.
    geometry_context = geometry.model_copy(
        update={"template_sha256": None, "realized_id": None}
    ).model_dump()
    authoritative = compile_text(template_root, text, geometry)
    provenance: dict[str, Any] = {
        "scope": "imported text-to-shape adapter with exact compiler guard",
        "disease_or_appearance_predicted": False,
        "adapter_inference_executed": False,
        "derived_identifiers_cleared": [
            name
            for name in ("template_sha256", "realized_id")
            if getattr(geometry, name) is not None
        ],
    }
    if authoritative["status"] != "accepted":
        return {
            **authoritative,
            "spec": None,
            "message": "The imported text adapter supports bounded shape edits only. Use the standard compiler for supported appearance or disease edits.",
            "adapter": provenance,
        }
    if authoritative["spec"]["appearance"] != current.appearance:
        return {
            "status": "unsupported",
            "spec": None,
            "message": "Use the standard compiler for appearance changes; the imported text adapter preserves the existing appearance and surface recipe.",
            "adapter": provenance,
        }
    if (current.material is not None or current.disease is not None) and authoritative["spec"][
        "template_id"
    ] != current.template_id:
        return {
            "status": "unsupported",
            "spec": None,
            "message": "Choose another reference with the standard compiler first; the text adapter preserves existing surface and disease recipes.",
            "adapter": provenance,
        }
    row = {"text": text, "context_spec": geometry_context}
    with _LOCK:
        model, tokenizer, identity, resolved_device = _enabled(
            adapter_dir,
            language_data,
            shape_data,
            allow_model_download=allow_model_download,
            device=device,
        )
        tokens = tokenizer.apply_chat_template(
            language.messages(row), tokenize=True, add_generation_prompt=True
        )
        maximum = identity["config"].get("maximum_tokens", 2048)
        if type(maximum) is not int or len(tokens) > maximum:
            raise ValueError("Text request exceeds the imported adapter token budget")
        prediction = language.predictions(model, tokenizer, [row], resolved_device)[0]
        provenance.update(
            adapter_inference_executed=True,
            adapter_manifest_sha256=_digest(adapter_dir / "adapter_manifest.json"),
            model_id=identity["config"]["model_id"],
            revision=identity["config"]["revision"],
            device=resolved_device,
        )
        try:
            checked = language.guard_proposal(prediction, template_root, text, geometry_context)
        except (ValueError, TypeError, KeyError) as error:
            return {
                "status": "unsupported",
                "spec": None,
                "message": "The imported adapter's proposal did not pass the shape compiler. No edit was applied; use the standard compiler or rephrase the request.",
                "adapter": {**provenance, "guard": "rejected", "reason": str(error)},
            }
    target = dict(checked["spec"])
    for name in ("material", "disease"):
        value = getattr(current, name)
        if value is not None:
            target[name] = value.model_dump()
    final = DiseaseAtlasSpec.model_validate(target).model_dump()
    return {
        "status": "accepted",
        "spec": final,
        "message": "Imported text adapter proposal verified. Existing surface and disease recipes were preserved.",
        "adapter": {**provenance, "guard": "passed"},
    }
