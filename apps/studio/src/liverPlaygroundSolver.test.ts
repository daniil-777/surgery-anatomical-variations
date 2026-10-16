import { describe, expect, it, vi } from "vitest";
import type { PhysicsParameters } from "./atlasPhysics";
import femaleCage from "./fixtures/liver-playground-female-cage.json";
import maleCage from "./fixtures/liver-playground-male-cage.json";
import { LiverPlaygroundSolver, type PlaygroundMesh } from "./liverPlaygroundSolver";

const parameters: PhysicsParameters = { young_pa: 5000, poisson: .45, relaxation_fraction: .4, relaxation_time_s: .7, density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };

function cube(resolution = 2): PlaygroundMesh {
  const positions: number[] = [], tets: number[] = [], n = resolution + 1;
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) positions.push(60 * x / resolution - 30, 60 * y / resolution - 30, 60 * z / resolution - 30);
  const index = (q: number[]) => (q[0]! * n + q[1]!) * n + q[2]!;
  for (let x = 0; x < resolution; x++) for (let y = 0; y < resolution; y++) for (let z = 0; z < resolution; z++) for (const permutation of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const q = [x, y, z], ids = [index(q)]; for (const axis of permutation) { q[axis]!++; ids.push(index(q)); }
    if (signedVolume(positions, ids) < 0) [ids[1], ids[2]] = [ids[2]!, ids[1]!]; tets.push(...ids);
  }
  const boundary = new Map<string, number[]>();
  for (let t = 0; t < tets.length; t += 4) for (const pattern of [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]]) {
    const face = pattern.map(i => tets[t + i]!), key = [...face].sort((a, b) => a - b).join(":");
    if (boundary.has(key)) boundary.delete(key); else boundary.set(key, face);
  }
  return { reference_positions_mm: positions, tets, surface_indices: [...boundary.values()].flat() };
}

function signedVolume(positions: ArrayLike<number>, ids: readonly number[]) {
  const vectors = ids.slice(1).map(id => [0, 1, 2].map(k => positions[3 * id + k]! - positions[3 * ids[0]! + k]!));
  const [a, b, c] = vectors;
  return (a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) + a![1]! * (b![2]! * c![0]! - b![0]! * c![2]!) + a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!)) / 6;
}
function simulate(solver: LiverPlaygroundSolver, seconds: number) { for (let i = 0; i < Math.round(seconds / solver.fixedStepS); i++) solver.step(); }
function strain(mesh: PlaygroundMesh, positions: ArrayLike<number>) {
  const edges = new Map<string, [number, number]>();
  for (let t = 0; t < mesh.tets.length; t += 4) for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) { const i = mesh.tets[t + a]!, j = mesh.tets[t + b]!; edges.set([i, j].sort((a, b) => a - b).join(":"), [i, j]); }
  let sum = 0;
  for (const [a, b] of edges.values()) { const rest = Math.hypot(...[0, 1, 2].map(k => mesh.reference_positions_mm[3 * a + k]! - mesh.reference_positions_mm[3 * b + k]!)); const now = Math.hypot(...[0, 1, 2].map(k => positions[3 * a + k]! - positions[3 * b + k]!)); sum += (now / rest - 1) ** 2; }
  return Math.sqrt(sum / edges.size);
}
function topPoint(solver: LiverPlaygroundSolver): number[] {
  let index = 0; for (let i = 1; i < solver.positionsMm.length / 3; i++) if (solver.positionsMm[3 * i + 1]! > solver.positionsMm[3 * index + 1]!) index = i;
  return Array.from(solver.positionsMm.slice(3 * index, 3 * index + 3));
}

describe("LiverPlaygroundSolver numerical behavior", () => {
  it("keeps an unforced body at rest and uses SI mass / free-fall acceleration", () => {
    const mesh = cube(), solver = new LiverPlaygroundSolver(mesh, parameters, { materialModel: "legacy", floorYmm: 0, gravity: false });
    const initial = solver.positionsMm.slice(); simulate(solver, 1);
    expect(Math.max(...solver.positionsMm.map((v, i) => Math.abs(v - initial[i]!)))).toBeLessThan(1e-5);
    expect(solver.masses.reduce((a, b) => a + b, 0)).toBeCloseTo(.06 ** 3 * 1060, 10);
    solver.drop(1000); solver.setGravity(true); const before = solver.metrics().center_of_mass_mm[1];
    for (let i = 0; i < 12; i++) solver.step();
    const expectedMm = 9.81 * (1 / 240) ** 2 * 12 * 13 / 2 * 1000;
    expect(before - solver.metrics().center_of_mass_mm[1]).toBeCloseTo(expectedMm, 1);
    expect(strain(mesh, solver.positionsMm)).toBeLessThan(1e-5);
  });

  it("settles the actual skinny female cage after rest/freefall/reset without time freezing", () => {
    const solver = new LiverPlaygroundSolver(femaleCage.mesh, femaleCage.parameters, { materialModel: "legacy", floorYmm: 0, gravity: false });
    simulate(solver, 1); solver.setGravity(true); solver.drop(1000); for (let i = 0; i < 12; i++) solver.step(); solver.drop(75);
    simulate(solver, 6);
    const metrics = solver.metrics();
    expect(metrics.simulation_time_s).toBeCloseTo(6, 8);
    expect(metrics.rejected_steps).toBe(0);
    expect(metrics.floor_penetration_mm).toBeLessThan(1e-5);
    expect(metrics.minimum_jacobian).toBeGreaterThan(.08);
    expect(metrics.maximum_speed_m_s).toBeLessThan(.01);
    expect(metrics.finite_state).toBe(true);
    expect(metrics.minimum_volume_projections).toBeGreaterThan(0);
    for (let t = 0; t < femaleCage.mesh.tets.length; t += 4) expect(signedVolume(solver.positionsMm, femaleCage.mesh.tets.slice(t, t + 4))).toBeGreaterThan(0);
  }, 20000);

  it.each([["male", maleCage], ["female", femaleCage]] as const)("survives ordinary drop heights on the actual %s cage", (_name, cage) => {
    const solver = new LiverPlaygroundSolver(cage.mesh, cage.parameters, { materialModel: "legacy", floorYmm: 0 });
    for (const height of [25, 50, 75, 100, 150]) {
      solver.drop(height); simulate(solver, 2);
      const metrics = solver.metrics();
      expect(metrics.simulation_time_s).toBeCloseTo(2, 8);
      expect(metrics.rejected_steps).toBe(0);
      expect(metrics.floor_penetration_mm).toBeLessThan(1e-5);
      expect(metrics.minimum_jacobian).toBeGreaterThan(.08);
      expect(metrics.finite_state).toBe(true);
    }
  }, 20000);

  it("deforms more under gravity with a lower learned modulus", () => {
    const mesh = cube(), soft = new LiverPlaygroundSolver(mesh, { ...parameters, young_pa: 1500 }, { materialModel: "legacy", floorYmm: 0 }), stiff = new LiverPlaygroundSolver(mesh, { ...parameters, young_pa: 15000 }, { materialModel: "legacy", floorYmm: 0 });
    soft.drop(0); stiff.drop(0); simulate(soft, 3); simulate(stiff, 3);
    expect(strain(mesh, soft.positionsMm)).toBeGreaterThan(strain(mesh, stiff.positionsMm) * 2);
    expect(soft.metrics().floor_penetration_mm).toBeLessThan(1e-5);
    expect(soft.metrics().minimum_jacobian).toBeGreaterThan(.08);
  });

  it("grabs a material patch, moves the body and recovers local strain after release", () => {
    const mesh = cube(), solver = new LiverPlaygroundSolver(mesh, parameters, { materialModel: "legacy", floorYmm: 0, gravity: false });
    const hit = topPoint(solver), centerBefore = solver.metrics().center_of_mass_mm;
    solver.beginGrab(hit, 25); solver.moveGrab([hit[0]! + 25, hit[1]! + 15, hit[2]!]); simulate(solver, .25);
    const heldStrain = strain(mesh, solver.positionsMm);
    expect(heldStrain).toBeGreaterThan(.005);
    expect(solver.metrics().center_of_mass_mm[0]).toBeGreaterThan(centerBefore[0] + 2);
    solver.endGrab(); simulate(solver, 3);
    expect(strain(mesh, solver.positionsMm)).toBeLessThan(heldStrain * .5);
    expect(solver.metrics().rejected_steps).toBe(0);
  });

  it("detects sphere contact in a coarse face interior without relying on vertices", () => {
    const mesh = cube(1), solver = new LiverPlaygroundSolver(mesh, parameters, { materialModel: "legacy", floorYmm: 0 }); solver.drop(0); simulate(solver, 1);
    const top = Math.max(...Array.from(solver.positionsMm).filter((_, i) => i % 3 === 1));
    const center = solver.metrics().center_of_mass_mm;
    solver.setProbe([center[0], top + 12, center[2]], 12); solver.setProbe([center[0], top + 3, center[2]], 12); simulate(solver, .5);
    expect(solver.metrics().maximum_probe_penetration_mm).toBeGreaterThan(0);
    expect(solver.metrics().maximum_probe_penetration_mm).toBeLessThan(10);
    expect(solver.metrics().minimum_jacobian).toBeGreaterThan(.08);
    expect(solver.metrics().floor_penetration_mm).toBeLessThan(1e-5);
    solver.setProbe(null); simulate(solver, 2); expect(solver.metrics().maximum_probe_penetration_mm).toBe(0);
  });

  it("exposes copied actual tool positions instead of unachieved pointer targets", () => {
    const solver = new LiverPlaygroundSolver(cube(), parameters, { materialModel: "legacy", floorYmm: 0, gravity: false });
    expect(solver.interactionState()).toEqual({ probe: null, grab: null });
    solver.setProbe([200, 200, 0], 8); solver.setProbe([260, 200, 0], 8);
    expect(solver.interactionState().probe!.centerMm).toEqual([200, 200, 0]);
    solver.step();
    const state = solver.interactionState();
    expect(state.probe!.centerMm[0]).toBeCloseTo(200 + Math.min(700 / 240, 8 / 3), 10);
    expect(state.probe!.targetMm).toEqual([260, 200, 0]);
    expect(state.probe!.radiusMm).toBe(8);
    (state.probe!.centerMm as unknown as number[])[0] = -1000;
    (state.probe!.targetMm as unknown as number[])[0] = -1000;
    expect(solver.interactionState().probe!.centerMm[0]).toBeCloseTo(200 + Math.min(700 / 240, 8 / 3), 10);
    expect(solver.interactionState().probe!.targetMm[0]).toBe(260);
    solver.setProbe(null);
    const hit = topPoint(solver); solver.beginGrab(hit, 25); solver.moveGrab([hit[0]! + 30, hit[1]!, hit[2]!]);
    const grabbed = solver.interactionState().grab!;
    expect(grabbed.attachmentMm[0]).toBeCloseTo(hit[0]!, 5);
    expect(grabbed.handleMm[0]).toBeCloseTo(hit[0]!, 5);
    expect(grabbed.targetMm[0]).toBeCloseTo(hit[0]! + 30, 5);
    (grabbed.attachmentMm as unknown as number[])[0] = -1000;
    expect(solver.interactionState().grab!.attachmentMm[0]).toBeCloseTo(hit[0]!, 5);
    solver.endGrab(); expect(solver.interactionState()).toEqual({ probe: null, grab: null });
  });

  it("survives repeated strong punches and reports fixed-time catchup honestly", () => {
    const solver = new LiverPlaygroundSolver(cube(), parameters, { materialModel: "legacy", floorYmm: 0 }); solver.drop(0); simulate(solver, 1);
    for (let i = 0; i < 8; i++) { solver.punch(topPoint(solver), [i % 2 ? 1 : -1, -1, .2], 1.5, 55); simulate(solver, .5); }
    simulate(solver, 3); const metrics = solver.metrics();
    expect(metrics.finite_state).toBe(true); expect(metrics.rejected_steps).toBe(0); expect(metrics.minimum_jacobian).toBeGreaterThan(.08); expect(metrics.floor_penetration_mm).toBeLessThan(1e-5);
    solver.reset(); expect(solver.advance(2)).toBe(12); expect(solver.metrics().simulation_time_s).toBeCloseTo(.05, 10); expect(solver.metrics().dropped_time_s).toBeCloseTo(1.95, 10);
  });

  it("rejects invalid inputs without corrupting the last valid state", () => {
    const mesh = cube(), solver = new LiverPlaygroundSolver(mesh, parameters);
    const before = solver.positionsMm.slice();
    expect(() => solver.moveGrab([NaN, 0, 0])).toThrow(); expect(() => solver.punch([0, 0, 0], [1, 0, 0], Infinity)).toThrow(); expect(() => solver.step(.1)).toThrow(); expect(() => solver.advance(NaN)).toThrow(); expect(() => solver.setParameters({ ...parameters, young_pa: -1 })).toThrow();
    expect(Array.from(solver.positionsMm)).toEqual(Array.from(before));
    expect(() => new LiverPlaygroundSolver({ ...mesh, reference_positions_mm: [...mesh.reference_positions_mm, 0, 0, 0] }, parameters)).toThrow("Unconnected");
    expect(() => new LiverPlaygroundSolver({ ...mesh, tets: [0, 0, 1, 2] }, parameters)).toThrow();
  });
});


describe("continuum playground integration", () => {
  it.each([["male", maleCage], ["female", femaleCage]] as const)("settles and manipulates the actual %s cage without inversion or lost time", (_name, cage) => {
    const solver = new LiverPlaygroundSolver(cage.mesh, cage.parameters, { floorYmm: 0, gravity: false, materialModel: "continuum" });
    const initial = solver.positionsMm.slice(); simulate(solver, .25);
    expect(Math.max(...solver.positionsMm.map((v, i) => Math.abs(v - initial[i]!)))).toBeLessThan(1e-5);
    solver.setGravity(true); solver.drop(75); simulate(solver, 3);
    expect(Math.abs(solver.metrics().volume_change_pct)).toBeLessThan(3);
    const hit = topPoint(solver); solver.beginGrab(hit, 35); solver.moveGrab([hit[0]! + 60, hit[1]! + 60, hit[2]!]); simulate(solver, .5); solver.endGrab();
    const probe = topPoint(solver); solver.setProbe([probe[0]!, probe[1]! + 6, probe[2]!], 6); solver.setProbe(probe, 6); simulate(solver, .25);
    expect(solver.metrics().maximum_probe_penetration_mm).toBeLessThan(6); solver.setProbe(null);
    solver.punch(topPoint(solver), [.5, -1, .2], 1.5, 35); simulate(solver, 1);
    const metrics = solver.metrics(); expect(metrics.simulation_time_s).toBeCloseTo(4.75, 8);
    expect(metrics.rejected_steps).toBe(0); expect(metrics.finite_state).toBe(true); expect(metrics.minimum_jacobian).toBeGreaterThan(.08);
    expect(metrics.floor_penetration_mm).toBeLessThan(1e-5); expect(metrics.minimum_volume_projections).toBe(0);
    expect(metrics.material_model).toBe("continuum"); expect(metrics.fixed_step_s).toBe(1 / 120);
    expect(metrics.final_sweep_max_displacement_mm).toBeGreaterThanOrEqual(0);
    solver.reset(); expect(solver.advance(2)).toBe(6); expect(solver.metrics().simulation_time_s).toBeCloseTo(.05, 10);
    expect(solver.metrics().dropped_time_s).toBeCloseTo(1.95, 10); expect(solver.interactionState()).toEqual({ grab: null, probe: null });
  }, 20000);

  it("responds to modulus and recovers continuum strain after releasing a grasp", () => {
    const mesh = cube();
    const soft = new LiverPlaygroundSolver(mesh, { ...parameters, young_pa: 1500 }, { floorYmm: 0, materialModel: "continuum" });
    const stiff = new LiverPlaygroundSolver(mesh, { ...parameters, young_pa: 15000 }, { floorYmm: 0, materialModel: "continuum" });
    soft.drop(0); stiff.drop(0); simulate(soft, 2); simulate(stiff, 2);
    expect(strain(mesh, soft.positionsMm)).toBeGreaterThan(strain(mesh, stiff.positionsMm) * 2);
    const free = new LiverPlaygroundSolver(mesh, parameters, { floorYmm: 0, gravity: false, materialModel: "continuum" });
    const hit = topPoint(free); free.beginGrab(hit, 25); free.moveGrab([hit[0]! + 25, hit[1]! + 15, hit[2]!]); simulate(free, .25);
    const held = strain(mesh, free.positionsMm); expect(held).toBeGreaterThan(.005); free.endGrab(); simulate(free, 3);
    expect(strain(mesh, free.positionsMm)).toBeLessThan(held * .5); expect(free.metrics().rejected_steps).toBe(0);
  });

  it("rolls back rejected particle, material, and mechanical tool state and accounts for rejected time", () => {
    const solver = new LiverPlaygroundSolver(cube(), parameters, { floorYmm: 0, gravity: false, materialModel: "continuum" });
    const hit = topPoint(solver); solver.beginGrab(hit, 25); solver.moveGrab([hit[0]! + 50, hit[1]!, hit[2]!]);
    solver.setProbe([200, 200, 0], 6); solver.setProbe([250, 200, 0], 6);
    const internals = solver as unknown as { continuum: { solveVertices: (...args: unknown[]) => void; cells: unknown[] }; maxProbePenetration: number };
    // A deterministic failed numerical trial exercises a path normal protocols should never reach.
    const before = solver.positions.slice(), velocity = solver.velocities.slice(), tools = solver.interactionState();
    const history = JSON.stringify(internals.continuum.cells); internals.maxProbePenetration = .0003;
    const failed = vi.spyOn(internals.continuum, "solveVertices").mockImplementation(() => { solver.positions[0] = NaN; });
    expect(solver.advance(solver.fixedStepS)).toBe(1); failed.mockRestore();
    expect(solver.positions).toEqual(before); expect(solver.velocities).toEqual(velocity); expect(solver.interactionState()).toEqual(tools);
    // beginStep scratch shifts are refreshed, but committed Maxwell state is unchanged.
    const state = (value: string) => (JSON.parse(value) as { state: unknown }[]).map(cell => cell.state);
    expect(state(JSON.stringify(internals.continuum.cells))).toEqual(state(history));
    expect(solver.metrics().simulation_time_s).toBe(0); expect(solver.metrics().rejected_steps).toBe(1);
    expect(solver.metrics().rejected_time_s).toBeCloseTo(solver.fixedStepS, 12); expect(solver.metrics().maximum_probe_penetration_mm).toBeCloseTo(.3, 12);
    expect(solver.step()).toBe(true); expect(solver.metrics().simulation_time_s).toBeCloseTo(solver.fixedStepS, 12);
  });
});


describe("unilateral closest-triangle probe contact", () => {
  it("has consistent augmented energy, nodal/tool forces and torque balance", () => {
    const solver = new LiverPlaygroundSolver(cube(1), parameters, { floorYmm:0, gravity:false, contactModel:"augmented", floorFrictionModel:"reaction" });
    const top = Math.max(...Array.from(solver.positionsMm).filter((_,i)=>i%3===1));solver.setProbe([7,top+6,5],8);
    type Face = { lambda:Float64Array;supportGap:number };
    const internal = solver as unknown as { probe:{current:[number,number,number];faces:Face[]};sampleStiffness:(face:Face)=>number;continuumExternal:(id:number,g?:Float64Array,h?:Float64Array)=>number;acceptedProbeResponse:()=>void };
    for(const face of internal.probe.faces){face.lambda[0]=.1;face.supportGap=.1/internal.sampleStiffness(face);}internal.acceptedProbeResponse();
    const force=[0,0,0],torque=[0,0,0],cross=(a:number[],b:number[])=>[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];
    for(let id=0;id<solver.masses.length;id++) {
      const gradient=new Float64Array(3);internal.continuumExternal(id,gradient,new Float64Array(9));
      for(let k=0;k<3;k++) {const index=3*id+k,old=solver.positions[index]!,h=1e-8;solver.positions[index]=old+h;const hi=internal.continuumExternal(id);solver.positions[index]=old-h;const lo=internal.continuumExternal(id);solver.positions[index]=old;expect((hi-lo)/(2*h)).toBeCloseTo(gradient[k]!,5);force[k]!+=gradient[k]!;}
      const moment=cross(Array.from(solver.positions.slice(3*id,3*id+3)),Array.from(gradient));for(let k=0;k<3;k++)torque[k]!+=moment[k]!;
    }
    const metric=solver.metrics(),expectedTorque=cross(internal.probe.current,metric.probe_reaction_n);
    for(let k=0;k<3;k++){expect(force[k]).toBeCloseTo(metric.probe_reaction_n[k]!,10);expect(torque[k]).toBeCloseTo(expectedTorque[k]!,10);}
    const energy=()=>Array.from(solver.masses,(_,id)=>internal.continuumExternal(id)).reduce((a,b)=>a+b,0)/3;
    for(let k=0;k<3;k++){const old=internal.probe.current[k]!,h=1e-8;internal.probe.current[k]=old+h;const hi=energy();internal.probe.current[k]=old-h;const lo=energy();internal.probe.current[k]=old;expect((hi-lo)/(2*h)).toBeCloseTo(-metric.probe_reaction_n[k]!,5);}
    expect(metric.maximum_probe_surface_penetration_mm).toBeCloseTo(2,8);
  });
  it("detects and safely repositions an inside-created probe, preserving its requested target", () => {
    const solver=new LiverPlaygroundSolver(cube(),parameters,{floorYmm:0,gravity:false,contactModel:"augmented",floorFrictionModel:"reaction"});
    const target=solver.metrics().center_of_mass_mm;solver.setProbe(target,6);const metric=solver.metrics();
    expect(metric.probe_inside_initializations).toBe(1);expect(metric.probe_initial_inside_overlap_mm).toBeCloseTo(36,6);expect(metric.probe_initialization_adjustment_mm).toBeGreaterThan(36);
    expect(metric.probe_center_inside).toBe(false);expect(metric.maximum_probe_surface_penetration_mm).toBe(0);solver.interactionState().probe!.targetMm.forEach((v,i)=>expect(v).toBeCloseTo(target[i]!,10));expect(metric.probe_work_j).toBe(0);
    for(let frame=0;frame<60;frame++){const previous=solver.interactionState().probe!.centerMm;expect(solver.step(1/60)).toBe(true);const current=solver.interactionState().probe!.centerMm;expect(Math.hypot(...current.map((v,i)=>v-previous[i]!))).toBeLessThanOrEqual(2+1e-8);expect(solver.metrics().probe_center_inside).toBe(false);}
    expect(solver.metrics().probe_motion_clamped_steps).toBeGreaterThan(0);expect(solver.metrics().simulation_time_s).toBeCloseTo(1,10);
    const internals=solver as unknown as {probe:{current:[number,number,number]};acceptedProbeResponse:()=>void};const accepted=[...internals.probe.current] as [number,number,number];internals.probe.current=solver.metrics().center_of_mass_mm.map(v=>v*.001) as [number,number,number];internals.acceptedProbeResponse();expect(solver.metrics().probe_center_inside).toBe(true);expect(solver.metrics().maximum_probe_surface_penetration_mm).toBeGreaterThan(6);internals.probe.current=accepted;internals.acceptedProbeResponse();
    const work=solver.metrics().probe_work_j;solver.setProbe(null);expect(solver.metrics().probe_reaction_n).toEqual([0,0,0]);expect(solver.metrics().probe_work_j).toBe(work);expect(solver.metrics().probe_removal_count).toBe(1);
    solver.reset();expect(solver.metrics().probe_work_j).toBe(0);expect(solver.metrics().probe_inside_initializations).toBe(0);expect(solver.metrics().maximum_probe_surface_penetration_mm).toBe(0);
  });
  it("has no contact-operator holes across a coarse edge and no tensile force on separation", () => {
    const solver=new LiverPlaygroundSolver(cube(1),parameters,{floorYmm:0,gravity:false,contactModel:"augmented",floorFrictionModel:"reaction"});solver.drop(0);
    const top=Math.max(...Array.from(solver.positionsMm).filter((_,i)=>i%3===1));solver.setProbe([-10,top+6,0],8);
    const internal=solver as unknown as {probe:{current:[number,number,number]};acceptedProbeResponse:()=>void};
    for(let frame=0;frame<=100;frame++){internal.probe.current[0]=(-10+20*frame/100)*.001;internal.acceptedProbeResponse();const m=solver.metrics();expect(m.probe_normal_force_n).toBeGreaterThan(1);expect(m.maximum_probe_surface_penetration_mm).toBeCloseTo(2,8);}
    internal.probe.current[1]=(top+40)*.001;internal.acceptedProbeResponse();expect(solver.metrics().probe_normal_force_n).toBe(0);expect(solver.metrics().probe_reaction_n).toEqual([0,0,0]);
  });
  it("rolls back nonzero augmented multipliers and accepted reaction on a failed trial", () => {
    const solver=new LiverPlaygroundSolver(cube(1),parameters,{floorYmm:0,gravity:false});solver.drop(0);solver.setProbe([0,67,0],8);simulate(solver,.2);
    const internal=solver as unknown as {probe:{faces:{lambda:Float64Array;supportGap:number}[]};continuum:{solveVertices:()=>void}};
    const before=internal.probe.faces.map(face=>({lambda:Array.from(face.lambda),supportGap:face.supportGap}));expect(before.some(face=>face.lambda.some(v=>v>0))).toBe(true);
    const response=solver.metrics(),tool=solver.interactionState();const fault=vi.spyOn(internal.continuum,"solveVertices").mockImplementation(()=>{solver.positions[0]=NaN;});expect(solver.step()).toBe(false);fault.mockRestore();
    expect(internal.probe.faces.map(face=>({lambda:Array.from(face.lambda),supportGap:face.supportGap}))).toEqual(before);expect(solver.interactionState()).toEqual(tool);expect(solver.metrics().probe_reaction_n).toEqual(response.probe_reaction_n);expect(solver.metrics().probe_work_j).toBe(response.probe_work_j);expect(solver.metrics().simulation_time_s).toBe(response.simulation_time_s);
  });
  it("includes gravity-free probe preload in floor reaction and tangential friction", () => {
    const solver=new LiverPlaygroundSolver(cube(1),parameters,{floorYmm:0,gravity:false,contactModel:"augmented",floorFrictionModel:"reaction"});solver.drop(0);solver.step();expect(solver.metrics().floor_normal_reaction_n).toBeLessThan(1e-8);
    solver.setProbe([0,68,0],8);solver.setProbe([0,67,0],8);simulate(solver,1.5);
    const loaded=solver.metrics();expect(loaded.probe_reaction_n[1]).toBeGreaterThan(.01);expect(loaded.floor_normal_reaction_n).toBeGreaterThan(.01);
    expect(Math.abs(loaded.floor_normal_reaction_n-loaded.probe_reaction_n[1])/loaded.probe_reaction_n[1]).toBeLessThan(.1);
    for(let i=0;i<solver.masses.length;i++)solver.velocities[3*i]=.03;const before=solver.metrics().floor_friction_dissipated_j;solver.step();expect(solver.metrics().floor_friction_dissipated_j).toBeGreaterThan(before);
  });
});
