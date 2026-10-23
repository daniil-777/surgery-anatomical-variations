"""A separate 300→1000-update experiment, never an implicit long continuation."""

import math
from dataclasses import asdict, dataclass, field

from viscera_core.tissue_learning_conv.config import ConvConfig


@dataclass(frozen=True)
class RefineObjective:
    neighbor_weight: float = 0.02
    prior_frequency_weight: float = 0.02
    prior_palette_weight: float = 0.05
    charbonnier_epsilon: float = 0.01
    scale_floor: float = 1 / 255
    reference_limit: int = 384
    kernels: tuple[int, ...] = (3, 5, 9)
    gate_step: int = 300

    def __post_init__(self):
        for key in (
            "neighbor_weight",
            "prior_frequency_weight",
            "prior_palette_weight",
            "charbonnier_epsilon",
            "scale_floor",
        ):
            v = getattr(self, key)
            if isinstance(v, bool) or not math.isfinite(v) or not 0 < v <= 1:
                raise ValueError(f"invalid {key}")
        if self.kernels != (3, 5, 9):
            raise ValueError("fixed valid-window scales are 3/5/9")
        if type(self.reference_limit) is not int or not 2 <= self.reference_limit <= 2048:
            raise ValueError("invalid train-only reference bound")
        if type(self.gate_step) is not int or not 1 <= self.gate_step <= 300:
            raise ValueError("invalid diagnostic gate step")


@dataclass(frozen=True)
class RefineConfig:
    training: ConvConfig = field(
        default_factory=lambda: ConvConfig(
            steps=1000,
            seed=20261020,
            lr=5e-5,
            critic_lr=5e-5,
            critic_warmup_updates=0,
            validation_every=100,
        )
    )
    objective: RefineObjective = field(default_factory=RefineObjective)

    def __post_init__(self):
        if self.training.steps > 1000:
            raise ValueError(
                "objective pilot budget is at most1000; a longer experiment needs a new protocol"
            )
        if not self.training.fixture and self.objective.gate_step != 300:
            raise ValueError("research pilot requires explicit300-step review")
        if self.training.validation_mode != "heldout" or self.training.critic_warmup_updates != 0:
            raise ValueError("warm-start pilot requires held-out validation and active critic")

    def to_dict(self):
        return {"training": self.training.to_dict(), "objective": asdict(self.objective)}

    @classmethod
    def from_dict(cls, value):
        if set(value) != {"training", "objective"}:
            raise ValueError("expected training and objective configurations")
        objective = dict(value["objective"])
        if "kernels" in objective:
            objective["kernels"] = tuple(objective["kernels"])
        return cls(ConvConfig.from_dict(value["training"]), RefineObjective(**objective))
