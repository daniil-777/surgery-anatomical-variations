import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PhysicsParameters } from "../atlasPhysics";
import { LiverCuttingSolver, preparedScalpelContact, scalpelContact, transferredScalpelContactSide } from "./solver";
import { DEFAULT_SCALPEL, type CuttingReference } from "./types";

const bulk: PhysicsParameters = { young_pa: 6000, poisson: .4, relaxation_fraction: .4, relaxation_time_s: .7,
  density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
const cohesive = { fractureEnergyJm2: 5, peakTractionPa: 16000 };

function fixture(): CuttingReference {
  // Two conforming half cubes, 8 mm deep, duplicated plane nodes. Six positive
  // tets per side; density-derived masses must survive complete fracture.
  const positionsMm: number[] = [], tets: number[] = [], seamPairs: CuttingReference["seamPairs"] = [];
  for (let half = 0; half < 2; half++) {
    const base = positionsMm.length / 3;
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) positionsMm.push((half - 1 + x) * 8, y * 8, z * 8 - 4);
    const index = (q: number[]) => base + q[0]! * 4 + q[1]! * 2 + q[2]!;
    for (const permutation of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const q = [0, 0, 0], ids = [index(q)]; for (const axis of permutation) { q[axis]!++; ids.push(index(q)); }
      const [a,b,c] = ids.slice(1).map(id => [0,1,2].map(k => positionsMm[3*id+k]! - positionsMm[3*ids[0]!+k]!));
      const det = a![0]!*(b![1]!*c![2]!-b![2]!*c![1]!)+a![1]!*(b![2]!*c![0]!-b![0]!*c![2]!)+a![2]!*(b![0]!*c![1]!-b![1]!*c![0]!);
      if (det < 0) [ids[1],ids[2]]=[ids[2]!,ids[1]!]; tets.push(...ids);
    }
  }
  // Diagonal face triangles [4,6,7] and [4,7,5], each32mm².
  for (let i=0;i<4;i++) seamPairs.push({left:4+i,right:8+i,areaM2:([2,1,1,2][i]! * 32/3)*1e-6});
  return { schema:"viscera.cutting-reference/v1",source:{templateId:"analytic-cube",sha256:"fixture",attribution:"analytic test",license:"CC0"},
    positionsMm,tets,boundaryIndices:[],seamPairs,seamLeftIndices:[4,6,7,4,7,5],seamRightIndices:[8,11,10,8,9,11],
    skin:{positionsMm:[],indices:[],colors:[],tetIndices:[],weights:[]},planeXMm:0,floorYMm:-2,
    fixedNodes:[0,1,12,13], diagnostics:{originalCageVolumeM3:1.024e-6,splitVolumeM3:1.024e-6,seamAreaM2:64e-6,embeddingErrorMm:0,minimumTetVolumeM3:0},limitations:[] };
}

describe("finite cutting blade contact", () => {
  const pose={tipYMm:0,centerZMm:0,active:true};
  it("uses the visible wedge, finite height and finite length",()=>{
    expect(scalpelContact([0,-.001,0],0,pose,DEFAULT_SCALPEL,1).penetrationM).toBe(0);
    expect(scalpelContact([0,.003,.012],0,pose,DEFAULT_SCALPEL,1).penetrationM).toBe(0);
    expect(scalpelContact([0,.020,0],0,pose,DEFAULT_SCALPEL,1).penetrationM).toBe(0);
    expect(scalpelContact([.002,.003,0],0,pose,DEFAULT_SCALPEL,1).penetrationM).toBe(0);
    expect(scalpelContact([0,.003,0],0,pose,DEFAULT_SCALPEL,1).penetrationM).toBeCloseTo(.0006,12);
    expect(scalpelContact([0,.003,0],0,pose,DEFAULT_SCALPEL,-1).normal[0]).toBe(-1);
    expect(scalpelContact([0,.003,0],0,pose,DEFAULT_SCALPEL,1).normal[0]).toBe(1);
  });
  it("has a work-conjugate penalty gradient on a bevel away from feature ties",()=>{
    const p=[.00003,.0004,0], h=1e-8, k=100;
    const response=scalpelContact(p,0,pose,DEFAULT_SCALPEL,1);
    for(let axis=0;axis<3;axis++){
      const lo=p.slice(),hi=p.slice();lo[axis]!-=h;hi[axis]!+=h;
      const energy=(q:number[])=>.5*k*scalpelContact(q,0,pose,DEFAULT_SCALPEL,1).penetrationM**2;
      expect((energy(hi)-energy(lo))/(2*h)).toBeCloseTo(-k*response.penetrationM*response.normal[axis]!,8);
    }
  });
  it("derives blade reaction from the same pose-dependent potential",()=>{
    for(const point of [[.00003,.0004,0],[0,.004,.0099]]){
      const h=1e-5,k=80,response=scalpelContact(point,0,pose,DEFAULT_SCALPEL,1);
      for(const [name,axis] of [["tipYMm",1],["centerZMm",2]] as const){
        const lo={...pose,[name]:pose[name]-h},hi={...pose,[name]:pose[name]+h};
        const energy=(q:typeof pose)=>.5*k*scalpelContact(point,0,q,DEFAULT_SCALPEL,1).penetrationM**2;
        // Negative pose derivative is the reaction on the blade; mm→m.
        expect(-(energy(hi)-energy(lo))/(2*h*.001)).toBeCloseTo(-k*response.penetrationM*response.normal[axis]!,7);
      }
    }
  });
  it("retains prepared material sides after crossing the blade center plane",()=>{
    const point=[-.0001,.003,0],response=preparedScalpelContact(point,0,pose,DEFAULT_SCALPEL,1);
    expect(response.normal).toEqual([1,0,0]);expect(response.penetrationM).toBeCloseTo(.0007,12);
    expect(scalpelContact(point,0,pose,DEFAULT_SCALPEL,1).normal).toEqual([-1,0,0]);
    expect(preparedScalpelContact([-.0001,.003,.011],0,pose,DEFAULT_SCALPEL,1).penetrationM).toBe(0);
    expect(preparedScalpelContact([-.002,-.001,0],0,pose,DEFAULT_SCALPEL,1).penetrationM).toBe(0);
    const h=1e-8,k=100;
    for(let axis=0;axis<3;axis++){
      const lo=point.slice(),hi=point.slice();lo[axis]!-=h;hi[axis]!+=h;
      const energy=(p:number[])=>.5*k*preparedScalpelContact(p,0,pose,DEFAULT_SCALPEL,1).penetrationM**2;
      expect((energy(hi)-energy(lo))/(2*h)).toBeCloseTo(-k*response.penetrationM*response.normal[axis]!,7);
    }
  });
  it("transfers contact side only through a force-free finite tip or end passage",()=>{
    for(const side of [-1,1] as const)for(const point of [[-side*.0002,-.0001,0],[-side*.0002,.004,.011]]){
      const next=transferredScalpelContactSide(point,0,pose,DEFAULT_SCALPEL,side);
      expect(next).toBe(-side);
      expect(preparedScalpelContact(point,0,pose,DEFAULT_SCALPEL,side).penetrationM).toBe(0);
      expect(preparedScalpelContact(point,0,pose,DEFAULT_SCALPEL,next).penetrationM).toBe(0);
    }
    // A subsequent return on the physically opposite side must not produce the
    // old phantom downward tip reaction while the point is outside the prism.
    const next=transferredScalpelContactSide([-.0002,-.0001,0],0,pose,DEFAULT_SCALPEL,1);
    const returned=[-.0002,.00002,0];
    expect(preparedScalpelContact(returned,0,pose,DEFAULT_SCALPEL,1).penetrationM).toBeGreaterThan(0);
    expect(preparedScalpelContact(returned,0,pose,DEFAULT_SCALPEL,next).penetrationM).toBe(0);
    expect(scalpelContact(returned,0,pose,DEFAULT_SCALPEL,next).penetrationM).toBe(0);
  });
  it("cannot change side inside the blade or discard an existing contact potential",()=>{
    for(const point of [[-.0001,.003,0],[-.0008,.00003,0]]){
      expect(preparedScalpelContact(point,0,pose,DEFAULT_SCALPEL,1).penetrationM).toBeGreaterThan(0);
      expect(transferredScalpelContactSide(point,0,pose,DEFAULT_SCALPEL,1)).toBe(1);
    }
    for(const side of [-1,1] as const)for(const x of [-1e-13,0,1e-13])
      expect(transferredScalpelContactSide([x,-.001,0],0,pose,DEFAULT_SCALPEL,side)).toBe(side);
  });
  it("opens tissue sideways along a sharp finite end with work-conjugate tool motion",()=>{
    const shape={...DEFAULT_SCALPEL,endBevelMm:2.4},slope=.6/2.4,norm=Math.hypot(1,slope),h=1e-8,k=100;
    for(const side of [-1,1] as const)for(const end of [-1,1]){
      const point=[side*.00005,.004,end*.009],response=preparedScalpelContact(point,0,pose,shape,side);
      expect(response.penetrationM).toBeCloseTo((.00025-.00005)/norm,12);
      expect(response.normal[0]).toBeCloseTo(side/norm,12);expect(response.normal[2]).toBeCloseTo(end*slope/norm,12);
      for(let axis=0;axis<3;axis++){
        const lo=point.slice(),hi=point.slice();lo[axis]!-=h;hi[axis]!+=h;
        const energy=(p:number[])=>.5*k*preparedScalpelContact(p,0,pose,shape,side).penetrationM**2;
        expect((energy(hi)-energy(lo))/(2*h)).toBeCloseTo(-k*response.penetrationM*response.normal[axis]!,8);
      }
      const lo={...pose,centerZMm:-h*1000},hi={...pose,centerZMm:h*1000};
      const energy=(p:typeof pose)=>.5*k*preparedScalpelContact(point,0,p,shape,side).penetrationM**2;
      expect(-(energy(hi)-energy(lo))/(2*h)).toBeCloseTo(-k*response.penetrationM*response.normal[2]!,8);
      expect(preparedScalpelContact([side*.0003,.004,end*.009],0,pose,shape,side).penetrationM).toBe(0);
      expect(preparedScalpelContact([-side*.002,.004,end*.0101],0,pose,shape,side).penetrationM).toBe(0);
    }
    const legacy={halfThicknessMm:.6,halfLengthMm:10,heightMm:16,halfAngleRadians:Math.PI/12};
    expect(scalpelContact([.00005,.004,.009],0,pose,legacy,1).penetrationM).toBeCloseTo(.00055,12);
    expect(()=>new LiverCuttingSolver(fixture(),{bulk,cohesive,scalpel:{...shape,endBevelMm:10}})).toThrow(/bevel/);
  });
});

describe("contact-driven cutting dynamics",()=>{
  it("owns retained mechanical import metadata across solve and reset",()=>{
    const mesh=fixture(),expected=structuredClone(mesh),solver=new LiverCuttingSolver(mesh,{bulk,cohesive,gravity:false}),control=new LiverCuttingSolver(expected,{bulk,cohesive,gravity:false});
    mesh.positionsMm.fill(100);mesh.tets.fill(0);mesh.seamPairs[0]!.right=0;mesh.seamPairs[0]!.areaM2=50;mesh.floorYMm=200;mesh.planeXMm=60;
    expect(solver.step()).toBe(true);expect(control.step()).toBe(true);expect(solver.positionsMm).toEqual(control.positionsMm);expect(solver.metrics()).toEqual(control.metrics());
    solver.reset();expect(Array.from(solver.positionsMm)).toEqual(expected.positionsMm);expect(solver.metrics().seamAreaM2).toBeCloseTo(64e-6,12);
  });
  it("assembles log-volume correction consistently in local, global, fast and final mechanics",()=>{
    const options={bulk,cohesive,gravity:false},stable=new LiverCuttingSolver(fixture(),{...options,equilibriumModel:"stable-neo-hookean"}),log=new LiverCuttingSolver(fixture(),{...options,equilibriumModel:"log-neo-hookean"});
    type State={positions:Float64Array;cells:{state:{previous:Float64Array;memory:Float64Array}}[];external:(id:number,g?:Float64Array,h?:Float64Array)=>number;evaluateCandidate:(p:Float64Array,h:number,history?:boolean)=>{energy:number;gradient:Float64Array}};
    const a=stable as unknown as State,b=log as unknown as State;
    for(const state of [a,b]){
      for(let id=0;id<state.positions.length/3;id++){
        const x=state.positions[3*id]!,y=state.positions[3*id+1]!,z=state.positions[3*id+2]!;
        state.positions[3*id]=.8*x+.03*y;state.positions[3*id+1]=.9*y-.01*z;state.positions[3*id+2]=.95*z;
      }
      state.cells.forEach((cell,i)=>{for(let k=0;k<5;k++){cell.state.previous[k]=.002*Math.sin(i+k);cell.state.memory[k]=.001*Math.cos(i-k);}});
    }
    const prediction=b.positions.slice(),before=structuredClone(b.cells.map(cell=>cell.state)),fast=b.evaluateCandidate(prediction,log.dtSeconds,false),exact=b.evaluateCandidate(prediction,log.dtSeconds,true),baseline=a.evaluateCandidate(prediction,stable.dtSeconds,true);
    expect(fast.energy).toBe(exact.energy);expect(fast.gradient).toEqual(exact.gradient);expect(exact.energy).toBeGreaterThan(baseline.energy);
    for(let id=0;id<b.positions.length/3;id++){
      const ga=new Float64Array(3),gb=new Float64Array(3);a.external(id,ga);b.external(id,gb);
      for(let axis=0;axis<3;axis++){
        const index=3*id+axis,old=b.positions[index]!,eps=1e-8;
        b.positions[index]=old-eps;const lo=b.evaluateCandidate(prediction,log.dtSeconds,false).energy;
        b.positions[index]=old+eps;const hi=b.evaluateCandidate(prediction,log.dtSeconds,false).energy;b.positions[index]=old;
        expect(Math.abs((hi-lo)/(2*eps)-exact.gradient[index]!)).toBeLessThan(2e-7);
        expect(gb[axis]!-ga[axis]!).toBeCloseTo(exact.gradient[index]!-baseline.gradient[index]!,10);
      }
    }
    expect(b.cells.map(cell=>cell.state)).toEqual(before);
    const clean=new LiverCuttingSolver(fixture(),{...options,equilibriumModel:"log-neo-hookean"});expect(clean.step()).toBe(true);
    expect(clean.metrics().fractureDissipationJ).toBe(0);expect(clean.metrics().minimumJacobian).toBeCloseTo(1,12);
  });

  it("rejects complete surface overlap before any accepted history changes",()=>{
    const mesh=JSON.parse(fs.readFileSync(new URL("../../public/cutting/liver-reference.json",import.meta.url),"utf8")) as CuttingReference;
    const solver=new LiverCuttingSolver(mesh,{bulk,cohesive,gravity:false});
    const internal=solver as unknown as {contactSurface:{evaluate:()=>{upperMm:number;lowerMm:number;worstTriangle:number;triangleCount:number;candidateTriangles:number}};positions:Float64Array;velocities:Float64Array;contactSides:Int8Array;cells:{state:unknown}[]};
    const before={metrics:solver.metrics(),positions:solver.positionsMm.slice(),velocity:internal.velocities.slice(),damage:solver.damage.slice(),opening:solver.maximumOpeningM.slice(),sides:internal.contactSides.slice(),pose:solver.scalpelPose(),history:internal.cells.map(cell=>structuredClone(cell.state))};
    const gate=vi.spyOn(internal.contactSurface,"evaluate").mockReturnValue({upperMm:.061,lowerMm:.06099,worstTriangle:5,triangleCount:mesh.cap!.indices.length/3,candidateTriangles:1});
    expect(solver.step()).toBe(false);expect(gate).toHaveBeenCalledTimes(6);
    expect(solver.metrics()).toEqual({...before.metrics,rejectedSteps:1,timeStepRetries:5,lastError:"Blade surface penetration 0.0610 mm exceeds 0.0600 mm gate"});
    expect(solver.positionsMm).toEqual(before.positions);expect(internal.velocities).toEqual(before.velocity);
    expect(solver.damage).toEqual(before.damage);expect(solver.maximumOpeningM).toEqual(before.opening);
    expect(internal.contactSides).toEqual(before.sides);expect(solver.scalpelPose()).toEqual(before.pose);
    expect(internal.cells.map(cell=>cell.state)).toEqual(before.history);gate.mockRestore();
    expect(solver.step()).toBe(true);expect(solver.metrics().maximumSurfacePenetrationMm).toBe(0);
    expect(new LiverCuttingSolver(fixture(),{bulk,cohesive,gravity:false}).metrics().maximumSurfacePenetrationMm).toBeNull();
  });

  it("matches cached trial and authoritative final assembly without creating trial history",()=>{
    const solver=new LiverCuttingSolver(fixture(),{bulk,cohesive,gravity:false});
    const state=solver as unknown as {positions:Float64Array;trialPose:{tipYMm:number;centerZMm:number;active:boolean};cells:{state:{previous:Float64Array;memory:Float64Array}}[];
      evaluateCandidate:(prediction:Float64Array,h:number,history:boolean)=>{energy:number;gradient:Float64Array;minimumJacobian:number;volume:number;stationarityResidualN:number;nextStates:unknown[]}};
    state.positions.forEach((value,i)=>{state.positions[i]=value+(i%3===0?.00003*Math.sin(i):i%3===1?.00002*Math.cos(i):0);});
    state.cells.forEach((cell,i)=>{for(let j=0;j<5;j++){cell.state.previous[j]=.002*Math.sin(i+j);cell.state.memory[j]=.001*Math.cos(i+2*j);}});
    state.trialPose={tipYMm:7.5,centerZMm:0,active:true};
    const history=state.cells.map(cell=>({previous:cell.state.previous.slice(),memory:cell.state.memory.slice()}));
    const prediction=Float64Array.from(state.positions,(v,i)=>v+.000001*Math.sin(i));
    const fast=state.evaluateCandidate(prediction,1/360,false),exact=state.evaluateCandidate(prediction,1/360,true);
    expect(fast.energy).toBe(exact.energy);expect(fast.gradient).toEqual(exact.gradient);
    expect(fast.minimumJacobian).toBe(exact.minimumJacobian);expect(fast.volume).toBe(exact.volume);
    expect(fast.stationarityResidualN).toBe(exact.stationarityResidualN);
    expect(fast.nextStates).toHaveLength(0);expect(exact.nextStates).toHaveLength(state.cells.length);
    expect(state.cells.map(cell=>cell.state)).toEqual(history);
  });
  it("preserves the unloaded body, mass and damage without artificial opening",()=>{
    const mesh=fixture(),solver=new LiverCuttingSolver(mesh,{bulk,cohesive,gravity:false});
    for(let i=0;i<20;i++)expect(solver.step()).toBe(true);
    expect(Math.max(...solver.positionsMm.map((v,i)=>Math.abs(v-mesh.positionsMm[i]!)))).toBeLessThan(1e-8);
    expect(solver.metrics().totalMassKg).toBeCloseTo(1.024e-6*1060,12);
    expect(solver.metrics().seamAreaM2).toBeCloseTo(64e-6,12);
    expect(solver.metrics().fractureDissipationJ).toBe(0);
    expect(solver.metrics().maximumOpeningMm).toBeLessThan(1e-9);
  });
  it("does not cut when a finite blade misses the interface",()=>{
    const solver=new LiverCuttingSolver(fixture(),{bulk,cohesive,gravity:false});
    solver.setScalpelTarget({tipYMm:0,centerZMm:50,active:true});
    // Move Z without lowering into tissue first; then descend entirely outside.
    solver.setScalpelTarget({tipYMm:10,centerZMm:50,active:true});
    for(let i=0;i<450;i++)expect(solver.step()).toBe(true);
    solver.setScalpelTarget({tipYMm:0,centerZMm:50,active:true});
    for(let i=0;i<100;i++)expect(solver.step()).toBe(true);
    expect(solver.metrics().contactForceN).toEqual([0,0,0]);
    expect(solver.metrics().fractureDissipationJ).toBe(0);
  });
  it("opens and irreversibly fractures only through actual blade loading",()=>{
    const solver=new LiverCuttingSolver(fixture(),{bulk,cohesive:{fractureEnergyJm2:.5,peakTractionPa:2000},gravity:false,iterations:48});
    solver.setScalpelTarget({tipYMm:3,centerZMm:0,active:true});
    for(let i=0;i<160;i++)expect(solver.step(),solver.metrics().lastError).toBe(true);
    const loaded=solver.metrics();
    expect(loaded.maximumOpeningMm).toBeGreaterThan(.5);
    expect(loaded.separatedAreaM2).toBeGreaterThan(0);
    expect(loaded.fractureDissipationJ).toBeGreaterThan(0);
    expect(loaded.minimumJacobian).toBeGreaterThan(.3);
    expect(loaded.totalMassKg).toBeCloseTo(1.024e-6*1060,12);
    const damage=solver.damage.slice();
    solver.setScalpelTarget({tipYMm:12,centerZMm:0,active:true});
    for(let i=0;i<160;i++)expect(solver.step(),solver.metrics().lastError).toBe(true);
    solver.damage.forEach((value,i)=>expect(value).toBeGreaterThanOrEqual(damage[i]!));
  });
  it("restores every accepted observable when a trial solve fails",()=>{
    const solver=new LiverCuttingSolver(fixture(),{bulk,cohesive,gravity:false});solver.step();
    const before=solver.metrics(),positions=solver.positionsMm.slice(),damage=solver.damage.slice(),history=solver.maximumOpeningM.slice(),pose=solver.scalpelPose();
    const internal=solver as unknown as {continuum:{solveVertices:()=>void};positions:Float64Array};
    const fault=vi.spyOn(internal.continuum,"solveVertices").mockImplementation(()=>{internal.positions[0]=NaN;});
    solver.setScalpelTarget({tipYMm:0,centerZMm:0,active:true});expect(solver.step()).toBe(false);fault.mockRestore();
    expect(solver.positionsMm).toEqual(positions);expect(solver.damage).toEqual(damage);expect(solver.maximumOpeningM).toEqual(history);expect(solver.scalpelPose()).toEqual(pose);
    expect(solver.metrics()).toEqual({...before,rejectedSteps:1,lastError:"Nonfinite tissue state"});
    expect(solver.step()).toBe(true);
    solver.reset();expect(solver.metrics().timeSeconds).toBe(0);expect(solver.damage.every(v=>v===0)).toBe(true);
  });
  it("retries uncommitted contact steps with matching time and tool travel",()=>{
    const options={bulk,cohesive,gravity:false},solver=new LiverCuttingSolver(fixture(),options),direct=new LiverCuttingSolver(fixture(),options);
    const target={tipYMm:0,centerZMm:0,active:true};solver.setScalpelTarget(target);direct.setScalpelTarget(target);
    const internal=solver as unknown as {evaluateCandidate:(prediction:Float64Array,h:number)=>{stationarityResidualN:number}};
    const evaluate=internal.evaluateCandidate.bind(internal);
    const fault=vi.spyOn(internal,"evaluateCandidate").mockImplementation((prediction,h)=>{
      const result=evaluate(prediction,h);return h===solver.dtSeconds?{...result,stationarityResidualN:.03}:result;
    });
    expect(solver.step()).toBe(true);fault.mockRestore();
    expect(direct.step(direct.dtSeconds/2)).toBe(true);
    expect(solver.metrics().lastStepSeconds).toBe(solver.dtSeconds/2);
    expect(solver.metrics().timeSeconds).toBe(solver.dtSeconds/2);
    expect(solver.metrics().timeStepRetries).toBe(1);expect(solver.metrics().rejectedSteps).toBe(0);
    expect(solver.scalpelPose()).toEqual(direct.scalpelPose());
    expect(solver.positionsMm).toEqual(direct.positionsMm);
    expect(solver.damage).toEqual(direct.damage);expect(solver.maximumOpeningM).toEqual(direct.maximumOpeningM);
    // A subsequent step also agrees: retry did not leak velocity/Maxwell state.
    expect(solver.step()).toBe(true);expect(direct.step()).toBe(true);
    expect(solver.positionsMm).toEqual(direct.positionsMm);
    expect(solver.metrics().toolWorkJ).toBe(direct.metrics().toolWorkJ);
  });
  it("bounds unsuccessful timestep recovery and publishes no trial state",()=>{
    const solver=new LiverCuttingSolver(fixture(),{bulk,cohesive,gravity:false,iterations:1});
    const before=solver.metrics(),positions=solver.positionsMm.slice(),pose=solver.scalpelPose();
    const internal=solver as unknown as {evaluateCandidate:(prediction:Float64Array,h:number)=>{stationarityResidualN:number}};
    const evaluate=internal.evaluateCandidate.bind(internal);
    vi.spyOn(internal,"evaluateCandidate").mockImplementation((prediction,h)=>({...evaluate(prediction,h),stationarityResidualN:.03}));
    solver.setScalpelTarget({tipYMm:0,centerZMm:0,active:true});expect(solver.step()).toBe(false);
    expect(solver.metrics()).toEqual({...before,rejectedSteps:1,timeStepRetries:5,lastError:"Mechanical residual 0.0300 N exceeds 0.001 N gate"});
    expect(solver.positionsMm).toEqual(positions);expect(solver.scalpelPose()).toEqual(pose);
    expect(solver.damage.every(v=>v===0)).toBe(true);expect(solver.maximumOpeningM.every(v=>v===0)).toBe(true);
  });
  it("uses a coupled work-conjugate fracture potential during mixed opening",()=>{
    const solver=new LiverCuttingSolver(fixture(),{bulk,cohesive:{fractureEnergyJm2:.5,peakTractionPa:2000},gravity:false});
    const internal=solver as unknown as {positions:Float64Array;external:(id:number,g?:Float64Array)=>number};
    internal.positions[3*10]!+=.0002;internal.positions[3*10+1]!+=.0001;
    const gradient=new Float64Array(3);internal.external(10,gradient);
    for(let axis=0;axis<3;axis++){
      const index=3*10+axis,old=internal.positions[index]!,h=1e-8;
      internal.positions[index]=old+h;const hi=internal.external(10);
      internal.positions[index]=old-h;const lo=internal.external(10);
      internal.positions[index]=old;expect((hi-lo)/(2*h)).toBeCloseTo(gradient[axis]!,6);
    }
    // Trial evaluations cannot publish damage or alter its history.
    expect(solver.damage.every(v=>v===0)).toBe(true);expect(solver.maximumOpeningM.every(v=>v===0)).toBe(true);
  });
  it("releases work-conjugate capsule retraction across damaged seam pairs and maintains post-withdrawal gaping",()=>{
    const options={bulk,cohesive:{fractureEnergyJm2:.5,peakTractionPa:2000},gravity:false,iterations:48,capsuleRetractionPa:600};
    const solver=new LiverCuttingSolver(fixture(),options),control=new LiverCuttingSolver(fixture(),{...options,capsuleRetractionPa:0});
    for(const s of [solver,control]){
      s.setScalpelTarget({tipYMm:3,centerZMm:0,active:true});
      for(let i=0;i<160;i++)expect(s.step(),s.metrics().lastError).toBe(true);
      s.setScalpelTarget({tipYMm:12,centerZMm:0,active:true});
      for(let i=0;i<160;i++)expect(s.step(),s.metrics().lastError).toBe(true);
    }
    expect(solver.metrics().maximumOpeningMm).toBeGreaterThan(control.metrics().maximumOpeningMm+.4);
    const state=solver as unknown as {positions:Float64Array;evaluateCandidate:(p:Float64Array,h:number,history:boolean)=>{energy:number;gradient:Float64Array}};
    const prediction=state.positions.slice(),fast=state.evaluateCandidate(prediction,solver.dtSeconds,false),exact=state.evaluateCandidate(prediction,solver.dtSeconds,true);
    expect(fast.energy).toBeCloseTo(exact.energy,12);expect(fast.gradient).toEqual(exact.gradient);
  });
  it("supports work-conjugate anisotropic mixed-mode shear coupling and heterogeneous seam toughness multipliers",()=>{
    expect(()=>new LiverCuttingSolver(fixture(),{bulk,cohesive,shearCouplingBeta:0})).toThrow(/beta/);
    expect(()=>new LiverCuttingSolver(fixture(),{bulk,cohesive,seamToughnessMultipliers:[1,2]})).toThrow(/seamPairs/);
    expect(()=>new LiverCuttingSolver(fixture(),{bulk,cohesive,seamToughnessMultipliers:[1,-1,1,1]})).toThrow(/Positive/);
    const solver=new LiverCuttingSolver(fixture(),{bulk,cohesive:{fractureEnergyJm2:.5,peakTractionPa:2000},gravity:false,shearCouplingBeta:.65,seamToughnessMultipliers:[1,2.5,2.5,1]});
    const internal=solver as unknown as {positions:Float64Array;external:(id:number,g?:Float64Array)=>number;evaluateCandidate:(p:Float64Array,h:number,history:boolean)=>{energy:number;gradient:Float64Array}};
    internal.positions[3*10]!+=.00022;internal.positions[3*10+1]!+=.00014;internal.positions[3*10+2]!-=0.00009;
    const gradient=new Float64Array(3);internal.external(10,gradient);
    for(let axis=0;axis<3;axis++){
      const index=3*10+axis,old=internal.positions[index]!,h=1e-8;
      internal.positions[index]=old+h;const hi=internal.external(10);
      internal.positions[index]=old-h;const lo=internal.external(10);
      internal.positions[index]=old;expect((hi-lo)/(2*h)).toBeCloseTo(gradient[axis]!,6);
    }
    const prediction=internal.positions.slice(),fast=internal.evaluateCandidate(prediction,solver.dtSeconds,false),exact=internal.evaluateCandidate(prediction,solver.dtSeconds,true);
    expect(fast.energy).toBe(exact.energy);expect(fast.gradient).toEqual(exact.gradient);
  });
});
