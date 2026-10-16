import numpy as np
import pytest
from viscera_core.mechanics import (
    Material,
    TetEnergy,
    block_mesh,
    energy_stress,
    patch_compression,
    tangent_action,
    verification_report,
)


def test_stress_tangent_objectivity_and_linear_limit():
    assert verification_report()["passed"]
    material = Material(5000, 0.35)
    strain = np.array([[0.7, 0.2, -0.1], [0.4, -0.2, 0.3], [0.2, 0.1, 0.1]])
    mu = 5000 / (2 * 1.35)
    lame = 5000 * 0.35 / (1.35 * 0.3)
    expected = mu * (strain + strain.T) + lame * np.trace(strain) * np.eye(3)
    np.testing.assert_allclose(
        tangent_action(np.eye(3), strain, material), expected, rtol=1e-13, atol=1e-10
    )


def test_affine_tet_patch_matches_analytic_energy_and_force_gradient():
    x, tets = block_mesh(2, 2, 2)
    material = Material()
    f = np.array([[1.08, 0.06, 0], [0, 0.93, 0.03], [0, 0, 1.02]])
    current = x @ f.T + np.array([0.04, -0.1, 0.2])
    fem = TetEnergy(x, tets, material)
    energy, gradient, j = fem.evaluate(current)
    density, _ = energy_stress(f, material)
    assert energy == pytest.approx(float(density) * 0.03 * 0.03 * 0.02, rel=1e-11)
    np.testing.assert_allclose(j, np.linalg.det(f), atol=1e-13)
    np.testing.assert_allclose(gradient.sum(0), 0, atol=1e-12)
    rng = np.random.default_rng(71)
    direction = rng.normal(size=x.shape)
    for epsilon in (1e-6, 1e-7):
        derivative = (
            fem.evaluate(current + epsilon * direction)[0]
            - fem.evaluate(current - epsilon * direction)[0]
        ) / (2 * epsilon)
        assert derivative == pytest.approx(float(np.sum(gradient * direction)), rel=3e-6, abs=1e-9)


def test_quasistatic_fixture_converges_and_scales_with_modulus():
    low = patch_compression(Material(3000, 0.35), 3, (0.0, 0.5, 1.0))
    high = patch_compression(Material(6000, 0.35), 3, (0.0, 0.5, 1.0))
    assert low["converged"] and high["converged"]
    assert low["curves"][0]["compressive_force_n"] == pytest.approx(0, abs=1e-12)
    assert low["curves"][-1]["compressive_force_n"] > 0
    assert high["curves"][-1]["compressive_force_n"] == pytest.approx(
        2 * low["curves"][-1]["compressive_force_n"], rel=2e-4
    )
    assert min(row["min_j"] for row in low["curves"]) > 0.05


def test_reject_bad_reference_and_material():
    x, tets = block_mesh(1, 1, 1)
    tets[:, [1, 2]] = tets[:, [2, 1]]
    with pytest.raises(ValueError, match="positive"):
        TetEnergy(x, tets, Material())
    with pytest.raises(ValueError):
        Material(-1).coefficients()
