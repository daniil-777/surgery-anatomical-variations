"""Repair invalid display normals only in optional material-v2 scenes.

The frozen atlas retains exact source geometry and its legacy normal policy. Tiny
source triangles can receive zero vertex normals from a renderer's tolerance.
This adapter supplies a deterministic shading frame without moving or removing
any source vertex/face, and reports every affected vertex.
"""

from __future__ import annotations

import hashlib
from typing import Any

import numpy as np

NORMAL_REPAIR_VERSION = "atlas-surface-normal-repair-1.0.0"
NORMAL_FRAME_RELATIVE_THRESHOLD = 1e-7


def _hash(normals: Any) -> str:
    return hashlib.sha256(np.asarray(normals, dtype="<f4").tobytes()).hexdigest()


def repair_display_normals(
    vertices_mm: Any, faces: Any, normals: Any
) -> tuple[Any, dict[str, Any]]:
    vertices = np.asarray(vertices_mm, dtype=np.float64)
    original = np.asarray(normals, dtype=np.float64)
    triangles = np.asarray(faces)
    if (
        vertices.ndim != 2
        or vertices.shape[1] != 3
        or original.shape != vertices.shape
        or triangles.ndim != 2
        or triangles.shape[1] != 3
        or triangles.dtype.kind not in "iu"
        or not len(triangles)
    ):
        raise ValueError("Invalid surface-normal repair array dimensions or face indices")
    if not np.isfinite(vertices).all() or triangles.min() < 0 or triangles.max() >= len(vertices):
        raise ValueError("Nonfinite geometry or out-of-range face index in normal repair")
    triangles = triangles.astype(np.int64, copy=False)
    repaired = original.copy()
    referenced = np.zeros(len(vertices), dtype=bool)
    referenced[triangles.reshape(-1)] = True
    invalid = ~np.isfinite(original).all(axis=1) | (np.linalg.norm(original, axis=1) < 1e-12)
    repair_ids = np.flatnonzero(invalid & referenced)
    weighted_count = 0
    largest_count = 0
    local_areas: list[float] = []
    if len(repair_ids):
        geometric = np.cross(
            vertices[triangles[:, 1]] - vertices[triangles[:, 0]],
            vertices[triangles[:, 2]] - vertices[triangles[:, 0]],
        )
        weights = np.linalg.norm(geometric, axis=1)
        for vertex_id in repair_ids:
            incident = np.flatnonzero((triangles == vertex_id).any(axis=1))
            incident = incident[np.isfinite(weights[incident]) & (weights[incident] > 0)]
            if not len(incident):
                raise ValueError(
                    f"Cannot repair normal at referenced vertex {vertex_id}: "
                    "no positive-area incident geometry"
                )
            summed = geometric[incident].sum(axis=0)
            length = float(np.linalg.norm(summed))
            total = float(weights[incident].sum())
            if length > total * 1e-10:
                repaired[vertex_id] = summed / length
                weighted_count += 1
            else:
                # np.argmax selects the first face index on equal areas. This
                # is a shading fallback for exact cancellation, not evidence
                # that overlapping or nonmanifold source geometry was repaired.
                largest = incident[np.argmax(weights[incident])]
                repaired[vertex_id] = geometric[largest] / weights[largest]
                largest_count += 1
            local_areas.extend((weights[incident] * 0.5).tolist())
    flags: list[str] = []
    if len(repair_ids):
        flags.append("invalid_referenced_display_normals")
    if largest_count:
        flags.append("incident_geometric_normal_cancellation")
    if np.any(invalid & ~referenced):
        flags.append("invalid_unreferenced_normals_preserved")
    metadata = {
        "policy": NORMAL_REPAIR_VERSION,
        "source_sha256": _hash(original),
        "sha256": _hash(repaired),
        "geometry_modified": False,
        "valid_input_normals_preserved": True,
        "repaired_vertex_count": len(repair_ids),
        "repaired_vertex_indices": repair_ids.tolist(),
        "area_weighted_incident_count": weighted_count,
        "largest_incident_face_fallback_count": largest_count,
        "invalid_unreferenced_count": int(np.sum(invalid & ~referenced)),
        "repaired_incident_area_mm2_min_max": (
            [float(min(local_areas)), float(max(local_areas))] if local_areas else None
        ),
        "source_defect_flags": flags,
        "scope": "surface shading frame only; no anatomical or topology repair",
    }
    return repaired, metadata
