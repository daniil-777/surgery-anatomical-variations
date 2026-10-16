"""Atlas-conditioned control learning. Geometry stays in immutable source templates.

Separate from frozen legacy shape.py. Synthetic seed holdouts establish only
within-generator interpolation, never patient generalization or tissue physics.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, cast

import numpy as np
import torch
from numpy.typing import NDArray
from torch import nn

Array = NDArray[Any]
Data = dict[str, Array]
Artifact = dict[str, Any]
ConditionDecoder = Callable[[str, Array], tuple[Array, Array]]
CONTROL_NAMES = ["scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry"]
FORMAT = "viscera-atlas-control-model-v1"
METHODS = ("template_mean", "nearest", "ridge", "mlp")


@dataclass(frozen=True)
class TrainConfig:
    """Fixed-run configuration; any change invalidates exact resume."""

    steps: int = 1200
    batch_size: int = 128
    hidden: int = 128
    lr: float = 0.001
    weight_decay: float = 0.0001
    ridge_alpha: float = 0.1
    seed: int = 6143
    condition_dropout: float = 0.25
    unconditional_dropout: float = 0.15
    checkpoint_every: int = 100
    device: str = "cpu"
    threads: int = 1
    neural_improvement: float = 0.02


DEFAULT_CONFIG = TrainConfig()


def digest(path: Path) -> str:
    """Return SHA-256 without loading the complete file."""
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def atomic_torch(path: Path, value: Artifact) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("wb") as stream:
        torch.save(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    atomic_json(
        path.with_suffix(path.suffix + ".sha256.json"), {"sha256": digest(path)}
    )


def safe_load(path: Path) -> Artifact:
    """Load tensor/primitive-only artifacts after integrity verification."""
    checksum = path.with_suffix(path.suffix + ".sha256.json")
    if not checksum.exists() or json.loads(checksum.read_text()).get(
        "sha256"
    ) != digest(path):
        raise ValueError("Checkpoint checksum missing or incorrect")
    value = torch.load(path, weights_only=True, map_location="cpu")
    if not isinstance(value, dict) or value.get("format") != FORMAT:
        raise ValueError("Unsupported atlas checkpoint format")
    return cast(Artifact, value)


def _names(value: Array, key: str, unique: bool = True) -> None:
    if (
        value.ndim != 1
        or value.dtype.kind not in "US"
        or not all(str(x) for x in value)
    ):
        raise ValueError(f"{key} must be one-dimensional nonempty strings")
    if unique and len(set(value.tolist())) != len(value):
        raise ValueError(f"{key} must be unique")


def validate_data(data: Data) -> None:
    """Validate split arrays without coercing missing or invalid labels."""
    required = (
        "controls",
        "control_names",
        "conditions",
        "condition_names",
        "condition_mask",
        "organ_ids",
        "organ_names",
        "template_ids",
        "sample_ids",
        "group_ids",
    )
    if any(key not in data for key in required):
        raise ValueError("Atlas split missing required arrays")
    x, c, mask = data["controls"], data["conditions"], data["condition_mask"]
    if x.ndim != 2 or x.shape[1] != 7 or len(x) < 1:
        raise ValueError("Atlas controls require nonempty N x 7 matrix")
    if not np.isfinite(x).all() or np.any(np.abs(x) > 1):
        raise ValueError("Atlas controls must be finite and bounded by [-1,1]")
    if (
        c.ndim != 2
        or len(c) != len(x)
        or mask.shape != c.shape
        or mask.dtype != np.bool_
    ):
        raise ValueError(
            "Conditions and boolean condition_mask must align with controls"
        )
    if not np.isfinite(c[mask]).all():
        raise ValueError(
            "Observed conditions must be finite; only masked targets may be NaN"
        )
    for key in ("control_names", "condition_names", "organ_names"):
        _names(data[key], key)
    if data["control_names"].tolist() != CONTROL_NAMES:
        raise ValueError("Atlas control schema mismatch")
    if len(data["condition_names"]) != c.shape[1]:
        raise ValueError("Condition schema dimension mismatch")
    for key in ("template_ids", "sample_ids", "group_ids"):
        _names(data[key], key, unique=key == "sample_ids")
        if len(data[key]) != len(x):
            raise ValueError(f"{key} must align with rows")
    ids = data["organ_ids"]
    if ids.shape != (len(x),) or ids.dtype.kind not in "iu":
        raise ValueError("organ_ids require one integer per row")
    if np.any(ids < 0) or np.any(ids >= len(data["organ_names"])):
        raise ValueError("organ_ids outside organ_names vocabulary")
    for template in np.unique(data["template_ids"]):
        if len(np.unique(ids[data["template_ids"] == template])) != 1:
            raise ValueError("One template cannot belong to different organs")


def read_split(root: Path, split: str) -> Data:
    """Verify hash and schema; callers control whether audit is opened."""
    if split not in ("train", "val", "audit"):
        raise ValueError("Unknown atlas split")
    path = root / f"{split}.npz"
    release = json.loads((root / "release.json").read_text())
    if release.get("artifact_hashes", {}).get(path.name) != digest(path):
        raise ValueError(f"Missing or incorrect release hash: {path.name}")
    with np.load(path, allow_pickle=False) as archive:
        data = {key: archive[key].copy() for key in archive.files}
    validate_data(data)
    return data


def audit_splits(train: Data, other: Data) -> None:
    """Reject derivative leakage; reference-lineage sharing is explicit."""
    for key in ("control_names", "condition_names", "organ_names"):
        if not np.array_equal(train[key], other[key]):
            raise ValueError(f"Split schema mismatch: {key}")
    for key in ("sample_ids", "group_ids"):
        if set(train[key]) & set(other[key]):
            raise ValueError(f"Derivative group leakage: {key}")
    for template in np.unique(other["template_ids"]):
        a = train["organ_ids"][train["template_ids"] == template]
        b = other["organ_ids"][other["template_ids"] == template]
        if not len(a) or not np.all(a == b[0]):
            raise ValueError(f"Unknown or reassigned template: {template}")


def fit_preprocessing(train: Data) -> Artifact:
    """Fit per-template statistics from observed training values only."""
    templates = sorted(set(train["template_ids"].tolist()))
    means, scales, observed, organ_ids = [], [], [], []
    for template in templates:
        ix = train["template_ids"] == template
        c, m = train["conditions"][ix], train["condition_mask"][ix]
        if ix.sum() < 3:
            raise ValueError(
                f"At least three training samples per template: {template}"
            )
        mean, scale, availability = [], [], []
        for j in range(c.shape[1]):
            values = c[m[:, j], j]
            mean.append(float(values.mean()) if len(values) else 0.0)
            scale.append(
                max(float(values.std()), abs(mean[-1]) * 1e-6, 1e-8)
                if len(values)
                else 1.0
            )
            availability.append(bool(len(values)))
        means.append(mean)
        scales.append(scale)
        observed.append(availability)
        organ_ids.append(int(train["organ_ids"][ix][0]))
    return {
        "templates": templates,
        "organ_ids": organ_ids,
        "condition_mean": means,
        "condition_scale": scales,
        "condition_available": observed,
    }


def encode_conditions(
    p: Artifact, templates: Array, conditions: Array, mask: Array
) -> tuple[Array, Array, Array]:
    lookup = {name: i for i, name in enumerate(p["templates"])}
    try:
        ids = np.asarray([lookup[str(t)] for t in templates], dtype=np.int64)
    except KeyError as exc:
        raise ValueError(f"Unsupported template: {exc.args[0]}") from exc
    mean, scale = (
        np.asarray(p["condition_mean"])[ids],
        np.asarray(p["condition_scale"])[ids],
    )
    if (
        conditions.shape != mean.shape
        or mask.shape != mean.shape
        or mask.dtype != np.bool_
    ):
        raise ValueError("Condition shape or mask type mismatch")
    if not np.isfinite(conditions[mask]).all():
        raise ValueError("Observed conditions must be finite")
    available = np.asarray(p["condition_available"])[ids]
    if np.any(mask & ~available):
        raise ValueError(
            "Requested condition has no observed training targets for this template"
        )
    z = (np.where(mask, conditions, mean) - mean) / scale
    return ids, z.astype(np.float32), mask.astype(np.float32)


class ConditionalRegressor(nn.Module):
    """Template-conditioned bounded mean and positive proposal variance."""

    def __init__(self, templates: int, conditions: int, hidden: int):
        super().__init__()
        self.embedding = nn.Embedding(templates, 16)
        self.net = nn.Sequential(
            nn.Linear(2 * conditions + 16, hidden),
            nn.SiLU(),
            nn.Linear(hidden, hidden),
            nn.SiLU(),
            nn.Linear(hidden, 14),
        )

    def forward(
        self, ids: torch.Tensor, z: torch.Tensor, mask: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        out = self.net(torch.cat((self.embedding(ids), z * mask, mask), 1))
        return out[:, :7].tanh(), out[:, 7:].clamp(-4.0, 0.2)


def balanced_indices(data: Data, rng: np.random.Generator, size: int) -> Array:
    """Sample organs uniformly, then templates uniformly within each organ."""
    organs = np.unique(data["organ_ids"])
    rows: list[int] = []
    for _ in range(size):
        organ = rng.choice(organs)
        templates = np.unique(data["template_ids"][data["organ_ids"] == organ])
        template = rng.choice(templates)
        rows.append(int(rng.choice(np.flatnonzero(data["template_ids"] == template))))
    return np.asarray(rows, dtype=np.int64)


def _train_data(artifact: Artifact) -> Data:
    return {
        key: value.numpy() if isinstance(value, torch.Tensor) else np.asarray(value)
        for key, value in artifact["training_rows"].items()
    }


def _model(artifact: Artifact) -> ConditionalRegressor:
    model = ConditionalRegressor(
        len(artifact["preprocessing"]["templates"]),
        len(artifact["condition_names"]),
        artifact["config"]["hidden"],
    )
    model.load_state_dict(artifact["model_state"])
    model.eval()
    return model


def _ridge(
    x: Array, z: Array, mask: Array, query_z: Array, query_mask: Array, alpha: float
) -> tuple[Array, Array]:
    # Every requested feature must be observed; missing rows never become targets.
    used = np.asarray(query_mask, dtype=bool)
    complete = np.all(mask[:, used].astype(bool), axis=1)
    if complete.sum() < 3:
        raise ValueError(
            "Fewer than three training rows jointly observe requested conditions"
        )
    x, z = x[complete], z[complete]
    f = np.column_stack((np.ones(len(x)), z[:, used]))
    q = np.r_[1.0, query_z[used]]
    penalty = np.eye(f.shape[1]) * alpha
    penalty[0, 0] = 0
    normal = f.T @ f + penalty
    weights = np.linalg.solve(normal, f.T @ x)
    prediction = np.clip(q @ weights, -1.0, 1.0)
    # Leave-one-out residuals reduce optimism in sampled conditional variation.
    hat = np.einsum("ij,ji->i", f, np.linalg.solve(normal, f.T))
    residual = (x - f @ weights) / np.maximum(1 - hat[:, None], 0.05)
    return prediction, residual


def predict_controls(
    artifact: Artifact,
    templates: Array,
    conditions: Array,
    mask: Array,
    method: str | None = None,
) -> Array:
    """Predict controls for each exact template; templates are never interpolated."""
    method = method or artifact["selected_method"]
    if method not in METHODS:
        raise ValueError("Unknown atlas sampling method")
    p = artifact["preprocessing"]
    ids, z, m = encode_conditions(p, templates, conditions, mask)
    if method == "mlp":
        with torch.inference_mode():
            mean, _ = _model(artifact)(
                torch.as_tensor(ids), torch.as_tensor(z), torch.as_tensor(m)
            )
        return np.asarray(mean.numpy(), dtype=np.float64)
    data = _train_data(artifact)
    _, tz, tm = encode_conditions(
        p, data["template_ids"], data["conditions"], data["condition_mask"]
    )
    result = np.empty((len(ids), 7), dtype=np.float64)
    for i, template in enumerate(templates):
        ix = data["template_ids"] == template
        x, cz, cm = data["controls"][ix], tz[ix], tm[ix]
        if method == "template_mean" or not m[i].any():
            result[i] = x.mean(0)
        elif method == "nearest":
            overlap = cm * m[i]
            distance = ((cz - z[i]) ** 2 * overlap).sum(1) / np.maximum(
                overlap.sum(1), 1
            )
            distance[overlap.sum(1) < m[i].sum()] = np.inf
            if not np.isfinite(distance).any():
                raise ValueError("No training example observes requested conditions")
            result[i] = x[int(distance.argmin())]
        else:
            result[i], _ = _ridge(
                x, cz, cm, z[i], m[i], artifact["config"]["ridge_alpha"]
            )
    return result


def sample_controls(
    artifact: Artifact,
    template_id: str,
    conditions: Mapping[str, float] | None = None,
    count: int = 16,
    seed: int = 0,
    method: str | None = None,
) -> Array:
    """Return bounded design proposals; decoder geometric gates remain required.

    Unconditional sampling bootstraps the actual template's control prior. This
    conserves synthetic design variation without inventing population frequency.
    """
    if count < 1 or count > 100000:
        raise ValueError("count must be between 1 and 100000")
    conditions = conditions or {}
    names = artifact["condition_names"]
    if set(conditions) - set(names):
        raise ValueError("Unknown condition name")
    c = np.asarray([[conditions.get(name, np.nan) for name in names]], dtype=np.float64)
    mask = np.asarray([[name in conditions for name in names]], dtype=bool)
    ids, z, m = encode_conditions(
        artifact["preprocessing"], np.asarray([template_id]), c, mask
    )
    rng = np.random.default_rng(seed)
    data = _train_data(artifact)
    ix = data["template_ids"] == template_id
    x = data["controls"][ix]
    if not conditions:
        return np.asarray(x[rng.integers(len(x), size=count)]).copy()
    for name, value in conditions.items():
        j = names.index(name)
        supported = data["conditions"][ix, j][data["condition_mask"][ix, j]]
        tolerance = max(float(np.ptp(supported)) * 1e-5, 1e-8)
        if not supported.min() - tolerance <= value <= supported.max() + tolerance:
            raise ValueError(
                f"Requested {name} exceeds training support for {template_id}"
            )
    method = method or artifact["selected_method"]
    mean = predict_controls(artifact, np.asarray([template_id]), c, mask, method)[0]
    _, tz, tm = encode_conditions(
        artifact["preprocessing"],
        data["template_ids"][ix],
        data["conditions"][ix],
        data["condition_mask"][ix],
    )
    if method == "nearest":
        overlap = tm * m
        distance = ((tz - z) ** 2 * overlap).sum(1) / np.maximum(overlap.sum(1), 1)
        distance[overlap.sum(1) < m.sum()] = np.inf
        valid = np.flatnonzero(np.isfinite(distance))
        neighbors = valid[np.argsort(distance[valid])[: min(8, len(valid))]]
        if not len(neighbors):
            raise ValueError("No supported neighbors")
        weights = 1 / np.maximum(distance[neighbors], 1e-4)
        return np.asarray(
            x[rng.choice(neighbors, count, p=weights / weights.sum())]
        ).copy()
    if method == "mlp":
        with torch.inference_mode():
            _, logstd = _model(artifact)(
                torch.as_tensor(ids), torch.as_tensor(z), torch.as_tensor(m)
            )
        std = np.exp(logstd.numpy()[0])

        def proposal() -> Array:
            return cast(Array, mean + rng.normal(size=7) * std)
    else:
        residual = (
            _ridge(x, tz, tm, z[0], m[0], artifact["config"]["ridge_alpha"])[1]
            if method == "ridge"
            else x - x.mean(0)
        )
        residual -= residual.mean(0)

        def proposal() -> Array:
            return cast(Array, mean + residual[int(rng.integers(len(residual)))])

    samples: list[Array] = []
    for _ in range(count * 256):
        proposal_value = proposal()
        if np.isfinite(proposal_value).all() and np.all(np.abs(proposal_value) <= 1):
            samples.append(proposal_value)
            if len(samples) == count:
                return np.asarray(samples)
    raise ValueError(
        "Bounded proposal rejection exhausted; relax constraints or use nearest"
    )


def refine_controls(
    artifact: Artifact,
    template_id: str,
    initial_controls: Array,
    conditions: Mapping[str, float],
    decoder: ConditionDecoder,
    *,
    relative_tolerance: float = 0.01,
    prior_weight: float = 0.01,
    max_nfev: int = 80,
) -> Artifact:
    """Match feasible physical targets using the real decoder and bounded controls.

    This numerical refinement does not establish medical plausibility. It returns
    explicit residuals when a target is infeasible, never silently declares success.
    The decoder must preserve the exact template and return measured conditions.
    """
    from scipy.optimize import least_squares

    initial = np.asarray(initial_controls, dtype=np.float64)
    if (
        initial.shape != (7,)
        or not np.isfinite(initial).all()
        or np.any(np.abs(initial) > 1)
    ):
        raise ValueError("Refinement requires seven finite bounded initial controls")
    if not conditions or set(conditions) - set(artifact["condition_names"]):
        raise ValueError("Refinement requires known target condition names")
    if not np.isfinite(relative_tolerance) or not 0 < relative_tolerance < 1:
        raise ValueError("relative_tolerance must be in (0,1)")
    if not np.isfinite(prior_weight) or prior_weight < 0 or max_nfev < 1:
        raise ValueError("Invalid refinement configuration")
    names = artifact["condition_names"]
    target = np.asarray(
        [conditions.get(name, np.nan) for name in names], dtype=np.float64
    )
    mask = np.asarray([name in conditions for name in names], dtype=bool)
    ids, _, _ = encode_conditions(
        artifact["preprocessing"],
        np.asarray([template_id]),
        target[None, :],
        mask[None, :],
    )
    feature_scale = np.asarray(artifact["preprocessing"]["condition_scale"])[ids[0]]
    unit_tolerance = np.maximum(
        np.abs(target[mask]) * relative_tolerance,
        feature_scale[mask] * relative_tolerance,
    )
    calls = 0

    def measure(controls: Array) -> Array:
        nonlocal calls
        values, observed = decoder(template_id, controls)
        calls += 1
        values, observed = np.asarray(values), np.asarray(observed)
        if values.shape != target.shape or observed.shape != target.shape:
            raise ValueError("Refinement decoder measurement shape mismatch")
        if not np.all(observed[mask]) or not np.isfinite(values[mask]).all():
            raise ValueError(
                "Refinement decoder does not observe requested measurements"
            )
        return values

    def residual(controls: Array) -> Array:
        measured = measure(controls)
        return np.concatenate(
            (
                (measured[mask] - target[mask]) / feature_scale[mask],
                prior_weight * (controls - initial),
            )
        )

    before = measure(initial)
    result = least_squares(
        residual,
        initial,
        bounds=(-1.0, 1.0),
        max_nfev=max_nfev,
        ftol=1e-9,
        xtol=1e-9,
        gtol=1e-9,
    )
    best_controls = np.asarray(result.x, dtype=np.float64)
    measured = measure(best_controls)
    before_error = np.linalg.norm((before[mask] - target[mask]) / feature_scale[mask])
    after_error = np.linalg.norm((measured[mask] - target[mask]) / feature_scale[mask])
    if after_error > before_error:
        best_controls, measured = initial.copy(), before
    matches = np.abs(measured[mask] - target[mask]) <= unit_tolerance
    achieved = {
        str(name): {
            "target": float(target[j]),
            "measured": float(measured[j]),
            "absolute_error": float(abs(measured[j] - target[j])),
            "before_absolute_error": float(abs(before[j] - target[j])),
            "tolerance_original_units": float(unit_tolerance[k]),
        }
        for k, (j, name) in enumerate(
            (j, name) for j, name in enumerate(names) if mask[j]
        )
    }
    return {
        "status": "matched" if np.all(matches) else "unmet_constraints",
        "template_id": template_id,
        "controls": best_controls.tolist(),
        "measurements": achieved,
        "decoder_calls": calls,
        "optimizer_converged": bool(result.success),
        "optimizer_message": str(result.message),
        "relative_tolerance": relative_tolerance,
        "requires_geometry_validation": True,
    }


def evaluate_arrays(
    artifact: Artifact,
    data: Data,
    method: str | None = None,
    decoder: ConditionDecoder | None = None,
    sampling: bool = True,
) -> Artifact:
    """Report controls and optional actual decoded geometry, never a learned proxy."""
    for key in ("condition_names", "organ_names", "control_names"):
        if data[key].tolist() != artifact[key]:
            raise ValueError(f"Evaluation schema mismatch: {key}")
    prediction = predict_controls(
        artifact,
        data["template_ids"],
        data["conditions"],
        data["condition_mask"],
        method,
    )
    squared = ((prediction - data["controls"]) / 2) ** 2
    per_template = {
        str(t): float(np.sqrt(squared[data["template_ids"] == t].mean()))
        for t in np.unique(data["template_ids"])
    }
    per_organ = {
        str(name): float(np.sqrt(squared[data["organ_ids"] == i].mean()))
        for i, name in enumerate(data["organ_names"])
        if np.any(data["organ_ids"] == i)
    }
    diversity = {}
    conditional_diversity = {}
    for template in sorted(per_template) if sampling else []:
        samples = sample_controls(artifact, template, count=128, seed=871)
        diversity[template] = {
            "mean_control_std": float(samples.std(0).mean()),
            "unique_fraction": len(np.unique(samples, axis=0)) / len(samples),
        }
        row = int(np.flatnonzero(data["template_ids"] == template)[0])
        requested = {
            str(name): float(data["conditions"][row, j])
            for j, name in enumerate(data["condition_names"])
            if data["condition_mask"][row, j]
        }
        try:
            proposals = sample_controls(
                artifact, template, requested, count=32, seed=913, method=method
            )
            conditional_diversity[template] = {
                "status": "MEASURED",
                "mean_control_std": float(proposals.std(0).mean()),
                "secondary_controls_mean_std": float(proposals[:, 3:].std(0).mean()),
                "unique_fraction": len(np.unique(proposals, axis=0)) / len(proposals),
            }
        except ValueError as exc:
            conditional_diversity[template] = {
                "status": "UNSUPPORTED",
                "reason": str(exc),
            }
    report: Artifact = {
        "rows": len(prediction),
        "method": method or artifact["selected_method"],
        "macro_template_control_nrmse": float(np.mean(list(per_template.values()))),
        "per_template_control_nrmse": per_template,
        "per_organ_control_nrmse": per_organ,
        "per_control_nrmse": dict(
            zip(CONTROL_NAMES, np.sqrt(squared.mean(0)).tolist(), strict=True)
        ),
        "unconditional_empirical_diversity": diversity,
        "conditional_proposal_diversity": conditional_diversity,
        "control_bound_violation_count": int(np.count_nonzero(np.abs(prediction) > 1)),
        "decoded_geometry": {
            "status": "NOT_RUN",
            "reason": "Pass a real atlas measurement decoder",
        },
        "scope": "Within-generator held-out seeds; not unseen-person anatomical validation",
    }
    if decoder is not None:
        decoded, masks = [], []
        for template, controls in zip(data["template_ids"], prediction, strict=True):
            value, observed = decoder(str(template), controls)
            decoded.append(value)
            masks.append(observed)
        measured = np.asarray(decoded, dtype=np.float64)
        decoded_mask = np.asarray(masks, dtype=bool)
        if (
            measured.shape != data["conditions"].shape
            or decoded_mask.shape != measured.shape
        ):
            raise ValueError("Invalid decoded geometry shape")
        valid = decoded_mask & data["condition_mask"]
        if not np.isfinite(measured[valid]).all():
            raise ValueError("Invalid decoded geometry measurement")
        lookup = {
            name: i for i, name in enumerate(artifact["preprocessing"]["templates"])
        }
        ids = np.asarray([lookup[t] for t in data["template_ids"]])
        scales = np.asarray(artifact["preprocessing"]["condition_scale"])[ids]
        errors = np.where(valid, measured - data["conditions"], 0)
        metrics = {}
        for j, name in enumerate(artifact["condition_names"]):
            v = valid[:, j]
            metrics[name] = {
                "observed_rows": int(v.sum()),
                "mae_original_units": float(np.abs(errors[v, j]).mean())
                if v.any()
                else None,
                "nrmse_training_std": float(
                    np.sqrt(((errors[v, j] / scales[v, j]) ** 2).mean())
                )
                if v.any()
                else None,
            }
        report["decoded_geometry"] = {"status": "MEASURED", "conditions": metrics}
    return report


def _config_valid(cfg: TrainConfig) -> None:
    if (
        min(cfg.steps, cfg.batch_size, cfg.hidden, cfg.checkpoint_every, cfg.threads)
        < 1
    ):
        raise ValueError("Training counts must be positive")
    for key in ("lr", "ridge_alpha"):
        if not np.isfinite(getattr(cfg, key)) or getattr(cfg, key) <= 0:
            raise ValueError(f"Invalid {key}")
    for key in ("condition_dropout", "unconditional_dropout", "neural_improvement"):
        if not np.isfinite(getattr(cfg, key)) or not 0 <= getattr(cfg, key) < 1:
            raise ValueError(f"Invalid {key}")
    if not np.isfinite(cfg.weight_decay) or cfg.weight_decay < 0:
        raise ValueError("Invalid weight_decay")


def _runtime(device: torch.device) -> Artifact:
    return {
        "python": platform.python_version(),
        "torch": str(torch.__version__),
        "numpy": str(np.__version__),
        "platform": platform.platform(),
        "device": str(device),
        "threads": torch.get_num_threads(),
        "cuda": torch.version.cuda,
        "device_name": torch.cuda.get_device_name(device)
        if device.type == "cuda"
        else platform.machine(),
    }


def train(
    root: Path,
    out: Path,
    cfg: TrainConfig = DEFAULT_CONFIG,
    resume: bool = False,
    stop_after: int | None = None,
) -> Artifact:
    """Fit baselines and candidate. Opens train/val only; never accesses audit."""
    _config_valid(cfg)
    if stop_after is not None and stop_after < 1:
        raise ValueError("stop_after must be positive")
    train_data, val = read_split(root, "train"), read_split(root, "val")
    audit_splits(train_data, val)
    if set(train_data["template_ids"]) != set(val["template_ids"]):
        raise ValueError("Validation must cover every training template")
    device = torch.device(
        "cuda"
        if cfg.device == "auto" and torch.cuda.is_available()
        else "cpu"
        if cfg.device == "auto"
        else cfg.device
    )
    if device.type not in ("cpu", "cuda"):
        raise ValueError("Exact resume currently supports CPU or CUDA only")
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    torch.set_num_threads(cfg.threads)
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(cfg.seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(cfg.seed)
    rng = np.random.default_rng(cfg.seed)
    p = fit_preprocessing(train_data)
    ids, z, masks = encode_conditions(
        p,
        train_data["template_ids"],
        train_data["conditions"],
        train_data["condition_mask"],
    )
    model = ConditionalRegressor(len(p["templates"]), z.shape[1], cfg.hidden).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay
    )
    inputs = [torch.as_tensor(array, device=device) for array in (ids, z, masks)]
    targets = torch.as_tensor(
        train_data["controls"], dtype=torch.float32, device=device
    )
    hashes = {
        name: digest(root / name) for name in ("release.json", "train.npz", "val.npz")
    }
    identity, source_hash = _runtime(device), digest(Path(__file__))
    cursor = 0
    losses: list[float] = []
    best_state: dict[str, torch.Tensor] | None = None
    best_score = float("inf")
    history: list[Artifact] = []
    out.mkdir(parents=True, exist_ok=True)
    if not resume and (out / "checkpoint.pt").exists():
        raise ValueError("Output already has a run; use resume or a new directory")
    if resume:
        state = safe_load(out / "checkpoint.pt")
        for key, value in (
            ("config", asdict(cfg)),
            ("dataset_hashes", hashes),
            ("runtime", identity),
            ("source_sha256", source_hash),
        ):
            if state.get(key) != value:
                raise ValueError(f"Resume {key} changed")
        model.load_state_dict(state["model_state"])
        optimizer.load_state_dict(state["optimizer_state"])
        rng.bit_generator.state = json.loads(state["numpy_rng_json"])
        torch.set_rng_state(state["torch_rng"])
        if device.type == "cuda":
            torch.cuda.set_rng_state_all(state["cuda_rng"])
        cursor, losses, history = state["cursor"], state["losses"], state["history"]
        best_state, best_score = state["best_state"], state["best_score"]
    rows = {
        key: torch.as_tensor(value) if value.dtype.kind not in "US" else value.tolist()
        for key, value in train_data.items()
        if key
        in (
            "controls",
            "control_names",
            "conditions",
            "condition_names",
            "condition_mask",
            "organ_ids",
            "organ_names",
            "template_ids",
            "sample_ids",
            "group_ids",
        )
    }
    artifact: Artifact = {
        "format": FORMAT,
        "config": asdict(cfg),
        "dataset_hashes": hashes,
        "source_sha256": source_hash,
        "runtime": identity,
        "preprocessing": p,
        "condition_names": train_data["condition_names"].tolist(),
        "control_names": CONTROL_NAMES,
        "organ_names": train_data["organ_names"].tolist(),
        "training_rows": rows,
        "selected_method": "ridge",
        "model_state": {},
        "scope": "Atlas-preserving design controls; no population or texture learning",
    }

    def current_artifact() -> Artifact:
        value = dict(artifact)
        value["model_state"] = {
            k: v.detach().cpu().clone() for k, v in model.state_dict().items()
        }
        return value

    while cursor < cfg.steps:
        model.train()
        index = torch.as_tensor(
            balanced_indices(train_data, rng, cfg.batch_size), device=device
        )
        template, features, observed = (value[index] for value in inputs)
        dropout = rng.random((cfg.batch_size, z.shape[1])) >= cfg.condition_dropout
        dropout[rng.random(cfg.batch_size) < cfg.unconditional_dropout] = False
        observed = observed * torch.as_tensor(dropout, device=device)
        mean, logstd = model(template, features, observed)
        # Proposal objective, not a calibrated bounded-density likelihood.
        loss = (0.5 * ((targets[index] - mean) / logstd.exp()).square() + logstd).mean()
        loss = loss + (targets[index] - mean).square().mean()
        if not torch.isfinite(loss):
            raise ValueError("Non-finite atlas training loss")
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        optimizer.step()
        cursor += 1
        losses.append(float(loss.detach().cpu()))
        if cursor % cfg.checkpoint_every == 0 or cursor == cfg.steps:
            candidate = current_artifact()
            score = evaluate_arrays(candidate, val, "mlp", sampling=False)[
                "macro_template_control_nrmse"
            ]
            history.append({"step": cursor, "validation_macro_control_nrmse": score})
            if score < best_score:
                best_score, best_state = score, copy.deepcopy(candidate["model_state"])
        if (
            cursor % cfg.checkpoint_every == 0
            or cursor == cfg.steps
            or cursor == stop_after
        ):
            checkpoint = current_artifact()
            checkpoint.update(
                {
                    "cursor": cursor,
                    "optimizer_state": optimizer.state_dict(),
                    "numpy_rng_json": json.dumps(rng.bit_generator.state),
                    "torch_rng": torch.get_rng_state(),
                    "cuda_rng": torch.cuda.get_rng_state_all()
                    if device.type == "cuda"
                    else [],
                    "losses": losses,
                    "history": history,
                    "best_state": best_state,
                    "best_score": best_score,
                }
            )
            atomic_torch(out / "checkpoint.pt", checkpoint)
        if cursor == stop_after and cursor < cfg.steps:
            return {"status": "interrupted", "step": cursor}
    if best_state is None:
        raise ValueError("No validation checkpoint available")
    artifact["model_state"] = best_state
    comparisons = {method: evaluate_arrays(artifact, val, method) for method in METHODS}
    baseline = min(
        METHODS[:-1], key=lambda name: comparisons[name]["macro_template_control_nrmse"]
    )
    base_score = comparisons[baseline]["macro_template_control_nrmse"]
    neural_score = comparisons["mlp"]["macro_template_control_nrmse"]
    organ_guard = all(
        comparisons["mlp"]["per_organ_control_nrmse"][organ] <= error * 1.10 + 1e-8
        for organ, error in comparisons[baseline]["per_organ_control_nrmse"].items()
    )
    neural_diversity = comparisons["mlp"]["conditional_proposal_diversity"]
    diversity_guard = all(
        value.get("status") == "MEASURED"
        and value["secondary_controls_mean_std"] >= 0.02
        for value in neural_diversity.values()
    )
    promote = (
        neural_score < base_score * (1 - cfg.neural_improvement)
        and organ_guard
        and diversity_guard
    )
    artifact["selected_method"] = "mlp" if promote else baseline
    artifact["promotion"] = {
        "neural_promoted": promote,
        "baseline": baseline,
        "required_relative_improvement": cfg.neural_improvement,
        "organ_guard_max_regression": 0.10,
        "organ_guard_passed": organ_guard,
        "conditional_diversity_guard_passed": diversity_guard,
        "min_secondary_controls_std": 0.02,
        "selection_split": "val",
        "audit_accessed": False,
    }
    atomic_torch(out / "model.pt", artifact)
    report = {
        "status": "complete",
        "selected_method": artifact["selected_method"],
        "promotion": artifact["promotion"],
        "comparisons": comparisons,
        "history": history,
        "model_sha256": digest(out / "model.pt"),
        "dataset_hashes": hashes,
        "source_sha256": source_hash,
        "runtime": identity,
        "limitations": [
            "Shared reference lineages across splits; no patient-held-out claim",
            "Seven bounded design controls preserve templates but do not discover new anatomy",
            "Conditional uncertainty is uncalibrated; geometry gates remain required",
            "Texture and tissue mechanics are not learned by this model",
        ],
    }
    atomic_json(out / "training_report.json", report)
    return report


def load_model(path: Path) -> Artifact:
    """Validate dimensions, vocabulary, finite state and semantic identity."""
    artifact = safe_load(path)
    if (
        artifact.get("control_names") != CONTROL_NAMES
        or artifact.get("selected_method") not in METHODS
    ):
        raise ValueError("Invalid atlas model contract")
    p = artifact.get("preprocessing", {})
    templates = p.get("templates", [])
    if not templates or len(set(templates)) != len(templates):
        raise ValueError("Invalid template vocabulary")
    d = len(artifact.get("condition_names", []))
    for key in ("condition_mean", "condition_scale", "condition_available"):
        array = np.asarray(p.get(key))
        if array.shape != (len(templates), d) or not np.isfinite(array).all():
            raise ValueError(f"Invalid preprocessing {key}")
    if np.any(np.asarray(p["condition_scale"]) <= 0):
        raise ValueError("Invalid preprocessing scale")
    for value in artifact["model_state"].values():
        if not isinstance(value, torch.Tensor) or not torch.isfinite(value).all():
            raise ValueError("Invalid non-finite model tensor")
    _model(artifact)
    data = _train_data(artifact)
    validate_data(data)
    encode_conditions(
        p, data["template_ids"], data["conditions"], data["condition_mask"]
    )
    return artifact


def make_geometry_decoder(template_root: Path) -> ConditionDecoder:
    """Build a cached high-resolution measurement adapter for the real atlas decoder."""
    from viscera_core.atlas import generate, load_template
    from viscera_core.atlas_dataset import condition_vector

    @lru_cache(maxsize=128)
    def template(template_id: str) -> Any:
        return load_template(template_root, template_id)

    def measure(template_id: str, controls: Array) -> tuple[Array, Array]:
        sample = generate(template(template_id), controls, seed=0)
        values, mask = condition_vector(sample.measurements)
        return np.asarray(values, dtype=np.float64), np.asarray(mask, dtype=bool)

    return measure


def evaluate(
    root: Path,
    model_path: Path,
    split: str = "val",
    decoder: ConditionDecoder | None = None,
) -> Artifact:
    """Evaluate frozen weights; explicit audit access records the model hash."""
    if split not in ("val", "audit"):
        raise ValueError("Evaluate only validation or explicit audit")
    artifact = load_model(model_path)
    if artifact["dataset_hashes"]["release.json"] != digest(root / "release.json"):
        raise ValueError("Evaluation release differs from frozen model release")
    data = read_split(root, split)
    audit_splits(_train_data(artifact), data)
    if split == "audit":
        audit_splits(read_split(root, "val"), data)
    report = evaluate_arrays(artifact, data, decoder=decoder)
    report.update(
        {
            "split": split,
            "model_sha256": digest(model_path),
            "split_sha256": digest(root / f"{split}.npz"),
            "model_frozen": True,
        }
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("train")
    run.add_argument("--dataset", type=Path, required=True)
    run.add_argument("--out", type=Path, required=True)
    run.add_argument("--steps", type=int, default=1200)
    run.add_argument("--batch-size", type=int, default=128)
    run.add_argument("--hidden", type=int, default=128)
    run.add_argument("--seed", type=int, default=6143)
    run.add_argument("--device", choices=("auto", "cpu", "cuda"), default="cpu")
    run.add_argument("--resume", action="store_true")
    ev = commands.add_parser("evaluate")
    ev.add_argument("--dataset", type=Path, required=True)
    ev.add_argument("--model", type=Path, required=True)
    ev.add_argument("--split", choices=("val", "audit"), default="val")
    ev.add_argument("--out", type=Path, required=True)
    ev.add_argument(
        "--templates",
        type=Path,
        help="Measure actual decoded geometry using this template directory",
    )
    sample = commands.add_parser("sample")
    sample.add_argument("--model", type=Path, required=True)
    sample.add_argument("--template", required=True)
    sample.add_argument(
        "--conditions", default="{}", help="JSON object in physical units"
    )
    sample.add_argument("--count", type=int, default=16)
    sample.add_argument("--seed", type=int, default=0)
    sample.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "train":
        result = train(
            args.dataset,
            args.out,
            TrainConfig(
                steps=args.steps,
                batch_size=args.batch_size,
                hidden=args.hidden,
                seed=args.seed,
                device=args.device,
            ),
            resume=args.resume,
        )
        print(
            json.dumps(
                {
                    key: result[key]
                    for key in ("status", "selected_method")
                    if key in result
                }
            )
        )
    elif args.command == "evaluate":
        decoder = make_geometry_decoder(args.templates) if args.templates else None
        result = evaluate(args.dataset, args.model, args.split, decoder)
        atomic_json(args.out, result)
        print(json.dumps({"report": str(args.out), "split": args.split}))
    else:
        model = load_model(args.model)
        controls = sample_controls(
            model, args.template, json.loads(args.conditions), args.count, args.seed
        )
        atomic_json(
            args.out,
            {
                "format": "viscera-atlas-control-samples-v1",
                "template_id": args.template,
                "control_names": CONTROL_NAMES,
                "controls": controls.tolist(),
                "seed": args.seed,
                "conditions": json.loads(args.conditions),
                "model_sha256": digest(args.model),
                "requires_geometry_validation": True,
            },
        )
        print(json.dumps({"samples": str(args.out), "count": len(controls)}))


if __name__ == "__main__":
    main()
