import { describe, expect, it } from "vitest";
import { createOmentalDepotField } from "./depotFields";

describe("anatomical omental morphology field", () => {
  it("is deterministic, seed-sensitive and bounded over thin, broad and tall depots", () => {
    for (const [width, height] of [[60, 180], [180, 80], [250, 300]]) {
      const first = createOmentalDepotField(42, width!, height!);
      const duplicate = createOmentalDepotField(42, width!, height!);
      const next = createOmentalDepotField(43, width!, height!);
      let different = 0;
      for (let y = 0; y <= 24; y++) for (let x = 0; x <= 24; x++) {
        const a = first.sample(x / 24, y / 24), b = duplicate.sample(x / 24, y / 24);
        expect(a).toEqual(b);
        if (a.lipidCoverage !== next.sample(x / 24, y / 24).lipidCoverage) different++;
        for (const value of Object.values(a)) { expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
        expect(a.thicknessScale).toBeGreaterThanOrEqual(.07);
        expect(a.lipidCoverage + a.membraneCoverage).toBeCloseTo(1, 12);
      }
      expect(different).toBeGreaterThan(500);
    }
  });

  it("places vessel paths inside thicker fatty sleeves and retains substantial thin intercord sheets", () => {
    for (const seed of [1, 42, 731, 2026]) {
      const field = createOmentalDepotField(seed, 180, 220);
      const vessels: number[] = [], membranes: number[] = [], sleeve: number[] = [];
      for (let row = 4; row < 100; row++) for (let column = 0; column < 100; column++) {
        const sample = field.sample(column / 100, row / 100);
        if (sample.vesselMask > .8) vessels.push(sample.thicknessScale);
        if (sample.lipidCoverage < .2) membranes.push(sample.thicknessScale);
        if (sample.lipidCoverage > .8) sleeve.push(sample.thicknessScale);
      }
      const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
      expect(vessels.length).toBeGreaterThan(100);
      expect(membranes.length).toBeGreaterThan(400);
      expect(sleeve.length).toBeGreaterThan(1000);
      expect(mean(vessels)).toBeGreaterThan(mean(membranes) * 3);
      expect(mean(sleeve)).toBeGreaterThan(mean(membranes) * 3);
    }
  });

  it("varies continuously across branch endpoints and does not repeat as a texture tile", () => {
    const field = createOmentalDepotField(42, 180, 220);
    let nonRepeating = 0;
    for (let row = 0; row <= 50; row++) for (let column = 0; column <= 50; column++) {
      const u = column / 50, v = row / 50, sample = field.sample(u, v);
      for (const shifted of [field.sample(u + 1e-6, v), field.sample(u, v + 1e-6)]) {
        expect(Math.abs(sample.lipidCoverage - shifted.lipidCoverage)).toBeLessThan(.0002);
        expect(Math.abs(sample.thicknessScale - shifted.thicknessScale)).toBeLessThan(.0002);
      }
      if (Math.abs(sample.lipidCoverage - field.sample(u + .4, v).lipidCoverage) > .1) nonRepeating++;
    }
    expect(nonRepeating).toBeGreaterThan(1000);
  });

  it("rejects nonfinite dimensions and coordinates", () => {
    for (const args of [[NaN, 100, 100], [1.5, 100, 100], [1, 0, 100], [1, 100, Infinity]]) {
      expect(() => createOmentalDepotField(args[0]!, args[1]!, args[2]!)).toThrow(RangeError);
    }
    const field = createOmentalDepotField(1, 100, 100);
    expect(() => field.sample(NaN, .5)).toThrow(RangeError);
    expect(() => field.sample(.5, Infinity)).toThrow(RangeError);
    for (const vesselFootprintMm of [0, -1, NaN, Infinity]) expect(() => createOmentalDepotField(1, 100, 100, { vesselFootprintMm })).toThrow(RangeError);
  });

  it("changes only visual vessel filtering when sampling resolution changes", () => {
    const coarse = createOmentalDepotField(42, 180, 220);
    const fine = createOmentalDepotField(42, 180, 220, { vesselFootprintMm: .12 });
    let coarseArea = 0, fineArea = 0;
    for (let row = 0; row < 100; row++) for (let column = 0; column < 100; column++) {
      const a = coarse.sample(column / 100, row / 100), b = fine.sample(column / 100, row / 100);
      expect(a.lipidCoverage).toBe(b.lipidCoverage);
      expect(a.membraneCoverage).toBe(b.membraneCoverage);
      expect(a.thicknessScale).toBe(b.thicknessScale);
      coarseArea += a.vesselMask; fineArea += b.vesselMask;
    }
    expect(coarseArea).toBeGreaterThan(fineArea * 1.5);
    expect(fineArea).toBeGreaterThan(20);
  });
});
