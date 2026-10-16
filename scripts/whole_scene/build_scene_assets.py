"""Build a attributed torso display assembly; preserve BP3D's common atlas frame.
Run from any directory with Python 3. No third-party dependencies are required.
HRA thoracic surfaces are an explicitly approximate cross-atlas bounding-box fit.
"""
from __future__ import annotations
import argparse, ast, hashlib, json, math, struct, zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BP = ROOT / 'reports/anatomy-references-2026-10-06/bodyparts3d'
TEMPLATES = ROOT / 'viscera/datasets/anatomy-templates/templates-v3'
OUT = ROOT / 'viscera/apps/studio/public/anatomy-scene'
ARCHIVE = BP / 'partof_BP3D_4.0_obj_99.zip'
CENTER = [0.0, 1070.0, 110.0]
ATTRIBUTION = 'BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International'

def digest(data): return hashlib.sha256(data).hexdigest()
def bounds(vertices): return [[fn(v[i] for v in vertices) for i in range(3)] for fn in (min, max)]
def merge(parts):
    vertices, faces = [], []
    for v, f in parts:
        offset = len(vertices); vertices.extend(v); faces.extend(tuple(i + offset for i in face) for face in f)
    return vertices, faces

def weld_coincident(vertices, faces):
    """Share normals at duplicate positions; keep the first original coordinate."""
    lookup, remap, welded = {}, [], []
    for vertex in vertices:
        key = tuple(round(value, 5) for value in vertex)
        if key not in lookup:
            lookup[key] = len(welded)
            welded.append(vertex)
        remap.append(lookup[key])
    return welded, [tuple(remap[i] for i in face) for face in faces]

def obj(raw):
    v, f = [], []
    for row in raw.decode().splitlines():
        fields = row.split()
        if not fields: continue
        if fields[0] == 'v':
            x, y, z = map(float, fields[1:4]); v.append((x, z, -y))
        elif fields[0] == 'f':
            indices = [int(s.split('/')[0])-1 for s in fields[1:]]
            f.extend((indices[0], indices[i], indices[i+1]) for i in range(1, len(indices)-1))
    return v, f

def array_from_npz(z, name):
    raw = z.read(name + '.npy'); major = raw[6]
    size = struct.unpack_from('<H' if major == 1 else '<I', raw, 8)[0]; start = 10 if major == 1 else 12
    header = ast.literal_eval(raw[start:start+size].decode())
    if header['fortran_order']: raise ValueError('Fortran array unsupported')
    types = {'<f8': 'd', '<f4': 'f', '<i8': 'q', '<i4': 'i', '<u4': 'I', '<u2': 'H'}
    fmt = '<' + types[header['descr']] * math.prod(header['shape'][1:])
    return list(struct.iter_unpack(fmt, raw[start+size:]))

def hra(organ, side=None):
    meta = json.loads((TEMPLATES / f'hra-{organ}-male.json').read_text())
    with zipfile.ZipFile(TEMPLATES / f'hra-{organ}-male.npz') as z:
        vertices = array_from_npz(z, 'vertices_mm'); faces = array_from_npz(z, 'faces')
    parts=[]
    for c in meta['components']:
        if side and not (f'_{side}_' in c['name'] or c['name'].endswith('_' + side[0].upper())): continue
        start=c['vertex_start']; count=c['vertex_count']; fs=c['face_start']; fc=c['face_count']
        parts.append((vertices[start:start+count], [tuple(i-start for i in face) for face in faces[fs:fs+fc]]))
    return merge(parts), meta

def fit(vertices, target):
    source = bounds(vertices)
    return [tuple(target[0][i] + (v[i]-source[0][i])/(source[1][i]-source[0][i])*(target[1][i]-target[0][i]) for i in range(3)) for v in vertices]

def write_glb(organs):
    binary=bytearray(); views=[]; accessors=[]; meshes=[]; nodes=[]; materials=[]
    def add(values, fmt, components, component_type, type_name, include_bounds=False):
        while len(binary)%4: binary.append(0)
        offset=len(binary)
        for value in values: binary.extend(struct.pack('<'+fmt*components, *value))
        views.append({'buffer':0,'byteOffset':offset,'byteLength':len(binary)-offset})
        a={'bufferView':len(views)-1,'componentType':component_type,'count':len(values),'type':type_name}
        if include_bounds: a.update(min=bounds(values)[0],max=bounds(values)[1])
        accessors.append(a); return len(accessors)-1
    for item in organs:
        v,f=item['_vertices'],item['_faces']; normals=[[0.,0.,0.] for _ in v]
        for a,b,c in f:
            u=[v[b][i]-v[a][i] for i in range(3)];w=[v[c][i]-v[a][i] for i in range(3)]
            n=(u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0])
            for idx in (a,b,c):
                for i in range(3): normals[idx][i]+=n[i]
        normals=[tuple(x/(math.sqrt(sum(q*q for q in n)) or 1) for x in n) for n in normals]
        pi=add(v,'f',3,5126,'VEC3',True);ni=add(normals,'f',3,5126,'VEC3');fi=add([(i,) for face in f for i in face],'I',1,5125,'SCALAR')
        attributes={'POSITION':pi,'NORMAL':ni}
        if '_tissueOcclusion' in item:
            attributes['_TISSUE_OCCLUSION']=add(item['_tissueOcclusion'],'f',1,5126,'SCALAR')
        color=[int(item['color'][i:i+2],16)/255 for i in (1,3,5)]
        materials.append({'name':item['id'],'pbrMetallicRoughness':{'baseColorFactor':color+[1],'metallicFactor':0,'roughnessFactor':0.44},'doubleSided':True})
        meshes.append({'name':item['id'],'primitives':[{'attributes':attributes,'indices':fi,'material':len(materials)-1}],'extras':{'id':item['id'],'category':item['category']}})
        nodes.append({'name':item['id'],'mesh':len(meshes)-1,'extras':{'id':item['id'],'category':item['category'],'source':item['source']}})
    doc={'asset':{'version':'2.0','generator':'VISCERA attributed torso assembler','copyright':ATTRIBUTION+'; HRA creators credited in manifest.json'},'scene':0,'scenes':[{'nodes':list(range(len(nodes)))}],'nodes':nodes,'meshes':meshes,'materials':materials,'accessors':accessors,'bufferViews':views,'buffers':[{'byteLength':len(binary)}]}
    js=json.dumps(doc,separators=(',',':')).encode();js+=b' '*((-len(js))%4);binary+=b'\0'*((-len(binary))%4)
    return struct.pack('<4sII',b'glTF',2,28+len(js)+len(binary))+struct.pack('<I4s',len(js),b'JSON')+js+struct.pack('<I4s',len(binary),b'BIN\0')+binary

def main(envelope_path=None, output_stem='bodyparts3d-torso', manifest_name='manifest.json', output_dir=None, original_selection=False, occlusion_path=None):
    output = Path(output_dir) if output_dir is not None else OUT
    output.mkdir(parents=True,exist_ok=True)
    trees={}
    for tree in ('isa','partof'):
        d=defaultdict(list)
        for row in (BP/f'{tree}_element_parts.txt').read_text().splitlines()[1:]:
            fma,label,mesh=row.split('\t');d[fma].append(mesh)
        trees[tree]=d
    archive=zipfile.ZipFile(ARCHIVE);members={Path(n).stem:n for n in archive.namelist() if n.endswith('.obj')}
    organs=[]; used=set()
    def add(id,label,category,color,fmas,tree='partof',ids=None):
        ids=list(dict.fromkeys(ids or [o for fma in fmas for o in trees[tree][fma]]))
        parts=[];sources=[]
        for meshid in ids:
            if meshid in used: continue
            if meshid in members:
                raw=archive.read(members[meshid]); member=members[meshid]
            else:
                raw=(ROOT/'viscera/references/whole-scene/supplemental-bodyparts3d'/f'{meshid}.obj').read_bytes()
                member=f'isa_BP3D_4.0_obj_99/{meshid}.obj'
            parts.append(obj(raw));used.add(meshid)
            sources.append({'elementId':meshid,'member':member,'sha256':digest(raw)})
        v,f=merge(parts)
        organs.append(dict(id=id,label=label,category=category,color=color,source='BodyParts3D',registration='native shared atlas frame',fmaIds=fmas,sourceIds=[s['elementId'] for s in sources],sourceMeshes=sources,_vertices=v,_faces=f))
    add('liver','Liver','digestive','#7f3536',['FMA13365','FMA15739','FMA15741','FMA15742','FMA15743','FMA15744','FMA15745','FMA15746'],tree='isa')
    add('stomach','Stomach','digestive','#c9837f',['FMA7148'])
    add('gallbladder','Gallbladder','digestive','#648956',['FMA7202'])
    add('pancreas','Pancreas','digestive','#d9a58a',['FMA7198'],tree='isa')
    raw=(ROOT/'viscera/references/whole-scene/spleen-FJ2561.obj').read_bytes();v,f=obj(raw)
    organs.append(dict(id='spleen',label='Spleen',category='digestive',color='#773d54',source='BodyParts3D',registration='native shared atlas frame',fmaIds=['FMA7196'],sourceIds=['FJ2561'],sourceMeshes=[{'elementId':'FJ2561','member':'isa_BP3D_4.0_obj_99/FJ2561.obj','sha256':digest(raw),'archiveUrl':'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip'}],_vertices=v,_faces=f))
    for side,fma in [('right','FMA7204'),('left','FMA7205')]: add(side+'-kidney',side.title()+' kidney','urinary','#a7524c',[fma])
    add('esophagus','Esophagus','digestive','#b97878',['FMA7131'])
    add('duodenum','Duodenum','digestive','#ce9b90',['FMA7206'])
    add('colon','Large intestine','digestive','#bb827e',['FMA7201'])
    add('small-intestine','Small intestine','digestive','#d6a193',['FMA7207','FMA7208'])
    add('urinary-bladder','Urinary bladder','urinary','#c2a287',['FMA15900'])
    for side,fma in [('right','FMA15571'),('left','FMA15572')]:add(side+'-ureter',side.title()+' ureter','urinary','#d2b295',[fma])
    add('cystic-duct','Cystic duct','digestive','#809251',['FMA14539'])
    add('hepatic-duct','Hepatic / common bile duct','digestive','#86945c',['FMA14668','FMA14669','FMA14670'])
    add('pancreatic-duct','Pancreatic duct','digestive','#e1c4a1',['FMA10419'])
    add('aorta','Aorta','cardiovascular','#ae4c46',['FMA3734'])
    add('vena-cava','Vena cava','cardiovascular','#617793',['FMA4720','FMA10951'])
    add('portal-vein','Portal venous connection','cardiovascular','#7b6886',['FMA14329','FMA15414','FMA15415'],tree='isa')
    add('hepatic-artery','Hepatic artery','cardiovascular','#b2574e',['FMA14771','FMA14772'],tree='isa')
    add('trachea','Trachea','respiratory','#ceb2a1',['FMA7394'])
    add('bronchi','Bronchial tree','respiratory','#bf9e89',['FMA7409'],tree='isa')
    add('diaphragm','Diaphragm','connective','#a86d65',['FMA13295'])
    add('rib-cage','Rib cage','skeleton','#ddcdb2',['FMA7480'])
    spineids=[]
    for row in (BP/'partof_parts_list_e.txt').read_text().splitlines()[1:]:
        fma,_,name=row.split('\t')
        if ('thoracic vertebra' in name or 'lumbar vertebra' in name) and 'disk' not in name:spineids.extend(trees['partof'][fma])
    add('spine','Thoracic and lumbar spine','skeleton','#d1bfa2',[],ids=spineids)
    add('pelvis','Bony pelvis and sacrum','skeleton','#d6c5aa',['FMA16580'])
    for side,target in [('right',[[-126,1126,24],[-2,1360,190]]),('left',[[3,1120,22],[130,1368,186]])]:
        (v,f),meta=hra('lung',side);v=fit(v,target)
        organs.append(dict(id=side+'-lung',label=side.title()+' lung',category='respiratory',color='#b88c94',source='Human Reference Atlas',registration='approximate cross-atlas bounds fit; not same donor',sourceIds=[meta['template_id']],sourceUrl=meta['source_url'],sourceSha256=meta['artifact_sha256'],attribution=meta['attribution'],license='CC-BY-4.0',targetBoundsAtlasMm=target,_vertices=v,_faces=f))
    (v,f),meta=hra('heart');v=fit(v,[[-36.3,1174.9,70.2],[79.4,1279.5,176.5]])
    organs.append(dict(id='heart',label='Heart',category='cardiovascular',color='#a04b50',source='Human Reference Atlas',registration='approximate cross-atlas bounds fit; not same donor',sourceIds=[meta['template_id']],sourceUrl=meta['source_url'],sourceSha256=meta['artifact_sha256'],attribution=meta['attribution'],license='CC-BY-4.0',_vertices=v,_faces=f))
    if not original_selection:
        add('mesentery','Small-intestinal mesentery','connective','#d6bd96',['FMA14643'])
        for organ_id,label,fma in [
            ('superior-mesenteric-artery','Superior mesenteric artery','FMA14749'),
            ('inferior-mesenteric-artery','Inferior mesenteric artery','FMA14750'),
            ('right-renal-artery','Right renal artery','FMA14752'),
            ('left-renal-artery','Left renal artery','FMA14753'),
            ('splenic-artery','Splenic artery','FMA14773'),
            ('celiac-trunk','Celiac trunk','FMA14812'),
        ]:
            add(organ_id,label,'cardiovascular','#ad6559',[fma])
        for side,fma in [('right','FMA14335'),('left','FMA14336')]:
            add(side+'-renal-vein',side.title()+' renal vein','cardiovascular','#817180',[fma],tree='isa')
    if envelope_path:
        with zipfile.ZipFile(envelope_path) as capsule:
            capsule_vertices = array_from_npz(capsule, 'vertices')
            capsule_faces = array_from_npz(capsule, 'faces')
        liver = next(o for o in organs if o['id'] == 'liver')
        liver['derivedCapsule'] = True
        liver['sourceVertexCount'] = len(liver['_vertices'])
        liver['sourceFaceCount'] = len(liver['_faces'])
        liver['_vertices'] = [tuple(v[i] + CENTER[i] for i in range(3)) for v in capsule_vertices]
        liver['_faces'] = capsule_faces
        liver['capsuleDerivation'] = json.loads(Path(envelope_path).with_suffix('.json').read_text())
    for o in organs:
        o['_vertices']=[tuple(v[i]-CENTER[i] for i in range(3)) for v in o['_vertices']]
        original_count = len(o['_vertices'])
        o['_vertices'], o['_faces'] = weld_coincident(o['_vertices'], o['_faces'])
        o['coincidentVerticesWelded'] = original_count - len(o['_vertices'])
        o['weldToleranceMm'] = 0.00001
        o['bounds']=bounds(o['_vertices']);o['center']=[sum(c)/2 for c in zip(*o['bounds'])];o['vertexCount']=len(o['_vertices']);o['faceCount']=len(o['_faces'])
    if occlusion_path:
        occlusion_metadata=json.loads(Path(occlusion_path).with_suffix('.json').read_text())
        if digest(write_glb(organs)) != occlusion_metadata['source_asset_sha256']:
            raise ValueError('Occlusion source hash does not match this exact assembled geometry')
        with zipfile.ZipFile(occlusion_path) as occlusion:
            for o in organs:
                if o['id']+'.npy' not in occlusion.namelist():continue
                values=array_from_npz(occlusion,o['id'])
                if len(values)!=len(o['_vertices']) or any(not math.isfinite(v[0]) or not 0<=v[0]<=1 for v in values):
                    raise ValueError('Occlusion attribute does not match the finite unit-range vertex contract')
                o['_tissueOcclusion']=values
                o['ambientVisibilityAttribute']='_TISSUE_OCCLUSION'
    blob=write_glb(organs);(output/(output_stem+'.glb')).write_bytes(blob)
    manifest={'schemaVersion':'1.0','asset':'/anatomy-scene/bodyparts3d-torso.glb','sha256':digest(blob),'units':'atlas millimetres (source OBJ scale assumed)','coordinateSystem':{'x':'patient left','y':'superior','z':'anterior','sourceTransform':'(x,y,z) -> (x,z,-y) - commonCenter','commonCenter':CENTER},'bounds':bounds([v for o in organs for v in o['_vertices']]),'sourceUrl':'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html','license':'CC-BY-4.0','licenseUrl':'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html','attribution':ATTRIBUTION,'archiveSha256':digest(ARCHIVE.read_bytes()),'modifications':'Shared rigid coordinate conversion and common translation; selected original mesh components concatenated by named organ; display colors and normals assigned. HRA heart/lungs fitted as explicitly approximate thoracic replacements. No deformation or arbitrary placement of BP3D organs.','limitations':['Adult male authored atlas, not a population or patient scan.','Official BP3D source has 99% polygon reduction; smooth shading adds no measured tissue detail.','HRA lungs and heart are independently fitted display surfaces, not validated same-donor registration.','The source common hepatic duct element includes the inferior extrahepatic bile route; label reflects combined surface.','Color, pathology and animation are illustrative; no physiological or surgical validation.','Connected visual surfaces do not establish watertight lumens or volumetric finite-element meshes.'],'organs':[{k:v for k,v in o.items() if not k.startswith('_')} for o in organs]}
    manifest['asset'] = '/anatomy-scene/' + output_stem + '.glb'
    if not original_selection:
        manifest['supplementalSourceManifest'] = 'references/whole-scene/supplemental-bodyparts3d/source-manifest.json'
        manifest['limitations'].append('Mesentery and added vascular branches retain source component fragmentation; no lumen continuity or physiological flow is inferred.')
    manifest['modifications'] += ' Coincident vertices within 0.00001 mm share indices and smooth normals; first original vertex coordinates retained.'
    if envelope_path:
        manifest['modifications'] += ' Liver segment assembly replaced by an explicitly derived continuous voxel capsule; per-organ derivation and geometric comparison recorded.'
    if occlusion_path:
        manifest['ambientVisibilityDerivation']=json.loads(Path(occlusion_path).with_suffix('.json').read_text())
        manifest['modifications'] += ' Separate bowel-only ambient visibility attribute baked by local self-organ ray sampling; positions and indices unchanged.'
    (output/manifest_name).write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({'organs':len(organs),'vertices':sum(o['vertexCount'] for o in organs),'faces':sum(o['faceCount'] for o in organs),'bytes':len(blob),'bounds':manifest['bounds']}))

if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--liver-envelope', type=Path)
    parser.add_argument('--output-stem', default='bodyparts3d-torso')
    parser.add_argument('--manifest-name', default='manifest.json')
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--original-selection', action='store_true', help='Reproduce the original 30-structure selection without the additive mesentery and vascular branches.')
    parser.add_argument('--tissue-occlusion', type=Path, help='Explicit optional bounded ambient-visibility attribute; never enabled implicitly.')
    args = parser.parse_args()
    main(args.liver_envelope, args.output_stem, args.manifest_name, args.output_dir, args.original_selection, args.tissue_occlusion)
