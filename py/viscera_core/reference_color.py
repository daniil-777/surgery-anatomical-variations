"""Observed-image colour transfer; never inverse optics or organ recognition.

Oklab matrices: Björn Ottosson, https://bottosson.github.io/posts/oklab/
(public-domain implementation). All public RGB values are normalized sRGB.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator

UnitFloat = Annotated[float, Field(ge=0, le=1, strict=True)]


class ReferenceColor(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)
    version: Literal["reference-color-1"] = "reference-color-1"
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    mask_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    organ: str = Field(min_length=1, max_length=64)
    observed_srgb: tuple[UnitFloat, UnitFloat, UnitFloat]
    strength: UnitFloat = 1.0
    mode: Literal["chroma", "color"] = "chroma"

    @field_validator("observed_srgb", mode="before")
    @classmethod
    def numeric_rgb(cls, value: Any) -> Any:
        if not isinstance(value, (list, tuple)) or len(value) != 3 or any(
            isinstance(v, bool) or not isinstance(v, (float, int)) for v in value
        ):
            raise ValueError("Reference colour needs three numeric sRGB channels")
        return value


_M1 = np.array([[.4122214708, .5363325363, .0514459929],
                [.2119034982, .6806995451, .1073969566],
                [.0883024619, .2817188376, .6299787005]])
_M2 = np.array([[.2104542553, .7936177850, -.0040720468],
                [1.9779984951, -2.4285922050, .4505937099],
                [.0259040371, .7827717662, -.8086757660]])
_I1, _I2 = np.linalg.inv(_M1), np.linalg.inv(_M2)


def to_linear(rgb: Any) -> np.ndarray:
    x = np.asarray(rgb, dtype=np.float64)
    return np.where(x <= .04045, x / 12.92, ((x + .055) / 1.055) ** 2.4)


def from_linear(rgb: Any) -> np.ndarray:
    x = np.clip(np.asarray(rgb, dtype=np.float64), 0, 1)
    return np.where(x <= .0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - .055)


def to_oklab(rgb: Any) -> np.ndarray:
    return np.cbrt(to_linear(rgb) @ _M1.T) @ _M2.T


def oklab_linear(lab: Any) -> np.ndarray:
    return (np.asarray(lab, dtype=np.float64) @ _I2.T) ** 3 @ _I1.T


def gamut_srgb(lab: Any) -> np.ndarray:
    """Compress chroma at fixed lightness/hue instead of clipping RGB channels."""
    value = np.asarray(lab, dtype=np.float64).copy()
    value[..., 0] = np.clip(value[..., 0], 0, 1)
    low = np.zeros(value.shape[:-1])
    high = np.ones_like(low)
    for _ in range(24):
        scale = (low + high) / 2
        candidate = value.copy()
        candidate[..., 1:] *= scale[..., None]
        linear = oklab_linear(candidate)
        valid = np.all((linear >= -1e-9) & (linear <= 1 + 1e-9), axis=-1)
        low, high = np.where(valid, scale, low), np.where(valid, high, scale)
    # Preserve in-gamut inputs exactly, including fully neutral values.
    raw = oklab_linear(value)
    scale = np.where(np.all((raw >= 0) & (raw <= 1), axis=-1), 1., low)
    value[..., 1:] *= scale[..., None]
    return from_linear(oklab_linear(value))


def transfer_base_color(base_srgb: Any, reference: ReferenceColor) -> np.ndarray:
    base = np.asarray(base_srgb, dtype=np.float64)
    if reference.strength == 0:
        return base.copy()
    old = to_oklab(base)
    target = to_oklab(reference.observed_srgb)
    if reference.mode == "chroma":
        target[0] = old[0]
    return gamut_srgb(old + reference.strength * (target - old))
