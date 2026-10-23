import fs from "node:fs";
import {describe,expect,it} from "vitest";
import {ContactSurfaceValidator,triangleBladePenetrationBounds} from "./contactSurface";
import {DEFAULT_SCALPEL,type CuttingReference} from "./types";

function fixture():CuttingReference {
  const positions=[-1,1,0,1,1,0,0,-2,0,0,0,2];
  return{schema:"viscera.cutting-reference/v1",source:{templateId:"analytic",sha256:"fixture",attribution:"analytic",license:"CC0"},
    positionsMm:positions,tets:[0,1,2,3],boundaryIndices:[],seamPairs:[],seamLeftIndices:[],seamRightIndices:[],
    skin:{positionsMm:[],indices:[],colors:[],tetIndices:[],weights:[]},
    cap:{positionsMm:positions.slice(0,9),indices:[0,1,2],tetIndices:[0,0,0],weights:[1,0,0,0,0,1,0,0,0,0,1,0]},
    planeXMm:0,floorYMm:-3,fixedNodes:[],diagnostics:{originalCageVolumeM3:1e-9,splitVolumeM3:1e-9,seamAreaM2:3e-6,embeddingErrorMm:0,minimumTetVolumeM3:1e-9},limitations:[]};
}
const active={tipYMm:0,centerZMm:0,active:true};

describe("continuous source-cap penetration validity",()=>{
  it("finds edge-interior penetration when every vertex is outside",()=>{
    const result=triangleBladePenetrationBounds([-1,1,0,1,1,0,0,-2,0],DEFAULT_SCALPEL),exact=Math.sin(Math.PI/12);
    expect(result.lowerMm).toBeLessThanOrEqual(exact);expect(result.upperMm).toBeGreaterThanOrEqual(exact);
    expect(result.upperMm-result.lowerMm).toBeLessThanOrEqual(1e-5);
    expect(result.lowerMm).toBeGreaterThan(.25);
  });
  it("handles deep interior, exterior, tangent, degenerate, and sharp-end intersections",()=>{
    const deep=triangleBladePenetrationBounds([-.2,4,0,.2,4,0,0,5,0],DEFAULT_SCALPEL);
    expect(deep.lowerMm).toBeCloseTo(.6,4);expect(deep.upperMm).toBeCloseTo(.6,4);
    expect(triangleBladePenetrationBounds([2,4,0,3,4,0,2,5,1],DEFAULT_SCALPEL).upperMm).toBe(0);
    expect(triangleBladePenetrationBounds([-1,0,0,1,0,0,0,-2,0],DEFAULT_SCALPEL).upperMm).toBeLessThan(1e-5);
    const point=triangleBladePenetrationBounds([0,4,9.9,0,4,9.9,0,4,9.9],DEFAULT_SCALPEL),exact=.1*.6/Math.hypot(2.4,.6);
    expect(point.lowerMm).toBeLessThanOrEqual(exact);expect(point.upperMm).toBeGreaterThanOrEqual(exact);
  });
  it("uses all embedded triangles and owns its copied geometry without changing input state",()=>{
    const mesh=fixture(),positions=Float64Array.from(mesh.positionsMm,v=>v*.001),shape={...DEFAULT_SCALPEL};
    const validator=new ContactSurfaceValidator(mesh,shape),before=positions.slice();
    mesh.cap!.weights.fill(0);mesh.cap!.indices.fill(0);mesh.tets.fill(0);shape.halfThicknessMm=30;
    const result=validator.evaluate(positions,active);
    expect(result.triangleCount).toBe(1);expect(result.candidateTriangles).toBe(1);expect(result.worstTriangle).toBe(0);
    expect(result.lowerMm).toBeGreaterThan(.25);expect(positions).toEqual(before);
    const inactive=validator.evaluate(positions,{...active,active:false});expect(inactive.upperMm).toBe(0);
    expect(result.lowerMm).toBeGreaterThan(.25);
  });
  it("is invariant to matching reference, current-position, and tool translations",()=>{
    const mesh=fixture(),origin=[100,34,-19];
    mesh.positionsMm=mesh.positionsMm.map((v,i)=>v+origin[i%3]!);
    mesh.cap!.positionsMm=mesh.cap!.positionsMm.map((v,i)=>v+origin[i%3]!);mesh.planeXMm=origin[0]!;
    const result=new ContactSurfaceValidator(mesh,DEFAULT_SCALPEL).evaluate(Float64Array.from(mesh.positionsMm,v=>v*.001),{tipYMm:origin[1]!,centerZMm:origin[2]!,active:true});
    expect(result.lowerMm).toBeCloseTo(Math.sin(Math.PI/12),4);
  });
  it("rejects non-affine or corrupt embeddings and nonfinite trial states",()=>{
    const nonaffine=fixture();nonaffine.tets.push(0,1,2,3);nonaffine.cap!.tetIndices[2]=1;
    expect(()=>new ContactSurfaceValidator(nonaffine,DEFAULT_SCALPEL)).toThrow(/affine/);
    const corrupt=fixture();corrupt.cap!.weights[0]=.9;expect(()=>new ContactSurfaceValidator(corrupt,DEFAULT_SCALPEL)).toThrow(/reconstruct/);
    const mesh=fixture(),validator=new ContactSurfaceValidator(mesh,DEFAULT_SCALPEL),positions=Float64Array.from(mesh.positionsMm,v=>v*.001);positions[0]=NaN;
    expect(()=>validator.evaluate(positions,active)).toThrow(/Finite/);
    expect(()=>triangleBladePenetrationBounds([0,0,0],DEFAULT_SCALPEL)).toThrow(/triangle/);
  });
  it("bounds the complete real source cap at rest and distinguishes inactive geometry",()=>{
    const mesh=JSON.parse(fs.readFileSync(new URL("../../public/cutting/liver-reference.json",import.meta.url),"utf8")) as CuttingReference;
    const validator=new ContactSurfaceValidator(mesh,DEFAULT_SCALPEL),positions=Float64Array.from(mesh.positionsMm,v=>v*.001);
    const cap=mesh.cap!,top=Math.max(...cap.positionsMm.filter((_,i)=>i%3===1));
    const result=validator.evaluate(positions,{tipYMm:top+3,centerZMm:0,active:true});
    expect(result.triangleCount).toBe(cap.indices.length/3);expect(result.upperMm).toBe(0);expect(result.candidateTriangles).toBe(0);
  });
});
