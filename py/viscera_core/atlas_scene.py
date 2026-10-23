"""Typed atlas requests, material realization and source-bound display exports."""

from __future__ import annotations

import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, cast

import numpy as np
import trimesh
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .atlas import (
    CONTROL_NAMES,
    DEFORMER_VERSION,
    AtlasTemplate,
    generate,
    list_templates,
    load_template,
)
from .atlas_appearance import APPEARANCE_VERSION, appearance


class AtlasSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    template_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9-]+$")
    seed: int = Field(default=42, ge=0, le=2**32 - 1, strict=True)
    controls: dict[str, float] = Field(default_factory=lambda: {k: 0.0 for k in CONTROL_NAMES})
    appearance: Literal["tissue", "source", "clay"] = "tissue"
    template_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    realized_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @field_validator("controls", mode="before")
    @classmethod
    def valid_controls(cls, v: Any) -> dict[str, float]:
        if not isinstance(v, dict) or set(v) - set(CONTROL_NAMES):
            raise ValueError("Unknown atlas shape controls")
        if any(
            isinstance(a, bool)
            or not isinstance(a, (int, float))
            or not -1 <= a <= 1
            for a in v.values()
        ):
            raise ValueError("Shape controls must be finite numbers in [-1,1]")
        return {k: float(v.get(k, 0.0)) for k in CONTROL_NAMES}


@lru_cache(maxsize=32)
def _cached_template(
    root: str, template_id: str, metadata_mtime: int, artifact_mtime: int, artifact_size: int
) -> AtlasTemplate:
    return load_template(root, template_id)


def get_template(root: str | Path, template_id: str) -> AtlasTemplate:
    p = Path(root)
    if not template_id or any(
        c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in template_id
    ):
        raise ValueError("Invalid template ID")
    meta = p / f"{template_id}.json"
    if not meta.is_file():
        raise KeyError(f"Template {template_id} is unavailable")
    artifact = (p / f"{template_id}.npz").stat()
    return _cached_template(
        str(p.resolve()),
        template_id,
        meta.stat().st_mtime_ns,
        artifact.st_mtime_ns,
        artifact.st_size,
    )


def catalog(root: str | Path) -> dict[str, Any]:
    templates = list_templates(root)
    order = [
        "liver",
        "gallbladder",
        "stomach",
        "pancreas",
        "spleen",
        "kidney",
        "small-intestine",
        "large-intestine",
        "heart",
        "lung",
        "brain",
        "urinary-bladder",
    ]
    organs = []
    for organ in order:
        entries = []
        for t in sorted(templates, key=lambda x: x["template_id"]):
            if t["organ"] != organ:
                continue
            label = t["sex_label"].title() + " reference"
            if t.get("laterality"):
                label += " · " + t["laterality"].title()
            entries.append(
                {
                    "id": t["template_id"],
                    "label": label,
                    "source": t["source_collection"],
                    "license": t["license"],
                    "source_url": t["source_url"],
                    "template_sha256": t["artifact_sha256"],
                    "vertices": t["vertex_count"],
                    "triangles": t["face_count"],
                    "control_limits": t["control_limits"],
                }
            )
        if entries:
            organs.append(
                {
                    "id": organ,
                    "label": "Lungs" if organ == "lung" else organ.replace("-", " ").title(),
                    "templates": entries,
                }
            )
    labels = ["Width", "Height", "Depth", "Bend", "Twist", "Taper", "Asymmetry"]
    descriptions = [
        "Scale along template X",
        "Scale along template Y",
        "Scale along template Z",
        "Smooth centerline bend",
        "Gentle axial twist",
        "Progressive change in cross-section",
        "Smooth asymmetric shear",
    ]
    return {
        "organs": organs,
        "controls": [
            {"key": k, "label": label, "min": -1, "max": 1, "default": 0, "description": desc}
            for k, label, desc in zip(CONTROL_NAMES, labels, descriptions, strict=True)
        ],
        "release": {
            "generator_version": DEFORMER_VERSION,
            "appearance_version": APPEARANCE_VERSION,
            "template_count": len(templates),
            "organ_count": len(organs),
            "profile": "development_preview",
            "coordinate_frame": "atlas-Y-up-centered-mm",
            "review_status": "unreviewed",
        },
    }


def display_normals(vertices: Any, faces: Any, organ: str) -> tuple[Any, dict[str, Any]]:
    """Smooth coincident lung segment seams on an audit copy; preserve original geometry."""
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    if organ == "lung":
        _, first, inverse = np.unique(
            np.round(v, 8), axis=0, return_index=True, return_inverse=True
        )
        audit = trimesh.Trimesh(vertices=v[first], faces=inverse[f], process=False)
        normals = np.asarray(audit.vertex_normals)[inverse]
        policy = "coincident-lung-segment-normals-1.0.0"
    else:
        mesh = trimesh.Trimesh(vertices=v, faces=f, process=False)
        normals = np.asarray(mesh.vertex_normals)
        policy = "source-indexed-trimesh-vertex-normals-1.0.0"
    return normals, {
        "policy": policy,
        "sha256": hashlib.sha256(np.asarray(normals, dtype="<f4").tobytes()).hexdigest(),
        "hash_encoding": "little-endian-float32-xyz",
        "geometry_modified": False,
        "weld_precision_mm": 1e-8 if organ == "lung" else None,
    }


def realize(root: str | Path, spec: AtlasSpec) -> dict[str, Any]:
    template = get_template(root, spec.template_id)
    meta = template.metadata
    if spec.template_sha256 is not None and spec.template_sha256 != meta["artifact_sha256"]:
        raise ValueError(
            "Reference template changed; reload the reference before generating/exporting"
        )
    sample = generate(template, spec.controls, spec.seed)
    if not sample.qa["passed"]:
        raise ValueError("Requested design failed the scoped geometry checks")
    color, mat = appearance(
        meta["organ"],
        template.vertices_mm,
        template.colors,
        spec.seed,
        spec.appearance,
        template.component_ids,
        meta["components"],
    )
    normals, normal_meta = display_normals(sample.vertices_mm, sample.faces, meta["organ"])
    realized = hashlib.sha256(
        (sample.metadata["geometry_sha256"] + APPEARANCE_VERSION + spec.appearance).encode()
        + np.asarray(color, dtype="<f4").tobytes()
    ).hexdigest()
    if meta["organ"] == "lung":
        realized = hashlib.sha256(
            (realized + normal_meta["policy"] + normal_meta["sha256"]).encode()
        ).hexdigest()
    result_spec = spec.model_copy(
        update={"template_sha256": meta["artifact_sha256"], "realized_id": realized}
    )
    scene = {
        "schemaVersion": "atlas-scene-1.0.0",
        "spec": result_spec.model_dump(),
        "organs": [
            {
                "id": meta["organ"],
                "name": meta["organ"].replace("-", " ").title(),
                "kind": "organ",
                "positions": sample.vertices_mm.reshape(-1).tolist(),
                "indices": sample.faces.reshape(-1).tolist(),
                "normals": normals.reshape(-1).tolist(),
                "colors": color.reshape(-1).tolist(),
                "color": "#a37e6f",
                "metadata": {
                    "appearance": mat,
                    "component_count": len(meta["components"]),
                    "template_id": spec.template_id,
                },
            }
        ],
        "metadata": {
            "profile": "development_preview",
            "unit": "mm",
            "coordinate_frame": "atlas-Y-up-centered-mm",
            "geometry_sha256": sample.metadata["geometry_sha256"],
            "display_normals": normal_meta,
            "realized_id": realized,
            "generator_version": DEFORMER_VERSION,
            "appearance": mat,
            "source": {
                "collection": meta["source_collection"],
                "url": meta["source_url"],
                "license": meta["license"],
                "attribution": meta["attribution"],
                "source_sha256": meta["source_sha256"],
                "template_sha256": meta["artifact_sha256"],
                "source_group_id": meta["source_group_id"],
            },
            "qa": sample.qa,
            "measurements": sample.measurements,
            "review_status": "unreviewed",
        },
    }
    return {
        "scene": scene,
        "spec": result_spec.model_dump(),
        "summary": {
            "organ": meta["organ"],
            "reference": spec.template_id,
            "vertices": len(sample.vertices_mm),
            "triangles": len(sample.faces),
            "extent_mm": [
                sample.measurements[k] for k in ("extent_x_mm", "extent_y_mm", "extent_z_mm")
            ],
            "measurements": sample.measurements,
            "min_jacobian": sample.qa["min_jacobian"],
            "qa_status": sample.qa["status"],
            "qa_scope": sample.qa["scope"],
            "review_status": "unreviewed",
            "profile": "development_preview",
        },
    }


def export_glb(root: str | Path, spec: AtlasSpec) -> bytes:
    if not spec.realized_id or not spec.template_sha256:
        raise ValueError("Export requires the bound spec of a displayed/generated specimen")
    result = realize(root, spec)
    if result["spec"]["realized_id"] != spec.realized_id:
        raise ValueError("Export recipe does not match the displayed specimen")
    item = result["scene"]["organs"][0]
    mesh = trimesh.Trimesh(
        vertices=np.array(item["positions"]).reshape(-1, 3) / 1000,
        faces=np.array(item["indices"]).reshape(-1, 3),
        vertex_normals=np.array(item["normals"]).reshape(-1, 3),
        process=False,
    )
    srgb = np.array(item["colors"]).reshape(-1, 3)
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    rgba = np.column_stack((np.rint(linear * 255), np.full(len(mesh.vertices), 255))).astype(
        np.uint8
    )
    mesh.visual = trimesh.visual.ColorVisuals(mesh=mesh, vertex_colors=rgba)
    material = item["metadata"]["appearance"]
    cast(Any, mesh.visual).material = cast(Any, trimesh.visual.material.PBRMaterial)(
        name="Atlas authored display material",
        baseColorFactor=[255, 255, 255, 255],
        metallicFactor=0.0,
        roughnessFactor=material["roughness"],
        doubleSided=True,
    )
    mesh.metadata.update(
        {"source_unit": "mm", "unit": "m", "profile": "development_preview", "appearance": material}
    )
    output = trimesh.Scene(mesh)
    output.metadata.update(result["scene"]["metadata"])
    output.metadata.update(
        {
            "unit": "m",
            "coordinate_frame": "glTF-Y-up",
            "source_unit": "mm",
            "authoring_transform": "gltf_position = authoring_position_mm / 1000",
            "spec": result["spec"],
            "export_scope": "visual_surface_not_simulation_domain",
            "vertex_color_encoding": "glTF linear RGB normalized uint8, rounded from authoring sRGB",
        }
    )

    def finish_gltf(tree: dict[str, Any]) -> None:
        tree.setdefault("extensionsUsed", []).append("KHR_materials_clearcoat")
        for entry in tree.get("materials", []):
            entry.setdefault("extensions", {})["KHR_materials_clearcoat"] = {
                "clearcoatFactor": material["clearcoat"],
                "clearcoatRoughnessFactor": material["clearcoat_roughness"],
            }

    binary = cast(Any, trimesh.exchange.gltf.export_glb)(output, tree_postprocessor=finish_gltf)
    if not isinstance(binary, bytes):
        raise ValueError("GLB exporter returned no binary")
    return binary
