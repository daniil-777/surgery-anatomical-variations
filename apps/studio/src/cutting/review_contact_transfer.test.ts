/** Independent review of the retained no-cap legacy side-transfer mode.
 * Production source caps use history-free exact triangle contact instead. */
import { describe, expect, it, vi } from "vitest";
import { LiverCuttingSolver, preparedScalpelContact, transferredScalpelContactSide } from "./solver";
import { DEFAULT_SCALPEL, type CuttingReference, type ScalpelPose } from "./types";
import type { ContactQuadrature } from "./contactQuadrature";

const bulk={young_pa:6000,poisson:.4,relaxation_fraction:.4,relaxation_time_s:.7,density_kg_m3:1060,contact_stiffness_n_m:300,indentation_stiffness_n_m:20000,fracture_energy_j_m2:20};
function reference():CuttingReference {
 return {schema:"viscera.cutting-reference/v1",source:{templateId:"analytic",sha256:"fixture",attribution:"analytic",license:"CC0"},
 positionsMm:[-10,0,0,0,0,0,0,10,0,0,0,10,10,0,0,0,0,0,0,10,0,0,0,10],tets:[0,1,2,3,4,5,7,6],boundaryIndices:[],
 seamPairs:[1,2,3].map(left=>({left,right:left+4,areaM2:50e-6/3})),seamLeftIndices:[1,2,3],seamRightIndices:[5,7,6],
 skin:{positionsMm:[],indices:[],colors:[],tetIndices:[],weights:[]},
 cap:{positionsMm:[0,1,1,0,9,1,0,1,9,0,1,1,0,9,1,0,1,9],indices:[0,1,2,3,5,4],tetIndices:[0,0,0,1,1,1],weights:[0,.8,.1,.1,0,0,.9,.1,0,0,.1,.9,0,.8,.1,.1,0,0,.1,.9,0,0,.9,.1]},
 planeXMm:0,floorYMm:-2,fixedNodes:[],diagnostics:{originalCageVolumeM3:1e-6/3,splitVolumeM3:1e-6/3,seamAreaM2:50e-6,embeddingErrorMm:0,minimumTetVolumeM3:1e-6/6},limitations:[]};
}
interface Internal {
 positions:Float64Array;velocities:Float64Array;contactSides:Int8Array;contactQuadrature:ContactQuadrature;trialPose:ScalpelPose;acceptedPose:ScalpelPose;
 cells:{state:{previous:Float64Array;memory:Float64Array}}[];
 nextContactSides():Int8Array;
 evaluateCandidate(prediction:Float64Array,h:number,includeHistory?:boolean):{energy:number;gradient:Float64Array;stationarityResidualN:number;contactForceN:number[];minimumJacobian:number};
}
function freeCrossing() {
 const mesh=reference();delete mesh.cap;
 const solver=new LiverCuttingSolver(mesh,{bulk,cohesive:{fractureEnergyJm2:5,peakTractionPa:5000},gravity:false});
 const state=solver as unknown as Internal;
 // A rigid, unstrained translation around the finite tip, with intact bonds.
 for(let i=0;i<state.positions.length;i+=3)state.positions[i]!-=.0002;
 state.acceptedPose={tipYMm:20,centerZMm:5,active:true};state.trialPose={...state.acceptedPose};solver.setScalpelTarget({...state.acceptedPose});
 return {solver,state};
}
const close=(actual:number,expected:number)=>expect(Math.abs(actual-expected)).toBeLessThanOrEqual(2e-7+1e-8*Math.abs(expected));

describe("independent legacy no-cap zero-energy contact-side transfer review",()=>{
 it("changes side around finite tips/ends without deleting active contact energy and is translation-equivariant",()=>{
  for(const oldSide of [-1,1] as const)for(const plane of [0,.085]) {
   const pose={tipYMm:12,centerZMm:-7,active:true};
   for(const relative of [[-oldSide*.0002,-.0003,0],[-oldSide*.0002,.004,.011],[-oldSide*.0002,.017,0]]){
    const point=new Float64Array([plane+relative[0]!,pose.tipYMm*.001+relative[1]!,pose.centerZMm*.001+relative[2]!]),saved=point.slice(),savedPose={...pose};
    const next=transferredScalpelContactSide(point,plane,pose,DEFAULT_SCALPEL,oldSide);
    expect(next).toBe(-oldSide);expect(preparedScalpelContact(point,plane,pose,DEFAULT_SCALPEL,oldSide).penetrationM).toBe(0);expect(preparedScalpelContact(point,plane,pose,DEFAULT_SCALPEL,next).penetrationM).toBe(0);
    expect(point).toEqual(saved);expect(pose).toEqual(savedPose);
   }
   const trapped=[plane-oldSide*.001,pose.tipYMm*.001+.004,pose.centerZMm*.001];
   expect(preparedScalpelContact(trapped,plane,pose,DEFAULT_SCALPEL,oldSide).penetrationM).toBeGreaterThan(0);
   expect(transferredScalpelContactSide(trapped,plane,pose,DEFAULT_SCALPEL,oldSide)).toBe(oldSide);
   expect(transferredScalpelContactSide([plane-oldSide*5e-13,pose.tipYMm*.001-.001,0],plane,pose,DEFAULT_SCALPEL,oldSide)).toBe(oldSide);
  }
 });

 it("keeps frozen-side force and tool work conjugate to the contact potential after transfer",()=>{
  const k=24000,pose={tipYMm:12,centerZMm:-7,active:true},plane=.085;
  for(const oldSide of [-1,1] as const){
   const side=transferredScalpelContactSide([plane-oldSide*.0002,.0117,-.007],plane,pose,DEFAULT_SCALPEL,oldSide);
   const point=[plane+side*.0001,.013,-.0068],response=preparedScalpelContact(point,plane,pose,DEFAULT_SCALPEL,side);
   expect(response.penetrationM).toBeGreaterThan(0);
   const energy=(p:number[],tool=pose)=>.5*k*preparedScalpelContact(p,plane,tool,DEFAULT_SCALPEL,side).penetrationM**2;
   const g=response.normal.map(v=>-k*response.penetrationM*v);
   for(let axis=0;axis<3;axis++){const hi=[...point],lo=[...point],h=1e-9;hi[axis]!+=h;lo[axis]!-=h;close((energy(hi)-energy(lo))/(2*h),g[axis]!);}
   const h=1e-5;close((energy(point,{...pose,tipYMm:pose.tipYMm+h})-energy(point,{...pose,tipYMm:pose.tipYMm-h}))/(2*h),-g[1]!*.001);
  }
 });

 it("owns candidate side arrays, freezes history during evaluations, commits only accepted states, and resets rest sides",()=>{
  const {solver,state}=freeCrossing(),original=state.contactSides.slice(),history=structuredClone(state.cells.map(c=>c.state));
  expect(state.contactQuadrature.samples.map(s=>s.index)).toEqual(state.contactQuadrature.samples.map((_,i)=>i));
  const candidate=state.nextContactSides();expect(candidate.every(side=>side===-1)).toBe(true);expect(state.contactSides).toEqual(original);candidate.fill(1);expect(state.contactSides).toEqual(original);
  const fast=state.evaluateCandidate(state.positions.slice(),solver.dtSeconds,false),exact=state.evaluateCandidate(state.positions.slice(),solver.dtSeconds,true);
  expect(fast.energy).toBe(exact.energy);expect(fast.gradient).toEqual(exact.gradient);expect(state.contactSides).toEqual(original);expect(state.cells.map(c=>c.state)).toEqual(history);expect(solver.damage.every(d=>d===0)).toBe(true);
  expect(solver.step()).toBe(true);expect(state.contactSides.every(side=>side===-1)).toBe(true);expect(state.contactQuadrature.samples.some(s=>s.side===1)).toBe(true);
  // Both authoritative and optimized global contact assemblies use transferred
  // sides, not the immutable quadrature's original material-side tags.
  state.trialPose={tipYMm:0,centerZMm:5,active:true};
  const a=state.evaluateCandidate(state.positions.slice(),solver.dtSeconds,false),b=state.evaluateCandidate(state.positions.slice(),solver.dtSeconds,true);
  expect(a.energy).toBe(b.energy);expect(a.gradient).toEqual(b.gradient);expect(a.contactForceN).toEqual(b.contactForceN);expect(a.contactForceN[0]).toBeGreaterThan(0);
  solver.reset();expect(state.contactSides).toEqual(original);
 });

 it("does not transfer sides on rejected nominal steps or failed retries",()=>{
  for(const recover of [false,true]){
   const {solver,state}=freeCrossing(),original=state.contactSides.slice(),positions=state.positions.slice(),history=structuredClone(state.cells.map(c=>c.state));
   const evaluate=state.evaluateCandidate.bind(state);let finalCalls=0;
   const candidates=vi.spyOn(state,"nextContactSides");
   vi.spyOn(state,"evaluateCandidate").mockImplementation((prediction,h,includeHistory=true)=>{
    const value=evaluate(prediction,h,includeHistory);
    if(includeHistory){expect(state.contactSides).toEqual(original);finalCalls++;if(!recover||finalCalls===1)return {...value,stationarityResidualN:.002};}
    return value;
   });
   expect(solver.step()).toBe(recover);
   if(recover){expect(finalCalls).toBe(2);expect(candidates).toHaveBeenCalledTimes(1);expect(state.contactSides.every(side=>side===-1)).toBe(true);expect(solver.metrics().timeSeconds).toBeCloseTo(solver.dtSeconds/2,15);}
   else {expect(finalCalls).toBe(6);expect(candidates).not.toHaveBeenCalled();expect(state.contactSides).toEqual(original);expect(state.positions).toEqual(positions);expect(state.cells.map(c=>c.state)).toEqual(history);expect(solver.metrics().timeSeconds).toBe(0);expect(solver.damage.every(d=>d===0)).toBe(true);}
  }
 });
});
