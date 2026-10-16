"""Retained joint model versions and explicit, validated generation selection."""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import atlas_model_registry as registry

DEFAULT_VAE_WEIGHTS = "artifacts/joint-vae/default/viscera-joint-weights.zip"
DEFAULT_VAE_SHA256 = "524a2c3c17003fefee14bf9eccf244adbc9076b44a23a1554ebec9e424cc60ca"


@lru_cache(maxsize=4)
def _install_default_vae(
    root: str, store: str, archive: str, checksum: str
) -> tuple[dict[str, Any], Path]:
    # Store and checksum participate in identity even when an operator changes
    # the environment or replaces a deployment archive in the same process.
    from .atlas_joint_model import _install_joint_weights

    return _install_joint_weights(Path(root), Path(archive))


def default_vae(root: Path) -> tuple[dict[str, Any], Path | None]:
    """Resolve the shipped V1 checkpoint without replacing any imported selection."""
    from .atlas_joint_model import _verify_renderer

    configured = os.environ.get("VISCERA_JOINT_DEFAULT_WEIGHTS")
    archive = Path(configured) if configured else root / DEFAULT_VAE_WEIGHTS
    if not archive.is_file():
        if configured:
            raise ValueError("Configured default joint VAE weights are unavailable")
        return {"version": 1, "active_bundle": None}, None
    checksum = registry.digest(archive)
    if not configured and checksum != DEFAULT_VAE_SHA256:
        raise ValueError("Bundled default joint VAE checksum changed")
    with registry._LOCK:
        state, directory = _install_default_vae(
            str(root.resolve()), str(registry.store_root(root).resolve()),
            str(archive.resolve()), checksum,
        )
        # A warm installation cache must never hide subsequent file tampering.
        if registry.digest(directory / "manifest.json") != state["manifest_sha256"]:
            raise ValueError("Bundled default joint VAE manifest changed")
        manifest = registry._read_json(directory / "manifest.json")
        registry._verify_files(directory, manifest.get("artifact_hashes"))
        _verify_renderer(root, registry._read_json(directory / "model.json"))
        return {**state, "source": "bundled_default"}, directory


def selected_generation(root: Path) -> int:
    path = registry.store_root(root) / "joint-selection.json"
    if not path.exists():
        return 1
    value = registry._read_json(path)
    if (
        value.get("version") != 1
        or type(value.get("generation")) is not int
        or value["generation"] not in (1, 2)
    ):
        raise ValueError("Invalid joint model selection; select a retained model again")
    return value["generation"]


def select_generation(root: Path, generation: int) -> None:
    if type(generation) is not int or generation not in (1, 2):
        raise ValueError("Unknown joint model generation")
    registry._atomic_json(
        registry.store_root(root) / "joint-selection.json", {"version": 1, "generation": generation}
    )


def status(root: Path) -> dict[str, Any]:
    generation = selected_generation(root)
    if generation == 2:
        from .atlas_joint_model_v2 import joint_status
    else:
        from .atlas_joint_model import joint_status
    return {**joint_status(root), "generation": generation}


def history(root: Path) -> dict[str, Any]:
    # A damaged active bundle must not hide healthy retained bundles that can
    # recover the session. Activation still runs the complete model contract.
    selection_error = None
    try:
        active = status(root)
    except (OSError, ValueError, TypeError, KeyError) as error:
        selection_error = str(error)
        try:
            generation = selected_generation(root)
        except (OSError, ValueError, TypeError, KeyError):
            generation = None
        active = {"generation": generation, "bundle_sha256": None}
    rows = []
    store = registry.store_root(root)
    for generation, folder in ((1, "joint-bundles"), (2, "joint-v2-bundles")):
        for directory in sorted((store / folder).glob("*")):
            if (
                not directory.is_dir()
                or directory.is_symlink()
                or not re.fullmatch(r"[a-f0-9]{64}", directory.name)
            ):
                continue
            try:
                manifest = registry._read_json(directory / "manifest.json")
                registry._verify_files(directory, manifest.get("artifact_hashes"))
                model = registry._read_json(directory / "model.json")
                rows.append(
                    {
                        "generation": generation,
                        "bundle_sha256": directory.name,
                        "model_sha256": registry.digest(directory / "model.npz"),
                        "method": model.get("selected_method", "unknown"),
                        "conditions": len(model.get("conditions", [])),
                        "runtime": model.get("runtime", {}),
                        "active": generation == active["generation"]
                        and directory.name == active["bundle_sha256"],
                        "integrity": "verified",
                    }
                )
            except (OSError, ValueError, TypeError, KeyError):
                rows.append(
                    {
                        "generation": generation,
                        "bundle_sha256": directory.name,
                        "active": False,
                        "integrity": "invalid",
                    }
                )
    return {
        "versions": rows,
        "selected_generation": active["generation"],
        "active_bundle": active["bundle_sha256"],
        "selection_error": selection_error,
    }


def activate_retained(root: Path, generation: int, identifier: str) -> dict[str, Any]:
    if (
        type(generation) is not int
        or generation not in (1, 2)
        or not re.fullmatch(r"[a-f0-9]{64}", identifier)
    ):
        raise ValueError("Choose a retained model generation and checksum")
    if generation == 2:
        from .atlas_joint_model_v2 import _validate_contract
    else:
        from .atlas_joint_model import _validate_contract
    folder = "joint-bundles" if generation == 1 else "joint-v2-bundles"
    pointer = "active-joint.json" if generation == 1 else "active-joint-v2.json"
    store = registry.store_root(root)
    with registry._LOCK:
        directory = store / folder / identifier
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError("Retained model is unavailable")
        manifest = registry._read_json(directory / "manifest.json")
        registry._verify_files(directory, manifest.get("artifact_hashes"))
        _validate_contract(root, directory, manifest)
        registry._atomic_json(
            store / pointer,
            {
                "version": 1,
                "active_bundle": identifier,
                "manifest_sha256": registry.digest(directory / "manifest.json"),
            },
        )
        select_generation(root, generation)
    return registry.model_status(root)
