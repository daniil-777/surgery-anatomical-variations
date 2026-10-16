import { describe, expect, it } from "vitest";
import { WholeScenePhysics, readLearnedSceneMaterials, type LearnedSceneMaterials, type ScenePhysicsOrgan } from "./wholeScenePhysics";
const organs: ScenePhysicsOrgan[] = [
  { id: "liver", category: "digestive", bounds: { min: [-120, -100, -20], max: [40, 30, 80] } },
  { id: "stomach", category: "digestive", bounds: { min: [10, -140, -40], max: [120, 30, 70] } },
  { id: "lungs", category: "respiratory", bounds: { min: [-110, 40, -60], max: [110, 290, 60] } },
  { id: "skeleton", category: "skeleton", bounds: { min: [-140, -260, -100], max: [140, 300, 90] } },
];
function source(stiffness = 6000): LearnedSceneMaterials {
  return { schema_version: "whole-scene-materials-1.0.0", model_id: "a".repeat(64), scope: "Synthetic test material histories", materials: organs.filter(o => o.category !== "skeleton").map(o => ({ id: o.id, young_pa: stiffness, relaxation_fraction: .35, relaxation_time_s: .45, density_kg_m3: 1000, accepted_for_application: true, observation_origin: "synthetic-design-history" })) };
}
function advance(solver: WholeScenePhysics, duration: number, breathing = false, dt = 1 / 60) { for (let t = 0; t < Math.round(duration / dt); t++) solver.step(dt, breathing); }

describe("whole-scene learned viscoelastic preview", () => {
  it("rejects nonlearned, unaccepted, duplicate and incomplete assignments atomically", () => {
    for (const override of [{ young_pa: NaN }, { accepted_for_application: false }, { observation_origin: "human" }, { relaxation_time_s: -1 }]) {
      const data = source(); Object.assign(data.materials[0]!, override); expect(() => readLearnedSceneMaterials(data)).toThrow();
    }
    const duplicate = source(); duplicate.materials.push(duplicate.materials[0]!); expect(() => readLearnedSceneMaterials(duplicate)).toThrow();
    const missing = source(); missing.materials.pop(); expect(() => new WholeScenePhysics(organs, missing)).toThrow(/No accepted learned material/);
    const model = source(); model.model_id = "fake"; expect(() => readLearnedSceneMaterials(model)).toThrow();
  });
  it("has exact equilibrium without forcing and exact reset after deformation", () => {
    const solver = new WholeScenePhysics(organs, source()); advance(solver, 2);
    expect(solver.snapshot().displacement_mm).toBe(0);
    solver.pulse("liver"); advance(solver, .4);
    expect(solver.snapshot().peak_displacement_mm).toBeGreaterThan(.1);
    solver.reset(); expect(solver.snapshot().displacement_mm).toBe(0); expect(solver.snapshot().time_s).toBe(0);
    const rest = new Float32Array([0, 0, 30, 20, 40, 20]), out = new Float32Array(rest.length); solver.deform(rest, out, solver.bind(rest)); expect(out).toEqual(rest);
  });
  it("learned stiffness changes the actual forced displacement", () => {
    const soft = new WholeScenePhysics(organs, source(1500)), stiff = new WholeScenePhysics(organs, source(15000));
    soft.pulse("liver"); stiff.pulse("liver"); advance(soft, .3); advance(stiff, .3);
    expect(soft.snapshot().peak_displacement_mm).toBeGreaterThan(stiff.snapshot().peak_displacement_mm * 1.8);
    expect(soft.snapshot().organs).toHaveLength(3);
  });
  it("deforms shared attachment coordinates identically and recovers after the load", () => {
    const solver = new WholeScenePhysics(organs, source());
    const p = new Float32Array([0, -25, 45, 20, 0, 50, 0, -25, 45]), a = solver.bind(p), out = new Float32Array(p.length);
    solver.pulse("liver"); advance(solver, .35); solver.deform(p, out, a);
    expect(Array.from(out.slice(0, 3))).toEqual(Array.from(out.slice(6, 9)));
    expect(out).not.toEqual(p); const peak = solver.snapshot().peak_displacement_mm;
    advance(solver, 10); expect(solver.snapshot().displacement_mm).toBeLessThan(peak * .001);
  });
  it("replays with different render frame intervals at a fixed physical timestep", () => {
    const a = new WholeScenePhysics(organs, source()), b = new WholeScenePhysics(organs, source());
    a.pulse("stomach"); b.pulse("stomach"); advance(a, 3, true, 1 / 60); advance(b, 3, true, 1 / 30);
    expect(a.snapshot().organs.map(o => o.displacement_mm)).toEqual(b.snapshot().organs.map(o => o.displacement_mm));
    expect(a.snapshot().time_s).toBeCloseTo(3, 9);
    a.step(.5, false); expect(a.snapshot().dropped_time_s).toBeCloseTo(.4, 10);
    expect(a.snapshot().time_s).toBeCloseTo(3.1, 9);
  });
  it("stays finite and keeps the shared field below its orientation-preserving gradient bound", () => {
    const solver = new WholeScenePhysics(organs, source(500));
    for (let cycle = 0; cycle < 18; cycle++) {
      solver.pulse(cycle % 2 ? "liver" : "stomach"); advance(solver, .4, true);
      const report = solver.snapshot(); expect(report.finite).toBe(true); expect(report.displacement_gradient_bound).toBeLessThanOrEqual(.25); expect(report.displacement_mm).toBeLessThanOrEqual(8.00001);
    }
    expect(solver.snapshot().organs.every(o => Math.hypot(...o.displacement_mm) > 0)).toBe(true);
  });
  it("rejects invalid times and bindings instead of publishing corrupt geometry", () => {
    const solver = new WholeScenePhysics(organs, source()); expect(() => solver.step(NaN, false)).toThrow(); expect(() => solver.step(-1, false)).toThrow();
    expect(() => solver.bind(new Float32Array([NaN, 0, 0]))).toThrow(); expect(() => solver.deform(new Float32Array(3), new Float32Array(6), solver.bind(new Float32Array(3)))).toThrow();
  });
});

describe("localized learned-material tool loading", () => {
  const anchor = [-20, -20, 45];
  function push(solver: WholeScenePhysics, depth = 12) {
    solver.beginToolContact({ mode: "push", organId: "liver", restPointMm: anchor, normal: [0, 0, 1], targetPointMm: [-20, -20, 45 - depth], radiusMm: 6 });
  }
  it("pushes the actual selected location with compressive-only normal force", () => {
    const solver = new WholeScenePhysics(organs, source()); push(solver); advance(solver, .7);
    const report = solver.toolSnapshot()!;
    expect(report.active).toBe(true); expect(report.actualSurfacePointMm[2]).toBeLessThan(44);
    expect(report.forceN[0]).toBeCloseTo(0, 10); expect(report.forceN[1]).toBeCloseTo(0, 10); expect(report.forceN[2]).toBeLessThan(0);
    expect(report.normalForceN).toBeGreaterThan(0); expect(report.normalForceN).toBeLessThanOrEqual(3);
    expect(report.normalForceN).toBeCloseTo(Math.min(3, report.requestedPenetrationMm * .180), 10);
    solver.moveToolTarget([-20, -20, 65]); advance(solver, .5);
    expect(solver.toolSnapshot()!.normalForceN).toBe(0);
  });
  it("has material-dependent localized compliance, not a renamed global pulse", () => {
    const soft = new WholeScenePhysics(organs, source(1500)), stiff = new WholeScenePhysics(organs, source(15000));
    // Remain below displacement/gradient saturation to measure material compliance.
    push(soft, 3); push(stiff, 3); advance(soft, 1); advance(stiff, 1);
    expect(Math.abs(soft.toolSnapshot()!.displacementMm[2]!)).toBeGreaterThan(Math.abs(stiff.toolSnapshot()!.displacementMm[2]!) * 1.35);
    expect(stiff.toolSnapshot()!.normalForceN).toBeGreaterThan(soft.toolSnapshot()!.normalForceN * 3);
    const near = soft.samplePoint([-15, -20, 45]), far = soft.samplePoint([110, 230, 45]);
    expect(Math.abs(near[2]! - 45)).toBeGreaterThan(Math.abs(far[2]! - 45) * 10);
    expect(Math.abs(near[2]! - 45)).toBeGreaterThan(.5);
    expect(soft.snapshot().organs.find(o => o.id === "stomach")!.displacement_mm.some(v => Math.abs(v) > 0)).toBe(true);
  });
  it("keeps neighboring tissues and identical attachment vertices in the same local field", () => {
    const solver = new WholeScenePhysics(organs, source()); push(solver); advance(solver, .4);
    const rest = new Float32Array([...anchor, -18, -20, 45, ...anchor]), out = new Float32Array(rest.length);
    solver.deform(rest, out, solver.bind(rest));
    expect(Array.from(out.slice(0, 3))).toEqual(Array.from(out.slice(6, 9)));
    expect(Math.abs(out[5]! - out[2]!)).toBeLessThan(.5);
    solver.samplePoint(anchor).forEach((v, i) => expect(v).toBeCloseTo(out[i]!, 4));
  });
  it("uses the rendered triangle barycentric anchor for coarse source meshes", () => {
    const solver = new WholeScenePhysics(organs, source());
    const vertices: [number[], number[], number[]] = [[-50, -50, 40], [50, -50, 40], [0, 50, 40]], barycentric = [.25, .25, .5];
    solver.beginToolContact({ mode: "grasp", organId: "stomach", restPointMm: [0, 0, 40], normal: [0, 0, 1], targetPointMm: [8, 0, 40], radiusMm: 6, attachment: { verticesMm: vertices, barycentric } });
    advance(solver, 1);
    const rest = new Float32Array(vertices.flat()), out = new Float32Array(9); solver.deform(rest, out, solver.bind(rest));
    const rendered = [0, 1, 2].map(a => barycentric.reduce((sum, w, i) => sum + w * out[i * 3 + a]!, 0));
    const report = solver.toolSnapshot()!;
    rendered.forEach((v, a) => expect(report.actualSurfacePointMm[a]).toBeCloseTo(v, 5));
    expect(rendered[0]).toBeGreaterThan(.05);
    expect(report.supportRadiusMm).toBeGreaterThan(140);
    // The nonlinear analytic center is deliberately NOT passed off as the displayed anchor.
    expect(Math.abs(solver.samplePoint([0, 0, 40])[0]! - rendered[0]!)).toBeGreaterThan(.01);
  });
  it("moves a persistent grasp target in either direction and recovers after release", () => {
    const solver = new WholeScenePhysics(organs, source());
    solver.beginToolContact({ mode: "grasp", organId: "liver", restPointMm: anchor, normal: [0, 0, 1], targetPointMm: [-10, -20, 45], radiusMm: 6 });
    advance(solver, .7); expect(solver.toolSnapshot()!.displacementMm[0]).toBeGreaterThan(1);
    solver.moveToolTarget([-30, -20, 45]); advance(solver, 1.5); expect(solver.toolSnapshot()!.displacementMm[0]).toBeLessThan(-1);
    solver.releaseToolContact(); expect(solver.toolSnapshot()!.forceN).toEqual([0, 0, 0]);
    advance(solver, 12); expect(Math.hypot(...solver.toolSnapshot()!.displacementMm)).toBeLessThan(.005);
  });
  it("slides pressure across nearby triangles without accumulating unbounded local modes", () => {
    const solver = new WholeScenePhysics(organs, source()); push(solver); advance(solver, .5);
    for (let i = 0; i < 30; i++) {
      const x = -20 + i * .5;
      solver.slideToolContact({ mode: "push", organId: "liver", restPointMm: [x, -20, 45], normal: [0, 0, 1], targetPointMm: [x, -20, 37], radiusMm: 6 }); advance(solver, .05);
    }
    expect(solver.snapshot().local_modes).toBe(1); expect(solver.toolSnapshot()!.restPointMm[0]).toBe(-5.5);
    expect(solver.toolSnapshot()!.displacementMm[2]).toBeLessThan(-.5);
  });
  it("bounds extreme targets, force and deformation while rejecting invalid anchors", () => {
    const solver = new WholeScenePhysics(organs, source(500)); push(solver, 1000);
    for (let i = 0; i < 50; i++) {
      solver.moveToolTarget([i % 2 ? 1e5 : -1e5, -20, -1e5]); advance(solver, .05);
      expect(solver.snapshot().finite).toBe(true); expect(solver.snapshot().displacement_gradient_bound).toBeLessThanOrEqual(.4500001);
      expect(Math.hypot(...solver.toolSnapshot()!.forceN)).toBeLessThanOrEqual(3.000001);
      expect(solver.toolSnapshot()!.normalForceN).toBeCloseTo(Math.min(3, solver.toolSnapshot()!.requestedPenetrationMm * .180), 9);
    }
    expect(solver.toolSnapshot()!.limitCount).toBeGreaterThan(0);
    expect(() => solver.moveToolTarget([NaN, 0, 0])).toThrow();
    expect(() => solver.beginToolContact({ mode: "grasp", organId: "skeleton", restPointMm: anchor, normal: [0, 0, 1], targetPointMm: anchor, radiusMm: 6 })).toThrow();
    solver.reset(); expect(solver.toolSnapshot()).toBeNull(); expect(solver.samplePoint(anchor)).toEqual(anchor);
  });
  it("reports local mode speed and retains explicit time-budget limits", () => {
    const solver = new WholeScenePhysics(organs, source()); push(solver, 4); solver.step(1 / 60, false);
    expect(solver.snapshot().maximum_local_mode_speed_m_s).toBeGreaterThan(0);
    expect(solver.snapshot().maximum_speed_m_s).toBeGreaterThanOrEqual(solver.snapshot().maximum_local_mode_speed_m_s);
    solver.step(.8, false); expect(solver.snapshot().dropped_time_s).toBeCloseTo(.7, 10);
  });
  for (const mode of ["push", "grasp"] as const) for (const frameTime of [.075, .1]) {
    it(`replays held and released ${mode} exactly at ${frameTime * 1000} ms render intervals`, () => {
      const batched = new WholeScenePhysics(organs, source()), fine = new WholeScenePhysics(organs, source());
      const vertices: [number[], number[], number[]] = [[-28, -28, 45], [-12, -28, 45], [-20, -12, 45]];
      for (const solver of [batched, fine]) solver.beginToolContact({
        mode, organId: "liver", restPointMm: anchor, normal: [0, 0, 1], radiusMm: 6,
        targetPointMm: mode === "push" ? [-20, -20, 41] : [-14, -18, 48],
        attachment: { verticesMm: vertices, barycentric: [.25, .25, .5] },
      });
      const replay = (duration: number) => {
        for (let frame = 0; frame < Math.round(duration / frameTime); frame++) {
          batched.step(frameTime, false);
          for (let substep = 0; substep < Math.round(frameTime * 120); substep++) fine.step(1 / 120, false);
          // Every fixed physical state, including memory-dependent force and
          // shared projected field, must be independent of render batching.
          expect(batched.toolSnapshot()).toEqual(fine.toolSnapshot());
          expect(batched.snapshot().organs).toEqual(fine.snapshot().organs);
          expect(batched.samplePoint([-15, -20, 45])).toEqual(fine.samplePoint([-15, -20, 45]));
          expect(batched.snapshot().time_s).toBe(fine.snapshot().time_s);
          expect(batched.snapshot().dropped_time_s).toBe(0);
          expect(batched.snapshot().finite).toBe(true);
          expect(batched.snapshot().displacement_gradient_bound).toBeLessThanOrEqual(.4500001);
          expect(Math.hypot(...batched.toolSnapshot()!.forceN)).toBeLessThanOrEqual(3.000001);
        }
      };
      replay(.9);
      const heldDisplacement = Math.hypot(...batched.toolSnapshot()!.displacementMm);
      expect(heldDisplacement).toBeGreaterThan(1);
      for (const solver of [batched, fine]) solver.releaseToolContact();
      replay(2.7);
      expect(batched.snapshot().time_s).toBeCloseTo(3.6, 10);
      expect(batched.toolSnapshot()!.forceN).toEqual([0, 0, 0]);
      expect(Math.hypot(...batched.toolSnapshot()!.displacementMm)).toBeLessThan(heldDisplacement * .02);
    });
  }
  it("admits only 100 ms of a 500 ms stall with the same bounded local solve", () => {
    const stalled = new WholeScenePhysics(organs, source(500)), fine = new WholeScenePhysics(organs, source(500));
    for (const solver of [stalled, fine]) push(solver, 1000);
    stalled.step(.5, false);
    for (let substep = 0; substep < 12; substep++) fine.step(1 / 120, false);
    expect(stalled.snapshot().time_s).toBeCloseTo(.1, 12);
    expect(stalled.snapshot().dropped_time_s).toBeCloseTo(.4, 12);
    expect(stalled.toolSnapshot()).toEqual(fine.toolSnapshot());
    expect(stalled.snapshot().organs).toEqual(fine.snapshot().organs);
    expect(stalled.snapshot().finite).toBe(true);
    expect(stalled.snapshot().displacement_gradient_bound).toBeLessThanOrEqual(.4500001);
    expect(Math.hypot(...stalled.toolSnapshot()!.forceN)).toBeLessThanOrEqual(3.000001);
    expect(stalled.toolSnapshot()!.limitCount).toBeGreaterThan(0);
  });
});
