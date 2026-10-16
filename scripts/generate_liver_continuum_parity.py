"""Regenerate deterministic Python/TypeScript constitutive parity reference."""
import hashlib,json,inspect
from pathlib import Path
import numpy as np
from viscera_core.liver_physics import LiverParameters,constitutive_response,deviatoric_green
source=Path(inspect.getfile(constitutive_response))
rng=np.random.default_rng(281994)
records=[]
for parameter in [LiverParameters(5000,.45,.4,.7),LiverParameters(500,.2,.75,2),LiverParameters(20000,.48,.05,.05),LiverParameters(9000,.45,0,.7)]:
 old=np.zeros((3,3));memory=np.zeros((3,3));frames=[]
 for i in range(12):
  f=np.eye(3)+rng.normal(0,.075,(3,3));dt=[1/240,.01,.05,.2][i%4]
  energy,piola,memory=constitutive_response(f,parameter,dt,old,memory);old=deviatoric_green(f)
  frames.append({'F':f.reshape(-1).tolist(),'dt':dt,'energy_density_pa':float(energy),'piola_pa':piola.reshape(-1).tolist()})
 records.append({'parameters':parameter.__dict__,'frames':frames})
(Path(__file__).resolve().parents[1] / 'apps/studio/src/fixtures/liver-continuum-python-parity.json').write_text(json.dumps({'reference':'viscera_core.liver_physics.constitutive_response','reference_source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'generated_by':'scripts/generate_liver_continuum_parity.py; numpy RNG281994;48finite-gradient history states','cases':records},indent=2)+'\n')
