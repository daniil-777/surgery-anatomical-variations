import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { AtlasGeneration } from "../../atlas";
import { adaptLiverAnatomy } from "./anatomy";
import { buildLiverCutGeometry, prepareLiverCut } from "./wounds";

const reference=()=>JSON.parse(gunzipSync(readFileSync(new URL("../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz",import.meta.url))).toString()) as AtlasGeneration;
describe("licensed HRA liver adapter",()=>{
 it("isolates the exact capsule with source identity, SI geometry and unchanged authored material data",()=>{
  const source=reference(),before=JSON.stringify(source),a=adaptLiverAnatomy(source);
  expect(a.surface.positionsM.length/3).toBe(15133);expect(a.surface.indices.length/3).toBe(30034);
  expect(a.provenance.license).toBe("CC-BY-4.0");expect(a.provenance.vascularModel).toBe("procedural-surface-design-not-patient-vasculature");expect(a.targets.length).toBeGreaterThanOrEqual(6);expect(a.targets.length).toBeLessThanOrEqual(12);
  expect(a.organ.metadata!.material_v2).toEqual(source.scene.organs[0]!.metadata!.material_v2);
  for(let i=0;i<a.surface.positionsM.length;i++)expect(a.surface.positionsM[i]).toBe(a.organ.positions[i]!* .001);
  expect(JSON.stringify(source)).toBe(before);
 });
 it("offers actual accepted vessel-hit targets and finite real cut geometry on the reference",()=>{
  const a=adaptLiverAnatomy(reference());let accepted=0;
  for(const target of a.targets){const cut=prepareLiverCut(a,[],{pick:target.pick,radiusM:.001,depthM:.0015,timeSeconds:0});if(cut.accepted&&cut.outcome==="vessel-hit")accepted++;}
  expect(accepted).toBeGreaterThanOrEqual(6);
  const depthPairs=a.targets.filter(t=>prepareLiverCut(a,[],{pick:t.pick,radiusM:.00125,depthM:.00025,timeSeconds:0}).outcome==="tissue-only"&&prepareLiverCut(a,[],{pick:t.pick,radiusM:.00125,depthM:.001,timeSeconds:0}).outcome==="vessel-hit");
  expect(depthPairs.length).toBeGreaterThanOrEqual(3);
  const result=a.targets.map(t=>prepareLiverCut(a,[],{pick:t.pick,radiusM:.001,depthM:.0015,timeSeconds:0})).find(r=>r.accepted&&r.outcome==="vessel-hit")!;
  const g=buildLiverCutGeometry(a,[result.wound!]);expect(g.removedAreaM2).toBeGreaterThan(3e-6);expect(g.cavity.indices.length).toBeGreaterThan(0);expect(g.surface.positionsM.every(Number.isFinite)).toBe(true);expect(g.surface.normals.every(Number.isFinite)).toBe(true);
  const boundary=(surfaces:typeof a.surface[])=>{const edges=new Map<string,number>();for(const surface of surfaces)for(let t=0;t<surface.indices.length;t+=3){const p=[0,1,2].map(j=>Array.from(surface.positionsM.slice(surface.indices[t+j]!*3,surface.indices[t+j]!*3+3)).map(v=>Math.round(v*1e10)).join(","));for(let j=0;j<3;j++){const key=[p[j]!,p[(j+1)%3]!].sort().join("|");edges.set(key,(edges.get(key)??0)+1);}}expect(Math.max(...edges.values())).toBe(2);return [...edges].filter(([,count])=>count===1).reduce((sum,[key])=>{const [x,y]=key.split("|").map(p=>p.split(",").map(Number));return sum+Math.hypot(...x!.map((v,k)=>(v-y![k]!)*1e-10));},0);};
  expect(boundary([g.surface,g.cavity])).toBeCloseTo(boundary([a.surface]),8);
 });
});
