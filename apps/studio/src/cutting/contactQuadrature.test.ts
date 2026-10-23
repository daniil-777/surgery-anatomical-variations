import fs from "node:fs";
import { describe,expect,it } from "vitest";
import { buildContactQuadrature } from "./contactQuadrature";
import { LiverCuttingSolver } from "./solver";
import type { CuttingReference } from "./types";

function reference():CuttingReference {
  return {schema:"viscera.cutting-reference/v1",source:{templateId:"analytic",sha256:"fixture",attribution:"analytic",license:"CC0"},
    positionsMm:[-10,0,0, 0,0,0, 0,10,0, 0,0,10, 10,0,0, 0,0,0, 0,10,0, 0,0,10],
    tets:[0,1,2,3,4,5,7,6],boundaryIndices:[],seamPairs:[1,2,3].map(left=>({left,right:left+4,areaM2:50e-6/3})),
    seamLeftIndices:[1,2,3],seamRightIndices:[5,7,6],skin:{positionsMm:[],indices:[],colors:[],tetIndices:[],weights:[]},
    cap:{positionsMm:[0,1,1,0,9,1,0,1,9,0,1,1,0,9,1,0,1,9],indices:[0,1,2,3,5,4],tetIndices:[0,0,0,1,1,1],
      weights:[0,.8,.1,.1,0,0,.9,.1,0,0,.1,.9,0,.8,.1,.1,0,0,.1,.9,0,0,.9,.1]},
    planeXMm:0,floorYMm:-2,fixedNodes:[],diagnostics:{originalCageVolumeM3:1e-6/3,splitVolumeM3:1e-6/3,seamAreaM2:50e-6,embeddingErrorMm:0,minimumTetVolumeM3:1e-6/6},limitations:[]};
}
const bulk={young_pa:6000,poisson:.4,relaxation_fraction:.4,relaxation_time_s:.7,density_kg_m3:1060,contact_stiffness_n_m:300,indentation_stiffness_n_m:20000,fracture_energy_j_m2:20};

describe("actual-source contact quadrature",()=>{
  it("conserves one-sided area and affine moments inside the source boundary",()=>{
    const mesh=reference();
    for(const spacing of [4,2.5,1]){
      const quadrature=buildContactQuadrature(mesh,spacing);
      expect(quadrature.mode).toBe("source-cap");expect(quadrature.oneSidedAreaM2).toBeCloseTo(32e-6,13);
      for(const side of [-1,1]){
        let area=0,y=0,z=0;
        for(const sample of quadrature.samples.filter(s=>s.side===side)){
          const p=[0,1,2].map(axis=>sample.ids.reduce((v,id,j)=>v+sample.weights[j]!*mesh.positionsMm[3*id+axis]!,0));
          expect(p[0]).toBeCloseTo(0,10);expect(p[1]!).toBeGreaterThanOrEqual(1-1e-8);expect(p[2]!).toBeGreaterThanOrEqual(1-1e-8);expect(p[1]!+p[2]!).toBeLessThanOrEqual(10+1e-8);
          area+=sample.areaM2;y+=sample.areaM2*p[1]!;z+=sample.areaM2*p[2]!;
        }
        expect(area).toBeCloseTo(32e-6,13);expect(y/area).toBeCloseTo(11/3,10);expect(z/area).toBeCloseTo(11/3,10);
      }
    }
  });
  it("distributes the work-conjugate contact gradient to support nodes",()=>{
    const solver=new LiverCuttingSolver(reference(),{bulk,cohesive:{fractureEnergyJm2:5,peakTractionPa:5000},gravity:false});
    const state=solver as unknown as {positions:Float64Array;trialPose:{tipYMm:number;centerZMm:number;active:boolean};external:(id:number,g?:Float64Array)=>number};
    state.trialPose={tipYMm:0,centerZMm:5,active:true};
    for(const id of [1,2,3])state.positions[3*id]!-=.00003;
    for(const id of [5,6,7])state.positions[3*id]!+=.00003;
    for(const id of [1,2,3,5,6,7]){
      const g=new Float64Array(3);state.external(id,g);
      for(let axis=0;axis<3;axis++){
        const index=3*id+axis,old=state.positions[index]!,h=1e-9;
        state.positions[index]=old+h;const hi=state.external(id);
        state.positions[index]=old-h;const lo=state.external(id);
        state.positions[index]=old;expect((hi-lo)/(2*h)).toBeCloseTo(g[axis]!,5);
      }
    }
  });
  it("preserves actual liver cap area without retaining every render triangle",()=>{
    const mesh=JSON.parse(fs.readFileSync(new URL("../../public/cutting/liver-reference.json",import.meta.url),"utf8")) as CuttingReference;
    const quadrature=buildContactQuadrature(mesh);
    expect(quadrature.oneSidedAreaM2).toBeCloseTo(mesh.diagnostics.capAreaM2 as number,12);
    expect(quadrature.oneSidedAreaM2).toBeLessThan(mesh.diagnostics.seamAreaM2);
    expect(quadrature.samples.length).toBeLessThan(mesh.cap!.indices.length/3);
    expect(quadrature.samples.length).toBeGreaterThan(mesh.seamPairs.length*2);
  });
  it("integrates cohesive nodal area over source tissue and preserves full-failure work",()=>{
    // The external callback isolates cohesive work under the legacy law; the
    // log-law bulk correction has separate local/global gradient coverage.
    const mesh=reference(),solver=new LiverCuttingSolver(mesh,{bulk,cohesive:{fractureEnergyJm2:5,peakTractionPa:5000},gravity:false,equilibriumModel:"stable-neo-hookean"});
    expect(solver.metrics().seamAreaM2).toBeCloseTo(50e-6,13);
    expect(solver.metrics().cohesiveAreaM2).toBeCloseTo(32e-6,13);
    const state=solver as unknown as {cohesiveAreas:Float64Array;positions:Float64Array;external:(id:number,g?:Float64Array)=>number};
    // Uniform positive opening beyond delta_f consumes Gc times source area.
    for(const pair of mesh.seamPairs)state.positions[3*pair.right]!+=.003;
    const energy=mesh.seamPairs.reduce((sum,pair)=>sum+state.external(pair.right),0);
    expect(energy).toBeCloseTo(32e-6*5,12);
    expect(state.cohesiveAreas.reduce((sum,area)=>sum+area,0)).toBeCloseTo(32e-6,13);
    expect(solver.damage.every(v=>v===0)).toBe(true);
  });
});
