"""Normal repair never changes source coordinates, topology or valid normals."""

from __future__ import annotations

import hashlib

import numpy as np
import pytest
from viscera_core.atlas_surface_normals import repair_display_normals


def test_tiny_triangle_zero_normal_repair_preserves_source_and_valid_normals() -> None:
    positions = np.array([[0.0, 0, 0], [1e-7, 0, 0], [0, 1e-7, 0], [7, 8, 9]])
    faces = np.array([[0, 1, 2]])
    normals = np.array([[0.0, 0, 0], [0, 0, 1], [0, 0, 1], [0, 0, 0]])
    before = [a.copy() for a in (positions, faces, normals)]
    repaired, metadata = repair_display_normals(positions, faces, normals)
    np.testing.assert_array_equal(repaired[0], [0, 0, 1])
    np.testing.assert_array_equal(repaired[1:], normals[1:])
    for value, expected in zip((positions, faces, normals), before, strict=True):
        np.testing.assert_array_equal(value, expected)
    assert metadata["repaired_vertex_indices"] == [0]
    assert metadata["area_weighted_incident_count"] == 1
    assert metadata["invalid_unreferenced_count"] == 1
    assert metadata["geometry_modified"] is False
    assert metadata["sha256"] == hashlib.sha256(repaired.astype("<f4").tobytes()).hexdigest()


def test_exact_cancellation_uses_deterministic_largest_face_and_flags_source() -> None:
    positions = np.array([[0.0, 0, 0], [2, 0, 0], [0, 2, 0]])
    faces = np.array([[0, 1, 2], [0, 2, 1]])
    normals = np.array([[0.0, 0, 0], [0, 0, 1], [0, 0, 1]])
    repaired, metadata = repair_display_normals(positions, faces, normals)
    np.testing.assert_array_equal(repaired[0], [0, 0, 1])
    assert metadata["largest_incident_face_fallback_count"] == 1
    assert "incident_geometric_normal_cancellation" in metadata["source_defect_flags"]


def test_missing_positive_area_incident_geometry_fails_and_valid_input_is_exact() -> None:
    positions = np.array([[0.0, 0, 0], [1, 0, 0], [2, 0, 0]])
    faces = np.array([[0, 1, 2]])
    with pytest.raises(ValueError, match="no positive-area"):
        repair_display_normals(positions, faces, np.zeros((3, 3)))
    normals = np.array([[0.0, 0, 1], [0, 0, 1], [0, 0, 1]])
    output, metadata = repair_display_normals(positions, faces, normals)
    np.testing.assert_array_equal(output, normals)
    assert metadata["source_sha256"] == metadata["sha256"]
    assert metadata["repaired_vertex_count"] == 0
