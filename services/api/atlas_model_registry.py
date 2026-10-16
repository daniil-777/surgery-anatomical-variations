"""Atomic, local imports of the final Colab weight bundle; never execute ZIP code."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import stat
import tempfile
import threading
import zipfile
from importlib import import_module
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np

FORMAT = "viscera-final-training-v1"
# This version's dependency set is frozen. Additive modules (such as the joint
# VAE) must not invalidate already trained original bundles. Every original
# renderer/trainer dependency is still required to match byte for byte.
LEGACY_CORE_SOURCES = (
    "__init__.py",
    "atlas.py",
    "atlas_appearance.py",
    "atlas_dataset.py",
    "atlas_disease.py",
    "atlas_disease_dataset.py",
    "atlas_disease_geometry_dataset.py",
    "atlas_disease_recipe_dataset.py",
    "atlas_disease_scene.py",
    "atlas_disease_text.py",
    "atlas_language.py",
    "atlas_material_bake.py",
    "atlas_material_dataset.py",
    "atlas_material_text.py",
    "atlas_materials.py",
    "atlas_scene.py",
    "atlas_surface_normals.py",
    "atlas_surface_scene.py",
    "atlas_text.py",
    "dataset.py",
    "geometry.py",
    "mechanics.py",
    "schema.py",
    "disease_profiles.json",
)
LEGACY_TRAIN_SOURCES = (
    "atlas_disease.py",
    "atlas_language.py",
    "atlas_material.py",
    "atlas_shape.py",
)
MAX_UPLOAD_BYTES = 128 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 2048
_LOCK = threading.RLock()
FILES = {
    "shape": "shape/model.pt",
    "material": "material/model.npz",
    "disease": "disease/model.npz",
}
DATA = {
    "shape": ("VISCERA_ATLAS_DATASET", "datasets/atlas/cohort-v2"),
    "material": ("VISCERA_ATLAS_MATERIAL_DATASET", "datasets/atlas/material-v1"),
    "language": ("VISCERA_ATLAS_LANGUAGE_DATASET", "datasets/atlas/language-v1"),
    "disease_recipes": ("VISCERA_DISEASE_DATASET", "disease-releases/recipes-v2"),
    "disease_geometry": ("VISCERA_DISEASE_GEOMETRY_DATASET", "disease-releases/geometry-v1"),
    "clinical": ("VISCERA_DISEASE_CLINICAL_DATASET", "disease-releases/clinical-ccby-v3"),
}
DEFAULTS = {
    "shape": ("VISCERA_ATLAS_MODEL", "artifacts/atlas/run-v2/model.pt"),
    "material": ("VISCERA_ATLAS_MATERIAL_MODEL", "artifacts/atlas/material-run-v1/model.npz"),
    "disease": ("VISCERA_DISEASE_MODEL", "artifacts/disease/recipes-run-v2/model.npz"),
}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def store_root(root: Path) -> Path:
    return Path(os.environ.get("VISCERA_MODEL_STORE", root / "data/imported-models"))


def data_paths(root: Path) -> dict[str, Path]:
    return {key: Path(os.environ.get(env, root / path)) for key, (env, path) in DATA.items()}


def _relative(name: str) -> str:
    path = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or ":" in name
        or path.is_absolute()
        or any(part in ("", ".", "..") for part in name.split("/"))
    ):
        raise ValueError("Unsafe weight archive path")
    return str(path)


def _read_json(path: Path) -> dict[str, Any]:
    def unique(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key in weight metadata")
            result[key] = value
        return result

    value = json.loads(path.read_text(), object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise ValueError("Weight metadata must be a JSON object")
    return value


def _verify_files(directory: Path, hashes: Any) -> None:
    if directory.is_symlink():
        raise ValueError("Model bundle directory must not be a symlink")
    if not isinstance(hashes, dict) or not hashes:
        raise ValueError("Weight archive has no artifact checksums")
    for name, expected in hashes.items():
        path = directory / _relative(name)
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise ValueError("Invalid artifact checksum")
        if (
            not path.is_file()
            or path.is_symlink()
            or not path.resolve().is_relative_to(directory.resolve())
            or digest(path) != expected
        ):
            raise ValueError(f"Weight artifact integrity mismatch: {name}")


def _extract(archive_path: Path, target: Path, *, prefix: str = "viscera-weights/") -> None:
    if archive_path.stat().st_size > MAX_UPLOAD_BYTES:
        raise ValueError("Weight upload exceeds 128 MiB")
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.infolist()
        if len(members) > MAX_MEMBERS or sum(x.file_size for x in members) > MAX_EXPANDED_BYTES:
            raise ValueError("Weight archive exceeds extraction limits")
        names: set[str] = set()
        for member in members:
            name = _relative(member.filename)
            mode = member.external_attr >> 16
            if (
                not name.startswith(prefix)
                or member.is_dir()
                or (stat.S_IFMT(mode) not in (0, stat.S_IFREG))
                or member.flag_bits & 1
            ):
                raise ValueError("Only regular unencrypted weight files are supported")
            relative = name.removeprefix(prefix)
            if relative in names:
                raise ValueError("Duplicate weight archive member")
            names.add(relative)
            # Reports/tokenizer metadata are inert. Only the explicitly named shape
            # checkpoint may be a torch archive, and it is loaded weights_only=True.
            suffix = PurePosixPath(relative).suffix.lower()
            inert_provenance = relative.startswith("attribution/") and suffix == ".py"
            inert_chat_template = relative == "language/adapter/chat_template.jinja" or (
                prefix == "viscera-wording-weights/" and relative == "adapter/chat_template.jinja"
            )
            if (
                suffix not in {".json", ".jsonld", ".txt", ".md", ".html", ".npz", ".safetensors"}
                and relative != "shape/model.pt"
                and not inert_provenance
                and not inert_chat_template
            ):
                raise ValueError(f"Unsupported weight archive file: {relative}")
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as src, output.open("xb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
        # Bound nested NumPy/torch ZIP payloads before their safe loaders allocate.
        nested_total = 0
        for relative in names:
            path = target / relative
            if path.suffix in {".npz", ".pt"}:
                with zipfile.ZipFile(path) as inner:
                    nested_total += sum(x.file_size for x in inner.infolist())
                    if len(inner.infolist()) > MAX_MEMBERS or nested_total > MAX_EXPANDED_BYTES:
                        raise ValueError("Expanded model tensors exceed import limits")
                    if path.suffix == ".npz":
                        for array in inner.infolist():
                            with inner.open(array) as stream:
                                version = np.lib.format.read_magic(stream)
                                if version == (1, 0):
                                    shape, _, dtype = np.lib.format.read_array_header_1_0(stream)
                                elif version == (2, 0):
                                    shape, _, dtype = np.lib.format.read_array_header_2_0(stream)
                                else:
                                    raise ValueError("Unsupported NumPy weight array format")
                                size = math.prod(shape) * dtype.itemsize
                                if (
                                    dtype.hasobject
                                    or size > MAX_EXPANDED_BYTES
                                    or size != array.file_size - stream.tell()
                                ):
                                    raise ValueError("Unsafe or inconsistent NumPy weight array")


def _validate_models(root: Path, directory: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """Use the same safe loaders and exact release/decoder contracts as inference."""
    from viscera_core import (
        atlas_dataset,
        atlas_disease_dataset,
        atlas_disease_geometry_dataset,
        atlas_disease_recipe_dataset,
        atlas_material_dataset,
    )
    from viscera_core.atlas_scene import get_template

    from pipelines.train.viscera_train import (
        atlas_disease,
        atlas_language,
        atlas_material,
        atlas_shape,
    )

    paths = data_paths(root)
    dependencies = manifest.get("dataset_dependencies")
    if not isinstance(dependencies, dict) or set(dependencies) != set(DATA):
        raise ValueError("Incomplete weight dataset dependency contract")
    for name, data in paths.items():
        if dependencies[name] != digest(data / "release.json"):
            raise ValueError(f"Installed dataset differs from weight training: {name}")
    identity = _read_json(directory / "run_identity.json")
    if (
        identity.get("format") != FORMAT
        or identity.get("config", {}).get("profile") != "full"
        or identity.get("release_hashes") != dependencies
    ):
        raise ValueError("Only complete full-profile runs with matching releases can activate")
    sources = [
        *(root / "py/viscera_core" / name for name in LEGACY_CORE_SOURCES),
        *(root / "pipelines/train/viscera_train" / name for name in LEGACY_TRAIN_SOURCES),
    ]
    code = identity.get("code_hashes", {})
    for path in sources:
        if code.get(str(path.relative_to(root))) != digest(path):
            raise ValueError(f"Weight decoder/trainer source mismatch: {path.name}")
    atlas_dataset.verify_release(paths["shape"])
    atlas_material_dataset.verify_material_release(paths["material"])
    atlas_disease_recipe_dataset.verify_release(paths["disease_recipes"])
    atlas_disease_geometry_dataset.verify_release(paths["disease_geometry"])
    clinical_release = atlas_disease_dataset.verify_release(paths["clinical"])
    atlas_language.verify_contract(paths["language"], paths["shape"])
    if clinical_release["rights"]["contains_noncommercial"]:
        raise ValueError("This importer accepts the default CC BY clinical lane only")
    safe_shape = atlas_shape.safe_load(directory / FILES["shape"])
    hidden = safe_shape.get("config", {}).get("hidden")
    if (
        type(hidden) is not int
        or not 1 <= hidden <= 1024
        or len(safe_shape.get("preprocessing", {}).get("templates", [])) > 4096
        or len(safe_shape.get("condition_names", [])) != 6
    ):
        raise ValueError("Shape model allocation exceeds the supported architecture")
    shape = atlas_shape.load_model(directory / FILES["shape"])
    material = atlas_material.load_model(directory / FILES["material"])
    disease = atlas_disease.load_recipe_model(directory / FILES["disease"])
    clinical = atlas_disease.load_source_model(directory / "clinical/source_model.json")
    if shape["condition_names"] != list(atlas_dataset.CONDITION_NAMES):
        raise ValueError("Shape model measurement names differ from the editor contract")
    shape_train = atlas_shape.read_split(paths["shape"], "train")
    material_train = atlas_material_dataset.read_split(paths["material"], "train")
    disease_train = atlas_disease_recipe_dataset.read_split(paths["disease_recipes"], "train")
    if (
        set(shape["preprocessing"]["templates"]) != set(shape_train["template_ids"].tolist())
        or set(material["group_names"].tolist())
        != set(atlas_material.group_names(material_train).tolist())
        or set(disease["profiles"]) != set(disease_train["profile_ids"].tolist())
    ):
        raise ValueError(
            "Model vocabulary must cover every template, material group and supported disease in training"
        )
    if clinical["rights"] != clinical_release["rights"]:
        raise ValueError("Clinical model rights differ from its source release")
    if (
        shape["dataset_hashes"]["release.json"] != dependencies["shape"]
        or material["metadata"]["identity"]["dataset_release_sha256"] != dependencies["material"]
        or disease["dataset_hashes"]["release.json"] != dependencies["disease_recipes"]
        or clinical["dataset_hashes"]["release.json"] != dependencies["clinical"]
    ):
        raise ValueError("A model's embedded training release differs from its import manifest")
    template_root = Path(
        os.environ.get("VISCERA_ATLAS_TEMPLATES", root / "datasets/atlas/cohort-v2/templates")
    )
    for name in shape["preprocessing"]["templates"]:
        if (
            get_template(template_root, name).metadata["artifact_sha256"]
            != get_template(paths["shape"] / "templates", name).metadata["artifact_sha256"]
        ):
            raise ValueError(f"Installed Studio template differs from trained model: {name}")
        controls = atlas_shape.sample_controls(shape, name, count=1, seed=42)
        if controls.shape != (1, 7) or not np.isfinite(controls).all() or np.any(abs(controls) > 1):
            raise ValueError("Shape model produced invalid bounded controls")
    from viscera_core.atlas_disease import DiseaseSpec
    from viscera_core.atlas_materials import MaterialRecipe

    for group in material["group_names"]:
        organ, preset = str(group).split("|")
        MaterialRecipe.model_validate(
            atlas_material.sample_recipe(material, organ, preset, 42)["recipe"]
        )
    for profile in disease["profiles"]:
        DiseaseSpec.model_validate(atlas_disease.sample_recipes(disease, profile, 42, count=1)[0])
    # Exercise the serving disease contract, including active profile/source hashes.
    from .atlas_disease_model import sample_recipe_model

    sample_recipe_model(
        directory / FILES["disease"], paths["disease_recipes"], disease["profiles"][0], 42
    )
    language_status = "not_included"
    if (directory / "language").exists():
        adapter = _read_json(directory / "language/adapter_manifest.json")
        ai = adapter.get("identity", {})
        cfg = ai.get("config", {})
        if (
            ai.get("format") != atlas_language.FORMAT
            or ai.get("tiny_fixture") is not False
            or ai.get("source_sha256") != digest(Path(atlas_language.__file__))
            or ai.get("language_release_sha256") != dependencies["language"]
            or ai.get("parent_release_sha256") != dependencies["shape"]
            or cfg.get("model_id") != atlas_language.BASE_MODEL
            or cfg.get("revision") != atlas_language.BASE_REVISION
        ):
            raise ValueError("Language adapter provenance does not match its guarded runtime")
        _verify_files(directory / "language", adapter.get("artifact_hashes"))
        adapter_hashes = adapter["artifact_hashes"]
        actual = {
            str(p.relative_to(directory / "language"))
            for p in (directory / "language/adapter").rglob("*")
            if p.is_file()
        }
        if (
            set(adapter_hashes) != actual
            or "adapter/adapter_model.safetensors" not in actual
            or any(not name.startswith("adapter/") for name in actual)
        ):
            raise ValueError("Language adapter safe file set changed")
        from safetensors import safe_open

        with safe_open(
            directory / "language/adapter/adapter_model.safetensors", framework="pt", device="cpu"
        ) as tensors:
            for name in tensors.keys():
                if math.prod(tensors.get_slice(name).get_shape()) > MAX_EXPANDED_BYTES // 4:
                    raise ValueError("Language tensor exceeds import limits")
        language_status = "stored_research_adapter_not_enabled"
    return {
        "shape": {
            "status": "active",
            "method": shape["selected_method"],
            "scope": "synthetic geometry controls",
        },
        "material": {
            "status": "active",
            "method": material["metadata"]["selected"],
            "scope": "procedural appearance controls",
        },
        "disease": {
            "status": "active",
            "method": disease["selected_method"],
            "scope": "synthetic disease surface recipes",
        },
        "clinical": {
            "status": "stored_retrieval_prior",
            "scope": "observed training cases only; not an editor generator",
            "groups": [
                {"organ": group["organ"], "disease_code": group["disease_code"]}
                for group in clinical["groups"]
            ],
        },
        "language": {
            "status": language_status,
            "scope": "Studio continues to use its guarded deterministic text compiler",
        },
        "physics": {"status": "not_trained", "scope": "no constitutive mechanics learned"},
    }


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _active(root: Path) -> tuple[dict[str, Any], Path | None]:
    store = store_root(root)
    pointer = store / "active.json"
    registry = _read_json(pointer) if pointer.exists() else {"version": 1, "active_bundle": None}
    if registry.get("version") != 1 or "active_bundle" not in registry:
        raise ValueError("Invalid active model registry; restore defaults or import again")
    identifier = registry.get("active_bundle")
    if identifier is None:
        return registry, None
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{64}", identifier):
        raise ValueError("Invalid active model registry")
    directory = store / "bundles" / identifier
    if digest(directory / "manifest.json") != registry.get("manifest_sha256"):
        raise ValueError("Active model manifest changed; restore defaults or import again")
    return registry, directory


def resolve_model(root: Path, lane: str) -> Path:
    _, directory = _active(root)
    if directory is not None:
        manifest = _read_json(directory / "manifest.json")
        selected = {
            name: sha
            for name, sha in manifest["artifact_hashes"].items()
            if name.startswith(lane + "/")
        }
        _verify_files(directory, selected)
        return directory / FILES[lane]
    env, relative = DEFAULTS[lane]
    return Path(os.environ.get(env, root / relative))


def resolve_imported_lane(root: Path, lane: str) -> tuple[str, Path]:
    """Research/retrieval artifacts exist only in an explicitly imported bundle."""
    if lane not in {"language", "clinical"}:
        raise ValueError("Unknown imported research lane")
    registry, directory = _active(root)
    if directory is None:
        raise ValueError("Import compatible full Colab weights first")
    hashes = _read_json(directory / "manifest.json")["artifact_hashes"]
    _verify_files(
        directory, {name: sha for name, sha in hashes.items() if name.startswith(lane + "/")}
    )
    return str(registry["active_bundle"]), directory / lane


def mark_language_enabled(root: Path, identifier: str) -> dict[str, Any]:
    with _LOCK:
        registry, directory = _active(root)
        if directory is None or registry.get("active_bundle") != identifier:
            raise ValueError("Active weights changed during language model loading; enable again")
        registry["language_enabled"] = True
        registry["lanes"]["language"]["status"] = "enabled_guarded_adapter"
        registry["lanes"]["language"]["scope"] = (
            "shape text proposals must agree with the deterministic compiler"
        )
        _atomic_json(store_root(root) / "active.json", registry)
    return model_status(root)


def language_enabled(root: Path) -> bool:
    registry, directory = _active(root)
    return _language_ready(root, registry, directory)


def _language_ready(root: Path, registry: dict[str, Any], directory: Path | None) -> bool:
    if directory is None or registry.get("language_enabled") is not True:
        return False
    from .atlas_language_model import is_adapter_enabled

    data = data_paths(root)
    return is_adapter_enabled(directory / "language", data["language"], data["shape"])


def model_status(root: Path) -> dict[str, Any]:
    registry, directory = _active(root)
    if directory:
        _verify_files(directory, _read_json(directory / "manifest.json")["artifact_hashes"])
    lanes = (
        {name: dict(lane) for name, lane in registry.get("lanes", {}).items()}
        if directory
        else {
            name: {
                "status": "available" if resolve_model(root, name).is_file() else "unavailable",
                "scope": "packaged default control model",
            }
            for name in FILES
        }
    )
    ready = _language_ready(root, registry, directory)
    if directory and "language" in lanes and lanes["language"].get("status") != "not_included":
        lanes["language"]["status"] = (
            "enabled_guarded_adapter" if ready else "stored_research_adapter_not_enabled"
        )
    from .atlas_joint_registry import status as joint_status

    joint = joint_status(root)
    lanes["joint"] = joint["lane"]
    from .atlas_wording_model import status as wording_status

    wording = wording_status(root)
    lanes["wording"] = wording["lane"]
    # Physics is an independent local training lane, not part of the uploaded
    # shape/material/disease archive or its activation pointer.
    physics_ready = False
    physics_directory = Path(
        os.environ.get("VISCERA_PHYSICS_MODEL", root / "artifacts/physics/liver-network-v1")
    )
    try:
        physics = import_module("viscera_core.physics_learning")
        _, physics_digest = physics.load_model(physics_directory)
        physics_report = _read_json(physics_directory / "evaluation.json")
        physics_ready = (
            physics_report.get("model_sha256") == physics_digest
            and physics_report.get("synthetic_gate_passed") is True
        )
        if physics_ready:
            lanes["physics"] = {
                "status": "active",
                "method": "separate_inverse_SLS_ensemble",
                "scope": physics.SCOPE,
            }
    except (ImportError, OSError, ValueError, KeyError):
        # Some serving bundles omit this separate optional research lane.
        pass
    return {
        "source": "imported" if directory else "defaults",
        "bundle_sha256": registry.get("active_bundle"),
        "lanes": lanes,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "activation": "all models validated before atomic switch",
        "text_runtime": "trained context-aware semantic plans"
        if wording["bundle_sha256"]
        else "opt-in imported adapter with deterministic compiler guard"
        if ready else "guarded deterministic compiler",
        "physics_parameters_learned": physics_ready,
        "language_enabled": ready,
        "joint_bundle_sha256": joint["bundle_sha256"],
        "joint_generation": joint["generation"],
        "wording_bundle_sha256": wording["bundle_sha256"],
    }


def import_weights(root: Path, archive_path: Path) -> dict[str, Any]:
    # The joint VAE is an independent lane. Importing it must not deactivate
    # existing shape, surface, disease or language weights.
    if archive_path.stat().st_size > MAX_UPLOAD_BYTES:
        raise ValueError("Weight upload exceeds 128 MiB")
    with zipfile.ZipFile(archive_path) as archive:
        if "viscera-wording-weights/manifest.json" in archive.namelist():
            from .atlas_wording_model import import_weights as import_wording_weights

            return import_wording_weights(root, archive_path)
        if "viscera-joint-v2-weights/manifest.json" in archive.namelist():
            from .atlas_joint_model_v2 import import_joint_weights

            return import_joint_weights(root, archive_path)
        if "viscera-joint-weights/manifest.json" in archive.namelist():
            from .atlas_joint_model import import_joint_weights

            return import_joint_weights(root, archive_path)
    store = store_root(root)
    store.mkdir(parents=True, exist_ok=True)
    with _LOCK, tempfile.TemporaryDirectory(prefix=".staging-", dir=store) as temporary:
        stage = Path(temporary)
        _extract(archive_path, stage)
        manifest = _read_json(stage / "manifest.json")
        if manifest.get("format") != FORMAT or manifest.get("smoke_only") is not False:
            raise ValueError(
                "Only final full-profile Colab weights may activate; smoke weights are diagnostic"
            )
        hashes = manifest.get("artifact_hashes")
        if not isinstance(hashes, dict):
            raise ValueError("Weight archive has no artifact checksums")
        _verify_files(stage, hashes)
        if {str(p.relative_to(stage)) for p in stage.rglob("*") if p.is_file()} != set(hashes) | {
            "manifest.json"
        }:
            raise ValueError("Weight ZIP contains unmanifested files")
        lanes = _validate_models(root, stage, manifest)
        identifier = digest(archive_path)
        destination = store / "bundles" / identifier
        destination.parent.mkdir(exist_ok=True)
        if destination.exists():
            _verify_files(destination, hashes)
            if digest(destination / "manifest.json") != digest(stage / "manifest.json"):
                raise ValueError("Stored model bundle changed")
        else:
            os.replace(stage, destination)
        _atomic_json(
            store / "active.json",
            {
                "version": 1,
                "active_bundle": identifier,
                "manifest_sha256": digest(destination / "manifest.json"),
                "lanes": lanes,
            },
        )
        from .atlas_language_model import clear_cache

        clear_cache()
    return model_status(root)


def restore_defaults(root: Path) -> dict[str, Any]:
    with _LOCK:
        _atomic_json(store_root(root) / "active.json", {"version": 1, "active_bundle": None})
        _atomic_json(store_root(root) / "active-joint.json", {"version": 1, "active_bundle": None})
        _atomic_json(store_root(root) / "active-joint-v2.json", {"version": 1, "active_bundle": None})
        _atomic_json(store_root(root) / "active-wording.json", {"version": 1, "active_bundle": None})
        from .atlas_wording_model import clear_cache as clear_wording_cache

        clear_wording_cache()
        from .atlas_joint_registry import select_generation

        select_generation(root, 1)
        from .atlas_language_model import clear_cache

        clear_cache()
    return model_status(root)
