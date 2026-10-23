import { describe, expect, it } from "vitest";
import { buildLiverCutGeometry, LIVER_PUNCH_SIDES, prepareLiverCut } from "./wounds";
import type { LiverAnatomy, LiverCutRequest, LiverSurface, LiverVec3, LiverWound } from "./types";

function fixture(vesselDepthM = .001): LiverAnatomy {
  const surface: LiverSurface = { positionsM: new Float64Array([-.01,0,-.01, .01,0,-.01, .01,0,.01, -.01,0,.01]), normals: new Float32Array([0,1,0,0,1,0,0,1,0,0,1,0]), indices: new Uint32Array([0,2,1,0,3,2]) };
  return { surface, organ: { id:"liver",name:"test",kind:"organ",color:"#fff",positions:Array.from(surface.positionsM,p=>p*1000),indices:Array.from(surface.indices) }, network: {version:"surface-vessels-design-1.0.0",seed:42,organ_id:"liver",provenance:"procedural-surface-design-not-patient-vasculature",settings:{density:.45,visibility:1,radius_scale:1},segments:[],statistics:{terminals:0,branches:0,connected_components:0,length_mm:0,murray_exponent:3}},
    vessels:[{id:"vessel",aM:[-.005,-vesselDepthM,0],bM:[.005,-vesselDepthM,0],normal:[0,1,0],radiusAM:.0002,radiusBM:.0002,depthM:vesselDepthM,aTriangle:0,bTriangle:1}],targets:[],provenance:{templateId:"fixture",label:"fixture",source:"fixture",license:"fixture",vascularModel:"procedural-surface-design-not-patient-vasculature",detail:"analytical plane"} };
}
function request(): LiverCutRequest { return { pick:{triangle:0,barycentric:[.5,.5,0],positionM:[0,0,0],normal:[0,1,0]},radiusM:.001,depthM:.0015,timeSeconds:0 }; }
const area = (s: LiverSurface) => { let total=0;for(let i=0;i<s.indices.length;i+=3){const p=[0,1,2].map(j=>Array.from(s.positionsM.slice(s.indices[i+j]!*3,s.indices[i+j]!*3+3))); const u=p[1]!.map((v,k)=>v-p[0]![k]!),v=p[2]!.map((q,k)=>q-p[0]![k]!);total+=Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!)*.5;}return total;};

describe("depth-aware geometric liver punches",()=>{
 it("cuts a real polygonal hole, preserves exact area, and adds correctly oriented walls and floor",()=>{
  const anatomy=fixture(),input=structuredClone(anatomy),cut=prepareLiverCut(anatomy,[],request());expect(cut.outcome).toBe("vessel-hit");expect(cut.wound!.apertureRadiusM).toBeCloseTo(.0002,14);
  const geometry=buildLiverCutGeometry(anatomy,[cut.wound!]);
  const expected=.5*LIVER_PUNCH_SIDES*Math.sin(2*Math.PI/LIVER_PUNCH_SIDES)*1e-6;
  expect(geometry.removedAreaM2).toBeCloseTo(expected,16);expect(area(geometry.surface)+geometry.removedAreaM2).toBeCloseTo(.0004,15);
  const perimeter=2*LIVER_PUNCH_SIDES*.001*Math.sin(Math.PI/LIVER_PUNCH_SIDES);
  expect(area(geometry.cavity)).toBeCloseTo(expected+perimeter*.0015,14);
  expect(Math.min(...geometry.cavity.positionsM.filter((_,i)=>i%3===1))).toBeCloseTo(-.0015,15);
  for(let t=0;t<geometry.cavity.indices.length/3;t++){
    const ids=Array.from(geometry.cavity.indices.slice(t*3,t*3+3));const c=[0,1,2].map(k=>ids.reduce((a,v)=>a+geometry.cavity.positionsM[v*3+k]!/3,0));const n=Array.from(geometry.cavity.normals.slice(ids[0]!*3,ids[0]!*3+3));
    if(Math.abs(n[1]!)<.5)expect(n[0]!*c[0]!+n[2]!*c[2]!).toBeLessThan(0);else expect(n[1]).toBeGreaterThan(.99);
  }
  expect(anatomy).toEqual(input);
 });
 it("has paired oppositely oriented internal edges after the cut; no T-junctions remain",()=>{
  const anatomy=fixture(),g=buildLiverCutGeometry(anatomy,[prepareLiverCut(anatomy,[],request()).wound!]);
  const edges=new Map<string,{count:number;orientation:number;ends:string[]}>();
  for(const surface of [g.surface,g.cavity])for(let t=0;t<surface.indices.length;t+=3){
   const p=[0,1,2].map(j=>Array.from(surface.positionsM.slice(surface.indices[t+j]!*3,surface.indices[t+j]!*3+3)).map(v=>Math.round(v*1e12)).join(","));
   for(let j=0;j<3;j++){const a=p[j]!,b=p[(j+1)%3]!,ends=[a,b].sort(),key=ends.join("|");const edge=edges.get(key)??{count:0,orientation:0,ends};edge.count++;edge.orientation+=a===ends[0]?1:-1;edges.set(key,edge);}
  }
  let boundaryLength=0;
  for(const edge of edges.values()){
   expect(edge.count).toBeLessThanOrEqual(2);
   if(edge.count===2)expect(edge.orientation).toBe(0);
   else {const [a,b]=edge.ends.map(p=>p.split(",").map(Number));expect([0,2].some(k=>Math.abs(a![k]!)===1e10&&a![k]===b![k])).toBe(true);expect(a![1]).toBe(0);expect(b![1]).toBe(0);boundaryLength+=Math.hypot(...a!.map((v,k)=>(v-b![k]!)*1e-12));}
  }
  expect(boundaryLength).toBeCloseTo(.08,11);
 });
 it("keeps every retained vertex attached to its exact original source triangle",()=>{
  const anatomy=fixture(),g=buildLiverCutGeometry(anatomy,[prepareLiverCut(anatomy,[],request()).wound!]);
  expect(g.sourceTriangles.length).toBe(g.surface.positionsM.length/3);expect(g.sourceBarycentrics.length).toBe(g.surface.positionsM.length);
  for(let i=0;i<g.sourceTriangles.length;i++){
   const t=g.sourceTriangles[i]!,b=Array.from(g.sourceBarycentrics.slice(i*3,i*3+3));expect(b.reduce((a,v)=>a+v,0)).toBeCloseTo(1,13);expect(Math.min(...b)).toBeGreaterThanOrEqual(-1e-12);
   for(let k=0;k<3;k++)expect(g.surface.positionsM[i*3+k]).toBeCloseTo(b.reduce((a,v,j)=>a+v*anatomy.surface.positionsM[anatomy.surface.indices[t*3+j]!*3+k]!,0),14);
  }
 });
 it("does not bleed until a punch reaches the buried finite tube; tangency has zero aperture",()=>{
  const anatomy=fixture();const r=request();r.depthM=.00025;expect(prepareLiverCut(anatomy,[],r).outcome).toBe("tissue-only");r.depthM=.0008;expect(prepareLiverCut(anatomy,[],r).outcome).toBe("tissue-only");
  r.depthM=.00085;const partial=prepareLiverCut(anatomy,[],r);expect(partial.outcome).toBe("vessel-hit");expect(partial.wound!.apertureRadiusM).toBeGreaterThan(0);expect(partial.wound!.apertureRadiusM).toBeLessThan(.0002);
  anatomy.vessels[0]!.aM[2]=.005;anatomy.vessels[0]!.bM[2]=.005;r.depthM=.002;expect(prepareLiverCut(anatomy,[],r).outcome).toBe("tissue-only");
 });
 it("rejects duplicates, malformed or spoofed hits, source boundary cuts, and fourth wounds without mutation",()=>{
  const anatomy=fixture(),r=request(),w=prepareLiverCut(anatomy,[],r).wound!;expect(prepareLiverCut(anatomy,[w],r).outcome).toBe("duplicate");
  for(const patch of [{radiusM:NaN},{radiusM:-1},{depthM:Infinity},{timeSeconds:-1}])expect(prepareLiverCut(anatomy,[],{...r,...patch}).accepted).toBe(false);
  expect(prepareLiverCut(anatomy,[],{...r,pick:{...r.pick,positionM:[1,0,0]}}).accepted).toBe(false);
  expect(prepareLiverCut(anatomy,[],{...r,pick:{...r.pick,normal:[0,-1,0]}}).accepted).toBe(false);
  expect(prepareLiverCut(anatomy,[],{...r,pick:{...r.pick,triangle:999}}).accepted).toBe(false);
  const edge={...r,pick:{...r.pick,barycentric:[0,1,0] as LiverVec3,positionM:[.01,0,.01] as LiverVec3}};expect(prepareLiverCut(anatomy,[],edge).accepted).toBe(false);
  const far=Array.from({length:3},(_,i)=>({...w,id:`w${i}`,pick:{...w.pick,positionM:[1+i,0,0] as LiverVec3}}));expect(prepareLiverCut(anatomy,far,r).accepted).toBe(false);
  expect(()=>buildLiverCutGeometry(anatomy,[w,w])).toThrow();
 });
 it("rejects a punch whose depth crosses a nearby back-facing sheet",()=>{
  const anatomy=fixture(),s=anatomy.surface;
  s.positionsM=new Float64Array([...s.positionsM,...Array.from(s.positionsM,(v,i)=>i%3===1?v-.0001:v)]);s.normals=new Float32Array([...s.normals,...Array.from(s.normals,v=>-v)]);s.indices=new Uint32Array([...s.indices,4,5,6,4,6,7]);
  const cut=prepareLiverCut(anatomy,[],request());expect(cut.accepted).toBe(false);expect(cut.reason).toContain("another capsule sheet");
 });
 it("unchanged geometry has zero cavity and exact original area",()=>{
  const anatomy=fixture(),g=buildLiverCutGeometry(anatomy,[]);expect(area(g.surface)).toBeCloseTo(.0004,15);expect(g.removedAreaM2).toBe(0);expect(g.cavity.indices.length).toBe(0);
 });
});
