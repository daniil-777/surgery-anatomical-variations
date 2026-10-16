"""Optional material-v2 serving adapter around the immutable atlas-v1 contract."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import (
    SerializationInfo,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)

from . import atlas_scene as legacy
from .atlas_materials import (
    MATERIAL_VERSION,
    SHADER_VERSION,
    MaterialRecipe,
    material_catalog,
    material_region_ids,
    resolve_material,
    sample_material,
)
from .atlas_surface_normals import NORMAL_FRAME_RELATIVE_THRESHOLD, repair_display_normals


class SurfaceAtlasSpec(legacy.AtlasSpec):
    material: MaterialRecipe | None = None

    @model_validator(mode="after")
    def material_mode(self) -> SurfaceAtlasSpec:
        if self.material is not None and self.appearance != "tissue":
            raise ValueError("Authored material requires tissue appearance")
        return self

    @model_serializer(mode="wrap")
    def serialize_material(
        self, handler: SerializerFunctionWrapHandler, info: SerializationInfo
    ) -> dict[str, Any]:
        result: dict[str, Any] = handler(self)
        if self.material is None:
            result.pop("material", None)
        return result

    def geometry_spec(self) -> legacy.AtlasSpec:
        return legacy.AtlasSpec.model_validate(self.model_dump(exclude={"material"}))


def catalog(root: str | Path) -> dict[str, Any]:
    result = legacy.catalog(root)
    result["materials"] = material_catalog()
    return result


def material_regions(template: Any) -> Any:
    return material_region_ids(template.component_ids, template.metadata["components"])


def realize(root: str | Path, spec: SurfaceAtlasSpec) -> dict[str, Any]:
    result = legacy.realize(root, spec.geometry_spec())
    if spec.material is None:
        return result
    template = legacy.get_template(root, spec.template_id)
    if spec.material.organ != template.metadata["organ"]:
        raise ValueError("Material organ must match the selected anatomy")
    regions = material_regions(template)
    fields = sample_material(spec.material, template.vertices_mm, region_ids=regions)
    resolved = resolve_material(spec.material)
    item = result["scene"]["organs"][0]
    normals, normal_repair = repair_display_normals(
        np.asarray(item["positions"]).reshape(-1, 3),
        np.asarray(item["indices"]).reshape(-1, 3),
        np.asarray(item["normals"]).reshape(-1, 3),
    )
    item["normals"] = normals.reshape(-1).tolist()
    result["scene"]["metadata"]["normal_repair"] = normal_repair
    if normal_repair["repaired_vertex_count"]:
        result["scene"]["metadata"]["display_normals"] = {
            **result["scene"]["metadata"]["display_normals"],
            "policy": normal_repair["policy"],
            "sha256": normal_repair["sha256"],
        }
    recipe = spec.material.model_dump()
    metadata = {
        "version": MATERIAL_VERSION,
        "shader_version": SHADER_VERSION,
        "display_normal_sha256": normal_repair["sha256"],
        "normal_frame_relative_threshold": NORMAL_FRAME_RELATIVE_THRESHOLD,
        "recipe": recipe,
        "resolved": resolved,
        "coordinate_space": "undeformed-template-mm",
        "geometry_modified": False,
        "evidence": "authored_procedural_design; optical_tissue_calibration_NOT_RUN",
    }
    binding = {
        "legacy_realized_id": result["spec"]["realized_id"],
        "display_normal_sha256": normal_repair["sha256"],
        "normal_frame_relative_threshold": NORMAL_FRAME_RELATIVE_THRESHOLD,
        "recipe": recipe,
        "resolved": resolved,
        "shader_version": SHADER_VERSION,
    }
    realized_id = hashlib.sha256(
        json.dumps(binding, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()
    bound = spec.model_copy(
        update={"template_sha256": result["spec"]["template_sha256"], "realized_id": realized_id}
    )
    item["colors"] = np.asarray(fields["rgb_srgb"]).reshape(-1).tolist()
    item["rest_positions"] = template.vertices_mm.reshape(-1).tolist()
    item["material_regions"] = regions.tolist()
    item["metadata"]["material_v2"] = metadata
    result["spec"] = bound.model_dump()
    result["scene"]["spec"] = bound.model_dump()
    result["scene"]["metadata"]["material_v2"] = metadata
    result["scene"]["metadata"]["realized_id"] = realized_id
    result["summary"]["material"] = {
        "version": MATERIAL_VERSION,
        "preset": spec.material.preset,
        "seed": spec.material.seed,
    }
    return result


def export_glb(root: str | Path, spec: SurfaceAtlasSpec, texture_resolution: int = 2048) -> bytes:
    if spec.material is None:
        return legacy.export_glb(root, spec.geometry_spec())
    if not spec.realized_id or not spec.template_sha256:
        raise ValueError("Export requires the bound spec of a displayed/generated specimen")
    result = realize(root, spec)
    if result["spec"]["realized_id"] != spec.realized_id:
        raise ValueError("Export recipe does not match the displayed specimen")
    from .atlas_material_bake import export_material_glb

    return export_material_glb(result, spec.material, texture_resolution)
