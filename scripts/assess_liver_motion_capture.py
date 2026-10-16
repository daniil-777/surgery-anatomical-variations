#!/usr/bin/env python3
"""Independently audit exported simulated motion, preserving clocks and resets."""
from __future__ import annotations
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
import numpy as np
from assess_liver_trajectories import shape_change, tetra_determinants


def vector(value, size, name):
    out = np.asarray(value, dtype=float)
    if out.shape != (size,) or not np.isfinite(out).all():
        raise ValueError(f"{name} requires {size} finite coordinates")
    return out


def sphere_surface_penetration_mm(positions, faces, center, radius):
    """Exact piecewise-linear surface distance plus closed-surface solid-angle test."""
    tri = positions[faces]
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    ab, ac, ap = b-a, c-a, center-a
    normal = np.cross(ab, ac)
    normal2 = np.einsum('ij,ij->i', normal, normal)
    if np.any(normal2 <= 1e-20):
        raise ValueError('Degenerate surface triangle')
    projected = center - (np.einsum('ij,ij->i', ap, normal) / normal2)[:, None] * normal
    v = projected-a
    aa, bb, cc = (np.einsum('ij,ij->i', u, v) for u, v in [(ab, ab), (ab, ac), (ac, ac)])
    va, vc = np.einsum('ij,ij->i', v, ab), np.einsum('ij,ij->i', v, ac)
    denom = aa*cc-bb*bb
    u, w = (va*cc-vc*bb)/denom, (vc*aa-va*bb)/denom
    inside_face = (u >= 0) & (w >= 0) & (u+w <= 1)
    distances = np.where(inside_face, np.linalg.norm(projected-center, axis=1), np.inf)
    for start, end in [(a,b), (b,c), (c,a)]:
        edge = end-start
        t = np.clip(np.einsum('ij,ij->i', center-start, edge) / np.einsum('ij,ij->i', edge, edge), 0, 1)
        distances = np.minimum(distances, np.linalg.norm(start+t[:,None]*edge-center, axis=1))
    distance = float(np.min(distances))
    rays = tri-center
    lengths = np.linalg.norm(rays, axis=2)
    x,y,z = rays[:,0], rays[:,1], rays[:,2]
    solid_denom = np.prod(lengths, axis=1) + np.einsum('ij,ij->i',x,y)*lengths[:,2] + np.einsum('ij,ij->i',y,z)*lengths[:,0] + np.einsum('ij,ij->i',z,x)*lengths[:,1]
    winding = float(np.sum(2*np.arctan2(np.einsum('ij,ij->i',x,np.cross(y,z)), solid_denom))/(4*np.pi))
    contained = abs(winding) > .5 and distance > 1e-8
    return max(0., radius + distance if contained else radius-distance), contained, distance


def assess_capture_data(data):
    if data.get('schema') != 'viscera.liver-motion-capture/1':
        raise ValueError('Unsupported motion capture schema')
    units = data.get('units', {})
    if any(units.get(k) != v for k, v in {'positions': 'mm', 'time': 's', 'force': 'N', 'work': 'J'}.items()):
        raise ValueError('Require explicit mm, s, N and J units')
    ref = np.asarray(data['cage']['reference_positions_mm'], dtype=float)
    if ref.ndim != 1 or len(ref) % 3 or len(ref) < 12 or not np.isfinite(ref).all():
        raise ValueError('Finite flat reference xyz required')
    ref = ref.reshape(-1, 3)
    raw_tets = np.asarray(data['cage']['tets'])
    if raw_tets.ndim != 1 or len(raw_tets) % 4 or len(raw_tets) == 0 or not np.issubdtype(raw_tets.dtype, np.integer):
        raise ValueError('Flat integer tetrahedra required')
    tets = raw_tets.reshape(-1, 4)
    if tets.min() < 0 or tets.max() >= len(ref):
        raise ValueError('Tetrahedron index outside reference mesh')
    det0 = tetra_determinants(ref, tets)
    if np.any(det0 <= 0):
        raise ValueError('Positive reference tetrahedra required')
    raw_faces = np.asarray(data['cage'].get('surface_indices', []))
    faces = None
    nonmanifold_edges = 0
    edge_incidence = {}
    if raw_faces.size:
        if raw_faces.ndim != 1 or len(raw_faces) % 3 or not np.issubdtype(raw_faces.dtype, np.integer):
            raise ValueError('Flat integer surface triangles required')
        faces = raw_faces.reshape(-1, 3)
        if faces.min() < 0 or faces.max() >= len(ref):
            raise ValueError('Surface index outside reference mesh')
        # Winding containment supports a closed oriented boundary chain, including sheets meeting along an edge.
        directed = {}
        for f in faces:
            for i,j in zip(f, np.roll(f, -1)):
                directed[(int(i),int(j))] = directed.get((int(i),int(j)), 0)+1
        if any(directed.get((j,i),0) != n for (i,j),n in directed.items()):
            raise ValueError('Closed consistently oriented boundary required for signed surface audit')
        nonmanifold_edges = sum(n != 1 for (i,j),n in directed.items() if i < j)
        edge_incidence = dict(Counter(2*n for (i,j),n in directed.items() if i < j))
        boundary = Counter(tuple(sorted(t[list(ids)])) for t in tets for ids in [(0,2,1),(0,1,3),(0,3,2),(1,2,3)])
        given = Counter(tuple(sorted(f)) for f in faces)
        if any(n != 1 for n in given.values()) or set(given) != {f for f,n in boundary.items() if n == 1}:
            raise ValueError('Surface must contain exactly the unique exterior tetrahedron faces')
    samples = data['samples']
    if not samples:
        raise ValueError('At least one recorded sample required')
    rows, issues, segments = [], [], {}
    previous = None
    coarse_work = solver_work_on_pairs = 0.
    work_pairs = solver_work_pairs = force_samples = 0
    maximum_jacobian_disagreement = 0.
    camera_samples = surface_samples = contained_samples = 0
    degenerate_surface_samples = 0
    max_surface_penetration = max_surface_disagreement = 0.
    lifecycle = []
    for index, sample in enumerate(samples):
        wall = float(sample['wall_time_s'])
        sim = float(sample['metrics']['simulation_time_s'])
        segment = sample['segment']
        if not np.isfinite([wall, sim]).all() or wall < 0 or sim < 0 or not isinstance(segment, int) or segment < 0:
            raise ValueError('Nonnegative finite clocks and integer segment required')
        x = vector(sample['node_positions_mm'], ref.size, 'Node positions').reshape(-1, 3)
        camera_keys = ['camera_position_mm','camera_target_mm','camera_fov_degrees','camera_aspect']
        if any(k in sample for k in camera_keys):
            camera_position = vector(sample['camera_position_mm'], 3, 'Camera position')
            camera_target = vector(sample['camera_target_mm'], 3, 'Camera target')
            fov, aspect = float(sample['camera_fov_degrees']), float(sample['camera_aspect'])
            if not np.isfinite([fov,aspect]).all() or not 0 < fov < 180 or aspect <= 0 or np.linalg.norm(camera_position-camera_target) <= 1e-10:
                raise ValueError('Valid camera pose, field of view and aspect required')
            camera_samples += 1
        if faces is not None:
            tri = x[faces]
            if np.any(np.linalg.norm(np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]),axis=1) <= 1e-10):
                degenerate_surface_samples += 1
                issues.append({'sample':index,'issue':'degenerate_surface_triangle'})
        if previous:
            if wall <= previous['wall'] or segment < previous['segment']:
                raise ValueError('Wall clock must increase and segments cannot go backwards')
            if segment == previous['segment'] and sim < previous['sim'] - 1e-12:
                raise ValueError('Simulation clock decreased without a new segment')
        if segment not in segments:
            segments[segment] = {'first': x.copy(), 'first_wall_s': wall, 'first_simulation_s': sim, 'sample_count': 0}
        group = segments[segment]
        group['sample_count'] += 1
        group['last_wall_s'], group['last_simulation_s'] = wall, sim
        det = tetra_determinants(x, tets)
        minimum_j = float(np.min(det / det0))
        reported_j = float(sample['metrics']['minimum_jacobian'])
        if not np.isfinite(reported_j):
            raise ValueError('Reported minimum Jacobian must be finite')
        disagreement = abs(minimum_j - reported_j)
        maximum_jacobian_disagreement = max(maximum_jacobian_disagreement, disagreement)
        if minimum_j <= 0:
            issues.append({'sample': index, 'issue': 'inverted_or_degenerate_tet', 'minimum_jacobian': minimum_j})
        if disagreement > 1e-4:
            issues.append({'sample': index, 'issue': 'reported_jacobian_mismatch', 'absolute_error': disagreement})
        force = None
        metrics = sample['metrics']
        for name in ['probe_work_j', 'floor_friction_dissipated_j', 'floor_normal_reaction_n']:
            if name in metrics and not np.isfinite(metrics[name]):
                raise ValueError(f'{name} must be finite when provided')
        if metrics.get('floor_friction_dissipated_j', 0) < -1e-12:
            issues.append({'sample': index, 'issue': 'negative_floor_friction_dissipation'})
        if metrics.get('floor_normal_reaction_n', 0) < -1e-12:
            issues.append({'sample': index, 'issue': 'tensile_unilateral_floor_reaction'})
        if 'probe_reaction_n' in metrics:
            force = vector(metrics['probe_reaction_n'], 3, 'Force on probe')
            force_samples += 1
            scalar = metrics.get('probe_normal_force_n')
            if scalar is not None and (not np.isfinite(scalar) or scalar < -1e-12 or np.linalg.norm(force) > scalar + 1e-8):
                issues.append({'sample': index, 'issue': 'inconsistent_sum_of_normal_forces'})
        probe = sample.get('contact', {}).get('probe')
        center = vector(probe['centerMm'], 3, 'Actual probe center') if probe else None
        if probe:
            radius = float(probe['radiusMm'])
            if not np.isfinite(radius) or radius <= 0:
                raise ValueError('Positive finite probe radius required')
            if faces is not None:
                penetration, contained, clearance = sphere_surface_penetration_mm(x, faces, center, radius)
                surface_samples += 1
                contained_samples += int(contained)
                max_surface_penetration = max(max_surface_penetration, penetration)
                reported_penetration = metrics.get('maximum_probe_surface_penetration_mm')
                if reported_penetration is not None:
                    if not np.isfinite(reported_penetration) or reported_penetration < 0:
                        raise ValueError('Finite nonnegative surface penetration required')
                    error = abs(penetration-reported_penetration)
                    max_surface_disagreement = max(max_surface_disagreement, error)
                    if error > 1e-3:
                        issues.append({'sample':index,'issue':'reported_surface_penetration_mismatch','absolute_error_mm':error})
        boundary_reasons = []
        if previous:
            old_probe = previous['sample'].get('contact', {}).get('probe')
            if segment != previous['segment']:
                boundary_reasons.append('segment_reset')
            if bool(probe) != bool(old_probe):
                boundary_reasons.append('activation' if probe else 'removal')
            if probe and old_probe and probe['radiusMm'] != old_probe['radiusMm']:
                boundary_reasons.append('radius_change')
            if segment == previous['segment']:
                for counter in ['probe_activation_count','probe_removal_count']:
                    if counter in metrics and counter in previous['sample']['metrics']:
                        difference = metrics[counter]-previous['sample']['metrics'][counter]
                        if difference < 0:
                            issues.append({'sample':index,'issue':'lifecycle_counter_decreased','counter':counter})
                        if difference != 0:
                            boundary_reasons.append(f'{counter}:{difference}')
        elif probe:
            boundary_reasons.append('capture_begins_with_active_probe')
        if boundary_reasons:
            lifecycle.append({'sample':index,'wall_time_s':wall,'segment':segment,'reasons':boundary_reasons})
        if not probe and force is not None and np.linalg.norm(force) > 1e-8:
            issues.append({'sample': index, 'issue': 'nonzero_probe_force_without_probe'})
        if previous and segment == previous['segment']:
            if sample.get('paused') and previous['sample'].get('paused'):
                if sim != previous['sim'] or not np.array_equal(x, previous['x']):
                    issues.append({'sample': index, 'issue': 'state_advanced_between_paused_samples'})
            loss = metrics.get('floor_friction_dissipated_j')
            old_loss = previous['sample']['metrics'].get('floor_friction_dissipated_j')
            if loss is not None and old_loss is not None and (not np.isfinite(loss) or loss < old_loss - 1e-12):
                issues.append({'sample': index, 'issue': 'floor_friction_dissipation_decreased'})
            old_probe = previous['sample'].get('contact', {}).get('probe')
            if not boundary_reasons and probe and old_probe and probe['radiusMm'] == old_probe['radiusMm'] and force is not None and previous['force'] is not None:
                coarse_work -= float(np.dot(.5 * (force + previous['force']), center - previous['center'])) * .001
                work_pairs += 1
                if 'probe_work_j' in metrics and 'probe_work_j' in previous['sample']['metrics']:
                    solver_work_on_pairs += metrics['probe_work_j'] - previous['sample']['metrics']['probe_work_j']
                    solver_work_pairs += 1
        rows.append({'sample': index, 'segment': segment, 'wall_time_s': wall, 'simulation_time_s': sim,
                     'minimum_jacobian': minimum_j, 'volume_change_pct': float((det.sum() / det0.sum() - 1) * 100),
                     **shape_change(group['first'], x)})
        previous = {'sample': sample, 'wall': wall, 'sim': sim, 'segment': segment, 'x': x,
                    'force': force, 'center': center}
    summaries = []
    for segment, group in segments.items():
        group = {k: v for k, v in group.items() if k != 'first'}
        group['segment'] = segment
        group['elapsed_wall_s'] = group['last_wall_s'] - group['first_wall_s']
        group['elapsed_simulation_s'] = group['last_simulation_s'] - group['first_simulation_s']
        summaries.append(group)
    return {'evidence_class': 'independent audit of simulated capture, not acquired tissue',
            'physical_validation': 'NOT_RUN', 'expert_human_validation': 'NOT_RUN',
            'numerical_status': 'PASS' if not issues else 'FAIL', 'issues': issues,
            'source': data.get('source'), 'parameters': data.get('parameters'),
            'sample_count': len(rows), 'segments': summaries, 'reference_volume_m3': float(det0.sum() / 6 * 1e-9),
            'independent_minimum_jacobian': min(r['minimum_jacobian'] for r in rows),
            'maximum_reported_jacobian_disagreement': maximum_jacobian_disagreement,
            'boundary_topology': {'manifold_status':'FAIL' if nonmanifold_edges else ('PASS_EDGE_INCIDENCE_ONLY' if faces is not None else 'NOT_RUN'),
                'edge_incidence_histogram':edge_incidence,'nonmanifold_edges':nonmanifold_edges,
                'tet_boundary_identity':'PASS' if faces is not None else 'NOT_RUN',
                'closed_oriented_chain':'PASS' if faces is not None else 'NOT_RUN',
                'samples_with_degenerate_surface_faces':degenerate_surface_samples,
                'self_intersection_check':'NOT_RUN',
                'limitation':'Balanced winding is a diagnostic over the exported tetrahedral boundary, not certification of manifold anatomy or intersection-free geometry.'},
            'camera_audit': {'status': 'PASS' if camera_samples == len(samples) else 'INCOMPLETE', 'samples_with_camera':camera_samples},
            'surface_contact_audit': {'status':'INDEPENDENT_GEOMETRY' if surface_samples else 'NOT_RUN',
                'active_probe_samples':surface_samples,'contained_center_samples':contained_samples,
                'nonmanifold_boundary_edges':nonmanifold_edges,
                'maximum_penetration_mm':max_surface_penetration if surface_samples else None,
                'maximum_reported_disagreement_mm':max_surface_disagreement if surface_samples else None,
                'method':'Exact point-to-triangle distance and closed-oriented-boundary solid-angle containment; actual accepted sphere center.'},
            'contact_lifecycle_boundaries': lifecycle,
            'maximum_pair_distance_change_rms_mm': max(r['all_pair_distance_change_rms_mm'] for r in rows),
            'probe_work_audit': {'status': 'SAMPLED_APPROXIMATION' if work_pairs else 'NOT_RUN',
                                 'force_samples': force_samples, 'eligible_adjacent_pairs': work_pairs,
                                 'pairs_with_solver_work': solver_work_pairs,
                                 'coarse_signed_work_on_tissue_j': coarse_work if work_pairs else None,
                                 'solver_work_change_on_same_pairs_j': solver_work_on_pairs if solver_work_pairs else None,
                                 'coarse_minus_solver_j': coarse_work - solver_work_on_pairs if work_pairs and solver_work_pairs == work_pairs else None,
                                 'convention': 'Minus integral of force ON tool dotted with actual accepted tool center displacement.',
                                 'limitation': 'At-most-30Hz samples omit substeps and may miss contact episodes. No integration across reset, missing contact, radius changes, or changed activation/removal counters; no stiffness or passivity inference from coarse work mismatch.'},
            'rows': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    raw = args.capture.read_bytes()
    result = assess_capture_data(json.loads(raw))
    result.update(path=str(args.capture), sha256=hashlib.sha256(raw).hexdigest())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    print(json.dumps({k: result[k] for k in ['numerical_status', 'sample_count', 'independent_minimum_jacobian', 'probe_work_audit']}))


if __name__ == '__main__':
    main()
