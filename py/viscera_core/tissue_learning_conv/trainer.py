"""Isolated two-optimizer training; every committed checkpoint includes critic/RNG."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

from viscera_core.tissue_learning.checkpoint import (
    atomic_json,
    digest,
    load_checkpoint,
    mirror_checkpoint,
    save_checkpoint,
)
from viscera_core.tissue_learning.config import identity
from viscera_core.tissue_learning.model import objective
from viscera_core.tissue_learning.trainer import Trainer as BaselineTrainer
from viscera_core.tissue_learning.trainer import environment

from .config import ConvConfig
from .data import NativePatchDataset
from .model import (
    ConvVAE,
    ProjectionPatchCritic,
    critic_hinge,
    critic_weights,
    masked_feature_matching,
    weighted_scores,
)

PRIOR_SNAPSHOT_STEPS = (1000, 3000, 6000)


def source_hashes():
    parent = Path(__file__).parent
    return {
        f"{directory.name}/{path.name}": digest(path)
        for directory in (
            parent.parent / "tissue_learning",
            parent.parent / "tissue_learning_detail",
            parent,
        )
        for path in sorted(directory.glob("*.py"))
    }


class ConvTrainer(BaselineTrainer):
    """Reuse only reviewed sampler, baseline and held-out metric helpers from v1.

    Initialization, optimizer steps, checkpoints and source identities are separate.
    NativePatchDataset owns decoding and never resizes a source frame on a draw.
    """

    def __init__(
        self,
        dataset: NativePatchDataset,
        output: Path,
        config: ConvConfig,
        *,
        resume_from: Path | None = None,
        mirror: Path | None = None,
    ):
        if not isinstance(dataset, NativePatchDataset):
            raise TypeError("detail experiment requires an explicit native-patch dataset")
        self.dataset, self.output, self.config = dataset, Path(output), config
        self.mirror = Path(mirror) if mirror else None
        if config.validation_mode == "heldout" and not dataset.splits["val"]:
            raise ValueError("independent validation support required")
        if (
            any(row["group_level"] == "synthetic_fixture" for row in dataset.records)
            and not config.fixture
        ):
            raise ValueError("synthetic fixtures must retain fixture provenance")
        if config.device == "cuda" and not torch.cuda.is_available():
            raise ValueError("CUDA unavailable; no silent CPU fallback")
        if (
            config.device == "cuda"
            and config.precision == "bfloat16"
            and not torch.cuda.is_bf16_supported()
        ):
            raise ValueError("BF16 unavailable")
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        torch.use_deterministic_algorithms(True)
        torch.set_num_threads(1)
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.manual_seed(config.seed)
        self.device = torch.device(config.device)
        self.model = ConvVAE(config, len(dataset.conditions)).to(self.device)
        self.critic = ProjectionPatchCritic(len(dataset.conditions), config.critic_width).to(
            self.device
        )
        self.optimizer = torch.optim.AdamW(
            self.model.parameters(), lr=config.lr, weight_decay=config.weight_decay
        )
        self.critic_optimizer = torch.optim.AdamW(
            self.critic.parameters(),
            lr=config.critic_lr,
            weight_decay=config.weight_decay,
            betas=(0.0, 0.9),
        )
        self.request = {
            "schema": "viscera.tissue-conv-training-request/v1",
            "model_type": "masked-rgb-spatial-cvae-gan-v1",
            "config": config.to_dict(),
            "config_sha256": identity(config.to_dict()),
            "data": dataset.summary(),
            "source_sha256": source_hashes(),
            "environment": environment(config.device),
            "condition_regions": dataset.condition_regions,
            "condition_species": dataset.condition_species,
            "preprocessing": {
                "revision": "native-128-dihedral-v1",
                "native_source_pixels": [128, 128],
                "resize": "none",
                "training_augmentation": "seeded right-angle rotations and horizontal flip",
                "evaluation_augmentation": "none",
                "invalid_encoder_and_critic_fill": 0.5,
                "critic_receptive_field_pixels": 23,
                "critic_score_stride": 4,
                "critic_mask_policy": "same real/fake mask; score weighted by native receptive-field coverage",
            },
            "objectives": "masked posterior L1 + valid-neighbor MSE + KL; spatial latent, circular resize-convolution decoder; projection SN hinge critic weighted .75 prior/.25 posterior; separate prior/posterior adversarial weights; actual-RF masked posterior feature matching",
            "qualification": "engineering_unqualified",
        }
        self.step, self.cursor, self.epoch = 0, 0, 0
        self.loss_history = []
        self.last_validation = {}
        self.rng = np.random.default_rng(config.seed)
        self.order = self._new_order()
        self.output.mkdir(parents=True, exist_ok=True)
        if resume_from:
            state, request = load_checkpoint(resume_from)
            if identity(request) != identity(self.request):
                raise ValueError("detail resume source/data/config/runtime identity mismatch")
            self.model.load_state_dict(state["model"], strict=True)
            self.critic.load_state_dict(state["critic"], strict=True)
            self.optimizer.load_state_dict(state["optimizer"])
            self.critic_optimizer.load_state_dict(state["critic_optimizer"])
            self.step, self.cursor, self.epoch = state["step"], state["cursor"], state["epoch"]
            self.order, self.baseline = state["order"], state["baseline"]
            self.last_validation, self.loss_history = state["validation"], state["loss_history"]
            self.rng.bit_generator.state = state["sampler_rng"]
            torch.set_rng_state(state["torch_rng"])
            if config.device == "cuda":
                torch.cuda.set_rng_state_all(state["cuda_rng"])
        else:
            if (self.output / "request.json").exists() or (
                self.output / "checkpoints/latest.json"
            ).exists():
                raise FileExistsError("resume explicitly or choose a new detail run directory")
            self.baseline = self._training_baseline()
        atomic_json(self.output / "request.json", self.request)
        self.status = "ready"

    def checkpoint(self):
        destination = self.output / "checkpoints" / f"step-{self.step:09d}"
        if destination.exists():
            state, request = load_checkpoint(destination)
            if identity(request) != identity(self.request) or state["step"] != self.step:
                raise ValueError("existing detail checkpoint differs")
        else:
            destination = save_checkpoint(
                self.output / "checkpoints",
                {
                    "step": self.step,
                    "cursor": self.cursor,
                    "epoch": self.epoch,
                    "order": self.order,
                    "sampler_rng": self.rng.bit_generator.state,
                    "torch_rng": torch.get_rng_state(),
                    "cuda_rng": torch.cuda.get_rng_state_all()
                    if self.config.device == "cuda"
                    else [],
                    "model": self.model.state_dict(),
                    "critic": self.critic.state_dict(),
                    "optimizer": self.optimizer.state_dict(),
                    "critic_optimizer": self.critic_optimizer.state_dict(),
                    "baseline": self.baseline,
                    "validation": self.last_validation,
                    "loss_history": self.loss_history,
                },
                self.request,
            )
        if self.mirror:
            mirror_checkpoint(destination, self.mirror / "checkpoints")
            atomic_json(self.mirror / "request.json", self.request)
        return destination

    def update(self):
        rgb, mask, condition = self._batch()
        weights = critic_weights(mask, self.config.critic_minimum_coverage)
        if (weights.sum((1, 2, 3)) <= 0).any():
            raise ValueError(
                "native crop lacks a valid critic field; fix preparation, never silently skip"
            )
        self.model.train()
        self.optimizer.zero_grad(set_to_none=True)
        active = self.step >= self.config.critic_warmup_updates
        with torch.autocast(
            device_type=self.config.device,
            dtype=torch.bfloat16,
            enabled=self.config.precision == "bfloat16",
        ):
            prediction, mu, logvar = self.model(rgb, mask, condition)
            measurements = objective(prediction, rgb, mask, mu, logvar, self.config)
            reconstruction = (
                ((prediction.float() - rgb).abs() * mask).sum((1, 2, 3)) / (3 * mask.sum((1, 2, 3)))
            ).mean()
            loss = (
                reconstruction
                + self.config.gradient_weight * measurements["valid_neighbor_mse"]
                + self.config.beta_kl * measurements["kl"]
            )
            prior = self.model.decode_patch(torch.randn_like(mu), condition) if active else None
        critic_loss = torch.zeros((), device=self.device)
        adversarial = torch.zeros((), device=self.device)
        prior_adversarial = torch.zeros((), device=self.device)
        posterior_adversarial = torch.zeros((), device=self.device)
        critic_scores = {}
        feature = torch.zeros((), device=self.device)
        critic_norm = torch.zeros((), device=self.device)
        if active:
            self.critic.train()
            self.critic.requires_grad_(True)
            self.critic_optimizer.zero_grad(set_to_none=True)
            # Critic runs float32 to keep spectral normalization and hinge stable;
            # generator AMP outputs are explicitly converted without detaching G.
            real, _ = self.critic(rgb, mask, condition)
            fake, _ = self.critic(prediction.detach().float(), mask, condition)
            sampled, _ = self.critic(prior.detach().float(), mask, condition)
            critic_loss = critic_hinge(real, fake, sampled, weights)
            if not torch.isfinite(critic_loss):
                raise ValueError("nonfinite critic loss")
            critic_loss.backward()
            critic_norm = torch.nn.utils.clip_grad_norm_(
                self.critic.parameters(), self.config.critic_clip_grad, error_if_nonfinite=True
            )
            self.critic_optimizer.step()
            self.critic.eval()  # Freeze spectral-norm buffers during the G update.
            self.critic.requires_grad_(False)
            with torch.no_grad():
                real, real_features = self.critic(rgb, mask, condition)
            fake, fake_features = self.critic(prediction.float(), mask, condition)
            sampled, _ = self.critic(prior.float(), mask, condition)
            posterior_adversarial = -weighted_scores(fake, weights)
            prior_adversarial = -weighted_scores(sampled, weights)
            adversarial = (
                self.config.prior_adversarial_weight * prior_adversarial
                + self.config.posterior_adversarial_weight * posterior_adversarial
            )
            feature = masked_feature_matching(
                fake_features, real_features, mask, self.config.critic_minimum_coverage
            )
            loss = loss + adversarial + self.config.feature_matching_weight * feature
            critic_scores = {
                "critic_real_score": float(weighted_scores(real.detach(), weights)),
                "critic_posterior_score": float(weighted_scores(fake.detach(), weights)),
                "critic_prior_score": float(weighted_scores(sampled.detach(), weights)),
            }
        if not torch.isfinite(loss):
            raise ValueError("nonfinite generator loss")
        loss.backward()
        norm = torch.nn.utils.clip_grad_norm_(
            self.model.parameters(), self.config.clip_grad, error_if_nonfinite=True
        )
        self.optimizer.step()
        self.critic.requires_grad_(True)
        if not all(
            torch.isfinite(value).all()
            for module in (self.model, self.critic)
            for value in module.state_dict().values()
            if value.is_floating_point()
        ):
            raise ValueError("nonfinite model/critic state; last complete checkpoint retained")
        return {
            "loss": float(loss.item()),
            "masked_l1": float(reconstruction.item()),
            **{
                key: float(measurements[key].item())
                for key in ("masked_mse", "valid_neighbor_mse", "kl")
            },
            "critic_hinge": float(critic_loss.item()),
            "generator_adversarial": float(adversarial.item()),
            "feature_matching": float(feature.item()),
            "critic_active": active,
            "prior_generator_adversarial": float(prior_adversarial.item()),
            "posterior_generator_adversarial": float(posterior_adversarial.item()),
            "weighted_prior_adversarial": float(prior_adversarial.item())
            * self.config.prior_adversarial_weight,
            "weighted_posterior_adversarial": float(posterior_adversarial.item())
            * self.config.posterior_adversarial_weight,
            "generator_clipped": bool(norm > self.config.clip_grad),
            "critic_clipped": bool(critic_norm > self.config.critic_clip_grad),
            **critic_scores,
            "gradient_norm_before_clip": float(norm.item()),
            "critic_gradient_norm_before_clip": float(critic_norm.item()),
            "minimum_critic_valid_fields": int((weights > 0).sum((1, 2, 3)).min().item()),
        }

    @torch.no_grad()
    def evaluate(
        self, split: str = "val", *, freeze: Path | None = None, training_diagnostic: bool = False
    ) -> dict:
        if split not in ("val", "test") and not (split == "train" and training_diagnostic):
            raise ValueError("only held-out validation/test evaluation is supported")
        if split == "test":
            raise ValueError(
                "test payload evaluation requires a separately frozen native test preparation"
            )
        ids = self.dataset.evaluation_indices(split, self.config.validation_limit)
        if not ids:
            raise ValueError(f"no {split} records available")
        self.model.eval()
        rows, posterior_means, posterior_logvars = [], [], []
        for index in ids:
            rgb, mask, condition_index = self.dataset.load(
                index,
                self.config.patch_size,
                minimum_valid_fraction=self.config.minimum_valid_fraction,
            )
            x = torch.from_numpy(rgb[None]).to(self.device)
            m = torch.from_numpy(mask[None]).to(self.device)
            condition = F.one_hot(
                torch.tensor([condition_index], device=self.device), len(self.dataset.conditions)
            ).float()
            prediction, mu, logvar = self.model(x, m, condition, sample=False)
            values = objective(prediction, x, m, mu, logvar, self.config)
            mean = torch.tensor(self.baseline["rgb"][condition_index], device=self.device)[
                None, :, None, None
            ]
            baseline_mse = (((x - mean).square() * m).sum() / (3 * m.sum())).item()
            rows.append(
                {
                    "id": self.dataset.records[index]["id"],
                    "group_id": self.dataset.records[index]["group_id"],
                    "condition": self.dataset.conditions[condition_index],
                    "masked_mse": values["masked_mse"].item(),
                    "baseline_mse": baseline_mse,
                    "kl": values["kl"].item(),
                }
            )
            posterior_means.append(mu.cpu().numpy()[0])
            posterior_logvars.append(logvar.cpu().numpy()[0])
        condition_metrics = {}
        for condition in sorted({row["condition"] for row in rows}):
            subset = [row for row in rows if row["condition"] == condition]
            condition_metrics[condition] = {
                key: float(np.mean([row[key] for row in subset]))
                for key in ("masked_mse", "baseline_mse", "kl")
            }
        # Fixed independent prior seeds avoid changing the training RNG stream.
        z = torch.from_numpy(
            np.random.default_rng(1181)
            .standard_normal((8, self.config.latent_dim))
            .astype(np.float32)
        ).to(self.device)
        diversity = {}
        for index, name in enumerate(self.dataset.conditions):
            c = F.one_hot(
                torch.full((8,), index, device=self.device), len(self.dataset.conditions)
            ).float()
            samples = self.model.decoder(z, c)
            diversity[name] = float(samples.std(dim=0).mean().item())
        result = {
            "split": split,
            "evaluated_samples": len(rows),
            "available_samples": len(self.dataset.splits[split]),
            "evaluated_groups": len({row["group_id"] for row in rows}),
            "per_condition": condition_metrics,
            "macro_masked_mse": float(
                np.mean([x["masked_mse"] for x in condition_metrics.values()])
            ),
            "macro_baseline_mse": float(
                np.mean([x["baseline_mse"] for x in condition_metrics.values()])
            ),
            "posterior_mu_variance": float(np.var(np.stack(posterior_means), axis=0).mean()),
            "posterior_mean_logvar": float(np.mean(posterior_logvars)),
            "mean_kl": float(np.mean([row["kl"] for row in rows])),
            "prior_rgb_std": diversity,
            "interpretation": "posterior reconstruction and collapse diagnostics; not prior sample realism or PBR accuracy",
            "qualification": "engineering_unqualified",
        }
        result["conditions_without_evaluated_support"] = sorted(
            set(self.dataset.conditions) - set(condition_metrics)
        )
        result["beats_train_mean_baseline"] = (
            result["macro_masked_mse"] < result["macro_baseline_mse"]
        )
        if split == "train":
            result["interpretation"] = (
                "in-sample training diagnostic only; no held-out generalization evidence"
            )
        self.model.train()
        return result

    def fit(self, *, stop_after_updates=None):
        stop = self.config.steps if stop_after_updates is None else stop_after_updates
        if type(stop) is not int or not self.step <= stop <= self.config.steps:
            raise ValueError("invalid absolute update bound")
        if (self.output / "freeze.json").exists() and stop > self.step:
            raise ValueError("tuning closed by frozen checkpoint")
        self.status = "running"
        checkpoint = self.checkpoint()
        start_step, start = self.step, time.perf_counter()
        if self.config.device == "cuda":
            torch.cuda.reset_peak_memory_stats()
        try:
            # A checkpoint may commit immediately before an interrupted snapshot.
            # Recover that milestone before advancing or reporting completion.
            if self.step in PRIOR_SNAPSHOT_STEPS:
                self.snapshot_priors()
            while self.step < stop:
                event = self.update()
                self.step += 1
                event["step"] = self.step
                self.loss_history.append(event)
                self.loss_history = self.loss_history[-10000:]
                with (self.output / "metrics.jsonl").open("a") as handle:
                    handle.write(json.dumps(event, allow_nan=False) + "\n")
                if self.config.validation_mode == "heldout" and (
                    self.step % self.config.validation_every == 0 or self.step == stop
                ):
                    self.last_validation = self.evaluate()
                if self.step in PRIOR_SNAPSHOT_STEPS:
                    checkpoint = self.checkpoint()
                    self.snapshot_priors()
                if self.step % self.config.checkpoint_every == 0 or self.step == stop:
                    checkpoint = self.checkpoint()
                    if self.config.device == "cuda":
                        torch.cuda.synchronize()
                    print(
                        json.dumps(
                            {
                                "step": self.step,
                                "budget_updates": self.config.steps,
                                "elapsed_seconds": time.perf_counter() - start,
                                **event,
                            }
                        ),
                        flush=True,
                    )
            if self.step in PRIOR_SNAPSHOT_STEPS:
                self.snapshot_priors()
            if self.config.device == "cuda":
                torch.cuda.synchronize()
            duration = time.perf_counter() - start
            self.status = "completed" if self.step == self.config.steps else "interrupted"
            result = {
                "status": self.status,
                "committed_updates": self.step,
                "updates_this_attempt": self.step - start_step,
                "wall_seconds": duration,
                "samples_per_wall_second": (self.step - start_step)
                * self.config.batch_size
                / max(duration, 1e-9),
                "batch_size": self.config.batch_size,
                "precision": self.config.precision,
                "peak_cuda_allocated_bytes": torch.cuda.max_memory_allocated()
                if self.config.device == "cuda"
                else None,
                "peak_cuda_reserved_bytes": torch.cuda.max_memory_reserved()
                if self.config.device == "cuda"
                else None,
                "environment": self.request["environment"],
                "checkpoint": str(checkpoint),
                "checkpoint_manifest_sha256": digest(checkpoint / "manifest.json"),
                "validation": self.last_validation,
                "qualification": "engineering_unqualified",
                "fixture": self.config.fixture,
            }
            atomic_json(self.output / "training-receipt.json", result)
            if self.mirror:
                atomic_json(self.mirror / "training-receipt.json", result)
            return result
        except BaseException as error:
            self.status = "failed"
            atomic_json(
                self.output / "failure.json",
                {
                    "error": str(error),
                    "last_in_memory_step": self.step,
                    "last_complete_checkpoint": str(checkpoint),
                    "resume_from_complete_checkpoint_only": True,
                },
            )
            raise

    @torch.no_grad()
    def snapshot_priors(self):
        """Publish complete fixed-prior tiles, recovering interrupted writes safely."""
        import tempfile

        from PIL import Image

        from viscera_core.tissue_learning.artifact import seed_latent
        from viscera_core.tissue_learning.portable import (
            complete_result,
            completed_result,
            mirror_completed_result,
            prepare_result_attempt,
        )

        checkpoint = self.checkpoint()
        destination = self.output / "prior-snapshots" / f"step-{self.step:09d}"
        target = self.mirror / "prior-snapshots" / destination.name if self.mirror else None
        snapshot_identity = {
            "kind": "native-conv-prior-snapshot-v1",
            "step": self.step,
            "checkpoint_manifest_sha256": digest(checkpoint / "manifest.json"),
            "request_sha256": identity(self.request),
            "seed": "42",
            "native_resolution": [128, 128],
            "inference_precision": "float32; TF32 disabled",
        }
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not prepare_result_attempt(destination, snapshot_identity):
            if target and completed_result(target, snapshot_identity):
                # A fresh VM can recover the exact verified Drive result instead
                # of decoding it again or changing a previously reviewed image.
                mirror_completed_result(target, destination, snapshot_identity)
            else:
                stage = Path(tempfile.mkdtemp(prefix=".snapshot-", dir=destination.parent))
                was_training = self.model.training
                cudnn_tf32 = torch.backends.cudnn.allow_tf32
                matmul_tf32 = torch.backends.cuda.matmul.allow_tf32
                try:
                    self.model.eval()
                    torch.backends.cudnn.allow_tf32 = False
                    torch.backends.cuda.matmul.allow_tf32 = False
                    latent = torch.from_numpy(seed_latent(42, self.config.latent_dim)[None]).to(
                        self.device
                    )
                    files = {}
                    with torch.autocast(device_type=self.config.device, enabled=False):
                        for index, _ in enumerate(self.dataset.conditions):
                            c = F.one_hot(
                                torch.tensor([index], device=self.device),
                                len(self.dataset.conditions),
                            ).float()
                            rgb = self.model.decoder(latent, c)[0].permute(1, 2, 0).cpu().numpy()
                            path = stage / f"condition-{index}-seed42-native128.png"
                            Image.fromarray(
                                np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
                            ).save(path)
                            files[path.name] = {
                                "sha256": digest(path),
                                "bytes": path.stat().st_size,
                            }
                    atomic_json(
                        stage / "receipt.json",
                        {
                            **snapshot_identity,
                            "files": files,
                            "qualification": "engineering_unqualified",
                        },
                    )
                    complete_result(stage, snapshot_identity)
                    stage.rename(destination)
                finally:
                    # Failed staging directories are deliberately preserved;
                    # absence of a published completion marker triggers recovery.
                    self.model.train(was_training)
                    torch.backends.cudnn.allow_tf32 = cudnn_tf32
                    torch.backends.cuda.matmul.allow_tf32 = matmul_tf32
        if target:
            mirror_completed_result(destination, target, snapshot_identity)
        return json.loads((destination / "receipt.json").read_text())
