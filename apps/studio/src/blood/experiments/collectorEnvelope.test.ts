import { describe, expect, it } from "vitest";
import { vesselApertures, vesselFrame, type VesselGeometryConfig } from "./geometry";
import { VesselFlowExperiment } from "./vesselFlow";
import { createVesselPreset } from "./vesselSolver";

interface Case {
  kind: "artery" | "vein"; pressureMMHg: number; radiusM: number; viscosityPaS: number;
  surfaceTensionNM: number; initialRelativeAmplitude: number;
}
const cases: Case[] = [];
for (const viscosityPaS of [.00345, .03]) {
  for (const surfaceTensionNM of [.045, .065]) for (const initialRelativeAmplitude of [.005, .02])
    cases.push({ kind: "artery", pressureMMHg: 140, radiusM: .0006, viscosityPaS, surfaceTensionNM, initialRelativeAmplitude });
  cases.push({ kind: "vein", pressureMMHg: 20, radiusM: .0006, viscosityPaS, surfaceTensionNM: .065, initialRelativeAmplitude: .005 });
  cases.push({ kind: "vein", pressureMMHg: 5, radiusM: .0002, viscosityPaS, surfaceTensionNM: .045, initialRelativeAmplitude: .02 });
}

describe("collector with actual UI vessel/flight cohorts", () => {
  it.each(cases)("accepts 1 s with $kind, $pressureMMHg mmHg, r=$radiusM m, mu=$viscosityPaS, sigma=$surfaceTensionNM, disturbance=$initialRelativeAmplitude", c => {
    const geometry: VesselGeometryConfig = { innerRadiusM: .003, wallThicknessM: .00065, holes: [],
      centrelineM: [[-.03, .025, 0], [-.015, .028, .002], [0, .026, .003], [.015, .023, .001], [.03, .025, 0]] };
    const frame = vesselFrame(geometry);
    geometry.holes = [.32, .5, .68].map((arcFraction, i) => {
      const n = frame.point(arcFraction, 0, 0).radial, b = frame.point(arcFraction, Math.PI / 2, 0).radial;
      return { id: `puncture-${i + 1}`, arcFraction, radiusM: c.radiusM,
        angleRad: Math.atan2(-.3 * b.y + .95 * b.z, -.3 * n.y + .95 * n.z) };
    });
    const config = createVesselPreset(c.kind, { sourcePressureMeanPa: c.pressureMMHg * 133.32,
      viscosityPaS: c.viscosityPaS, innerRadiusM: geometry.innerRadiusM, lengthM: frame.lengthM,
      pressureReferencePositionM: frame.curve.getPointAt(.5).toArray() as [number, number, number] });
    const flow = new VesselFlowExperiment(config, { surfaceTensionNM: c.surfaceTensionNM, initialRelativeAmplitude: c.initialRelativeAmplitude });
    flow.setHoles(vesselApertures(geometry));
    let maxSubsteps = 0, maxSlope = 0, maxReynolds = 0, maxRelativeVolumeError = 0, maxEnergyErrorJ = 0, eventCount = 0;
    for (let i = 0; i < 500; i++) {
      const result = flow.step();
      expect(result.accepted, `${JSON.stringify(c)} at step ${i}: ${result.reason}`).toBe(true);
      const s = flow.snapshot(), stats = flow.diagnostics().collectorTelemetry!;
      maxSubsteps = Math.max(maxSubsteps, stats.substeps); maxSlope = Math.max(maxSlope, stats.maxSlope);
      maxReynolds = Math.max(maxReynolds, stats.maxFilmReynolds);
      maxRelativeVolumeError = Math.max(maxRelativeVolumeError, Math.abs(stats.relativeVolumeError));
      maxEnergyErrorJ = Math.max(maxEnergyErrorJ, Math.abs(stats.energyBalanceErrorJ));
      eventCount += s.breakup.landingEvents.length;
      expect(stats.minimumHeightM).toBeGreaterThan(0);
      expect(stats.maximumHeightM).toBeLessThan(.1 * Math.min(flow.collectorConfig.widthM, flow.collectorConfig.depthM));
      // .3 / frequency * frequency can round one ULP above .3.
      expect(stats.maxCourant).toBeLessThanOrEqual(.3 + Number.EPSILON);
      expect(s.collector.steepFrontWarning).toBe(stats.maxSlope > flow.collectorConfig.maxSlope);
      expect(Math.abs(s.collector.inputVolumeM3 - s.landedVolumeM3)).toBeLessThan(1e-14);
      expect(Math.abs(s.coupledVolumeErrorM3)).toBeLessThan(1e-14);
    }
    const final = flow.snapshot();
    expect(final.timeSeconds).toBe(1); expect(eventCount).toBeGreaterThan(0);
    expect(final.collector.depositedVolumeM3).toBeGreaterThan(0);
    expect(maxSubsteps).toBeLessThan(128);
    expect(maxRelativeVolumeError).toBeLessThan(2e-10); expect(maxEnergyErrorJ).toBeLessThan(1e-13);
    console.info("Coupled collector envelope", JSON.stringify({ ...c, eventCount, maxSubsteps, maxSlope, maxReynolds,
      maxRelativeVolumeError, maxEnergyErrorJ, depositedML: final.collector.depositedVolumeM3 * 1e6,
      escapedML: final.collector.escapedVolumeM3 * 1e6 }));
  }, 30000);
});
