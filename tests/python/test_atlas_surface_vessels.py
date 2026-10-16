from copy import deepcopy

import numpy as np
import pytest
from viscera_core.atlas_surface_vessels import (
    VESSEL_VERSION,
    apply_vessel_appearance,
    sample_vessels,
    validate_network,
)


def network():
    return {"version": VESSEL_VERSION, "seed": 42, "organ_id": "liver",
            "provenance": "procedural-surface-design-not-patient-vasculature",
            "settings": {"density": 0.45, "visibility": 0.72, "radius_scale": 1},
            "segments": [{"a_mm": [0, 0, 0], "b_mm": [10, 0, 0], "normal": [0, 0, 1], "radius_a_mm": 1,
                          "radius_b_mm": 1, "depth_mm": 0.5, "kind": 0,
                          "a_anchor": {"triangle": 0, "weights": [1, 0, 0]}, "b_anchor": {"triangle": 0, "weights": [0, 1, 0]}}]}


def test_analytic_parity_with_browser_and_facing_gate():
    value = validate_network(network())
    positions = np.array([[5, 0, 0], [5, 0, 0], [5, 30, 0], [5, 0.4, 0]])
    normals = np.array([[0, 0, 1], [0, 0, -1], [0, 0, 1], [0, 0, 1]])
    result = sample_vessels(positions, normals, value)
    assert result["artery"][0] == pytest.approx(0.72 * 0.74 * np.exp(-0.4), abs=1e-12)
    assert result["height_mm"][0] == pytest.approx(0.072 * np.exp(-0.4), abs=1e-12)
    assert result["artery"][1] == 0
    assert result["artery"][2] == 0
    assert result["gradient_rest"][3, 1] < 0
    value["segments"].append(deepcopy(value["segments"][0]))
    duplicate = sample_vessels(positions, normals, value)
    for key in result:
        np.testing.assert_array_equal(result[key], duplicate[key])


def test_zero_visibility_and_export_channels():
    value = network()
    base = np.array([[0.4, 0.2, 0.12]])
    roughness = np.array([0.5])
    positions = np.array([[5, 0, 0]])
    normals = np.array([[0, 0, 1]])
    color, rough, height, gradient = apply_vessel_appearance(base, roughness, positions, normals, value)
    assert color[0, 0] < base[0, 0]
    assert rough[0] < roughness[0]
    assert 0 < height[0] < 0.1
    assert np.isfinite(gradient).all()
    value["settings"]["visibility"] = 0
    color, rough, height, gradient = apply_vessel_appearance(base, roughness, positions, normals, value)
    np.testing.assert_array_equal(color, base)
    np.testing.assert_array_equal(rough, roughness)
    assert np.max(height) == 0


@pytest.mark.parametrize("patch", [{"radius_a_mm": -1}, {"depth_mm": float("nan")}, {"normal": [0, 0, 0]},
                                  {"a_mm": [0, 0, float("inf")]}, {"kind": True},
                                  {"a_anchor": {"triangle": 0, "weights": [0.5, 0.5, 0.5]}}])
def test_rejects_invalid_fields(patch):
    value = network()
    value["segments"][0].update(patch)
    with pytest.raises(ValueError):
        validate_network(value)
