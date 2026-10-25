import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { Group, Mesh, SphereGeometry, MeshStandardMaterial, Texture } from 'three';
import { compileSceneText, sceneTextHints, validateConnectedSceneDisease } from './sceneTextEdits';
import { parseJointModel } from './atlasJointLocal';
import { primeTextCompilerTables } from './atlasTextCompiler';
import { importedVariationSystem, createVariationState, applyTargetedVariation, resetVariation } from './imports/variations';
import { sampleVirtaMedVariation, warpVirtaMedPositions } from './virtaMedScene';
import { createWholeSceneVariation } from './wholeSceneModel';
import type { AtlasGeneration } from './atlas';
const read=(path:string)=>readFileSync(path);
const tables=JSON.parse(read('apps/studio/public/models/text-compiler/tables.json').toString());
primeTextCompilerTables(tables);
const weights=read('apps/studio/public/models/joint-v2/weights.bin');
const system=importedVariationSystem(parseJointModel(JSON.parse(read('apps/studio/public/models/joint-v2/model.json').toString()),weights.buffer.slice(weights.byteOffset,weights.byteOffset+weights.byteLength)),tables);
const lib=JSON.parse(read('apps/studio/public/static/api/atlas/catalog.json').toString());
const references=async(id:string):Promise<AtlasGeneration>=>JSON.parse(gunzipSync(read(`apps/studio/public/static/api/atlas/specimens/${id}.json.gz`)).toString());
const ref=(organ:string)=>system.references.find(r=>r.organ===organ)!.id;
const compile=(text:string,organ='liver',current?:Awaited<ReturnType<typeof compileSceneText>>)=>compileSceneText(system,ref(organ),text,current,lib,references);

describe('shared scene text compiler',()=>{
  it('compiles every disease hint using the actual organ compiler',async()=>{
    for(const organ of new Set(system.references.map(r=>r.organ)))for(const hint of sceneTextHints(system,organ)) {
      const result=await compile(hint.prompt,organ);
      if(hint.id.includes('-'))expect(result.disease?.profile_id,hint.prompt).toBe(hint.id);
    }
  });
  it('rejects unimplemented connected lesion parameters while permitting material controls',async()=>{
    await expect(validateConnectedSceneDisease(await compile('liver-cirrhosis, count 7'),['liver-cirrhosis'])).rejects.toThrow('Custom lesion');
    await expect(validateConnectedSceneDisease(await compile('liver-cirrhosis, pigment contrast 0.8'),['liver-cirrhosis'])).resolves.toBeUndefined();
    await expect(validateConnectedSceneDisease(await compile('liver-hcc'),['liver-cirrhosis'])).rejects.toThrow('not in this connected scene');
  });
  it('preserves disease when a later concise shape instruction is applied',async()=>{
    const first=await compile('liver-cirrhosis, severity 0.75');
    const second=await compile('twist 0.2; wetter','liver',first);
    expect(second.disease?.profile_id).toBe('liver-cirrhosis');
    expect(second.controls.twist).toBe(.2);
    const baseline=await compile(sceneTextHints(system,'liver').find(item=>item.id==='baseline')!.prompt,'liver',second);
    expect(baseline.disease).toBeNull();expect(baseline.controls).toEqual(Object.fromEntries(Object.keys(baseline.controls).map(key=>[key,0])));
  });
  it.each(['make a new liver','20% wider','height 200 mm','make the kidney wider','wider; remove tumour'])('rejects unsupported or wrong-target text: %s',async text=>{
    await expect(compile(text)).rejects.toThrow();
  });
  it('keeps the connected shape map orientation-preserving at bounded control extremes',async()=>{
    for(const organ of ['liver','gallbladder']) {
      const recipe=await compile(organ==='liver'?'liver-cirrhosis, severity 1':'gallbladder-distension, severity 1',organ);
      for(const sign of [-1,1]) {
        const controls=Object.fromEntries(Object.keys(recipe.controls).map((key,i)=>[key,sign*(i%2?-.95:.95)]));
        const sample=sampleVirtaMedVariation(system,createWholeSceneVariation(42,1,1),'baseline',{...recipe,controls});
        for(let x=-160;x<160;x+=40)for(let y=-100;y<110;y+=30)for(let z=-80;z<90;z+=30){
          const h=.1,columns=[];
          for(let axis=0;axis<3;axis++){const a=[x,y,z],b=[x,y,z];a[axis]!-=h;b[axis]!+=h;const out=warpVirtaMedPositions(new Float32Array([...a,...b]),sample);columns.push([0,1,2].map(k=>(out[k+3]!-out[k]!)/(2*h)));}
          const [a,b,c]=columns as [number[],number[],number[]];const det=a[0]!*(b[1]!*c[2]!-b[2]!*c[1]!)-b[0]!*(a[1]!*c[2]!-a[2]!*c[1]!)+c[0]!*(a[1]!*b[2]!-a[2]!*b[1]!);
          expect(det).toBeGreaterThan(.35);
        }
      }
    }
  });
  it('makes deterministic connected disease and shape maps without random broad reshaping',async()=>{
    const recipe=await compile('gallbladder-cholecystitis, severity 0.75, wider, wetter','gallbladder');
    const sample=sampleVirtaMedVariation(system,createWholeSceneVariation(42,1,.75),'baseline',recipe);
    const rest=new Float32Array([-70,5,28,-40,-12,-18,-40,-12,-18,0,55,10]);
    const a=warpVirtaMedPositions(rest,sample),b=warpVirtaMedPositions(rest,sample);
    expect(a).toEqual(b);expect(a).not.toEqual(rest);expect([...a].every(Number.isFinite)).toBe(true);
    expect([...a.slice(3,6)]).toEqual([...a.slice(6,9)]);
  });
});

describe('targeted uploaded scene transactions',()=>{
  const setup=()=>{const root=new Group();for(let i=0;i<2;i++){const mesh=new Mesh(new SphereGeometry(2,30,20),new MeshStandardMaterial({color:0x997766}));mesh.position.x=i*8;root.add(mesh);}return {root,state:createVariationState(root)};};
  it('edits only the chosen mesh, retains its neighbor through repeated edits and restores exact source resources',async()=>{
    const {state}=setup(),a=state.meshes[0]!,b=state.meshes[1]!;
    const disease=await compile('liver-cirrhosis, severity 0.75');
    const options={shapeStrength:1,textureStrength:1,synthesizeSeamlessTextures:false};
    await applyTargetedVariation(state,[0],disease,options);
    expect(a.mesh.geometry.getAttribute('position').array).not.toEqual(a.geometry.getAttribute('position').array);
    expect(a.mesh.geometry.getAttribute('color')).toBeDefined();expect(b.mesh.geometry).toBe(b.geometry);expect(b.mesh.material).toBe(b.material);
    const first=a.mesh.geometry,firstMaterial=a.mesh.material;
    await applyTargetedVariation(state,[1],await compile('wider; wetter'),options);
    expect(a.mesh.geometry).toBe(first);expect(a.mesh.material).toBe(firstMaterial);
    for(let i=0;i<3;i++)await applyTargetedVariation(state,[1],disease,options);
    expect(state.ownedGeometry).toHaveLength(2);expect(state.ownedMaterials).toHaveLength(2);
    resetVariation(state);expect(a.mesh.geometry).toBe(a.geometry);expect(b.mesh.geometry).toBe(b.geometry);expect(state.ownedGeometry).toHaveLength(0);
  });
  it('refuses an excessive texture allocation before publishing any edited mesh',async()=>{
    const {state}=setup();
    const map=new Texture({width:8192,height:4096} as any);
    (state.meshes[1]!.mesh.material as MeshStandardMaterial).map=map;
    const original=state.meshes[0]!.mesh.geometry;
    await expect(applyTargetedVariation(state,[0],await compile('wider; wetter'),
      {shapeStrength:1,textureStrength:1,synthesizeSeamlessTextures:true})).rejects.toThrow('No edit was applied');
    expect(state.meshes[0]!.mesh.geometry).toBe(original);expect(state.ownedGeometry).toHaveLength(0);
  });
  it('a cancelled preparation cannot mutate the current scene',async()=>{
    const {state}=setup(),before=state.meshes.map(item=>item.mesh.geometry),controller=new AbortController();
    const pending=applyTargetedVariation(state,[0],await compile('wider'),{shapeStrength:1,textureStrength:1,signal:controller.signal});controller.abort();
    await expect(pending).rejects.toThrow();expect(state.meshes.map(item=>item.mesh.geometry)).toEqual(before);
  });
});
