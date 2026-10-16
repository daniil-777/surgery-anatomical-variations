#!/usr/bin/env python3
"""Check released floor reactions against independently integrated cage weight."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from assess_liver_trajectories import tetra_determinants


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('comparison', type=Path)
    parser.add_argument('--male', type=Path, required=True)
    parser.add_argument('--female', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    comparison = json.loads(args.comparison.read_text())
    rows, sources = [], {}
    for name, path in [('male', args.male), ('female', args.female)]:
        fixture = json.loads(path.read_text())
        prepared = fixture.get('prepared', fixture)
        mesh = prepared['mesh']
        ref = np.asarray(mesh['reference_positions_mm'], dtype=float).reshape(-1, 3)
        tets = np.asarray(mesh['tets'], dtype=int).reshape(-1, 4)
        det = tetra_determinants(ref, tets)
        if not np.isfinite(det).all() or np.any(det <= 0):
            raise ValueError('Positive finite reference tetrahedra required')
        volume = float(det.sum() / 6 * 1e-9)
        mass = volume * prepared['parameters']['density_kg_m3']
        weight = mass * prepared['room']['gravity_m_s2']
        if not np.isfinite(weight) or weight <= 0:
            raise ValueError('Positive finite specimen weight required')
        sources[name] = {'fixture_path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                         'source': prepared.get('source'), 'reference_volume_m3': volume, 'mass_kg': mass, 'weight_n': weight}
        for case in comparison['cases']:
            final = case['final']
            if case['name'] == name and final['floor_friction_model'] == 'reaction':
                reaction = final['floor_normal_reaction_n']
                rows.append({'specimen': name, 'variant': case['variant'], 'weight_n': weight,
                             'reported_floor_reaction_n': reaction, 'absolute_error_n': abs(reaction - weight),
                             'relative_error': abs(reaction - weight) / weight,
                             'maximum_speed_m_s': final['maximum_speed_m_s'],
                             'probe_reaction_n': final['probe_reaction_n'],
                             'release_zero_force': case['release_zero_force']})
    result = {'scope': 'Numerical final released-state weight balance. Residual motion may remain; not a clinical validation or a forced-contact equilibrium certificate.',
              'physical_validation': 'NOT_RUN', 'comparison_sha256': hashlib.sha256(args.comparison.read_bytes()).hexdigest(),
              'source_sha256': comparison['source_sha256'], 'specimens': sources, 'cases': rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
    print(json.dumps(rows, indent=2))


if __name__ == '__main__':
    main()
