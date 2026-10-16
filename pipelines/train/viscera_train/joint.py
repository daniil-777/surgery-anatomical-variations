"""Train an actual joint conditional VAE on paired rendered organ observations.

An observation surrogate is fitted only to training rows and frozen before VAE
training. Its gradients connect mesh/colour reconstruction to the editor-control
heads. Held-out render-space errors disclose the surrogate's approximation.
"""

from __future__ import annotations

import argparse
import copy
import json
import platform
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
from viscera_core import atlas_joint as joint
from viscera_core.atlas_disease_recipe_dataset import write_json


@dataclass(frozen=True)
class Config:
    steps: int = 4000
    surrogate_steps: int = 1400
    batch_size: int = 128
    hidden: int = 256
    latent: int = 24
    embedding: int = 32
    learning_rate: float = 0.0007
    beta: float = 0.01
    free_bits: float = 0.03
    prior_weight: float = 3.0
    seed: int = 7102026
    threads: int = 2
    device: str = "auto"
    profile: str = "full"


def torch_classes() -> tuple[Any, Any, Any]:
    import torch
    from torch import nn

    class JointVAE(nn.Module):
        def __init__(self, conditions: int, observation_dim: int, config: Config):
            super().__init__()
            h, z, e = config.hidden, config.latent, config.embedding
            self.embedding = nn.Embedding(conditions, e)
            self.prior_mean = nn.Embedding(conditions, z)
            self.prior_logvar = nn.Embedding(conditions, z)
            nn.init.zeros_(self.prior_mean.weight)
            nn.init.zeros_(self.prior_logvar.weight)
            self.encoder = nn.Sequential(
                nn.Linear(22 + observation_dim + e, h),
                nn.SiLU(),
                nn.Linear(h, h),
                nn.SiLU(),
                nn.Linear(h, 2 * z),
            )
            self.decoder = nn.Sequential(nn.Linear(z + e, h), nn.SiLU(), nn.Linear(h, h), nn.SiLU())
            self.shape_head = nn.Linear(h, 7)
            self.material_head = nn.Linear(h, 6)
            self.disease_head = nn.Linear(h, 9)
            self.observation_head = nn.Linear(h, observation_dim)

        def encode(self, x: Any, y: Any, ids: Any) -> tuple[Any, Any]:
            mean, logvar = self.encoder(torch.cat((x, y, self.embedding(ids)), 1)).chunk(2, 1)
            return mean, logvar.clamp(-8, 4)

        def prior(self, ids: Any) -> tuple[Any, Any]:
            return self.prior_mean(ids), self.prior_logvar(ids).clamp(-8, 4)

        def decode(self, z: Any, ids: Any) -> tuple[Any, Any]:
            h = self.decoder(torch.cat((z, self.embedding(ids)), 1))
            x = torch.cat(
                [
                    torch.tanh(head(h))
                    for head in (self.shape_head, self.material_head, self.disease_head)
                ],
                1,
            )
            return x, self.observation_head(h)

    class ObservationSurrogate(nn.Module):
        def __init__(self, conditions: int, observation_dim: int, config: Config):
            super().__init__()
            self.embedding = nn.Embedding(conditions, config.embedding)
            self.net = nn.Sequential(
                nn.Linear(22 + config.embedding, config.hidden),
                nn.SiLU(),
                nn.Linear(config.hidden, config.hidden),
                nn.SiLU(),
                nn.Linear(config.hidden, observation_dim),
            )

        def forward(self, x: Any, ids: Any) -> Any:
            return self.net(torch.cat((x, self.embedding(ids)), 1))

    return torch, JointVAE, ObservationSurrogate


def load_datasets(datasets: list[Path]) -> tuple[dict[str, Any], dict[str, dict[str, np.ndarray]]]:
    if not datasets:
        raise ValueError("At least one joint dataset is required")
    conditions: list[dict[str, Any]] = []
    parts: dict[str, list[dict[str, np.ndarray]]] = {s: [] for s in ("train", "val", "audit")}
    provenance: dict[str, Any] = {
        "dataset_hashes": {},
        "renderer_hashes": {},
        "template_hashes": {},
        "template_metadata_hashes": {},
    }
    seen_groups: dict[str, set[str]] = {s: set() for s in parts}
    for directory in map(Path, datasets):
        release = joint.verify_release(directory)
        catalog = json.loads((directory / "catalog.json").read_text())
        if catalog.get("control_names") != list(joint.CONTROL_NAMES) or catalog.get(
            "observation_names"
        ) != list(joint.OBSERVATION_NAMES):
            raise ValueError("Joint dataset feature/observation schema mismatch")
        local = catalog["conditions"]
        joint.validate_conditions(local)
        lane = "baseline" if all(c["profile_id"] == "baseline" for c in local) else "disease"
        if lane + "/release.json" in provenance["dataset_hashes"]:
            raise ValueError("Repeated joint dataset lane")
        provenance["dataset_hashes"][lane + "/release.json"] = joint.digest(
            directory / "release.json"
        )
        for key in ("renderer_hashes", "template_hashes", "template_metadata_hashes"):
            hashes = release.get(key, catalog.get(key, {}))
            if not hashes:
                raise ValueError("Joint release is missing " + key)
            for name, sha in hashes.items():
                if name in provenance[key] and provenance[key][name] != sha:
                    raise ValueError("Dataset provenance disagreement: " + name)
                provenance[key][name] = sha
        mapping = []
        for condition in local:
            if joint.condition_key(condition) in list(map(joint.condition_key, conditions)):
                raise ValueError("Joint dataset conditions overlap")
            mapping.append(len(conditions))
            conditions.append(condition)
        for split in parts:
            data = joint.read_split(directory, split)
            seen_groups[split].update(data["group_ids"].tolist())
            data["condition_ids"] = np.asarray(mapping, dtype=np.int64)[data["condition_ids"]]
            parts[split].append(data)
    if set(provenance["renderer_hashes"]) != set(joint.RENDERER_PATHS):
        raise ValueError("Joint dataset must cover every renderer source hash")
    for a, b in (("train", "val"), ("train", "audit"), ("val", "audit")):
        if seen_groups[a] & seen_groups[b]:
            raise ValueError("Joint family/group split leakage")
    merged = {}
    obs_shape = None
    for split, arrays in parts.items():
        merged[split] = {
            name: np.concatenate([a[name] for a in arrays], axis=0)
            for name in (
                "controls",
                "observations",
                "condition_ids",
                "sample_ids",
                "group_ids",
                "seeds",
            )
        }
        joint.validate_split(merged[split], conditions)
        if set(merged[split]["condition_ids"].tolist()) != set(range(len(conditions))):
            raise ValueError("Every split needs every modeled condition")
        shape = merged[split]["observations"].shape[1:]
        if obs_shape is not None and shape != obs_shape:
            raise ValueError("Joint observations differ in anchor count")
        obs_shape = shape
    for a, b in (("train", "val"), ("train", "audit"), ("val", "audit")):
        if set(merged[a]["sample_ids"]) & set(merged[b]["sample_ids"]):
            raise ValueError("Joint sample split leakage")
    provenance["conditions"] = conditions
    provenance["observation_shape"] = list(obs_shape or ())
    return provenance, merged


def _distribution_metrics(samples: np.ndarray, truth: np.ndarray) -> dict[str, float]:
    varying = truth.std(0) > 1e-4
    if not varying.any():
        return {
            "mean_mae": 0.0,
            "relative_std_error": 0.0,
            "covariance_mae": 0.0,
            "unique_fraction": float(len(np.unique(samples, axis=0)) / len(samples)),
        }
    a, b = samples[:, varying], truth[:, varying]
    return {
        "mean_mae": float(np.abs(a.mean(0) - b.mean(0)).mean()),
        "relative_std_error": float((np.abs(a.std(0) - b.std(0)) / (b.std(0) + 1e-4)).mean()),
        "covariance_mae": float(np.abs(np.cov(a, rowvar=False) - np.cov(b, rowvar=False)).mean()),
        "unique_fraction": float(len(np.unique(samples, axis=0)) / len(samples)),
    }


def train(datasets: list[Path], out: Path, config: Config = Config()) -> dict[str, Any]:
    if config.steps < 1 or config.surrogate_steps < 1 or config.batch_size < 8:
        raise ValueError("Training requires positive steps and batch size >= 8")
    if (
        not 1 <= config.latent <= 256
        or not 16 <= config.hidden <= 2048
        or not 1 <= config.embedding <= 256
    ):
        raise ValueError("Unsupported joint architecture dimensions")
    if (
        not 0 <= config.beta <= 1
        or not 0 <= config.free_bits <= 2
        or not 0 < config.learning_rate < 0.1
        or config.threads < 1
        or not 0 <= config.prior_weight <= 20
    ):
        raise ValueError("Invalid optimizer configuration")
    if config.profile not in ("smoke", "full"):
        raise ValueError("Profile must be smoke or full")
    if config.profile == "full" and (config.steps < 1000 or config.surrogate_steps < 200):
        raise ValueError("Full profile requires >=1000 VAE and >=200 surrogate steps")
    out = Path(out)
    if (out / "model.npz").exists():
        raise ValueError("Refusing to overwrite an existing joint model")
    provenance, data = load_datasets(datasets)
    torch, VAE, Surrogate = torch_classes()
    torch.set_num_threads(config.threads)
    torch.manual_seed(config.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(config.seed)
    device = (
        "cuda"
        if config.device == "auto" and torch.cuda.is_available()
        else "cpu"
        if config.device == "auto"
        else config.device
    )
    if device not in ("cpu", "cuda") or (device == "cuda" and not torch.cuda.is_available()):
        raise ValueError("Requested training device is unavailable")
    rng = np.random.default_rng(config.seed)
    k = len(provenance["conditions"])
    x = data["train"]["controls"].astype(np.float32)
    ids = data["train"]["condition_ids"]
    obs = data["train"]["observations"].reshape(len(x), -1).astype(np.float32)
    d = obs.shape[1]
    obs_mean = np.stack([obs[ids == i].mean(0) for i in range(k)])
    obs_scale = np.maximum((obs - obs_mean[ids]).std(0), 0.005).astype(np.float32)
    masks = np.ones((k, 22), dtype=np.float32)
    for i, c in enumerate(provenance["conditions"]):
        if c["profile_id"] == "baseline":
            masks[i, 13:] = 0
    groups = [np.flatnonzero(ids == i) for i in range(k)]
    control_min = np.stack([x[g].min(0) for g in groups])
    control_max = np.stack([x[g].max(0) for g in groups])
    tensors = {}
    for split, arrays in data.items():
        y = arrays["observations"].reshape(len(arrays["controls"]), -1)
        cid = arrays["condition_ids"]
        tensors[split] = (
            torch.as_tensor(arrays["controls"], dtype=torch.float32, device=device),
            torch.as_tensor((y - obs_mean[cid]) / obs_scale, dtype=torch.float32, device=device),
            torch.as_tensor(cid, dtype=torch.long, device=device),
        )
    mask_t = torch.as_tensor(masks, device=device)
    net = VAE(k, d, config).to(device)
    surrogate = Surrogate(k, d, config).to(device)
    tx, ty, ti = tensors["train"]

    def batch() -> Any:
        # Each selected condition supplies a contiguous block for covariance supervision.
        per = min(16, config.batch_size)
        chosen = rng.integers(k, size=max(1, config.batch_size // per))
        return torch.as_tensor(
            np.concatenate([rng.choice(groups[i], per, replace=True) for i in chosen]),
            device=device,
        )

    def observation_loss(pred: Any, target: Any) -> Any:
        delta = (pred - target).reshape(-1, provenance["observation_shape"][0], 7)
        return (
            delta[:, :, :3].square().mean()
            + delta[:, :, 3:6].square().mean()
            + 0.25 * delta[:, :, 6].square().mean()
        )

    @torch.no_grad()
    def surrogate_score(split: str) -> float:
        vx, vy, vi = tensors[split]
        total = 0.0
        for start in range(0, len(vx), 256):
            sl = slice(start, start + 256)
            total += float(observation_loss(surrogate(vx[sl], vi[sl]), vy[sl])) * len(vx[sl])
        return total / len(vx)

    optimizer = torch.optim.AdamW(
        surrogate.parameters(), lr=config.learning_rate, weight_decay=1e-5
    )
    best_surrogate, best_score = None, float("inf")
    history = []
    interval = max(1, min(200, config.surrogate_steps // 5))
    for step in range(1, config.surrogate_steps + 1):
        ix = batch()
        loss = observation_loss(surrogate(tx[ix], ti[ix]), ty[ix])
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(surrogate.parameters(), 5)
        optimizer.step()
        if step % interval == 0 or step == config.surrogate_steps:
            score = surrogate_score("val")
            history.append(
                {"phase": "surrogate", "step": step, "loss": float(loss.detach()), "val": score}
            )
            print(json.dumps(history[-1]), flush=True)
            if score < best_score:
                best_score, best_surrogate = score, copy.deepcopy(surrogate.state_dict())
    surrogate.load_state_dict(best_surrogate)
    surrogate.eval()
    for parameter in surrogate.parameters():
        parameter.requires_grad_(False)
    optimizer = torch.optim.AdamW(net.parameters(), lr=config.learning_rate, weight_decay=1e-5)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, config.steps, eta_min=config.learning_rate * 0.15
    )

    def control_loss(pred: Any, target: Any, cid: Any) -> Any:
        error = (pred - target).square() * mask_t[cid]
        return (
            error[:, :7].mean()
            + error[:, 7:13].mean()
            + error[:, 13:].sum() / mask_t[cid, 13:].sum().clamp_min(1)
        )

    def prior_moments(pred: Any, target: Any, cid: Any) -> Any:
        result = pred.sum() * 0
        for c in cid.unique():
            p, t = pred[cid == c] * mask_t[c], target[cid == c] * mask_t[c]
            if len(p) < 2:
                continue
            pm, tm = p.mean(0), t.mean(0)
            ps, ts = p.std(0, correction=0), t.std(0, correction=0)
            pc, tc = p - pm, t - tm
            result = (
                result
                + (pm - tm).square().mean()
                + (ps - ts).square().mean()
                + (pc.T @ pc / len(p) - tc.T @ tc / len(t)).square().mean()
            )
        return result / max(1, len(cid.unique()))

    @torch.no_grad()
    def deployment() -> dict[str, Any]:
        weights = {
            name: tensor.detach().cpu().numpy().copy()
            for name, tensor in net.state_dict().items()
            if name.startswith(
                (
                    "embedding.",
                    "prior_mean.",
                    "prior_logvar.",
                    "decoder.",
                    "shape_head.",
                    "material_head.",
                    "disease_head.",
                )
            )
        }
        weights.update(control_min=control_min, control_max=control_max)
        return {"arrays": weights, "config": asdict(config), "conditions": provenance["conditions"]}

    def prior_report(split: str) -> dict[str, Any]:
        model = deployment()
        arrays = model["arrays"]
        per_condition = {}
        erng = np.random.default_rng(90417)
        for i, c in enumerate(provenance["conditions"]):
            truth = data[split]["controls"][data[split]["condition_ids"] == i]
            train_controls = x[ids == i]
            z = arrays["prior_mean.weight"][i] + np.exp(
                np.clip(arrays["prior_logvar.weight"][i], -8, 4) / 2
            ) * erng.normal(size=(128, config.latent))
            draws = (
                np.clip(
                    joint.decode_latents(model, np.full(128, i), z), control_min[i], control_max[i]
                )
                * masks[i]
            )
            gaussian = (
                np.clip(
                    erng.normal(train_controls.mean(0), train_controls.std(0), size=(128, 22)),
                    control_min[i],
                    control_max[i],
                )
                * masks[i]
            )
            mean = np.repeat(train_controls.mean(0)[None], 128, 0)
            item = {
                name: _distribution_metrics(samples, truth)
                for name, samples in (
                    ("joint_vae", draws),
                    ("factorized_control_gaussian", gaussian),
                    ("condition_mean", mean),
                )
            }
            item["joint_vae"]["shape_std_mean"] = float(draws[:, :7].std(0).mean())
            item["joint_vae"]["material_std_mean"] = float(draws[:, 7:13].std(0).mean())
            item["joint_vae"]["disease_std_mean"] = float(draws[:, 13:].std(0).mean())
            per_condition["|".join(joint.condition_key(c))] = item
        return {
            "per_condition": per_condition,
            "macro": {
                method: {
                    key: float(np.mean([v[method][key] for v in per_condition.values()]))
                    for key in (
                        "mean_mae",
                        "relative_std_error",
                        "covariance_mae",
                        "unique_fraction",
                    )
                }
                for method in ("joint_vae", "factorized_control_gaussian", "condition_mean")
            },
        }

    @torch.no_grad()
    def reconstruction(split: str) -> dict[str, float]:
        vx, vy, vi = tensors[split]
        result = np.zeros(7)
        raw_errors, direct_errors, posterior_means = [], [], []
        modality_counts = np.zeros(3)
        for start in range(0, len(vx), 256):
            sl = slice(start, start + 256)
            mean, _ = net.encode(vx[sl], vy[sl], vi[sl])
            decoded, observed = net.decode(mean, vi[sl])
            reconstructed = surrogate(decoded * mask_t[vi[sl]], vi[sl])
            direct = surrogate(vx[sl], vi[sl])
            for modality, (a, b) in enumerate(((0, 7), (7, 13), (13, 22))):
                mask = mask_t[vi[sl], a:b]
                result[modality] += float(((decoded[:, a:b] - vx[sl, a:b]).abs() * mask).sum())
                modality_counts[modality] += float(mask.sum())
            posterior_means.append(mean.cpu().numpy())
            result[3] += float(control_loss(decoded, vx[sl], vi[sl])) * len(vx[sl])
            result[4] += float(observation_loss(observed, vy[sl])) * len(vx[sl])
            result[5] += float(observation_loss(reconstructed, vy[sl])) * len(vx[sl])
            pm, plv = net.prior(vi[sl])
            mu, lv = net.encode(vx[sl], vy[sl], vi[sl])
            result[6] += float(
                (0.5 * (plv - lv + (lv.exp() + (mu - pm).square()) / plv.exp() - 1)).mean()
            ) * len(vx[sl])
            raw_errors.append(
                ((reconstructed - vy[sl]).cpu().numpy() * obs_scale).reshape(
                    -1, *provenance["observation_shape"]
                )
            )
            direct_errors.append(
                ((direct - vy[sl]).cpu().numpy() * obs_scale).reshape(
                    -1, *provenance["observation_shape"]
                )
            )
        result[:3] /= np.maximum(modality_counts, 1)
        result[3:] /= len(vx)
        encoded_means = np.concatenate(posterior_means)
        split_ids = data[split]["condition_ids"]
        within_condition_variance = np.mean(
            [encoded_means[split_ids == i].var(0) for i in range(k)], axis=0
        )
        errors, direct = np.concatenate(raw_errors), np.concatenate(direct_errors)
        return {
            **dict(
                zip(
                    (
                        "shape_control_mae",
                        "material_control_mae",
                        "disease_control_mae",
                        "control_loss",
                        "observation_head_loss",
                        "render_surrogate_consistency_loss",
                        "kl_per_latent",
                    ),
                    map(float, result),
                    strict=True,
                )
            ),
            "active_latents_within_condition": int(
                np.count_nonzero(within_condition_variance > 0.01)
            ),
            "geometry_normalized_rmse": float(np.sqrt(np.mean(errors[:, :, :3] ** 2))),
            "colour_linear_rgb_rmse": float(np.sqrt(np.mean(errors[:, :, 3:6] ** 2))),
            "roughness_rmse": float(np.sqrt(np.mean(errors[:, :, 6] ** 2))),
            "surrogate_geometry_normalized_rmse": float(np.sqrt(np.mean(direct[:, :, :3] ** 2))),
            "surrogate_colour_linear_rgb_rmse": float(np.sqrt(np.mean(direct[:, :, 3:6] ** 2))),
        }

    best_net, best_val, best_step = None, float("inf"), 0
    interval = max(1, min(250, config.steps // 5))
    for step in range(1, config.steps + 1):
        ix = batch()
        bx, by, bi = tx[ix], ty[ix], ti[ix]
        mu, lv = net.encode(bx, by, bi)
        z = mu + torch.exp(lv / 2) * torch.randn_like(mu)
        decoded, observed = net.decode(z, bi)
        masked = decoded * mask_t[bi]
        pm, plv = net.prior(bi)
        kl = 0.5 * (plv - lv + (lv.exp() + (mu - pm).square()) / plv.exp() - 1)
        beta = config.beta * min(1.0, step / max(1, config.steps * 0.35))
        prior_draw, _ = net.decode(pm + torch.exp(plv / 2) * torch.randn_like(pm), bi)
        loss = (
            control_loss(decoded, bx, bi)
            + 0.15 * observation_loss(observed, by)
            + 0.3 * observation_loss(surrogate(masked, bi), by)
            + beta * kl.clamp_min(config.free_bits).sum(1).mean()
            + config.prior_weight * prior_moments(prior_draw, bx, bi)
        )
        if not torch.isfinite(loss):
            raise RuntimeError("Joint training loss became nonfinite")
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 5)
        optimizer.step()
        scheduler.step()
        with torch.no_grad():
            net.prior_logvar.weight.clamp_(-8, 4)
        if step % interval == 0 or step == config.steps:
            rec = reconstruction("val")
            metrics = prior_report("val")["macro"]["joint_vae"]
            score = (
                rec["control_loss"]
                + 0.15 * rec["render_surrogate_consistency_loss"]
                + 0.3 * metrics["relative_std_error"]
                + metrics["mean_mae"]
                + metrics["covariance_mae"]
            )
            history.append(
                {
                    "phase": "vae",
                    "step": step,
                    "loss": float(loss.detach()),
                    "beta": beta,
                    "validation_score": score,
                    "validation_reconstruction": rec,
                    "validation_prior": metrics,
                }
            )
            print(json.dumps(history[-1]), flush=True)
            if score < best_val:
                best_val, best_net, best_step = score, copy.deepcopy(net.state_dict()), step
    net.load_state_dict(best_net)
    net.eval()
    validation = {"reconstruction": reconstruction("val"), "prior": prior_report("val")}
    audit = {"reconstruction": reconstruction("audit"), "prior": prior_report("audit")}
    weights = deployment()["arrays"]
    meta = {
        "format": joint.FORMAT,
        "selected_method": "joint_conditional_vae",
        "training_profile": config.profile,
        "completed_steps": config.steps,
        "selected_step": best_step,
        "training_samples": len(x),
        "config": asdict(config),
        "feature_names": list(joint.CONTROL_NAMES),
        "observation_names": list(joint.OBSERVATION_NAMES),
        **provenance,
        "model_decoder_sha256": joint.digest(Path(joint.__file__)),
        "scope": joint.SCOPE,
        "validation": validation,
        "audit": audit,
        "runtime": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "device": device,
            "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None,
        },
        "supervision": {
            "geometry": "corresponding source surface anchors after current bounded renderer",
            "appearance": "authored linear RGB and roughness evaluated at those same anchors",
            "observations_are_measured_tissue": False,
            "field_phase": "deterministic percondition renderer_seed",
            "surrogate_validation_loss": best_score,
            "observation_metrics": "surrogate render-space approximations, not independent renderer reconstruction",
        },
        "quality": {
            "clinical_validation": "NOT_RUN",
            "physics_learning": False,
            "baseline_comparison": "reported honestly; VAE is never replaced by ridge, mean or bootstrap",
        },
    }
    out.mkdir(parents=True, exist_ok=True)
    model_path = out / "model.npz"
    with model_path.with_suffix(".tmp").open("wb") as stream:
        np.savez_compressed(
            stream, metadata_json=np.asarray(json.dumps(meta, allow_nan=False)), **weights
        )
    model_path.with_suffix(".tmp").replace(model_path)
    write_json(out / "model.json", {**meta, "artifact_sha256": joint.digest(model_path)})
    loaded = joint.load_model(model_path)
    replay = True
    for condition in provenance["conditions"]:
        args = (
            loaded,
            condition["template_id"],
            None if condition["profile_id"] == "baseline" else condition["profile_id"],
            42,
        )
        replay &= joint.sample_joint(*args) == joint.sample_joint(*args)
    report = {
        **meta,
        "artifact_sha256": joint.digest(model_path),
        "seed_replay_passed": bool(replay),
        "history": history,
        "split_counts": {s: len(a["controls"]) for s, a in data.items()},
    }
    write_json(out / "training_report.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--disease", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    for name in (
        "steps",
        "surrogate_steps",
        "batch_size",
        "hidden",
        "latent",
        "embedding",
        "seed",
        "threads",
    ):
        parser.add_argument(
            "--" + name.replace("_", "-"), type=int, default=getattr(Config(), name)
        )
    for name in ("learning_rate", "beta", "free_bits", "prior_weight"):
        parser.add_argument(
            "--" + name.replace("_", "-"), type=float, default=getattr(Config(), name)
        )
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--profile", choices=("full", "smoke"), default="full")
    args = parser.parse_args()
    options = vars(args).copy()
    baseline, disease, out = [options.pop(name) for name in ("baseline", "disease", "out")]
    report = train([baseline, disease], out, Config(**options))
    print(
        json.dumps(
            {
                "model": str(out / "model.npz"),
                "sha256": report["artifact_sha256"],
                "selected_step": report["selected_step"],
                "seed_replay": report["seed_replay_passed"],
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
