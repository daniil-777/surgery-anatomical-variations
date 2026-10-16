"""Bounded conditional spline-flow contract and NumPy deployment (v2 only).

The flow learns coupled editor controls; the disease-v2 renderer retains source
mesh connectivity. Appearance/disease labels remain authored synthetic examples,
not measured patient optics, prevalence or mechanical parameters.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, cast

import numpy as np

from .atlas import CONTROL_NAMES as SHAPE_NAMES
from .atlas_disease_recipe_dataset import decode_recipe
from .atlas_joint import CONTROL_NAMES as CONTROL_NAMES
from .atlas_joint import OBSERVATION_NAMES as OBSERVATION_NAMES
from .atlas_joint import RENDERER_PATHS as _V1_RENDERER_PATHS
from .atlas_joint import digest as digest
from .atlas_joint import encode_controls as encode_controls
from .atlas_material_dataset import controls_recipe

FORMAT = "viscera-joint-flow-v2"
DATASET_FORMAT = "viscera-joint-dataset-v2"
METHOD = "conditional_spline_flow"
SEVERITY_NAMES = ("baseline", "mild", "moderate", "severe")
SEVERITY_BANDS = {1: (0.10, 0.35), 2: (0.35, 0.70), 3: (0.70, 1.0)}
RENDERER_PATHS = _V1_RENDERER_PATHS + tuple(
    "py/viscera_core/" + name
    for name in ("atlas_disease_v2.py", "atlas_disease_scene_v2.py", "disease_profiles_v2.json")
)
SCOPE = "conditional spline flow of bounded synthetic geometry, authored colour and disease-v2 recipes; not measured patient, optical or mechanical ground truth"
REQUIRED_ARRAYS = (
    "controls",
    "observations",
    "rest_points",
    "region_ids",
    "condition_ids",
    "severity_ids",
    "renderer_seeds",
    "spatial_features",
    "sample_ids",
    "group_ids",
    "seeds",
)


def condition_key(condition: dict[str, Any]) -> tuple[str, str]:
    return condition["template_id"], condition["profile_id"]


def spatial_features(renderer_seeds: Any) -> np.ndarray:
    seeds = np.asarray(renderer_seeds)
    if (
        seeds.ndim < 1
        or seeds.shape[-1] != 2
        or seeds.dtype.kind not in "ui"
        or np.any(seeds < 0)
        or np.any(seeds >= 2**32)
    ):
        raise ValueError("Expected two uint32 material/disease renderer seeds")
    values = (
        (seeds.astype(np.uint64)[..., None] >> np.asarray([0, 8, 16, 24], dtype=np.uint64)) & 255
    ).reshape(*seeds.shape[:-1], 8)
    return (values.astype(np.float32) / np.float32(127.5) - 1).astype(np.float32)


def validate_conditions(conditions: list[dict[str, Any]]) -> None:
    from .atlas_disease_v2 import disease_catalog
    from .atlas_materials import PRESETS, PROFILES

    if not conditions or len({condition_key(c) for c in conditions}) != len(conditions):
        raise ValueError("V2 conditions must be nonempty and unique")
    profiles = {p["id"]: p for p in disease_catalog()["profiles"] if p.get("supported")}
    for c in conditions:
        if (
            c.get("renderer_version") != "disease-v2"
            or not isinstance(c.get("template_id"), str)
            or not c["template_id"]
        ):
            raise ValueError("V2 condition requires an exact template and disease-v2 renderer")
        if c.get("organ") not in PROFILES or c.get("material_preset") not in PRESETS:
            raise ValueError("Invalid V2 organ/material condition")
        if c.get("profile_id") != "baseline":
            p = profiles.get(c.get("profile_id"))
            if p is None or p["organ"] != c["organ"]:
                raise ValueError("Unsupported V2 organ/disease condition")


def decode_controls(
    condition: dict[str, Any], values: Any, seed: int, renderer_seeds: Any | None = None
) -> dict[str, Any]:
    x = np.asarray(values, dtype=np.float64)
    if x.shape != (22,) or not np.isfinite(x).all() or np.any(np.abs(x) > 1 + 1e-6):
        raise ValueError("Expected 22 finite V2 controls in [-1,1]")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("V2 seed must be uint32")
    x = np.clip(x, -1, 1)
    seeds = (
        np.random.default_rng(seed).integers(0, 2**32, 2, dtype=np.uint32)
        if renderer_seeds is None
        else np.asarray(renderer_seeds)
    )
    if seeds.shape != (2,):
        raise ValueError("Expected a pair of renderer seeds")
    spatial_features(seeds)
    material = controls_recipe(
        condition["organ"], condition["material_preset"], int(seeds[0]), x[7:13]
    )
    disease = (
        None
        if condition["profile_id"] == "baseline"
        else decode_recipe(condition["profile_id"], (x[13:] + 1) / 2, int(seeds[1]))
    )
    return {
        "controls": dict(zip(SHAPE_NAMES, map(float, x[:7]), strict=True)),
        "material": material.model_dump(mode="json"),
        "disease": disease,
    }


def validate_split(data: dict[str, np.ndarray], conditions: list[dict[str, Any]]) -> None:
    if not set(REQUIRED_ARRAYS) <= data.keys():
        raise ValueError("V2 dataset is missing required paired arrays")
    x, obs, rest, cid, sid = [
        data[k]
        for k in ("controls", "observations", "rest_points", "condition_ids", "severity_ids")
    ]
    n = len(x)
    if x.shape != (n, 22) or n == 0 or not np.isfinite(x).all() or np.any(np.abs(x) > 1 + 1e-6):
        raise ValueError("V2 controls require finite N x 22 values in [-1,1]")
    if (
        obs.ndim != 3
        or obs.shape[0] != n
        or obs.shape[1] < 8
        or obs.shape[2] != 7
        or not np.isfinite(obs).all()
    ):
        raise ValueError("V2 observations require finite N x P x 7 values")
    if np.any(obs[:, :, 3:] < 0) or np.any(obs[:, :, 3:] > 1):
        raise ValueError("V2 colour/roughness observations exceed [0,1]")
    if rest.shape != (*obs.shape[:2], 3) or not np.isfinite(rest).all():
        raise ValueError("V2 rest query coordinates do not match observations")
    regions = data["region_ids"]
    if (
        regions.shape != obs.shape[:2]
        or regions.dtype.kind not in "iu"
        or np.any(regions < 0)
        or np.any(regions > 255)
    ):
        raise ValueError("V2 material region IDs are invalid")
    for values, limit, label in ((cid, len(conditions), "condition"), (sid, 4, "severity")):
        if (
            values.shape != (n,)
            or values.dtype.kind not in "iu"
            or np.any(values < 0)
            or np.any(values >= limit)
        ):
            raise ValueError("Invalid V2 " + label + " IDs")
    seeds = data["renderer_seeds"]
    phase = spatial_features(seeds)
    if (
        seeds.shape != (n, 2)
        or data["spatial_features"].shape != (n, 8)
        or not np.allclose(phase, data["spatial_features"], atol=1e-7, rtol=0)
    ):
        raise ValueError("V2 spatial seed features are not exact")
    for name in ("sample_ids", "group_ids"):
        values = data[name]
        if values.shape != (n,) or values.dtype.kind not in "US" or not all(values):
            raise ValueError("Invalid V2 " + name)
    if len(np.unique(data["sample_ids"])) != n:
        raise ValueError("Duplicate V2 sample IDs")
    seeds = data["seeds"]
    if (
        seeds.shape != (n,)
        or seeds.dtype.kind not in "iu"
        or np.any(seeds < 0)
        or np.any(seeds >= 2**32)
    ):
        raise ValueError("Invalid V2 parent seeds")
    for i, c in enumerate(conditions):
        mask = cid == i
        if c["profile_id"] == "baseline":
            if np.any(sid[mask] != 0) or np.any(x[mask, 13:] != 0):
                raise ValueError("Baseline V2 rows require severity0 and masked disease controls")
        else:
            if np.any(sid[mask] == 0):
                raise ValueError("Disease V2 rows need explicit design severity")
            counts = (x[mask, 18] + 1) * 3.5
            if not np.allclose(counts, np.rint(counts), atol=1e-5):
                raise ValueError("V2 disease counts must remain integer")
            for band, (lo, hi) in SEVERITY_BANDS.items():
                values = (x[mask & (sid == band), 13] + 1) / 2
                if np.any(values < lo - 1e-6) or np.any(values > hi + 1e-6):
                    raise ValueError("V2 disease strength differs from its requested band")


def verify_release(root: Path) -> dict[str, Any]:
    root = Path(root)
    release = json.loads((root / "release.json").read_text())
    required = {"train.npz", "val.npz", "audit.npz", "catalog.json"}
    if (
        release.get("format") != DATASET_FORMAT
        or not required <= release.get("artifact_hashes", {}).keys()
    ):
        raise ValueError("Invalid V2 dataset release or missing integrity coverage")
    for name, sha in release["artifact_hashes"].items():
        p = root / name
        if (
            Path(name).is_absolute()
            or ".." in Path(name).parts
            or p.is_symlink()
            or not p.resolve().is_relative_to(root.resolve())
            or digest(p) != sha
        ):
            raise ValueError("V2 dataset path/checksum mismatch: " + name)
    return cast(dict[str, Any], release)


def read_split(root: Path, split: str) -> dict[str, np.ndarray]:
    root = Path(root)
    if split not in ("train", "val", "audit"):
        raise ValueError("Unknown V2 data split")
    meta = json.loads((root / "release.json").read_text())
    if meta.get("format") != DATASET_FORMAT or meta["artifact_hashes"][split + ".npz"] != digest(
        root / (split + ".npz")
    ):
        raise ValueError("V2 split checksum mismatch")
    with np.load(root / (split + ".npz"), allow_pickle=False) as f:
        data = {key: f[key] for key in REQUIRED_ARRAYS}
    validate_split(data, json.loads((root / "catalog.json").read_text())["conditions"])
    return data


def to_flow_controls(controls: Any, severity_ids: Any, rng: np.random.Generator) -> np.ndarray:
    """Exact band coordinates and count dequantization; baseline nuisance is uniform."""
    x = np.asarray(controls, dtype=np.float32).copy()
    sid = np.asarray(severity_ids)
    for band, (lo, hi) in SEVERITY_BANDS.items():
        mask = sid == band
        x[mask, 13] = (((x[mask, 13] + 1) / 2 - lo) / (hi - lo)) * 2 - 1
    disease = sid != 0
    k = np.rint((x[disease, 18] + 1) * 3.5)
    x[disease, 18] = (k + rng.random(len(k))) / 4 - 1
    x[~disease, 13:] = rng.uniform(-1, 1, (int((~disease).sum()), 9))
    return np.clip(x, -1 + 1e-6, 1 - 1e-6)


def from_flow_controls(values: Any, severity_ids: Any) -> np.ndarray:
    x = np.clip(np.asarray(values, dtype=np.float64), -1, 1).copy()
    sid = np.asarray(severity_ids)
    for band, (lo, hi) in SEVERITY_BANDS.items():
        mask = sid == band
        x[mask, 13] = 2 * (lo + (x[mask, 13] + 1) / 2 * (hi - lo)) - 1
    disease = sid != 0
    k = np.clip(np.floor((x[disease, 18] + 1) * 4), 0, 7)
    x[disease, 18] = k / 3.5 - 1
    x[~disease, 13:] = 0
    return x.astype(np.float32)


def coupling_masks(layers: int) -> np.ndarray:
    rng = np.random.default_rng(9817301)
    rows: list[np.ndarray] = []
    for _ in range((layers + 1) // 2):
        mask = np.zeros(22, dtype=np.uint8)
        mask[rng.permutation(22)[:11]] = 1
        rows.extend((mask, 1 - mask))
    return np.stack(rows[:layers])


def _silu(x: np.ndarray) -> np.ndarray:
    return cast(np.ndarray, x / (1 + np.exp(-np.clip(x, -60, 60))))


def _linear(x: np.ndarray, a: dict[str, np.ndarray], prefix: str) -> np.ndarray:
    return cast(np.ndarray, x @ a[prefix + ".weight"].T + a[prefix + ".bias"])


def _softmax(x: np.ndarray) -> np.ndarray:
    p = np.exp(x - x.max(-1, keepdims=True))
    return cast(np.ndarray, p / p.sum(-1, keepdims=True))


def rational_quadratic_spline(
    values: Any, parameters: Any, bins: int, inverse: bool = False
) -> tuple[np.ndarray, np.ndarray]:
    """Monotone bounded RQ splines; formulas from Durkan et al. (NeurIPS 2019)."""
    x, p = np.asarray(values, dtype=np.float64), np.asarray(parameters, dtype=np.float64)
    if (
        p.shape != (*x.shape, 3 * bins - 1)
        or not np.isfinite(x).all()
        or not np.isfinite(p).all()
        or np.any(np.abs(x) > 1 + 1e-5)
    ):
        raise ValueError("Invalid bounded spline inputs")
    widths = 2 * (1e-3 + (1 - bins * 1e-3) * _softmax(p[..., :bins]))
    heights = 2 * (1e-3 + (1 - bins * 1e-3) * _softmax(p[..., bins : 2 * bins]))
    interior = np.logaddexp(0, p[..., 2 * bins :] + math.log(math.expm1(1 - 1e-3))) + 1e-3
    derivatives = np.concatenate((np.ones((*x.shape, 1)), interior, np.ones((*x.shape, 1))), -1)
    knots_x = np.concatenate((np.full((*x.shape, 1), -1.0), -1 + np.cumsum(widths, -1)), -1)
    knots_y = np.concatenate((np.full((*x.shape, 1), -1.0), -1 + np.cumsum(heights, -1)), -1)
    knots_x[..., -1] = knots_y[..., -1] = 1
    source = knots_y if inverse else knots_x
    index = np.clip(np.sum(np.clip(x, -1, 1)[..., None] >= source[..., 1:], -1), 0, bins - 1)[
        ..., None
    ]

    def take(a: np.ndarray, offset: int = 0) -> np.ndarray:
        return np.take_along_axis(a, index + offset, -1)[..., 0]

    w, h, x0, y0, d0, d1 = (
        take(widths),
        take(heights),
        take(knots_x),
        take(knots_y),
        take(derivatives),
        take(derivatives, 1),
    )
    delta = h / w
    if inverse:
        dy = np.clip(x, -1, 1) - y0
        a = dy * (d0 + d1 - 2 * delta) + h * (delta - d0)
        b = h * d0 - dy * (d0 + d1 - 2 * delta)
        c = -delta * dy
        denominator = -b - np.sqrt(np.maximum(b * b - 4 * a * c, 0))
        theta = np.divide(
            2 * c, denominator, out=np.zeros_like(c), where=np.abs(denominator) > 1e-20
        )
    else:
        theta = (np.clip(x, -1, 1) - x0) / w
    theta = np.clip(theta, 0, 1)
    blend = theta * (1 - theta)
    denominator = delta + (d0 + d1 - 2 * delta) * blend
    output = (
        x0 + theta * w if inverse else y0 + h * (delta * theta * theta + d0 * blend) / denominator
    )
    derivative = (
        delta
        * delta
        * (d1 * theta * theta + 2 * delta * blend + d0 * (1 - theta) ** 2)
        / (denominator * denominator)
    )
    logdet = np.log(np.maximum(derivative, 1e-30)) * (-1 if inverse else 1)
    return np.clip(output, -1, 1).astype(np.float32), logdet.astype(np.float32)


def context_indices(model: dict[str, Any], condition_ids: Any) -> tuple[np.ndarray, ...]:
    ids = np.asarray(condition_ids, dtype=np.int64)
    c = model["conditions"]
    return tuple(
        np.asarray([model[name].index(c[int(i)][field]) for i in ids])
        for name, field in (
            ("templates", "template_id"),
            ("profiles", "profile_id"),
            ("organs", "organ"),
        )
    )


def context_features(
    model: dict[str, Any], condition_ids: Any, severity_ids: Any, phase: Any
) -> np.ndarray:
    a = model["arrays"]
    tid, pid, oid = context_indices(model, condition_ids)
    x = np.concatenate(
        (
            a["template_embedding.weight"][tid] * model["config"]["context_gain"],
            a["profile_embedding.weight"][pid] * model["config"]["context_gain"],
            a["organ_embedding.weight"][oid] * model["config"]["context_gain"],
            a["type_embedding.weight"][(np.asarray(severity_ids) > 0).astype(np.int64)],
        ),
        1,
    )
    return _linear(_silu(_linear(x, a, "context.0")), a, "context.2")


def flow_transform(
    model: dict[str, Any],
    values: Any,
    condition_ids: Any,
    severity_ids: Any,
    phase: Any,
    inverse: bool = False,
) -> tuple[np.ndarray, np.ndarray]:
    a, cfg = model["arrays"], model["config"]
    x = np.asarray(values, dtype=np.float32).copy()
    context = context_features(model, condition_ids, severity_ids, phase)
    total = np.zeros(len(x), dtype=np.float32)
    layers = reversed(range(cfg["layers"])) if inverse else range(cfg["layers"])
    for layer in layers:
        mask = a["masks"][layer].astype(bool)
        prefix = f"couplings.{layer}"
        h = _silu(_linear(np.concatenate((x[:, mask], context), 1), a, prefix + ".input"))
        scale, shift = np.split(_linear(context, a, prefix + ".film"), 2, axis=1)
        h = h * (1 + 0.1 * np.tanh(scale)) + shift
        for block in range(cfg["blocks"]):
            h = h + _linear(
                _silu(_linear(_silu(h), a, prefix + f".blocks.{block}.0")),
                a,
                prefix + f".blocks.{block}.2",
            )
        params = _linear(_silu(h), a, prefix + ".output").reshape(len(x), 11, 3 * cfg["bins"] - 1)
        x[:, ~mask], ld = rational_quadratic_spline(x[:, ~mask], params, cfg["bins"], inverse)
        total += ld.sum(1)
    return x, total


def parameter_shapes(meta: dict[str, Any]) -> dict[str, tuple[int, ...]]:
    c = meta["config"]
    e, h, bins, cd = c["embedding"], c["hidden"], c["bins"], 2 * c["embedding"]
    small = max(8, e // 2)
    result = {
        "masks": (c["layers"], 22),
        "template_embedding.weight": (len(meta["templates"]), e),
        "profile_embedding.weight": (len(meta["profiles"]), e),
        "organ_embedding.weight": (len(meta["organs"]), small),
        "type_embedding.weight": (2, small),
        "context.0.weight": (cd, 2 * e + 2 * small),
        "context.0.bias": (cd,),
        "context.2.weight": (cd, cd),
        "context.2.bias": (cd,),
    }
    for layer in range(c["layers"]):
        p = f"couplings.{layer}"
        for name, out_size, in_size in (
            ("input", h, 11 + cd),
            ("film", 2 * h, cd),
            ("output", 11 * (3 * bins - 1), h),
        ):
            result[p + "." + name + ".weight"] = (out_size, in_size)
            result[p + "." + name + ".bias"] = (out_size,)
        for block in range(c["blocks"]):
            for index in (0, 2):
                result[p + f".blocks.{block}.{index}.weight"] = (h, h)
                result[p + f".blocks.{block}.{index}.bias"] = (h,)
    return result


def load_model(path: Path) -> dict[str, Any]:
    path = Path(path)
    manifest = json.loads(path.with_suffix(".json").read_text())
    sha = digest(path)
    if manifest.get("format") != FORMAT or manifest.get("artifact_sha256") != sha:
        raise ValueError("V2 model format/checksum mismatch")
    with np.load(path, allow_pickle=False) as f:
        meta = json.loads(str(f["metadata_json"].item()))
        arrays = {k: f[k] for k in f.files if k != "metadata_json"}
    if meta != {k: v for k, v in manifest.items() if k != "artifact_sha256"}:
        raise ValueError("V2 manifest differs from payload")
    if (
        meta.get("selected_method") != METHOD
        or meta.get("feature_names") != list(CONTROL_NAMES)
        or meta.get("observation_names") != list(OBSERVATION_NAMES)
    ):
        raise ValueError("Unsupported V2 model/feature schema")
    if meta.get("severity_names") != list(SEVERITY_NAMES) or meta.get("severity_bands") != {
        str(k): list(v) for k, v in SEVERITY_BANDS.items()
    }:
        raise ValueError("Unsupported V2 severity design bands")
    validate_conditions(meta["conditions"])
    for name, field in (
        ("templates", "template_id"),
        ("profiles", "profile_id"),
        ("organs", "organ"),
    ):
        if meta.get(name) != sorted({c[field] for c in meta["conditions"]}):
            raise ValueError("Invalid V2 factorized context vocabulary")
    c = meta["config"]
    for name, lo, hi in (
        ("hidden", 16, 1024),
        ("embedding", 4, 128),
        ("layers", 2, 24),
        ("bins", 4, 32),
        ("blocks", 1, 4),
    ):
        if type(c.get(name)) is not int or not lo <= c[name] <= hi:
            raise ValueError("Invalid V2 flow architecture")
    if (
        type(c.get("context_gain")) not in (int, float)
        or not np.isfinite(c["context_gain"])
        or not 0 <= c["context_gain"] <= 1
    ):
        raise ValueError("Invalid V2 density context gain")
    expected = parameter_shapes(meta)
    if set(arrays) != set(expected):
        raise ValueError("Unexpected V2 deployment tensors")
    for name, shape in expected.items():
        if arrays[name].shape != shape or not np.isfinite(arrays[name]).all():
            raise ValueError("Invalid V2 deployment parameter: " + name)
        if name != "masks" and arrays[name].dtype.kind != "f":
            raise ValueError("Nonfloating V2 model parameter")
    if not np.array_equal(arrays["masks"], coupling_masks(c["layers"])):
        raise ValueError("V2 coupling masks differ from architecture")
    if (
        meta.get("training_profile") not in ("full", "smoke")
        or type(meta.get("completed_steps")) is not int
        or meta["completed_steps"] < 1
    ):
        raise ValueError("Invalid V2 training provenance")
    return {**meta, "arrays": arrays, "artifact_sha256": sha}


def sample_joint(
    model: dict[str, Any],
    template_id: str,
    profile_id: str | None,
    seed: int,
    temperature: float = 1.0,
    severity: str = "auto",
    renderer_seeds: Any | None = None,
) -> dict[str, Any]:
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("V2 sample seed must be uint32")
    if (
        isinstance(temperature, bool)
        or not isinstance(temperature, (float, int, np.floating))
        or not np.isfinite(temperature)
        or not 0.1 <= temperature <= 1.5
    ):
        raise ValueError("V2 temperature must be in [0.1,1.5]")
    pair = (template_id, "baseline" if profile_id is None else profile_id)
    keys = list(map(condition_key, model["conditions"]))
    if pair not in keys:
        raise ValueError("Template/disease pair is absent from V2 training")
    index = keys.index(pair)
    rng = np.random.default_rng(seed)
    generated_seeds = rng.integers(0, 2**32, 2, dtype=np.uint32)
    phases = generated_seeds if renderer_seeds is None else np.asarray(renderer_seeds)
    phase = spatial_features(phases)
    if phases.shape != (2,):
        raise ValueError("V2 renderer_seeds must contain two values")
    if severity not in ("auto", *SEVERITY_NAMES):
        raise ValueError("Unknown V2 design severity")
    if pair[1] == "baseline":
        if severity not in ("auto", "baseline"):
            raise ValueError("Healthy baseline does not have a disease severity band")
        sid = 0
    else:
        if severity == "baseline":
            raise ValueError("Disease requires mild, moderate or severe design strength")
        sid = int(rng.integers(1, 4)) if severity == "auto" else SEVERITY_NAMES.index(severity)
    z = rng.uniform(-1 + 1e-6, 1 - 1e-6, (1, 22)).astype(np.float32)
    z = np.tanh(np.arctanh(z) * temperature)
    values, _ = flow_transform(
        model, z, np.asarray([index]), np.asarray([sid]), phase[None], inverse=True
    )
    controls = from_flow_controls(values, np.asarray([sid]))[0]
    output = decode_controls(model["conditions"][index], controls, seed, phases)
    output["renderer_version"] = "disease-v2"
    output["model"] = {
        "method": METHOD,
        "model_sha256": model["artifact_sha256"],
        "template_id": template_id,
        "profile_id": profile_id,
        "request_seed": seed,
        "temperature": float(temperature),
        "severity": SEVERITY_NAMES[sid],
        "renderer_seeds": list(map(int, phases)),
        "scope": SCOPE,
        "training_samples": model["training_samples"],
        "disease_severity_is_clinical_stage": False,
        "patient_distribution_learned": False,
        "physics_learned": False,
    }
    return output
