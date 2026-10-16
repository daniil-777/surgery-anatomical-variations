"""Strict pilot contracts, deliberately distinct from OrganSceneSpec v2.

The bounds below are authored design bounds, not human population statistics.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator

PARAMETER_KEYS = (
    "liver_width_mm",
    "liver_height_mm",
    "liver_depth_mm",
    "left_lobe_ratio",
    "inferior_concavity",
    "fissure_depth_mm",
    "gallbladder_length_mm",
    "gallbladder_radius_mm",
)
PARAMETER_BOUNDS = {
    "liver_width_mm": (190.0, 300.0),
    "liver_height_mm": (120.0, 190.0),
    "liver_depth_mm": (120.0, 200.0),
    "left_lobe_ratio": (0.30, 0.78),
    "inferior_concavity": (0.10, 0.55),
    "fissure_depth_mm": (2.0, 12.0),
    "gallbladder_length_mm": (55.0, 110.0),
    "gallbladder_radius_mm": (10.0, 22.0),
}
DEFAULT_PARAMETERS = {
    "liver_width_mm": 235.0,
    "liver_height_mm": 145.0,
    "liver_depth_mm": 125.0,
    "left_lobe_ratio": 0.48,
    "inferior_concavity": 0.30,
    "fissure_depth_mm": 7.0,
    "gallbladder_length_mm": 80.0,
    "gallbladder_radius_mm": 15.0,
}
CONDITION_KEYS = (
    "liver_volume_ml",
    "liver_width_mm",
    "liver_height_mm",
    "gallbladder_enclosed_ml",
    "gallbladder_length_mm",
)


class ShapeParameters(BaseModel):
    """Eight continuous controls of one authored construction recipe."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    liver_width_mm: float = Field(235.0, ge=190.0, le=300.0)
    liver_height_mm: float = Field(145.0, ge=120.0, le=190.0)
    liver_depth_mm: float = Field(125.0, ge=120.0, le=200.0)
    left_lobe_ratio: float = Field(0.48, ge=0.30, le=0.78)
    inferior_concavity: float = Field(0.30, ge=0.10, le=0.55)
    fissure_depth_mm: float = Field(7.0, ge=2.0, le=12.0)
    gallbladder_length_mm: float = Field(80.0, ge=55.0, le=110.0)
    gallbladder_radius_mm: float = Field(15.0, ge=10.0, le=22.0)


class SceneRequest(BaseModel):
    """Executable PilotSceneSpec request; unsupported keys fail validation."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    seed: int = Field(1234, ge=0, le=2**32 - 1, strict=True)
    title: str = Field("Original abdominal anatomy", max_length=120)
    parameters: ShapeParameters = Field(default_factory=lambda: ShapeParameters.model_validate({}))
    include_vessels: bool = True
    wall_thickness_mm: float = Field(1.5, ge=0.5, le=3.0)

    @model_validator(mode="after")
    def valid_wall(self) -> "SceneRequest":
        if self.wall_thickness_mm >= self.parameters.gallbladder_radius_mm * 0.3:
            raise ValueError("wall thickness must remain below 30% of the body radius")
        return self
