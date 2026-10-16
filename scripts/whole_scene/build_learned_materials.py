"""Apply the existing inverse SLS network to explicitly synthetic scene materials.
This does not train organ-specific biological mechanics. All observations here are
new synthetic design experiments; density is a fixed design choice, not inferred.
Run: OPENBLAS_NUM_THREADS=1 viscera/.venv/bin/python viscera/scripts/whole_scene/build_learned_materials.py
"""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/'viscera/py'))
import numpy as np
from viscera_core.physics_learning_v2 import infer_observation, stress_response

ASSETS = ROOT/'viscera/apps/studio/public/anatomy-scene'
MODEL = ROOT/'viscera/artifacts/physics/liver-network-v2'
CATEGORY_DESIGN = {
    'digestive': [4200., .40, .72],
    'urinary': [5700., .33, .58],
    'respiratory': [2300., .49, .91],
    'cardiovascular': [8100., .28, .43],
    'connective': [11500., .24, .39],
}

def main():
    manifest=json.loads((ASSETS/'manifest.json').read_text())
    materials=[]
    times=np.linspace(0., 7., 113)
    strain=.024*np.minimum(np.clip(times/.8,0,1), np.clip((4.7-times)/.85,0,1))
    test_times=np.linspace(0.,5.2,101)
    test_strain=.017*np.sin(np.pi*test_times/5.2)**2
    for organ in manifest['organs']:
        if organ['category']=='skeleton':continue
        seed=int(hashlib.sha256(organ['id'].encode()).hexdigest()[:8],16)
        rng=np.random.default_rng(seed)
        design=np.array(CATEGORY_DESIGN[organ['category']])*np.array([rng.uniform(.88,1.12),rng.uniform(.92,1.08),rng.uniform(.91,1.09)])
        stress=stress_response(times,strain,design)
        # Deterministic low-amplitude observation noise; tared force at t=0.
        noisy=stress+rng.normal(0.,max(abs(stress))*.002,len(stress));noisy[0]=0.
        reference_length=20.;reference_area=100.
        provenance=f'Synthetic scene design experiment for {organ["id"]}; standard linear solid simulator, seed {seed}; category preset, not measured human {organ["label"]} tissue. Metric calibration is synthetic: L0=20 mm; A0=100 mm^2.'
        result=infer_observation(MODEL,times_s=times.tolist(),force_n=(noisy*reference_area*1e-6).tolist(),displacement_mm=(strain*reference_length).tolist(),reference_length_mm=reference_length,reference_area_mm2=reference_area,provenance=provenance)
        if not result['accepted_for_application']:raise RuntimeError((organ['id'],result['rejection_reasons']))
        predicted=np.array([result['parameters'][k] for k in ('young_pa','relaxation_fraction','relaxation_time_s')])
        actual_test=stress_response(test_times,test_strain,design)
        prediction_test=stress_response(test_times,test_strain,predicted)
        error=float(np.sqrt(np.mean((actual_test-prediction_test)**2))/np.max(abs(actual_test)))
        if error>.02:raise RuntimeError(f'{organ["id"]}: held-out error {error} > .02')
        materials.append(dict(id=organ['id'],**result['parameters'],density_kg_m3=1000.,accepted_for_application=True,observation_origin='synthetic-design-history',category=organ['category'],model_id=result['model_id'],design_parameters=dict(zip(('young_pa','relaxation_fraction','relaxation_time_s'),design.tolist())),neural_parameters=result['neural_parameters'],parameter_intervals_90=result['parameter_intervals_90'],fit_stress_nrmse=result['stress_nrmse'],held_out_waveform_stress_nrmse=error,diagnostics=result['diagnostics'],provenance=provenance))
    payload={'schema_version':'whole-scene-materials-1.0.0','model_id':materials[0]['model_id'],'model_version':'liver-inverse-sls-2.0.0','scope':'Existing neural inverse SLS ensemble with bounded physical refinement applied to synthetic category-dependent design histories for all soft scene structures. Not organ-specific biological training, clinical calibration, or validated whole-body tissue mechanics.','observation_origin':'synthetic-design-history','density_provenance':'Fixed 1000 kg/m^3 display-simulation assumption, not learned.','parameter_intervals_scope':'Synthetic inverse-model calibration only; does not measure human tissue uncertainty.','skeleton_scope':'Rib cage, spine and pelvis are rigid supports and have no soft material assigned.','inference_method':'Protocol-conditioned neural ensemble proposal followed by bounded robust physical refinement.','held_out_validation':{'protocol':'New smooth half-sine-squared strain history, distinct from fitting ramp-hold-release history','samples_per_organ':101,'maximum_stress_nrmse':max(x['held_out_waveform_stress_nrmse'] for x in materials),'acceptance_threshold':.02,'accepted_count':len(materials)},'materials':materials}
    payload['scene_asset_sha256'] = manifest['sha256']
    (ASSETS/'learned-materials.json').write_text(json.dumps(payload,indent=2)+'\n')
    print(json.dumps({'accepted':len(materials),'model_id':payload['model_id'],'max_held_out_nrmse':payload['held_out_validation']['maximum_stress_nrmse']}))

if __name__=='__main__':main()
