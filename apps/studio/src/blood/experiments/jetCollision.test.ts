import { describe, expect, it } from "vitest";
import { JetCollectorCollision, type JetCollectorSurface } from "./jetCollision";
import { JetBreakupExperiment, type JetBreakupConfig } from "./jetBreakup";
import type { VesselEmission } from "./vesselSolver";
import { tankSurfaceData } from "./geometry";

const surface = (height = .0015, timeSeconds = 0): JetCollectorSurface => ({ timeSeconds, nx: 4, nz: 4,
  widthM: .004, depthM: .004, originXM: -.002, originZM: -.002, heightM: new Float64Array(16).fill(height) });
const near = (a: number, b: number, tolerance = 1e-12) => expect(Math.abs(a - b)).toBeLessThan(tolerance);
const config = (overrides: Partial<JetBreakupConfig> = {}): JetBreakupConfig => ({ densityKgM3: 1060,
  viscosityPaS: .00345, surfaceTensionNM: .055, initialRelativeAmplitude: .01, minimumWeber: 4,
  fixedDtSeconds: .002, gravityMS2: [0, -9.81, 0], collectionPlaneYM: 0, maxElements: 8192, ...overrides });
const emitted = (step: number, height = .02): VesselEmission => {
  const volumeM3 = Math.PI * .0004 ** 2 * 3 * .002;
  return { id: step, runId: 0, holeId: "test", runVolumeStartM3: step * volumeM3, originM: [0, height, 0],
    initialVelocityMS: [0, 0, 3], radiusM: .0004, volumeM3, emissionTimeSeconds: (step + .5) * .002, durationSeconds: .002 };
};
const tray = (timeSeconds: number, height = .0015): JetCollectorSurface => ({ ...surface(height, timeSeconds),
  nx: 8, nz: 8, widthM: .16, depthM: .2, originXM: -.08, originZM: -.1, heightM: new Float64Array(64).fill(height) });

describe("continuous contact with the previous accepted collector graph", () => {
  it("matches the independent raised-flat quadratic impact time for point and finite vertical support", () => {
    const graph = new JetCollectorCollision(surface(), 0, .02);
    const expected = (Math.sqrt(.1 ** 2 + 2 * 9.81 * .0001) - .1) / 9.81;
    for (const radius of [0, .0003]) {
      const hit = graph.contact([0, .0216 + radius, 0], [0, -.1, 0], [0, -9.81, 0], 0, 0, .002, radius)!;
      near(hit.timeSeconds, expected); near(hit.positionM[1], .0215);
      expect(hit.timeSeconds).toBeLessThan(.002);
    }
  });
  it("hits a local hill even when both step endpoint clearances are positive", () => {
    const field = surface(0);
    field.heightM = Float64Array.from({ length: 16 }, (_, i) => i % 4 === 1 || i % 4 === 2 ? .002 : 0);
    const graph = new JetCollectorCollision(field, 0, 0);
    expect(graph.heightAt(-.002, 0)).toBe(0); expect(graph.heightAt(.002, 0)).toBe(0);
    const hit = graph.contact([-.002, .0015, 0], [2, 0, 0], [0, 0, 0], 0, 0, .002, 0)!;
    near(hit.timeSeconds, .00075); near(hit.positionM[0], -.0005); near(hit.positionM[1], .0015);
  });
  it("matches a sloped-plane analytic intersection inside the nonuniform triangle fan", () => {
    const field = { ...surface(0), originXM: 0, originZM: 0 };
    field.heightM = Float64Array.from({ length: 16 }, (_, i) => .0005 + .2 * ((i % 4 + .5) * .001));
    const graph = new JetCollectorCollision(field, 0, 0);
    const expected = (.0008 - (.0005 + .2 * .0011)) / (.1 + .2 * .2);
    const hit = graph.contact([.0011, .0008, .002], [.2, -.1, 0], [0, 0, 0], 0, 0, .002, 0)!;
    near(hit.timeSeconds, expected); near(hit.positionM[0], .0011 + .2 * expected);
    near(hit.positionM[1], .0008 - .1 * expected);
  });
  it("matches the renderer's actual four-triangle graph across every cell of an asymmetric field", () => {
    const field = surface();
    field.heightM = Float64Array.from({ length: 16 }, (_, i) => .0001 + .00003 * ((i * 7 + i * i) % 19));
    const graph = new JetCollectorCollision(field, 0, 0);
    const mesh = tankSurfaceData({ ...field, heightM: .01 }, field.heightM, undefined, .98, [.2, .2, .2], true);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const point = [0, 0, 0];
      for (let j = 0; j < 3; j++) for (let axis = 0; axis < 3; axis++)
        point[axis]! += mesh.positions[mesh.indices[i + j]! * 3 + axis]! * [.2, .3, .5][j]! / 1000;
      near(graph.heightAt(point[0]!, point[2]!), point[1]!, 1e-10);
    }
  });
  it("uses the base plane outside the tray and absorbs a lateral entry below raised film at the domain edge", () => {
    const graph = new JetCollectorCollision(surface(), 0, 0);
    const outside = graph.contact([.01, .0001, 0], [0, -.1, 0], [0, 0, 0], 0, 0, .002, 0)!;
    near(outside.timeSeconds, .001); expect(outside.positionM).toEqual([.01, 0, 0]);
    const edge = graph.contact([-.003, .001, 0], [1, 0, 0], [0, 0, 0], 0, 0, .002, 0)!;
    near(edge.timeSeconds, .001); near(edge.positionM[0], -.002); near(edge.positionM[1], .0015);
  });
  it("absorbs material overtaken by a raised surface at the current interval start, never retroactively", () => {
    const graph = new JetCollectorCollision(surface(.002, .1), .1, 0);
    const hit = graph.contact([0, .0015, 0], [0, 0, 0], [0, 0, 0], 0, .1, .102, .0001)!;
    expect(hit.timeSeconds).toBe(.1); expect(hit.positionM[1]).toBe(.002);
    const newborn = graph.contact([0, .0021, 0], [0, 0, 0], [0, 0, 0], .101, .1, .102, .0002)!;
    expect(newborn.timeSeconds).toBe(.101);
  });
  it("copies the accepted field, rejects stale/invalid fields and bounds traversal work", () => {
    const field = surface(), before = Array.from(field.heightM), graph = new JetCollectorCollision(field, 0, 0);
    expect(Array.from(field.heightM)).toEqual(before);
    (field.heightM as Float64Array).fill(.002);
    near(graph.heightAt(0, 0), .0015);
    expect(() => new JetCollectorCollision(surface(.0015, .1), 0, 0)).toThrow();
    const invalid = surface(); (invalid.heightM as Float64Array)[3] = NaN;
    expect(() => new JetCollectorCollision(invalid, 0, 0)).toThrow();
    const big = new JetCollectorCollision({ ...surface(.002), nx: 256, nz: 256, heightM: new Float64Array(256 ** 2).fill(.002) }, 0, 0);
    // Start outside, enter below the raised graph; diagonal broad phase is
    // deliberately bounded rather than blocking a frame on pathological input.
    expect(() => big.contact([-.003, .001, -.003], [3, 0, 3], [0, 0, 0], 0, 0, .002, 0)).toThrow(/4096/);
  });
});

describe("height-aware authoritative breakup integration", () => {
  it("lands detached drops and portions on raised film once, preserving every emitted volume", () => {
    const solver = new JetBreakupExperiment(config()), fixed = new JetBreakupExperiment(config());
    const ids = new Set<number>(); let landed = 0, raisedFirst = Infinity, fixedFirst = Infinity, drops = 0;
    for (let i = 0; i < 180; i++) {
      const emissions = i < 50 ? [emitted(i)] : [], timeSeconds = (i + 1) * .002;
      const frame = solver.step({ timeSeconds, emissions,
        collectorSurface: { ...tray(i * .002), depthM: .8, originZM: -.4 } });
      const base = fixed.step({ timeSeconds, emissions });
      for (const event of frame.landingEvents) {
        expect(ids.has(event.id)).toBe(false); ids.add(event.id); landed += event.volumeM3;
        expect(event.timeSeconds).toBeGreaterThanOrEqual(i * .002 - 1e-12);
        expect(event.timeSeconds).toBeLessThanOrEqual(timeSeconds);
        near(event.positionM[1], .0015); raisedFirst = Math.min(raisedFirst, event.timeSeconds);
        if (event.supportRadiusM > 0) drops++;
      }
      for (const event of base.landingEvents) fixedFirst = Math.min(fixedFirst, event.timeSeconds);
      near(frame.emittedVolumeM3, frame.inFlightVolumeM3 + frame.landedVolumeM3, 1e-18);
    }
    expect(drops).toBeGreaterThan(0); expect(raisedFirst).toBeLessThan(fixedFirst);
    near(landed, solver.snapshot().emittedVolumeM3, 1e-18); expect(solver.snapshot().inFlightVolumeM3).toBe(0);
  });
  it("handles a freshly pinched sphere intersecting the film immediately without landing its former portions again", () => {
    const solver = new JetBreakupExperiment(config({ gravityMS2: [0, 0, 0] }));
    let immediate = 0, landed = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const s = solver.step({ timeSeconds: (i + 1) * .002, emissions: [emitted(i, .0025)], collectorSurface: tray(i * .002, .002) });
      for (const event of s.landingEvents) {
        expect(seen.has(event.id)).toBe(false); seen.add(event.id); landed += event.volumeM3;
        const pinch = s.pinchEvents.find(p => p.id === event.id);
        if (pinch) { expect(event.timeSeconds).toBe(pinch.timeSeconds); expect(event.volumeM3).toBe(pinch.volumeM3); immediate++; }
      }
      near(landed + s.inFlightVolumeM3, s.emittedVolumeM3, 1e-18);
    }
    expect(immediate).toBeGreaterThan(0);
  });
  it("rolls back malformed surface input and keeps checkpoints and input arrays independent", () => {
    const solver = new JetBreakupExperiment(config());
    solver.step({ timeSeconds: .002, emissions: [emitted(0)], collectorSurface: tray(0) });
    const saved = solver.snapshot(), checkpoint = solver.checkpoint(), bad = tray(.002);
    (bad.heightM as Float64Array)[0] = NaN;
    expect(() => solver.step({ timeSeconds: .004, emissions: [emitted(1)], collectorSurface: bad })).toThrow();
    expect(solver.snapshot()).toEqual(saved);
    const good = tray(.002), original = Array.from(good.heightM);
    solver.step({ timeSeconds: .004, emissions: [emitted(1)], collectorSurface: good });
    expect(Array.from(good.heightM)).toEqual(original);
    solver.restore(checkpoint); expect(solver.snapshot()).toEqual(saved);
  });
});
