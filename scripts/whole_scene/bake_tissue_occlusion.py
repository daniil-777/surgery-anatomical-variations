"""Bake deterministic bounded self-organ ambient visibility without moving geometry.

Requires numpy, scipy, trimesh, and rtree. The scalar is a display-lighting estimate,
not measured tissue detail. It excludes other organs so visibility toggles remain
valid. A renderer should cap ambient attenuation; direct lighting remains intact.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import struct
import time
from pathlib import Path

import numpy as np
import trimesh
from scipy.sparse import coo_matrix

from check_scene_connections import read_glb

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT/'viscera/artifacts/whole-scene-quality-2026-10-08/no-occlusion/bodyparts3d-torso.glb'
OUT = ROOT/'viscera/references/whole-scene/tissue-occlusion.npz'


def source_normals(path):
    data=path.read_bytes(); size=struct.unpack_from('<I',data,12)[0]
    doc=json.loads(data[20:20+size]); binary=data[28+size:]; result={}
    for mesh in doc['meshes']:
        acc=doc['accessors'][mesh['primitives'][0]['attributes']['NORMAL']]
        view=doc['bufferViews'][acc['bufferView']]
        result[mesh['name']]=np.frombuffer(binary,dtype='<f4',count=acc['count']*3,offset=view.get('byteOffset',0)+acc.get('byteOffset',0)).reshape(-1,3).astype(float)
    return result


def bounded_ray_distances(mesh, origins, directions, radius):
    """Exact ray/triangle intersections with a finite segment AABB broad phase."""
    ends=origins+directions*radius
    boxes=np.c_[np.minimum(origins,ends)-1e-7,np.maximum(origins,ends)+1e-7]
    candidates=[];ray_ids=[]
    for ray,box in enumerate(boxes):
        ids=list(mesh.triangles_tree.intersection(box))
        candidates.extend(ids);ray_ids.extend([ray]*len(ids))
    distances=np.full(len(origins),np.inf)
    if not candidates:return distances
    ray_ids=np.asarray(ray_ids);triangles=mesh.triangles[np.asarray(candidates)]
    e1=triangles[:,1]-triangles[:,0];e2=triangles[:,2]-triangles[:,0]
    h=np.cross(directions[ray_ids],e2);det=np.einsum('ij,ij->i',e1,h)
    valid=np.abs(det)>1e-12;inverse=np.zeros(len(det));inverse[valid]=1/det[valid]
    s=origins[ray_ids]-triangles[:,0];u=inverse*np.einsum('ij,ij->i',s,h)
    q=np.cross(s,e1);v=inverse*np.einsum('ij,ij->i',directions[ray_ids],q)
    t=inverse*np.einsum('ij,ij->i',e2,q)
    hit=valid&(u>=-1e-9)&(v>=-1e-9)&(u+v<=1+1e-9)&(t>=0)&(t<=radius)
    np.minimum.at(distances,ray_ids[hit],t[hit])
    return distances


def verify_bounded_ray_kernel(meshes):
    cube=trimesh.creation.box(extents=[2,2,2])
    origins=np.array([[-2.,0,0],[0,0,0],[2,0,0],[0,3,0],[0,3,3]])
    directions=np.array([[1.,0,0],[1,0,0],[1,0,0],[0,-1,0],[0,-1,0]])
    expected=np.array([1.,1.,np.inf,2.,np.inf])
    actual=bounded_ray_distances(cube,origins,directions,3.)
    if not np.allclose(actual,expected,atol=1e-9):raise RuntimeError('Analytical finite-ray box test failed')
    if np.isfinite(bounded_ray_distances(cube,origins[:1],directions[:1],.5)).any():raise RuntimeError('Ray exceeded its finite segment')
    samples=0;maximum_error=0.
    for organ in ['small-intestine','colon']:
        vertices,faces=meshes[organ];mesh=trimesh.Trimesh(vertices,faces,process=False)
        selected=np.arange(0,len(vertices),max(1,len(vertices)//180))
        normal=mesh.vertex_normals[selected];origins=vertices[selected]+normal*.2
        bounded=bounded_ray_distances(mesh,origins,normal,18.)
        locations,ray_ids,_=mesh.ray.intersects_location(origins,normal,multiple_hits=False)
        reference=np.full(len(origins),np.inf);reference[ray_ids]=np.linalg.norm(locations-origins[ray_ids],axis=1)
        error=float(np.max(np.abs(np.clip(1-bounded/18,0,1)-np.clip(1-reference/18,0,1))))
        if error>1e-7:raise RuntimeError('Bounded kernel differs from reference triangle rays')
        samples+=len(origins);maximum_error=max(maximum_error,error)
    return {'analytical_cube_cases':6,'reference_bowel_rays':samples,'maximum_attenuation_difference':maximum_error}


def main(source=SOURCE, output=OUT):
    meshes=read_glb(source);normals=source_normals(source); arrays={};stats=[]
    kernel_validation=verify_bounded_ray_kernel(meshes)
    for organ in ['small-intestine','colon']:
        start=time.time();vertices,faces=meshes[organ];normal=normals[organ]
        normal/=np.maximum(np.linalg.norm(normal,axis=1)[:,None],1e-12)
        mesh=trimesh.Trimesh(vertices,faces,process=False)
        guide=np.tile([0.,0.,1.],(len(vertices),1));guide[np.abs(normal[:,2])>.9]=[0.,1.,0.]
        tangent=np.cross(guide,normal);tangent/=np.maximum(np.linalg.norm(tangent,axis=1)[:,None],1e-12)
        bitangent=np.cross(normal,tangent)
        seed=int(hashlib.sha256(organ.encode()).hexdigest()[:8],16);rng=np.random.default_rng(seed)
        phase=rng.uniform(0,2*np.pi,len(vertices)); visibility=np.ones(len(vertices)); rays=16; radius=18.; bias=.2
        for offset in range(0,len(vertices),512):
            end=min(offset+512,len(vertices));count=end-offset
            sample=np.arange(rays); r=np.sqrt((sample+.5)/rays);phi=sample*np.pi*(3-np.sqrt(5))+phase[offset:end,None]
            direction=(tangent[offset:end,None,:]*(r[None,:]*np.cos(phi))[:,:,None]+bitangent[offset:end,None,:]*(r[None,:]*np.sin(phi))[:,:,None]+normal[offset:end,None,:]*np.sqrt(1-r*r)[None,:,None]).reshape(-1,3)
            origins=np.repeat(vertices[offset:end]+bias*normal[offset:end],rays,axis=0)
            distances=bounded_ray_distances(mesh,origins,direction,radius)
            blocked=np.clip(1-distances/radius,0,1)
            visibility[offset:end]=1-blocked.reshape(count,rays).mean(axis=1)
            if offset%4096==0:print(organ,end,'/',len(vertices),round(time.time()-start,1),'s',flush=True)
        # Two conservative neighbor passes suppress low-ray Monte Carlo noise.
        edges=mesh.edges_unique; row=np.r_[edges[:,0],edges[:,1]]; col=np.r_[edges[:,1],edges[:,0]]
        adjacency=coo_matrix((np.ones(len(row)),(row,col)),shape=(len(vertices),len(vertices))).tocsr()
        degree=np.maximum(np.asarray(adjacency.sum(axis=1)).ravel(),1)
        for _ in range(2):visibility=.65*visibility+.35*(adjacency@visibility)/degree
        visibility=np.clip(visibility,0,1).astype(np.float32)
        if not np.isfinite(visibility).all():raise RuntimeError('Non-finite visibility')
        arrays[organ]=visibility
        stats.append({'id':organ,'vertex_count':len(vertices),'rays_per_vertex':rays,'radius_mm':radius,'origin_bias_mm':bias,'seed':seed,'visibility_min_p05_p50_p95_max':np.percentile(visibility,[0,5,50,95,100]).tolist(),'seconds':time.time()-start})
    output.parent.mkdir(parents=True,exist_ok=True);np.savez_compressed(output,**arrays)
    output.with_suffix('.json').write_text(json.dumps({'source_asset_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'attribute':'_TISSUE_OCCLUSION','range':[0,1],'meaning':'1 unoccluded; 0 fully locally occluded','method':'Sixteen deterministic cosine-hemisphere samples per vertex; self-organ triangle rays with 0.2 mm outward origin bias and linearly decreasing 18 mm range; two 35% adjacent-vertex smoothing passes.','scope':'Authored display ambient visibility only, no other-organ occlusion, no coordinate or topology modification, no anatomical or optical measurement.','kernel_validation':kernel_validation,'recommended_maximum_ambient_attenuation':.35,'structures':stats},indent=2)+'\n')
    print(json.dumps(stats),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,default=SOURCE);parser.add_argument('--output',type=Path,default=OUT);args=parser.parse_args();main(args.source,args.output)
