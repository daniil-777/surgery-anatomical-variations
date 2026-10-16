"""Versioned disease adapter; legacy shape/material recipes retain their behavior."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, cast

import numpy as np
import trimesh
from pydantic import SerializationInfo, SerializerFunctionWrapHandler, model_serializer

from . import atlas_surface_scene as surface
from .atlas import CONTROL_NAMES, _geometry_hash, deform_vertices
from .atlas_disease import (
    PROFILES,
    VERSION,
    DiseaseSpec,
    apply_disease_color,
    deform_disease,
    disease_catalog,
    disease_field,
)
from .atlas_scene import display_normals, get_template
from .atlas_surface_normals import repair_display_normals


class DiseaseAtlasSpec(surface.SurfaceAtlasSpec):
    disease: DiseaseSpec | None = None

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
        return surface.SurfaceAtlasSpec.model_validate(self.model_dump(exclude={"disease"}))

    def geometry_spec(self) -> Any:
        return self.surface_spec().geometry_spec()


def catalog(root: str | Path) -> dict[str, Any]:
    result = surface.catalog(root)
    result["diseases"] = disease_catalog()
    return result


def realize(root: str | Path, spec: DiseaseAtlasSpec) -> dict[str, Any]:
    result = surface.realize(root, spec.surface_spec())
    if spec.disease is None:
        return result
    template = get_template(root, spec.template_id)
    field = disease_field(template, spec.disease)
    faces = template.faces
    item = result["scene"]["organs"][0]
    baseline = np.asarray(item["positions"]).reshape(-1, 3)

    def cross(v: Any) -> np.ndarray:
        tri = v[faces]
        return np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])

    old_cross = cross(baseline)
    old_area = np.linalg.norm(old_cross, axis=1)
    valid = old_area > 2e-12
    applied_fraction = 1.0
    for attempt in range(9):
        disease_vertices = deform_disease(template.vertices_mm, field)
        vertices = deform_vertices(
            disease_vertices,
            spec.controls,
            template.metadata["control_limits"],
            template.metadata["normalization_mm"],
        )
        new_cross = cross(vertices)
        new_area = np.linalg.norm(new_cross, axis=1)
        area_ratio = new_area[valid] / old_area[valid]
        dot = np.einsum("ij,ij->i", old_cross[valid], new_cross[valid]) / np.maximum(
            old_area[valid] * new_area[valid], 1e-300
        )
        if (
            np.isfinite(vertices).all()
            and not np.any(new_area[valid] <= 2e-12)
            and not np.any(dot <= 0)
        ):
            break
        # Source tessellation can violate a chord-based face check even when the
        # continuous map is invertible. Reduce displacement, never repair/delete
        # source faces; record the applied fraction in the exported provenance.
        if attempt < 8:
            applied_fraction *= 0.5
            for site in field["fields"]:
                site["amplitude_mm"] *= 0.5
            field["gradient_bound_per_step"] *= 0.5
    else:
        raise ValueError(
            "Disease design introduces a degenerate or reversed face; reduce strength/region size"
        )
    field["applied_displacement_fraction"] = applied_fraction
    normals, normal_meta = display_normals(vertices, faces, template.metadata["organ"])
    normals, normal_repair = repair_display_normals(vertices, faces, normals)
    if normal_repair["repaired_vertex_count"]:
        normal_meta = {
            **normal_meta,
            "policy": normal_repair["policy"],
            "sha256": normal_repair["sha256"],
        }
    item["positions"] = vertices.reshape(-1).tolist()
    item["normals"] = normals.reshape(-1).tolist()
    item["colors"] = (
        apply_disease_color(np.asarray(item["colors"]).reshape(-1, 3), template.vertices_mm, field)
        .reshape(-1)
        .tolist()
        if spec.appearance == "tissue"
        else item["colors"]
    )
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
        "surface_area_mm2": float(new_area.sum() / 2),
        "method": "disease-display-triangle-measurements-1.0.0",
    }
    coefficients = (
        np.array([spec.controls[k] for k in CONTROL_NAMES]) * template.metadata["control_limits"]
    )
    # Global atlas determinant: exp(sum(scale) + 2*taper*tanh(z)); shears and
    # twist have determinant one. Use |tanh|<=1, not samples at mesh vertices.
    atlas_lower = np.exp(coefficients[:3].sum() - 2 * abs(coefficients[5]))
    bound = float(atlas_lower * (1 - field["gradient_bound_per_step"]) ** (3 * field["steps"]))
    qa = {
        "passed": True,
        "status": "PASS",
        "scope": "finite nondegenerate same-topology outer-surface design",
        "topology_preserved": True,
        "new_degenerate_faces": 0,
        "normal_turns_over_90_degrees": 0,
        "area_ratio_min": float(area_ratio.min()),
        "area_ratio_max": float(area_ratio.max()),
        "min_normal_dot": float(dot.min()),
        "continuous_jacobian_lower_bound": bound,
        "source_topology": template.metadata.get("topology_audit", {}),
        "self_intersection": {
            "status": "NOT_RUN",
            "reason": "Discrete/source triangle intersections not certified",
        },
        "anatomical_plausibility": {"status": "NOT_RUN"},
        "mechanical_validation": {"status": "NOT_RUN"},
    }
    recipe = spec.disease.model_dump(mode="json")
    disease_meta = {
        "version": VERSION,
        "recipe": recipe,
        "profile": PROFILES[spec.disease.profile_id],
        "evidence": "synthetic_surface_morphology_not_patient_or_population_geometry",
        "max_displacement_mm": float(np.linalg.norm(vertices - baseline, axis=1).max()),
        "requested_sites": field["requested_sites"],
        "realized_sites": field["realized_sites"],
        "applied_displacement_fraction": applied_fraction,
        "displacement_limited_by_source_mesh": applied_fraction < 1,
        "internal_anatomy_generated": False,
        "physical_parameters_inferred": False,
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


def export_glb(root: str | Path, spec: DiseaseAtlasSpec, texture_resolution: int = 2048) -> bytes:
    if spec.disease is None:
        return surface.export_glb(root, spec.surface_spec(), texture_resolution)
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
