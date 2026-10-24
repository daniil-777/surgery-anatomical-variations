import { describe, expect, it } from 'vitest';
import { Matrix4, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildSurfacePhenotype } from './surfacePhenotypes';
import type { ImportedDiseaseProfile } from './variations';
import type { AtlasDiseaseSpec } from '../atlasDisease';

const profile: ImportedDiseaseProfile = {id:'liver-capsular-cyst',organ:'liver',label:'Cyst',pattern:'focal',mechanism:'cyst',rMin:.12,rRange:.02,amp:.21,steps:7,mult:1,maxSites:1,logScale:[0,0,0],srgb:[.5,.36,.23]};
const disease: AtlasDiseaseSpec = {profile_id:profile.id,seed:42,severity:.8,size:.5,spread:.5,irregularity:.4,contrast:.6,count:1,location:[0,0,-1]};
const coordinates = (g: PlaneGeometry | SphereGeometry, world = new Matrix4()) => {
  const p=g.getAttribute('position'), out=new Float64Array(p.count*3), v=new Vector3();
  for(let i=0;i<p.count;i++)v.fromBufferAttribute(p,i).applyMatrix4(world).toArray(out,i*3);
  return out;
};

describe('surface-confined external disease phenotypes',()=>{
 it('does not spread a focal lesion through the air gap onto a nearby disconnected surface',()=>{
  const a=new PlaneGeometry(2,2,32,32),b=a.clone().translate(0,0,.03),g=mergeGeometries([a,b]);
  const coords=Float64Array.from(g.getAttribute('position').array);
  const result=buildSurfacePhenotype(coords,g,new Matrix4(),disease,profile,.7,.9);
  const split=a.getAttribute('position').count;
  expect(Math.max(...result.mask.subarray(0,split))).toBeGreaterThan(.1);
  expect(Math.max(...result.mask.subarray(split))).toBe(0);
  expect(Array.from(result.displacement.subarray(split*3)).every(x=>x===0)).toBe(true);
  const maskPeak=result.mask.indexOf(Math.max(...result.mask));
  const heights=Array.from({length:split},(_,i)=>result.displacement[i*3+2]!);
  expect(heights.indexOf(Math.max(...heights))).toBe(maskPeak);
 });
 it('produces identical world-space fields for baked and unbaked rotated/scaled uploads',()=>{
  const source=new SphereGeometry(1,32,24),world=new Matrix4().makeRotationY(.7).scale(new Vector3(1.4,.8,1.1));
  const baked=source.clone().applyMatrix4(world),coords=coordinates(source,world);
  const a=buildSurfacePhenotype(coords,source,world,disease,profile,.8,.7);
  const b=buildSurfacePhenotype(coords,baked,new Matrix4(),disease,profile,.8,.7);
  expect(a.mask).toEqual(b.mask);
  for(let i=0;i<a.displacement.length;i++)expect(a.displacement[i]).toBeCloseTo(b.displacement[i]!,7);
 });
 it('has no severity or strength floor, and responds continuously to shape strength',()=>{
  const g=new SphereGeometry(1,32,24),coords=coordinates(g);
  const sample=(severity:number,shape:number)=>buildSurfacePhenotype(coords,g,new Matrix4(),{...disease,severity},profile,shape,.9);
  const zero=sample(0,1),tiny=sample(.8,.001),full=sample(.8,1);
  expect(Array.from(zero.displacement).every(x=>x===0)).toBe(true);expect(Array.from(zero.mask).every(x=>x===0)).toBe(true);
  expect(zero.globalScale).toEqual([1,1,1]);
  expect(Array.from(sample(.8,0).displacement).every(x=>x===0)).toBe(true);
  for(let i=0;i<tiny.displacement.length;i++)expect(tiny.displacement[i]).toBeCloseTo(full.displacement[i]!* .001,10);
 });
 it('keeps nodules small and deterministic while diffuse steatosis changes fullness without nodular displacement',()=>{
  const g=new SphereGeometry(1,48,32),coords=coordinates(g);
  const nodular={...profile,id:'liver-cirrhosis',pattern:'nodular',rMin:.02,rRange:.02,maxSites:48};
  const a=buildSurfacePhenotype(coords,g,new Matrix4(),disease,nodular,.8,.8);
  expect(a).toEqual(buildSurfacePhenotype(coords,g,new Matrix4(),disease,nodular,.8,.8));
  expect(Math.max(...a.siteRadii)).toBeLessThan(Math.sqrt(12)*.06);
  const fat=buildSurfacePhenotype(coords,g,new Matrix4(),disease,{...profile,id:'liver-steatotic-enlargement',logScale:[.18,.13,.15]},.8,.8);
  expect(fat.siteRadii).toHaveLength(0);expect(fat.globalScale[0]).toBeGreaterThan(1);
  expect(Array.from(fat.displacement).every(x=>x===0)).toBe(true);expect(Math.min(...fat.mask)).toBeGreaterThan(0);
 });
});
