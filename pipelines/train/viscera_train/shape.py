"""Train/evaluate a compact conditional rectified flow in procedural PCA space.

Run from the viscera directory: python -m pipelines.train.viscera_train.shape --help
Only train.npz and val.npz are opened during training. Test is an explicit action.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import random
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np
import torch
from torch import nn


@dataclass(frozen=True)
class TrainConfig:
    steps: int = 600
    batch_size: int = 64
    hidden: int = 128
    rank: int = 8
    lr: float = 0.001
    seed: int = 817
    condition_dropout: float = 0.1
    unconditional_dropout: float = 0.1
    parameter_transform: str = "bounded_logit"
    checkpoint_every: int = 100
    device: str = "auto"


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as f:
        json.dump(value, f, indent=2, allow_nan=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)


def atomic_torch(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as f:
        torch.save(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)
    atomic_json(path.with_suffix(path.suffix + ".sha256.json"), {"sha256": digest(path)})


def safe_load(path: Path) -> dict[str, Any]:
    metadata = path.with_suffix(path.suffix + ".sha256.json")
    if not metadata.exists() or json.loads(metadata.read_text())["sha256"] != digest(path):
        raise ValueError(f"Missing or incorrect checkpoint checksum: {path}")
    value = torch.load(path, map_location="cpu", weights_only=True)
    if not isinstance(value, dict):
        raise ValueError("Checkpoint must contain a mapping")
    return value


def read_split(root: Path, split: str) -> dict[str, np.ndarray]:
    path = root / f"{split}.npz"
    manifest_path = root / "release.json"
    if not manifest_path.exists():
        raise ValueError("Dataset release.json is required")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("artifact_hashes", {}).get(path.name) != digest(path):
        raise ValueError(f"Split absent from release manifest or corrupt: {path.name}")
    with np.load(path, allow_pickle=False) as archive:
        data = {k: archive[k].copy() for k in archive.files}
    for key in ("parameters", "conditions", "parameter_names", "condition_names"):
        if key not in data:
            raise ValueError(f"{path}: missing {key}")
    x, c = data["parameters"], data["conditions"]
    if x.ndim != 2 or c.ndim != 2 or len(x) != len(c) or not len(x):
        raise ValueError("Nonempty aligned two-dimensional arrays required")
    if not np.isfinite(x).all() or not np.isfinite(c).all():
        raise ValueError(
            "Pilot training requires finite measured labels; no invented missing targets"
        )
    if x.shape[1] != len(data["parameter_names"]) or c.shape[1] != len(data["condition_names"]):
        raise ValueError("Named feature dimensions disagree")
    for key in ("parameter_names", "condition_names"):
        names = data[key]
        if (
            names.ndim != 1
            or names.dtype.kind not in "US"
            or not all(str(name) for name in names)
            or len(np.unique(names)) != len(names)
        ):
            raise ValueError(f"{key} must contain unique nonempty feature names")
    if "sample_ids" not in data:
        raise ValueError("Split rows require sample_ids")
    for key in ("sample_ids", "group_ids"):
        if key in data:
            ids = data[key]
            if ids.ndim != 1 or len(ids) != len(x) or ids.dtype.kind not in "US":
                raise ValueError(f"{key} must align one string identifier per row")
            if not all(str(value) for value in ids):
                raise ValueError(f"{key} cannot contain empty identifiers")
    if len(np.unique(data["sample_ids"])) != len(x):
        raise ValueError("sample_ids must be unique within each split")
    return data


def audit_splits(a: dict[str, Any], b: dict[str, Any]) -> None:
    for names in ("parameter_names", "condition_names"):
        if not np.array_equal(a[names], b[names]):
            raise ValueError(f"Split feature schema mismatch: {names}")
    key = "group_ids" if "group_ids" in a and "group_ids" in b else "sample_ids"
    if key not in a or key not in b:
        raise ValueError("Split records must contain group_ids or sample_ids")
    overlap = set(a[key].tolist()) & set(b[key].tolist())
    if overlap:
        raise ValueError(f"Derivative group leakage: {sorted(overlap)[:3]}")


def fit_preprocessing(
    train: dict[str, Any], rank: int, parameter_transform: str = "bounded_logit"
) -> dict[str, np.ndarray]:
    x = np.asarray(train["parameters"], dtype=np.float64)
    c = np.asarray(train["conditions"], dtype=np.float64)
    physical_mean = x.mean(0)
    physical_scale = np.maximum(x.std(0, ddof=1), 1e-9)
    bounds: dict[str, np.ndarray] = {}
    if parameter_transform == "bounded_logit":
        from viscera_core.schema import PARAMETER_BOUNDS

        names = train["parameter_names"].tolist()
        if any(k not in PARAMETER_BOUNDS for k in names):
            raise ValueError("Bounded encoding requires authoritative bounds for every parameter")
        bounds = {
            "bounds_low": np.array([PARAMETER_BOUNDS[k][0] for k in names]),
            "bounds_high": np.array([PARAMETER_BOUNDS[k][1] for k in names]),
        }
        x = physical_to_unconstrained(x, bounds)
    elif parameter_transform != "identity":
        raise ValueError("Parameter transform must be bounded_logit or identity")
    xm = x.mean(0)
    xs = x.std(0, ddof=1)
    xs = np.where(xs > 1e-9, xs, 1.0)
    _, s, vt = np.linalg.svd((x - xm) / xs, full_matrices=False)
    numerical_rank = int(np.sum(s > max(s[0] * 1e-9, 1e-10)))
    k = min(rank, numerical_rank, len(x) - 1)
    if k < 1:
        raise ValueError("Insufficient variation for shape learning")
    sigma = s[:k] / np.sqrt(len(x) - 1)
    cs = c.std(0, ddof=1)
    return {
        **bounds,
        "physical_mean": physical_mean,
        "physical_scale": physical_scale,
        "x_mean": xm,
        "x_scale": xs,
        "basis": vt[:k].T,
        "sigma": sigma,
        "c_mean": c.mean(0),
        "c_scale": np.where(cs > 1e-9, cs, 1.0),
        "c_min": c.min(0),
        "c_max": c.max(0),
    }


def physical_to_unconstrained(x: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    if "bounds_low" not in p:
        return np.asarray(x)
    fraction = (x - p["bounds_low"]) / (p["bounds_high"] - p["bounds_low"])
    if not np.isfinite(fraction).all() or np.any((fraction <= 0) | (fraction >= 1)):
        raise ValueError(
            "bounded_logit requires strictly interior finite parameters; exact endpoints are explicitly unsupported, never clamped"
        )
    return np.asarray(np.log(fraction) - np.log1p(-fraction))


def encode(x: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    x = physical_to_unconstrained(x, p)
    return np.asarray((((x - p["x_mean"]) / p["x_scale"]) @ p["basis"]) / p["sigma"])


def decode(z: np.ndarray, p: dict[str, Any]) -> np.ndarray:
    x = np.asarray((z * p["sigma"]) @ p["basis"].T * p["x_scale"] + p["x_mean"])
    if "bounds_low" in p:
        from scipy.special import expit

        return np.asarray(p["bounds_low"] + (p["bounds_high"] - p["bounds_low"]) * expit(x))
    return x


class ConditionalFlow(nn.Module):
    frequencies: torch.Tensor

    def __init__(self, latent_dim: int, condition_dim: int, hidden: int):
        super().__init__()
        self.latent_dim = latent_dim
        self.condition_dim = condition_dim
        self.net = nn.Sequential(
            nn.Linear(latent_dim + 2 * condition_dim + 16, hidden),
            nn.SiLU(),
            nn.Linear(hidden, hidden),
            nn.SiLU(),
            nn.Linear(hidden, hidden),
            nn.SiLU(),
            nn.Linear(hidden, latent_dim),
        )
        self.register_buffer("frequencies", 2.0 ** torch.arange(8) * torch.pi)

    def forward(
        self, z: torch.Tensor, t: torch.Tensor, c: torch.Tensor, observed: torch.Tensor
    ) -> torch.Tensor:
        phase = t[:, None] * self.frequencies[None, :]
        return cast(
            torch.Tensor,
            self.net(torch.cat((z, c * observed, observed, phase.sin(), phase.cos()), dim=1)),
        )


def integrate(
    model: ConditionalFlow, c: torch.Tensor, observed: torch.Tensor, seed: int, steps: int = 32
) -> torch.Tensor:
    if steps < 1:
        raise ValueError("Positive integration steps required")
    generator = torch.Generator(device=c.device).manual_seed(seed)
    z = torch.randn((len(c), model.latent_dim), generator=generator, device=c.device)
    with torch.inference_mode():
        # Heun predictor/corrector with the same condition at both evaluations.
        for i in range(steps):
            t = torch.full((len(c),), i / steps, device=c.device)
            v = model(z, t, c, observed)
            predictor = z + v / steps
            vn = model(predictor, t + 1 / steps, c, observed)
            z = z + (v + vn) / (2 * steps)
    return z


def baseline_fit(z: np.ndarray, c: np.ndarray) -> dict[str, np.ndarray]:
    design = np.column_stack((np.ones(len(c)), c))
    regularizer = np.eye(design.shape[1]) * 1e-3
    regularizer[0, 0] = 0
    coefficients = np.linalg.solve(design.T @ design + regularizer, design.T @ z)
    residuals = z - design @ coefficients
    covariance = residuals.T @ residuals / max(1, len(z) - 1)
    values, vectors = np.linalg.eigh(covariance)
    factor = vectors @ np.diag(np.sqrt(np.maximum(values, 1e-8)))
    return {"coefficients": coefficients, "residual_factor": factor, "train_z": z, "train_c": c}


def arrays_to_tensors(p: dict[str, Any]) -> dict[str, Any]:
    return {k: torch.as_tensor(v.copy()) for k, v in p.items()}


def tensors_to_arrays(p: dict[str, Any]) -> dict[str, Any]:
    return {k: v.cpu().numpy() for k, v in p.items()}


def select_device(value: str) -> torch.device:
    if value == "auto":
        value = "cuda" if torch.cuda.is_available() else "cpu"
    if value == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA requested but unavailable")
    return torch.device(value)


def rng_state() -> dict[str, Any]:
    state = np.random.get_state(legacy=True)
    if not isinstance(state, tuple):
        raise TypeError("Expected legacy NumPy RNG tuple")
    return {
        "python": random.getstate(),
        "torch": torch.get_rng_state(),
        "numpy": {
            "keys": torch.tensor(state[1].astype(np.int64)),
            "pos": state[2],
            "gaussian": state[3],
            "cached": state[4],
        },
        "cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
    }


def restore_rng(state: dict[str, Any]) -> None:
    random.setstate(state["python"])
    torch.set_rng_state(state["torch"])
    n = state["numpy"]
    np.random.set_state(
        ("MT19937", n["keys"].numpy().astype(np.uint32), n["pos"], n["gaussian"], n["cached"])
    )
    if state["cuda"] and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(state["cuda"])


def train(
    data_root: Path,
    out: Path,
    config: TrainConfig = TrainConfig(),
    resume: bool = False,
    stop_after: int | None = None,
) -> dict[str, Any]:
    if config.steps < 1 or config.batch_size < 1 or config.checkpoint_every < 1:
        raise ValueError("Positive steps, batch and checkpoint interval required")
    if config.hidden < 1 or config.rank < 1 or not np.isfinite(config.lr) or config.lr <= 0:
        raise ValueError("Positive hidden width, rank and finite learning rate required")
    if not 0 <= config.condition_dropout <= 1 or not 0 <= config.unconditional_dropout <= 1:
        raise ValueError("Condition dropout probabilities must be in [0, 1]")
    if stop_after is not None and (type(stop_after) is not int or stop_after < 1):
        raise ValueError("stop_after must be a positive integer")
    out.mkdir(parents=True, exist_ok=True)
    train_data, val_data = read_split(data_root, "train"), read_split(data_root, "val")
    audit_splits(train_data, val_data)
    release = json.loads((data_root / "release.json").read_text())
    train_groups = train_data.get("group_ids", train_data["sample_ids"])
    if len(np.unique(train_groups)) != len(train_groups):
        raise ValueError(
            "Pilot trainer requires one anatomy row per group; derivatives must not inflate training weights"
        )
    identity = {s: digest(data_root / f"{s}.npz") for s in ("train", "val")}
    decoder_module = importlib.util.find_spec("viscera_core.geometry")
    if decoder_module is None or decoder_module.origin is None:
        raise ImportError("Procedural decoder source cannot be resolved")
    code_identity = {
        "trainer_sha256": digest(Path(__file__)),
        "geometry_sha256": digest(Path(decoder_module.origin)),
    }
    device = select_device(config.device)
    runtime_identity = {
        "device_type": device.type,
        "torch_version": str(torch.__version__),
        "numpy_version": str(np.__version__),
    }
    if device.type == "cpu":
        torch.set_num_threads(min(4, os.cpu_count() or 1))
    torch.manual_seed(config.seed)
    random.seed(config.seed)
    np.random.seed(config.seed)
    torch.use_deterministic_algorithms(device.type == "cpu")
    pre = fit_preprocessing(train_data, config.rank, config.parameter_transform)
    z = encode(train_data["parameters"], pre)
    c = (train_data["conditions"] - pre["c_mean"]) / pre["c_scale"]
    model = ConditionalFlow(z.shape[1], c.shape[1], config.hidden).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=config.lr, weight_decay=1e-4)
    x_train = torch.as_tensor(z, dtype=torch.float32, device=device)
    c_train = torch.as_tensor(c, dtype=torch.float32, device=device)
    baseline = baseline_fit(z, c)
    ordering = torch.Generator().manual_seed(config.seed + 1)
    permutation = torch.randperm(len(z), generator=ordering)
    cursor = 0
    step = 0
    history = []
    elapsed_before = 0.0
    if resume:
        checkpoint = safe_load(out / "checkpoint.pt")
        if (
            checkpoint["data_identity"] != identity
            or checkpoint["config"] != asdict(config)
            or checkpoint["code_identity"] != code_identity
            or checkpoint.get("runtime_identity") != runtime_identity
        ):
            raise ValueError(
                "Resume refuses changed train/val data, code, configuration or runtime"
            )
        model.load_state_dict(checkpoint["model"])
        optimizer.load_state_dict(checkpoint["optimizer"])
        step = checkpoint["step"]
        cursor = checkpoint["cursor"]
        permutation = checkpoint["permutation"]
        ordering.set_state(checkpoint["ordering_rng"])
        history = checkpoint["history"]
        elapsed_before = checkpoint["elapsed_s"]
        restore_rng(checkpoint["rng"])
    elif (out / "checkpoint.pt").exists():
        raise ValueError("Existing checkpoint: use --resume or choose a new output directory")
    started = time.perf_counter()
    goal = min(config.steps, stop_after) if stop_after is not None else config.steps
    if goal < step:
        raise ValueError("stop_after precedes the restored checkpoint")
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats()
    model.train()
    while step < goal:
        if cursor == len(z):
            permutation = torch.randperm(len(z), generator=ordering)
            cursor = 0
        indexes = permutation[cursor : cursor + config.batch_size].to(device)
        cursor += len(indexes)
        x1 = x_train[indexes]
        condition = c_train[indexes]
        x0 = torch.randn_like(x1)
        t = torch.rand(len(indexes), device=device)
        observed = (torch.rand_like(condition) >= config.condition_dropout).float()
        # Independent attribute dropout almost never presents all five missing
        # conditions. Explicit unconditional rows train the default {} sampler.
        unconditional = torch.rand((len(indexes), 1), device=device) < config.unconditional_dropout
        observed = observed.masked_fill(unconditional, 0)
        xt = x0 * (1 - t[:, None]) + x1 * t[:, None]
        prediction = model(xt, t, condition, observed)
        loss = torch.mean((prediction - (x1 - x0)) ** 2)
        if not torch.isfinite(loss):
            raise FloatingPointError("Nonfinite training loss; no model promotion")
        optimizer.zero_grad(set_to_none=True)
        torch.autograd.backward(loss)
        nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        step += 1
        if step % 25 == 0 or step == goal:
            history.append({"step": step, "flow_mse": float(loss.detach().cpu())})
        if step % config.checkpoint_every == 0 or step == goal:
            atomic_torch(
                out / "checkpoint.pt",
                {
                    "format": 1,
                    "model": model.state_dict(),
                    "optimizer": optimizer.state_dict(),
                    "config": asdict(config),
                    "data_identity": identity,
                    "code_identity": code_identity,
                    "runtime_identity": runtime_identity,
                    "step": step,
                    "cursor": cursor,
                    "permutation": permutation,
                    "ordering_rng": ordering.get_state(),
                    "rng": rng_state(),
                    "history": history,
                    "elapsed_s": elapsed_before + time.perf_counter() - started,
                },
            )
    complete = step == config.steps
    artifact = {
        "format": 1,
        "model": model.cpu().state_dict(),
        "config": asdict(config),
        "preprocessing": arrays_to_tensors(pre),
        "baselines": arrays_to_tensors(baseline),
        "parameter_names": train_data["parameter_names"].tolist(),
        "condition_names": train_data["condition_names"].tolist(),
        "data_identity": identity,
        "code_identity": code_identity,
        "runtime_identity": runtime_identity,
        "decoder_resolution": release.get("recipe", {}).get("resolution", "low"),
        "parameter_transform": {
            "name": config.parameter_transform,
            "bounds_source": "viscera_core.schema.PARAMETER_BOUNDS"
            if config.parameter_transform == "bounded_logit"
            else None,
            "endpoint_policy": "reject exact boundary training values; no epsilon or clipping",
        },
        "step": step,
        "status": "research_candidate" if complete else "interrupted",
    }
    atomic_torch(out / "model.pt", artifact)
    report = {
        "status": artifact["status"],
        "step": step,
        "parameter_count": sum(p.numel() for p in model.parameters()),
        "train_samples": len(z),
        "val_samples": len(val_data["parameters"]),
        "pca_rank": z.shape[1],
        "train_only_preprocessing": True,
        "parameter_transform": artifact["parameter_transform"],
        "test_accessed": False,
        "data_identity": identity,
        "code_identity": code_identity,
        "sampling_policy": "uniform permutation of one anatomy row per derivative group; one procedural lineage",
        "device": str(device),
        "device_name": torch.cuda.get_device_name(device)
        if device.type == "cuda"
        else platform.processor(),
        "torch_version": torch.__version__,
        "numpy_version": np.__version__,
        "wall_time_s": elapsed_before + time.perf_counter() - started,
        "peak_gpu_bytes": torch.cuda.max_memory_allocated(device)
        if device.type == "cuda"
        else None,
        "history": history,
        "evidence": "within-generator procedural design distribution; unreviewed",
        "limitations": [
            "No independent anatomical designs or patient population fitted",
            "Flow loss is not anatomical fidelity; evaluate decoded candidates separately",
            "No expert or tissue validation; no automatic production promotion",
        ],
    }
    if complete:
        report["validation"] = evaluate_arrays(
            artifact, val_data, split="val", seed=config.seed + 9
        )
    atomic_json(out / "training_report.json", report)
    (out / "MODEL_CARD.md").write_text(
        "# VISCERA procedural shape research candidate\n\n"
        f"Status: {artifact['status']}. Trained {step} steps on {len(z)} procedural variations.\n\n"
        "A conditional rectified flow learns construction parameters in a train-only PCA basis. "
        "Conditional Gaussian/PCA and nearest-design baselines are bundled. The decoder is the "
        "versioned procedural geometry implementation; weights alone do not contain anatomy.\n\n"
        f"Parameter transform: {config.parameter_transform}. Bounded logit uses authoritative capability "
        "intervals and a sigmoid decoder, with exact endpoint training values rejected explicitly. "
        "This prevents out-of-domain controls by construction; mesh gates can still reject shapes.\n\n"
        "Data are original synthetic designs, unreviewed and not patient anatomy. Validation is "
        "within-generator interpolation only. No claim of empirical tissue realism, independent "
        "anatomical generalization, or physiological material validity. No test-set model selection.\n\n"
        "See training_report.json for measured compute, failed candidates, condition errors and "
        "baseline comparisons. model.pt uses PyTorch weights_only loading and a SHA-256 sidecar.\n"
    )
    return report


def model_from_artifact(artifact: dict[str, Any]) -> ConditionalFlow:
    p = artifact["preprocessing"]
    model = ConditionalFlow(
        p["basis"].shape[1], len(artifact["condition_names"]), artifact["config"]["hidden"]
    )
    model.load_state_dict(artifact["model"])
    model.eval()
    return model


def sample_parameters(
    artifact: dict[str, Any],
    conditions: np.ndarray,
    method: str = "flow",
    seed: int = 18,
    integration_steps: int = 32,
) -> np.ndarray:
    p = tensors_to_arrays(artifact["preprocessing"])
    b = tensors_to_arrays(artifact["baselines"])
    conditions = np.asarray(conditions, dtype=np.float64)
    if conditions.ndim != 2 or conditions.shape[1] != len(artifact["condition_names"]):
        raise ValueError("Condition columns must match artifact condition_names")
    if np.isinf(conditions).any():
        raise ValueError("Infinite conditions are invalid; use NaN only for omitted conditions")
    observed = np.isfinite(conditions)
    normalized = np.where(observed, (conditions - p["c_mean"]) / p["c_scale"], 0)
    rng = np.random.default_rng(seed)
    if method == "flow":
        z = integrate(
            model_from_artifact(artifact),
            torch.tensor(normalized, dtype=torch.float32),
            torch.tensor(observed, dtype=torch.float32),
            seed,
            integration_steps,
        ).numpy()
    elif method == "pca":
        z = np.column_stack((np.ones(len(normalized)), normalized)) @ b["coefficients"]
        z += rng.normal(size=z.shape) @ b["residual_factor"].T
    elif method == "nearest":
        distances = np.sum(
            ((normalized[:, None] - b["train_c"][None]) * observed[:, None]) ** 2, axis=-1
        )
        z = b["train_z"][np.argmin(distances, axis=1)]
    else:
        raise ValueError("Method must be flow, pca or nearest")
    return decode(z, p)


def decoded_measurements(
    parameters: np.ndarray, parameter_names: list[str], seed: int, resolution: str = "low"
) -> dict[str, Any]:
    from viscera_core.geometry import PARAMETER_BOUNDS, generate_scene

    params = dict(zip(parameter_names, map(float, parameters), strict=True))
    bad = [
        k
        for k, v in params.items()
        if not np.isfinite(v) or not PARAMETER_BOUNDS[k][0] <= v <= PARAMETER_BOUNDS[k][1]
    ]
    if bad:
        return {"accepted": False, "reason": "parameter_out_of_bounds", "fields": bad}
    try:
        scene = generate_scene(
            {"seed": seed, "parameters": params}, resolution=resolution, include_simulation=False
        )
        qa = scene.get("qa", {})
        if qa and not qa.get("passed", qa.get("valid", True)):
            return {"accepted": False, "reason": "geometry_gate", "qa": qa}
        return {"accepted": True, "measurements": scene["measurements"], "parameters": params}
    except (ValueError, KeyError, RuntimeError) as exc:
        return {"accepted": False, "reason": "decoder_error", "message": str(exc)}


def evaluate_arrays(
    artifact: dict[str, Any],
    reference: dict[str, Any],
    split: str,
    seed: int = 18,
    maximum_decode: int = 24,
) -> dict[str, Any]:
    from scipy.spatial.distance import cdist

    for key in ("parameter_names", "condition_names"):
        if not np.array_equal(reference[key], artifact[key]):
            raise ValueError(f"Evaluation feature schema mismatch: {key}")
    if not len(reference["conditions"]) or maximum_decode < 1:
        raise ValueError("Evaluation requires reference rows and a positive decode limit")
    conditions = reference["conditions"]
    p = tensors_to_arrays(artifact["preprocessing"])
    result: dict[str, Any] = {
        "split": split,
        "count": len(conditions),
        "track": "within_generator",
        "empirical_anatomy_claim": False,
        "methods": {},
    }
    physical_mean = p.get("physical_mean", p["x_mean"])
    physical_scale = p.get("physical_scale", p["x_scale"])
    standardized_reference = (reference["parameters"] - physical_mean) / physical_scale
    for method in ("flow", "pca", "nearest"):
        generated = sample_parameters(artifact, conditions, method, seed)
        standardized = (generated - physical_mean) / physical_scale
        distances = cdist(standardized_reference, standardized)
        decoded = [
            decoded_measurements(
                row, artifact["parameter_names"], seed + i, artifact["decoder_resolution"]
            )
            for i, row in enumerate(generated[:maximum_decode])
        ]
        accepted = [i for i, row in enumerate(decoded) if row["accepted"]]
        errors = {}
        for j, name in enumerate(artifact["condition_names"]):
            values = [
                abs(float(decoded[i]["measurements"][name]) - float(conditions[i, j]))
                for i in accepted
            ]
            errors[name] = {
                "mean_absolute": float(np.mean(values)) if values else None,
                "p95_absolute": float(np.quantile(values, 0.95)) if values else None,
                "denominator": len(values),
                "normalization_train_std": float(p["c_scale"][j]),
            }
        fixed = np.repeat(conditions[:1], 12, axis=0)
        variants = sample_parameters(artifact, fixed, method, seed + 1)
        sensitivity = []
        # Intervene on one *measured* condition at a time with the same noise.
        # Report coupled attribute drift; never infer control from latent changes.
        centre = np.median(conditions, axis=0)
        for j, name in enumerate(artifact["condition_names"]):
            low, high = centre.copy(), centre.copy()
            low[j] = max(p["c_min"][j], centre[j] - 0.3 * p["c_scale"][j])
            high[j] = min(p["c_max"][j], centre[j] + 0.3 * p["c_scale"][j])
            pair_parameters = np.concatenate(
                [sample_parameters(artifact, v[None], method, seed + 441) for v in (low, high)]
            )
            pair = [
                decoded_measurements(
                    v, artifact["parameter_names"], seed + 441, artifact["decoder_resolution"]
                )
                for v in pair_parameters
            ]
            entry = {
                "condition": name,
                "requested_low": float(low[j]),
                "requested_high": float(high[j]),
                "attempted": 2,
                "accepted": sum(v["accepted"] for v in pair),
            }
            if all(v["accepted"] for v in pair):
                measurements = [v["measurements"] for v in pair]
                entry.update(
                    {
                        "realized_low": float(measurements[0][name]),
                        "realized_high": float(measurements[1][name]),
                        "correct_direction": bool(measurements[1][name] > measurements[0][name]),
                        "other_condition_normalized_drift": {
                            k: abs(float(measurements[1][k]) - float(measurements[0][k]))
                            / float(p["c_scale"][q])
                            for q, k in enumerate(artifact["condition_names"])
                            if q != j
                        },
                    }
                )
            else:
                entry["failures"] = [v for v in pair if not v["accepted"]]
            sensitivity.append(entry)
        result["methods"][method] = {
            "parameter_mmd": float(distances.min(axis=1).mean()),
            "parameter_coverage": float(len(np.unique(distances.argmin(axis=0))) / len(distances)),
            "metric_space": "train-standardized procedural controls, not anatomical surface distance",
            "decoded_attempted": len(decoded),
            "decoded_accepted": len(accepted),
            "decoded_rejected": len(decoded) - len(accepted),
            "conditional_errors": errors,
            "failures": [
                {"index": i, **row} for i, row in enumerate(decoded) if not row["accepted"]
            ],
            "fixed_condition_parameter_std": np.std(variants, axis=0).tolist(),
            "realized_condition_sensitivity": sensitivity,
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    tr = sub.add_parser("train")
    tr.add_argument("--data", type=Path, required=True)
    tr.add_argument("--out", type=Path, required=True)
    tr.add_argument("--steps", type=int, default=600)
    tr.add_argument("--batch-size", type=int, default=64)
    tr.add_argument("--hidden", type=int, default=128)
    tr.add_argument("--seed", type=int, default=817)
    tr.add_argument("--device", default="auto")
    tr.add_argument(
        "--parameter-transform", choices=("bounded_logit", "identity"), default="bounded_logit"
    )
    tr.add_argument("--resume", action="store_true")
    tr.add_argument("--stop-after", type=int)
    ev = sub.add_parser("evaluate")
    ev.add_argument("--data", type=Path, required=True)
    ev.add_argument("--model", type=Path, required=True)
    ev.add_argument("--split", choices=("val", "test"), default="test")
    ev.add_argument("--out", type=Path, required=True)
    sa = sub.add_parser("sample")
    sa.add_argument("--model", type=Path, required=True)
    sa.add_argument(
        "--conditions",
        required=True,
        help="JSON object using model condition_names; omitted values stay unconditioned",
    )
    sa.add_argument("--count", type=int, default=8)
    sa.add_argument("--seed", type=int, default=31)
    sa.add_argument("--out", type=Path, required=True)
    sa.add_argument(
        "--scene-dir", type=Path, help="Write each accepted decoded 3D scene as self-contained JSON"
    )
    args = parser.parse_args()
    if args.command == "train":
        config = TrainConfig(
            steps=args.steps,
            batch_size=args.batch_size,
            hidden=args.hidden,
            seed=args.seed,
            device=args.device,
            parameter_transform=args.parameter_transform,
        )
        report = train(args.data, args.out, config, args.resume, args.stop_after)
        print(
            json.dumps(
                {k: report[k] for k in ("status", "step", "wall_time_s", "device")}, indent=2
            )
        )
    elif args.command == "evaluate":
        artifact = safe_load(args.model)
        reference = read_split(args.data, args.split)
        if any(
            digest(args.data / f"{split}.npz") != artifact["data_identity"][split]
            for split in ("train", "val")
        ):
            raise ValueError("Evaluation dataset does not match the model train/validation release")
        if args.split == "test":
            audit_splits(read_split(args.data, "train"), reference)
            audit_splits(read_split(args.data, "val"), reference)
        report = evaluate_arrays(artifact, reference, args.split)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(args.out, report)
        print(args.out)
    else:
        artifact = safe_load(args.model)
        if args.count < 1:
            raise ValueError("Sample count must be positive")
        specified = json.loads(args.conditions)
        if not isinstance(specified, dict):
            raise ValueError("Conditions must be a JSON object")
        unknown = set(specified) - set(artifact["condition_names"])
        if unknown:
            raise ValueError(f"Unknown condition names: {sorted(unknown)}")
        conditions = np.array(
            [[specified.get(k, np.nan) for k in artifact["condition_names"]]] * args.count
        )
        params = sample_parameters(artifact, conditions, seed=args.seed)
        rows = [
            decoded_measurements(
                row, artifact["parameter_names"], args.seed + i, artifact["decoder_resolution"]
            )
            for i, row in enumerate(params)
        ]
        if args.scene_dir is not None:
            from viscera_core.geometry import generate_scene

            args.scene_dir.mkdir(parents=True, exist_ok=True)
            for index, row in enumerate(rows):
                if row["accepted"]:
                    scene = generate_scene(
                        {"seed": args.seed + index, "parameters": row["parameters"]},
                        resolution=artifact["decoder_resolution"],
                    )
                    scene_path = args.scene_dir / f"sample-{index:04d}.json"
                    atomic_json(scene_path, scene)
                    row["scene_artifact"] = str(scene_path)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(
            args.out,
            {
                "requested": specified,
                "attempted": len(rows),
                "accepted": sum(r["accepted"] for r in rows),
                "samples": rows,
            },
        )
        print(args.out)


if __name__ == "__main__":
    main()
