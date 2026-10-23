import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fastestRayleighPlateauMode, JetBreakupExperiment, rayleighPlateauGrowthRate, type JetBreakupConfig } from "./jetBreakup";
import { createVesselPreset, VesselExperiment, type VesselEmission, type VesselHole } from "./vesselSolver";

const config = (overrides: Partial<JetBreakupConfig> = {}): JetBreakupConfig => ({
  densityKgM3: 1060, viscosityPaS: .00345, surfaceTensionNM: .055, initialRelativeAmplitude: .01,
  minimumWeber: 4, fixedDtSeconds: .002, gravityMS2: [0, -9.81, 0], collectionPlaneYM: 0, maxElements: 8192, ...overrides,
});
function source(c = config(), radius = .0004, speed = 3, height = .1) {
  let cumulative = 0;
  return (step: number, runId = 0): VesselEmission => {
    const volumeM3 = Math.PI * radius ** 2 * speed * c.fixedDtSeconds;
    const result: VesselEmission = { id: step, holeId: "test", runId, runVolumeStartM3: cumulative,
      originM: [0, height, 0], initialVelocityMS: [0, 0, speed], radiusM: radius, volumeM3,
      emissionTimeSeconds: (step + .5) * c.fixedDtSeconds, durationSeconds: c.fixedDtSeconds };
    cumulative += volumeM3; return result;
  };
}
const rel = (actual: number, expected: number, tolerance = 1e-10) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-25, Math.abs(expected) * tolerance));
const reference = JSON.parse(readFileSync(new URL("../../../../../blood/jet-breakup-reference.json", import.meta.url), "utf8")) as {
  cases: (Pick<JetBreakupConfig, "densityKgM3" | "viscosityPaS" | "surfaceTensionNM" | "initialRelativeAmplitude"> & {
    radiusM: number; growthRateSInv: number; wavelengthM: number; breakupAgeSeconds: number;
  })[];
};

describe("viscous capillary instability reference", () => {
  it.each(reference.cases)("matches the independent 80-digit growth root at R=$radiusM μ=$viscosityPaS", expected => {
    const actual = fastestRayleighPlateauMode(expected.radiusM, expected);
    rel(actual.growthRateSInv, expected.growthRateSInv, 2e-14);
    rel(actual.wavelengthM, expected.wavelengthM, 2e-14);
    rel(actual.breakupAgeSeconds, expected.breakupAgeSeconds, 2e-14);
  });
  it("matches the independent inviscid long-wave maximum and unstable cutoff", () => {
    const c = config({ viscosityPaS: 0 }), r = .0004, mode = fastestRayleighPlateauMode(r, c);
    rel(mode.dimensionlessWavenumber, Math.SQRT1_2);
    rel(mode.growthRateSInv * mode.capillaryTimeSeconds, 1 / (2 * Math.sqrt(2)));
    rel(mode.wavelengthM, 2 * Math.PI * Math.SQRT2 * r);
    for (const k of [0, 1, 2, 100]) expect(rayleighPlateauGrowthRate(r, c.densityKgM3, 0, c.surfaceTensionNM, k)).toBe(0);
  });
  it("satisfies the viscous growth polynomial and maximizes it independently", () => {
    for (const viscosity of [0, .00345, .01, .03, .5]) {
      const c = config({ viscosityPaS: viscosity }), r = .0004, m = fastestRayleighPlateauMode(r, c);
      const k = m.dimensionlessWavenumber / r, omega = m.growthRateSInv;
      const drive = c.surfaceTensionNM / (2 * c.densityKgM3 * r ** 3)
        * (m.dimensionlessWavenumber ** 2 - m.dimensionlessWavenumber ** 4);
      rel(omega ** 2 + 3 * viscosity / c.densityKgM3 * k ** 2 * omega, drive, 1e-12);
      for (let n = 1; n < 100; ++n)
        expect(rayleighPlateauGrowthRate(r, c.densityKgM3, viscosity, c.surfaceTensionNM, n / 100)).toBeLessThanOrEqual(omega * (1 + 1e-12));
    }
  });
  it("slows growth with viscosity and exposes disturbance-dependent pinch time", () => {
    const r = .0004;
    const low = fastestRayleighPlateauMode(r, config()), high = fastestRayleighPlateauMode(r, config({ viscosityPaS: .03 }));
    expect(high.growthRateSInv).toBeLessThan(low.growthRateSInv);
    expect(high.wavelengthM).toBeGreaterThan(low.wavelengthM);
    expect(high.breakupAgeSeconds).toBeGreaterThan(low.breakupAgeSeconds);
    const small = fastestRayleighPlateauMode(r, config({ initialRelativeAmplitude: .001 }));
    rel(small.breakupAgeSeconds / low.breakupAgeSeconds, 1.5);
    expect(fastestRayleighPlateauMode(r, config({ initialRelativeAmplitude: 0 })).breakupAgeSeconds).toBe(Infinity);
    expect(fastestRayleighPlateauMode(r, config({ surfaceTensionNM: 0 })).growthRateSInv).toBe(0);
  });
  it("has the expected capillary scaling with surface tension and radius at zero viscosity", () => {
    const base = fastestRayleighPlateauMode(.0004, config({ viscosityPaS: 0 }));
    rel(fastestRayleighPlateauMode(.0004, config({ viscosityPaS: 0, surfaceTensionNM: .11 })).growthRateSInv / base.growthRateSInv, Math.SQRT2);
    rel(fastestRayleighPlateauMode(.0008, config({ viscosityPaS: 0 })).growthRateSInv / base.growthRateSInv, 1 / Math.sqrt(8));
  });
});

describe("authoritative conservative capillary flight", () => {
  it("develops necking and detached drops while every delivered mesh has its accepted volume", () => {
    const c = config(), solver = new JetBreakupExperiment(c), emission = source(c);
    let maxAmplitude = 0, maxDrops = 0, emitted = 0;
    for (let i = 0; i < 100; ++i) {
      const e = emission(i); emitted += e.volumeM3;
      const frame = solver.step({ timeSeconds: (i + 1) * c.fixedDtSeconds, emissions: [e] });
      rel(frame.emittedVolumeM3, emitted);
      rel(frame.inFlightVolumeM3 + frame.landedVolumeM3, emitted);
      maxDrops = Math.max(maxDrops, frame.droplets.length);
      for (const ligament of frame.ligaments) {
        maxAmplitude = Math.max(maxAmplitude, ligament.relativeAmplitude);
        let volume = 0;
        for (let j = 1; j < ligament.points.length; ++j) {
          const a = ligament.points[j - 1]!, b = ligament.points[j]!;
          const length = Math.hypot(...b.positionM.map((v, k) => v - a.positionM[k]!));
          volume += Math.PI * length * (a.radiusM ** 2 + a.radiusM * b.radiusM + b.radiusM ** 2) / 3;
        }
        rel(volume, ligament.volumeM3, 2e-12);
      }
      for (const drop of frame.droplets) rel(4 * Math.PI / 3 * drop.radiusM ** 3, drop.volumeM3, 1e-12);
    }
    expect(maxAmplitude).toBeGreaterThan(.5); expect(maxDrops).toBeGreaterThan(5);
    expect(solver.snapshot().pinchCount).toBeGreaterThan(10);
    expect(solver.snapshot().landedVolumeM3).toBeGreaterThan(0);
  });
  it("keeps detached drop volume unchanged until its own exact finite-radius impact", () => {
    const c = config(), solver = new JetBreakupExperiment(c), emission = source(c);
    const seen = new Map<number, number>(); let dropImpacts = 0, impactVolume = 0;
    for (let i = 0; i < 180; ++i) {
      const frame = solver.step({ timeSeconds: (i + 1) * c.fixedDtSeconds, emissions: i < 50 ? [emission(i)] : [] });
      for (const drop of frame.droplets) {
        if (seen.has(drop.id)) expect(drop.volumeM3).toBe(seen.get(drop.id));
        else seen.set(drop.id, drop.volumeM3);
      }
      for (const event of frame.landingEvents) {
        expect(event.timeSeconds).toBeGreaterThanOrEqual(i * c.fixedDtSeconds - 1e-12);
        expect(event.timeSeconds).toBeLessThanOrEqual((i + 1) * c.fixedDtSeconds);
        expect(event.positionM[1]).toBe(c.collectionPlaneYM);
        if (event.supportRadiusM > 0) { ++dropImpacts; expect(event.volumeM3).toBe(seen.get(event.id)); }
        impactVolume += event.volumeM3;
      }
    }
    expect(dropImpacts).toBeGreaterThan(0);
    rel(impactVolume, solver.snapshot().emittedVolumeM3);
    expect(solver.snapshot().inFlightVolumeM3).toBe(0);
  });
  it("conserves ballistic momentum at each replacement and reports nonnegative unresolved kinetic loss", () => {
    const c = config({ gravityMS2: [0, 0, 0] }), solver = new JetBreakupExperiment(c), emission = source(c);
    let pinches = 0;
    for (let i = 0; i < 40; ++i) {
      const frame = solver.step({ timeSeconds: (i + 1) * c.fixedDtSeconds, emissions: [emission(i)] });
      for (const pinch of frame.pinchEvents) {
        ++pinches; rel(pinch.velocityMS[2], 3); expect(pinch.velocityMS[0]).toBe(0); expect(pinch.velocityMS[1]).toBe(0);
        expect(pinch.mergeKineticEnergyLostJ).toBeGreaterThanOrEqual(0);
        expect(pinch.mergeKineticEnergyLostJ).toBeLessThan(1e-30);
      }
    }
    expect(pinches).toBeGreaterThan(0);
  });
  it("does not fabricate Rayleigh breakup for low-We, short, zero-disturbance or zero-surface-tension cases", () => {
    for (const [overrides, speed, sourceSteps] of [
      [{}, .1, 60], [{}, 3, 1], [{ initialRelativeAmplitude: 0 }, 3, 40], [{ surfaceTensionNM: 0 }, 3, 40],
    ] as const) {
      const c = config(overrides), solver = new JetBreakupExperiment(c), emission = source(c, .0004, speed);
      let sawFallback = false;
      for (let i = 0; i < 100; ++i) {
        const frame = solver.step({ timeSeconds: (i + 1) * c.fixedDtSeconds, emissions: i < sourceSteps ? [emission(i)] : [] });
        sawFallback ||= frame.ligaments.some(l => l.mode !== "capillary");
        expect(frame.droplets).toHaveLength(0); expect(frame.pinchCount).toBe(0);
      }
      expect(sawFallback).toBe(true);
    }
  });
  it("rolls back invalid events/capacity errors and restores checkpoint state exactly", () => {
    const c = config({ maxElements: 8, gravityMS2: [0, 0, 0] }), solver = new JetBreakupExperiment(c), emission = source(c);
    const first = solver.step({ timeSeconds: .002, emissions: [emission(0)] }), checkpoint = solver.checkpoint();
    expect(() => solver.step({ timeSeconds: .004, emissions: [{ ...emission(1), volumeM3: NaN }] })).toThrow();
    expect(solver.snapshot()).toEqual(first);
    const fresh = source(c); fresh(0);
    let failure = false;
    for (let i = 1; i < 20; ++i) {
      const before = solver.snapshot();
      try { solver.step({ timeSeconds: (i + 1) * .002, emissions: [fresh(i)] }); }
      catch { failure = true; expect(solver.snapshot()).toEqual(before); break; }
    }
    expect(failure).toBe(true); solver.restore(checkpoint); expect(solver.snapshot()).toEqual(first);
    expect(() => new JetBreakupExperiment(c).restore(checkpoint)).toThrow();
  });
  it("conserves every impact across the 27 radius/viscosity/speed envelope and drains after source closure", () => {
    for (const radius of [.0002, .0004, .0006]) for (const viscosity of [.00345, .01, .03]) for (const speed of [.1, .7, 3.4]) {
      const c = config({ viscosityPaS: viscosity }), solver = new JetBreakupExperiment(c);
      const emission = source(c, radius, speed, .026), directionNorm = Math.hypot(.3, .95);
      let impacts = 0;
      for (let i = 0; i < 240; ++i) {
        const input = i < 120 ? [{ ...emission(i), initialVelocityMS: [0, -.3 * speed / directionNorm, .95 * speed / directionNorm] as const }] : [];
        const frame = solver.step({ timeSeconds: (i + 1) * c.fixedDtSeconds, emissions: input });
        for (const event of frame.landingEvents) impacts += event.volumeM3;
        rel(frame.inFlightVolumeM3 + frame.landedVolumeM3, frame.emittedVolumeM3, 2e-11);
        expect(frame.ligaments.length * 17 + frame.droplets.length).toBeLessThan(c.maxElements * 17);
      }
      rel(impacts, solver.snapshot().emittedVolumeM3, 2e-11);
      expect(solver.snapshot().inFlightVolumeM3).toBe(0);
    }
  }, 15000);
});

describe("vessel external-flight handoff", () => {
  const aperture: VesselHole = { id: "a", radiusM: .0004, wallLengthM: .00065, dischargeCoefficient: .62,
    positionM: [0, .03, 0], direction: [0, -.3, .95] };
  it("preserves pressure/discharge and reconciles authoritative breakup/impact inventory", () => {
    const vc = createVesselPreset("artery", { viscosityPaS: .00345 });
    const local = new VesselExperiment(vc), external = new VesselExperiment(vc, { externalFlight: true });
    const jet = new JetBreakupExperiment(config({ viscosityPaS: vc.viscosityPaS }));
    local.setHoles([aperture]); external.setHoles([aperture]);
    for (let i = 0; i < 180; ++i) {
      const a = local.step(), b = external.step();
      expect(b.pressurePa).toBe(a.pressurePa); expect(b.vesselVolumeM3).toBe(a.vesselVolumeM3);
      expect(b.expelledVolumeM3).toBe(a.expelledVolumeM3); expect(b.parcels).toHaveLength(0);
      const flight = jet.step({ timeSeconds: b.timeSeconds, emissions: b.emissions });
      external.reconcileExternalFlight(flight);
      rel(external.snapshot().inFlightVolumeM3, flight.inFlightVolumeM3);
      rel(external.snapshot().landedVolumeM3, flight.landedVolumeM3);
      expect(Math.abs(external.snapshot().volumeErrorM3)).toBeLessThan(1e-17);
    }
    expect(jet.snapshot().pinchCount).toBeGreaterThan(0);
  });
  it("provides immutable exact emission intervals and restarts run coordinates across occlusion", () => {
    const solver = new VesselExperiment(createVesselPreset("artery"), { externalFlight: true });
    solver.setHoles([aperture]); const first = solver.step().emissions[0]!;
    const second = solver.step().emissions[0]!;
    expect(second.runId).toBe(first.runId); expect(second.runVolumeStartM3).toBe(first.volumeM3);
    solver.setHoles([]); solver.setHoles([aperture]); const reopened = solver.step().emissions[0]!;
    expect(reopened.runId).not.toBe(first.runId); expect(reopened.runVolumeStartM3).toBe(0);
    const checkpoint = solver.checkpoint(), before = solver.snapshot();
    solver.step(); solver.restore(checkpoint); expect(solver.snapshot()).toEqual(before);
    const preview = solver.prepareStep(); expect(solver.snapshot()).toEqual(before);
    preview.commit(); expect(solver.snapshot()).toEqual(preview.snapshot); expect(() => preview.commit()).toThrow();
    expect(() => solver.reconcileExternalFlight({ inFlightVolumeM3: 0, landedVolumeM3: 0 })).toThrow();
  });
});
