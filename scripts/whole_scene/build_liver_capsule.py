"""Derive a continuous liver display capsule from registered source segments.
No convex hull or organ repositioning. Candidate only until explicitly selected.
Requires the project's scientific Python environment (numpy, scipy, trimesh, skimage).
"""
from pathlib import Path
import argparse, hashlib, sys, json
import numpy as np
import trimesh
from scipy.spatial import cKDTree
from scipy.ndimage import binary_closing, binary_fill_holes, distance_transform_edt, gaussian_filter
from skimage.measure import marching_cubes
from check_scene_connections import read_glb
ROOT=Path(__file__).resolve().parents[3]
BASELINE_SOURCE = ROOT/'viscera/artifacts/whole-scene-2026-10-08/source-candidates/bodyparts3d-torso-source.glb'
BASELINE_SHA256 = '040b58a57ae73df34494970e80840cb83f12f102ded7336d7fe8d928b0736c50'
def distance(points,v,f):
 tri=v[f];tree=cKDTree(tri.mean(axis=1));result=[]
 for start in range(0,len(points),2048):
  pts=points[start:start+2048];_,idx=tree.query(pts,k=32);t=tri[idx];a,b,c=t[:,:,0],t[:,:,1],t[:,:,2];pt=pts[:,None,:];ab=b-a;ac=c-a;bc=c-b;pa=pt-a;n=np.cross(ab,ac);n2=np.maximum((n*n).sum(-1),1e-24);ab2=np.maximum((ab*ab).sum(-1),1e-24);ac2=np.maximum((ac*ac).sum(-1),1e-24);bc2=np.maximum((bc*bc).sum(-1),1e-24);abac=(ab*ac).sum(-1);den=np.maximum(ab2*ac2-abac**2,1e-24);nab=(pa*ab).sum(-1);nac=(pa*ac).sum(-1);u=(ac2*nab-abac*nac)/den;w=(ab2*nac-abac*nab)/den;d=np.where((u>=0)&(w>=0)&(u+w<=1),((pa*n).sum(-1)**2)/n2,np.inf)
  for origin,edge,sq in [(a,ab,ab2),(a,ac,ac2),(b,bc,bc2)]:
   delta=pt-origin;s=np.clip((delta*edge).sum(-1)/sq,0,1);d=np.minimum(d,((delta-s[:,:,None]*edge)**2).sum(-1))
  result.extend(np.sqrt(d.min(axis=1)))
 return np.array(result)

def stats(a):return {'max':float(a.max()),'p95':float(np.quantile(a,.95)),'median':float(np.median(a))}

def main(source=BASELINE_SOURCE, allow_derived_source=False):
    target=ROOT/'viscera/references/whole-scene'
    source = Path(source)
    source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_sha256 != BASELINE_SHA256 and not allow_derived_source:
        raise ValueError('Expected the archived original-segment baseline GLB. Refusing to derive a capsule from an unverified or already derived surface; use --source with the original baseline.')
    v,f=read_glb(source)['liver']
    source_mesh=trimesh.Trimesh(v,f,process=False)
    vox=source_mesh.voxelized(pitch=1.0)
    solid=binary_fill_holes(binary_closing(np.pad(vox.matrix,2),iterations=1))
    signed_distance = distance_transform_edt(solid) - distance_transform_edt(~solid)
    field = gaussian_filter(signed_distance, sigma=1.25)
    nv,nf,_,_=marching_cubes(field,level=0.,step_size=2,allow_degenerate=False)
    nv+=vox.translation-2.
    capsule=trimesh.Trimesh(nv,nf,process=False)
    trimesh.smoothing.filter_taubin(capsule,lamb=.5,nu=.53,iterations=8)
    if capsule.volume < 0:
        capsule.invert()
    nv=capsule.vertices;nf=capsule.faces
    forward=distance(nv,v,f);reverse=distance(v,nv,nf)
    exposed=set()
    for axis in range(3):
        other=[i for i in range(3) if i!=axis];bins={}
        for index,point in enumerate(v):
            key=tuple(np.rint(point[other]/3.).astype(int))
            if key not in bins:bins[key]=[index,index]
            if point[axis]<v[bins[key][0],axis]:bins[key][0]=index
            if point[axis]>v[bins[key][1],axis]:bins[key][1]=index
        for pair in bins.values():exposed.update(pair)
    np.savez_compressed(target/'liver-envelope-sdf.npz',vertices=nv,faces=nf)
    report={
        'method':'1 mm surface voxelization; padded grid; one 3×3×3 binary closing; enclosed-volume fill; signed distance Gaussian-filtered with sigma 1.25 mm; marching cubes sampled every 2 voxels; 8 Taubin smoothing iterations lambda=.5 nu=.53; outward winding.',
        'scope':'Derived display capsule, not new anatomical ground truth. Original source liver segments retained in the source archive and baseline assets.',
        'source_file':str(source.relative_to(ROOT)) if source.is_relative_to(ROOT) else str(source),
        'source_sha256':source_sha256,
        'source_is_verified_original_segment_baseline':source_sha256 == BASELINE_SHA256,
        'source_vertices':len(v),'source_faces':len(f),'candidate_vertices':len(nv),'candidate_faces':len(nf),
        'source_bounds':source_mesh.bounds.tolist(),'candidate_bounds':capsule.bounds.tolist(),
        'watertight':bool(capsule.is_watertight),'winding_consistent':bool(capsule.is_winding_consistent),'signed_volume_mm3':float(capsule.volume),'connected_components':len(capsule.split(only_watertight=False)),
        'distance_method':'Vertex-to-triangle distance over 32 nearest triangle-centroid candidates: conservative distance upper bounds, not guaranteed exact nearest triangle. All vertices evaluated in both directions.',
        'candidate_to_source_surface_mm':stats(forward),'all_source_to_candidate_surface_mm':stats(reverse),
        'directional_exterior_source_to_candidate_surface_mm':stats(reverse[list(exposed)]),
        'directional_exterior_source_vertex_count':len(exposed),
        'directional_exterior_scope':'Source-only six-axis extremal vertices in 3 mm projected bins, an approximate exposed-source subset; not exact ray-visibility or proof all source exterior points are included.',
        'reverse_scope':'All-source reverse distances include deliberately removed interior segmentation sheets. Their maximum cannot be interpreted as exterior shape error.',
        'shape_claim':'No exact Hausdorff error bound asserted. The capsule removes internal sheets and shallow segmentation creases, while respecting the source external scale and registration.'}
    (target/'liver-envelope-sdf.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report),flush=True)

if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=BASELINE_SOURCE)
    parser.add_argument('--allow-derived-source', action='store_true', help='Experimental override; default rejects any input whose hash differs from the original baseline.')
    args = parser.parse_args()
    main(args.source, args.allow_derived_source)
