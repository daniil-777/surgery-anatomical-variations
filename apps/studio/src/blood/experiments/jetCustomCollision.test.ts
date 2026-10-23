import { describe, expect, it } from "vitest";
import { JetBreakupExperiment, type JetBreakupConfig } from "./jetBreakup";
import type { VesselEmission } from "./vesselSolver";
const config: JetBreakupConfig = { densityKgM3: 1060, viscosityPaS: .00345, surfaceTensionNM: .055,
  initialRelativeAmplitude: .01, minimumWeber: 4, fixedDtSeconds: .002, gravityMS2: [0, -9.81, 0],
  collectionPlaneYM: 0, maxElements: 8192 };
const emission: VesselEmission = { id: 0, holeId: "wound", runId: 0, runVolumeStartM3: 0,
  originM: [0, .1, 0], initialVelocityMS: [0, 1, 0], radiusM: .0002, volumeM3: Math.PI * .0002 ** 2 * .002,
  emissionTimeSeconds: .001, durationSeconds: .002 };
describe("backwards-compatible custom jet receiver", () => {
  it("preserves actual portion durations and aperture radius for an immediate attachment boundary", () => {
    const jet = new JetBreakupExperiment(config);
    const s = jet.step({ timeSeconds: .002, emissions: [emission], collision: { contact: (_o, _v, _g, birth) => ({
      timeSeconds: birth, positionM: [.001, .1, 0], surface: { triangle: 7, barycentric: [.2, .3, .5] },
      sourceAttachment: true,
    }) } });
    const intervals = s.landingEvents.map(e => e.sourceAttachment!);
    expect(intervals.every(i => i.radiusM === emission.radiusM && i.endTimeSeconds > i.startTimeSeconds)).toBe(true);
    expect(intervals.reduce((sum, i) => sum + i.endTimeSeconds - i.startTimeSeconds, 0)).toBeCloseTo(emission.durationSeconds, 15);
    s.landingEvents.forEach(e => expect(e.volumeM3 / (e.sourceAttachment!.endTimeSeconds - e.sourceAttachment!.startTimeSeconds))
      .toBeCloseTo(emission.volumeM3 / emission.durationSeconds, 15));
    intervals[0]!.radiusM = 9;
    expect(jet.snapshot().landingEvents[0]!.sourceAttachment!.radiusM).toBe(emission.radiusM);
    expect(s.landedVolumeM3).toBeCloseTo(emission.volumeM3, 23);
  });
  it("transfers accepted source mass once with independent receiving-surface coordinates", () => {
    const jet = new JetBreakupExperiment(config);
    const s = jet.step({ timeSeconds: .002, emissions: [emission], collision: { contact: (_o, _v, _g, birth) => ({
      timeSeconds: birth, positionM: [.001, .1, 0], surface: { triangle: 7, barycentric: [.2, .3, .5] },
    }) } });
    expect(s.inFlightVolumeM3).toBe(0); expect(s.landedVolumeM3).toBeCloseTo(emission.volumeM3, 24);
    expect(s.landingEvents[0]!.surface).toEqual({ triangle: 7, barycentric: [.2, .3, .5] });
    const coordinates = s.landingEvents[0]!.surface!.barycentric as unknown as number[]; coordinates[0] = 99;
    expect(jet.snapshot().landingEvents[0]!.surface!.barycentric[0]).toBe(.2);
    const next = jet.step({ timeSeconds: .004, emissions: [], collision: { contact: () => undefined } });
    expect(next.landingEvents).toEqual([]); expect(next.landedVolumeM3).toBe(s.landedVolumeM3);
  });
  it("rejects retroactive, nonfinite, invalid barycentric and throwing receivers transactionally", () => {
    const jet = new JetBreakupExperiment(config), before = jet.snapshot();
    const invalid = [
      () => ({ timeSeconds: 0, positionM: [0, .1, 0] as const }),
      () => ({ timeSeconds: .001, positionM: [NaN, .1, 0] as const }),
      () => ({ timeSeconds: .001, positionM: [0, .1, 0] as const, surface: { triangle: 0, barycentric: [0, 0, 0] as const } }),
      () => { throw new Error("receiver rejected"); },
    ];
    for (const contact of invalid) {
      expect(() => jet.step({ timeSeconds: .002, emissions: [emission], collision: { contact } })).toThrow();
      expect(jet.snapshot()).toEqual(before);
    }
  });
});
