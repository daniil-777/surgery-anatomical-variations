"""Numerical implementation checks; these do not validate human tissue realism."""

from pathlib import Path

import numpy as np
import pytest
from scipy.optimize import brentq
from scipy.spatial import ConvexHull
from viscera_core.liver_physics import (
    LiverParameters,
    ViscoelasticTet,
    build_liver_cage,
    constitutive_response,
    deviatoric_green,
    embed_surface,
    run_liver_experiment,
    sphere_contact_energy_gradient,
    surface_contact_quadrature,
)
from viscera_core.mechanics import block_mesh


def ellipsoid() -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(4)
    vertices = rng.normal(size=(80, 3))
    vertices /= np.linalg.norm(vertices, axis=1)[:, None]
    vertices *= np.array([90, 65, 45])
    return vertices, ConvexHull(vertices).simplices


def test_finite_strain_energy_gradient_objectivity_and_rest():
    material = LiverParameters()
    f = np.array([[1.03, 0.07, 0.0], [0, 0.96, 0.02], [0, 0, 1.01]])
    previous = deviatoric_green(f) * 0.3
    memory = previous * 0.7
    direction = np.array([[0.3, 0.1, -0.2], [0.2, 0.4, 0.1], [0, 0.1, 0.2]])
    energy, stress, _ = constitutive_response(f, material, 0.03, previous, memory)
    epsilon = 1e-6
    numerical = (
        constitutive_response(f + epsilon * direction, material, 0.03, previous, memory)[0]
        - constitutive_response(f - epsilon * direction, material, 0.03, previous, memory)[0]
    ) / (2 * epsilon)
    assert numerical == pytest.approx(np.sum(stress * direction), rel=1e-7, abs=1e-6)
    angle = 0.57
    rotation = np.array(
        [[np.cos(angle), -np.sin(angle), 0], [np.sin(angle), np.cos(angle), 0], [0, 0, 1]]
    )
    rotated_e, rotated_p, _ = constitutive_response(rotation @ f, material, 0.03, previous, memory)
    assert rotated_e == pytest.approx(energy, abs=1e-10)
    np.testing.assert_allclose(rotated_p, rotation @ stress, atol=1e-10)
    rest_e, rest_p, rest_q = constitutive_response(rotation, material, 0.1)
    assert abs(rest_e) < 1e-10
    np.testing.assert_allclose(rest_p, 0, atol=1e-10)
    np.testing.assert_allclose(rest_q, 0, atol=1e-14)


def test_assembled_gradient_balances_and_commits_true_relaxation_memory():
    x, tets = block_mesh(1, 1, 1)
    material = LiverParameters(relaxation_fraction=0.6, relaxation_time_s=0.4)
    fem = ViscoelasticTet(x, tets, material)
    f = np.array([[1, 0.06, 0], [0, 1, 0], [0, 0, 1]])
    current = x @ f.T
    _, gradient, jacobians = fem.evaluate(current, 0.1)
    np.testing.assert_allclose(gradient.sum(0), 0, atol=1e-12)
    np.testing.assert_allclose(jacobians, 1, atol=1e-12)
    rng = np.random.default_rng(30)
    direction = rng.normal(size=x.shape)
    epsilon = 1e-7
    derivative = (
        fem.evaluate(current + epsilon * direction, 0.1)[0]
        - fem.evaluate(current - epsilon * direction, 0.1)[0]
    ) / (2 * epsilon)
    assert derivative == pytest.approx(np.sum(gradient * direction), rel=2e-6)
    fem.commit(current, 0.1)
    memory = fem.memory.copy()
    for _ in range(4):
        fem.commit(current, 0.1)
    np.testing.assert_allclose(
        fem.memory, memory * np.exp(-0.4 / material.shear_relaxation_time_s), rtol=1e-11, atol=1e-14
    )
    assert np.linalg.norm(fem.memory) > 0
    # Absolute stiffness scales reaction; shear-memory relaxation remains fixed.
    stiff = ViscoelasticTet(
        x, tets, LiverParameters(young_pa=12000, relaxation_fraction=0.6, relaxation_time_s=0.4)
    )
    np.testing.assert_allclose(
        stiff.evaluate(current, 0.1)[1], 2 * gradient, rtol=1e-10, atol=1e-12
    )


def test_uniaxial_relaxation_matches_network_standard_linear_solid_domain():
    material = LiverParameters(
        young_pa=6000, poisson=0.45, relaxation_fraction=0.6, relaxation_time_s=0.4
    )
    equilibrium_young = (
        9 * material.bulk * material.relaxed_shear / (3 * material.bulk + material.relaxed_shear)
    )
    assert equilibrium_young == pytest.approx(
        material.young_pa * (1 - material.relaxation_fraction)
    )
    mapped_time = (
        material.shear_relaxation_time_s
        * (3 * material.bulk + material.shear)
        / (3 * material.bulk + material.relaxed_shear)
    )
    assert mapped_time == pytest.approx(material.relaxation_time_s)
    # Independently solve traction-free lateral faces at each time. This tests
    # actual 3D stress transfer, beyond merely repeating the parameter formulas.
    axial_strain = 1e-6
    strain, memory = np.zeros((3, 3)), np.zeros((3, 3))
    elapsed = 0.0
    for step in range(101):
        dt = 1e-6 if step == 0 else 0.004
        lateral = brentq(
            lambda value: constitutive_response(
                np.diag([1 + axial_strain, 1 + value, 1 + value]), material, dt, strain, memory
            )[1][1, 1],
            -axial_strain,
            0,
            xtol=1e-14,
        )
        f = np.diag([1 + axial_strain, 1 + lateral, 1 + lateral])
        _, stress, memory = constitutive_response(f, material, dt, strain, memory)
        strain = deviatoric_green(f)
        elapsed += dt
        expected = (
            material.young_pa
            * axial_strain
            * (
                (1 - material.relaxation_fraction)
                + material.relaxation_fraction * np.exp(-elapsed / material.relaxation_time_s)
            )
        )
        assert stress[0, 0] == pytest.approx(expected, rel=1e-4)


def test_inversion_line_search_guard_has_consistent_energy_gradient():
    reference, tets = block_mesh(1, 1, 1)
    fem = ViscoelasticTet(reference, tets, LiverParameters())
    current = reference @ np.diag([0.1, 1, 1])
    energy, gradient, jacobians = fem.evaluate(current, 0.1)
    assert np.isfinite(energy) and np.all(jacobians < 0.15)
    direction = np.random.default_rng(72).normal(size=current.shape)
    epsilon = 1e-8
    numerical = (
        fem.evaluate(current + epsilon * direction, 0.1)[0]
        - fem.evaluate(current - epsilon * direction, 0.1)[0]
    ) / (2 * epsilon)
    assert numerical == pytest.approx(np.sum(gradient * direction), rel=2e-6)
    assert np.linalg.norm(gradient) > 1


def test_surface_contact_gradient_and_translation_without_vertex_tunneling():
    # Two 50mm-wide triangles are far coarser than the 8mm sphere. Nodal-only
    # contact would report zero force everywhere along this interior sweep.
    reference = np.array(
        [[-0.025, 0, -0.025], [0.025, 0, -0.025], [0.025, 0, 0.025], [-0.025, 0, 0.025]]
    )
    faces = np.array([[0, 1, 2], [0, 2, 3]])
    radius, height, stiffness = 0.008, 0.006, 1500
    expected = stiffness * height * (radius - height) ** 2 / radius**2
    errors = []
    for spacing in (1 / 3, 1 / 6):
        q = surface_contact_quadrature(
            reference, faces, np.zeros(3), radius, spacing_fraction=spacing
        )
        assert q["areas_m2"].sum() == pytest.approx(0.05**2, rel=1e-12)
        forces = [
            sphere_contact_energy_gradient(
                reference, q, np.array([x, height, 0]), radius, stiffness
            )[2][1]
            for x in np.linspace(-0.01, 0.01, 41)
        ]
        assert min(forces) > 0.99 * expected
        errors.append(max(abs(np.array(forces) / expected - 1)))
    assert errors[1] < errors[0] and errors[1] < 0.003
    center = np.array([0.0023, height, 0.0007])
    energy, gradient, force = sphere_contact_energy_gradient(
        reference, q, center, radius, stiffness
    )
    direction = np.random.default_rng(331).normal(size=reference.shape)
    epsilon = 1e-8
    numerical = (
        sphere_contact_energy_gradient(
            reference + epsilon * direction, q, center, radius, stiffness
        )[0]
        - sphere_contact_energy_gradient(
            reference - epsilon * direction, q, center, radius, stiffness
        )[0]
    ) / (2 * epsilon)
    assert energy > 0
    assert numerical == pytest.approx(np.sum(gradient * direction), rel=2e-6)
    np.testing.assert_allclose(gradient.sum(0), force, atol=1e-12)


@pytest.mark.parametrize("cut", [False, True])
def test_actual_surface_is_embedded_exactly_and_affine_motion_is_reproduced(cut):
    vertices, faces = ellipsoid()
    cage = build_liver_cage(vertices, faces, resolution=3, cut=cut)
    original = cage["reference"]
    np.testing.assert_allclose(embed_surface(cage, original), vertices * 0.001, atol=1e-12)
    f = np.array([[1.03, 0.02, 0], [0, 0.98, 0], [0, 0.01, 1.01]])
    shift = np.array([0.01, -0.02, 0.005])
    np.testing.assert_allclose(
        embed_surface(cage, original @ f.T + shift), vertices * 0.001 @ f.T + shift, atol=1e-12
    )
    assert cage["embedding_max_error_mm"] < 1e-7
    assert np.min(cage["embedding_weights"]) >= -1e-6
    assert cage["enclosure"]["measured_enclosure_excess_pct"] <= 5
    assert cage["enclosure"]["maximum_allowed_excess_pct"] == 10
    fem = ViscoelasticTet(original, cage["tets"], LiverParameters())
    assert np.min(fem.volumes) > 0
    if cut:
        np.testing.assert_allclose(
            original[cage["seam_pairs"][:, 0]], original[cage["seam_pairs"][:, 1]], atol=1e-8
        )


def test_grasp_relaxes_recovers_and_reactions_change_with_modulus():
    vertices, faces = ellipsoid()
    reports = [
        run_liver_experiment(
            vertices,
            faces,
            {"young_pa": modulus, "contact_stiffness_n_m": 300},
            "grasp",
            resolution=2,
            steps=24,
        )
        for modulus in (3000, 9000)
    ]
    for report in reports:
        metrics = report["metrics"]
        assert metrics["finite_state"]
        assert metrics["minimum_jacobian"] > 0.5
        assert metrics["inverted_elements"] == metrics["rejected_steps"] == 0
        assert metrics["unconverged_steps"] == 0
        assert metrics["peak_displacement_mm"] > 1
        assert metrics["residual_displacement_mm"] < metrics["peak_displacement_mm"] * 0.4
        assert 0 < metrics["hold_force_ratio"] < 1
        assert metrics["numerical_status"] == "PASS"
        assert len(report["frames"]) == 25
    assert (
        reports[1]["metrics"]["peak_tool_force_n"]
        > reports[0]["metrics"]["peak_tool_force_n"] * 1.3
    )


def test_cut_irreversibly_changes_connectivity_and_balances_assumed_fracture_work():
    vertices, faces = ellipsoid()
    report = run_liver_experiment(
        vertices,
        faces,
        {"contact_stiffness_n_m": 300, "fracture_energy_j_m2": 20},
        "cut",
        resolution=2,
        steps=24,
    )
    severed = np.array([frame["severed_bonds"] for frame in report["frames"]])
    assert severed[0] == 0 and severed[-1] > 0
    assert np.all(np.diff(severed) >= 0)
    metrics = report["metrics"]
    assert metrics["severed_bonds"] == metrics["total_seam_bonds"]
    assert metrics["maximum_seam_opening_mm"] > 1
    assert metrics["fracture_dissipation_j"] > 0
    assert metrics["force_displacement_work_j"] == pytest.approx(
        metrics["fracture_dissipation_j"], rel=1e-12
    )
    assert (
        metrics["rejected_steps"]
        == metrics["inverted_elements"]
        == metrics["unconverged_steps"]
        == 0
    )
    assert len(report["frames"][-1]["active_surface_indices"]) > len(
        report["frames"][0]["active_surface_indices"]
    )
    # No tetrahedron spans the severed interface: after all bonds release, the
    # two volumes are mechanically disconnected, not merely recoloured faces.
    tets = np.array(report["mesh"]["tets"]).reshape(-1, 4)
    nodes = np.array(report["mesh"]["reference_positions_mm"]).reshape(-1, 3)
    plane = nodes[np.array(report["mesh"]["seam_pairs"])[:, 0], 0].mean()
    sides = nodes[tets, 0] - plane
    assert not np.any((sides.min(1) < -1e-5) & (sides.max(1) > 1e-5))


def test_atlas_liver_time_refinement_and_unit_identity():
    path = (
        Path(__file__).resolve().parents[2]
        / "datasets/atlas/cohort-v2/templates/hra-liver-male.npz"
    )
    if not path.exists():
        pytest.skip("Source atlas release is optional in minimal source checkout")
    with np.load(path) as source:
        vertices, faces = source["vertices_mm"], source["faces"]
    reports = [
        run_liver_experiment(
            vertices,
            faces,
            {"young_pa": 4800, "contact_stiffness_n_m": 300},
            "grasp",
            resolution=3,
            steps=steps,
        )
        for steps in (24, 48)
    ]
    for report in reports:
        assert report["mesh"]["source_vertex_count"] == len(vertices)
        assert report["mesh"]["embedding_max_error_mm"] < 1e-7
        assert report["metrics"]["numerical_status"] == "PASS"
        assert report["metrics"]["maximum_volume_error_pct"] < 2
        assert report["mesh"]["enclosure_over_convex_hull_pct"] <= 5
        assert report["mesh"]["tool_reference_gap_mm"] < 1e-3
    coarse, fine = [r["metrics"]["peak_tool_force_n"] for r in reports]
    assert abs(coarse - fine) / fine < 0.15
    assert (
        reports[0]["mesh"]["reference_geometry_sha256"]
        == reports[1]["mesh"]["reference_geometry_sha256"]
    )
    indentation = run_liver_experiment(
        vertices,
        faces,
        {"young_pa": 4800, "contact_stiffness_n_m": 300},
        "indent",
        resolution=3,
        steps=24,
    )
    assert indentation["metrics"]["loaded_contact_gap_frames"] == 0
    assert indentation["metrics"]["numerical_status"] == "PASS"
    assert indentation["parameters"]["indentation_stiffness_n_m"] == 20000
    assert indentation["metrics"]["maximum_contact_penetration_mm"] < 0.6
    assert (
        indentation["tool"]["contact"]["samples"]
        > len(indentation["mesh"]["reference_positions_mm"]) // 3
    )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"young_pa": -1},
        {"poisson": 0.5},
        {"relaxation_fraction": 1},
        {"density_kg_m3": float("nan")},
        {"relaxation_time_s": 0},
        {"indentation_stiffness_n_m": 999},
    ],
)
def test_reject_unphysical_parameters(kwargs):
    with pytest.raises(ValueError):
        LiverParameters(**kwargs)


def test_reject_invalid_geometry_protocol_and_units():
    vertices, faces = ellipsoid()
    with pytest.raises(ValueError, match="index"):
        build_liver_cage(vertices, np.array([[0, 1, len(vertices)]]))
    with pytest.raises(ValueError, match="units"):
        build_liver_cage(vertices / 1000, faces)
    with pytest.raises(ValueError, match="protocol"):
        run_liver_experiment(vertices, faces, protocol="unknown")
    with pytest.raises(ValueError, match="resolution"):
        build_liver_cage(vertices, faces, resolution=20)
