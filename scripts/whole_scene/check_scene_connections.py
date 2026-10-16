"""Measure bidirectional vertex-to-triangle gaps for source atlas connections.
The minimum is an upper bound on the true triangle-to-triangle distance. It is
not lumen connectivity, watertightness, or a certification of attachment.
"""
import hashlib, json, struct
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[3]
ASSETS=ROOT/'viscera/apps/studio/public/anatomy-scene'

def read_glb(path=None):
    data=(path or ASSETS/'bodyparts3d-torso.glb').read_bytes();n=struct.unpack_from('<I',data,12)[0];j=json.loads(data[20:20+n]);raw=data[28+n:]
    def accessor(i):
        a=j['accessors'][i];b=j['bufferViews'][a['bufferView']];offset=b.get('byteOffset',0)+a.get('byteOffset',0)
        columns=3 if a['type']=='VEC3' else 1;dtype={5126:'<f4',5125:'<u4',5123:'<u2'}[a['componentType']]
        return np.frombuffer(raw,dtype=dtype,count=a['count']*columns,offset=offset).reshape(-1,columns)
    result={}
    for m in j['meshes']:
        p=m['primitives'][0];result[m['name']]=(accessor(p['attributes']['POSITION']).astype(float),accessor(p['indices']).reshape(-1,3))
    return result

def one_way(points,vertices,faces):
    tri=vertices[faces];a,b,c=tri[:,0],tri[:,1],tri[:,2];ab=b-a;ac=c-a;bc=c-b
    n=np.cross(ab,ac);n2=(n*n).sum(-1);n2=np.maximum(n2,1e-24)
    ab2=np.maximum((ab*ab).sum(-1),1e-24);ac2=np.maximum((ac*ac).sum(-1),1e-24);bc2=np.maximum((bc*bc).sum(-1),1e-24)
    abac=(ab*ac).sum(-1);den=np.maximum(ab2*ac2-abac**2,1e-24)
    best=float('inf')
    for start in range(0,len(points),64):
        p=points[start:start+64,None,:];pa=p-a
        nab=(pa*ab).sum(-1);nac=(pa*ac).sum(-1)
        u=(ac2*nab-abac*nac)/den;v=(ab2*nac-abac*nab)/den
        plane=((pa*n).sum(-1)**2)/n2
        d=np.where((u>=0)&(v>=0)&(u+v<=1),plane,np.inf)
        for origin,edge,squared in [(a,ab,ab2),(a,ac,ac2),(b,bc,bc2)]:
            delta=p-origin;t=np.clip((delta*edge).sum(-1)/squared,0,1)
            edge_distance=((delta-t[:,:,None]*edge)**2).sum(-1);d=np.minimum(d,edge_distance)
        best=min(best,float(np.min(d)))
    return np.sqrt(best)

def main():
    meshes=read_glb();pairs=[('gallbladder','cystic-duct'),('cystic-duct','hepatic-duct'),('hepatic-duct','duodenum'),('pancreatic-duct','duodenum'),('esophagus','stomach'),('stomach','duodenum'),('pancreas','duodenum'),('right-kidney','right-ureter'),('left-kidney','left-ureter'),('right-ureter','urinary-bladder'),('left-ureter','urinary-bladder')];records=[]
    for an,bn in pairs:
        av,af=meshes[an];bv,bf=meshes[bn];gap=float(min(one_way(av,bv,bf),one_way(bv,av,af)));records.append({'from':an,'to':bn,'vertex_to_surface_gap_upper_bound_mm':gap});print(an,bn,round(gap,4),flush=True)
    output={'asset_sha256':hashlib.sha256((ASSETS/'bodyparts3d-torso.glb').read_bytes()).hexdigest(),'method':'Minimum bidirectional vertex-to-triangle Euclidean distance on final shared-frame baseline GLB; upper bound on true triangle-to-triangle distance, with source atlas units assumed millimetres.','scope':'Geometry proximity only. Does not certify lumen connection, manifoldness, tissue continuity or biological contact.','connections':records}
    (ROOT/'viscera/references/whole-scene/connection-proximity.json').write_text(json.dumps(output,indent=2)+'\n')

if __name__=='__main__':main()
