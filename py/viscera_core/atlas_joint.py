"""Joint shape/appearance/disease recipe CVAE contract and NumPy deployment.

The learned decoder proposes bounded editor controls; the versioned renderer
retains full source topology and evaluates continuous authored tissue fields.
This is a synthetic design distribution, not measured patient/optical physics.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

from .atlas import CONTROL_NAMES as SHAPE_NAMES
from .atlas_disease_recipe_dataset import FEATURE_NAMES as _DISEASE_NAMES
from .atlas_disease_recipe_dataset import decode_recipe, encode_recipe
from .atlas_material_dataset import CONTROL_NAMES as MATERIAL_NAMES
from .atlas_material_dataset import controls_recipe, recipe_controls

DISEASE_NAMES = tuple(_DISEASE_NAMES)
CONTROL_NAMES = (
    tuple("shape." + n for n in SHAPE_NAMES)
    + tuple("material." + n for n in MATERIAL_NAMES)
    + tuple("disease." + n for n in DISEASE_NAMES)
)
OBSERVATION_NAMES = (
    "x_normalized",
    "y_normalized",
    "z_normalized",
    "red_linear",
    "green_linear",
    "blue_linear",
    "roughness",
)
FORMAT = "viscera-joint-vae-v1"
DATASET_FORMAT = "viscera-joint-dataset-v1"
RENDERER_PATHS = tuple(
    "py/viscera_core/" + name
    for name in (
        "atlas.py",
        "atlas_scene.py",
        "atlas_appearance.py",
        "atlas_materials.py",
        "atlas_material_dataset.py",
        "atlas_surface_scene.py",
        "atlas_surface_normals.py",
        "atlas_disease.py",
        "atlas_disease_scene.py",
        "atlas_disease_recipe_dataset.py",
        "disease_profiles.json",
    )
)
SCOPE = "joint synthetic geometry, authored tissue colour and disease design recipes; not a patient distribution or measured tissue physics"


def digest(path: Path) -> str:
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def condition_key(condition: dict[str, Any]) -> tuple[str, str]:
    return str(condition["template_id"]), str(condition["profile_id"])


def validate_conditions(conditions: list[dict[str, Any]]) -> None:
    if not conditions or len(set(map(condition_key, conditions))) != len(conditions):
        raise ValueError("Joint conditions must be nonempty and unique")
    from .atlas_disease import disease_catalog
    from .atlas_materials import PRESETS, PROFILES

    profiles = {p["id"]: p for p in disease_catalog()["profiles"] if p.get("supported")}
    for row in conditions:
        if type(row.get("renderer_seed")) is not int or not 0 <= row["renderer_seed"] < 2**32:
            raise ValueError("Joint conditions require deterministic uint32 renderer_seed")
        if not isinstance(row.get("template_id"), str) or not row["template_id"]:
            raise ValueError("Invalid joint template identifier")
        if row.get("organ") not in PROFILES or row.get("material_preset") not in PRESETS:
            raise ValueError("Unknown joint organ or material preset")
        if row["profile_id"] != "baseline":
            profile = profiles.get(row["profile_id"])
            if not profile or profile["organ"] != row["organ"]:
                raise ValueError("Unsupported disease/organ condition")


def encode_controls(shape: Any, material: Any, disease: dict[str, Any] | None) -> np.ndarray:
    s = np.asarray(
        [shape[n] for n in SHAPE_NAMES] if isinstance(shape, dict) else shape, dtype=np.float32
    )
    if s.shape != (7,):
        raise ValueError("Expected seven shape controls")
    values = np.concatenate(
        (s, recipe_controls(material), 2 * encode_recipe(disease) - 1 if disease else np.zeros(9))
    )
    if not np.isfinite(values).all() or np.any(np.abs(values) > 1 + 1e-6):
        raise ValueError("Joint controls must be finite in [-1,1]")
    return np.clip(values, -1, 1).astype(np.float32)


def decode_controls(condition: dict[str, Any], values: Any, seed: int) -> dict[str, Any]:
    values = np.asarray(values, dtype=np.float64)
    if values.shape != (22,) or not np.isfinite(values).all() or np.any(np.abs(values) > 1):
        raise ValueError("Expected 22 finite joint controls in [-1,1]")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Joint seed must be uint32")
    rng = np.random.default_rng(condition["renderer_seed"])
    material_seed, disease_seed = [int(v) for v in rng.integers(0, 2**32, size=2)]
    material = controls_recipe(
        condition["organ"], condition["material_preset"], material_seed, values[7:13]
    )
    disease = (
        None
        if condition["profile_id"] == "baseline"
        else decode_recipe(condition["profile_id"], (values[13:] + 1) / 2, disease_seed)
    )
    return {
        "controls": dict(zip(SHAPE_NAMES, map(float, values[:7]), strict=True)),
        "material": material.model_dump(mode="json"),
        "disease": disease,
    }


def validate_split(data: dict[str, np.ndarray], conditions: list[dict[str, Any]]) -> None:
    validate_conditions(conditions)
    x, obs, ids = data["controls"], data["observations"], data["condition_ids"]
    if x.ndim != 2 or x.shape[1] != 22 or not len(x):
        raise ValueError("Joint data requires nonempty N x 22 controls")
    if not np.isfinite(x).all() or np.any(np.abs(x) > 1 + 1e-6):
        raise ValueError("Joint controls exceed finite [-1,1] support")
    if obs.ndim != 3 or obs.shape[0] != len(x) or obs.shape[1] < 8 or obs.shape[2] != 7:
        raise ValueError("Joint observations must be N x P x 7, P >= 8")
    if not np.isfinite(obs).all() or np.any((obs[:, :, 3:] < 0) | (obs[:, :, 3:] > 1)):
        raise ValueError("Invalid rendered colour/roughness observations")
    if (
        ids.shape != (len(x),)
        or ids.dtype.kind not in "iu"
        or np.any(ids < 0)
        or np.any(ids >= len(conditions))
    ):
        raise ValueError("Invalid joint condition IDs")
    for name in ("sample_ids", "group_ids"):
        a = data[name]
        if a.shape != (len(x),) or a.dtype.kind not in "US" or not all(a):
            raise ValueError("Invalid joint " + name)
    if len(np.unique(data["sample_ids"])) != len(x):
        raise ValueError("Repeated joint sample IDs")
    seeds = data["seeds"]
    if (
        seeds.shape != (len(x),)
        or seeds.dtype.kind not in "iu"
        or np.any(seeds < 0)
        or np.any(seeds >= 2**32)
    ):
        raise ValueError("Invalid joint seeds")
    for i, condition in enumerate(conditions):
        if condition["profile_id"] == "baseline" and np.any(x[ids == i, 13:] != 0):
            raise ValueError("Baseline rows must have masked zero disease controls")


def verify_release(root: Path) -> dict[str, Any]:
    root = Path(root)
    release = json.loads((root / "release.json").read_text())
    if release.get("format") != DATASET_FORMAT:
        raise ValueError("Unsupported joint dataset format")
    required = {"train.npz", "val.npz", "audit.npz", "catalog.json"}
    if not required <= release.get("artifact_hashes", {}).keys():
        raise ValueError("Joint release missing required artifact hashes")
    for name, sha in release["artifact_hashes"].items():
        path = root / name
        if (
            Path(name).is_absolute()
            or ".." in Path(name).parts
            or path.is_symlink()
            or not path.resolve().is_relative_to(root.resolve())
            or digest(path) != sha
        ):
            raise ValueError("Joint release checksum/path mismatch: " + name)
    return release


def read_split(root: Path, split: str) -> dict[str, np.ndarray]:
    if split not in ("train", "val", "audit"):
        raise ValueError("Unknown joint split")
    root = Path(root)
    release = json.loads((root / "release.json").read_text())
    if release.get("format") != DATASET_FORMAT or release["artifact_hashes"][
        split + ".npz"
    ] != digest(root / (split + ".npz")):
        raise ValueError("Joint split checksum mismatch")
    with np.load(root / (split + ".npz"), allow_pickle=False) as archive:
        result = {k: archive[k].copy() for k in archive.files}
    validate_split(result, json.loads((root / "catalog.json").read_text())["conditions"])
    return result


def _silu(x: np.ndarray) -> np.ndarray:
    return x / (1 + np.exp(-np.clip(x, -60, 60)))


def decode_latents(model: dict[str, Any], ids: np.ndarray, z: np.ndarray) -> np.ndarray:
    """Exact deployment of the shared trunk plus three jointly trained heads."""
    arrays = model["arrays"]
    h = np.concatenate((np.asarray(z, dtype=np.float32), arrays["embedding.weight"][ids]), 1)
    for index in (0, 2):
        h = _silu(h @ arrays[f"decoder.{index}.weight"].T + arrays[f"decoder.{index}.bias"])
    values = np.concatenate(
        [
            np.tanh(h @ arrays[f"{name}_head.weight"].T + arrays[f"{name}_head.bias"])
            for name in ("shape", "material", "disease")
        ],
        1,
    )
    return np.asarray(values, dtype=np.float32)


def load_model(path: Path) -> dict[str, Any]:
    path = Path(path)
    sha = digest(path)
    manifest = json.loads(path.with_suffix(".json").read_text())
    if manifest.get("format") != FORMAT or manifest.get("artifact_sha256") != sha:
        raise ValueError("Joint model checksum or format mismatch")
    with np.load(path, allow_pickle=False) as archive:
        meta = json.loads(str(archive["metadata_json"].item()))
        arrays = {k: archive[k].copy() for k in archive.files if k != "metadata_json"}
    if meta != {k: v for k, v in manifest.items() if k != "artifact_sha256"}:
        raise ValueError("Joint metadata payload differs from manifest")
    if meta.get("selected_method") != "joint_conditional_vae" or meta.get("feature_names") != list(
        CONTROL_NAMES
    ):
        raise ValueError("Unsupported joint method or control schema")
    if meta.get("observation_names") != list(OBSERVATION_NAMES):
        raise ValueError("Unsupported joint observation schema")
    if (
        meta.get("training_profile") not in ("full", "smoke")
        or type(meta.get("completed_steps")) is not int
        or meta["completed_steps"] < 1
    ):
        raise ValueError("Invalid joint training provenance")
    validate_conditions(meta["conditions"])
    c = meta["config"]
    for name in ("hidden", "latent", "embedding"):
        if type(c[name]) is not int or not 1 <= c[name] <= 2048:
            raise ValueError("Invalid joint architecture")
    k, h, z, e = len(meta["conditions"]), c["hidden"], c["latent"], c["embedding"]
    expected = {
        "embedding.weight": (k, e),
        "prior_mean.weight": (k, z),
        "prior_logvar.weight": (k, z),
        "decoder.0.weight": (h, z + e),
        "decoder.0.bias": (h,),
        "decoder.2.weight": (h, h),
        "decoder.2.bias": (h,),
        "control_min": (k, 22),
        "control_max": (k, 22),
    }
    for name, size in (("shape", 7), ("material", 6), ("disease", 9)):
        expected[name + "_head.weight"] = (size, h)
        expected[name + "_head.bias"] = (size,)
    if set(arrays) != set(expected):
        raise ValueError("Unexpected or missing joint deployment tensors")
    for name, shape in expected.items():
        if (
            arrays[name].shape != shape
            or arrays[name].dtype.kind != "f"
            or not np.isfinite(arrays[name]).all()
        ):
            raise ValueError("Invalid joint parameter: " + name)
    lo, hi = arrays["control_min"], arrays["control_max"]
    if np.any(lo > hi) or np.any(lo < -1) or np.any(hi > 1):
        raise ValueError("Invalid joint training support")
    if np.any(np.abs(arrays["prior_logvar.weight"]) > 12):
        raise ValueError("Unbounded joint prior variance")
    return {**meta, "arrays": arrays, "artifact_sha256": sha}


def sample_joint(
    model: dict[str, Any],
    template_id: str,
    profile_id: str | None,
    seed: int,
    temperature: float = 1.0,
) -> dict[str, Any]:
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Joint seed must be uint32")
    if (
        isinstance(temperature, bool)
        or not isinstance(temperature, (int, float, np.floating))
        or not np.isfinite(temperature)
        or not 0.1 <= temperature <= 1.5
    ):
        raise ValueError("Joint temperature must be in [0.1,1.5]")
    pair = template_id, "baseline" if profile_id is None else profile_id
    keys = list(map(condition_key, model["conditions"]))
    if pair not in keys:
        raise ValueError("Template/disease pair is not supported by this joint model")
    index = keys.index(pair)
    a = model["arrays"]
    rng = np.random.default_rng(seed)
    z = (
        a["prior_mean.weight"][index]
        + temperature
        * np.exp(np.clip(a["prior_logvar.weight"][index], -8, 4) / 2)
        * rng.normal(size=model["config"]["latent"])
    ).astype(np.float32)[None]
    raw = decode_latents(model, np.asarray([index]), z)[0]
    controls = np.clip(raw, a["control_min"][index], a["control_max"][index])
    result = decode_controls(model["conditions"][index], controls, seed)
    result["model"] = {
        "method": "joint_conditional_vae",
        "model_sha256": model["artifact_sha256"],
        "template_id": template_id,
        "profile_id": profile_id,
        "request_seed": seed,
        "temperature": float(temperature),
        "training_samples": model["training_samples"],
        "scope": SCOPE,
        "bounded_controls_clipped": int(np.count_nonzero(raw != controls)),
        "patient_distribution_learned": False,
        "physics_learned": False,
    }
    return result
