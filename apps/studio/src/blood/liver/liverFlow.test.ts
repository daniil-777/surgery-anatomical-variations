import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { adaptLiverAnatomy } from "./anatomy";
import { prepareLiverCut, buildLiverCutGeometry } from "./wounds";
import { LiverFlowExperiment, liverWoundSourcePosition } from "./liverFlow";
import type { AtlasGeneration } from "../../atlas";
import type { LiverAnatomy, LiverWound } from "./types";
const reference = () => adaptLiverAnatomy(JSON.parse(gunzipSync(readFileSync(new URL(
  "../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration);
function wounds(anatomy: LiverAnatomy, count = 1): LiverWound[] {
  const list: LiverWound[] = [];
  for (const target of [...anatomy.targets].sort((a, b) => b.pick.normal[1] - a.pick.normal[1])) {
    if (list.length === count) break;
    const cut = prepareLiverCut(anatomy, list, { pick: target.pick, radiusM: .001, depthM: .0015, timeSeconds: 0 });
    if (cut.accepted && cut.outcome === "vessel-hit" && cut.wound!.apertureRadiusM >= .00005 && cut.wound!.apertureRadiusM <= .0015)
      list.push(cut.wound!);
  }
  expect(list.length).toBe(count); return list;
}
function advance(f: LiverFlowExperiment, count: number) {
  for (let i = 0; i < count; i++) { const step = f.step(); expect(step.accepted, `step ${i}: ${step.reason}`).toBe(true); }
  return f.snapshot();
}
function renderedIntegral(anatomy: LiverAnatomy, wounds: LiverWound[], depth: Float64Array) {
  const cut = buildLiverCutGeometry(anatomy, wounds), m = cut.surface; let volume = 0;
  for (let k = 0; k < m.indices.length; k += 3) {
    const ids = [m.indices[k]!, m.indices[k + 1]!, m.indices[k + 2]!];
    const p = ids.map(i => Array.from(m.positionsM.slice(3 * i, 3 * i + 3)));
    const u = p[1]!.map((x, j) => x - p[0]![j]!), v = p[2]!.map((x, j) => x - p[0]![j]!);
    const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    const h = ids.map(i => {
      const t = cut.sourceTriangles[i]!;
      return [0, 1, 2].reduce((sum, j) => sum + cut.sourceBarycentrics[3 * i + j]! * depth[anatomy.surface.indices[3 * t + j]!]!, 0);
    });
    volume += area * h.reduce((a, b) => a + b, 0) / 3;
  }
  return volume;
}

describe("actual HRA liver coupled circulation, wound, flight and film", () => {
  it("keeps intact tissue dry with the complete global inventory and advancing circulation", () => {
    const anatomy = reference(), f = new LiverFlowExperiment(anatomy), s = advance(f, 20);
    let minimumY = Infinity;
    for (let i = 1; i < anatomy.surface.positionsM.length; i += 3)
      minimumY = Math.min(minimumY, anatomy.surface.positionsM[i]!);
    expect(f.vesselConfig.collectionPlaneYM).toBe(minimumY - .02);
    expect(s.vessel.expelledVolumeM3).toBe(0); expect(s.film.filmVolumeM3).toBe(0);
    expect(Math.abs(s.coupledVolumeErrorM3)).toBeLessThan(1e-13);
    expect(s.cardiovascular.stepIndex).toBe(s.stepIndex);
  });
  it.each(["vein", "artery"] as const)("runs %s pressure-driven bleeding for one second and preserves exact cut-film inventory", kind => {
    const anatomy = reference(), cuts = wounds(anatomy), f = new LiverFlowExperiment(anatomy, { kind });
    f.setWounds(cuts);
    const start = performance.now(), s = advance(f, 500), elapsed = performance.now() - start;
    expect(s.vessel.expelledVolumeM3).toBeGreaterThan(0);
    if (kind === "vein") {
      expect(s.film.inputVolumeM3).toBeGreaterThan(0);
      expect(s.film.filmVolumeM3).toBeGreaterThan(0);
      expect(s.film.depthM.filter(x => x > 0).length).toBeGreaterThan(3);
    } else {
      // The independent all-triangle oracle for this actual target checks all
      // 500 emission speeds: upward/outward centre paths miss the organ and
      // reach the floor beyond the finite tray. Positive film is not expected.
      // Receipt: artifacts/liver-bleeding-2026-10-20/arterial-trajectory-oracle.json.
      const jet = s.vessel.jets[0]!;
      expect(jet.direction[1]).toBeGreaterThan(0); expect(jet.direction[2]).toBeGreaterThan(0);
      const gravity = -f.vesselConfig.gravityMS2[1], vy = jet.velocityMS * jet.direction[1];
      const flightTime = (vy + Math.sqrt(vy * vy + 2 * gravity
        * (jet.positionM[1] - f.vesselConfig.collectionPlaneYM))) / gravity;
      const floorZ = jet.positionM[2] + jet.velocityMS * jet.direction[2] * flightTime;
      expect(floorZ).toBeGreaterThan(s.collector.domain.originZM + s.collector.domain.depthM);
      expect(s.film.inputVolumeM3).toBe(0); expect(s.film.filmVolumeM3).toBe(0);
      expect(s.collector.filmVolumeM3).toBe(0); expect(s.pendingReturnVolumeM3).toBe(0);
      expect(s.breakup.inFlightVolumeM3).toBeGreaterThan(0); expect(s.terminalEscapeVolumeM3).toBeGreaterThan(0);
      expect(Math.abs(s.breakup.landedVolumeM3 - s.terminalEscapeVolumeM3)).toBeLessThan(1e-17);
      expect(Math.abs(s.breakup.inFlightVolumeM3 + s.terminalEscapeVolumeM3
        - s.vessel.expelledVolumeM3)).toBeLessThan(1e-17);
    }
    expect(s.film.depthM.filter(x => x === 0).length).toBeGreaterThan(s.film.depthM.length / 2);
    expect(Math.abs(s.coupledVolumeErrorM3)).toBeLessThan(1e-13);
    expect(Math.abs(s.film.volumeErrorM3)).toBeLessThan(1e-17);
    expect(renderedIntegral(anatomy, cuts, s.film.depthM)).toBeCloseTo(s.film.filmVolumeM3, 17);
    const expelled = s.vessel.expelledVolumeM3;
    f.setOccluded(true); const stopped = advance(f, 30);
    expect(stopped.vessel.expelledVolumeM3).toBe(expelled);
    expect(stopped.film.inputVolumeM3).toBeGreaterThanOrEqual(s.film.inputVolumeM3);
    console.info("Liver actual-mesh coupled evidence", JSON.stringify({ kind, fixedSteps: 500, elapsedMs: elapsed,
      pressurePa: s.vessel.pressurePa, expelledVolumeM3: s.vessel.expelledVolumeM3, filmVolumeM3: s.film.filmVolumeM3,
      escapedVolumeM3: s.film.escapedVolumeM3, inFlightM3: s.breakup.inFlightVolumeM3, maxDepthM: s.film.maxDepthM,
      maxMassErrorM3: s.coupledVolumeErrorM3, filmTelemetry: f.diagnostics().film.telemetry }));
  }, 60000);
  it("preserves existing film when a second actual wound is added and rejects invalid edits atomically", () => {
    const anatomy = reference(), cuts = wounds(anatomy, 2), f = new LiverFlowExperiment(anatomy);
    f.setWounds(cuts.slice(0, 1)); const before = advance(f, 80);
    f.setWounds(cuts);
    expect(f.snapshot().film.filmVolumeM3).toBeCloseTo(before.film.filmVolumeM3, 20);
    const accepted = f.snapshot();
    expect(() => f.setWounds([...cuts, { ...cuts[0]!, id: "invalid", apertureRadiusM: .02 }])).toThrow();
    expect(f.snapshot()).toEqual(accepted);
    advance(f, 30);
  }, 60000);
  it("uses effective vessel-wall length independently of a deeper fully exposing tissue punch", () => {
    const anatomy = reference();
    let pair: LiverWound[] | undefined;
    for (const target of anatomy.targets) {
      const a = prepareLiverCut(anatomy, [], { pick: target.pick, radiusM: .001, depthM: .0015, timeSeconds: 0 });
      const b = prepareLiverCut(anatomy, [], { pick: target.pick, radiusM: .001, depthM: .002, timeSeconds: 0 });
      if (a.accepted && b.accepted && a.wound!.vesselId && a.wound!.vesselId === b.wound!.vesselId
        && Math.abs(a.wound!.apertureRadiusM - b.wound!.apertureRadiusM) < 1e-14) {
        pair = [a.wound!, b.wound!]; break;
      }
    }
    expect(pair).toBeDefined();
    const flows = pair!.map(w => {
      const f = new LiverFlowExperiment(anatomy); f.setWounds([w]);
      expect(f.options.effectiveWallLengthM).toBe(.0001);
      const source = liverWoundSourcePosition(anatomy, w), vessel = anatomy.vessels.find(v => v.id === w.vesselId)!;
      const displacement = source.map((x, k) => x - w.pick.positionM[k]!);
      const depth = -displacement.reduce((s, x, k) => s + x * w.pick.normal[k]!, 0);
      const radial = Math.hypot(...displacement.map((x, k) => x + depth * w.pick.normal[k]!));
      expect(depth).toBeGreaterThanOrEqual(0); expect(depth).toBeLessThan(w.depthM);
      expect(radial).toBeLessThan(w.radiusM);
      const ab = vessel.bM.map((x, k) => x - vessel.aM[k]!);
      const t = Math.max(0, Math.min(1, source.reduce((v, x, k) => v + (x - vessel.aM[k]!) * ab[k]!, 0) / ab.reduce((v, x) => v + x * x, 0)));
      expect(Math.hypot(...source.map((x, k) => x - vessel.aM[k]! - t * ab[k]!)))
        .toBeLessThanOrEqual(vessel.radiusAM * (1 - t) + vessel.radiusBM * t + 1e-8);
      return advance(f, 1).vessel.jets[0]!;
    });
    // The same fully exposed tube is found at the same height in this fixture:
    // neither hydraulic resistance nor hydrostatic pressure changes with depth.
    expect(flows[0]!.positionM).toEqual(flows[1]!.positionM);
    expect(flows[0]!.flowM3S).toBe(flows[1]!.flowM3S);
    const longer = new LiverFlowExperiment(anatomy, { effectiveWallLengthM: .0005 });
    longer.setWounds([pair![0]!]);
    expect(advance(longer, 1).vessel.jets[0]!.flowM3S).toBeLessThan(flows[0]!.flowM3S);
  }, 60000);
  it("runs three actual wounds for five seconds, with finite spatial flow and bounded conserved inventory", () => {
    const anatomy = reference(), cuts = wounds(anatomy, 3), f = new LiverFlowExperiment(anatomy);
    f.setWounds(cuts);
    const start = performance.now(), s = advance(f, 2500), elapsed = performance.now() - start;
    expect(s.vessel.expelledVolumeM3).toBeGreaterThan(0);
    expect(s.film.filmVolumeM3 + s.film.escapedVolumeM3).toBeGreaterThan(0);
    expect(Math.abs(s.coupledVolumeErrorM3)).toBeLessThan(1e-13);
    expect(Math.abs(s.film.volumeErrorM3)).toBeLessThan(1e-17);
    expect(s.film.maxDepthM).toBeLessThan(.005);
    expect(renderedIntegral(anatomy, cuts, s.film.depthM)).toBeCloseTo(s.film.filmVolumeM3, 16);
    console.info("Liver three-wound five-second evidence", JSON.stringify({ elapsedMs: elapsed,
      expelledVolumeM3: s.vessel.expelledVolumeM3, filmVolumeM3: s.film.filmVolumeM3,
      escapedVolumeM3: s.film.escapedVolumeM3, maxDepthM: s.film.maxDepthM,
      globalErrorM3: s.coupledVolumeErrorM3, telemetry: f.diagnostics().film.telemetry }));
  }, 60000);
});
