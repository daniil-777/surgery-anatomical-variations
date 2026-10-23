import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vesselApertures, vesselFrame, type ApertureSpec, type VesselGeometryConfig } from "./geometry";
import { createVesselPreset, VesselExperiment } from "./vesselSolver";

/** Mirrors the audited ExperimentLab envelope; the artifact stores the UI
 * source digest so subsequent UI changes cannot silently inherit this result.
 * Uses the actual shared curve and aperture mapping, not guessed directions.
 */
const geometry: VesselGeometryConfig = {
  innerRadiusM: .003, wallThicknessM: .00065, holes: [],
  centrelineM: [[-.03, .025, 0], [-.015, .028, .002], [0, .026, .003], [.015, .023, .001], [.03, .025, 0]],
};
const frame = vesselFrame(geometry);
const aperture = (index: number, radiusM: number): ApertureSpec => {
  const arcFraction = [.32, .5, .68][index]!;
  const n = frame.point(arcFraction, 0, 0).radial, b = frame.point(arcFraction, Math.PI / 2, 0).radial;
  return { id: `puncture-${index + 1}`, arcFraction, radiusM,
    angleRad: Math.atan2(-.3 * b.y + .95 * b.z, -.3 * n.y + .95 * n.z) };
};

describe("vessel UI operating envelope", () => {
  it("keeps every pressure/viscosity/aperture/count combination finite, conservative, and inside the stated collector", () => {
    const results: {
      kind: string; pressureMMHg: number; viscosityPaS: number; radiusM: number; holes: number;
      maxSampledReynoldsNumber: number; maxSampledSpeedMS: number; maxVolumeErrorM3: number;
      minPressurePa: number; maxPressurePa: number; expelledVolumeM3: number; activeParcels: number; passed: boolean;
    }[] = [];
    const siteGeometry = [.0002, .0004, .0006].map(radiusM => ({
      radiusM, apertures: vesselApertures({ ...geometry, holes: [0, 1, 2].map(i => aperture(i, radiusM)) }),
    }));
    const center = frame.curve.getPointAt(.5);
    // For downward jets with vertical gravity, the horizontal distance is no
    // greater than the infinite-speed straight-line intercept. This checks the
    // entire possible speed range, not merely sampled simulation positions.
    const collectorBounds = siteGeometry.flatMap(({ apertures }) => apertures.map(hole => {
      const tPerSpeed = hole.positionM[1] / -hole.direction[1];
      const x = hole.positionM[0] + hole.direction[0] * tPerSpeed;
      const z = hole.positionM[2] + hole.direction[2] * tPerSpeed;
      return { holeId: hole.id, originM: hole.positionM, direction: hole.direction,
        infiniteSpeedLandingM: [x, 0, z], insideCollector: hole.direction[1] < 0
          && Math.max(Math.abs(hole.positionM[0] - center.x), Math.abs(x - center.x)) < .08
          && Math.max(Math.abs(hole.positionM[2] - center.z), Math.abs(z - center.z)) < .1 };
    }));
    expect(collectorBounds.every(v => v.insideCollector)).toBe(true);
    for (const kind of ["artery", "vein"] as const) {
      const pressures = kind === "artery" ? Array.from({ length: 17 }, (_, i) => 60 + i * 5) : [5, 10, 15, 20];
      for (const pressureMMHg of pressures) for (const viscosityPaS of [.00345, .01, .03]) {
        for (const { radiusM, apertures } of siteGeometry) for (const holes of [1, 2, 3]) {
          const config = createVesselPreset(kind, { lengthM: frame.lengthM, viscosityPaS,
            sourcePressureMeanPa: pressureMMHg * 133.322387415,
            pressureReferencePositionM: center.toArray() as [number, number, number] });
          const solver = new VesselExperiment(config);
          solver.setHoles(apertures.slice(0, holes));
          let maxRe = 0, maxSpeed = 0, maxError = 0, minP = Infinity, maxP = -Infinity, valid = true;
          for (let i = 0; i < 125; ++i) {
            const state = solver.step(8);
            maxRe = Math.max(maxRe, ...state.jets.map(j => j.reynoldsNumber ?? 0));
            maxSpeed = Math.max(maxSpeed, ...state.jets.map(j => j.velocityMS));
            maxError = Math.max(maxError, Math.abs(state.volumeErrorM3));
            minP = Math.min(minP, state.pressurePa); maxP = Math.max(maxP, state.pressurePa);
            valid &&= state.vesselVolumeM3 >= config.minimumVesselVolumeM3 && state.supplyVolumeM3 >= 0
              && state.parcels.every(p => p.positionM.every(Number.isFinite) && p.positionM[1] > 0)
              && state.jets.every(j => Number.isFinite(j.flowM3S) && j.flowM3S >= 0)
              && Math.abs(state.expelledVolumeM3 - state.inFlightVolumeM3 - state.landedVolumeM3) < 1e-16;
          }
          const final = solver.snapshot();
          results.push({ kind, pressureMMHg, viscosityPaS, radiusM, holes, maxSampledReynoldsNumber: maxRe,
            maxSampledSpeedMS: maxSpeed, maxVolumeErrorM3: maxError, minPressurePa: minP, maxPressurePa: maxP,
            expelledVolumeM3: final.expelledVolumeM3, activeParcels: final.parcels.length, passed: valid && maxError < 1e-16 });
        }
      }
    }
    expect(results).toHaveLength(567);
    expect(results.filter(result => !result.passed)).toEqual([]);
    if (process.env.VISCERA_WRITE_VESSEL_ENVELOPE === "1") {
      const destination = "artifacts/blood-experiments-2026-10-20";
      mkdirSync(destination, { recursive: true });
      const sources = ["apps/studio/src/blood/experiments/vesselSolver.ts", "apps/studio/src/blood/experiments/geometry.ts",
        "apps/studio/src/blood/experiments/ExperimentLab.tsx", "apps/studio/src/blood/experiments/vesselEnvelope.test.ts"];
      const record = { schema: "viscera.vessel-ui-envelope/v1", date: "2026-10-20", status: "PASS", cases: results.length,
        durationPerCaseSeconds: 2, fixedDtSeconds: .002, statisticsSamplingSeconds: .016, curveLengthM: frame.lengthM,
        collectorBounds, maxSampledReynoldsNumber: Math.max(...results.map(r => r.maxSampledReynoldsNumber)),
        maxSampledSpeedMS: Math.max(...results.map(r => r.maxSampledSpeedMS)),
        maxAbsoluteVolumeErrorM3: Math.max(...results.map(r => r.maxVolumeErrorM3)),
        sourceSha256: Object.fromEntries(sources.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])),
        results, scope: "CPU numerical operating envelope of a reduced perfusion/ballistic model; not validation against blood/tissue measurements, 3D CFD, or rendered realism." };
      writeFileSync(`${destination}/vessel-ui-envelope.json`, `${JSON.stringify(record, null, 2)}\n`);
      console.log(JSON.stringify({ cases: record.cases, maxSampledReynoldsNumber: record.maxSampledReynoldsNumber,
        maxSampledSpeedMS: record.maxSampledSpeedMS, maxAbsoluteVolumeErrorM3: record.maxAbsoluteVolumeErrorM3 }));
    }
  }, 60000);
});
