"""Validated joint shape/appearance/disease VAE imports and NumPy inference.

This lane is independent from the original Colab bundle. A failed import never
changes either active pointer, and no code from a weight archive is executed.
"""

from __future__ import annotations

import os
import re
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import atlas_model_registry as registry

FORMAT = "viscera-joint-vae-v1"
PREFIX = "viscera-joint-weights/"
SCOPE = "joint synthetic shape, tissue color and disease controls; not measured clinical realism"


def _template_root(root: Path) -> Path:
    return Path(
        os.environ.get("VISCERA_ATLAS_TEMPLATES", root / "datasets/atlas/cohort-v2/templates")
    )


def _active(root: Path) -> tuple[dict[str, Any], Path | None]:
    pointer = registry.store_root(root) / "active-joint.json"
    state = (
        registry._read_json(pointer) if pointer.exists() else {"version": 1, "active_bundle": None}
    )
    if state.get("version") != 1 or "active_bundle" not in state:
        raise ValueError("Invalid joint model registry; restore defaults or import again")
    identifier = state.get("active_bundle")
    if identifier is None:
        from .atlas_joint_registry import default_vae

        return default_vae(root)
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{64}", identifier):
        raise ValueError("Invalid joint model registry")
    directory = registry.store_root(root) / "joint-bundles" / identifier
    if registry.digest(directory / "manifest.json") != state.get("manifest_sha256"):
        raise ValueError("Active joint model manifest changed; restore defaults or import again")
    manifest = registry._read_json(directory / "manifest.json")
    registry._verify_files(directory, manifest.get("artifact_hashes"))
    return state, directory


def joint_status(root: Path) -> dict[str, Any]:
    state, directory = _active(root)
    return {
        "bundle_sha256": state.get("active_bundle"),
        "lane": {
            "status": "active" if directory else "not_included",
            "source": state.get("source", "imported") if directory else "unavailable",
            **({"method": "joint_conditional_vae"} if directory else {}),
            "scope": SCOPE
            if directory
            else "Import joint VAE weights to sample all three together",
        },
    }


@lru_cache(maxsize=2)
def _load(path: str, weights_sha256: str, metadata_sha256: str) -> dict[str, Any]:
    from viscera_core.atlas_joint import load_model

    model = load_model(Path(path))
    for array in model["arrays"].values():
        array.flags.writeable = False
    return model


def _model(directory: Path) -> dict[str, Any]:
    path = directory / "model.npz"
    return _load(
        str(path.resolve()), registry.digest(path), registry.digest(path.with_suffix(".json"))
    )


def _verify_renderer(root: Path, meta: dict[str, Any]) -> None:
    from viscera_core.atlas_joint import RENDERER_PATHS

    from .atlas_renderer_compat import matches_renderer_source

    renderer = meta.get("renderer_hashes")
    if not isinstance(renderer, dict) or set(renderer) != set(RENDERER_PATHS):
        raise ValueError("Joint model must bind every frozen renderer source")
    decoder = "py/viscera_core/atlas_joint.py"
    for name, expected in {**renderer, decoder: meta.get("model_decoder_sha256")}.items():
        path = root / registry._relative(name)
        if (
            not isinstance(expected, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected)
            or not path.is_file()
            or not path.resolve().is_relative_to(root.resolve())
            or not matches_renderer_source(name, expected, registry.digest(path))
        ):
            raise ValueError(f"Joint renderer source differs from training: {name}")


def _verify_template(root: Path, meta: dict[str, Any], template_id: str) -> Any:
    from viscera_core.atlas_scene import get_template

    templates = _template_root(root)
    template = get_template(templates, template_id)
    if registry.digest(templates / f"{template_id}.npz") != meta.get("template_hashes", {}).get(
        template_id
    ) or registry.digest(templates / f"{template_id}.json") != meta.get(
        "template_metadata_hashes", {}
    ).get(template_id):
        raise ValueError(f"Installed anatomy reference differs from joint training: {template_id}")
    return template


def _validate_contract(root: Path, directory: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    from viscera_core.atlas_disease import PROFILES
    from viscera_core.atlas_disease_scene import DiseaseAtlasSpec
    from viscera_core.atlas_joint import sample_joint

    meta = registry._read_json(directory / "model.json")
    if (
        manifest.get("format") != FORMAT
        or manifest.get("smoke_only") is not False
        or manifest.get("profile") != "full"
        or meta.get("format") != FORMAT
        or meta.get("selected_method") != "joint_conditional_vae"
        or meta.get("training_profile") != "full"
        or type(meta.get("completed_steps")) is not int
        or meta["completed_steps"] < 1000
        or meta["completed_steps"] != meta.get("config", {}).get("steps")
        or type(meta.get("config", {}).get("surrogate_steps")) is not int
        or meta["config"]["surrogate_steps"] < 200
    ):
        raise ValueError(
            "Only completed full-profile joint VAE weights can activate; smoke is diagnostic"
        )
    dependencies = manifest.get("dataset_dependencies")
    if not isinstance(dependencies, dict) or set(dependencies) != {"baseline", "disease"}:
        raise ValueError("Joint model must bind both baseline and disease dataset releases")
    for lane, expected in dependencies.items():
        if (
            not isinstance(expected, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected)
            or registry.digest(directory / "data" / f"{lane}-release.json") != expected
            or meta.get("dataset_hashes", {}).get(f"{lane}/release.json") != expected
        ):
            raise ValueError(f"Joint training dataset provenance mismatch: {lane}")
    _verify_renderer(root, meta)
    conditions = meta.get("conditions")
    template_hashes = meta.get("template_hashes")
    if (
        not isinstance(conditions, list)
        or not 1 <= len(conditions) <= 4096
        or any(not isinstance(condition, dict) for condition in conditions)
        or not isinstance(template_hashes, dict)
        or set(template_hashes) != {condition.get("template_id") for condition in conditions}
        or not isinstance(meta.get("template_metadata_hashes"), dict)
        or set(meta["template_metadata_hashes"]) != set(template_hashes)
    ):
        raise ValueError("Joint model condition/template catalog is incomplete")
    audit = registry._read_json(directory / "exact-renderer-audit.json")
    audited = audit.get("conditions")
    if (
        audit.get("format") != "viscera-joint-exact-renderer-audit-v1"
        or audit.get("passed") is not True
        or audit.get("model_sha256") != registry.digest(directory / "model.npz")
        or audit.get("condition_count") != len(conditions)
        or type(audit.get("rendered_samples")) is not int
        or audit["rendered_samples"] < 3 * len(conditions)
        or not isinstance(audited, list)
        or len(audited) != len(conditions)
        or any(not isinstance(row, dict) or row.get("passed") is not True for row in audited)
        or {(row.get("template_id"), row.get("profile_id")) for row in audited}
        != {(row.get("template_id"), row.get("profile_id")) for row in conditions}
    ):
        raise ValueError("Joint weights require a passed exact-renderer audit for every condition")
    organs: dict[str, str] = {}
    for name in template_hashes:
        template = _verify_template(root, meta, name)
        organs[name] = template.metadata["organ"]
    model = _model(directory)
    seen: set[tuple[str, str]] = set()
    for condition in conditions:
        template_id = condition.get("template_id")
        profile = condition.get("profile_id")
        key = (template_id, profile)
        if (
            not isinstance(profile, str)
            or key in seen
            or condition.get("organ") != organs[template_id]
            or (
                profile != "baseline"
                and (profile not in PROFILES or PROFILES[profile]["organ"] != organs[template_id])
            )
        ):
            raise ValueError("Joint disease condition does not match its anatomical reference")
        seen.add(key)
        disease_id = None if profile == "baseline" else profile
        sampled = sample_joint(model, template_id, disease_id, 42, temperature=1.0)
        spec = DiseaseAtlasSpec.model_validate(
            {
                "template_id": template_id,
                "seed": 42,
                "appearance": "tissue",
                "controls": sampled["controls"],
                "material": sampled["material"],
                "disease": sampled["disease"],
            }
        )
        if (
            spec.material is None
            or spec.material.organ != organs[template_id]
            or (spec.disease.profile_id if spec.disease else None) != disease_id
        ):
            raise ValueError("Joint VAE output does not match its organ/disease condition")
    return meta


def _install_joint_weights(root: Path, archive: Path) -> tuple[dict[str, Any], Path]:
    """Validate and retain inert weights without changing the selected model."""
    if archive.stat().st_size > registry.MAX_UPLOAD_BYTES:
        raise ValueError("Weight upload exceeds 128 MiB")
    store = registry.store_root(root)
    store.mkdir(parents=True, exist_ok=True)
    with registry._LOCK, tempfile.TemporaryDirectory(prefix=".joint-staging-", dir=store) as tmp:
        stage = Path(tmp)
        registry._extract(archive, stage, prefix=PREFIX)
        manifest = registry._read_json(stage / "manifest.json")
        hashes = manifest.get("artifact_hashes")
        registry._verify_files(stage, hashes)
        actual = {str(path.relative_to(stage)) for path in stage.rglob("*") if path.is_file()}
        if actual != set(hashes) | {"manifest.json"}:
            raise ValueError("Joint weight ZIP contains unmanifested files")
        if any(Path(name).suffix not in {".json", ".npz", ".md", ".txt"} for name in actual):
            raise ValueError(
                "Joint weight ZIP accepts only inert model arrays, reports and metadata"
            )
        _validate_contract(root, stage, manifest)
        identifier = registry.digest(archive)
        destination = store / "joint-bundles" / identifier
        destination.parent.mkdir(exist_ok=True)
        if destination.exists():
            registry._verify_files(destination, hashes)
            if registry.digest(destination / "manifest.json") != registry.digest(
                stage / "manifest.json"
            ):
                raise ValueError("Stored joint model bundle changed")
        else:
            os.replace(stage, destination)
        return {
            "version": 1,
            "active_bundle": identifier,
            "manifest_sha256": registry.digest(destination / "manifest.json"),
        }, destination


def import_joint_weights(root: Path, archive: Path) -> dict[str, Any]:
    with registry._LOCK:
        state, _ = _install_joint_weights(root, archive)
        registry._atomic_json(registry.store_root(root) / "active-joint.json", state)
        from .atlas_joint_registry import select_generation

        select_generation(root, 1)
    return registry.model_status(root)


def sample_model(root: Path, spec: Any, seed: int, temperature: float) -> dict[str, Any]:
    from viscera_core.atlas_disease_scene import DiseaseAtlasSpec, realize
    from viscera_core.atlas_joint import sample_joint

    state, directory = _active(root)
    if directory is None:
        raise ValueError("Import joint VAE Colab weights in Trained models before joint sampling")
    profile = spec.disease.profile_id if spec.disease else None
    model = _model(directory)
    _verify_renderer(root, model)
    _verify_template(root, model, spec.template_id)
    sampled = sample_joint(model, spec.template_id, profile, seed, temperature=temperature)
    target = DiseaseAtlasSpec.model_validate(
        {
            "template_id": spec.template_id,
            "seed": seed,
            "appearance": "tissue",
            "controls": sampled["controls"],
            "material": sampled["material"],
            "disease": sampled["disease"],
        }
    )
    if (
        target.disease.profile_id if target.disease else None
    ) != profile or target.material is None:
        raise ValueError("Joint VAE output differs from the requested disease condition")
    result = realize(_template_root(root), target)
    provenance = {
        **sampled["model"],
        "model_sha256": registry.digest(directory / "model.npz"),
        "bundle_sha256": state["active_bundle"],
        "request_seed": seed,
        "temperature": temperature,
        "template_id": spec.template_id,
        "profile_id": profile,
        "material_seed": target.material.seed,
        "spatial_seed": target.disease.seed if target.disease else None,
    }
    result["summary"]["joint_model"] = provenance
    result["scene"]["metadata"]["joint_model"] = provenance
    return result
