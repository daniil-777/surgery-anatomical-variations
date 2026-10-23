import { describe, expect, it } from "vitest";
import { closestPointOnRunoffAttached, distanceToRunoffAttached, runoffGrowingAttachedContactTime, runoffSphereContactTime } from "./runoffContact";
import { LiverRunoffExperiment, runoffAttachedGeometry } from "./runoff";
import type { VesselVector } from "../experiments/vesselSolver";
import type { LiverDrainageEvent } from "./types";
import type { JetCollisionQuery } from "../experiments/jetCollision";

const near = (a: number, b: number, tolerance = 1e-12) => expect(Math.abs(a - b)).toBeLessThan(tolerance);
const body = (originM: VesselVector, initialVelocityMS: VesselVector, radiusM = .0002) =>
  ({ originM, initialVelocityMS, radiusM, birthTimeSeconds: 0 });
const free: JetCollisionQuery = { contact: () => undefined };

describe("independent continuous runoff contact geometry", () => {
  it("matches axial, radial and diagonal finite-cylinder distances", () => {
    const a = .001, L = .002, shape = runoffAttachedGeometry([0, 0, 0], [0, 1, 0], Math.PI * a * a * L, a, L);
    near(distanceToRunoffAttached(shape, [0, L / 2, 0]), 0);
    near(distanceToRunoffAttached(shape, [0, -.003, 0]), .003);
    near(distanceToRunoffAttached(shape, [.004, L / 2, 0]), .003);
    near(distanceToRunoffAttached(shape, [.004, L + .004, 0]), .005);
  });
  it("projects below-base exterior points onto the overhanging major cap, continuously across its plane", () => {
    const a = .001, h = .003, L = .0005;
    const volume = Math.PI * a * a * L + Math.PI * h * (3 * a * a + h * h) / 6;
    const shape = runoffAttachedGeometry([0, 0, 0], [0, 1, 0], volume, a, L);
    const centre = 4 / 3000, radius = 5 / 3000, point: VesselVector = [.002, .0004, 0];
    const length = Math.hypot(point[0], point[1] - L - centre);
    const expected: VesselVector = [point[0] * radius / length,
      L + centre + (point[1] - L - centre) * radius / length, 0];
    expect(expected[1]).toBeGreaterThan(L);
    near(distanceToRunoffAttached(shape, point), length - radius);
    const projected = closestPointOnRunoffAttached(shape, point);
    projected.forEach((x, k) => near(x, expected[k]!));
    near(Math.hypot(...point.map((x, k) => x - projected[k]!)), distanceToRunoffAttached(shape, point));
    for (const y of [L - 1e-10, L, L + 1e-10]) {
      const p: VesselVector = [.002, y, 0], cp = closestPointOnRunoffAttached(shape, p);
      near(Math.hypot(...p.map((x, k) => x - cp[k]!)), distanceToRunoffAttached(shape, p));
      expect(Math.abs(distanceToRunoffAttached(shape, p) - distanceToRunoffAttached(shape, [.002, L, 0])))
        .toBeLessThanOrEqual(Math.abs(y - L) + 1e-15);
    }
  });
  it("finds a passage whose two endpoints are both separated from the static solid", () => {
    const a = .001, volume = Math.PI * a * a * .0005;
    const drop = body([-.003, .00025, 0], [3, 0, 0]);
    const t = runoffGrowingAttachedContactTime(drop, { positionM: [0, 0, 0], normal: [0, 1, 0] },
      volume, 0, 0, .002, a, .0005, [0, 0, 0]);
    near(t!, (.003 - a - drop.radiusM) / 3, 1e-10);
  });
  it("finds the analytic first touch of a continuously growing neck, without future-volume contact", () => {
    const a = .001, speed = 1, drop = body([0, .0015, 0], [0, 0, 0]);
    const t = runoffGrowingAttachedContactTime(drop, { positionM: [0, 0, 0], normal: [0, 1, 0] },
      0, Math.PI * a * a * speed, 0, .002, a, .002, [0, 0, 0]);
    near(t!, (.0015 - drop.radiusM) / speed, 2e-10);
  });
  it("uses the exact relative quadratic for colliding or separating gravitational spheres", () => {
    const a = body([-.01, .03, 0], [1, 0, 0], .001), b = body([.01, .03, 0], [-1, 0, 0], .001);
    near(runoffSphereContactTime(a, b, [0, -9.81, 0], 0, .02)!, .009);
    expect(runoffSphereContactTime({ ...a, initialVelocityMS: [-1, 0, 0] }, b,
      [0, -9.81, 0], 0, .02)).toBeUndefined();
  });
});

describe("conservative instantaneous aggregate closure", () => {
  const support = (p: VesselVector) => ({ positionM: [p[0] < .004 ? .003 : .005, .03, .002] as VesselVector,
    normal: [0, -1, 0] as VesselVector });
  const nearest = (p: VesselVector) => ({ positionM: [p[0], .03, p[2]] as VesselVector, normal: [0, -1, 0] as VesselVector });
  const source = (id: number, x: number, volumeM3: number, time: number): LiverDrainageEvent => ({
    id, sourceVertex: id, stepIndex: 1, startTimeSeconds: time, endTimeSeconds: time,
    positionM: [x, .03, .001], normal: [0, -1, 0], volumeM3,
  });
  it("conserves volume, centre of mass and linear momentum and reports inelastic loss", () => {
    const f = new LiverRunoffExperiment({ attachedContactModel: "aggregate", collectionPlaneYM: 0, neckLengthM: .002 }, support, nearest), V = f.criticalVolumeM3;
    const s = f.step({ timeSeconds: .002, drainageEvents: [source(0, .001, V, 0), source(1, .005, V, .002)],
      collision: free, collectorMaximumYM: 0 });
    expect(s.droplets).toHaveLength(1); expect(s.attached).toHaveLength(0); expect(s.telemetry.coalescenceEvents).toBe(1);
    const d = s.droplets[0]!, origin = runoffAttachedGeometry([.003, .03, .002], [0, -1, 0], V, .001, .002);
    near(d.volumeM3, 2 * V); near(d.positionM[0], .004);
    near(d.positionM[1], origin.centreOfMassM[1] - .25 * 9.81 * .002 ** 2);
    near(d.velocityMS[1], -9.81 * .002 / 2);
    near(s.telemetry.coalescenceKineticEnergyRemovedJ, .25 * 1060 * V * (9.81 * .002) ** 2, 1e-18);
    expect(s.telemetry.coalescenceFreeSurfaceEnergyChangeJ).toBeLessThan(0); near(s.volumeErrorM3, 0, 1e-20);
  });
  it("transfers the entire stationary attached donor, keeping its fixed support for later refill", () => {
    const f = new LiverRunoffExperiment({ attachedContactModel: "aggregate", collectionPlaneYM: 0, neckLengthM: .002 }, support, nearest), V = f.criticalVolumeM3, attached = V / 2;
    const s = f.step({ timeSeconds: .002, drainageEvents: [source(0, .001, V, 0), source(1, .005, attached, 0)],
      collision: free, collectorMaximumYM: 0 });
    expect(s.droplets).toHaveLength(1); expect(s.attached).toHaveLength(0); expect(s.telemetry.physicalSupportCount).toBe(2);
    const a = runoffAttachedGeometry([.003, .03, .002], [0, -1, 0], V, .001, .002);
    const b = runoffAttachedGeometry([.005, .03, .002], [0, -1, 0], attached, .001, .002);
    const expected = a.centreOfMassM.map((x, k) => (V * x + attached * b.centreOfMassM[k]!) / (V + attached));
    near(s.droplets[0]!.positionM[0], expected[0]!);
    near(s.droplets[0]!.positionM[1], expected[1]! - .5 * 9.81 * .002 ** 2);
    near(s.droplets[0]!.volumeM3, V + attached); near(s.volumeErrorM3, 0, 1e-20);
  });
  it("rejects an aggregate that cannot clear the organ and restores the accepted inventory", () => {
    const f = new LiverRunoffExperiment({ attachedContactModel: "aggregate", collectionPlaneYM: 0, neckLengthM: .002 }, support, nearest), V = f.criticalVolumeM3;
    const r = Math.cbrt(3 * V / (4 * Math.PI));
    const collision: JetCollisionQuery = { contact: (p, _v, _g, birth, _start, _end, radius) =>
      radius > r * 1.1 ? { timeSeconds: birth, positionM: p, surface: { triangle: 0, barycentric: [1, 0, 0] } } : undefined };
    const before = f.snapshot();
    expect(() => f.step({ timeSeconds: .002, drainageEvents: [source(0, .001, V, 0), source(1, .005, V, .002)],
      collision, collectorMaximumYM: 0 })).toThrow(/aggregate shape is unresolved/);
    expect(f.snapshot()).toEqual(before);
  });
  it("keeps collision COM, momentum and inventory invariant under fixed-step and source-packet splitting", () => {
    const run = (dt: number, packets: number) => {
      const f = new LiverRunoffExperiment({ attachedContactModel: "aggregate", collectionPlaneYM: 0, neckLengthM: .002, fixedDtSeconds: dt }, support, nearest);
      const V = f.criticalVolumeM3; let id = 0;
      for (let i = 0; i < Math.round(.002 / dt); i++) {
        const events: LiverDrainageEvent[] = [];
        if (i === 0) for (let j = 0; j < packets; j++) events.push(source(id++, .001, V / packets, 0));
        if (i === Math.round(.002 / dt) - 1)
          for (let j = 0; j < packets; j++) events.push(source(id++, .005, V / packets, .002));
        f.step({ timeSeconds: (i + 1) * dt, drainageEvents: events, collision: free, collectorMaximumYM: 0 });
      }
      return f.snapshot();
    };
    const reference = run(.002, 1);
    for (const candidate of [run(.001, 7), run(.0005, 3)]) {
      expect(candidate.droplets).toHaveLength(1);
      near(candidate.droplets[0]!.volumeM3, reference.droplets[0]!.volumeM3, 1e-20);
      candidate.droplets[0]!.positionM.forEach((v, k) => near(v, reference.droplets[0]!.positionM[k]!, 1e-12));
      candidate.droplets[0]!.velocityMS.forEach((v, k) => near(v, reference.droplets[0]!.velocityMS[k]!, 1e-12));
      near(candidate.telemetry.coalescenceKineticEnergyRemovedJ, reference.telemetry.coalescenceKineticEnergyRemovedJ, 1e-18);
    }
  });
  it("rejects unresolved rapid repeated contact without committing partial events or inventory", () => {
    const f = new LiverRunoffExperiment({ attachedContactModel: "aggregate", collectionPlaneYM: 0 }, support, nearest);
    const before = f.snapshot(), e = { ...source(0, .001, 2 * f.criticalVolumeM3, 0), endTimeSeconds: .002 };
    expect(() => f.step({ timeSeconds: .002, drainageEvents: [e], collision: free, collectorMaximumYM: 0 }))
      .toThrow(/contact.*budget|contact.*unresolved|aggregate shape is unresolved/);
    expect(f.snapshot()).toEqual(before);
  });
});
