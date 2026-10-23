"""Versioned configuration for a bounded, opt-in texture-detail experiment."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from viscera_core.tissue_learning.config import ExperimentConfig

# Eight orientations at each of three bands. Integer vectors preserve the unit
# torus; arbitrary Gaussian directions would break periodic value/derivative seams.
FOURIER_VECTORS = (
    (2, 0), (2, 1), (1, 1), (1, 2), (0, 2), (-1, 2), (-1, 1), (-2, 1),
    (8, 0), (7, 3), (6, 6), (3, 7), (0, 8), (-3, 7), (-6, 6), (-7, 3),
    (32, 0), (30, 12), (23, 23), (12, 30), (0, 32), (-12, 30), (-23, 23), (-30, 12),
)


@dataclass(frozen=True)
class DetailConfig:
    steps: int = 3000
    seed: int = 1923
    batch_size: int = 8
    patch_size: int = 128
    latent_dim: int = 64
    hidden_width: int = 160
    fourier_vectors: tuple[tuple[int, int], ...] = FOURIER_VECTORS
    lr: float = .0003
    weight_decay: float = .0001
    beta_kl: float = .001
    gradient_weight: float = .1
    clip_grad: float = 1.
    checkpoint_every: int = 100
    validation_every: int = 250
    validation_limit: int = 128
    baseline_limit_per_condition: int = 256
    precision: str = "bfloat16"
    device: str = "cuda"
    minimum_valid_fraction: float = .5
    commercial_only: bool = False
    fixture: bool = False
    validation_mode: str = "heldout"
    sampling: str = "condition_balanced"
    critic_width: int = 32
    critic_lr: float = .0001
    critic_weight: float = .01
    feature_matching_weight: float = .1
    critic_warmup_updates: int = 200
    critic_minimum_coverage: float = .75

    def __post_init__(self):
        shared = {key: value for key, value in asdict(self).items()
                  if key in ExperimentConfig.__dataclass_fields__}
        ExperimentConfig(**shared)  # Reuse proven scalar/finite bounds only.
        if self.patch_size != 128:
            raise ValueError("detail candidate requires native 128px patches")
        vectors = self.fourier_vectors
        if (not 1 <= len(vectors) <= 32 or len(set(vectors)) != len(vectors)
                or any(len(v) != 2 or any(type(x) is not int or abs(x) > 32 for x in v)
                       or v == (0, 0) or v[1] < 0 or (v[1] == 0 and v[0] < 0) for v in vectors)):
            raise ValueError("invalid bounded canonical integer Fourier vectors")
        if type(self.critic_width) is not int or not 4 <= self.critic_width <= 64:
            raise ValueError("invalid critic width")
        if type(self.critic_warmup_updates) is not int or not 0 <= self.critic_warmup_updates <= 1000:
            raise ValueError("invalid critic warmup")
        for key in ("critic_lr", "critic_weight", "feature_matching_weight", "critic_minimum_coverage"):
            value = getattr(self, key)
            if not math.isfinite(value) or not 0 < value <= 1:
                raise ValueError(f"invalid {key}")

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict):
        value = dict(value)
        if "fourier_vectors" in value:
            value["fourier_vectors"] = tuple(tuple(v) for v in value["fourier_vectors"])
        return cls(**value)
