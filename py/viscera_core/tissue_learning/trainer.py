"""Resumable research training; posterior fit never certifies prior sample realism."""

from __future__ import annotations

import json
import os
import platform
import time
from pathlib import Path

import numpy as np
import PIL
import safetensors
import torch
from torch.nn import functional as F

from .checkpoint import (
    atomic_json,
    digest,
    latest_checkpoint,
    load_checkpoint,
    mirror_checkpoint,
    save_checkpoint,
)
from .config import ExperimentConfig, identity
from .data import TissueDataset
from .model import TissueAppearanceVAE, objective


def source_hashes() -> dict[str, str]:
    return {p.name: digest(p) for p in sorted(Path(__file__).parent.glob("*.py"))}


def environment(device: str) -> dict:
    return {"python": platform.python_version(), "platform": platform.system(),
            "machine": platform.machine(), "torch": torch.__version__, "numpy": np.__version__,
            "pillow": PIL.__version__, "safetensors": safetensors.__version__,
            "device": device, "cuda": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None,
            "determinism": "same runtime/device only; CPU exact resume tested separately"}


class Trainer:
    def __init__(self, dataset: TissueDataset, output: Path, config: ExperimentConfig,
                 *, resume_from: Path | None = None, mirror: Path | None = None):
        self.dataset, self.output, self.config = dataset, Path(output), config
        self.mirror = Path(mirror) if mirror else None
        if config.validation_mode == "heldout" and not dataset.splits["val"]:
            raise ValueError("heldout validation requires independent validation records")
        if any(row["group_level"] == "synthetic_fixture" for row in dataset.records) and not config.fixture:
            raise ValueError("software fixture data must retain fixture=True provenance")
        if config.device == "cuda" and not torch.cuda.is_available():
            raise ValueError("CUDA requested but unavailable; no silent CPU fallback")
        if config.device == "cuda" and config.precision == "bfloat16" and not torch.cuda.is_bf16_supported():
            raise ValueError("selected GPU does not support bfloat16 AMP")
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        torch.use_deterministic_algorithms(True)
        torch.set_num_threads(1)
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.manual_seed(config.seed)
        self.device = torch.device(config.device)
        self.model = TissueAppearanceVAE(config, len(dataset.conditions)).to(self.device)
        self.optimizer = torch.optim.AdamW(self.model.parameters(), lr=config.lr,
                                           weight_decay=config.weight_decay)
        self.request = {"schema": "viscera.tissue-training-request/v1", "config": config.to_dict(),
                        "config_sha256": identity(config.to_dict()), "data": dataset.summary(),
                        "source_sha256": source_hashes(), "environment": environment(config.device),
                        "condition_regions": dataset.condition_regions,
                        "condition_species": dataset.condition_species,
                        "scheduler": "none; constant LR", "scaler": "none; bfloat16 or float32",
                        "preprocessing": {"revision": "masked-rgb-square-crop-v2",
                            "training_crop": "up to8 seeded square crops, mask-bbox-centered fallback, center fallback",
                            "evaluation_crop": "center square, mask-bbox-centered fallback",
                            "image_resize": "Pillow bicubic", "mask_resize": "nearest; values>=128 valid",
                            "heuristic_exclusions": "minRGB>.90 and maxRGB>.98 glare; maxRGB<.03 dark",
                            "invalid_encoder_fill": 0.5, "color_space": "observed sRGB /255"},
                        "parameter_inventory": {name: {"shape": list(p.shape), "trainable": p.requires_grad,
                                                       "elements": p.numel()}
                                                for name, p in self.model.named_parameters()}}
        self.step, self.cursor, self.epoch = 0, 0, 0
        self.loss_history: list[dict] = []
        self.rng = np.random.default_rng(config.seed)
        self.order = self._new_order()
        self.last_validation: dict = ({"status": "not_available_training_only",
            "interpretation": "real gradients only; no held-out generalization evidence"}
            if config.validation_mode == "training_only" else {})
        self.output.mkdir(parents=True, exist_ok=True)
        if resume_from:
            state, request = load_checkpoint(resume_from)
            if identity(request) != identity(self.request):
                raise ValueError("resume request/data/source/runtime identity mismatch")
            self.model.load_state_dict(state["model"], strict=True)
            self.optimizer.load_state_dict(state["optimizer"])
            self.step, self.cursor, self.epoch = state["step"], state["cursor"], state["epoch"]
            self.order, self.baseline, self.last_validation = state["order"], state["baseline"], state["validation"]
            self.loss_history = state["loss_history"]
            self.rng.bit_generator.state = state["sampler_rng"]
            torch.set_rng_state(state["torch_rng"])
            if config.device == "cuda":
                torch.cuda.set_rng_state_all(state["cuda_rng"])
        else:
            if (self.output / "request.json").exists() or (self.output / "checkpoints/latest.json").exists():
                raise FileExistsError("run already exists; resume explicitly or select a new output")
            self.baseline = self._training_baseline()
        atomic_json(self.output / "request.json", self.request)
        self.status = "ready"

    def _training_baseline(self) -> dict:
        means, counts = [], []
        rng = np.random.default_rng(8147)
        for condition in self.dataset.conditions:
            ids = [i for i in self.dataset.splits["train"] if self.dataset.records[i]["condition"] == condition]
            ids = rng.permutation(ids)[:self.config.baseline_limit_per_condition]
            total, count = np.zeros(3, dtype=np.float64), 0.
            for index in ids:
                rgb, mask, _ = self.dataset.load(int(index), self.config.patch_size,
                    minimum_valid_fraction=self.config.minimum_valid_fraction)
                total += (rgb * mask).sum((1, 2), dtype=np.float64)
                count += float(mask.sum())
            means.append((total / count).tolist())
            counts.append(len(ids))
        return {"rgb": means, "sample_counts": counts, "fit_split": "train",
                "method": "masked per-condition RGB mean; deterministic capped train sample"}

    def _new_order(self) -> list[int]:
        if self.config.sampling == "shuffled":
            return self.rng.permutation(self.dataset.splits["train"]).tolist()
        groups = [[i for i in self.dataset.splits["train"]
                   if self.dataset.records[i]["condition"] == name] for name in self.dataset.conditions]
        count = max(map(len, groups))
        balanced = []
        for indices in groups:
            # Every source is used before repetition within its condition.
            # Oversampling repeats observations; it does not create independent data.
            repeated = []
            while len(repeated) < count:
                repeated.extend(self.rng.permutation(indices).tolist())
            balanced.extend(repeated[:count])
        return self.rng.permutation(balanced).tolist()

    def _batch(self) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        samples = []
        for _ in range(self.config.batch_size):
            if self.cursor == len(self.order):
                self.order = self._new_order()
                self.cursor, self.epoch = 0, self.epoch + 1
            index = self.order[self.cursor]
            self.cursor += 1
            samples.append(self.dataset.load(index, self.config.patch_size,
                crop_seed=int(self.rng.integers(0, 2**63)),
                minimum_valid_fraction=self.config.minimum_valid_fraction))
        rgb = torch.from_numpy(np.stack([s[0] for s in samples])).to(self.device)
        mask = torch.from_numpy(np.stack([s[1] for s in samples])).to(self.device)
        condition = F.one_hot(torch.tensor([s[2] for s in samples], device=self.device),
                              len(self.dataset.conditions)).float()
        return rgb, mask, condition

    def checkpoint(self) -> Path:
        root = self.output / "checkpoints"
        existing = root / f"step-{self.step:09d}"
        if existing.exists():
            load_checkpoint(existing)
            result = existing
        else:
            result = save_checkpoint(root, {"step": self.step, "cursor": self.cursor,
                "epoch": self.epoch, "order": self.order, "sampler_rng": self.rng.bit_generator.state,
                "torch_rng": torch.get_rng_state(),
                "cuda_rng": torch.cuda.get_rng_state_all() if self.config.device == "cuda" else [],
                "model": self.model.state_dict(), "optimizer": self.optimizer.state_dict(),
                "baseline": self.baseline, "validation": self.last_validation,
                "loss_history": self.loss_history}, self.request)
        if self.mirror:
            mirror_checkpoint(result, self.mirror / "checkpoints")
            atomic_json(self.mirror / "request.json", self.request)
        return result

    @torch.no_grad()
    def evaluate(self, split: str = "val", *, freeze: Path | None = None,
                 training_diagnostic: bool = False) -> dict:
        if split not in ("val", "test") and not (split == "train" and training_diagnostic):
            raise ValueError("only held-out validation/test evaluation is supported")
        if split == "test":
            if freeze is None:
                raise ValueError("test images require an explicit frozen checkpoint receipt")
            frozen = json.loads(Path(freeze).read_text())
            checkpoint = self.output / "checkpoints" / f"step-{self.step:09d}"
            if (frozen.get("checkpoint_manifest_sha256") != digest(checkpoint / "manifest.json")
                    or frozen.get("dataset_manifest_sha256") != self.dataset.digest
                    or frozen.get("tuning_closed") is not True):
                raise ValueError("test freeze identity mismatch")
        ids = self.dataset.evaluation_indices(split, self.config.validation_limit)
        if not ids:
            raise ValueError(f"no {split} records available")
        self.model.eval()
        rows, posterior_means, posterior_logvars = [], [], []
        for index in ids:
            rgb, mask, condition_index = self.dataset.load(index, self.config.patch_size,
                minimum_valid_fraction=self.config.minimum_valid_fraction)
            x = torch.from_numpy(rgb[None]).to(self.device)
            m = torch.from_numpy(mask[None]).to(self.device)
            condition = F.one_hot(torch.tensor([condition_index], device=self.device), len(self.dataset.conditions)).float()
            prediction, mu, logvar = self.model(x, m, condition, sample=False)
            values = objective(prediction, x, m, mu, logvar, self.config)
            mean = torch.tensor(self.baseline["rgb"][condition_index], device=self.device)[None, :, None, None]
            baseline_mse = (((x - mean).square() * m).sum() / (3 * m.sum())).item()
            rows.append({"id": self.dataset.records[index]["id"], "group_id": self.dataset.records[index]["group_id"],
                         "condition": self.dataset.conditions[condition_index], "masked_mse": values["masked_mse"].item(),
                         "baseline_mse": baseline_mse, "kl": values["kl"].item()})
            posterior_means.append(mu.cpu().numpy()[0])
            posterior_logvars.append(logvar.cpu().numpy()[0])
        condition_metrics = {}
        for condition in sorted({row["condition"] for row in rows}):
            subset = [row for row in rows if row["condition"] == condition]
            condition_metrics[condition] = {key: float(np.mean([row[key] for row in subset]))
                                            for key in ("masked_mse", "baseline_mse", "kl")}
        # Fixed independent prior seeds avoid changing the training RNG stream.
        z = torch.from_numpy(np.random.default_rng(1181).standard_normal((8, self.config.latent_dim)).astype(np.float32)).to(self.device)
        coords = torch.linspace(0, 1, 16, device=self.device)
        v, u = torch.meshgrid(coords, coords, indexing="ij")
        uv = torch.stack((u, v), -1).reshape(1, -1, 2).expand(8, -1, -1)
        diversity = {}
        for index, name in enumerate(self.dataset.conditions):
            c = F.one_hot(torch.full((8,), index, device=self.device), len(self.dataset.conditions)).float()
            samples = self.model.decoder(z, c, uv)
            diversity[name] = float(samples.std(dim=0).mean().item())
        result = {"split": split, "evaluated_samples": len(rows), "available_samples": len(self.dataset.splits[split]),
                  "evaluated_groups": len({row["group_id"] for row in rows}), "per_condition": condition_metrics,
                  "macro_masked_mse": float(np.mean([x["masked_mse"] for x in condition_metrics.values()])),
                  "macro_baseline_mse": float(np.mean([x["baseline_mse"] for x in condition_metrics.values()])),
                  "posterior_mu_variance": float(np.var(np.stack(posterior_means), axis=0).mean()),
                  "posterior_mean_logvar": float(np.mean(posterior_logvars)),
                  "mean_kl": float(np.mean([row["kl"] for row in rows])),
                  "prior_rgb_std": diversity,
                  "interpretation": "posterior reconstruction and collapse diagnostics; not prior sample realism or PBR accuracy",
                  "qualification": "engineering_unqualified"}
        result["conditions_without_evaluated_support"] = sorted(set(self.dataset.conditions) - set(condition_metrics))
        result["beats_train_mean_baseline"] = result["macro_masked_mse"] < result["macro_baseline_mse"]
        if split == "train":
            result["interpretation"] = "in-sample training diagnostic only; no held-out generalization evidence"
        self.model.train()
        return result

    def fit(self, *, stop_after_updates: int | None = None) -> dict:
        stop = self.config.steps if stop_after_updates is None else stop_after_updates
        if type(stop) is not int or not self.step <= stop <= self.config.steps:
            raise ValueError("stop_after_updates is an absolute committed-update bound")
        if (self.output / "freeze.json").exists() and stop > self.step:
            raise ValueError("tuning is closed by the frozen-checkpoint receipt")
        self.status = "running"
        self.checkpoint()
        start = time.perf_counter()
        start_step = self.step
        if self.config.device == "cuda":
            torch.cuda.reset_peak_memory_stats()
        try:
            while self.step < stop:
                self.model.train()
                rgb, mask, condition = self._batch()
                self.optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type=self.config.device, dtype=torch.bfloat16,
                                    enabled=self.config.precision == "bfloat16"):
                    prediction, mu, logvar = self.model(rgb, mask, condition)
                    losses = objective(prediction, rgb, mask, mu, logvar, self.config)
                if not torch.isfinite(losses["loss"]):
                    raise ValueError("nonfinite loss; last complete checkpoint retained")
                losses["loss"].backward()
                norm = torch.nn.utils.clip_grad_norm_(self.model.parameters(), self.config.clip_grad,
                                                     error_if_nonfinite=True)
                self.optimizer.step()
                if not all(torch.isfinite(p).all() for p in self.model.parameters()):
                    raise ValueError("nonfinite parameters; last complete checkpoint retained")
                self.step += 1
                event = {"step": self.step, **{k: float(v.item()) for k, v in losses.items()},
                         "gradient_norm_before_clip": float(norm.item())}
                self.loss_history.append(event)
                self.loss_history = self.loss_history[-2000:]
                with (self.output / "metrics.jsonl").open("a") as handle:
                    handle.write(json.dumps(event, allow_nan=False) + "\n")
                if self.config.validation_mode == "heldout" and (
                        self.step % self.config.validation_every == 0 or self.step == self.config.steps):
                    self.last_validation = self.evaluate()
                    atomic_json(self.output / f"validation-{self.step:09d}.json", self.last_validation)
                if self.step % self.config.checkpoint_every == 0:
                    self.checkpoint()
            checkpoint = self.checkpoint()
            if self.config.device == "cuda":
                torch.cuda.synchronize()
            duration = time.perf_counter() - start
            self.status = "completed" if self.step == self.config.steps else "interrupted"
            receipt = {"status": self.status, "committed_updates": self.step,
                "updates_this_attempt": self.step - start_step, "wall_seconds": duration,
                "samples_per_wall_second": (self.step - start_step) * self.config.batch_size / max(duration, 1e-9),
                "batch_size": self.config.batch_size, "precision": self.config.precision,
                "peak_cuda_allocated_bytes": torch.cuda.max_memory_allocated() if self.config.device == "cuda" else None,
                "peak_cuda_reserved_bytes": torch.cuda.max_memory_reserved() if self.config.device == "cuda" else None,
                "environment": self.request["environment"], "checkpoint": str(checkpoint),
                "checkpoint_manifest_sha256": digest(checkpoint / "manifest.json"),
                "validation": self.last_validation, "qualification": "engineering_unqualified",
                "fixture": self.config.fixture}
            atomic_json(self.output / "training-receipt.json", receipt)
            if self.mirror:
                atomic_json(self.mirror / "training-receipt.json", receipt)
            return receipt
        except BaseException as error:
            self.status = "failed"
            atomic_json(self.output / "failure.json", {"status": "failed", "step": self.step,
                "error": type(error).__name__ + ": " + str(error),
                "recovery": "resume the last verified complete checkpoint; partial updates are not committed"})
            raise


def freeze_checkpoint(run: Path, dataset: TissueDataset) -> Path:
    path = latest_checkpoint(Path(run) / "checkpoints")
    _, request = load_checkpoint(path)
    if request["data"]["manifest_sha256"] != dataset.digest:
        raise ValueError("freeze dataset mismatch")
    output = Path(run) / "freeze.json"
    if output.exists():
        raise FileExistsError("freeze already exists; test-set decisions must not be silently overwritten")
    atomic_json(output, {"checkpoint_manifest_sha256": digest(path / "manifest.json"),
                        "dataset_manifest_sha256": dataset.digest, "tuning_closed": True})
    return output
