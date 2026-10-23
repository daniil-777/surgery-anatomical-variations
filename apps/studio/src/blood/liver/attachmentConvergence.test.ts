import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AtlasGeneration } from "../../atlas";
import { adaptLiverAnatomy } from "./anatomy";
import { refineLiverAnatomy } from "./refinement";
import { LiverFlowExperiment } from "./liverFlow";
import { prepareLiverCut } from "./wounds";

describe("finite-interval aperture attachment on the actual refined liver", () => {
  it("removes packet-dependent transients across 2/1/0.5/0.25 ms while retaining physical inventory and inertia warnings", () => {
    const generation = JSON.parse(gunzipSync(readFileSync(new URL(
      "../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration;
    const anatomy = refineLiverAnatomy(adaptLiverAnatomy(generation));
    const cut = prepareLiverCut(anatomy, [], { pick: anatomy.targets[0]!.pick, radiusM: .00125, depthM: .001, timeSeconds: 0 });
    expect(cut.accepted).toBe(true);
    const runs = [.002, .001, .0005, .00025].map(fixedDtSeconds => {
      const flow = new LiverFlowExperiment(anatomy, { fixedDtSeconds }); flow.setWounds([cut.wound!]);
      let peakSubsteps = 0, peakSlope = 0;
      for (let k = 1; k <= Math.round(.2 / fixedDtSeconds); k++) {
        const result = flow.step(); expect(result.accepted, `${fixedDtSeconds}: ${result.reason}`).toBe(true);
        const d = flow.diagnostics();
        peakSubsteps = Math.max(peakSubsteps, d.film.telemetry.acceptedSubsteps);
        peakSlope = Math.max(peakSlope, d.film.slope.maximumSurfaceSlope);
      }
      const snapshot = flow.snapshot(), diagnostics = flow.diagnostics();
      expect(snapshot.film.depthM.every(h => Number.isFinite(h) && h >= 0)).toBe(true);
      expect(Math.abs(snapshot.film.volumeErrorM3)).toBeLessThan(1e-19);
      expect(Math.abs(snapshot.coupledVolumeErrorM3)).toBeLessThan(1e-13);
      expect(snapshot.film.filmVolumeM3).toBeCloseTo(snapshot.vessel.expelledVolumeM3, 19);
      expect(diagnostics.film.validity.status).toBe("outside-creeping-thin-film-indicators");
      expect(diagnostics.film.telemetry.maximumFilmReynolds).toBeGreaterThan(1);
      return { fixedDtSeconds, snapshot, diagnostics, peakSubsteps, peakSlope };
    });
    const reference = runs[3]!.snapshot.film;
    const evidence = runs.map(run => {
      const film = run.snapshot.film;
      const relativeVolumeWeightedL1 = film.depthM.reduce((s, h, i) =>
        s + Math.abs(h - reference.depthM[i]!) * film.vertexAreaM2[i]!, 0) / reference.filmVolumeM3;
      expect(relativeVolumeWeightedL1).toBeLessThan(.01);
      return { fixedDtSeconds: run.fixedDtSeconds, timeSeconds: run.snapshot.timeSeconds,
        relativeVolumeWeightedL1, peakSubsteps: run.peakSubsteps, peakSlope: run.peakSlope,
        maxDepthM: film.maxDepthM, expelledVolumeM3: run.snapshot.vessel.expelledVolumeM3,
        filmVolumeErrorM3: film.volumeErrorM3, globalVolumeErrorM3: run.snapshot.coupledVolumeErrorM3,
        telemetry: run.diagnostics.film.telemetry, slope: run.diagnostics.film.slope,
        footprints: run.diagnostics.film.attachmentFootprints };
    });
    const peaks = runs.map(r => r.diagnostics.film.telemetry.maximumFilmReynolds);
    expect(Math.max(...peaks) / Math.min(...peaks)).toBeLessThan(1.05);
    // Reference is a numerical refinement comparison, not an experimental or
    // physiological oracle. Independent source ODE/area tests are separate.
    console.info("Finite aperture attachment timestep comparison", JSON.stringify(evidence));
    if (process.env.LIVER_REFINEMENT_EVIDENCE) {
      mkdirSync(process.env.LIVER_REFINEMENT_EVIDENCE, { recursive: true });
      writeFileSync(resolve(process.env.LIVER_REFINEMENT_EVIDENCE, "attachment-timestep-comparison.json"), JSON.stringify(evidence, null, 2));
    }
  }, 120000);
});
