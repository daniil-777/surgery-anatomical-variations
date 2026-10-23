/** Independent global checks: local VBD energies are deliberately not summed. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildContactQuadrature, type ContactQuadrature } from "./contactQuadrature";
import { cohesiveParameters, cohesiveResponse } from "./cohesive";
import { LiverCuttingSolver, preparedScalpelContact } from "./solver";
import { minimizeIncremental } from "./minimize";
import {bladePlanes,integrateTrianglePenalty} from "./contactIntegral";
import { DEFAULT_SCALPEL, type CuttingReference, type ScalpelPose } from "./types";
import type { MaxwellState } from "../liverContinuumMaterial";

const bulk = { young_pa: 6000, poisson: .4, relaxation_fraction: .4, relaxation_time_s: .7,
  density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
function reference(): CuttingReference {
  return { schema: "viscera.cutting-reference/v1", source: { templateId: "analytic", sha256: "fixture", attribution: "analytic", license: "CC0" },
    positionsMm: [-10,0,0, 0,0,0, 0,10,0, 0,0,10, 10,0,0, 0,0,0, 0,10,0, 0,0,10],
    tets: [0,1,2,3,4,5,7,6], boundaryIndices: [], seamPairs: [1,2,3].map(left => ({ left, right: left+4, areaM2: 50e-6/3 })),
    seamLeftIndices: [1,2,3], seamRightIndices: [5,7,6], skin: { positionsMm: [], indices: [], colors: [], tetIndices: [], weights: [] },
    cap: { positionsMm: [0,1,1,0,9,1,0,1,9,0,1,1,0,9,1,0,1,9], indices: [0,1,2,3,5,4], tetIndices: [0,0,0,1,1,1],
      weights: [0,.8,.1,.1,0,0,.9,.1,0,0,.1,.9,0,.8,.1,.1,0,0,.1,.9,0,0,.9,.1] },
    planeXMm: 0, floorYMm: -2, fixedNodes: [], diagnostics: { originalCageVolumeM3: 1e-6/3, splitVolumeM3: 1e-6/3,
      seamAreaM2: 50e-6, embeddingErrorMm: 0, minimumTetVolumeM3: 1e-6/6 }, limitations: [] };
}
interface Internal {
  positions: Float64Array; velocities: Float64Array; trialPose: ScalpelPose; acceptedPose: ScalpelPose;
  cells: { state: MaxwellState }[]; contactQuadrature: ContactQuadrature;
  cohesiveAreas: Float64Array;
  contactStiffnessPaPerM: number;
  external(id: number, gradient?: Float64Array, hessian?: Float64Array): number;
  evaluateCandidate(prediction: Float64Array, h: number): { stationarityResidualN: number; contactForceN: number[]; energy:number;gradient:Float64Array;minimumJacobian:number;maximumContactPenetrationMm:number };
  preconditioner(h:number): {diagonal:Float64Array;applyInverse(input:Float64Array):Float64Array;multiply(input:Float64Array):Float64Array};
}
const internal = (solver: LiverCuttingSolver) => solver as unknown as Internal;
const numericallyClose=(actual:number,expected:number)=>expect(Math.abs(actual-expected)).toBeLessThanOrEqual(2e-7+1e-8*Math.abs(expected));
function globalContact(mesh: CuttingReference, state: Internal) {
  let energy = 0;
  const force = [0,0,0], torque = [0,0,0],n=state.positions.length,gram=new Float64Array(n*n),cap=mesh.cap!;
  // Independent triangle-level assembly, bypassing the optimized contact
  // adapter. Every triangle contributes once to global energy and torque.
  for(let offset=0;offset<cap.indices.length;offset+=3){
    const corners=cap.indices.slice(offset,offset+3),tet=cap.tetIndices[corners[0]!]!,ids=mesh.tets.slice(4*tet,4*tet+4);
    const weights=corners.map(id=>cap.weights.slice(4*id,4*id+4));
    const points=weights.map(row=>[0,1,2].map(axis=>ids.reduce((sum,id,j)=>sum+row[j]!*state.positions[3*id+axis]!,0)) as [number,number,number]);
    const ref=corners.map(id=>cap.positionsMm.slice(3*id,3*id+3)),a=ref[1]!.map((v,i)=>v-ref[0]![i]!),b=ref[2]!.map((v,i)=>v-ref[0]![i]!);
    const area=.5e-6*Math.hypot(a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!);
    const side=ids.reduce((sum,id)=>sum+mesh.positionsMm[3*id]!,0)/4<mesh.planeXMm?-1:1;
    const result=integrateTrianglePenalty(points,area,bladePlanes(mesh.planeXMm*.001,state.trialPose,DEFAULT_SCALPEL,side),state.contactStiffnessPaPerM);
    energy+=result.energyJ;
    for(let c=0;c<3;c++){
      const q=points[c]!,f=result.gradient.subarray(3*c,3*c+3);
      for(let axis=0;axis<3;axis++)force[axis]!+=f[axis]!;
      torque[0]!+=q[1]*f[2]!-q[2]*f[1]!;torque[1]!+=q[2]*f[0]!-q[0]*f[2]!;torque[2]!+=q[0]*f[1]!-q[1]*f[0]!;
      for(let d=0;d<3;d++)for(let i=0;i<4;i++)for(let j=0;j<4;j++)for(let r=0;r<3;r++)for(let s=0;s<3;s++)
        gram[n*(3*ids[i]!+r)+3*ids[j]!+s]!+=weights[c]![i]!*weights[d]![j]!*result.gram[9*(3*c+r)+3*d+s]!;
    }
  }
  return { energy, force, torque,gram };
}

describe("independent distributed contact review", () => {
  it("integrates cohesive basis areas over source triangles and differentiates their unique potential", () => {
    const mesh=reference(), material={fractureEnergyJm2:5,peakTractionPa:5000};
    // This probe isolates cohesive work in the external callback.
    const solver=new LiverCuttingSolver(mesh,{bulk,cohesive:material,gravity:false,equilibriumModel:"stable-neo-hookean"}),state=internal(solver),cap=mesh.cap!;
    const exactAreas=new Float64Array(mesh.seamPairs.length);
    const pairOfLeft=new Map(mesh.seamPairs.map((pair,index)=>[pair.left,index]));
    for(let i=0;i<cap.indices.length;i+=3) {
      const corners=cap.indices.slice(i,i+3),tet=cap.tetIndices[corners[0]!]!,nodes=mesh.tets.slice(4*tet,4*tet+4);
      if(nodes.reduce((sum,id)=>sum+mesh.positionsMm[3*id]!,0)/4>=mesh.planeXMm)continue;
      const p=corners.map(id=>cap.positionsMm.slice(3*id,3*id+3));
      const area=.5*Math.abs((p[1]![1]!-p[0]![1]!)*(p[2]![2]!-p[0]![2]!)-(p[1]![2]!-p[0]![2]!)*(p[2]![1]!-p[0]![1]!))*1e-6;
      for(let j=0;j<4;j++) {
        const pair=pairOfLeft.get(nodes[j]!);
        if(pair!==undefined)exactAreas[pair]!+=area*corners.reduce((sum,id)=>sum+cap.weights[4*id+j]!,0)/3;
      }
    }
    for(let i=0;i<exactAreas.length;i++)expect(state.cohesiveAreas[i]).toBeCloseTo(exactAreas[i]!,14);
    expect(solver.metrics().cohesiveAreaM2).toBeCloseTo(32e-6,14);
    expect(solver.metrics().seamAreaM2).toBeCloseTo(50e-6,14);
    const gaps=[[.0007,.00009,-.00012],[-.0001,.0005,.0001],[.0002,-.0001,.00005]],histories=[0,.0003,.0016];
    mesh.seamPairs.forEach((pair,i)=>{
      solver.maximumOpeningM[i]=histories[i]!;
      for(let axis=0;axis<3;axis++) {
        state.positions[3*pair.left+axis]!-=gaps[i]![axis]!/2;
        state.positions[3*pair.right+axis]!+=gaps[i]![axis]!/2;
      }
    });
    const initialHistory=solver.maximumOpeningM.slice(),initialDamage=solver.damage.slice(),stiffness=cohesiveParameters(material).stiffnessPaPerM;
    const energy=()=>mesh.seamPairs.reduce((sum,pair,i)=>{
      const gap=[0,1,2].map(axis=>state.positions[3*pair.right+axis]!-state.positions[3*pair.left+axis]!);
      const response=cohesiveResponse(Math.hypot(Math.max(0,gap[0]!),gap[1]!,gap[2]!),solver.maximumOpeningM[i]!,material);
      const old=cohesiveResponse(0,solver.maximumOpeningM[i]!,material);
      return sum+exactAreas[i]!*(response.storedEnergyJm2+response.dissipatedEnergyJm2-old.dissipatedEnergyJm2+.5*stiffness*Math.min(0,gap[0]!)**2);
    },0);
    expect(mesh.seamPairs.reduce((sum,pair)=>sum+state.external(pair.left),0)).toBeCloseTo(energy(),14);
    for(let id=0;id<8;id++) {
      const gradient=new Float64Array(3);state.external(id,gradient);
      for(let axis=0;axis<3;axis++) {
        const index=3*id+axis,old=state.positions[index]!,h=1e-9;
        state.positions[index]=old+h;const hi=energy();state.positions[index]=old-h;const lo=energy();state.positions[index]=old;
        expect((hi-lo)/(2*h)).toBeCloseTo(gradient[axis]!,8);
      }
    }
    expect(solver.maximumOpeningM).toEqual(initialHistory);expect(solver.damage).toEqual(initialDamage);
  });

  it("publishes exactly Gc times the actual capsule area on complete separation", () => {
    const original=JSON.parse(readFileSync(new URL("../../public/cutting/liver-reference.json",import.meta.url),"utf8")) as CuttingReference;
    const mesh={...original,fixedNodes:[]},material={fractureEnergyJm2:2.5,peakTractionPa:5000};
    const solver=new LiverCuttingSolver(mesh,{bulk,cohesive:material,gravity:false}),state=internal(solver),cap=mesh.cap!;
    let bothSidesArea=0;
    for(let i=0;i<cap.indices.length;i+=3) {
      const p=cap.indices.slice(i,i+3).map(id=>cap.positionsMm.slice(3*id,3*id+3));
      bothSidesArea+=.5*Math.abs((p[1]![1]!-p[0]![1]!)*(p[2]![2]!-p[0]![2]!)-(p[1]![2]!-p[0]![2]!)*(p[2]![1]!-p[0]![1]!))*1e-6;
    }
    const sideOfNode=new Int8Array(mesh.positionsMm.length/3);
    for(let i=0;i<mesh.tets.length;i+=4) {
      const nodes=mesh.tets.slice(i,i+4),side=nodes.reduce((sum,id)=>sum+mesh.positionsMm[3*id]!,0)/4<mesh.planeXMm?-1:1;
      for(const id of nodes) {expect(sideOfNode[id]===0||sideOfNode[id]===side).toBe(true);sideOfNode[id]=side;}
    }
    // Impose a rigid translation of each half. Bulk strain is zero, the
    // traction-free terminal state needs no fixture/contact work or iteration.
    const opening=1.25*cohesiveParameters(material).deltafM;
    for(let id=0;id<sideOfNode.length;id++)state.positions[3*id]!+=sideOfNode[id]!*opening/2;
    expect(solver.maximumOpeningM.every(v=>v===0)).toBe(true);
    expect(solver.step(),solver.metrics().lastError).toBe(true);
    const metrics=solver.metrics(),area=bothSidesArea/2;
    expect(metrics.cohesiveAreaM2).toBeCloseTo(area,13);
    expect(metrics.separatedAreaM2).toBeCloseTo(area,13);
    expect(metrics.fractureDissipationJ).toBeCloseTo(material.fractureEnergyJm2*area,13);
    expect(metrics.fractureDissipationJ).toBeLessThan(material.fractureEnergyJm2*metrics.seamAreaM2);
    expect(metrics.minimumJacobian).toBeCloseTo(1,10);
    expect(solver.damage.every(v=>v===1)).toBe(true);
  });

  it("matches the unique global potential, tool reaction and torque without adjacency double counting", () => {
    const mesh = reference(), solver = new LiverCuttingSolver(mesh, { bulk, cohesive: { fractureEnergyJm2: 5, peakTractionPa: 5000 }, gravity: false });
    const state = internal(solver);
    for (let id=0; id<8; id++) {
      state.positions[3*id]! += id<4 ? -.000031 : .000047;
      state.positions[3*id+1]! += .000013*(id%3);
    }
    for (const pose of [{ tipYMm: 1.43, centerZMm: 5, active: true }, { tipYMm: -.5, centerZMm: -4.7, active: true }]) {
      state.trialPose = pose;
      const global = globalContact(mesh, state), nodalGradient = [0,0,0], nodalTorque = [0,0,0];
      expect(global.energy).toBeGreaterThan(0);
      for (let id=0; id<8; id++) {
        const on = new Float64Array(3), off = new Float64Array(3);
        state.external(id, on); state.trialPose = { ...pose, active: false }; state.external(id, off); state.trialPose = pose;
        const g = on.map((v,axis) => v-off[axis]!);
        for (let axis=0; axis<3; axis++) {
          nodalGradient[axis]! += g[axis]!;
          const index=3*id+axis, old=state.positions[index]!, h=1e-9;
          state.positions[index]=old+h; const hi=globalContact(mesh,state).energy;
          state.positions[index]=old-h; const lo=globalContact(mesh,state).energy;
          state.positions[index]=old;
          numericallyClose((hi-lo)/(2*h),g[axis]!);
        }
        const p=state.positions.subarray(3*id,3*id+3);
        nodalTorque[0]! += p[1]!*g[2]! - p[2]!*g[1]!;
        nodalTorque[1]! += p[2]!*g[0]! - p[0]!*g[2]!;
        nodalTorque[2]! += p[0]!*g[1]! - p[1]!*g[0]!;
      }
      const candidate=state.evaluateCandidate(state.positions.slice(),solver.dtSeconds);
      for (let axis=0; axis<3; axis++) {
        expect(nodalGradient[axis]).toBeCloseTo(global.force[axis]!, 11);
        expect(candidate.contactForceN[axis]).toBeCloseTo(global.force[axis]!, 11);
        expect(nodalTorque[axis]).toBeCloseTo(global.torque[axis]!, 12);
      }
      for (const [name,axis] of [["tipYMm",1],["centerZMm",2]] as const) {
        const h=1e-6;
        state.trialPose={...pose,[name]:pose[name]+h}; const hi=globalContact(mesh,state).energy;
        state.trialPose={...pose,[name]:pose[name]-h}; const lo=globalContact(mesh,state).energy;
        state.trialPose=pose;
        numericallyClose(-(hi-lo)/(2*h*.001),global.force[axis]!);
      }
    }
  });

  it("preserves actual cap area and affine moments under rigid transforms of the embedded patch", () => {
    const mesh=JSON.parse(readFileSync(new URL("../../public/cutting/liver-reference.json",import.meta.url),"utf8")) as CuttingReference;
    const quadrature=buildContactQuadrature(mesh), cap=mesh.cap!;
    const supportCaps=new Map<number,{nodes:Set<number>;triangles:number[][]}>();
    for(let i=0;i<cap.indices.length;i+=3) {
      const ids=cap.indices.slice(i,i+3),tet=cap.tetIndices[ids[0]!]!;
      if(!supportCaps.has(tet))supportCaps.set(tet,{nodes:new Set(mesh.tets.slice(4*tet,4*tet+4)),triangles:[]});
      supportCaps.get(tet)!.triangles.push(ids);
    }
    // Every actual sample must remain inside a source triangle supported by
    // its mechanical nodes; the enclosing cage's larger seam is insufficient.
    for(const sample of quadrature.samples) {
      const p=[1,2].map(axis=>sample.ids.reduce((sum,id,j)=>sum+sample.weights[j]!*mesh.positionsMm[3*id+axis]!,0));
      const inside=[...supportCaps.values()].filter(group=>sample.ids.every(id=>group.nodes.has(id))).some(group=>group.triangles.some(ids=>{
        const v=ids.map(id=>[cap.positionsMm[3*id+1]!,cap.positionsMm[3*id+2]!]);
        const cross=v.map((a,j)=>{const b=v[(j+1)%3]!;return(b[0]!-a[0]!)*(p[1]!-a[1]!)-(b[1]!-a[1]!)*(p[0]!-a[0]!);});
        return !(cross.some(x=>x>1e-7)&&cross.some(x=>x< -1e-7));
      }));
      expect(inside).toBe(true);
    }
    // A general rigid transform tests affine interpolation, not a rotated blade:
    // the production experiment deliberately supports only its fixed cut plane.
    const transform=(p:number[]) => {
      const a=.37,b=-.23,x=Math.cos(a)*p[0]!-Math.sin(a)*p[1]!,y=Math.sin(a)*p[0]!+Math.cos(a)*p[1]!;
      return [x+17,Math.cos(b)*y-Math.sin(b)*p[2]!-8,Math.sin(b)*y+Math.cos(b)*p[2]!+31];
    };
    const nodes=Array.from({length:mesh.positionsMm.length/3},(_,id)=>transform(mesh.positionsMm.slice(3*id,3*id+3)));
    for (const side of [-1,1]) {
      const exact=[0,0,0], sampled=[0,0,0]; let exactArea=0,sampledArea=0;
      for (let i=0;i<cap.indices.length;i+=3) {
        const ids=cap.indices.slice(i,i+3),tet=cap.tetIndices[ids[0]!]!;
        const tetSide=mesh.tets.slice(4*tet,4*tet+4).reduce((s,id)=>s+mesh.positionsMm[3*id]!,0)/4<mesh.planeXMm?-1:1;
        if(tetSide!==side)continue;
        const p=ids.map(id=>cap.positionsMm.slice(3*id,3*id+3));
        const area=.5*Math.abs((p[1]![1]!-p[0]![1]!)*(p[2]![2]!-p[0]![2]!)-(p[1]![2]!-p[0]![2]!)*(p[2]![1]!-p[0]![1]!))*1e-6;
        const center=transform([0,1,2].map(axis=>p.reduce((s,v)=>s+v[axis]!,0)/3));
        exactArea+=area; for(let axis=0;axis<3;axis++)exact[axis]!+=area*center[axis]!;
      }
      for(const sample of quadrature.samples.filter(s=>s.side===side)) {
        sampledArea+=sample.areaM2;
        for(let axis=0;axis<3;axis++)sampled[axis]!+=sample.areaM2*sample.ids.reduce((s,id,j)=>s+sample.weights[j]!*nodes[id]![axis]!,0);
      }
      expect(sampledArea).toBeCloseTo(exactArea,13);
      for(let axis=0;axis<3;axis++)expect(sampled[axis]!/sampledArea).toBeCloseTo(exact[axis]!/exactArea,9);
    }
  });

  it("keeps the assigned escape side through crossing and has no contact below or beyond the finite blade", () => {
    const pose={tipYMm:0,centerZMm:0,active:true};
    for(const side of [-1,1] as const) {
      for(const x of [-.0003,-.00001,.00001,.0003]) {
        const c=preparedScalpelContact([x,.001,0],0,pose,DEFAULT_SCALPEL,side);
        if(c.penetrationM>0)expect(c.normal[0]*side).toBeGreaterThan(0);
      }
      for(const p of [[-.002*side,-.0001,0],[-.002*side,.001,.012],[-.002*side,.017,0]])
        expect(preparedScalpelContact(p,0,pose,DEFAULT_SCALPEL,side).penetrationM).toBe(0);
    }
  });

  it("retries a previously loaded cap without leaking material history, velocity, tool travel or work", () => {
    const options={bulk,cohesive:{fractureEnergyJm2:.5,peakTractionPa:2000},gravity:false,contactSpacingMm:.25};
    // Outer supports ensure genuine deformation instead of free-body escape.
    const mesh={...reference(),fixedNodes:[0,4]};
    const solver=new LiverCuttingSolver(mesh,options),direct=new LiverCuttingSolver(mesh,options);
    for(const s of [solver,direct]) {
      const state=internal(s); state.acceptedPose={tipYMm:9.2,centerZMm:5,active:true};
      s.setScalpelTarget({tipYMm:3,centerZMm:5,active:true});
      // Use a resolved shallow load, not the previous coarse cap's invalid
      // deep overlap. Atomic retry needs nonzero force and Maxwell memory;
      // reaching fracture is a separate constitutive test.
      const loaded=()=>Math.hypot(...s.metrics().contactForceN)>1e-5&&state.cells.some(c=>Array.from(c.state.memory).some(v=>Math.abs(v)>1e-12));
      for(let i=0;i<500&&!loaded();i++)expect(s.step(),s.metrics().lastError).toBe(true);
      expect(loaded()).toBe(true);
      expect(s.metrics().maximumSurfacePenetrationMm).toBeLessThanOrEqual(.06);
    }
    const before=solver.metrics(), beforePose=solver.scalpelPose();
    expect(solver.positionsMm).toEqual(direct.positionsMm);
    expect(solver.maximumOpeningM).toEqual(direct.maximumOpeningM);
    // The UI prescribes an endpoint for the nominal interval. A retry follows
    // that same linear path; the direct half-step must prescribe its midpoint.
    const selectedSpeedMmS=8, endpoint={...beforePose,tipYMm:beforePose.tipYMm-selectedSpeedMmS*solver.dtSeconds};
    solver.setScalpelTarget(endpoint);
    direct.setScalpelTarget({...endpoint,tipYMm:(endpoint.tipYMm+beforePose.tipYMm)/2});
    const state=internal(solver), evaluate=state.evaluateCandidate.bind(state);
    expect(Math.hypot(...before.contactForceN)).toBeGreaterThan(1e-5);
    expect(state.cells.some(c=>Array.from(c.state.memory).some(v=>Math.abs(v)>1e-12))).toBe(true);
    const fault=vi.spyOn(state,"evaluateCandidate").mockImplementation((prediction,h)=>{
      const result=evaluate(prediction,h);return h===solver.dtSeconds?{...result,stationarityResidualN:.03}:result;
    });
    expect(solver.step(),solver.metrics().lastError).toBe(true);fault.mockRestore();
    expect(direct.step(direct.dtSeconds/2),direct.metrics().lastError).toBe(true);
    expect(solver.metrics().timeSeconds-before.timeSeconds).toBeCloseTo(direct.metrics().lastStepSeconds,14);
    expect(solver.metrics().lastStepSeconds).toBeLessThanOrEqual(solver.dtSeconds/2);
    expect(Math.hypot(solver.scalpelPose().tipYMm-beforePose.tipYMm,solver.scalpelPose().centerZMm-beforePose.centerZMm)/(solver.metrics().timeSeconds-before.timeSeconds)).toBeCloseTo(selectedSpeedMmS,10);
    expect(solver.positionsMm).toEqual(direct.positionsMm);
    expect(solver.maximumOpeningM).toEqual(direct.maximumOpeningM);expect(solver.damage).toEqual(direct.damage);
    expect(state.velocities).toEqual(internal(direct).velocities);
    expect(state.cells.map(c=>c.state)).toEqual(internal(direct).cells.map(c=>c.state));
    expect(solver.scalpelPose()).toEqual(direct.scalpelPose());
    expect(solver.metrics().toolWorkJ).toBe(direct.metrics().toolWorkJ);
    direct.setScalpelTarget(endpoint);
    expect(solver.step(),solver.metrics().lastError).toBe(true);expect(direct.step(),direct.metrics().lastError).toBe(true);
    expect(solver.positionsMm).toEqual(direct.positionsMm);
    expect(solver.metrics().toolWorkJ).toBe(direct.metrics().toolWorkJ);
  });

  it("differentiates the full incremental potential with Maxwell memory and keeps trial histories frozen", () => {
    const mesh={...reference(),fixedNodes:[0,4]},material={fractureEnergyJm2:5,peakTractionPa:5000};
    const solver=new LiverCuttingSolver(mesh,{bulk,cohesive:material,gravity:false}),state=internal(solver);
    const prediction=state.positions.slice();
    for(let id=0;id<8;id++) {
      const side=id<4?-1:1;
      state.positions[3*id]!+=side*.00004+.012*prediction[3*id+1]!;
      state.positions[3*id+1]!+=.018*prediction[3*id+2]!;
      state.positions[3*id+2]!+=.011*prediction[3*id]!;
    }
    for(let i=0;i<state.cells.length;i++)for(let j=0;j<5;j++) {
      state.cells[i]!.state.previous[j]=.003*Math.sin(j+i);
      state.cells[i]!.state.memory[j]=.001*Math.cos(2*j+i);
    }
    solver.maximumOpeningM.set([0,.0013,.0008]);
    state.trialPose={tipYMm:1.43,centerZMm:5,active:true};
    const history=solver.maximumOpeningM.slice(),damage=solver.damage.slice(),memory=structuredClone(state.cells.map(cell=>cell.state));
    const evaluation=state.evaluateCandidate(prediction,solver.dtSeconds);
    expect(evaluation.minimumJacobian).toBeGreaterThan(.9);
    for(let index=0;index<state.positions.length;index++) {
      const old=state.positions[index]!,h=1e-8;
      state.positions[index]=old+h;const hi=state.evaluateCandidate(prediction,solver.dtSeconds).energy;
      state.positions[index]=old-h;const lo=state.evaluateCandidate(prediction,solver.dtSeconds).energy;
      state.positions[index]=old;
      numericallyClose((hi-lo)/(2*h),evaluation.gradient[index]!);
    }
    // Subtract the inactive preconditioner to isolate its full contact Gram
    // action, including shared-node/off-diagonal coupling. The Gram is a PSD
    // approximation: moving nearest-plane region boundaries add curvature to
    // the actual Hessian, so those two matrices must not be conflated.
    const contactPose={...state.trialPose},active=state.preconditioner(solver.dtSeconds);
    state.trialPose={...contactPose,active:false};const inactive=state.preconditioner(solver.dtSeconds);state.trialPose=contactPose;
    const contactGradient=()=>{
      const output=new Float64Array(state.positions.length);
      for(let id=0;id<8;id++) {
        const on=new Float64Array(3),off=new Float64Array(3);state.external(id,on);
        state.trialPose={...contactPose,active:false};state.external(id,off);state.trialPose=contactPose;
        for(let axis=0;axis<3;axis++)output[3*id+axis]=on[axis]!-off[axis]!;
      }
      return output;
    };
    const direction=Float64Array.from(state.positions,(_,i)=>Math.sin(i+.31)),unchanged=state.positions.slice(),epsilon=1e-8;
    state.positions.set(unchanged.map((v,i)=>v+epsilon*direction[i]!));const hi=contactGradient();
    state.positions.set(unchanged.map((v,i)=>v-epsilon*direction[i]!));const lo=contactGradient();state.positions.set(unchanged);
    const action=active.multiply(direction),inactiveAction=inactive.multiply(direction);
    const assembled=globalContact(mesh,state).gram;let quadratic=0,hessianDifference=0;
    for(let i=0;i<action.length;i++) {
      const expected=action[i]!-inactiveAction[i]!,observed=(hi[i]!-lo[i]!)/(2*epsilon);
      let mapped=0;for(let j=0;j<direction.length;j++)mapped+=assembled[i*direction.length+j]!*direction[j]!;
      expect(Math.abs(mapped-expected)).toBeLessThanOrEqual(2e-3+1e-7*Math.abs(expected));
      quadratic+=direction[i]!*expected;hessianDifference+=Math.abs(observed-expected);
    }
    expect(quadratic).toBeGreaterThan(0);expect(hessianDifference).toBeGreaterThan(1);
    const before=state.evaluateCandidate(prediction,solver.dtSeconds),metrics=solver.metrics();
    const preconditioner=state.preconditioner(solver.dtSeconds);
    const iterations=minimizeIncremental(state.positions,()=>state.evaluateCandidate(prediction,solver.dtSeconds),preconditioner.diagonal,mesh.floorYMm*.001,8,preconditioner.applyInverse);
    const after=state.evaluateCandidate(prediction,solver.dtSeconds);
    expect(iterations).toBeGreaterThan(0);expect(after.energy).toBeLessThan(before.energy);expect(after.minimumJacobian).toBeGreaterThan(.1);
    expect(solver.maximumOpeningM).toEqual(history);expect(solver.damage).toEqual(damage);
    expect(state.cells.map(cell=>cell.state)).toEqual(memory);expect(solver.metrics()).toEqual(metrics);
  });

  it("requires Armijo decrease and valid J on each optimizer update, restoring a wholly rejected line", () => {
    const x=new Float64Array([0,.1,0]),old=x.slice(),diagonal=new Float64Array([.1,.1,1]),visited:number[]=[];
    const evaluate=()=>{
      const gradient=new Float64Array([x[0]!+.95,x[1]!+1,x[2]!]);
      const result={energy:.5*gradient.reduce((sum,v)=>sum+v*v,0),gradient,minimumJacobian:1+x[0]!};
      visited.push(result.minimumJacobian);return result;
    };
    const initial=evaluate(),steps=minimizeIncremental(x,evaluate,diagonal,0,1),end=evaluate();
    expect(steps).toBe(1);expect(visited.some(j=>j<=.1)).toBe(true);expect(end.minimumJacobian).toBeGreaterThan(.1);expect(x[1]).toBeGreaterThanOrEqual(0);
    const directional=initial.gradient.reduce((sum,g,i)=>sum+g*(x[i]!-old[i]!),0);
    expect(directional).toBeLessThan(0);expect(end.energy).toBeLessThanOrEqual(initial.energy+1e-4*directional+1e-14);
    x.set(old);let calls=0;
    const rejected=()=>{const value=evaluate();return {...value,minimumJacobian:++calls===1?1:.05};};
    expect(minimizeIncremental(x,rejected,diagonal,0,5)).toBe(0);expect(calls).toBe(17);expect(x).toEqual(old);
  });

  it("never publishes candidates that fail the independent penetration gate", () => {
    const solver=new LiverCuttingSolver(reference(),{bulk,cohesive:{fractureEnergyJm2:5,peakTractionPa:5000},gravity:false});
    const state=internal(solver),metrics=solver.metrics(),positions=solver.positionsMm.slice(),history=solver.maximumOpeningM.slice(),damage=solver.damage.slice();
    const memory=structuredClone(state.cells.map(cell=>cell.state)),pose=solver.scalpelPose(),evaluate=state.evaluateCandidate.bind(state);
    solver.setScalpelTarget({tipYMm:pose.tipYMm-.02,centerZMm:pose.centerZMm,active:true});
    const fault=vi.spyOn(state,"evaluateCandidate").mockImplementation((prediction,h)=>({...evaluate(prediction,h),maximumContactPenetrationMm:.061}));
    expect(solver.step()).toBe(false);fault.mockRestore();
    expect(solver.metrics().lastError).toMatch(/^Blade contact penetration/);
    expect(solver.metrics().timeSeconds).toBe(metrics.timeSeconds);expect(solver.metrics().acceptedSteps).toBe(metrics.acceptedSteps);
    expect(solver.positionsMm).toEqual(positions);expect(solver.maximumOpeningM).toEqual(history);expect(solver.damage).toEqual(damage);
    expect(state.cells.map(cell=>cell.state)).toEqual(memory);expect(solver.scalpelPose()).toEqual(pose);
  });
});
