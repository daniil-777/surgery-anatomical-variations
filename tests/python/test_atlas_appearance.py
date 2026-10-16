"""Appearance repeatability and preserved source coordinates/colors."""

import numpy as np
from viscera_core.atlas_appearance import appearance, value_noise


def test_tissue_is_seeded_and_geometry_is_untouched():
    points = np.random.default_rng(4).normal(size=(100, 3)) * 25
    colors = np.full((100, 3), 0.4)
    before = points.copy()
    a, meta = appearance("liver", points, colors, 4)
    b, _ = appearance("liver", points, colors, 4)
    c, _ = appearance("liver", points, colors, 5)
    np.testing.assert_array_equal(a, b)
    np.testing.assert_array_equal(points, before)
    assert not np.array_equal(a, c)
    assert meta["optical_validation"] == "NOT_RUN"
    assert not meta["mechanical_parameters_inferred"]
    assert np.isfinite(a).all() and ((a >= 0) & (a <= 1)).all()


def test_source_color_is_copied_without_modification():
    points = np.zeros((3, 3))
    colors = np.eye(3)
    result, meta = appearance("kidney", points, colors, 8, "source")
    np.testing.assert_array_equal(result, colors)
    result[0, 0] = 0.2
    assert colors[0, 0] == 1 and meta["clearcoat"] == 0


def test_noise_is_continuous_at_lattice_boundary():
    left = np.array([[18.0 - 1e-8, 4.0, -2.0]])
    right = np.array([[18.0 + 1e-8, 4.0, -2.0]])
    np.testing.assert_allclose(value_noise(left, 18, 42), value_noise(right, 18, 42), atol=1e-8)
