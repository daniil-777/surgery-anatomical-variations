import { describe, expect, it } from "vitest";
import { LiverRunoffExperiment, RunoffUnsupportedSupportError, runoffAttachedGeometry, type LiverRunoffConfig } from "./runoff";
import { LiverSurfaceFlow } from "./surfaceFlow";
import { JetCollectorCollision, type JetCollisionQuery } from "../experiments/jetCollision";
import type { LiverDrainageEvent, LiverSurface } from "./types";
import type { VesselLandingEvent, VesselVector } from "../experiments/vesselSolver";

const near = (a: number, b: number, tolerance = 1e-14) => expect(Math.abs(a - b)).toBeLessThan(tolerance);
const flatSupport = (p: VesselVector) => ({ positionM: [p[0], .03, p[2]] as VesselVector, normal: [0, -1, 0] as VesselVector,
  surface: { triangle: 0, barycentric: [1, 0, 0] as VesselVector } });
const free: JetCollisionQuery = { contact: () => undefined };
const event = (id: number, volumeM3: number, startTimeSeconds = 0, endTimeSeconds = .002): LiverDrainageEvent =>
  ({ id, sourceVertex: 0, stepIndex: Math.floor(endTimeSeconds / .002), startTimeSeconds, endTimeSeconds,
    volumeM3, positionM: [.001, .03, .001], normal: [0, -1, 0] });
const config = (extra: Partial<LiverRunoffConfig> = {}) => ({ collectionPlaneYM: 0, ...extra });
const floor = (timeSeconds: number, height = 0) => new JetCollectorCollision({
  timeSeconds, nx: 8, nz: 8, widthM: .2, depthM: .2, originXM: -.1, originZM: -.1,
  heightM: new Float64Array(64).fill(height),
}, timeSeconds, 0);

describe("explicit physical-support runoff geometry", () => {
  it("matches independently integrated cylinder/cap volume and first moment from tiny to release inventory", () => {
    for (const volume of [0, 1e-22, 1e-15, 1e-10, Math.PI * .001 ** 2 * .0005, 1e-8, 3.3e-8]) {
      const s = runoffAttachedGeometry([.2, .3, .4], [0, -2, 0], volume, .001, .0005);
      const a = .001, L = s.neckLengthM, h = s.capHeightM;
      const cylinder = Math.PI * a ** 2 * L, cap = Math.PI * h * (3 * a ** 2 + h ** 2) / 6;
      near(cylinder + cap, volume, 1e-22);
      // Integrate π(a²+2cz−z²) and its first moment without the production centroid formula.
      const c = h > 0 ? (h * h - a * a) / (2 * h) : 0;
      const capMoment = Math.PI * (a * a * h * h / 2 + 2 * c * h ** 3 / 3 - h ** 4 / 4);
      const moment = cylinder * L / 2 + cap * L + capMoment;
      if (volume > 0) near(s.centreOfMassM[1], .3 - moment / volume, 2e-16);
      expect(s.neckLengthM).toBeGreaterThanOrEqual(0); expect(s.capHeightM).toBeGreaterThanOrEqual(0);
    }
  });
  it("uses surface tension, physical contact perimeter and gravity rather than mesh/packet volume", () => {
    const a = new LiverRunoffExperiment(config(), flatSupport);
    near(a.criticalVolumeM3, 2 * Math.PI * .001 * .055 / (1060 * 9.81), 1e-22);
    const b = new LiverRunoffExperiment(config({ surfaceTensionNM: .11 }), flatSupport);
    near(b.criticalVolumeM3, 2 * a.criticalVolumeM3, 1e-22);
    const g = new LiverRunoffExperiment(config({ gravityMS2: [0, -4.905, 0] }), flatSupport);
    near(g.criticalVolumeM3, 2 * a.criticalVolumeM3, 1e-22);
    expect(() => new LiverRunoffExperiment(config({ neckLengthM: 0 }), flatSupport)).toThrow(/centre of mass/);
  });
  it("releases at the preserved combined centre of mass, with zero launch momentum and exact volume", () => {
    const f = new LiverRunoffExperiment(config(), flatSupport), V = f.criticalVolumeM3;
    const s = f.step({ timeSeconds: .002, drainageEvents: [event(0, V)], collision: free, collectorMaximumYM: 0 });
    expect(s.attached).toHaveLength(0); expect(s.droplets).toHaveLength(1);
    const d = s.droplets[0]!, expected = runoffAttachedGeometry([.002, .03, .002], [0, -1, 0], V, .001, .0005);
    near(d.birthTimeSeconds, .002); expect(d.positionM).toEqual(expected.centreOfMassM);
    expect(d.velocityMS).toEqual([0, 0, 0]); near(4 * Math.PI * d.radiusM ** 3 / 3, V, 1e-22);
    expect(.03 - d.positionM[1]).toBeGreaterThan(d.radiusM); near(s.volumeErrorM3, 0);
  });
  it("reports signed liquid-air area work without claiming a dissipative pinch or hiding missing contact energy", () => {
    const f = new LiverRunoffExperiment(config(), flatSupport), V = f.criticalVolumeM3;
    const checkpoint = f.checkpoint(), shape = runoffAttachedGeometry([0, 0, 0], [0, 1, 0], V, .001, .0005);
    const second: LiverDrainageEvent = { ...event(1, V), positionM: [.013, .03, .001] };
    const s = f.step({ timeSeconds: .002, drainageEvents: [event(0, V), second], collision: free, collectorMaximumYM: 0 });
    // Surface-of-revolution integral: spherical cap area=2πR h; cylinder=2πaL.
    const h = shape.capHeightM, R = (h * h + .001 ** 2) / (2 * h), sphereR = Math.cbrt(3 * V / (4 * Math.PI));
    const oneRelease = .055 * (4 * Math.PI * sphereR ** 2 - 2 * Math.PI * R * h - 2 * Math.PI * .001 * .0005);
    expect(oneRelease).toBeGreaterThan(0);
    near(s.telemetry.pinchFreeSurfaceEnergyChangeJ, 2 * oneRelease, 1e-20);
    expect(s.telemetry.momentumModel).toMatch(/work (?:are|is) unresolved/);
    f.restore(checkpoint); expect(f.snapshot().telemetry.pinchFreeSurfaceEnergyChangeJ).toBe(0);
  });
});

describe("runoff interval integration and conservative phase ownership", () => {
  function run(dt: number, parts: number) {
    const f = new LiverRunoffExperiment(config({ fixedDtSeconds: dt }), flatSupport);
    // Separate drops have time to clear their source. The previous 20 ms
    // forcing made an old drop intersect the refilling neck; independent
    // ballistic spheres were not a physically valid reference for that case.
    const rate = f.criticalVolumeM3 / .4; let id = 0;
    for (let i = 0; i < Math.round(.8 / dt); i++) {
      const events = Array.from({ length: parts }, (_, j) => event(id++, rate * dt / parts,
        i * dt + j * dt / parts, i * dt + (j + 1) * dt / parts));
      f.step({ timeSeconds: (i + 1) * dt, drainageEvents: events, collision: free, collectorMaximumYM: 0 });
    }
    return f.snapshot();
  }
  it("keeps release times, volumes and trajectories invariant under packet/timestep refinement", () => {
    const reference = run(.002, 1);
    expect(reference.droplets).toHaveLength(2);
    for (const other of [run(.002, 7), run(.001, 3), run(.0005, 2)]) {
      expect(other.droplets).toHaveLength(2);
      for (let i = 0; i < 2; i++) {
        near(other.droplets[i]!.birthTimeSeconds, reference.droplets[i]!.birthTimeSeconds, 1e-12);
        near(other.droplets[i]!.volumeM3, reference.droplets[i]!.volumeM3, 1e-21);
        other.droplets[i]!.positionM.forEach((v, k) => near(v, reference.droplets[i]!.positionM[k]!, 1e-12));
      }
      near(other.volumeErrorM3, 0, 1e-18);
    }
  });
  it("has deterministic physical cell-centre anchors independent of event order and vertex IDs", () => {
    const a = new LiverRunoffExperiment(config(), flatSupport), b = new LiverRunoffExperiment(config(), flatSupport);
    const x = event(0, 1e-9), y = { ...event(1, 2e-9), sourceVertex: 60000, positionM: [.003, .03, .003] as [number, number, number] };
    const first = a.step({ timeSeconds: .002, drainageEvents: [x, y], collision: free, collectorMaximumYM: 0 });
    const second = b.step({ timeSeconds: .002, drainageEvents: [y, x], collision: free, collectorMaximumYM: 0 });
    expect(first.attached).toEqual(second.attached); expect(first.attached).toHaveLength(1);
    expect(first.attached[0]!.anchorM).toEqual([.002, .03, .002]);
    near(first.telemetry.maximumRelocationM, Math.sqrt(2) * .001);
  });
  it("shares a precomputed physical support across source cells without duplicate bodies or a centre-of-mass jump", () => {
    const support = (_p: VesselVector) => ({ ...flatSupport([.004, .03, .002]), supportId: "authored-support-17" });
    const a = new LiverRunoffExperiment(config(), support, flatSupport), b = new LiverRunoffExperiment(config(), support, flatSupport);
    const V = a.criticalVolumeM3;
    const x: LiverDrainageEvent = { ...event(0, V / 2), positionM: [.003, .03, .001] };
    const y: LiverDrainageEvent = { ...event(1, V / 2), positionM: [.005, .03, .001] };
    const first = a.step({ timeSeconds: .002, drainageEvents: [x, y], collision: free, collectorMaximumYM: 0 });
    const reverse = b.step({ timeSeconds: .002, drainageEvents: [y, x], collision: free, collectorMaximumYM: 0 });
    expect(first).toEqual(reverse);
    expect(first.telemetry.physicalSupportCount).toBe(1); expect(first.telemetry.mappedSourceCellCount).toBe(2);
    expect(first.droplets).toHaveLength(1); expect(first.attached).toHaveLength(0);
    const expected = runoffAttachedGeometry([.004, .03, .002], [0, -1, 0], V, .001, .0005);
    expect(first.droplets[0]!.positionM).toEqual(expected.centreOfMassM);
    near(first.inputVolumeM3, V, 1e-22); near(first.volumeErrorM3, 0, 1e-22);
  });
  it("rejects inconsistent shared identities and rolls back newly mapped cells and phase inventory", () => {
    const support = (p: VesselVector) => ({ ...flatSupport([p[0] < .004 ? .004 : .0041, .03, .002]),
      supportId: "same-id-inconsistent-pose" });
    const f = new LiverRunoffExperiment(config(), support, flatSupport);
    const x: LiverDrainageEvent = { ...event(0, 1e-9), positionM: [.003, .03, .001] };
    f.step({ timeSeconds: .002, drainageEvents: [x], collision: free, collectorMaximumYM: 0 });
    const before = f.snapshot();
    const y: LiverDrainageEvent = { ...event(1, 1e-9, .002, .004), positionM: [.005, .03, .001] };
    expect(() => f.step({ timeSeconds: .004, drainageEvents: [y], collision: free, collectorMaximumYM: 0 }))
      .toThrow(/identity changed geometry/);
    expect(f.snapshot()).toEqual(before); expect(f.snapshot().telemetry.mappedSourceCellCount).toBe(1);
  });
  it("lands an occluded source's old drops once at independent analytic floor-contact times", () => {
    const f = new LiverRunoffExperiment(config(), flatSupport), V = f.criticalVolumeM3, contacts: VesselLandingEvent[] = [];
    for (let i = 0; i < 80; i++) {
      const s = f.step({ timeSeconds: (i + 1) * .002, drainageEvents: i === 0 ? [event(0, V)] : [],
        collision: floor(i * .002), collectorMaximumYM: 0 });
      contacts.push(...s.contacts); near(s.volumeErrorM3, 0, 1e-20);
    }
    expect(contacts).toHaveLength(1); const e = contacts[0]!;
    const shape = runoffAttachedGeometry([.002, .03, .002], [0, -1, 0], V, .001, .0005);
    const radius = Math.cbrt(3 * V / (4 * Math.PI));
    near(e.timeSeconds, .002 + Math.sqrt(2 * (shape.centreOfMassM[1] - radius) / 9.81), 1e-12);
    expect(e.positionM[1]).toBe(0); near(e.volumeM3, V, 1e-21);
    near(f.snapshot().collectorTransferredVolumeM3, V); expect(f.snapshot().inFlightVolumeM3).toBe(0);
  });
  it("returns actual drop mass to the organ instead of ignoring recontact", () => {
    const f = new LiverRunoffExperiment(config(), flatSupport), V = f.criticalVolumeM3;
    const collision: JetCollisionQuery = { contact: (p, _v, _g, _birth, start, end, radius) =>
      radius > 0 && end > start ? { timeSeconds: start, positionM: p, surface: { triangle: 3, barycentric: [.2, .3, .5] } } : undefined };
    f.step({ timeSeconds: .002, drainageEvents: [event(0, V)], collision, collectorMaximumYM: 0 });
    const s = f.step({ timeSeconds: .004, drainageEvents: [], collision, collectorMaximumYM: 0 });
    expect(s.contacts).toHaveLength(1); expect(s.contacts[0]!.surface!.triangle).toBe(3);
    near(s.organReturnedVolumeM3, V); expect(s.inFlightVolumeM3).toBe(0); near(s.volumeErrorM3, 0);
  });
  it("transfers a growing attached cap at a real earlier tray contact, before the capillary threshold", () => {
    const f = new LiverRunoffExperiment(config(), flatSupport), V = f.criticalVolumeM3;
    const height = .029; // 1 mm below the attachment, so the growing cap reaches it.
    const s = f.step({ timeSeconds: .002, drainageEvents: [event(0, V / 2)], collision: floor(0, height), collectorMaximumYM: height });
    expect(s.telemetry.collectorBridgeTransfers).toBeGreaterThan(0);
    expect(s.telemetry.releasedDrops).toBe(0); expect(s.droplets).toHaveLength(0);
    expect(s.contacts[0]!.positionM[1]).toBe(height);
    expect(s.contacts[0]!.timeSeconds).toBeGreaterThan(0); expect(s.contacts[0]!.timeSeconds).toBeLessThan(.002);
    const h = .0005, contactVolume = Math.PI * .001 ** 2 * .0005 + Math.PI * h * (3 * .001 ** 2 + h ** 2) / 6;
    near(s.contacts[0]!.volumeM3, contactVolume, 1e-20);
    near(s.contacts[0]!.timeSeconds, .002 * contactVolume / (V / 2), 1e-12);
    near(s.attachedVolumeM3 + s.collectorTransferredVolumeM3, V / 2, 1e-19);
  });
  it("rolls back duplicate events, malformed contacts, unsupported supports and foreign checkpoints", () => {
    const f = new LiverRunoffExperiment(config(), flatSupport), V = f.criticalVolumeM3;
    f.step({ timeSeconds: .002, drainageEvents: [event(0, V / 2)], collision: free, collectorMaximumYM: 0 });
    const before = f.snapshot(), checkpoint = f.checkpoint();
    expect(() => f.step({ timeSeconds: .004, drainageEvents: [event(0, V / 2, .002, .004)], collision: free })).toThrow(/duplicate/);
    expect(f.snapshot()).toEqual(before);
    const bad: JetCollisionQuery = { contact: (p, _v, _g, birth, _s, _e, radius) => radius > 0
      ? { timeSeconds: birth, positionM: p, surface: { triangle: -1, barycentric: [0, 0, 0] } } : undefined };
    expect(() => f.step({ timeSeconds: .004, drainageEvents: [event(1, V / 2, .002, .004)], collision: bad })).toThrow(/contact/);
    expect(f.snapshot()).toEqual(before);
    f.step({ timeSeconds: .004, drainageEvents: [event(1, V / 2, .002, .004)], collision: free, collectorMaximumYM: 0 });
    f.restore(checkpoint); expect(f.snapshot()).toEqual(before);
    expect(() => new LiverRunoffExperiment(config(), flatSupport).restore(checkpoint)).toThrow(/another/);
    const wrong = new LiverRunoffExperiment(config(), p => ({ positionM: [p[0], .03, p[2]], normal: [0, 1, 0] }));
    expect(() => wrong.step({ timeSeconds: .002, drainageEvents: [event(0, 1e-9)], collision: free })).toThrow(/outward gravity/);
    expect(wrong.snapshot().inputVolumeM3).toBe(0);
  });
  it("rejects intersecting support geometry and exposes zero-sigma drainage as unsupported without fake drops", () => {
    const f = new LiverRunoffExperiment(config(), flatSupport, p => ({ positionM: [p[0], p[1] + .00001, p[2]], normal: [0, -1, 0] }));
    expect(() => f.step({ timeSeconds: .002, drainageEvents: [event(0, 1e-9)], collision: free })).toThrow(/intersects|absent/);
    expect(f.snapshot().inputVolumeM3).toBe(0);
    const zero = new LiverRunoffExperiment(config({ surfaceTensionNM: 0 }), flatSupport);
    expect(zero.step({ timeSeconds: .002, drainageEvents: [], collision: free }).inputVolumeM3).toBe(0);
    expect(() => zero.step({ timeSeconds: .004, drainageEvents: [event(0, 1e-9, .002, .004)], collision: free })).toThrow(/continuous-stream/);
    expect(zero.snapshot().timeSeconds).toBe(.002);
  });
});

describe("read-only authored outlet eligibility", () => {
  it("uses exact source admission with candidate cut geometry without consuming physical capacity or inventory", () => {
    const f = new LiverRunoffExperiment(config({ maxReservoirs: 1 }), flatSupport), before = f.snapshot();
    const eligible = f.createDrainageEligibilityEvaluator();
    expect(eligible([.001, .03, .001], [0, -1, 0])).toEqual({ eligible: true });
    expect(eligible([.005, .03, .001], [0, -1, 0])).toEqual({ eligible: true });
    expect(f.snapshot()).toEqual(before);
    const removed = f.createDrainageEligibilityEvaluator({
      nearestSurface: p => ({ positionM: [p[0], .04, p[2]], normal: [0, -1, 0] }),
    });
    expect(removed([.001, .03, .001], [0, -1, 0]).eligible).toBe(false);
    expect(removed([.001, .03, .001], [0, -1, 0]).eligible).toBe(false);
    expect(f.snapshot()).toEqual(before);
  });
  it("retains explicitly unsupported outlets but propagates invalid inputs and programmer failures", () => {
    const f = new LiverRunoffExperiment(config(), flatSupport);
    const unsupported = f.createDrainageEligibilityEvaluator({ resolveSupport: () => {
      throw new RunoffUnsupportedSupportError("No physical support");
    } });
    expect(unsupported([.001, .03, .001], [0, -1, 0])).toEqual({ eligible: false, reason: "No physical support" });
    expect(() => unsupported([NaN, .03, .001], [0, -1, 0])).toThrow(RangeError);
    expect(() => unsupported([.001, .03, .001], [0, 0, 0])).toThrow(RangeError);
    const broken = f.createDrainageEligibilityEvaluator({ resolveSupport: () => { throw new Error("Programmer failure"); } });
    expect(() => broken([.001, .03, .001], [0, -1, 0])).toThrow("Programmer failure");
  });
});

describe("accepted film drainage transfers", () => {
  const downward: LiverSurface = { positionsM: new Float64Array([0, .03, 0, .01, .03, 0, 0, .03, .01]),
    normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const hit = (id: number, volumeM3 = 1e-10): VesselLandingEvent => ({ id, holeId: "w", timeSeconds: .001,
    positionM: [0, .03, 0], velocityMS: [0, 0, 0], volumeM3, supportRadiusM: 0,
    surface: { triangle: 0, barycentric: [.2, .3, .5] } });
  it("exports exactly removed volume at its accepted time with stable IDs and copied arrays", () => {
    const f = new LiverSurfaceFlow(downward), saved = f.checkpoint(), s = f.step([hit(1)]);
    near(s.drainageEvents!.reduce((sum, e) => sum + e.volumeM3, 0), s.escapedVolumeM3, 1e-25);
    expect(s.drainageEvents).toHaveLength(3); expect(s.filmVolumeM3).toBe(0);
    for (const e of s.drainageEvents!) {
      expect(e.startTimeSeconds).toBe(.001); expect(e.endTimeSeconds).toBe(.001);
      expect(e.normal).toEqual([0, -1, 0]); expect(e.stepIndex).toBe(1);
    }
    const before = f.snapshot(); s.drainageEvents![0]!.positionM[0] = 55;
    expect(f.snapshot()).toEqual(before);
    f.restore(saved); expect(f.step([hit(1)])).toEqual(before);
  });
  it("preserves continuous source intervals, total input and immutable previous accepted samplers", () => {
    const f = new LiverSurfaceFlow(downward), sampler = f.acceptedDepthSampler();
    const e = { ...hit(1), sourceAttachment: { startTimeSeconds: 0, endTimeSeconds: .002, radiusM: .0002 } };
    const s = f.step([e], new Map([["w", { indices: new Uint32Array([0, 1, 2]), weights: new Float64Array([.2, .3, .5]),
      radiusM: .0002, areaM2: 1e-7 }]]));
    expect(s.drainageEvents!.every(e => e.endTimeSeconds > e.startTimeSeconds)).toBe(true);
    near(s.drainageEvents!.reduce((sum, e) => sum + e.volumeM3, 0), e.volumeM3, 1e-24);
    expect(sampler(0)).toBe(0);
    expect(() => sampler(-1)).toThrow(); expect(() => f.depthAtVertex(3)).toThrow();
    const before = f.snapshot(); expect(() => f.step([hit(1)])).toThrow(/duplicate/);
    expect(f.snapshot()).toEqual(before);
  });
  it("keeps a frozen nonzero surface sampler unchanged when the current accepted state advances", () => {
    const upward = { ...downward, normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]) };
    const f = new LiverSurfaceFlow(upward);
    const dry = f.acceptedDepthSampler();
    f.step([hit(0, 1e-9)]);
    const wet = f.acceptedDepthSampler(), values = [0, 1, 2].map(wet);
    expect(values.some(v => v > 0)).toBe(true);
    f.step([{ ...hit(1, 2e-9), timeSeconds: .003 }]);
    expect([0, 1, 2].map(wet)).toEqual(values);
    expect([0, 1, 2].map(dry)).toEqual([0, 0, 0]);
    expect([0, 1, 2].map(i => f.depthAtVertex(i))).not.toEqual(values);
  });
});
