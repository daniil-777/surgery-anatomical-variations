"""Explicit spatial appearance experiment, independent of prior Fourier models."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from viscera_core.tissue_learning.config import ExperimentConfig


@dataclass(frozen=True)
class ConvConfig:
    steps: int = 6000
    seed: int = 1923
    batch_size: int = 16
    patch_size: int = 128
    latent_channels: int = 8
    latent_resolution: int = 8
    decoder_channels: tuple[int, ...] = (64, 48, 32, 16, 8)
    encoder_channels: tuple[int, ...] = (32, 64, 96, 96)
    lr: float = 0.0002
    weight_decay: float = 0.0001
    beta_kl: float = 0.005
    gradient_weight: float = 0.1
    clip_grad: float = 1.0
    checkpoint_every: int = 100
    validation_every: int = 500
    validation_limit: int = 128
    baseline_limit_per_condition: int = 256
    precision: str = "bfloat16"
    device: str = "cuda"
    minimum_valid_fraction: float = 0.5
    commercial_only: bool = False
    fixture: bool = False
    validation_mode: str = "heldout"
    sampling: str = "condition_balanced"
    critic_width: int = 32
    critic_lr: float = 0.0002
    critic_clip_grad: float = 10.0
    prior_adversarial_weight: float = 0.1
    posterior_adversarial_weight: float = 0.02
    feature_matching_weight: float = 0.05
    critic_warmup_updates: int = 100
    critic_minimum_coverage: float = 0.75

    @property
    def latent_dim(self):
        return self.latent_channels * self.latent_resolution**2

    def __post_init__(self):
        shared = {
            k: v for k, v in asdict(self).items() if k in ExperimentConfig.__dataclass_fields__
        }
        ExperimentConfig(**shared)
        if self.patch_size != 128 or self.latent_resolution != 8:
            raise ValueError("spatial candidate requires native128 and latent8x8")
        if type(self.latent_channels) is not int or not 2 <= self.latent_channels <= 16:
            raise ValueError("invalid bounded latent channels")
        for key, length in (("decoder_channels", 5), ("encoder_channels", 4)):
            widths = getattr(self, key)
            if len(widths) != length or any(
                type(v) is not int or not 4 <= v <= 128 for v in widths
            ):
                raise ValueError(f"invalid {key}")
        if type(self.critic_width) is not int or not 4 <= self.critic_width <= 64:
            raise ValueError("invalid critic width")
        if (
            type(self.critic_warmup_updates) is not int
            or not 0 <= self.critic_warmup_updates <= 1000
        ):
            raise ValueError("invalid critic warmup")
        for key in (
            "critic_lr",
            "prior_adversarial_weight",
            "posterior_adversarial_weight",
            "feature_matching_weight",
            "critic_minimum_coverage",
        ):
            value = getattr(self, key)
            if isinstance(value, bool) or not math.isfinite(value) or not 0 < value <= 1:
                raise ValueError(f"invalid {key}")
        if not math.isfinite(self.critic_clip_grad) or not 0 < self.critic_clip_grad <= 100:
            raise ValueError("invalid critic clipping")

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, value):
        value = dict(value)
        for key in ("decoder_channels", "encoder_channels"):
            if key in value:
                value[key] = tuple(value[key])
        return cls(**value)
