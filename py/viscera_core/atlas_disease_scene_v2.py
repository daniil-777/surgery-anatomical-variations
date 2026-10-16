"""Versioned disease adapter; legacy shape/material recipes retain their behavior."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Literal, cast

import numpy as np
import trimesh
from pydantic import SerializationInfo, SerializerFunctionWrapHandler, model_serializer

from . import atlas_surface_scene as surface
from .atlas import _geometry_hash
from .atlas_disease_v2 import (
    PROFILES,
    VERSION,
    DiseaseSpecV2,
    _source_cache,
    apply_disease_color,
    disease_catalog,
    disease_field,
    mesh_qa,
    source_safe_shape_controls,
    transform_points,
)
from .atlas_scene import get_template
from .atlas_surface_normals import repair_display_normals


class DiseaseAtlasSpecV2(surface.SurfaceAtlasSpec):
    renderer_version: Literal["disease-v2"]
    disease: DiseaseSpecV2 | None = None

    @model_serializer(mode="wrap")
    def serialize_disease(
        self, handler: SerializerFunctionWrapHandler, info: SerializationInfo
    ) -> dict[str, Any]:
        result: dict[str, Any] = handler(self)
        for key in ("material", "disease"):
            if getattr(self, key) is None:
                result.pop(key, None)
        return result

    def surface_spec(self) -> surface.SurfaceAtlasSpec:
        return surface.SurfaceAtlasSpec.model_validate(
            self.model_dump(exclude={"disease", "renderer_version"})
        )

    def geometry_spec(self) -> Any:
        return self.surface_spec().geometry_spec()


def catalog(root: str | Path) -> dict[str, Any]:
    result = surface.catalog(root)
    result["diseases"] = disease_catalog()
    return result


def realize(root: str | Path, spec: DiseaseAtlasSpecV2) -> dict[str, Any]:
    template = get_template(root, spec.template_id)
    requested_controls = dict(spec.controls)
    applied_controls, shape_fraction = source_safe_shape_controls(template, requested_controls)
    spec = spec.model_copy(update={"controls": applied_controls})
    result = surface.realize(root, spec.surface_spec())
    field = disease_field(template, spec.disease, spec.controls) if spec.disease else None
    faces = template.faces
    item = result["scene"]["organs"][0]
    baseline = np.asarray(item["positions"]).reshape(-1, 3)
    cache = _source_cache(template)
    vertices, normals = transform_points(
        template,
        spec.controls,
        template.vertices_mm,
        field,
        normals=cache["normals"],
        tree=cache["tree"],
    )
    qa = mesh_qa(template, vertices, field, spec.controls)
    if not qa["passed"]:
        raise ValueError(
            "Disease-v2 surface fails finite, nondegenerate or transported-face orientation QA"
        )
    normals, normal_repair = repair_display_normals(vertices, faces, normals)
    normal_meta = {
        "policy": "inverse-transpose-continuous-map-source-normal-v2",
        "sha256": normal_repair["sha256"],
    }
    applied_fraction = field["applied_displacement_fraction"] if field else 1.0
    item["positions"] = vertices.reshape(-1).tolist()
    item["normals"] = normals.reshape(-1).tolist()
    item["colors"] = (
        apply_disease_color(np.asarray(item["colors"]).reshape(-1, 3), template.vertices_mm, field)
        .reshape(-1)
        .tolist()
        if spec.appearance == "tissue" and field is not None
        else item["colors"]
    )
    if field is not None:
        item["metadata"]["disease_field"] = field
    # Material validation and normal-frame metadata must describe the actual new normals.
    if "material_v2" in item["metadata"]:
        item["metadata"]["material_v2"]["display_normal_sha256"] = normal_repair["sha256"]
    measurements = {
        **result["summary"]["measurements"],
        **dict(
            zip(
                ("extent_x_mm", "extent_y_mm", "extent_z_mm"),
                np.ptp(vertices, axis=0).tolist(),
                strict=True,
            )
        ),
        "surface_area_mm2": qa["surface_area_mm2"],
        "volume_ml": None,
        "compactness": None,
        "method": "disease-display-triangle-measurements-2.0.0",
    }
    bound = qa["continuous_jacobian_lower_bound"]
    recipe = spec.disease.model_dump(mode="json") if spec.disease else None
    disease_meta = {
        "version": VERSION,
        "renderer_version": "disease-v2",
        "recipe": recipe,
        "profile": PROFILES[spec.disease.profile_id] if spec.disease else None,
        "evidence": "synthetic_surface_morphology_not_patient_or_population_geometry",
        "max_displacement_mm": float(np.linalg.norm(vertices - baseline, axis=1).max()),
        "rms_displacement_mm": float(np.sqrt(np.mean((vertices - baseline) ** 2) * 3)),
        "requested_sites": field["requested_sites"] if field else 0,
        "realized_sites": field["realized_sites"] if field else 0,
        "applied_displacement_fraction": applied_fraction,
        "effective_morphology_strength": field["effective_morphology_strength"] if field else 0.0,
        "requested_morphology_strength": spec.disease.severity if spec.disease else 0.0,
        "displacement_limited_by_source_mesh": applied_fraction < 1,
        "source_precision_repair": template.metadata.get("precision_repair"),
        "shape_control_projection": {
            "policy": "shared deterministic all-precision source-face certification",
            "requested_controls": requested_controls,
            "applied_controls": applied_controls,
            "applied_fraction": shape_fraction,
        },
        "actual_strength_backoffs": field["discrete_guard"].get("actual_strength_backoffs", 0)
        if field and "discrete_guard" in field
        else 0,
        "internal_anatomy_generated": False,
        "physical_parameters_inferred": False,
        "severity_semantics": "authored strength, not clinical stage",
    }
    geometry_hash = _geometry_hash(vertices, faces)
    identity = {
        "surface_realized_id": result["spec"]["realized_id"],
        "disease": recipe,
        "field": field,
        "geometry": geometry_hash,
        "version": VERSION,
    }
    realized = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()
    bound_spec = spec.model_copy(
        update={"realized_id": realized, "template_sha256": result["spec"]["template_sha256"]}
    ).model_dump(mode="json")
    result["spec"] = bound_spec
    result["scene"]["spec"] = bound_spec
    result["scene"]["metadata"].update(
        disease=disease_meta,
        geometry_sha256=geometry_hash,
        realized_id=realized,
        qa=qa,
        measurements=measurements,
        display_normals=normal_meta,
        normal_repair=normal_repair,
    )
    result["summary"].update(
        disease=disease_meta,
        extent_mm=np.ptp(vertices, axis=0).tolist(),
        measurements=measurements,
        min_jacobian=bound,
        min_jacobian_kind="conservative_bound",
        qa_scope=qa["scope"],
    )
    return result


def export_glb(root: str | Path, spec: DiseaseAtlasSpecV2, texture_resolution: int = 2048) -> bytes:
    if not spec.realized_id or not spec.template_sha256:
        raise ValueError("Export requires the displayed, bound disease recipe")
    result = realize(root, spec)
    if result["spec"]["realized_id"] != spec.realized_id:
        raise ValueError("Export recipe does not match the displayed specimen")
    if spec.material is not None:
        from .atlas_material_bake import export_material_glb

        return export_material_glb(result, spec.material, texture_resolution)
    item = result["scene"]["organs"][0]
    mesh = trimesh.Trimesh(
        vertices=np.asarray(item["positions"]).reshape(-1, 3) / 1000,
        faces=np.asarray(item["indices"]).reshape(-1, 3),
        vertex_normals=np.asarray(item["normals"]).reshape(-1, 3),
        process=False,
    )
    rgb = np.asarray(item["colors"]).reshape(-1, 3)
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    mesh.visual = trimesh.visual.ColorVisuals(
        mesh=mesh,
        vertex_colors=np.c_[np.rint(linear * 255), np.full(len(rgb), 255)].astype(np.uint8),
    )
    appearance = item["metadata"]["appearance"]
    cast(Any, mesh.visual).material = trimesh.visual.material.PBRMaterial(  # type: ignore[no-untyped-call]
        name="Disease design display material",
        baseColorFactor=[255, 255, 255, 255],
        metallicFactor=0.0,
        roughnessFactor=appearance["roughness"],
        doubleSided=True,
    )
    scene = trimesh.Scene(mesh)
    scene.metadata.update(result["scene"]["metadata"])
    scene.metadata.update(
        spec=result["spec"],
        unit="m",
        source_unit="mm",
        export_scope="disease_surface_design_not_simulation_domain",
        coordinate_frame="glTF-Y-up",
        authoring_transform="gltf_position = authoring_position_mm / 1000",
        vertex_color_encoding="glTF linear RGB normalized uint8, rounded from authoring sRGB",
    )

    def finish(tree: dict[str, Any]) -> None:
        tree.setdefault("extensionsUsed", []).append("KHR_materials_clearcoat")
        for material in tree.get("materials", []):
            material.setdefault("extensions", {})["KHR_materials_clearcoat"] = {
                "clearcoatFactor": appearance["clearcoat"],
                "clearcoatRoughnessFactor": appearance["clearcoat_roughness"],
            }

    binary = trimesh.exchange.gltf.export_glb(scene, tree_postprocessor=finish)  # type: ignore[no-untyped-call]
    if not isinstance(binary, bytes):
        raise TypeError("GLB exporter did not return binary data")
    return binary


DiseaseAtlasSpec = DiseaseAtlasSpecV2
