import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { adaptLiverAnatomy } from "./anatomy";
import { prepareLiverCut } from "./wounds";
import { LiverFlowExperiment, liverTransferId } from "./liverFlow";
import { LiverRunoffExperiment } from "./runoff";
import { DryCollectorFilm } from "./dryCollector";
import type { AtlasGeneration } from "../../atlas";

const reference = () => adaptLiverAnatomy(JSON.parse(gunzipSync(readFileSync(new URL(
  "../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration);
afterEach(() => vi.restoreAllMocks());

describe("liver film, runoff and initially dry collector coupling", () => {
  it("keeps receiver event namespaces disjoint and rejects unsafe IDs before mutation", () => {
    for (const id of [0, 1, 1_000_000_000, Math.floor((Number.MAX_SAFE_INTEGER - 1) / 2)]) {
      expect(liverTransferId(id, "wound") % 2).toBe(0);
      expect(liverTransferId(id, "runoff") % 2).toBe(1);
      expect(Number.isSafeInteger(liverTransferId(id, "runoff"))).toBe(true);
    }
    for (const id of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      expect(() => liverTransferId(id, "wound")).toThrow();
  });
  it("carries actual underside drainage into visible phases without counting cumulative transfers twice", () => {
    const anatomy = reference(), model = new LiverFlowExperiment(anatomy);
    const cut = prepareLiverCut(anatomy, [], {
      pick: anatomy.targets[0]!.pick, radiusM: .00125, depthM: .001, timeSeconds: 0,
    });
    expect(cut.outcome).toBe("vessel-hit"); model.setWounds([cut.wound!]);
    let peakAttached = 0, peakAirborne = 0;
    for (let step = 0; step < 3000; step++) {
      const result = model.step();
      expect(result.accepted, `step ${step}: ${result.reason}`).toBe(true);
      if (step % 100 !== 99) continue;
      const s = model.snapshot();
      peakAttached = Math.max(peakAttached, s.runoff.attachedVolumeM3);
      peakAirborne = Math.max(peakAirborne, s.runoff.inFlightVolumeM3);
      const inventory = s.cardiovascular.circulatingVolumeM3 + s.vessel.vesselVolumeM3
        + s.breakup.inFlightVolumeM3 + s.film.filmVolumeM3 + s.runoff.attachedVolumeM3
        + s.runoff.inFlightVolumeM3 + s.pendingReturnVolumeM3 + s.collector.filmVolumeM3 + s.terminalEscapeVolumeM3;
      expect(Math.abs(inventory - s.initialInventoryM3)).toBeLessThan(1e-12);
      expect(Math.abs(s.film.escapedVolumeM3 - s.runoff.inputVolumeM3)).toBeLessThan(1e-17);
      expect(Math.abs(s.runoff.volumeErrorM3)).toBeLessThan(1e-17);
      expect(Math.abs(s.collector.volumeErrorM3)).toBeLessThan(1e-17);
      expect(s.collector.initialFilmVolumeM3).toBe(0);
      expect(s.collector.heightM.every(h => Number.isFinite(h) && h >= 0)).toBe(true);
    }
    const before = model.snapshot();
    expect(before.runoff.inputVolumeM3).toBeGreaterThan(0);
    expect(peakAttached).toBeGreaterThan(0);
    expect(peakAirborne + before.collector.filmVolumeM3).toBeGreaterThan(0);
    expect(before.collector.filmVolumeM3).toBeGreaterThan(0);
    model.setOccluded(true);
    for (let i = 0; i < 100; i++) {
      const result = model.step(); expect(result.accepted, result.reason).toBe(true);
    }
    const closed = model.snapshot();
    expect(closed.vessel.expelledVolumeM3).toBe(before.vessel.expelledVolumeM3);
    expect(closed.collector.filmVolumeM3).toBeGreaterThanOrEqual(before.collector.filmVolumeM3 - 1e-18);
    expect(Math.abs(closed.coupledVolumeErrorM3)).toBeLessThan(1e-12);
    console.info("Liver runoff inventory", JSON.stringify({
      timeSeconds: before.timeSeconds, expelledML: before.vessel.expelledVolumeM3 * 1e6,
      filmML: before.film.filmVolumeM3 * 1e6, attachedML: before.runoff.attachedVolumeM3 * 1e6,
      airborneML: before.runoff.inFlightVolumeM3 * 1e6, collectedML: before.collector.filmVolumeM3 * 1e6,
      pendingML: before.pendingReturnVolumeM3 * 1e6, terminalML: before.terminalEscapeVolumeM3 * 1e6,
      conservationErrorM3: before.coupledVolumeErrorM3,
    }));
  }, 180000);

  it("rolls back every owner when runoff throws after changing its candidate state", () => {
    const model = new LiverFlowExperiment(reference()), before = model.snapshot();
    const original = LiverRunoffExperiment.prototype.step;
    vi.spyOn(LiverRunoffExperiment.prototype, "step").mockImplementationOnce(function (this: LiverRunoffExperiment, input) {
      original.call(this, input); throw new Error("injected runoff failure after mutation");
    });
    expect(model.step()).toEqual({ accepted: false, reason: "injected runoff failure after mutation" });
    expect(model.snapshot()).toEqual(before);
    expect(model.step().accepted).toBe(true);
  });

  it("restores committed collection if its commit callback subsequently throws", () => {
    const model = new LiverFlowExperiment(reference()), before = model.snapshot();
    const original = DryCollectorFilm.prototype.prepareStep;
    vi.spyOn(DryCollectorFilm.prototype, "prepareStep").mockImplementationOnce(function (this: DryCollectorFilm, deposits) {
      const prepared = original.call(this, deposits);
      return { ...prepared, commit() { prepared.commit(); throw new Error("injected collector commit failure"); } };
    });
    expect(model.step()).toEqual({ accepted: false, reason: "injected collector commit failure" });
    expect(model.snapshot()).toEqual(before);
    expect(model.step().accepted).toBe(true);
  });
});
