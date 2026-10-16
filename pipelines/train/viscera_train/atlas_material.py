"""Factorized appearance-code learning; frozen atlas geometry is never predicted.

A measured procedural-field inverse model is compared with simple baselines.
Unconditional appearance is an empirical design-space bootstrap, not a tissue
population distribution. Model exports use non-pickle NPZ for optional serving.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
import torch
from torch import nn
from viscera_core import atlas_material_dataset as dataset

FORMAT = "viscera-material-prior-1.0.0"
FloatArray = npt.NDArray[np.float64]


def digest(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
    tmp.replace(path)


@dataclass(frozen=True)
class Config:
    steps: int = 2000
    seed: int = 1923
    width: int = 64
    batch_size: int = 96
    lr: float = 0.001
    ridge: float = 0.1
    checkpoint_every: int = 250


class Prior(nn.Module):
    def __init__(self, input_size: int, width: int):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Linear(input_size, width),
            nn.Tanh(),
            nn.Linear(width, width),
            nn.Tanh(),
            nn.Linear(width, len(dataset.CONTROL_NAMES) * 2),
        )

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        output = self.layers(x)
        return output[:, :6].tanh(), output[:, 6:].clamp(-3, 0)


def group_names(data: dict[str, Any]) -> npt.NDArray[np.str_]:
    return np.asarray(
        [
            f"{organ}|{preset}"
            for organ, preset in zip(data["organ_names"], data["presets"], strict=True)
        ]
    )


def ensure_groups(train: dict[str, Any], val: dict[str, Any]) -> None:
    for key in ("sample_ids", "group_ids"):
        if set(train[key]) & set(val[key]):
            raise ValueError("Material recipe derivatives cross training/validation splits")
    if not set(group_names(val)).issubset(set(group_names(train))):
        raise ValueError("Validation contains an unsupported organ/preset")


def features(model: dict[str, Any], conditions: FloatArray, groups: Any) -> FloatArray:
    group = [model["group_names"].tolist().index(str(g)) for g in groups]
    x = (np.asarray(conditions, dtype=np.float64) - model["condition_mean"]) / model[
        "condition_scale"
    ]
    if x.shape != (len(group), len(dataset.CONDITION_NAMES)) or not np.isfinite(x).all():
        raise ValueError("Invalid measured material conditions")
    return np.column_stack((np.eye(len(model["group_names"]))[group], x))


def fit_baselines(train: dict[str, Any], cfg: Config) -> dict[str, Any]:
    groups = group_names(train)
    names = np.asarray(sorted(set(groups)))
    controls, conditions = train["controls"], train["conditions"]
    model = {
        "group_names": names,
        "condition_mean": conditions.mean(axis=0),
        "condition_scale": np.maximum(conditions.std(axis=0), 1e-6),
        "train_groups": groups,
        "train_controls": controls.copy(),
        "train_conditions": conditions.copy(),
    }
    x = features(model, conditions, groups)
    penalty = np.eye(x.shape[1]) * cfg.ridge
    # Group intercepts shrink much less than slopes; preprocessing uses train only.
    penalty[: len(names), : len(names)] *= 0.01
    inverse = np.linalg.inv(x.T @ x + penalty)
    coef = inverse @ x.T @ controls
    leverage = np.einsum("ni,ij,nj->n", x, inverse, x)
    residuals = (controls - x @ coef) / np.maximum(1 - leverage[:, None], 0.05)
    model.update(ridge_coef=coef, ridge_residuals=residuals)
    nearest_residuals, mean_residuals = np.zeros_like(controls), np.zeros_like(controls)
    for i, group in enumerate(groups):
        others = np.flatnonzero((groups == group) & (np.arange(len(groups)) != i))
        if len(others) < 1:
            raise ValueError("At least two training material recipes per organ/preset are required")
        distance = np.mean(
            ((conditions[others] - conditions[i]) / model["condition_scale"]) ** 2, axis=1
        )
        nearest_residuals[i] = controls[i] - controls[others[np.argmin(distance)]]
        mean_residuals[i] = controls[i] - controls[others].mean(axis=0)
    model.update(nearest_residuals=nearest_residuals, mean_residuals=mean_residuals)
    model["group_means"] = np.stack([controls[groups == name].mean(axis=0) for name in names])
    return model


def mlp_numpy(model: dict[str, Any], x: FloatArray) -> tuple[FloatArray, FloatArray]:
    for index in (0, 2):
        x = np.tanh(x @ model[f"nn_layers.{index}.weight"].T + model[f"nn_layers.{index}.bias"])
    output = x @ model["nn_layers.4.weight"].T + model["nn_layers.4.bias"]
    return np.tanh(output[:, :6]), np.clip(output[:, 6:], -3, 0)


def predict(model: dict[str, Any], data: dict[str, Any], method: str | None = None) -> FloatArray:
    method = method or str(model["selected"])
    groups = group_names(data)
    x = features(model, data["conditions"], groups)
    if method == "ridge":
        return np.asarray(np.clip(x @ model["ridge_coef"], -1, 1), dtype=np.float64)
    if method == "mlp":
        return mlp_numpy(model, x)[0]
    result = []
    for i, group in enumerate(groups):
        ids = np.flatnonzero(model["train_groups"] == group)
        if method == "mean":
            result.append(model["train_controls"][ids].mean(axis=0))
        elif method == "nearest":
            distance = np.mean(
                (
                    (model["train_conditions"][ids] - data["conditions"][i])
                    / model["condition_scale"]
                )
                ** 2,
                axis=1,
            )
            result.append(model["train_controls"][ids[np.argmin(distance)]])
        else:
            raise ValueError("Unknown material model method")
    return np.asarray(result, dtype=np.float64)


def measured_metrics(
    model: dict[str, Any],
    data: dict[str, Any],
    predicted: FloatArray,
    anchors: dict[str, FloatArray],
) -> dict[str, Any]:
    code_error = np.mean((predicted - data["controls"]) ** 2, axis=1)
    summary_errors, field_errors = [], []
    for i, controls in enumerate(predicted):
        summary, fields = dataset.evaluate_controls(
            str(data["organ_names"][i]),
            str(data["presets"][i]),
            int(data["seeds"][i]),
            controls,
            anchors[str(data["template_ids"][i])],
        )
        summary_errors.append(((summary - data["conditions"][i]) / model["condition_scale"]) ** 2)
        target = data["field_values"][i]
        field_errors.append(
            [
                np.mean(np.abs(fields[:, :3] - target[:, :3])),
                np.mean(np.abs(fields[:, 3] - target[:, 3])),
                np.sqrt(np.mean((fields[:, 4] - target[:, 4]) ** 2)),
                np.sqrt(np.mean((fields[:, 5:] - target[:, 5:]) ** 2)),
            ]
        )
    summary_errors_a, field_errors_a = np.asarray(summary_errors), np.asarray(field_errors)
    groups = group_names(data)
    per_group = {
        g: {
            "control_nrmse": float(np.sqrt(code_error[groups == g].mean()) / 2),
            "field_summary_nrmse": float(np.sqrt(summary_errors_a[groups == g].mean())),
        }
        for g in sorted(set(groups))
    }
    per_organ = {
        str(organ): {
            "control_nrmse": float(np.sqrt(code_error[data["organ_names"] == organ].mean()) / 2),
            "field_summary_nrmse": float(
                np.sqrt(summary_errors_a[data["organ_names"] == organ].mean())
            ),
        }
        for organ in sorted(set(data["organ_names"]))
    }
    return {
        "rows": len(predicted),
        "macro_control_nrmse": float(np.mean([v["control_nrmse"] for v in per_group.values()])),
        "macro_field_summary_nrmse": float(
            np.mean([v["field_summary_nrmse"] for v in per_group.values()])
        ),
        "condition_rmse_original_units": dict(
            zip(
                dataset.CONDITION_NAMES,
                np.sqrt(summary_errors_a.mean(axis=0)) * model["condition_scale"],
                strict=True,
            )
        ),
        "field_mae_rmse": dict(
            zip(
                ("rgb_linear_mae", "roughness_mae", "height_mm_rmse", "gradient_rmse"),
                field_errors_a.mean(axis=0),
                strict=True,
            )
        ),
        "per_group": per_group,
        "per_organ": per_organ,
        "scope": "Reconstruction of procedural material fields, not comparison with tissue photographs",
    }


def load_anchors(data: Path) -> dict[str, FloatArray]:
    with np.load(data / "surface_anchors.npz", allow_pickle=False) as archive:
        return {
            str(tid): np.asarray(points, dtype=np.float64)
            for tid, points in zip(archive["template_ids"], archive["points_mm"], strict=True)
        }


def _save_checkpoint(path: Path, value: dict[str, Any]) -> None:
    tmp = path.with_suffix(".tmp")
    torch.save(value, tmp)
    tmp.replace(path)
    write_json(path.with_suffix(".sha256.json"), {"sha256": digest(path)})


def _load_checkpoint(path: Path) -> dict[str, Any]:
    if json.loads(path.with_suffix(".sha256.json").read_text())["sha256"] != digest(path):
        raise ValueError("Material checkpoint integrity mismatch")
    value: dict[str, Any] = torch.load(path, weights_only=True, map_location="cpu")
    if value.get("format") != FORMAT:
        raise ValueError("Wrong material checkpoint format")
    return value


def train(
    data: Path,
    out: Path,
    cfg: Config = Config(),
    *,
    resume: bool = False,
    stop_after: int | None = None,
) -> dict[str, Any]:
    if (
        min(cfg.steps, cfg.width, cfg.batch_size, cfg.checkpoint_every) < 1
        or cfg.ridge <= 0
        or cfg.lr <= 0
        or not np.isfinite([cfg.ridge, cfg.lr]).all()
    ):
        raise ValueError("Invalid material training configuration")
    training, validation = dataset.read_split(data, "train"), dataset.read_split(data, "val")
    ensure_groups(training, validation)
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed)
    model = fit_baselines(training, cfg)
    x = torch.tensor(
        features(model, training["conditions"], group_names(training)), dtype=torch.float32
    )
    y = torch.tensor(training["controls"], dtype=torch.float32)
    network = Prior(x.shape[1], cfg.width)
    optimizer = torch.optim.AdamW(network.parameters(), lr=cfg.lr, weight_decay=0.001)
    groups = group_names(training)
    group_rows = [np.flatnonzero(groups == name) for name in model["group_names"]]
    identity = {
        "format": FORMAT,
        "source_sha256": digest(Path(__file__)),
        "dataset_release_sha256": digest(data / "release.json"),
        "config": asdict(cfg),
        "torch": str(torch.__version__),
        "numpy": np.__version__,
        "device": "cpu",
        "python": platform.python_version(),
        "platform": platform.platform(),
        "threads": torch.get_num_threads(),
        "dataset_code_hashes": dataset.code_hashes(),
    }
    out.mkdir(parents=True, exist_ok=True)
    if (out / "checkpoint.pt").exists() and not resume:
        raise ValueError("Choose a fresh output directory or resume the identical run")
    step, losses = 0, []
    if resume:
        state = _load_checkpoint(out / "checkpoint.pt")
        if state["identity"] != identity:
            raise ValueError("Material resume identity changed")
        network.load_state_dict(state["network"])
        optimizer.load_state_dict(state["optimizer"])
        torch.set_rng_state(state["torch_rng"])
        rng.bit_generator.state = json.loads(state["numpy_rng_json"])
        step, losses = state["step"], state["losses"]
    for step in range(step + 1, cfg.steps + 1):
        selected_groups = rng.integers(0, len(group_rows), cfg.batch_size)
        ids = [int(rng.choice(group_rows[g])) for g in selected_groups]
        mean, logstd = network(x[ids])
        loss = (((y[ids] - mean) / logstd.exp()) ** 2 / 2 + logstd).mean()
        if not torch.isfinite(loss):
            raise ValueError("Nonfinite material loss")
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(network.parameters(), 1.0)
        optimizer.step()
        losses.append(float(loss.detach()))
        if step % cfg.checkpoint_every == 0 or step == cfg.steps or step == stop_after:
            _save_checkpoint(
                out / "checkpoint.pt",
                {
                    "format": FORMAT,
                    "identity": identity,
                    "network": network.state_dict(),
                    "optimizer": optimizer.state_dict(),
                    "torch_rng": torch.get_rng_state(),
                    "numpy_rng_json": json.dumps(rng.bit_generator.state),
                    "step": step,
                    "losses": losses,
                },
            )
        if step == stop_after and step < cfg.steps:
            return {"status": "interrupted", "step": step}
    model.update(
        {
            f"nn_{key}": value.detach().numpy().astype(np.float64)
            for key, value in network.state_dict().items()
        }
    )
    anchors = load_anchors(data)
    metrics = {
        method: measured_metrics(model, validation, predict(model, validation, method), anchors)
        for method in ("mean", "nearest", "ridge", "mlp")
    }
    baseline = min(
        ("mean", "nearest", "ridge"), key=lambda name: metrics[name]["macro_field_summary_nrmse"]
    )
    improves = (
        metrics["mlp"]["macro_field_summary_nrmse"]
        <= metrics[baseline]["macro_field_summary_nrmse"] * 0.98
    )
    slices_pass = all(
        metrics["mlp"]["per_organ"][organ]["field_summary_nrmse"]
        <= max(value["field_summary_nrmse"] * 1.1, 1e-8)
        for organ, value in metrics[baseline]["per_organ"].items()
    )
    model["selected"] = np.asarray("mlp" if improves and slices_pass else baseline)
    report = {
        "status": "trained_synthetic_material_prior",
        "identity": identity,
        "steps": step,
        "selected": str(model["selected"]),
        "selection": {
            "metric": "macro organ/preset actual-field summary RMSE normalized by train standard deviation",
            "neural_improves_2_percent": improves,
            "no_organ_regresses_over_10_percent": slices_pass,
        },
        "validation": metrics,
        "audit_opened": False,
        "losses": losses,
        "training_rows": len(training["controls"]),
        "validation_rows": len(validation["controls"]),
        "geometry_modified": False,
        "optical_calibration": "NOT_RUN",
        "tissue_photograph_supervision": "NONE",
    }
    model_path = out / "model.npz"
    np.savez_compressed(model_path, **model)
    write_json(
        out / "model.json",
        {
            "format": FORMAT,
            "identity": identity,
            "model_sha256": digest(model_path),
            "selected": str(model["selected"]),
            "controls": list(dataset.CONTROL_NAMES),
            "conditions": list(dataset.CONDITION_NAMES),
            "scope": "Authored procedural appearance design-space prior; never empirical anatomy or tissue frequency",
        },
    )
    write_json(out / "training_report.json", report)
    return report


def load_model(path: Path) -> dict[str, Any]:
    meta = json.loads(path.with_suffix(".json").read_text())
    if meta.get("format") != FORMAT or meta.get("model_sha256") != digest(path):
        raise ValueError("Material model integrity or format mismatch")
    if (
        meta["identity"]["source_sha256"] != digest(Path(__file__))
        or meta["identity"]["dataset_code_hashes"] != dataset.code_hashes()
    ):
        raise ValueError("Material model/decoder source drift")
    if meta["controls"] != list(dataset.CONTROL_NAMES) or meta["conditions"] != list(
        dataset.CONDITION_NAMES
    ):
        raise ValueError("Material model feature schema mismatch")
    with np.load(path, allow_pickle=False) as archive:
        model = {key: archive[key] for key in archive.files}
    if (
        not np.isfinite(model["train_controls"]).all()
        or np.any(np.abs(model["train_controls"]) > 1)
        or model["train_controls"].shape[1] != 6
    ):
        raise ValueError("Invalid stored material controls")
    n, width, count = (
        len(model["train_controls"]),
        meta["identity"]["config"]["width"],
        len(model["group_names"]),
    )
    shapes = {
        "train_groups": (n,),
        "train_conditions": (n, 8),
        "condition_mean": (8,),
        "condition_scale": (8,),
        "ridge_coef": (count + 8, 6),
        "group_means": (count, 6),
        "ridge_residuals": (n, 6),
        "nearest_residuals": (n, 6),
        "mean_residuals": (n, 6),
        "nn_layers.0.weight": (width, count + 8),
        "nn_layers.0.bias": (width,),
        "nn_layers.2.weight": (width, width),
        "nn_layers.2.bias": (width,),
        "nn_layers.4.weight": (12, width),
        "nn_layers.4.bias": (12,),
    }
    if any(key not in model or model[key].shape != shape for key, shape in shapes.items()):
        raise ValueError("Material model array schema mismatch")
    if any(not np.isfinite(value).all() for value in model.values() if value.dtype.kind in "fiu"):
        raise ValueError("Nonfinite material model parameters")
    if (
        (model["condition_scale"] <= 0).any()
        or len(set(model["group_names"])) != count
        or not set(model["train_groups"]).issubset(set(model["group_names"]))
    ):
        raise ValueError("Invalid material preprocessing/groups")
    if str(model["selected"]) != meta["selected"] or meta["selected"] not in {
        "mean",
        "nearest",
        "ridge",
        "mlp",
    }:
        raise ValueError("Material model selection mismatch")
    model["metadata"] = meta
    return model


def sample_recipe(
    model: dict[str, Any],
    organ: str,
    preset: str,
    seed: int,
    conditions: dict[str, float] | None = None,
) -> dict[str, Any]:
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Material sampling seed must be uint32")
    group = f"{organ}|{preset}"
    if group not in model["group_names"]:
        raise ValueError("Unsupported material organ/preset")
    ids = np.flatnonzero(model["train_groups"] == group)
    rng = np.random.default_rng(seed)
    if conditions:
        if set(conditions) - set(dataset.CONDITION_NAMES):
            raise ValueError("Unknown material field condition")
        target = model["train_conditions"][ids].mean(axis=0)
        for name, value in conditions.items():
            index = dataset.CONDITION_NAMES.index(name)
            values = model["train_conditions"][ids, index]
            if (
                isinstance(value, bool)
                or not np.isfinite(value)
                or not values.min() <= value <= values.max()
            ):
                raise ValueError(
                    f"Material condition {name} lies outside observed training support"
                )
            target[index] = value
        data = {
            "organ_names": np.asarray([organ]),
            "presets": np.asarray([preset]),
            "conditions": target[None, :],
        }
        mean = predict(model, data)[0]
        for _ in range(10000):
            if str(model["selected"]) == "mlp":
                _, logstd = mlp_numpy(model, features(model, target[None, :], [group]))
                controls = mean + rng.normal(size=6) * np.exp(logstd[0])
            else:
                controls = mean + model[f"{str(model['selected'])}_residuals"][rng.choice(ids)]
            if (np.abs(controls) <= 1).all():
                break
        else:
            raise ValueError("Could not sample a bounded material proposal")
        sampling = "conditional_control_proposal; requested field statistics require independent measurement"
    else:
        controls = model["train_controls"][rng.choice(ids)].copy()
        sampling = (
            "organ/preset empirical training-control bootstrap with independent spatial field seed"
        )
    recipe = dataset.controls_recipe(organ, preset, seed, controls)
    return {
        "recipe": recipe.model_dump(),
        "normalized_controls": controls.tolist(),
        "sampling": sampling,
        "requested_conditions": conditions or {},
        "geometry_modified": False,
        "material_prior": str(model["selected"]),
        "dataset_release_sha256": model.get("metadata", {})
        .get("identity", {})
        .get("dataset_release_sha256"),
        "empirical_tissue_distribution": False,
    }


def evaluate(
    data: Path, model_path: Path, split: str = "val", *, freeze: Path | None = None
) -> dict[str, Any]:
    if split == "audit":
        if freeze is None or json.loads(freeze.read_text()).get("model_sha256") != digest(
            model_path
        ):
            raise ValueError("Freeze the selected material model before opening audit")
    model = load_model(model_path)
    if model["metadata"]["identity"]["dataset_release_sha256"] != digest(data / "release.json"):
        raise ValueError("Material evaluation release mismatch")
    rows = dataset.read_split(data, split)
    return measured_metrics(model, rows, predict(model, rows), load_anchors(data))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("train", "evaluate", "sample"))
    parser.add_argument("--data", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--steps", type=int, default=2000)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--split", choices=("val", "audit"), default="val")
    parser.add_argument("--freeze", type=Path)
    parser.add_argument("--organ", default="liver")
    parser.add_argument("--preset", default="balanced")
    parser.add_argument("--seed", type=int, default=1944)
    args = parser.parse_args()
    if args.action == "train":
        if args.data is None:
            parser.error("--data is required")
        report = train(args.data, args.out, Config(steps=args.steps), resume=args.resume)
        print(
            json.dumps(
                {
                    k: report[k]
                    for k in ("status", "selected", "training_rows", "validation_rows")
                    if k in report
                }
            )
        )
    elif args.action == "evaluate":
        if args.data is None or args.model is None:
            parser.error("--data and --model are required")
        report = evaluate(args.data, args.model, args.split, freeze=args.freeze)
        write_json(args.out, report)
        print(json.dumps({k: v for k, v in report.items() if k not in ("per_group", "per_organ")}))
    else:
        if args.model is None:
            parser.error("--model is required")
        report = sample_recipe(load_model(args.model), args.organ, args.preset, args.seed)
        write_json(args.out, report)
        print(json.dumps(report))


if __name__ == "__main__":
    main()
