"""Validated, independent surface appearance recipes; no adipose geometry dependencies."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import isfinite
from numbers import Integral, Real
from types import MappingProxyType

VERSION = "tissue-materials-0.2.1"


@dataclass(frozen=True)
class OrganProfile:
    label: str
    color: tuple[float, float, float]
    structure: str
    relief_mm: float
    thickness_mm: float
    roughness: float
    vascularity: float
    lobule_mm: float


# Art-directed appearance priors, NOT measured optical or anatomical properties.
ORGAN_PROFILES = MappingProxyType(
    {
        "liver": OrganProfile(
            "Liver capsule", (0.46, 0.20, 0.17), "capsule", 0.065, 2.3, 0.36, 0.32, 2.2
        ),
        "kidney": OrganProfile(
            "Kidney capsule", (0.51, 0.23, 0.22), "capsule", 0.055, 1.8, 0.32, 0.45, 1.5
        ),
        "heart": OrganProfile(
            "Heart / epicardium", (0.51, 0.25, 0.25), "muscle", 0.17, 2.4, 0.35, 0.92, 3.5
        ),
        "lung": OrganProfile("Lung pleura", (0.67, 0.43, 0.46), "lung", 0.13, 1.2, 0.40, 0.55, 4.8),
        "spleen": OrganProfile(
            "Spleen capsule", (0.38, 0.19, 0.26), "capsule", 0.075, 2.2, 0.38, 0.35, 2.0
        ),
        "stomach": OrganProfile(
            "Stomach serosa", (0.73, 0.46, 0.44), "serosa", 0.13, 1.8, 0.34, 0.78, 3.0
        ),
        "small_bowel": OrganProfile(
            "Small bowel serosa", (0.76, 0.49, 0.45), "serosa", 0.10, 0.85, 0.32, 0.92, 2.0
        ),
        "large_bowel": OrganProfile(
            "Large bowel serosa", (0.70, 0.47, 0.44), "serosa", 0.16, 1.4, 0.36, 0.72, 3.2
        ),
        "pancreas": OrganProfile(
            "Pancreas lobules", (0.74, 0.51, 0.40), "glandular", 0.32, 2.1, 0.44, 0.45, 3.8
        ),
        "gallbladder": OrganProfile(
            "Gallbladder serosa", (0.43, 0.48, 0.31), "serosa", 0.085, 0.7, 0.29, 0.65, 2.3
        ),
        "bladder": OrganProfile(
            "Bladder serosa", (0.77, 0.57, 0.52), "serosa", 0.10, 1.4, 0.35, 0.68, 3.0
        ),
        "uterus": OrganProfile(
            "Uterine serosa", (0.66, 0.39, 0.39), "muscle", 0.12, 2.2, 0.37, 0.70, 3.0
        ),
        "muscle": OrganProfile(
            "Exposed skeletal muscle", (0.54, 0.22, 0.23), "muscle", 0.20, 2.0, 0.45, 0.45, 3.0
        ),
        "fascia": OrganProfile(
            "Connective fascia", (0.83, 0.78, 0.69), "fascia", 0.11, 0.55, 0.43, 0.28, 3.0
        ),
        "peritoneum": OrganProfile(
            "Peritoneal membrane", (0.79, 0.61, 0.56), "fascia", 0.055, 0.45, 0.30, 0.75, 3.5
        ),
        "mesentery": OrganProfile(
            "Mesenteric connective tissue", (0.82, 0.66, 0.48), "fascia", 0.12, 0.8, 0.35, 1.0, 4.0
        ),
        "gastric_mucosa": OrganProfile(
            "Gastric mucosa", (0.78, 0.40, 0.36), "mucosa", 0.62, 1.5, 0.34, 0.45, 3.8
        ),
        "intestinal_mucosa": OrganProfile(
            "Small intestinal mucosa", (0.82, 0.49, 0.43), "villi", 0.33, 0.9, 0.40, 0.38, 1.1
        ),
        "colonic_mucosa": OrganProfile(
            "Colonic mucosa", (0.80, 0.47, 0.43), "mucosa", 0.25, 1.0, 0.34, 0.55, 2.5
        ),
    }
)


def finite_range(name: str, value: object, lower: float, upper: float) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a finite number in [{lower}, {upper}]")
    number = float(value)
    if not isfinite(number) or not lower <= number <= upper:
        raise ValueError(f"{name} must be a finite number in [{lower}, {upper}]")
    return number


@dataclass(frozen=True)
class TissueRecipe:
    organ: str = "liver"
    seed: int = 42
    tile_size_mm: float = 80.0
    vessel_opacity: float = 0.70
    fascia_opacity: float = 0.12
    adipose_opacity: float = 0.0
    wetness: float = 0.80
    detail: float = 1.0
    transition_organ: str | None = None
    transition_width: float = 0.16

    def __post_init__(self) -> None:
        if not isinstance(self.organ, str) or self.organ not in ORGAN_PROFILES:
            raise ValueError(f"organ must be one of {', '.join(ORGAN_PROFILES)}")
        if self.transition_organ is not None and (
            not isinstance(self.transition_organ, str)
            or self.transition_organ not in ORGAN_PROFILES
        ):
            raise ValueError("transition_organ must name a supported surface family or be None")
        if isinstance(self.seed, bool) or not isinstance(self.seed, Integral):
            raise ValueError("seed must be a uint64 integer")
        if not 0 <= int(self.seed) <= 2**64 - 1:
            raise ValueError("seed must be a uint64 integer")
        object.__setattr__(self, "seed", int(self.seed))
        for name in ("vessel_opacity", "fascia_opacity", "adipose_opacity", "wetness"):
            object.__setattr__(self, name, finite_range(name, getattr(self, name), 0, 1))
        object.__setattr__(
            self, "tile_size_mm", finite_range("tile_size_mm", self.tile_size_mm, 10, 500)
        )
        object.__setattr__(self, "detail", finite_range("detail", self.detail, 0, 2))
        object.__setattr__(
            self,
            "transition_width",
            finite_range("transition_width", self.transition_width, 0.02, 0.4),
        )

    def to_dict(self) -> dict:
        return asdict(self)
