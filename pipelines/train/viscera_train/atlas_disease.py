"""Two disease learning lanes with explicit evidence boundaries.

The recipe CVAE learns a synthetic visual design distribution from the same
sampler used by the editor. The independent clinical case prior learns measured
feature support from licensed source patients. Neither is a clinical simulator.
"""

from __future__ import annotations

import argparse
import json
import platform
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, cast

import numpy as np
from viscera_core import atlas_disease_recipe_dataset as recipes

RECIPE_FORMAT = "viscera-disease-recipe-model-v1"
SOURCE_FORMAT = "viscera-disease-source-prior-v1"
FEATURE_NAMES = recipes.FEATURE_NAMES
digest, write_json = recipes.digest, recipes.write_json


@dataclass(frozen=True)
class Config:
    steps: int = 1600
    batch_size: int = 128
    hidden: int = 96
    latent: int = 8
    embedding: int = 16
    learning_rate: float = 0.001
    beta: float = 0.015
    seed: int = 71026
    threads: int = 1


def _torch_classes() -> tuple[Any, Any]:
    import torch
    from torch import nn

    class RecipeVAE(nn.Module):  # type: ignore[misc]
        def __init__(self, profiles: int, config: Config):
            super().__init__()
            self.latent = config.latent
            self.embedding = nn.Embedding(profiles, config.embedding)
            self.encoder = nn.Sequential(
                nn.Linear(9 + config.embedding, config.hidden),
                nn.SiLU(),
                nn.Linear(config.hidden, config.hidden),
                nn.SiLU(),
                nn.Linear(config.hidden, 2 * config.latent),
            )
            self.decoder = nn.Sequential(
                nn.Linear(config.latent + config.embedding, config.hidden),
                nn.SiLU(),
                nn.Linear(config.hidden, config.hidden),
                nn.SiLU(),
                nn.Linear(config.hidden, 9),
                nn.Sigmoid(),
            )

        def encode(self, x: Any, ids: Any) -> tuple[Any, Any]:
            encoded = self.encoder(torch.cat((x, self.embedding(ids)), dim=1))
            mean, logvar = encoded.chunk(2, dim=1)
            return mean, logvar.clamp(-8, 4)

        def decode(self, z: Any, ids: Any) -> Any:
            return self.decoder(torch.cat((z, self.embedding(ids)), dim=1))

    return torch, RecipeVAE


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return cast(np.ndarray, 1.0 / (1.0 + np.exp(-np.clip(x, -60, 60))))


def decode_latents(model: dict[str, Any], ids: np.ndarray, z: np.ndarray) -> np.ndarray:
    """NumPy deployment of the exact trained decoder; PyTorch is not a server dependency."""
    arrays = model["arrays"]
    x = np.concatenate((z.astype(np.float32), arrays["embedding.weight"][ids]), axis=1)
    for index in (0, 2, 4):
        x = x @ arrays[f"decoder.{index}.weight"].T + arrays[f"decoder.{index}.bias"]
        x = x * _sigmoid(x) if index < 4 else _sigmoid(x)
    return cast(np.ndarray, np.asarray(x, dtype=np.float32))


def _snap_count(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values).copy()
    values[:, 5] = np.rint(values[:, 5] * 7) / 7
    return values


def _recipe_arrays(model: dict[str, Any], profile_id: str) -> np.ndarray:
    if profile_id not in model["profiles"]:
        raise ValueError("Disease profile is not supported by this trained model")
    ids = model["arrays"]["training_profile_ids"]
    return cast(
        np.ndarray, model["arrays"]["training_features"][ids == model["profiles"].index(profile_id)]
    )


def sample_recipes(
    model: dict[str, Any], profile_id: str, seed: int, count: int = 1, method: str | None = None
) -> list[dict[str, Any]]:
    """Sample distinct recipe draws and independent spatial seeds, never clinical grades."""
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**32:
        raise ValueError("Seed must be uint32")
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 4096:
        raise ValueError("Sample count must be an integer in [1,4096]")
    x = _recipe_arrays(model, profile_id)
    rng = np.random.default_rng(seed)
    method = method or model["selected_method"]
    if method == "empirical_bootstrap":
        values = x[rng.integers(len(x), size=count)]
    elif method == "conditional_vae":
        ids: np.ndarray = np.full(count, model["profiles"].index(profile_id), dtype=np.int64)
        z = rng.normal(size=(count, model["config"]["latent"]))
        values = _snap_count(decode_latents(model, ids, z))
        # Neural proposals stay inside the actual training recipe support.
        values = np.clip(values, x.min(0), x.max(0))
        values = _snap_count(values)
    else:
        raise ValueError("Unknown disease recipe model method")
    spatial_seeds = rng.integers(0, 2**32, size=count, dtype=np.uint64)
    return [
        recipes.decode_recipe(profile_id, row, int(spatial_seed))
        for row, spatial_seed in zip(values, spatial_seeds, strict=True)
    ]


def _prior_metrics(
    model: dict[str, Any], data: dict[str, np.ndarray], method: str
) -> dict[str, Any]:
    per_profile: dict[str, Any] = {}
    for profile in model["profiles"]:
        truth = data["features"][data["profile_ids"] == profile]
        if not len(truth):
            continue
        proposals = sample_recipes(model, profile, 3001, max(128, len(truth)), method)
        samples = np.asarray([recipes.encode_recipe(p) for p in proposals])
        observed_std = truth.std(0)
        varying = observed_std > 1e-5
        std_error = (
            float(
                np.mean(
                    np.abs(samples.std(0)[varying] - observed_std[varying]) / observed_std[varying]
                )
            )
            if varying.any()
            else 0.0
        )
        per_profile[profile] = {
            "mean_feature_mae": float(np.abs(samples.mean(0) - truth.mean(0)).mean()),
            "relative_std_error": std_error,
            "unique_control_vectors": len(np.unique(samples, axis=0)),
            "samples": len(samples),
            "validation_recipes": len(truth),
        }
    return {
        "macro_mean_feature_mae": float(
            np.mean([v["mean_feature_mae"] for v in per_profile.values()])
        ),
        "macro_relative_std_error": float(
            np.mean([v["relative_std_error"] for v in per_profile.values()])
        ),
        "min_unique_control_vectors": min(
            v["unique_control_vectors"] for v in per_profile.values()
        ),
        "per_profile": per_profile,
    }


def _save_recipe_model(path: Path, metadata: dict[str, Any], arrays: dict[str, np.ndarray]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    with temp.open("wb") as stream:
        np.savez_compressed(
            stream,
            metadata_json=np.asarray(json.dumps(metadata, allow_nan=False)),
            **cast(Any, arrays),
        )
    temp.replace(path)
    write_json(path.with_suffix(".json"), {**metadata, "artifact_sha256": digest(path)})


def load_recipe_model(path: Path) -> dict[str, Any]:
    path = Path(path)
    manifest = json.loads(path.with_suffix(".json").read_text())
    if manifest.get("format") != RECIPE_FORMAT or manifest.get("artifact_sha256") != digest(path):
        raise ValueError("Disease recipe model checksum or format mismatch")
    with np.load(path, allow_pickle=False) as archive:
        metadata = json.loads(str(archive["metadata_json"].item()))
        arrays = {key: archive[key].copy() for key in archive.files if key != "metadata_json"}
    if metadata != {k: v for k, v in manifest.items() if k != "artifact_sha256"}:
        raise ValueError("Disease recipe model manifest does not match payload")
    profiles = metadata.get("profiles", [])
    if (
        not profiles
        or len(profiles) != len(set(profiles))
        or metadata.get("feature_names") != FEATURE_NAMES
    ):
        raise ValueError("Invalid disease recipe model vocabulary")
    if metadata.get("selected_method") not in ("empirical_bootstrap", "conditional_vae"):
        raise ValueError("Unsupported disease recipe model method")
    x, ids = arrays["training_features"], arrays["training_profile_ids"]
    if (
        x.ndim != 2
        or x.shape[1] != 9
        or not len(x)
        or not np.isfinite(x).all()
        or np.any((x < 0) | (x > 1))
    ):
        raise ValueError("Malformed disease recipe model training support")
    if (
        ids.shape != (len(x),)
        or ids.dtype.kind not in "iu"
        or np.any(ids < 0)
        or np.any(ids >= len(profiles))
    ):
        raise ValueError("Malformed disease recipe model profile IDs")
    if set(ids.tolist()) != set(range(len(profiles))):
        raise ValueError("A model profile has no training recipes")
    c = metadata["config"]
    expected = {
        "embedding.weight": (len(profiles), c["embedding"]),
        "decoder.0.weight": (c["hidden"], c["latent"] + c["embedding"]),
        "decoder.0.bias": (c["hidden"],),
        "decoder.2.weight": (c["hidden"], c["hidden"]),
        "decoder.2.bias": (c["hidden"],),
        "decoder.4.weight": (9, c["hidden"]),
        "decoder.4.bias": (9,),
    }
    for key, shape in expected.items():
        if arrays[key].shape != shape or not np.isfinite(arrays[key]).all():
            raise ValueError(f"Malformed disease decoder parameter: {key}")
    return {**metadata, "arrays": arrays, "artifact_sha256": digest(path)}


def train_recipe(dataset: Path, out: Path, config: Config = Config()) -> dict[str, Any]:
    """Fit conditional VAE and retain empirical baseline when validation rejects it."""
    if (out / "model.npz").exists():
        raise ValueError("Training output already contains a model; use a new run directory")
    if (
        config.steps < 1
        or config.batch_size < 1
        or config.hidden < 4
        or config.latent < 1
        or config.embedding < 1
    ):
        raise ValueError("Invalid disease training architecture or step count")
    if not 0 <= config.beta <= 1 or not 0 < config.learning_rate < 1 or config.threads < 1:
        raise ValueError("Invalid disease training optimizer configuration")
    dataset, out = Path(dataset), Path(out)
    release = recipes.verify_release(dataset)
    training, validation = recipes.read_split(dataset, "train"), recipes.read_split(dataset, "val")
    recipes.ensure_groups(training, validation)
    torch, RecipeVAE = _torch_classes()
    torch.set_num_threads(config.threads)
    torch.manual_seed(config.seed)
    np_rng = np.random.default_rng(config.seed)
    profiles = sorted(set(training["profile_ids"].tolist()))
    lookup = {p: i for i, p in enumerate(profiles)}
    ids = np.asarray([lookup[p] for p in training["profile_ids"]], dtype=np.int64)
    groups = [np.flatnonzero(ids == i) for i in range(len(profiles))]
    net = RecipeVAE(len(profiles), config)
    optimizer = torch.optim.AdamW(net.parameters(), lr=config.learning_rate, weight_decay=1e-5)
    x_tensor, id_tensor = (
        torch.from_numpy(training["features"].astype(np.float32)),
        torch.from_numpy(ids),
    )
    history = []
    net.train()
    for step in range(config.steps):
        # Every profile receives equal sampling probability even if cohort sizes differ.
        selected = [
            int(np_rng.choice(groups[i]))
            for i in np_rng.integers(len(groups), size=config.batch_size)
        ]
        x, pid = x_tensor[selected], id_tensor[selected]
        mean, logvar = net.encode(x, pid)
        z = mean + torch.randn_like(mean) * torch.exp(logvar * 0.5)
        reconstruction = net.decode(z, pid)
        mse = (reconstruction - x).square().mean()
        kl = (-0.5 * (1 + logvar - mean.square() - logvar.exp())).mean()
        loss = mse + config.beta * kl
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
        optimizer.step()
        if step == 0 or (step + 1) % max(1, config.steps // 20) == 0:
            history.append(
                {
                    "step": step + 1,
                    "loss": float(loss.detach()),
                    "reconstruction_mse": float(mse.detach()),
                    "kl": float(kl.detach()),
                }
            )
    net.eval()
    arrays = {
        key: value.detach().cpu().numpy()
        for key, value in net.state_dict().items()
        if key.startswith("decoder.") or key == "embedding.weight"
    }
    arrays.update(
        training_features=training["features"].astype(np.float32), training_profile_ids=ids
    )
    metadata = {
        "format": RECIPE_FORMAT,
        "feature_names": FEATURE_NAMES,
        "profiles": profiles,
        "profile_organs": {
            p: str(training["organ_names"][training["profile_ids"] == p][0]) for p in profiles
        },
        "config": asdict(config),
        "selected_method": "empirical_bootstrap",
        "scope": "synthetic_visual_recipe_distribution_not_patient_population",
        "patient_count": 0,
        "training_recipe_count": len(ids),
        "source_sha256": release["recipe"]["source_sha256"],
        "catalog_sha256": release["artifact_hashes"]["catalog.json"],
        "dataset_hashes": {
            name: digest(dataset / name) for name in ("release.json", "train.npz", "val.npz")
        },
        "trainer_sha256": digest(Path(__file__)),
        "environment": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "torch": torch.__version__,
        },
        "requires_geometry_validation": True,
    }
    model = {**metadata, "arrays": arrays}
    val_ids = np.asarray([lookup[p] for p in validation["profile_ids"]], dtype=np.int64)
    val_x: np.ndarray = validation["features"].astype(np.float32)
    with torch.inference_mode():
        vmean, _ = net.encode(torch.from_numpy(val_x), torch.from_numpy(val_ids))
        torch_prediction = net.decode(vmean, torch.from_numpy(val_ids)).numpy()
        numpy_prediction = decode_latents(model, val_ids, vmean.numpy())
    parity = float(np.max(np.abs(torch_prediction - numpy_prediction)))
    if parity > 2e-6:
        raise ValueError("Disease training/deployment decoder parity failed")
    means = np.asarray([training["features"][ids == i].mean(0) for i in range(len(profiles))])
    mean_error = float(np.abs(means[val_ids] - val_x).mean())
    neural_error = float(np.abs(_snap_count(torch_prediction) - val_x).mean())
    baseline_metrics = _prior_metrics(model, validation, "empirical_bootstrap")
    neural_metrics = _prior_metrics(model, validation, "conditional_vae")
    # Reconstruction alone is insufficient: reject collapsed or shifted prior samples.
    gates = {
        "reconstruction_improves_mean_5pct": neural_error < mean_error * 0.95,
        "mean_distribution_error_no_worse_than_baseline": neural_metrics["macro_mean_feature_mae"]
        <= max(baseline_metrics["macro_mean_feature_mae"] * 1.15, 0.035),
        "std_distribution_error_under_60pct": neural_metrics["macro_relative_std_error"] <= 0.6,
        "every_profile_diverse": neural_metrics["min_unique_control_vectors"] >= 8,
        "deployment_decoder_parity": parity <= 2e-6,
    }
    if all(gates.values()):
        metadata["selected_method"] = "conditional_vae"
    report = {
        "format": "viscera-disease-recipe-training-report-v1",
        "status": "trained",
        "selected_method": metadata["selected_method"],
        "config": asdict(config),
        "scope": metadata["scope"],
        "patient_count": 0,
        "profiles": len(profiles),
        "validation": {
            "mean_baseline_reconstruction_mae": mean_error,
            "cvae_reconstruction_mae": neural_error,
            "empirical_bootstrap": baseline_metrics,
            "conditional_vae": neural_metrics,
        },
        "selection_gates": gates,
        "deployment_max_absolute_error": parity,
        "training_history": history,
        "audit_opened": False,
        "limitations": release["limitations"],
    }
    _save_recipe_model(out / "model.npz", metadata, arrays)
    write_json(out / "training_report.json", report)
    write_json(
        out / "freeze.json",
        {
            "model_sha256": digest(out / "model.npz"),
            "tuning_closed": True,
            "selected_method": metadata["selected_method"],
        },
    )
    return report


def evaluate_recipe(
    dataset: Path, model_path: Path, split: str = "audit", *, freeze: Path | None = None
) -> dict[str, Any]:
    model = load_recipe_model(model_path)
    if digest(Path(dataset) / "release.json") != model["dataset_hashes"]["release.json"]:
        raise ValueError("Model was trained on a different disease recipe release")
    if split == "audit":
        if freeze is None:
            raise ValueError("Audit requires a frozen model decision")
        frozen = json.loads(Path(freeze).read_text())
        if (
            frozen.get("model_sha256") != digest(model_path)
            or frozen.get("tuning_closed") is not True
        ):
            raise ValueError("Audit freeze does not match model")
    train_data, data = recipes.read_split(dataset, "train"), recipes.read_split(dataset, split)
    if split != "train":
        recipes.ensure_groups(train_data, data)
    if split == "audit":
        recipes.ensure_groups(recipes.read_split(dataset, "val"), data)
    return {
        "split": split,
        "model_sha256": digest(model_path),
        "method": model["selected_method"],
        "scope": model["scope"],
        "patient_count": 0,
        "metrics": _prior_metrics(model, data, model["selected_method"]),
    }


def _source_validate(data: dict[str, np.ndarray]) -> None:
    required = {
        "features",
        "feature_names",
        "case_ids",
        "group_ids",
        "organ_names",
        "disease_codes",
    }
    if not required <= data.keys():
        raise ValueError("Source case arrays are incomplete")
    x = data["features"]
    if (
        x.ndim != 2
        or not len(x)
        or len(data["feature_names"]) != x.shape[1]
        or not np.isfinite(x).all()
    ):
        raise ValueError("Source case features must be a nonempty finite matrix")
    for key in ("case_ids", "group_ids", "organ_names", "disease_codes"):
        if data[key].shape != (len(x),) or data[key].dtype.kind not in "US":
            raise ValueError(f"Source case {key} does not align")
    if len(set(data["case_ids"].tolist())) != len(x) or len(set(data["group_ids"].tolist())) != len(
        x
    ):
        raise ValueError("Source prior requires one independent row per patient")


def _source_group(model: dict[str, Any], organ: str, disease_code: str) -> dict[str, Any]:
    groups = [
        g for g in model["groups"] if g["organ"] == organ and g["disease_code"] == disease_code
    ]
    if len(groups) != 1:
        raise ValueError("No training patients support this organ and disease label")
    return cast(dict[str, Any], groups[0])


def sample_source_cases(
    model: dict[str, Any],
    organ: str,
    disease_code: str,
    *,
    seed: int = 0,
    count: int = 1,
    conditions: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    """Retrieve coherent observed cases; do not hallucinate variance from a singleton."""
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed < 2**32:
        raise ValueError("Seed must be uint32")
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 4096:
        raise ValueError("Count must be within [1,4096]")
    group = _source_group(model, organ, disease_code)
    x = np.asarray(group["features"], dtype=float)
    names = model["feature_names"]
    conditions = conditions or {}
    if set(conditions) - set(names):
        raise ValueError("Unknown measured source condition")
    distances = np.zeros(len(x))
    for name, value in conditions.items():
        j = names.index(name)
        value = float(value)
        tolerance = max(float(np.ptp(x[:, j])) * 1e-6, abs(float(x[0, j])) * 1e-6, 1e-8)
        if (
            not np.isfinite(value)
            or not x[:, j].min() - tolerance <= value <= x[:, j].max() + tolerance
        ):
            raise ValueError(f"Requested {name} lies outside observed training support")
        distances += ((x[:, j] - value) / max(float(np.std(x[:, j])), tolerance)) ** 2
    weights = np.exp(-0.5 * (distances - distances.min()))
    weights /= weights.sum()
    indices = np.random.default_rng(seed).choice(len(x), size=count, p=weights)
    return [
        {
            "case_id": group["case_ids"][int(i)],
            "organ": organ,
            "disease_code": disease_code,
            "measured_features": dict(zip(names, x[int(i)].tolist(), strict=True)),
            "observed_training_patients": group["patient_count"],
            "sampling": "empirical_case_retrieval",
            "requested_conditions": conditions,
            "conditions_are_exactly_matched": all(
                abs(float(x[int(i), names.index(k)]) - float(v)) <= 1e-6
                for k, v in conditions.items()
            ),
        }
        for i in indices
    ]


def _evaluate_source(model: dict[str, Any], data: dict[str, np.ndarray]) -> dict[str, Any]:
    _source_validate(data)
    if data["feature_names"].tolist() != model["feature_names"]:
        raise ValueError("Source prior feature schema mismatch")
    if set(data["group_ids"].tolist()) & set(model["training_group_ids"]):
        raise ValueError("Patient leakage between source training and holdout")
    supported, unsupported, errors = [], [], []
    for i, case in enumerate(data["case_ids"]):
        try:
            group = _source_group(model, str(data["organ_names"][i]), str(data["disease_codes"][i]))
        except ValueError:
            unsupported.append(
                {
                    "case_id": str(case),
                    "disease_code": str(data["disease_codes"][i]),
                    "reason": "no_training_patients_for_this_organ_and_disease",
                }
            )
            continue
        prediction = np.asarray(group["mean_features"])
        error = np.abs(prediction - data["features"][i])
        errors.append(error)
        supported.append(
            {
                "case_id": str(case),
                "training_patients": group["patient_count"],
                "absolute_error": dict(zip(model["feature_names"], error.tolist(), strict=True)),
            }
        )
    return {
        "patients": len(data["features"]),
        "supported_patients": len(supported),
        "unsupported_patients": unsupported,
        "per_patient": supported,
        "feature_mae": dict(
            zip(model["feature_names"], np.asarray(errors).mean(0).tolist(), strict=True)
        )
        if errors
        else None,
        "interpretation": "patient-held-out feature prediction; too few cases for population claims",
    }


def train_source(dataset: Path, out: Path, *, allow_noncommercial: bool = False) -> dict[str, Any]:
    from viscera_core import atlas_disease_dataset as source_data

    dataset, out = Path(dataset), Path(out)
    if (out / "source_model.json").exists():
        raise ValueError("Source prior output exists; use a new run directory")
    release = source_data.verify_release(dataset)
    noncommercial = bool(release["rights"]["contains_noncommercial"])
    if noncommercial and not allow_noncommercial:
        raise ValueError("This source release requires explicit noncommercial opt-in")
    training, validation = (
        source_data.read_split(dataset, "train"),
        source_data.read_split(dataset, "val"),
    )
    _source_validate(training)
    _source_validate(validation)
    groups = []
    for organ, disease in sorted(
        set(zip(training["organ_names"], training["disease_codes"], strict=True))
    ):
        mask = (training["organ_names"] == organ) & (training["disease_codes"] == disease)
        x = training["features"][mask]
        groups.append(
            {
                "organ": str(organ),
                "disease_code": str(disease),
                "patient_count": len(x),
                "case_ids": training["case_ids"][mask].tolist(),
                "features": x.tolist(),
                "mean_features": x.mean(0).tolist(),
                "feature_min": x.min(0).tolist(),
                "feature_max": x.max(0).tolist(),
                "empirical_covariance": np.cov(x.T, ddof=1).tolist()
                if len(x) > 1
                else np.zeros((x.shape[1], x.shape[1])).tolist(),
                "variance_identifiable": len(x) > 1,
            }
        )
    model = {
        "format": SOURCE_FORMAT,
        "method": "conditional_empirical_case_prior",
        "feature_names": training["feature_names"].tolist(),
        "groups": groups,
        "training_group_ids": training["group_ids"].tolist(),
        "training_case_ids": training["case_ids"].tolist(),
        "patient_count": len(training["features"]),
        "rights": release["rights"],
        "dataset_hashes": {
            name: digest(dataset / name) for name in ("release.json", "train.npz", "val.npz")
        },
        "scope": "measured_source_case_retrieval_not_a_population_generator",
        "singleton_policy": "zero learned covariance; no added patient variation",
        "trainer_sha256": digest(Path(__file__)),
    }
    metrics = _evaluate_source(model, validation)
    write_json(out / "source_model.json", model)
    write_json(out / "source_model.json.sha256.json", {"sha256": digest(out / "source_model.json")})
    report = {
        "format": "viscera-disease-source-prior-report-v1",
        "status": "trained",
        "training_patients": model["patient_count"],
        "validation": metrics,
        "scope": model["scope"],
        "rights": release["rights"],
        "audit_opened": False,
        "limitations": [
            "No paired healthy source anatomy is available.",
            "Singleton classes cannot estimate disease population variability.",
            "Photographs were not treated as measured 3D training labels.",
        ],
    }
    write_json(out / "training_report.json", report)
    write_json(
        out / "freeze.json",
        {"model_sha256": digest(out / "source_model.json"), "tuning_closed": True},
    )
    return report


def load_source_model(path: Path, *, allow_noncommercial: bool = False) -> dict[str, Any]:
    path = Path(path)
    expected = json.loads(path.with_suffix(path.suffix + ".sha256.json").read_text())
    if expected.get("sha256") != digest(path):
        raise ValueError("Source prior checksum mismatch")
    model = json.loads(path.read_text())
    if model.get("format") != SOURCE_FORMAT:
        raise ValueError("Unsupported source prior format")
    if model["rights"]["contains_noncommercial"] and not allow_noncommercial:
        raise ValueError("Source prior requires explicit noncommercial opt-in")
    for group in model["groups"]:
        features = np.asarray(group["features"], dtype=float)
        if (
            features.shape != (group["patient_count"], len(model["feature_names"]))
            or not np.isfinite(features).all()
        ):
            raise ValueError("Malformed source prior feature matrix")
        if len(group["case_ids"]) != group["patient_count"]:
            raise ValueError("Source prior case IDs do not align")
    return cast(dict[str, Any], model)


def evaluate_source(
    dataset: Path,
    model_path: Path,
    split: str = "audit",
    *,
    freeze: Path | None = None,
    allow_noncommercial: bool = False,
) -> dict[str, Any]:
    from viscera_core import atlas_disease_dataset as source_data

    model = load_source_model(model_path, allow_noncommercial=allow_noncommercial)
    if digest(Path(dataset) / "release.json") != model["dataset_hashes"]["release.json"]:
        raise ValueError("Source prior was trained on a different release")
    if split == "audit":
        if freeze is None:
            raise ValueError("Source audit requires a frozen model")
        frozen = json.loads(Path(freeze).read_text())
        if (
            frozen.get("model_sha256") != digest(model_path)
            or frozen.get("tuning_closed") is not True
        ):
            raise ValueError("Source audit freeze mismatch")
    data = source_data.read_split(dataset, split)
    if split == "audit":
        validation = source_data.read_split(dataset, "val")
        if set(data["group_ids"].tolist()) & set(validation["group_ids"].tolist()):
            raise ValueError("Patient leakage between source validation and audit")
    return {
        "split": split,
        "model_sha256": digest(model_path),
        "scope": model["scope"],
        "metrics": _evaluate_source(model, data),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-recipes")
    build.add_argument("--out", type=Path, required=True)
    build.add_argument("--seed", type=int, default=7102026)
    train = commands.add_parser("train-recipes")
    train.add_argument("--dataset", type=Path, required=True)
    train.add_argument("--out", type=Path, required=True)
    train.add_argument("--steps", type=int, default=Config.steps)
    train.add_argument("--seed", type=int, default=Config.seed)
    source = commands.add_parser("train-source")
    source.add_argument("--dataset", type=Path, required=True)
    source.add_argument("--out", type=Path, required=True)
    source.add_argument("--allow-noncommercial", action="store_true")
    args = parser.parse_args()
    if args.command == "build-recipes":
        result = recipes.build_release(args.out, seed=args.seed)
    elif args.command == "train-recipes":
        result = train_recipe(args.dataset, args.out, Config(steps=args.steps, seed=args.seed))
    else:
        result = train_source(args.dataset, args.out, allow_noncommercial=args.allow_noncommercial)
    print(
        json.dumps(
            {
                key: value
                for key, value in result.items()
                if key not in ("training_history", "validation", "artifact_hashes")
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
