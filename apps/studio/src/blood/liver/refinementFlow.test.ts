import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AtlasGeneration } from "../../atlas";
import { adaptLiverAnatomy } from "./anatomy";
import { refineLiverAnatomy } from "./refinement";
import { LiverFlowExperiment } from "./liverFlow";
import { prepareLiverCut } from "./wounds";

describe("matched physical-time liver film refinement", () => {
  it("keeps the same wound hydraulics and bounded positive conservative flow through five seconds", async () => {
    const generation = JSON.parse(gunzipSync(readFileSync(new URL(
      "../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration;
    const coarse = adaptLiverAnatomy(generation);
    const evidence: Record<string, unknown>[] = [];
    const traces: { pressurePa: number; expelledVolumeM3: number }[][] = [];
    const references: number[][] = [];
    const artifactDir = process.env.LIVER_REFINEMENT_EVIDENCE;
    for (const level of [0, 1] as const) {
      const anatomy = refineLiverAnatomy(coarse, level), target = anatomy.targets[0]!;
      const cut = prepareLiverCut(anatomy, [], { pick: target.pick, radiusM: .00125, depthM: .001, timeSeconds: 0 });
      expect(cut.accepted, cut.reason).toBe(true);
      expect(cut.outcome).toBe("vessel-hit");
      const initializationStart = performance.now(), flow = new LiverFlowExperiment(anatomy);
      flow.setWounds([cut.wound!]);
      references.push([...flow.vesselConfig.pressureReferencePositionM]);
      const initializationMs = performance.now() - initializationStart;
      let peakSubsteps = 0, peakDepthM = 0, peakMassErrorM3 = 0, peakStepMs = 0, peakSlope = 0;
      const start = performance.now(), trace: { pressurePa: number; expelledVolumeM3: number }[] = [];
      const steps = level === 1 && process.env.LIVER_REFINEMENT_LONG ? 4000 : 2500;
      for (let step = 1; step <= steps; step++) {
        // Long numerical trials must let the test worker service its IPC;
        // this does not alter fixed physical time or the accepted state.
        if (step % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        const stepStart = performance.now(), result = flow.step();
        peakStepMs = Math.max(peakStepMs, performance.now() - stepStart);
        if (!result.accepted) {
          console.info("Liver refinement rejection", JSON.stringify({ level, step, reason: result.reason, evidence }));
          throw new Error(`Refinement level ${level} rejected step ${step}: ${result.reason}`);
        }
        const diagnostics = flow.diagnostics();
        peakSubsteps = Math.max(peakSubsteps, diagnostics.film.telemetry.acceptedSubsteps);
        peakSlope = Math.max(peakSlope, diagnostics.film.slope.maximumSurfaceSlope);
        if (step === 250 || step === 1000 || step === 2500 || step === 4000) {
          const s = flow.snapshot();
          peakDepthM = Math.max(peakDepthM, s.film.maxDepthM);
          peakMassErrorM3 = Math.max(peakMassErrorM3, Math.abs(s.coupledVolumeErrorM3));
          expect(s.timeSeconds).toBeCloseTo(step * .002, 10);
          expect(s.film.depthM.every(h => Number.isFinite(h) && h >= 0)).toBe(true);
          expect(s.film.maxDepthM).toBeLessThan(.005);
          expect(Math.abs(s.coupledVolumeErrorM3)).toBeLessThan(1e-13);
          expect(Math.abs(s.film.volumeErrorM3)).toBeLessThan(1e-17);
          expect(diagnostics.film.telemetry.sourceBoundaryContactVolumeM3).toBe(0);
          const row = { level, vertices: anatomy.surface.positionsM.length / 3, triangles: anatomy.surface.indices.length / 3,
            timeSeconds: s.timeSeconds, stepIndex: s.stepIndex, initializationMs, elapsedMs: performance.now() - start, peakStepMs,
            pressureReferencePositionM: flow.vesselConfig.pressureReferencePositionM,
            pressurePa: s.vessel.pressurePa, expelledVolumeM3: s.vessel.expelledVolumeM3,
            filmVolumeM3: s.film.filmVolumeM3, escapedVolumeM3: s.film.escapedVolumeM3,
            inFlightVolumeM3: s.breakup.inFlightVolumeM3, maxDepthM: s.film.maxDepthM,
            peakDepthM, peakMassErrorM3, filmVolumeErrorM3: s.film.volumeErrorM3, peakSubsteps, peakSlope,
            slope: diagnostics.film.slope,
            telemetry: diagnostics.film.telemetry, validity: diagnostics.film.validity };
          evidence.push(row);
          trace.push({ pressurePa: s.vessel.pressurePa, expelledVolumeM3: s.vessel.expelledVolumeM3 });
          console.info("Liver refinement checkpoint", JSON.stringify(row));
          if (artifactDir) {
            mkdirSync(artifactDir, { recursive: true });
            const stringify = (_key: string, value: unknown) => ArrayBuffer.isView(value) ? Array.from(value as Float64Array) : value;
            writeFileSync(resolve(artifactDir, `level-${level}-${step}.json`),
              JSON.stringify({ anatomy: anatomy.provenance, options: flow.options, snapshot: s, diagnostics }, stringify));
            writeFileSync(resolve(artifactDir, "comparison.json"), JSON.stringify({ evidence,
              scope: "Same default target, 1.25 mm radius, 1 mm depth, 0.1 mm effective vessel wall. CPU wall time is observational, not a real-time or clinical validation." }, null, 2));
          }
        }
      }
      traces.push(trace);
    }
    // Refinement changes only the film graph and contact representation. The
    // vessel and its physical wound remain identical, not a tuned inflow.
    traces[0]!.forEach((point, i) => {
      expect(traces[1]![i]!.pressurePa).toBeCloseTo(point.pressurePa, 8);
      expect(traces[1]![i]!.expelledVolumeM3).toBeCloseTo(point.expelledVolumeM3, 17);
    });
    references[0]!.forEach((coordinate, i) => expect(references[1]![i]).toBeCloseTo(coordinate, 13));
  }, 240000);
});
