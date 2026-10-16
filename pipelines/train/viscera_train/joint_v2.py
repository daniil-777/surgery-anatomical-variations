"""Bounded spline flow with an independently evaluated renderer-query surrogate.

Spline formulas follow Durkan et al., Neural Spline Flows (NeurIPS 2019).
Default density pools healthy/disease types; organ/profile residual context is
optional. A separate query surrogate fits paired authored geometry/colour, rest
coordinates, regions and spatial seeds. It is diagnostic by default (field_weight=0).
Only an explicitly enabled field loss backpropagates through the actual inverse flow.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import platform
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
from scipy.special import ndtr, ndtri
from viscera_core import atlas_joint_v2 as joint
from viscera_core.atlas_disease_recipe_dataset import write_json


@dataclass(frozen=True)
class Config:
    steps: int = 4000
    surrogate_steps: int = 600
    batch_size: int = 256
    query_points: int = 16
    layers: int = 6
    bins: int = 8
    blocks: int = 2
    hidden: int = 96
    embedding: int = 16
    field_hidden: int = 96
    learning_rate: float = 0.0003
    field_weight: float = 0.0
    context_gain: float = 0.0
    dropout: float = 0.1
    seed: int = 7102027
    threads: int = 2
    device: str = "auto"
    amp: bool = True
    checkpoint_every: int = 1000
    profile: str = "full"


def torch_classes() -> tuple[Any, Any, Any, Any]:
    import torch
    import torch.nn.functional as F
    from torch import nn

    def spline(values: Any, parameters: Any, bins: int, inverse: bool = False) -> tuple[Any, Any]:
        # Keep knot arithmetic and analytic inversion in float32 even under A100 BF16.
        x, p = values.float(), parameters.float()
        widths = 2 * (1e-3 + (1 - bins * 1e-3) * torch.softmax(p[..., :bins], -1))
        heights = 2 * (1e-3 + (1 - bins * 1e-3) * torch.softmax(p[..., bins : 2 * bins], -1))
        interior = F.softplus(p[..., 2 * bins :] + math.log(math.expm1(1 - 1e-3))) + 1e-3
        derivatives = F.pad(interior, (1, 1), value=1)
        kx = F.pad(-1 + torch.cumsum(widths, -1), (1, 0), value=-1)
        ky = F.pad(-1 + torch.cumsum(heights, -1), (1, 0), value=-1)
        # Exact domain boundaries avoid a cumulative rounding gap at x=1.
        kx = torch.cat((kx[..., :-1], torch.ones_like(kx[..., -1:])), -1)
        ky = torch.cat((ky[..., :-1], torch.ones_like(ky[..., -1:])), -1)
        knots = ky if inverse else kx
        index = (
            (x.clamp(-1, 1).unsqueeze(-1) >= knots[..., 1:])
            .sum(-1)
            .clamp(0, bins - 1)
            .unsqueeze(-1)
        )

        def take(a: Any, offset: int = 0) -> Any:
            return a.gather(-1, index + offset).squeeze(-1)

        w, h, x0, y0, d0, d1 = (
            take(widths),
            take(heights),
            take(kx),
            take(ky),
            take(derivatives),
            take(derivatives, 1),
        )
        delta = h / w
        if inverse:
            dy = x.clamp(-1, 1) - y0
            a = dy * (d0 + d1 - 2 * delta) + h * (delta - d0)
            b = h * d0 - dy * (d0 + d1 - 2 * delta)
            c = -delta * dy
            denominator = -b - torch.sqrt((b * b - 4 * a * c).clamp_min(0))
            theta = (
                2
                * c
                / torch.where(
                    denominator.abs() > 1e-20, denominator, torch.full_like(denominator, -1e-20)
                )
            )
        else:
            theta = (x.clamp(-1, 1) - x0) / w
        theta = theta.clamp(0, 1)
        blend = theta * (1 - theta)
        denominator = delta + (d0 + d1 - 2 * delta) * blend
        output = (
            x0 + theta * w
            if inverse
            else y0 + h * (delta * theta.square() + d0 * blend) / denominator
        )
        derivative = (
            delta.square()
            * (d1 * theta.square() + 2 * delta * blend + d0 * (1 - theta).square())
            / denominator.square()
        )
        return output.clamp(-1, 1), derivative.clamp_min(1e-30).log() * (-1 if inverse else 1)

    class Conditioner(nn.Module):
        def __init__(self, c: Config):
            super().__init__()
            self.input = nn.Linear(11 + 2 * c.embedding, c.hidden)
            self.film = nn.Linear(2 * c.embedding, 2 * c.hidden)
            self.blocks = nn.ModuleList(
                [
                    nn.Sequential(
                        nn.Linear(c.hidden, c.hidden), nn.SiLU(), nn.Linear(c.hidden, c.hidden)
                    )
                    for _ in range(c.blocks)
                ]
            )
            self.dropout = c.dropout
            self.output = nn.Linear(c.hidden, 11 * (3 * c.bins - 1))
            nn.init.zeros_(self.output.weight)
            nn.init.zeros_(self.output.bias)

        def forward(self, x: Any, context: Any) -> Any:
            h = F.silu(self.input(torch.cat((x, context), 1)))
            scale, shift = self.film(context).chunk(2, 1)
            h = h * (1 + 0.1 * torch.tanh(scale)) + shift
            for block in self.blocks:
                h = h + block(F.dropout(F.silu(h), p=self.dropout, training=self.training))
            return self.output(F.silu(h))

    class Flow(nn.Module):
        def __init__(self, meta: dict[str, Any], c: Config):
            super().__init__()
            small = max(8, c.embedding // 2)
            self.template_embedding = nn.Embedding(len(meta["templates"]), c.embedding)
            self.profile_embedding = nn.Embedding(len(meta["profiles"]), c.embedding)
            self.organ_embedding = nn.Embedding(len(meta["organs"]), small)
            self.type_embedding = nn.Embedding(2, small)
            self.context_gain = c.context_gain
            cd = 2 * c.embedding
            self.context = nn.Sequential(
                nn.Linear(2 * c.embedding + 2 * small, cd), nn.SiLU(), nn.Linear(cd, cd)
            )
            self.couplings = nn.ModuleList([Conditioner(c) for _ in range(c.layers)])
            self.masks: Any
            self.register_buffer(
                "masks", torch.as_tensor(joint.coupling_masks(c.layers), dtype=torch.uint8)
            )
            self.bins = c.bins

        def context_features(self, tid: Any, pid: Any, oid: Any, sid: Any, phase: Any) -> Any:
            return self.context(
                torch.cat(
                    (
                        self.template_embedding(tid) * self.context_gain,
                        self.profile_embedding(pid) * self.context_gain,
                        self.organ_embedding(oid) * self.context_gain,
                        self.type_embedding((sid > 0).long()),
                    ),
                    1,
                )
            )

        def transform(self, x: Any, context: Any, inverse: bool = False) -> tuple[Any, Any]:
            total = torch.zeros(len(x), device=x.device, dtype=torch.float32)
            layers = reversed(range(len(self.couplings))) if inverse else range(len(self.couplings))
            for layer in layers:
                mask = self.masks[layer].bool()
                params = self.couplings[layer](x[:, mask], context).reshape(
                    len(x), 11, 3 * self.bins - 1
                )
                changed, ld = spline(x[:, ~mask], params, self.bins, inverse)
                result = x.clone()
                result[:, ~mask] = changed
                x = result
                total = total + ld.sum(1)
            return x, total

    class FieldSurrogate(nn.Module):
        def __init__(self, meta: dict[str, Any], c: Config):
            super().__init__()
            self.template = nn.Embedding(len(meta["templates"]), 16)
            self.profile = nn.Embedding(len(meta["profiles"]), 16)
            self.severity = nn.Embedding(4, 8)
            self.context = nn.Sequential(
                nn.Linear(22 + 16 + 16 + 8 + 8, c.field_hidden),
                nn.SiLU(),
                nn.Linear(c.field_hidden, c.field_hidden),
            )
            self.region = nn.Embedding(256, 4)
            self.query = nn.Sequential(
                nn.Linear(c.field_hidden + 7, c.field_hidden),
                nn.SiLU(),
                nn.Linear(c.field_hidden, c.field_hidden),
                nn.SiLU(),
                nn.Linear(c.field_hidden, 7),
            )

        def forward(
            self, x: Any, tid: Any, pid: Any, sid: Any, phase: Any, rest: Any, region: Any
        ) -> Any:
            context = self.context(
                torch.cat((x, self.template(tid), self.profile(pid), self.severity(sid), phase), 1)
            )
            queries = torch.cat(
                (
                    context[:, None, :].expand(-1, rest.shape[1], -1),
                    rest,
                    self.region(region.long()),
                ),
                -1,
            )
            output = self.query(queries)
            # Predict displacement plus linear RGB/roughness, not fixed anchor indices.
            return torch.cat((rest + output[..., :3] * 0.1, torch.sigmoid(output[..., 3:])), -1)

    return torch, Flow, FieldSurrogate, spline


def load_datasets(datasets: list[Path]) -> tuple[dict[str, Any], dict[str, dict[str, np.ndarray]]]:
    provenance: dict[str, Any] = {
        "conditions": [],
        "renderer_hashes": {},
        "template_hashes": {},
        "template_metadata_hashes": {},
        "dataset_hashes": {},
    }
    parts: dict[str, list[dict[str, np.ndarray]]] = {s: [] for s in ("train", "val", "audit")}
    for directory in map(Path, datasets):
        release = joint.verify_release(directory)
        catalog = json.loads((directory / "catalog.json").read_text())
        if catalog.get("control_names") != list(joint.CONTROL_NAMES) or catalog.get(
            "observation_names"
        ) != list(joint.OBSERVATION_NAMES):
            raise ValueError("V2 control/observation channel declaration mismatch")
        local = catalog["conditions"]
        joint.validate_conditions(local)
        lane = "baseline" if all(c["profile_id"] == "baseline" for c in local) else "disease"
        if lane + "/release.json" in provenance["dataset_hashes"]:
            raise ValueError("Duplicate V2 dataset lane")
        provenance["dataset_hashes"][lane + "/release.json"] = joint.digest(
            directory / "release.json"
        )
        for name in ("renderer_hashes", "template_hashes", "template_metadata_hashes"):
            hashes = release.get(name, catalog.get(name, {}))
            if not hashes:
                raise ValueError("Missing V2 provenance: " + name)
            for key, value in hashes.items():
                if key in provenance[name] and provenance[name][key] != value:
                    raise ValueError("V2 dataset provenance disagreement")
                provenance[name][key] = value
        offset = len(provenance["conditions"])
        if set(map(joint.condition_key, local)) & set(
            map(joint.condition_key, provenance["conditions"])
        ):
            raise ValueError("Duplicate V2 modeled condition")
        provenance["conditions"].extend(local)
        for split in parts:
            data = joint.read_split(directory, split)
            data["condition_ids"] = data["condition_ids"].astype(np.int64) + offset
            parts[split].append(data)
    if set(provenance["renderer_hashes"]) != set(joint.RENDERER_PATHS):
        raise ValueError("V2 release must bind every renderer source")
    merged = {}
    for split, rows in parts.items():
        merged[split] = {
            name: np.concatenate([d[name] for d in rows], 0) for name in joint.REQUIRED_ARRAYS
        }
        joint.validate_split(merged[split], provenance["conditions"])
        present = set(
            zip(
                merged[split]["condition_ids"].tolist(),
                merged[split]["severity_ids"].tolist(),
                strict=True,
            )
        )
        needed = {
            (i, sid)
            for i, c in enumerate(provenance["conditions"])
            for sid in ((0,) if c["profile_id"] == "baseline" else (1, 2, 3))
        }
        if present != needed:
            raise ValueError("Every V2 split requires every condition/severity band")
    del parts
    for a, b in (("train", "val"), ("train", "audit"), ("val", "audit")):
        for key in ("sample_ids", "group_ids"):
            if set(merged[a][key]) & set(merged[b][key]):
                raise ValueError("V2 family/sample split leakage: " + key)
    for name, field in (
        ("templates", "template_id"),
        ("profiles", "profile_id"),
        ("organs", "organ"),
    ):
        provenance[name] = sorted({c[field] for c in provenance["conditions"]})
    provenance["observation_shape"] = list(merged["train"]["observations"].shape[1:])
    return provenance, merged


def _mixed_log_correction(sid: np.ndarray) -> np.ndarray:
    # Uniform auxiliary baseline dimensions integrate out with +9log2.
    # Count bins have width1/4; disease strength maps into a physical band.
    result = np.full(len(sid), 9 * math.log(2), dtype=np.float32)
    for band, (lo, hi) in joint.SEVERITY_BANDS.items():
        result[sid == band] = -math.log(hi - lo) - math.log(4)
    return result


def _distribution_metrics(draws: np.ndarray, truth: np.ndarray, baseline: bool) -> dict[str, float]:
    a, b = (draws[:, :13], truth[:, :13]) if baseline else (draws, truth)
    varying = b.std(0) > 1e-4
    av, bv = a[:, varying], b[:, varying]
    return {
        "mean_mae": float(np.abs(a.mean(0) - b.mean(0)).mean()),
        "relative_std_error": float((np.abs(av.std(0) - bv.std(0)) / (bv.std(0) + 1e-4)).mean())
        if varying.any()
        else 0.0,
        "covariance_mae": float(np.abs(np.cov(av, rowvar=False) - np.cov(bv, rowvar=False)).mean())
        if varying.any()
        else 0.0,
        "unique_fraction": len(np.unique(draws, axis=0)) / len(draws),
        "boundary_fraction": float((np.abs(a) > 0.97).mean()),
        "shape_std_mean": float(a[:, :7].std(0).mean()),
        "material_std_mean": float(a[:, 7:13].std(0).mean()),
        "disease_std_mean": float(a[:, 13:].std(0).mean()) if not baseline else 0.0,
    }


def train(datasets: list[Path], out: Path, config: Config = Config()) -> dict[str, Any]:
    if (
        config.profile not in ("full", "smoke")
        or config.steps < 1
        or config.surrogate_steps < 1
        or config.batch_size < 8
        or config.query_points < 1
    ):
        raise ValueError("Invalid V2 training configuration")
    if config.profile == "full" and (config.steps < 4000 or config.surrogate_steps < 200):
        raise ValueError("V2 full training requires at least4000 flow and200 surrogate steps")
    if (
        not 0 < config.learning_rate < 0.1
        or not 0 <= config.field_weight <= 1
        or config.threads < 1
        or config.checkpoint_every < 1
        or not 0 <= config.dropout <= 0.5
        or not 0 <= config.context_gain <= 1
    ):
        raise ValueError("Invalid V2 optimizer configuration")
    for name, lo, hi in (
        ("layers", 2, 24),
        ("bins", 4, 32),
        ("blocks", 1, 4),
        ("hidden", 16, 1024),
        ("embedding", 4, 128),
        ("field_hidden", 16, 512),
    ):
        if not lo <= getattr(config, name) <= hi:
            raise ValueError("Invalid V2 architecture dimension " + name)
    out = Path(out)
    if (out / "model.npz").exists():
        raise ValueError(
            "V2 output already contains final model; use verified completed-stage reuse"
        )
    out.mkdir(parents=True, exist_ok=True)
    provenance, data = load_datasets(datasets)
    torch, Flow, Surrogate, _ = torch_classes()
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
    if device not in ("cpu", "cuda") or device == "cuda" and not torch.cuda.is_available():
        raise ValueError("Requested V2 device is unavailable")
    amp = config.amp and device == "cuda" and torch.cuda.is_bf16_supported()
    rng = np.random.default_rng(config.seed)
    model = Flow(provenance, config).to(device)
    field = Surrogate(provenance, config).to(device)
    decoder_hash = joint.digest(Path(joint.__file__))
    identity = {
        "config": asdict(config),
        "datasets": provenance["dataset_hashes"],
        "decoder_sha256": decoder_hash,
        "trainer_sha256": joint.digest(Path(__file__)),
        "execution": {"device": device, "bf16": amp, "torch": str(torch.__version__)},
    }
    identity_hash = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    checkpoint = out / "checkpoint.pt"
    saved = None
    if checkpoint.exists():
        saved = torch.load(checkpoint, map_location=device, weights_only=True)
        if (
            saved.get("format") != "viscera-joint-flow-checkpoint-v2"
            or saved.get("identity_sha256") != identity_hash
        ):
            raise ValueError("V2 checkpoint config/data/source differs from this run")
        model.load_state_dict(saved["model"])
        field.load_state_dict(saved["field"])
        rng.bit_generator.state = saved["numpy_rng"]
        torch.set_rng_state(saved["torch_rng"].cpu())
        if device == "cuda":
            torch.cuda.set_rng_state_all([s.cpu() for s in saved["cuda_rng"]])
        print(
            json.dumps({"resuming_phase": saved["phase"], "completed_steps": saved["step"]}),
            flush=True,
        )
    contexts = {}
    for split, d in data.items():
        tid, pid, oid = joint.context_indices(provenance, d["condition_ids"])
        contexts[split] = (tid, pid, oid)
    group_keys = sorted(
        set(
            zip(
                data["train"]["condition_ids"].tolist(),
                data["train"]["severity_ids"].tolist(),
                strict=True,
            )
        )
    )
    groups = {
        key: np.flatnonzero(
            (data["train"]["condition_ids"] == key[0]) & (data["train"]["severity_ids"] == key[1])
        )
        for key in group_keys
    }
    history = saved["history"] if saved else []
    gaussian = {}
    fixed_rng = np.random.default_rng(557301)
    training_flow = joint.to_flow_controls(
        data["train"]["controls"], data["train"]["severity_ids"], fixed_rng
    )
    for key, ix in groups.items():
        gaussian[key] = (training_flow[ix].mean(0), np.maximum(training_flow[ix].std(0), 0.04))
    field_means = {}
    mean_rng = np.random.default_rng(73471)
    for key, ix in groups.items():
        selected = mean_rng.choice(ix, min(64, len(ix)), replace=False)
        observed = data["train"]["observations"][selected]
        rest = data["train"]["rest_points"][selected]
        field_means[key] = np.r_[
            (observed[..., :3] - rest).mean(axis=(0, 1)),
            observed[..., 3:].mean(axis=(0, 1)),
        ].astype(np.float32)

    # Query tensors are sliced on CPU then transferred. Whole512-point datasets stay offGPU.
    def tensors(split: str, ix: np.ndarray, query: bool = True) -> dict[str, Any]:
        d = data[split]
        tid, pid, oid = contexts[split]
        r = {
            name: torch.as_tensor(values[ix], device=device)
            for name, values in (
                ("x", d["controls"]),
                ("sid", d["severity_ids"].astype(np.int64)),
                ("tid", tid),
                ("pid", pid),
                ("oid", oid),
                ("phase", d["spatial_features"]),
            )
        }
        r["cid"] = torch.as_tensor(d["condition_ids"][ix], device=device)
        for name in ("x", "phase"):
            r[name] = r[name].float()
        if query:
            q = rng.integers(
                d["observations"].shape[1],
                size=(len(ix), min(config.query_points, d["observations"].shape[1])),
            )
            for name, source in (
                ("obs", "observations"),
                ("rest", "rest_points"),
                ("region", "region_ids"),
            ):
                r[name] = torch.as_tensor(d[source][ix[:, None], q], device=device).float()
        return r

    def batch() -> np.ndarray:
        per = min(16, config.batch_size)
        selected = rng.integers(len(group_keys), size=max(1, config.batch_size // per))
        return np.concatenate(
            [rng.choice(groups[group_keys[i]], per, replace=True) for i in selected]
        )

    def context(r: dict[str, Any]) -> Any:
        return model.context_features(r["tid"], r["pid"], r["oid"], r["sid"], r["phase"])

    def field_values(r: dict[str, Any], x: Any) -> Any:
        return field(x, r["tid"], r["pid"], r["sid"], r["phase"], r["rest"], r["region"])

    def field_loss(pred: Any, truth: Any) -> Any:
        d = pred - truth
        return (
            (d[..., :3] / 0.05).square().mean()
            + (d[..., 3:6] / 0.1).square().mean()
            + 0.25 * (d[..., 6] / 0.1).square().mean()
        )

    def physical_controls(u: Any, sid: Any) -> Any:
        # Smooth count-bin centre interpolation is used only by the field surrogate.
        x = u.clone()
        for band, (lo, hi) in joint.SEVERITY_BANDS.items():
            mask = sid == band
            x[mask, 13] = 2 * (lo + (u[mask, 13] + 1) / 2 * (hi - lo)) - 1
        x[:, 18] = ((u[:, 18] + 1) * 4 - 0.5).clamp(0, 7) / 3.5 - 1
        x[sid == 0, 13:] = 0
        return x

    @torch.no_grad()  # type: ignore[untyped-decorator]
    def evaluate_field(split: str) -> dict[str, float]:
        # Deterministic row/query subset, preserving caller RNG for exact resume.
        state = copy.deepcopy(rng.bit_generator.state)
        rng.bit_generator.state = np.random.default_rng(2719).bit_generator.state
        erng = np.random.default_rng(2718)
        ix = erng.choice(
            len(data[split]["controls"]), min(2048, len(data[split]["controls"])), replace=False
        )
        sums = np.zeros(3)
        baseline_sums = np.zeros(3)
        count = 0
        for start in range(0, len(ix), 128):
            selected = ix[start : start + 128]
            r = tensors(split, selected)
            error = (field_values(r, r["x"]) - r["obs"]).cpu().numpy()
            sums += np.array(
                [
                    np.mean(error[..., :3] ** 2),
                    np.mean(error[..., 3:6] ** 2),
                    np.mean(error[..., 6] ** 2),
                ]
            ) * len(error)
            means = np.stack(
                [
                    field_means[
                        (int(data[split]["condition_ids"][i]), int(data[split]["severity_ids"][i]))
                    ]
                    for i in selected
                ]
            )
            observed = r["obs"].cpu().numpy()
            base = np.broadcast_to(means[:, None, :], observed.shape).copy()
            base[..., :3] += r["rest"].cpu().numpy()
            error_base = base - observed
            baseline_sums += np.array(
                [
                    np.mean(error_base[..., :3] ** 2),
                    np.mean(error_base[..., 3:6] ** 2),
                    np.mean(error_base[..., 6] ** 2),
                ]
            ) * len(error)
            count += len(error)
        rng.bit_generator.state = state
        names = ("geometry_normalized_rmse", "colour_linear_rgb_rmse", "roughness_rmse")
        return {
            **dict(zip(names, np.sqrt(sums / count).tolist(), strict=True)),
            **dict(
                zip(
                    ("condition_mean_" + n for n in names),
                    np.sqrt(baseline_sums / count).tolist(),
                    strict=True,
                )
            ),
        }

    def save_checkpoint(
        phase: str,
        step: int,
        optimizer: Any,
        scheduler: Any,
        best: Any,
        best_score: float,
        best_step: int,
        best_field: Any,
    ) -> None:
        record = {
            "format": "viscera-joint-flow-checkpoint-v2",
            "identity_sha256": identity_hash,
            "identity": identity,
            "phase": phase,
            "step": step,
            "model": model.state_dict(),
            "field": field.state_dict(),
            "optimizer": optimizer.state_dict(),
            "scheduler": scheduler.state_dict() if scheduler else None,
            "best_state": best,
            "best_score": best_score,
            "best_step": best_step,
            "best_field": best_field,
            "history": history,
            "numpy_rng": rng.bit_generator.state,
            "torch_rng": torch.get_rng_state(),
            "cuda_rng": torch.cuda.get_rng_state_all() if device == "cuda" else [],
        }
        temporary = checkpoint.with_suffix(".tmp")
        torch.save(record, temporary)
        temporary.replace(checkpoint)

    foptimizer = torch.optim.AdamW(
        field.parameters(), lr=config.learning_rate * 2, weight_decay=1e-4
    )
    best_field = saved.get("best_field") if saved else None
    best_field_score = (
        saved["best_score"] if saved and saved["phase"] == "surrogate" else float("inf")
    )
    start = 0
    if saved and saved["phase"] == "surrogate":
        foptimizer.load_state_dict(saved["optimizer"])
        start = saved["step"]
    if not saved or saved["phase"] == "surrogate":
        interval = max(1, min(300, config.surrogate_steps // 4))
        for step in range(start + 1, config.surrogate_steps + 1):
            r = tensors("train", batch())
            with torch.autocast(device_type=device, dtype=torch.bfloat16, enabled=amp):
                loss = field_loss(field_values(r, r["x"]), r["obs"])
            if not torch.isfinite(loss):
                raise RuntimeError("V2 field loss became nonfinite")
            foptimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(field.parameters(), 5)
            foptimizer.step()
            if step % interval == 0 or step == config.surrogate_steps:
                metrics = evaluate_field("val")
                score = (
                    metrics["geometry_normalized_rmse"] / 0.05
                    + metrics["colour_linear_rgb_rmse"] / 0.1
                    + metrics["roughness_rmse"] / 0.1
                )
                history.append(
                    {
                        "phase": "surrogate",
                        "step": step,
                        "loss": float(loss.detach()),
                        "validation": metrics,
                    }
                )
                print(json.dumps(history[-1]), flush=True)
                if score < best_field_score:
                    best_field_score = score
                    best_field = copy.deepcopy(field.state_dict())
            if step % config.checkpoint_every == 0 or step == config.surrogate_steps:
                save_checkpoint(
                    "surrogate", step, foptimizer, None, None, best_field_score, 0, best_field
                )
    field.load_state_dict(best_field)
    field.eval()
    for p in field.parameters():
        p.requires_grad_(False)
    optimizer = torch.optim.AdamW(model.parameters(), lr=config.learning_rate, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, config.steps, eta_min=config.learning_rate * 0.08
    )
    start = 0
    best = None
    best_score = float("inf")
    best_step = 0
    if saved and saved["phase"] == "flow":
        optimizer.load_state_dict(saved["optimizer"])
        scheduler.load_state_dict(saved["scheduler"])
        start = saved["step"]
        best, best_score, best_step = saved["best_state"], saved["best_score"], saved["best_step"]

    @torch.no_grad()  # type: ignore[untyped-decorator]
    def density_report(split: str) -> dict[str, Any]:
        was_training = model.training
        model.eval()
        d = data[split]
        erng = np.random.default_rng(83017)
        # Fixed independent dequantization makes checkpoints directly comparable.
        values = joint.to_flow_controls(d["controls"], d["severity_ids"], erng)
        logps = []
        for begin in range(0, len(values), 512):
            ix = np.arange(begin, min(begin + 512, len(values)))
            r = tensors(split, ix, query=False)
            _, ld = model.transform(torch.as_tensor(values[ix], device=device), context(r))
            logps.append((-22 * math.log(2) + ld).cpu().numpy())
        flow_lp = np.concatenate(logps) + _mixed_log_correction(d["severity_ids"])
        rows = {}
        for key in group_keys:
            ix = np.flatnonzero((d["condition_ids"] == key[0]) & (d["severity_ids"] == key[1]))
            mu, sd = gaussian[key]
            columns = 13 if key[1] == 0 else 22
            u = values[ix, :columns]
            lower, upper = (
                ndtr((-1 - mu[:columns]) / sd[:columns]),
                ndtr((1 - mu[:columns]) / sd[:columns]),
            )
            lp = (
                -0.5 * ((u - mu[:columns]) / sd[:columns]) ** 2
                - np.log(sd[:columns])
                - 0.5 * math.log(2 * math.pi)
                - np.log(np.maximum(upper - lower, 1e-12))
            ).sum(1)
            correction = (
                0
                if key[1] == 0
                else -math.log(joint.SEVERITY_BANDS[key[1]][1] - joint.SEVERITY_BANDS[key[1]][0])
                - math.log(4)
            )
            cid, sid = key
            name = "|".join(
                (*joint.condition_key(provenance["conditions"][cid]), joint.SEVERITY_NAMES[sid])
            )
            rows[name] = {
                "rows": len(ix),
                "active_dimensions": columns,
                "flow_nll_per_active_dimension": float(-flow_lp[ix].mean() / columns),
                "truncated_diagonal_gaussian_nll_per_active_dimension": float(
                    -(lp + correction).mean() / columns
                ),
                "uniform_nll_per_active_dimension": float(
                    (columns * math.log(2) - correction) / columns
                ),
            }
        macro = {
            key: float(np.mean([v[key] for v in rows.values()]))
            for key in (
                "flow_nll_per_active_dimension",
                "truncated_diagonal_gaussian_nll_per_active_dimension",
                "uniform_nll_per_active_dimension",
            )
        }
        model.train(was_training)
        return {
            "macro": macro,
            "per_condition_severity": rows,
            "definition": "Mixed continuous-control/discrete-count dequantization bound in physical normalized control coordinates; baseline uniform nuisance9dims removed; no clinical interpretation.",
        }

    # Every initialized spline is exactly the identity. Include that real model in
    # selection so finite-sample overfitting cannot silently replace the uniform prior.
    if not (saved and saved["phase"] == "flow"):
        initial = density_report("val")
        best_score = initial["macro"]["flow_nll_per_active_dimension"]
        best = copy.deepcopy(model.state_dict())
        history.append(
            {"phase": "flow", "step": 0, "identity_baseline": True, "validation": initial["macro"]}
        )
        print(json.dumps(history[-1]), flush=True)

    def distribution_loss(pred: Any, truth: Any, r: dict[str, Any]) -> Any:
        # Pool queried field displacement/colour by exact condition and severity.
        p = torch.cat(((pred[..., :3] - r["rest"]) / 0.05, pred[..., 3:] / 0.1), -1)
        t = torch.cat(((truth[..., :3] - r["rest"]) / 0.05, truth[..., 3:] / 0.1), -1)
        keys = r["cid"] * 4 + r["sid"]
        loss = p.sum() * 0
        for key in keys.unique():
            a, b = p[keys == key].reshape(-1, 7), t[keys == key].reshape(-1, 7)
            loss = (
                loss
                + (a.mean(0) - b.mean(0)).square().mean()
                + (a.std(0, correction=0) - b.std(0, correction=0)).square().mean()
            )
        return loss / max(1, len(keys.unique()))

    interval = max(1, min(1000, config.steps // 5))
    for step in range(start + 1, config.steps + 1):
        ix = batch()
        r = tensors("train", ix)
        values = joint.to_flow_controls(
            data["train"]["controls"][ix], data["train"]["severity_ids"][ix], rng
        )
        with torch.autocast(device_type=device, dtype=torch.bfloat16, enabled=amp):
            ctx = context(r)
            _, ld = model.transform(torch.as_tensor(values, device=device), ctx)
            correction = torch.as_tensor(
                _mixed_log_correction(data["train"]["severity_ids"][ix]), device=device
            )
            dimensions = torch.where(r["sid"] == 0, 13.0, 22.0)
            nll = ((22 * math.log(2) - ld - correction) / dimensions).mean()
            # The inverse is the actual deployed sampler; gradients reach its coupling parameters.
            if config.field_weight:
                z = torch.rand((len(ix), 22), device=device) * 2 - 1
                sampled, _ = model.transform(z, ctx, inverse=True)
                generated = physical_controls(sampled, r["sid"])
                auxiliary = distribution_loss(field_values(r, generated), r["obs"], r)
            else:
                auxiliary = nll * 0
            loss = (
                nll + config.field_weight * min(1.0, step / max(1, config.steps * 0.15)) * auxiliary
            )
        if not torch.isfinite(loss):
            raise RuntimeError("V2 flow loss became nonfinite; no weights exported")
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5)
        optimizer.step()
        scheduler.step()
        if (step <= 100 and step % 20 == 0) or step % interval == 0 or step == config.steps:
            report = density_report("val")
            score = report["macro"]["flow_nll_per_active_dimension"]
            history.append(
                {
                    "phase": "flow",
                    "step": step,
                    "loss": float(loss.detach()),
                    "nll": float(nll.detach()),
                    "field_moment_loss": float(auxiliary.detach()),
                    "validation": report["macro"],
                }
            )
            print(json.dumps(history[-1]), flush=True)
            if score < best_score:
                best_score = score
                best = copy.deepcopy(model.state_dict())
                best_step = step
        if step % config.checkpoint_every == 0 or step == config.steps:
            save_checkpoint(
                "flow", step, optimizer, scheduler, best, best_score, best_step, best_field
            )
    model.load_state_dict(best)
    model.eval()
    weights = {k: v.detach().cpu().numpy().copy() for k, v in model.state_dict().items()}
    meta = {
        "format": joint.FORMAT,
        "selected_method": joint.METHOD,
        "training_profile": config.profile,
        "completed_steps": config.steps,
        "selected_step": best_step,
        "training_samples": len(data["train"]["controls"]),
        "config": asdict(config),
        **provenance,
        "feature_names": list(joint.CONTROL_NAMES),
        "observation_names": list(joint.OBSERVATION_NAMES),
        "severity_names": list(joint.SEVERITY_NAMES),
        "severity_bands": {str(k): list(v) for k, v in joint.SEVERITY_BANDS.items()},
        "model_decoder_sha256": decoder_hash,
        "scope": joint.SCOPE,
        "validation": {"density": density_report("val"), "field_surrogate": evaluate_field("val")},
        "audit": {"density": density_report("audit"), "field_surrogate": evaluate_field("audit")},
        "runtime": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "device": device,
            "bf16_conditioners": amp,
            "spline_arithmetic": "float32",
            "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None,
        },
        "supervision": {
            "query_coordinates": "actual perrow rest positions and material region IDs",
            "phase": "exact independent material/disease uint32 seedbytes in surrogate and renderer; density is deliberately independent of nuisance phase",
            "density_context": "pooled healthy/disease type; template/profile/organ residual embeddings scaled by context_gain; design bands use invertible coordinate mapping",
            "density_context_gain": config.context_gain,
            "field_regularizer_weight": config.field_weight,
            "flow_gradient_from_generated_field_moments": bool(config.field_weight),
            "observations_are_measured_tissue": False,
            "baseline_auxiliary_dimensions": "independent uniform nuisance; removed in reported per-active-dimension bound",
            "disease_count": "8 equal-width uniform dequantization bins, hard inverse quantization",
            "severity": "explicit invertible physical band map; design strength, not clinical stage",
        },
        "checkpoint_identity_sha256": identity_hash,
        "checkpoint_resume_supported": True,
    }
    validation_density = meta["validation"]["density"]["macro"]
    audit_density = meta["audit"]["density"]["macro"]
    margin = 0.002  # Declared minimum mean NLL improvement per active control.
    improved = (
        validation_density["uniform_nll_per_active_dimension"]
        - validation_density["flow_nll_per_active_dimension"]
        > margin
    )
    audit_improved = (
        audit_density["uniform_nll_per_active_dimension"]
        - audit_density["flow_nll_per_active_dimension"]
        > margin
    )
    meta["validation_acceptance"] = {
        "density_improved_over_identity": bool(improved),
        "audit_improved_over_identity": bool(audit_improved),
        "export_eligible": bool(
            config.profile == "full" and best_step > 0 and improved and audit_improved
        ),
        "uniform_nll": validation_density["uniform_nll_per_active_dimension"],
        "selected_nll": validation_density["flow_nll_per_active_dimension"],
        "audit_uniform_nll": audit_density["uniform_nll_per_active_dimension"],
        "audit_selected_nll": audit_density["flow_nll_per_active_dimension"],
        "minimum_improvement": margin,
        "selection": "validation only, including exact untrained identity checkpoint; audit is a release gate, never a checkpoint selector",
        "scope": "synthetic control-density fit only; not anatomical or clinical realism",
    }
    deployment = {**meta, "arrays": weights}
    # Deployment parity checks use unrounded flow coordinates, including analytic inverses.
    erng = np.random.default_rng(4071)
    size = min(32, len(data["val"]["controls"]))
    ix = np.arange(size)
    r = tensors("val", ix, query=False)
    z = erng.uniform(-0.99, 0.99, (size, 22)).astype(np.float32)
    with torch.no_grad():
        expected = (
            model.transform(torch.as_tensor(z, device=device), context(r), inverse=True)[0]
            .cpu()
            .numpy()
        )
    actual = joint.flow_transform(
        deployment,
        z,
        data["val"]["condition_ids"][ix],
        data["val"]["severity_ids"][ix],
        data["val"]["spatial_features"][ix],
        inverse=True,
    )[0]
    parity = float(np.max(np.abs(actual - expected)))
    if parity > 5e-4:
        raise RuntimeError(f"V2 NumPy decoder parity failed: {parity}")

    # Prior diagnostics include every condition/severity, not just common classes.
    def prior_report(split: str) -> dict[str, Any]:
        rows: dict[str, Any] = {}
        erng = np.random.default_rng(72041)
        for cid, sid in group_keys:
            ix = np.flatnonzero(
                (data[split]["condition_ids"] == cid) & (data[split]["severity_ids"] == sid)
            )
            chosen = erng.choice(ix, 64, replace=True)
            phase = data[split]["spatial_features"][chosen]
            latent = erng.uniform(-1, 1, (64, 22)).astype(np.float32)
            local, _ = joint.flow_transform(
                deployment, latent, np.full(64, cid), np.full(64, sid), phase, inverse=True
            )
            draws = joint.from_flow_controls(local, np.full(64, sid))
            mu, sd = gaussian[(cid, sid)]
            lower, upper = ndtr((-1 - mu) / sd), ndtr((1 - mu) / sd)
            baseline = mu + sd * ndtri(
                np.clip(lower + erng.random((64, 22)) * (upper - lower), 1e-7, 1 - 1e-7)
            )
            baseline = joint.from_flow_controls(baseline, np.full(64, sid))
            name = "|".join(
                (*joint.condition_key(provenance["conditions"][cid]), joint.SEVERITY_NAMES[sid])
            )
            rows[name] = {
                "flow": _distribution_metrics(draws, data[split]["controls"][ix], sid == 0),
                "truncated_diagonal_gaussian": _distribution_metrics(
                    baseline, data[split]["controls"][ix], sid == 0
                ),
                "requested_severity": joint.SEVERITY_NAMES[sid],
                "severity_support_passed": bool(
                    sid == 0
                    or np.all(
                        ((draws[:, 13] + 1) / 2 >= joint.SEVERITY_BANDS[sid][0] - 1e-6)
                        & ((draws[:, 13] + 1) / 2 <= joint.SEVERITY_BANDS[sid][1] + 1e-6)
                    )
                ),
            }
        return {
            "per_condition_severity": rows,
            "macro": {
                method: {
                    key: float(np.mean([r[method][key] for r in rows.values()]))
                    for key in (
                        "mean_mae",
                        "relative_std_error",
                        "covariance_mae",
                        "unique_fraction",
                        "boundary_fraction",
                    )
                }
                for method in ("flow", "truncated_diagonal_gaussian")
            },
        }

    meta["validation"]["prior"] = prior_report("val")
    meta["audit"]["prior"] = prior_report("audit")
    meta["numpy_decoder_max_abs_error"] = parity
    # Publish the NPZ last: its existence is the runner's completed-stage marker.
    # A disconnect after any earlier sidecar write can resume the final checkpoint.
    staging = out / ".finalizing"
    staging.mkdir(exist_ok=True)
    path = staging / "model.npz"
    with path.with_suffix(".tmp").open("wb") as f:
        np.savez_compressed(
            f, metadata_json=np.asarray(json.dumps(meta, allow_nan=False)), **weights
        )
    path.with_suffix(".tmp").replace(path)
    write_json(staging / "model.json", {**meta, "artifact_sha256": joint.digest(path)})
    loaded = joint.load_model(path)
    replay = all(
        joint.sample_joint(
            loaded, c["template_id"], None if c["profile_id"] == "baseline" else c["profile_id"], 71
        )
        == joint.sample_joint(
            loaded, c["template_id"], None if c["profile_id"] == "baseline" else c["profile_id"], 71
        )
        for c in loaded["conditions"]
    )
    report = {
        **meta,
        "artifact_sha256": joint.digest(path),
        "seed_replay_passed": replay,
        "history": history,
        "split_counts": {s: len(d["controls"]) for s, d in data.items()},
    }
    write_json(staging / "training_report.json", report)
    for name in ("model.json", "training_report.json", "model.npz"):
        (staging / name).replace(out / name)
    staging.rmdir()
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
        "query_points",
        "layers",
        "bins",
        "blocks",
        "hidden",
        "embedding",
        "field_hidden",
        "seed",
        "threads",
        "checkpoint_every",
    ):
        parser.add_argument(
            "--" + name.replace("_", "-"), type=int, default=getattr(Config(), name)
        )
    for name in ("learning_rate", "field_weight", "dropout", "context_gain"):
        parser.add_argument(
            "--" + name.replace("_", "-"), type=float, default=getattr(Config(), name)
        )
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--profile", choices=("full", "smoke"), default="full")
    parser.add_argument("--no-amp", action="store_true")
    args = vars(parser.parse_args())
    baseline, disease, out = [args.pop(k) for k in ("baseline", "disease", "out")]
    args["amp"] = not args.pop("no_amp")
    report = train([baseline, disease], out, Config(**args))
    print(
        json.dumps(
            {
                "model": str(out / "model.npz"),
                "sha256": report["artifact_sha256"],
                "selected_step": report["selected_step"],
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
