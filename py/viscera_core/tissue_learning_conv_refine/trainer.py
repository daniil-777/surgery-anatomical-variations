"""New objective identity with exact resume; frozen v3 model and runtime reused."""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from pathlib import Path

import numpy as np
import torch

from viscera_core.tissue_learning.checkpoint import atomic_json, digest, load_checkpoint
from viscera_core.tissue_learning.config import identity
from viscera_core.tissue_learning.model import objective
from viscera_core.tissue_learning.trainer import environment
from viscera_core.tissue_learning_conv.artifact import load_artifact, validate_artifact
from viscera_core.tissue_learning_conv.data import NativePatchDataset
from viscera_core.tissue_learning_conv.model import (
    ConvVAE,
    ProjectionPatchCritic,
    critic_hinge,
    critic_weights,
    masked_feature_matching,
    weighted_scores,
)
from viscera_core.tissue_learning_conv.trainer import ConvTrainer
from viscera_core.tissue_learning_conv.trainer import source_hashes as parent_source_hashes

from .config import RefineConfig
from .losses import neighbor_charbonnier, prior_matching
from .reference import build_reference


def source_hashes():
    return {
        **parent_source_hashes(),
        **{
            f"tissue_learning_conv_refine/{p.name}": digest(p)
            for p in sorted(Path(__file__).parent.glob("*.py"))
        },
    }


def verify_parent(checkpoint, model_path, expected_model_sha256, dataset, config):
    checkpoint, model_path = Path(checkpoint), Path(model_path)
    if digest(model_path) != expected_model_sha256:
        raise ValueError("parent model SHA mismatch")
    state, request = load_checkpoint(checkpoint)
    value = load_artifact(model_path)
    if (
        request.get("schema") != "viscera.tissue-conv-training-request/v1"
        or request.get("refinement")
        or state["step"] <= 0
        or not config.fixture
        and state["step"] != 6000
    ):
        raise ValueError("warm start must be original completed6000 conv checkpoint")
    if value["provenance"]["checkpoint_manifest_sha256"] != digest(checkpoint / "manifest.json"):
        raise ValueError("parent model/checkpoint binding differs")
    if (
        request["data"] != dataset.summary()
        or value["architecture"]["condition_labels"] != dataset.conditions
    ):
        raise ValueError("parent data/conditions differ; no silent new training split")
    for key in (
        "latent_channels",
        "latent_resolution",
        "decoder_channels",
        "encoder_channels",
        "critic_width",
    ):
        if identity(request["config"][key]) != identity(config.to_dict()[key]):
            raise ValueError("parent architecture differs")
    _, layers = validate_artifact(value)
    for i, arrays in enumerate(layers):
        for suffix, array in zip(("weight", "bias"), arrays):
            tensor = state["model"][f"decoder.layers.{i}.{suffix}"].numpy()
            if not np.array_equal(tensor, array):
                raise ValueError("parent exported decoder differs from full checkpoint")
    return (
        state,
        request,
        {
            "model_sha256": expected_model_sha256,
            "checkpoint_manifest_sha256": digest(checkpoint / "manifest.json"),
            "request_sha256": identity(request),
            "training_steps": state["step"],
            "dataset_manifest_sha256": request["data"]["manifest_sha256"],
        },
    )


class RefineTrainer(ConvTrainer):
    def __init__(
        self,
        dataset: NativePatchDataset,
        output: Path,
        config: RefineConfig,
        *,
        warm_start: Path,
        parent_model: Path,
        expected_parent_model_sha256: str,
        resume_from: Path | None = None,
        mirror: Path | None = None,
    ):
        self.pilot = config
        config = config.training
        parent_state, parent_request, parent = verify_parent(
            warm_start, parent_model, expected_parent_model_sha256, dataset, config
        )
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
        self.reference = build_reference(
            dataset, self.pilot.objective, config.minimum_valid_fraction
        )
        self.request["refinement"] = {
            "schema": "viscera.tissue-conv-objective-refinement/v1",
            "parent": parent,
            "objective": asdict(self.pilot.objective),
            "objective_sha256": identity(asdict(self.pilot.objective)),
            "reference": self.reference,
            "reference_sha256": self.reference["sha256"],
            "warm_start_policy": "model and critic including SN buffers; both optimizers reset; fresh sampler and CPU/CUDA RNG; new step zero",
            "gate": {
                "step": self.pilot.objective.gate_step,
                "maximum_updates": 1000,
                "requires_bound_quantitative_receipt_and_explicit_visual_review": True,
            },
        }
        self.request["objectives"] = (
            "masked posterior L1 + train-normalized neighbor Charbonnier + KL; "
            "unchanged conditional prior/posterior hinge critic and posterior feature matching; "
            "unpaired train-only prior fully-valid-window residual RMS matching and palette/contrast bounds"
        )
        self.model.load_state_dict(parent_state["model"], strict=True)
        self.critic.load_state_dict(parent_state["critic"], strict=True)
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
        atomic_json(self.output / "train-reference.json", self.reference)
        if self.mirror:
            atomic_json(self.mirror / "train-reference.json", self.reference)
        self.status = "ready"

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
            scales = torch.as_tensor(self.reference["neighbor_scale"], device=self.device)[
                condition.argmax(1)
            ]
            detail = neighbor_charbonnier(
                prediction, rgb, mask, scales, self.pilot.objective.charbonnier_epsilon
            )
            loss = (
                reconstruction
                + self.pilot.objective.neighbor_weight * detail
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
            frequency, palette, prior_statistics = prior_matching(
                prior.float(), mask, condition.argmax(1), self.reference, self.pilot.objective
            )
            loss = (
                loss
                + adversarial
                + self.config.feature_matching_weight * feature
                + self.pilot.objective.prior_frequency_weight * frequency
                + self.pilot.objective.prior_palette_weight * palette
            )
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
            "normalized_neighbor_charbonnier": float(detail.item()),
            "prior_frequency_match": float(frequency.item()),
            "prior_palette_bounds": float(palette.item()),
            "prior_frequency_supported_samples": (prior_statistics["support"] > 0).sum(0).tolist(),
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

    def fit(self, *, stop_after_updates=None, gate_receipt=None, visual_review=None):
        stop = self.config.steps if stop_after_updates is None else stop_after_updates
        milestone = self.pilot.objective.gate_step
        if stop > milestone:
            if self.step < milestone:
                raise ValueError("stop at the diagnostic gate before any continuation")
            from .diagnostics import validate_continuation

            review = validate_continuation(self, gate_receipt, visual_review)
            atomic_json(self.output / "continuation-review.json", review)
            if self.mirror:
                atomic_json(self.mirror / "continuation-review.json", review)
        if type(stop) is not int or not self.step <= stop <= self.config.steps:
            raise ValueError("invalid absolute update bound")
        if self.step == stop:
            checkpoint = self.checkpoint()
            checkpoint_sha = digest(checkpoint / "manifest.json")
            receipts = [self.output / "training-receipt.json"]
            if self.mirror:
                receipts.append(self.mirror / "training-receipt.json")
            recovered = None
            for path in receipts:
                if not path.exists():
                    continue
                value = json.loads(path.read_text())
                if value.get("committed_updates") != self.step:
                    continue
                if (
                    value.get("checkpoint_manifest_sha256") != checkpoint_sha
                    or value.get("batch_size") != self.config.batch_size
                    or value.get("precision") != self.config.precision
                ):
                    raise ValueError("existing completed-stage receipt differs from checkpoint")
                if recovered is not None and value != recovered:
                    raise ValueError("local and mirrored completed-stage receipts differ")
                recovered = value
            if recovered is not None:
                if self.step in (0, milestone, self.config.steps):
                    self.snapshot_priors()
                # Snapshot recovery must not turn the original measured training
                # duration into a zero-update rerun timing.
                for path in receipts:
                    if path.exists() and json.loads(path.read_text()) != recovered:
                        raise ValueError("preserve a different prior stage receipt explicitly")
                    atomic_json(path, recovered)
                self.status = recovered["status"]
                return recovered
        if self.step in (0, milestone, self.config.steps):
            self.snapshot_priors()
        result = super().fit(stop_after_updates=stop)
        if self.step in (milestone, self.config.steps):
            self.snapshot_priors()
        return result
