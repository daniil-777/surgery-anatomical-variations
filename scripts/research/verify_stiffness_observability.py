"""Scoped numerical observability witness, not tissue calibration or video labels.

For this fixed-Poisson, quasistatic displacement-controlled fixture, with no body
forces or prescribed tractions, scaling positive E leaves the energy minimizers
unchanged. Reaction measurements can set E's scale within this assumed model.
This does not address calibrated dynamics, gravity or arbitrary video inference.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from viscera_core import mechanics


def coordinate_fixture(material: mechanics.Material, depths: tuple[float, ...]) -> dict:
    """Independent diagnostic solve using the existing element energy assembly.

    The public compression fixture returns scalar curves, not coordinates. This
    small observer recreates its stated boundary conditions and stores the full
    equilibrium trajectory without patching or changing the mechanics module.
    It is not an independent constitutive implementation or validation dataset.
    """
    reference, tets = mechanics.block_mesh(3, 3, 2)
    fem = mechanics.TetEnergy(reference, tets, material)
    top = np.isclose(reference[:, 2], 0.02)
    patch = top & (np.sum((reference[:, :2] - 0.015) ** 2, axis=1) <= 0.0101**2)
    fixed = np.repeat(np.isclose(reference[:, 2], 0)[:, None], 3, axis=1)
    fixed[patch, 2] = True
    free = ~fixed
    current = reference.copy()
    states, forces, residuals = [], [], []
    position_scale_m = 0.001
    energy_scale_j = material.young_pa * 0.03**3
    for depth in depths:
        prescribed = current.copy()
        prescribed[patch, 2] = reference[patch, 2] - depth * 0.001

        def objective(values: np.ndarray) -> tuple[float, np.ndarray]:
            positions = prescribed.copy()
            positions[free] = values * position_scale_m
            energy, gradient, jacobians = fem.evaluate(positions)
            scaled_gradient = gradient[free] * position_scale_m / energy_scale_j
            return (energy / energy_scale_j if np.min(jacobians) > 0.05 else float('inf'),
                    scaled_gradient)

        result = minimize(objective, current[free] / position_scale_m, jac=True,
                          method='L-BFGS-B',
                          options={'maxiter': 1200, 'ftol': 1e-14, 'gtol': 1e-8, 'maxls': 40})
        prescribed[free] = result.x * position_scale_m
        energy, gradient, jacobians = fem.evaluate(prescribed)
        force = float(-gradient[patch, 2].sum())
        residual = float(np.max(np.abs(gradient[free])))
        if (not np.isfinite(prescribed).all() or not np.isfinite(energy)
                or np.min(jacobians) <= 0.05 or residual > 1e-6 + 1e-4 * abs(force)):
            raise RuntimeError('Independent coordinate fixture did not converge')
        current = prescribed
        states.append(current.copy())
        forces.append(force)
        residuals.append(residual)
    surface = np.any(np.isclose(reference, 0) |
                     np.isclose(reference, np.array([0.03, 0.03, 0.02])), axis=1)
    return {'positions_m': np.asarray(states), 'reference_m': reference, 'tets': tets,
            'free_dof_mask': free, 'surface_node_mask': surface,
            'forces_n': np.asarray(forces), 'free_residuals_n': np.asarray(residuals)}


def run(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    moduli = (2500.0, 5000.0, 10000.0)
    depths = (0.0, 0.5, 1.0, 1.5, 2.0)
    runs = [mechanics.patch_compression(mechanics.Material(e, .35), resolution=3,
                                      depths_mm=depths) for e in moduli]
    if not all(r['converged'] for r in runs):
        raise RuntimeError('Underlying synthetic FEM fixture did not converge')
    forces = np.asarray([[c['compressive_force_n'] for c in r['curves']] for r in runs])
    normalized = forces / np.asarray(moduli)[:, None]
    relative_scale_error = float(np.max(abs(normalized-normalized[1])) /
                                 max(1e-12, np.max(abs(normalized[1]))))
    rng = np.random.default_rng(20261007)
    gradients = np.eye(3)[None] + rng.normal(0, .05, (16, 3, 3))
    constitutive = [mechanics.energy_stress(gradients, mechanics.Material(e, .35))
                    for e in moduli]
    normalized_energies = np.asarray([values[0] / e for e, values in zip(moduli, constitutive)])
    normalized_stresses = np.asarray([values[1] / e for e, values in zip(moduli, constitutive)])
    energy_error = float(np.max(abs(normalized_energies-normalized_energies[1])))
    stress_error = float(np.max(abs(normalized_stresses-normalized_stresses[1])))

    traces = [coordinate_fixture(mechanics.Material(e, .35), depths) for e in moduli]
    positions = np.asarray([trace['positions_m'] for trace in traces])
    coordinate_differences = positions - positions[1:2]
    free = traces[1]['free_dof_mask']
    surface = traces[1]['surface_node_mask']
    nodal_distances = np.linalg.norm(coordinate_differences, axis=-1)
    maximum_nodal_difference = float(np.max(nodal_distances))
    maximum_free_difference = float(np.max(np.abs(coordinate_differences[:, :, free])))
    force_parity_error = float(np.max(np.abs(
        np.asarray([trace['forces_n'] for trace in traces]) - forces)))
    coordinate_path = output / 'observability-coordinates.npz'
    np.savez_compressed(coordinate_path, positions_m=positions, moduli_pa=np.asarray(moduli),
                        depths_mm=np.asarray(depths), reference_m=traces[1]['reference_m'],
                        tets=traces[1]['tets'], free_dof_mask=free, surface_node_mask=surface)

    # A separate E within the same noiseless model/mesh, with observed reactions.
    # This is displacement controlled, not a prescribed-load forward experiment.
    truth = 7500.0
    target = mechanics.patch_compression(mechanics.Material(truth, .35), resolution=3,
                                        depths_mm=depths)
    if not target['converged']:
        raise RuntimeError('Synthetic reaction-calibration fixture did not converge')
    measured = np.asarray([c['compressive_force_n'] for c in target['curves']])
    unit_force = forces[1] / moduli[1]
    fit_ids = np.array([1, 2])
    test_ids = np.array([3, 4])
    estimate = float(unit_force[fit_ids] @ measured[fit_ids] /
                     (unit_force[fit_ids] @ unit_force[fit_ids]))
    predicted = estimate * unit_force
    heldout_rmse = float(np.sqrt(np.mean((predicted[test_ids]-measured[test_ids])**2)))
    report = {
        'schema': 'viscera.physics.observability_witness.v2',
        'evidence_kind': 'synthetic_numerical_fixture',
        'geometry': '30x30x20 mm block, fixed bottom, prescribed top patch z; patch x/y free',
        'model': 'existing SNH quadratic-J Eq.13 pilot, fixed nu=0.35, no contact or gravity',
        'not_a_human_tissue_parameter_range': True,
        'moduli_pa': list(moduli), 'depths_mm': list(depths),
        'force_curves_n': forces.tolist(),
        'normalized_energy_max_abs_error': energy_error,
        'normalized_stress_max_abs_error': stress_error,
        'reaction_force_proportionality_relative_error': relative_scale_error,
        'fixture_displacement_only_scale_identifiable': False,
        # Compatibility field: its scope is explicitly the fixture below.
        'video_only_scale_identifiable': False,
        'identifiability_scope': 'This quasistatic, fixed-nu, homogeneous-E fixture only; '
            'no inference about calibrated dynamic, body-force or reference-material experiments.',
        'argument': 'W_E(x)=E*W_1(x); with E-independent displacement constraints and no '
            'body forces or prescribed tractions, the argmin set is invariant to E>0. '
            'Reaction forces scale with E. This does not prove unique equilibrium.',
        'coordinate_comparison': {
            'method': 'Independent boundary-value solve using existing TetEnergy; '
                'no mechanics code or optimizer monkeypatching',
            'reference_modulus_pa': moduli[1],
            'compared': 'All full 3D positions at all five depths, including unconstrained DOFs',
            'coordinate_array_shape': list(positions.shape),
            'array_axes': ['modulus', 'depth', 'node', 'xyz'],
            'max_nodal_distance_m': maximum_nodal_difference,
            'max_free_dof_difference_m': maximum_free_difference,
            'max_unconstrained_displacement_m': float(np.max(np.abs(
                (positions[1] - traces[1]['reference_m'])[:, free]))),
            'rms_free_dof_difference_m': float(np.sqrt(np.mean(
                coordinate_differences[:, :, free]**2))),
            'max_surface_nodal_distance_m': float(np.max(nodal_distances[:, :, surface])),
            'independent_fixture_force_parity_max_abs_error_n': force_parity_error,
            'coordinate_tolerance_m': 1e-7,
            'artifact': coordinate_path.name,
            'artifact_sha256': hashlib.sha256(coordinate_path.read_bytes()).hexdigest(),
        },
        # Kept for existing report consumers; its explicit name clarifies the experiment.
        'known_load_calibration': {
            'protocol': 'prescribed displacement with synthetic observed reaction force',
            'validation_scope': 'Same model, mesh, boundary conditions and noiseless solver; '
                'held-out depths only, not independent physics or tissue validation.',
            'truth_pa': truth, 'estimate_pa': estimate,
            'fit_depth_ids': fit_ids.tolist(), 'heldout_depth_ids': test_ids.tolist(),
            'observed_reactions_n': measured.tolist(),
            'predicted_reactions_n': predicted.tolist(),
            'heldout_force_rmse_n': heldout_rmse,
            'parameter_relative_error': abs(estimate-truth)/truth,
        },
        'does_not_validate': ['contact', 'near-incompressibility', 'viscoelasticity',
                             'real organ mechanics', 'video reconstruction',
                             'noisy calibration', 'independent-model generalization'],
        'source_sha256': hashlib.sha256(Path(mechanics.__file__).read_bytes()).hexdigest(),
        'diagnostic_source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'runs': runs,
    }
    if (energy_error > 1e-12 or stress_error > 1e-12 or relative_scale_error > 1e-4
            or maximum_nodal_difference > 1e-7 or maximum_free_difference > 1e-7
            or force_parity_error > 1e-7 or abs(estimate-truth)/truth > 1e-4):
        raise RuntimeError('Observability witness failed numerical tolerance')
    (output/'observability.json').write_text(json.dumps(report, indent=2)+'\n')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 3, figsize=(15, 4), layout='constrained')
    free_nodes = np.any(free, axis=1)
    for index, (e, force) in enumerate(zip(moduli, forces)):
        axes[0].plot(depths, force, 'o-', label=f'E={e/1000:g} kPa (fixture)')
        axes[1].plot(depths, force/e, 'o-', label=f'E={e/1000:g} kPa')
        points = positions[index, -1, free_nodes] * 1000
        axes[2].scatter(points[:, 0], points[:, 2], s=45 + 30*index,
                        facecolors='none', edgecolors=f'C{index}', linewidths=1.0,
                        label=f'E={e/1000:g} kPa')
    axes[0].set(title='Displacement-controlled block: reactions differ',
                xlabel='Prescribed patch displacement (mm)', ylabel='Reaction force (N)')
    axes[1].set(title='Reaction force scales with E in this fixture',
                xlabel='Prescribed patch displacement (mm)', ylabel='Reaction force / E (m²)')
    axes[2].set(title='Solved free-node positions coincide',
                xlabel='x (mm); final-depth x/z projection', ylabel='z (mm)')
    axes[2].text(.03, .35, f'All-depth 3D max difference: {maximum_nodal_difference:.2g} m',
                 transform=axes[2].transAxes, fontsize=8)
    for axis in axes:
        axis.grid(alpha=.2)
        axis.legend(fontsize=7)
    fig.suptitle('Synthetic quasistatic fixed-ν block — not measured organ calibration', fontsize=12)
    fig.savefig(output/'observability.png', dpi=160)
    plt.close(fig)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=Path('artifacts/physics/research'))
    args = parser.parse_args()
    result = run(args.out)
    print(json.dumps({key: result[key] for key in [
        'fixture_displacement_only_scale_identifiable', 'coordinate_comparison',
        'reaction_force_proportionality_relative_error', 'known_load_calibration']}, indent=2))
