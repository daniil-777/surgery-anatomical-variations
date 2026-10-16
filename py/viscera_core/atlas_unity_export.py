"""Unity-ready, source-preserving mesh and explicitly packed PBR texture bundles."""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
import trimesh
from PIL import Image

from .atlas_material_bake import _bake_maps, _bake_slot, _unit
from .atlas_materials import MaterialRecipe, resolve_material
from .atlas_surface_normals import repair_display_normals

VERSION = "viscera-unity-1.0.0"


def apply_surface_edits(result: dict[str, Any], edits: list[dict[str, Any]]) -> None:
    """Accept coordinates for known meshes only; topology and rest coordinates stay fixed."""
    organs = {item["id"]: item for item in result["scene"]["organs"]}
    seen: set[str] = set()
    for edit in edits:
        name = edit["organ_id"]
        if name not in organs or name in seen:
            raise ValueError("Surface edit references an unknown or duplicate organ")
        seen.add(name)
        item = organs[name]
        original = np.asarray(item["positions"], dtype=np.float64).reshape(-1, 3)
        raw = np.asarray(edit["positions"], dtype=np.float64)
        if raw.ndim != 1 or raw.size != original.size or not np.isfinite(raw).all():
            raise ValueError("Surface edit must contain one finite position per source vertex")
        positions = raw.reshape(-1, 3)
        if np.max(np.abs(positions), initial=0) > 10_000:
            raise ValueError("Surface edit exceeds the supported millimetre workspace")
        faces = np.asarray(item["indices"], dtype=np.int64).reshape(-1, 3)
        tri, old = positions[faces], original[faces]
        cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        old_cross = np.cross(old[:, 1] - old[:, 0], old[:, 2] - old[:, 0])
        area = np.linalg.norm(cross, axis=1)
        old_area = np.linalg.norm(old_cross, axis=1)
        if np.any(area <= np.maximum(old_area * 1e-5, 1e-18)):
            raise ValueError("Surface edit collapses source faces")
        if np.any(np.einsum("ij,ij->i", cross, old_cross) <= 0):
            raise ValueError("Surface edit reverses a face relative to the displayed specimen")
        # Match the live sculpture's area-weighted geometry normals. Preserve
        # otherwise unused vertices but never emit invalid referenced normals.
        normals = np.zeros_like(positions)
        for corner in range(3):
            np.add.at(normals, faces[:, corner], cross)
        normals, repair = repair_display_normals(positions, faces, _unit(normals))
        item["positions"] = positions.reshape(-1).tolist()
        item["normals"] = normals.reshape(-1).tolist()
        meta = {
            "version": "surface-coordinate-edit-1.0.0",
            "source_vertex_count": len(positions),
            "topology_preserved": True,
            "rest_material_coordinates_preserved": True,
            "max_displacement_mm": float(np.linalg.norm(positions - original, axis=1).max()),
            "positions_sha256": hashlib.sha256(positions.astype("<f4").tobytes()).hexdigest(),
            "normal_policy": "area-weighted, source topology, repaired invalid normals",
            "normal_repair": repair,
            "self_intersection_test": "NOT_RUN",
            "mechanical_validation": "NOT_RUN",
        }
        item.setdefault("metadata", {})["surface_edit"] = meta
        result["scene"]["metadata"].setdefault("surface_edits", {})[name] = meta
        from .atlas import _geometry_hash

        scene_metadata = result["scene"]["metadata"]
        for key in ("geometry_sha256", "measurements", "qa"):
            if key in scene_metadata:
                scene_metadata.setdefault("source_" + key, scene_metadata[key])
        scene_metadata["geometry_sha256"] = _geometry_hash(positions, faces)
        scene_metadata["measurements"] = {
            "extent_mm": np.ptp(positions, axis=0).tolist(),
            "surface_area_mm2": float(area.sum() * 0.5),
            "method": "edited-surface-triangle-measurements",
        }
        scene_metadata["qa"] = {
            "passed": True,
            "scope": "finite, source-topology surface edit; no new collapsed/reversed faces",
            "self_intersection": "NOT_RUN",
            "mechanical_validation": "NOT_RUN",
        }


def bind_surface_vessels(result: dict[str, Any], bindings: list[dict[str, Any]]) -> None:
    from .atlas_surface_vessels import validate_network

    organs = {item["id"]: item for item in result["scene"]["organs"]}
    seen: set[str] = set()
    for binding in bindings:
        name = binding["organ_id"]
        if name not in organs or name in seen:
            raise ValueError("Surface vessels reference an unknown or duplicate organ")
        seen.add(name)
        network = validate_network(binding["network"])
        item = organs[name]
        rest = np.asarray(item.get("rest_positions", [])).reshape(-1, 3)
        faces = np.asarray(item["indices"], dtype=np.int64).reshape(-1, 3)
        if not len(rest):
            raise ValueError("Surface vessels require source-bound material rest coordinates")
        for segment in network["segments"]:
            for point, anchor_key in (("a_mm", "a_anchor"), ("b_mm", "b_anchor")):
                anchor = segment[anchor_key]
                if anchor["triangle"] >= len(faces):
                    raise ValueError("Vessel attachment references a missing source triangle")
                expected = np.asarray(anchor["weights"]) @ rest[faces[anchor["triangle"]]]
                if np.linalg.norm(expected - np.asarray(segment[point])) > 0.01:
                    raise ValueError("Vessel endpoint does not match its source-surface attachment")
        organs[name].setdefault("metadata", {})["surface_vessels"] = network
        result["scene"]["metadata"].setdefault("surface_vessels", {})[name] = {
            "version": network["version"],
            "seed": network["seed"],
            "settings": network["settings"],
            "segment_count": len(network["segments"]),
            "network_sha256": hashlib.sha256(
                json.dumps(network, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
            ).hexdigest(),
            "coordinate_space": "source template rest millimetres",
            "appearance_baked": True,
        }


def unity_mesh(item: dict[str, Any], baked: dict[str, Any]) -> dict[str, Any]:
    """Convert the exact bake frame, with coupled geometry/UV/normal-map parity."""
    mapping = baked["mapping"]
    reflection = np.array([1.0, 1.0, -1.0])
    positions = np.asarray(item["positions"]).reshape(-1, 3)[mapping] * reflection / 1000
    normals = _unit(np.asarray(item["normals"]).reshape(-1, 3)[mapping]) * reflection
    tangent = baked["tangents"].copy()
    tangent[:, :3] *= reflection
    # Reflection and V reversal each invert tangent handedness, cancelling.
    # The associated normal texture has its green channel inverted exactly once.
    uv = baked["uv"].copy()
    uv[:, 1] = 1 - uv[:, 1]
    faces = baked["faces"][:, [0, 2, 1]]
    return {
        "version": VERSION,
        "name": str(item.get("id", "Anatomy")),
        "positions": positions.astype(np.float32).reshape(-1).tolist(),
        "normals": normals.astype(np.float32).reshape(-1).tolist(),
        "tangents": tangent.astype(np.float32).reshape(-1).tolist(),
        "uv": uv.astype(np.float32).reshape(-1).tolist(),
        "indices": faces.reshape(-1).tolist(),
        "baseColor": "Textures/Viscera_BaseColor.png",
        "normal": "Textures/Viscera_Normal.png",
        "mask": "Textures/Viscera_Mask.png",
    }


def pack_unity_mask(orm: Any) -> Any:
    """Shared Standard/URP/HDRP layout: metal, AO, disabled detail, smoothness."""
    mask = np.zeros((*orm.shape[:2], 4), dtype=np.uint8)
    mask[:, :, 0] = orm[:, :, 2]
    mask[:, :, 1] = orm[:, :, 0]
    mask[:, :, 3] = 255 - orm[:, :, 1]
    return mask


def export_unity(result: dict[str, Any], recipe: MaterialRecipe, resolution: int = 4096) -> bytes:
    if len(result["scene"]["organs"]) != 1:
        raise ValueError("Atlas Unity material export requires exactly one displayed organ")
    with _bake_slot():
        item = result["scene"]["organs"][0]
        rest, positions, normals = [
            np.asarray(item[key]).reshape(-1, 3)
            for key in ("rest_positions", "positions", "normals")
        ]
        baked = _bake_maps(
            rest,
            positions,
            normals,
            np.asarray(item["indices"]).reshape(-1, 3),
            item["material_regions"],
            recipe,
            resolution,
            disease_field=item.get("metadata", {}).get("disease_field"),
            vessel_network=item.get("metadata", {}).get("surface_vessels"),
        )
        return _package_unity(result, recipe, baked)


def _package_unity(result: dict[str, Any], recipe: MaterialRecipe, baked: dict[str, Any]) -> bytes:
    item = result["scene"]["organs"][0]
    resolved = resolve_material(recipe)
    data = unity_mesh(item, baked)
    data.update(clearcoat=resolved["clearcoat"], coatSmoothness=1 - resolved["clearcoat_roughness"])
    mesh_bytes = json.dumps(data, separators=(",", ":"), allow_nan=False).encode()
    digest = hashlib.sha256(mesh_bytes).hexdigest()
    bundle_digest = hashlib.sha256(
        mesh_bytes
        + json.dumps(
            {"recipe": recipe.model_dump(), "maps": baked["metadata"]["maps_sha256"]},
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()
    label = re.sub(r"[^a-zA-Z0-9_-]", "-", str(result["spec"].get("template_id", "anatomy")))[:80]
    prefix = f"Assets/VISCERA/Exports/{label}-{bundle_digest[:12]}"
    stream = io.BytesIO()
    manifest: dict[str, Any] = {
        "version": VERSION,
        "bundle_sha256_id": bundle_digest,
        "texture_resolution": baked["metadata"]["resolution"],
        "source_units": "mm",
        "unity_units": "m",
        "coordinate_transform": "Unity position = (x,y,-z) / 1000; triangle indices reversed",
        "texture_frame": "UV=(u,1-v); normal G=255-sourceG; tangent xyz=(x,y,-z), w unchanged",
        "normal_import": "NormalMap, flipGreenChannel=false; do not recalculate tangents",
        "texture_channels": {
            "base_color": "sRGB RGB",
            "normal": "linear tangent RGB",
            "mask": "linear R=metallic G=AO B=detail-mask(0) A=1-roughness",
        },
        "occlusion": "constant 1; no ambient-occlusion simulation was baked",
        "spec": result["spec"],
        "scene_provenance": result["scene"].get("metadata", {}),
        "surface_provenance": item.get("metadata", {}),
        "bake": baked["metadata"],
        "mesh_sha256": digest,
        "supported_materials": ["Standard", "Universal Render Pipeline/Complex Lit", "HDRP/Lit"],
        "unity_editor_execution": "NOT_RUN; exporter and coordinate/map contracts tested in Python",
        "limitations": [
            "Standard shader has no clearcoat layer",
            "HDRP coat lobe differs from the source clearcoat",
            "Subsurface scattering and measured tissue optics are not calibrated",
            "Visual surface, not a simulation-ready volume",
        ],
        "files": {},
    }
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=4) as archive:

        def write(relative: str, payload: bytes) -> None:
            archive.writestr(f"{prefix}/{relative}", payload)
            manifest["files"][relative] = {
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }

        write("Anatomy.visceraunity", mesh_bytes)
        normal = baked["normal"].copy()
        normal[:, :, 1] = 255 - normal[:, :, 1]
        for name, pixels in (
            ("BaseColor", baked["base_color"]),
            ("Normal", normal),
            ("Mask", pack_unity_mask(baked["metallic_roughness"])),
        ):
            png = io.BytesIO()
            Image.fromarray(pixels).save(png, format="PNG", compress_level=4)
            write(f"Textures/Viscera_{name}.png", png.getvalue())
        archive.writestr(f"{prefix}/manifest.json", json.dumps(manifest, indent=2, allow_nan=False))
        importer = Path(__file__).with_name("unity") / "Editor" / "VisceraUnityImporter.cs"
        archive.writestr("Assets/VISCERA/Editor/VisceraUnityImporter.cs", importer.read_bytes())
        archive.writestr("README.txt", UNITY_README)
        source = result["scene"].get("metadata", {}).get("source", {})
        archive.writestr(
            "ATTRIBUTION.txt",
            "Source anatomy attribution (retain when redistributing):\n"
            + json.dumps(source, indent=2, ensure_ascii=False)
            + "\nChanges: source-bound shape/material authoring, UV seams, texture baking, "
            "and explicit Unity coordinate conversion.\n",
        )
    return stream.getvalue()


def export_edited_vertex_glb(result: dict[str, Any]) -> bytes:
    """Preserve an edited non-textured display without regenerating its geometry."""
    scene = trimesh.Scene()
    for item in result["scene"]["organs"]:
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
        scene.add_geometry(mesh, node_name=item["id"])
    scene.metadata.update(result["scene"].get("metadata", {}))
    scene.metadata.update(spec=result["spec"], unit="m", coordinate_frame="glTF-Y-up")
    return scene.export(file_type="glb")


UNITY_README = """VISCERA Unity material export

1. Extract the ZIP outside your Unity project, then copy its Assets/VISCERA folder
   into the project's Assets folder. Keep the shared Editor importer only once.
2. Wait for script compilation and import. Anatomy.visceraunity becomes a prefab
   asset containing the mesh and a material for the project's active pipeline.
3. Drag that asset into your scene. Its unit scale is metres (Transform scale 1).
4. In the importer Inspector you may select Auto, BuiltIn, URP, or HDRP and Reimport.
   URP uses Complex Lit for the wet clearcoat; Standard omits that layer.

All PNGs are full-resolution authored atlases. Texture importer settings preserve
4096 resolution, disable compression, enable mipmaps, and set sRGB only on color.
Mask: red=metallic, green=occlusion, blue=disabled detail mask, alpha=smoothness.
The same mask is assigned to metallic AND occlusion slots in Standard/URP.
Normal PNGs already account for Unity's UV frame: do not flip green again.
The importer preserves exported normals and tangents, including chart seams.

Changing render pipelines requires reimporting the .visceraunity asset. Other
lighting, exposure, environment and tone mapping alter the displayed result.
HDRP subsurface scattering requires a separately calibrated diffusion profile;
this exporter does not invent tissue optical constants. No engine render was
executed on the export host; manifest.json records the exact validation scope.
"""
