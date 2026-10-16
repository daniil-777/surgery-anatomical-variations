"""Neutral mesh/bundle export with explicit units and freshly computed surface QA."""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any, Callable

import numpy as np
import trimesh
from viscera_core.geometry import mesh_metrics


def checked_mesh(item: dict[str, Any]) -> trimesh.Trimesh:
    if not isinstance(item, dict):
        raise ValueError("Each organ must be a mesh object")
    vertices = np.asarray(item["positions"], dtype=np.float64)
    indices = np.asarray(item["indices"], dtype=np.float64)
    if vertices.size > 1_800_000 or indices.size > 3_600_000:
        raise ValueError("Mesh exceeds local export limits")
    if vertices.ndim != 1 or indices.ndim != 1 or vertices.size % 3 or indices.size % 3:
        raise ValueError("Expected flat triangle/vertex arrays")
    if (
        not np.isfinite(vertices).all()
        or not np.isfinite(indices).all()
        or np.any(indices != np.floor(indices))
    ):
        raise ValueError("Mesh contains nonfinite values or noninteger indices")
    if np.max(np.abs(vertices), initial=0) > 10_000:
        raise ValueError("Mesh coordinates exceed the supported abdominal workspace")
    # Check before either int64 conversion here or int32 conversion in metrics.
    # Otherwise 2**32 + i wraps to a seemingly valid vertex in the QA routine.
    if indices.size and (indices.min() < 0 or indices.max() >= vertices.size // 3):
        raise ValueError("Mesh contains an out-of-range face index")
    faces = indices.astype(np.int64).reshape(-1, 3)
    points = vertices.reshape(-1, 3)
    metrics = mesh_metrics(points, faces)
    if (
        not metrics["watertight"]
        or metrics["degenerate_triangle_count"]
        or metrics["signed_volume_ml"] <= 0
    ):
        raise ValueError("Mesh failed the closed oriented surface export check")
    mesh = trimesh.Trimesh(vertices=points, faces=faces, process=False)
    if not mesh.is_winding_consistent:
        raise ValueError("Adjacent triangles have inconsistent winding")
    colors = np.asarray(item.get("colors", []), dtype=np.float64)
    if colors.size == vertices.size and np.isfinite(colors).all():
        vertex_colors = np.concatenate(
            (np.clip(colors.reshape(-1, 3), 0, 1) * 255, np.full((len(points), 1), 255)), axis=1
        ).astype(np.uint8)
        mesh.visual = trimesh.visual.ColorVisuals(mesh=mesh, vertex_colors=vertex_colors)
    mesh.metadata.update(units="mm", profile="development_preview", measurement=metrics)
    return mesh


def export_scene(scene: dict[str, Any], format_name: str) -> tuple[bytes, str, str]:
    organs = scene.get("organs", [])
    if not isinstance(organs, list) or not organs or len(organs) > 24:
        raise ValueError("Export requires 1–24 organs")
    if any(not isinstance(item, dict) for item in organs):
        raise ValueError("Each organ must be a mesh object")
    meshes = [
        (str(item.get("id", f"organ-{i}")), checked_mesh(item)) for i, item in enumerate(organs)
    ]
    if format_name == "glb":
        output = trimesh.Scene()
        for name, mesh in meshes:
            # RAS+ millimetres -> glTF Y-up metres; proper rotation preserves winding.
            mesh.apply_transform(
                np.asarray(
                    [[0.001, 0, 0, 0], [0, 0, 0.001, 0], [0, -0.001, 0, 0], [0, 0, 0, 1]],
                    dtype=np.float64,
                )
            )
            output.add_geometry(mesh, node_name=name, geom_name=name)
        output.metadata.update(
            profile="development_preview",
            source_units="mm",
            gltf_units="m",
            frame="Y_up",
            inverse_authoring_transform="RAS_mm=(1000*x,-1000*z,1000*y)",
        )
        export: Callable[..., object] = output.export
        binary = export(file_type="glb")
        if not isinstance(binary, bytes):
            raise ValueError("GLB exporter returned an unexpected artifact")
        return binary, "model/gltf-binary", "anatomy.glb"
    if format_name == "obj":
        output = trimesh.Scene()
        for name, mesh in meshes:
            output.add_geometry(mesh, node_name=name, geom_name=name)
        export_obj: Callable[..., object] = output.export
        text = export_obj(file_type="obj")
        if not isinstance(text, str):
            raise ValueError("OBJ exporter returned an unexpected artifact")
        return (
            ("# VISCERA authoring units: mm; development preview\n" + text).encode(),
            "text/plain",
            "anatomy-mm.obj",
        )
    if format_name != "viscera":
        raise ValueError("Supported formats: glb, obj, viscera")
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        manifest = {
            "bundle_version": "0.1.0",
            "profile": "development_preview",
            "units": "mm",
            "anatomical_review": "unreviewed",
            "simulation_verified": False,
            "organs": [name for name, _ in meshes],
            "intended_use": "Synthetic geometry authoring and research preview. No patient-specific or clinical claims.",
        }
        archive.writestr("manifest.json", json.dumps(manifest, indent=2))
        archive.writestr("scene.json", json.dumps(scene, separators=(",", ":"), allow_nan=False))
        archive.writestr("spec.json", json.dumps(scene.get("spec", {}), indent=2))
        for i, (name, mesh) in enumerate(meshes):
            # Numeric paths prevent user-supplied identifiers becoming archive paths.
            ply = mesh.export(file_type="ply")
            if not isinstance(ply, (str, bytes)):
                raise ValueError("PLY exporter returned an unexpected artifact")
            archive.writestr(f"organs/{i}/surface-mm.ply", ply)
            archive.writestr(
                f"organs/{i}/metadata.json", json.dumps({"id": name, **mesh.metadata}, indent=2)
            )
        archive.writestr(
            "dossier/README.txt",
            "Original procedural development preview.\nSurface checks are recorded per mesh.\nAnatomical review, self-intersection predicates, physical organ validation and engine calibration are NOT_RUN.\n",
        )
    return stream.getvalue(), "application/zip", "anatomy.viscera"
