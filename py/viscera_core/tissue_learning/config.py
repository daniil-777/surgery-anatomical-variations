"""Inert, serializable scientific configuration for a fixed training budget."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def identity(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


@dataclass(frozen=True)
class ExperimentConfig:
    steps: int = 2000
    seed: int = 1923
    batch_size: int = 8
    patch_size: int = 128
    latent_dim: int = 32
    hidden_width: int = 96
    frequencies: tuple[int, ...] = (1, 2, 4, 8, 16, 32)
    lr: float = 0.0003
    weight_decay: float = 0.0001
    beta_kl: float = 0.001
    gradient_weight: float = 0.1
    clip_grad: float = 1.0
    checkpoint_every: int = 100
    validation_every: int = 100
    validation_limit: int = 128
    baseline_limit_per_condition: int = 256
    precision: str = "float32"
    device: str = "cpu"
    minimum_valid_fraction: float = 0.15
    commercial_only: bool = True
    fixture: bool = False
    validation_mode: str = "heldout"
    sampling: str = "shuffled"

    def __post_init__(self) -> None:
        for name, low, high in (("steps", 1, 10_000_000), ("seed", 0, 2**64 - 1),
                                ("batch_size", 1, 1024), ("latent_dim", 2, 128),
                                ("hidden_width", 8, 256), ("checkpoint_every", 1, 1_000_000),
                                ("validation_every", 1, 1_000_000), ("validation_limit", 1, 100_000),
                                ("baseline_limit_per_condition", 1, 100_000)):
            value = getattr(self, name)
            if type(value) is not int or not low <= value <= high:
                raise ValueError(f"invalid {name}")
        if self.patch_size not in (16, 32, 64, 128, 256, 512):
            raise ValueError("patch_size must be a supported power of two")
        if (not self.frequencies or len(self.frequencies) > 10
                or any(type(f) is not int or not 1 <= f <= 128 for f in self.frequencies)
                or tuple(sorted(set(self.frequencies))) != tuple(self.frequencies)):
            raise ValueError("frequencies must be sorted unique positive integers <= 128")
        if 2 * max(self.frequencies) >= self.patch_size:
            raise ValueError("training Fourier frequencies must be below the patch Nyquist limit")
        for name in ("lr", "weight_decay", "beta_kl", "gradient_weight", "clip_grad",
                     "minimum_valid_fraction"):
            value = getattr(self, name)
            if isinstance(value, bool) or not math.isfinite(value) or value < 0:
                raise ValueError(f"invalid {name}")
        if self.lr == 0 or self.clip_grad == 0 or not 0 < self.minimum_valid_fraction <= 1:
            raise ValueError("learning rate, clipping and mask coverage must be positive")
        if self.device not in ("cpu", "cuda") or self.precision not in ("float32", "bfloat16"):
            raise ValueError("supported profiles: CPU float32 or CUDA float32/bfloat16")
        if self.device == "cpu" and self.precision != "float32":
            raise ValueError("CPU exact-resume profile requires float32")
        if self.validation_mode not in ("heldout", "training_only"):
            raise ValueError("invalid explicit validation mode")
        if self.sampling not in ("shuffled", "condition_balanced"):
            raise ValueError("invalid sampling policy")

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict) -> ExperimentConfig:
        value = dict(value)
        if "frequencies" in value:
            value["frequencies"] = tuple(value["frequencies"])
        return cls(**value)
