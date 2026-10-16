#!/usr/bin/env python3
"""Independent saved-trajectory diagnostics. All inputs here are simulated, not tissue GT."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np


def shape_change(a, b):
    a, b = np.asarray(a, dtype=float).reshape(-1, 3), np.asarray(b, dtype=float).reshape(-1, 3)
    if a.shape != b.shape or len(a) < 3 or not np.isfinite([a, b]).all():
        raise ValueError('Finite corresponding xyz landmarks are required')
    ac, bc = a-a.mean(0), b-b.mean(0)
    u, _, vh = np.linalg.svd(bc.T @ ac)
    correction = np.diag([1., 1., np.linalg.det(u @ vh)])
    aligned = bc @ (u @ correction @ vh)
    i, j = np.triu_indices(len(a), 1)
    da, db = np.linalg.norm(a[i]-a[j], axis=1), np.linalg.norm(b[i]-b[j], axis=1)
    return {'rigid_aligned_rms_mm': float(np.sqrt(np.mean(np.sum((aligned-ac)**2,axis=1)))),
            'all_pair_distance_change_rms_mm': float(np.sqrt(np.mean((db-da)**2))),
            'centroid_displacement_mm': float(np.linalg.norm(b.mean(0)-a.mean(0)))}


def tetra_determinants(x,tets):
    q=x[tets]
    return np.linalg.det(np.stack([q[:,1]-q[:,0],q[:,2]-q[:,0],q[:,3]-q[:,0]],axis=2))


def assess_fem(path):
    d=json.loads(path.read_text()); m=d['mesh']; frames=d['frames']
    if d['units']['geometry']!='mm' or d['units']['force']!='N' or d['units']['time']!='s':raise ValueError('Require mm, N, s')
    ref=np.array(m['reference_positions_mm']).reshape(-1,3);tets=np.array(m['tets']).reshape(-1,4)
    det0=tetra_determinants(ref,tets)
    if np.any(det0<=0):raise ValueError('Positive reference elements required')
    time=np.array([f['time_s'] for f in frames]); force=np.array([f['tool_force_n'] for f in frames]);tool=np.array([f['tool_position_mm'] for f in frames])
    if not np.all(np.diff(time)>0):raise ValueError('Strictly increasing aligned time grid required')
    rows=[]
    for f in frames:
        x=np.array(f['positions_mm']).reshape(-1,3); det=tetra_determinants(x,tets)
        rows.append({'time_s':f['time_s'],'phase':f['phase'],'force_magnitude_n':float(np.linalg.norm(f['tool_force_n'])),
            'tool_path_distance_mm':float(np.linalg.norm(np.array(f['tool_position_mm'])-tool[0])),
            'minimum_jacobian':float((det/det0).min()),'volume_change_pct':float((det.sum()/det0.sum()-1)*100),
            'maximum_node_displacement_mm':float(np.linalg.norm(x-ref,axis=1).max()),**shape_change(ref,x)})
    hold=[r for r in rows if r['phase']=='hold']; recovery=[r for r in rows if r['phase']=='recovery'];peak=max(r['maximum_node_displacement_mm'] for r in rows)
    return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'source':d.get('source',{}).get('realized_id'),
        'physical_validation':'NOT_RUN','numerical_only':True,'frames':len(rows),'nodes':len(ref),'tets':len(tets),
        'independent_minimum_jacobian':min(r['minimum_jacobian'] for r in rows),
        'independent_max_abs_volume_change_pct':max(abs(r['volume_change_pct']) for r in rows),
        'force_magnitude_impulse_n_s':float(np.trapezoid(np.linalg.norm(force,axis=1),time)),
        'reaction_force_dot_tool_path_j':float(np.sum(.5*(force[1:]+force[:-1])*np.diff(tool,axis=0))*.001),
        'reaction_work_sign_convention':'Signed integral F_reported dot dx_tool. Not assumed actuator work; force convention must be retained.',
        'hold_end_start_force_ratio':hold[-1]['force_magnitude_n']/hold[0]['force_magnitude_n'] if hold and hold[0]['force_magnitude_n']>0 else None,
        'final_residual_over_peak_node_displacement':rows[-1]['maximum_node_displacement_mm']/peak if recovery and peak else None,
        'recovery_note':'Residual ratio at recorded end only; not a fitted time constant. Max node can change identity.',
        'rows':rows}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--experiment',type=Path,action='append',default=[]);p.add_argument('--instruments',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    out={'evidence_class':'synthetic trajectory audit, not measured validation','experiments':[assess_fem(f) for f in a.experiment]}
    if a.instruments:
        d=json.loads(a.instruments.read_text()); g=d['grasp']; q=d['push']; base=q['before'];samples=q['samples']
        out['instruments']={'path':str(a.instruments),'sha256':hashlib.sha256(a.instruments.read_bytes()).hexdigest(),
          'grasp':shape_change(g['before']['nodePositionsMm'],g['grasped']['nodePositionsMm']),
          'push_samples':[{'simulation_time_s':v['metrics']['simulation_time_s'],**shape_change(base['nodePositionsMm'],v['nodePositionsMm'])} for v in samples],
          'camera_change_max':float(max(np.linalg.norm(np.array(v['cameraPosition'])-base['cameraPosition']) for v in samples)),
          'probe_geometry_error_max_mm':float(max(np.linalg.norm(np.array(v['instrument']['tipMm'])+v['instrument']['contactRadiusMm']*np.array(v['instrument']['axis'])-v['contact']['probe']['centerMm']) for v in samples if v['contact']['probe']))}
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(out,indent=2,allow_nan=False)+'\n')

if __name__=='__main__':main()
