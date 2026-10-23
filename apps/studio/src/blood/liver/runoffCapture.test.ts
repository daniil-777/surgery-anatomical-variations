import { describe, expect, it } from "vitest";
import { LiverRunoffExperiment, runoffAttachedGeometry } from "./runoff";
import { distanceToRunoffAttached } from "./runoffContact";
import type { VesselVector } from "../experiments/vesselSolver";
import type { LiverDrainageEvent, LiverVec3 } from "./types";
import type { JetCollisionQuery } from "../experiments/jetCollision";
const near = (a: number, b: number, tolerance = 1e-18) => expect(Math.abs(a - b)).toBeLessThan(tolerance);
const free: JetCollisionQuery = { contact: () => undefined };
const support = (p: VesselVector) => ({ positionM: [p[0] < .004 ? .003 : .005, .03, .002] as VesselVector,
  normal: [0, -1, 0] as VesselVector, surface: { triangle: p[0] < .004 ? 0 : 1, barycentric: [1, 0, 0] as VesselVector } });
const nearest = (p: VesselVector) => ({ positionM: [p[0], .03, p[2]] as VesselVector, normal: [0, -1, 0] as VesselVector });
const source = (id: number, x: number, volumeM3: number, start: number, end = start): LiverDrainageEvent => ({
  id, sourceVertex: id, stepIndex: 1, startTimeSeconds: start, endTimeSeconds: end,
  positionM: [x, .03, .001], normal: [0, -1, 0], volumeM3,
});

describe("explicit absorbing wet-support contact", () => {
  it("applies an explicit axial-domain cosine to both source and actual support without changing inventory", () => {
    const c = .8, oblique: VesselVector = [.8, -.6, 0];
    const f = new LiverRunoffExperiment({ collectionPlaneYM: 0, neckLengthM: .002, minimumGravityAlignment: c }, support, nearest);
    const before = f.snapshot(), eligible = f.createDrainageEligibilityEvaluator();
    expect(eligible([.001, .03, .001], [0, -1, 0]).eligible).toBe(true);
    expect(eligible([.001, .03, .001], oblique)).toMatchObject({ eligible: false, reason: expect.stringContaining("source lies outside") });
    const wrongAnchor = f.createDrainageEligibilityEvaluator({ resolveSupport: p => ({ ...support(p), normal: oblique }) });
    expect(wrongAnchor([.001, .03, .001], [0, -1, 0])).toMatchObject({ eligible: false,
      reason: expect.stringContaining("support lies outside") });
    expect(f.snapshot()).toEqual(before);
    expect(() => f.step({ timeSeconds: .002, drainageEvents: [{ ...source(0, .001, 1e-9, 0), normal: [...oblique] }],
      collision: free, collectorMaximumYM: 0 })).toThrow(/source lies outside/);
    expect(f.snapshot()).toEqual(before);
    for (const bound of [NaN, -1, 1.01]) expect(() => new LiverRunoffExperiment({ minimumGravityAlignment: bound }, support, nearest))
      .toThrow(/Invalid runoff/);
  });
  it("captures only the incoming free volume at interior contact while preserving all concurrent donor fill", () => {
    const f = new LiverRunoffExperiment({ collectionPlaneYM: 0, neckLengthM: .002 }, support, nearest), V = f.criticalVolumeM3;
    const s = f.step({ timeSeconds: .002, drainageEvents: [source(0, .001, V, 0), source(1, .005, V / 2, 0, .002)],
      collision: free, collectorMaximumYM: 0 });
    expect(s.telemetry.wetCaptureCount).toBe(1); expect(s.droplets).toHaveLength(0); expect(s.attached).toHaveLength(1);
    const e = s.contacts[0]!;
    expect(e.timeSeconds).toBeGreaterThan(0); expect(e.timeSeconds).toBeLessThan(.002);
    near(s.attachedVolumeM3, V / 2); near(e.volumeM3, V); near(s.organReturnedVolumeM3, V);
    expect(e.surface).toEqual({ triangle: 1, barycentric: [1, 0, 0] }); expect(e.velocityMS).toEqual([0, 0, 0]);
    expect(e.positionM).toEqual([.005, .03, .002]); expect(e.wetCapture).toBeTruthy();
    const donorAtContact = runoffAttachedGeometry([.005, .03, .002], [0, -1, 0], V / 2 * e.timeSeconds / .002, .001, .002);
    near(distanceToRunoffAttached(donorAtContact, e.wetCapture!.contactPositionM), 0, 1e-12);
    const r = Math.cbrt(3 * V / (4 * Math.PI));
    near(Math.hypot(...e.wetCapture!.sourceCentreM.map((x, k) => x - e.wetCapture!.contactPositionM[k]!)), r, 2e-10);
    const velocity = -9.81 * e.timeSeconds, mass = 1060 * V;
    near(s.telemetry.wetCaptureKineticEnergyRemovedJ, .5 * mass * velocity ** 2);
    near(s.telemetry.wetCaptureMomentumRemovedKgMS[1], mass * velocity);
    near(s.telemetry.wetCapturePotentialEnergyChangeJ, mass * 9.81 * (.03 - e.wetCapture!.sourceCentreM[1]));
    near(s.volumeErrorM3, 0); expect(s.telemetry.coalescenceEvents).toBe(0);
    const next = f.step({ timeSeconds: .004, drainageEvents: [], collision: free, collectorMaximumYM: 0 });
    expect(next.contacts).toHaveLength(0); near(next.attachedVolumeM3, V / 2); expect(next.telemetry.wetCaptureCount).toBe(1);
  });
  it("routes an entire free component to a wet support when only the relaxed sphere reaches it", () => {
    const resolve = (p: VesselVector) => ({ positionM: (p[2] > .004 ? [.00475, .03, .0025]
      : p[0] < .004 ? [.003, .03, .002] : [.0065, .03, .002]) as VesselVector,
      normal: [0, -1, 0] as VesselVector, surface: { triangle: p[2] > .004 ? 2 : p[0] < .004 ? 0 : 1,
        barycentric: [1, 0, 0] as VesselVector } });
    const f = new LiverRunoffExperiment({ collectionPlaneYM: 0, neckLengthM: .002 }, resolve, nearest), V = f.criticalVolumeM3;
    const donor = Math.PI * .001 ** 2 * .0012;
    const input = { timeSeconds: .002, drainageEvents: [source(0, .001, V, 0), source(1, .005, V, 0),
      { ...source(2, .005, donor, 0), positionM: [.005, .03, .005] as LiverVec3 }], collision: free, collectorMaximumYM: 0 };
    const before = f.snapshot(), checkpoint = f.checkpoint(), s = f.step(input);
    expect(s.contacts).toHaveLength(2); expect(s.droplets).toHaveLength(0); expect(s.attached).toHaveLength(1);
    expect(s.telemetry.aggregateRelaxationCaptureCount).toBe(2); near(s.telemetry.aggregateRelaxationCaptureVolumeM3, 2 * V);
    near(s.attachedVolumeM3, donor); near(s.organReturnedVolumeM3, 2 * V); near(s.volumeErrorM3, 0);
    expect(s.telemetry.coalescenceEvents).toBe(0); near(s.telemetry.coalescenceKineticEnergyRemovedJ, 0);
    const attached = s.attached[0]!, radius = Math.cbrt(3 * V / (4 * Math.PI));
    for (const e of s.contacts) {
      expect(e.wetCapture!.model).toBe("aggregate-relaxation"); expect(e.surface!.triangle).toBe(2);
      expect(distanceToRunoffAttached(attached, e.wetCapture!.sourceCentreM)).toBeGreaterThan(radius);
      expect(e.velocityMS).toEqual([0, 0, 0]); near(e.volumeM3, V); near(e.timeSeconds, 0);
    }
    f.restore(checkpoint); expect(f.snapshot()).toEqual(before); expect(f.step(input)).toEqual(s);
  });
  it("rejects a malformed canonical capture destination and rolls back all donors, IDs, and work counters", () => {
    const invalid = (p: VesselVector) => ({ ...support(p), surface: { triangle: 1, barycentric: [2, -1, 0] as VesselVector } });
    const f = new LiverRunoffExperiment({ collectionPlaneYM: 0, neckLengthM: .002 }, invalid, nearest), V = f.criticalVolumeM3;
    const before = f.snapshot();
    expect(() => f.step({ timeSeconds: .002, drainageEvents: [source(0, .001, V, 0), source(1, .005, V / 2, 0, .002)],
      collision: free, collectorMaximumYM: 0 })).toThrow(/invalid canonical film destination/);
    expect(f.snapshot()).toEqual(before);
  });
  it("rejects finite-source zero-time self-recapture at every tested timestep, without a cooldown or inventory loss", () => {
    for (const dt of [.002, .001, .0005]) {
      const f = new LiverRunoffExperiment({ collectionPlaneYM: 0, neckLengthM: .002, fixedDtSeconds: dt }, support, nearest);
      const V = f.criticalVolumeM3;
      const first = f.step({ timeSeconds: dt, drainageEvents: [source(0, .001, V, 0), source(1, .005, V / 2, 0, dt)],
        collision: free, collectorMaximumYM: 0 });
      expect(first.telemetry.wetCaptureCount).toBe(1);
      // No new external supply: the already captured mass alone returns from
      // film at the next accepted boundary, as in the coordinator protocol.
      const returned = source(2, .005, first.organReturnedVolumeM3, dt);
      expect(() => f.step({ timeSeconds: 2 * dt, drainageEvents: [returned], collision: free, collectorMaximumYM: 0 }))
        .toThrow(/zero-time self-recapture/);
      expect(f.snapshot()).toEqual(first);
      near(first.attachedVolumeM3 + first.inFlightVolumeM3 + first.organReturnedVolumeM3, 1.5 * V);
      expect(first.telemetry.wetCaptureCount).toBe(1);
    }
  });
  it("restores capture IDs, cloned metadata and counters on checkpoint retry", () => {
    const f = new LiverRunoffExperiment({ collectionPlaneYM: 0, neckLengthM: .002 }, support, nearest), V = f.criticalVolumeM3;
    const before = f.snapshot(), checkpoint = f.checkpoint();
    const input = { timeSeconds: .002, drainageEvents: [source(0, .001, V, 0), source(1, .005, V / 2, 0, .002)],
      collision: free, collectorMaximumYM: 0 };
    const accepted = f.step(input); f.restore(checkpoint); expect(f.snapshot()).toEqual(before);
    expect(f.step(input)).toEqual(accepted);
    const copy = f.snapshot(); (copy.contacts[0]!.wetCapture!.destinationM as unknown as number[])[0] = 99;
    expect(f.snapshot()).toEqual(accepted);
  });
});
