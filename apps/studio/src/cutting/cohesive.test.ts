import { describe, expect, it } from "vitest";
import { cohesiveParameters, cohesiveResponse } from "./cohesive";
const p = { fractureEnergyJm2: 20, peakTractionPa: 16000 };
describe("irreversible cohesive interface", () => {
  it("integrates to Gc with nonnegative dissipation and exact peak", () => {
    const { delta0M, deltafM } = cohesiveParameters(p);
    expect(cohesiveResponse(delta0M, 0, p).tractionPa).toBeCloseTo(p.peakTractionPa, 9);
    let work = 0, previous = cohesiveResponse(0, 0, p), x0 = 0;
    for (let i = 1; i <= 1000; i++) {
      const x = deltafM * i / 1000, result = cohesiveResponse(x, previous.maximumOpeningM, p);
      work += .5 * (previous.tractionPa + result.tractionPa) * (x - x0);
      expect(result.dissipatedEnergyJm2 + 1e-12).toBeGreaterThanOrEqual(previous.dissipatedEnergyJm2);
      previous = result; x0 = x;
    }
    expect(work).toBeCloseTo(20, 10);
    expect(previous.storedEnergyJm2).toBe(0);
    expect(previous.dissipatedEnergyJm2).toBeCloseTo(20, 10);
  });
  it("unloads without healing, remains open after failure, preserves compression", () => {
    const { deltafM, stiffnessPaPerM } = cohesiveParameters(p), history = .6 * deltafM;
    const loading = cohesiveResponse(history, 0, p), unloading = cohesiveResponse(history / 2, history, p);
    expect(unloading.damage).toBe(loading.damage); expect(unloading.tractionPa).toBeCloseTo(loading.tractionPa / 2, 10);
    expect(unloading.dissipatedEnergyJm2).toBe(loading.dissipatedEnergyJm2);
    expect(cohesiveResponse(history, deltafM, p).tractionPa).toBe(0);
    const compression = cohesiveResponse(-.0001, deltafM, p);
    expect(compression.tractionPa).toBeCloseTo(-.0001 * stiffnessPaPerM, 10);
    expect(compression.storedEnergyJm2).toBeCloseTo(.5 * stiffnessPaPerM * .0001 ** 2, 10);
  });
  it("reports consistent envelope tangent and rejects invalid inputs", () => {
    const x = .001, h = 1e-8;
    const slope = (cohesiveResponse(x + h, 0, p).tractionPa - cohesiveResponse(x - h, 0, p).tractionPa) / (2 * h);
    expect(cohesiveResponse(x, 0, p).tangentPaPerM).toBeCloseTo(slope, 2);
    expect(() => cohesiveResponse(NaN, 0, p)).toThrow(); expect(() => cohesiveResponse(0, -1, p)).toThrow();
    expect(() => cohesiveParameters({ ...p, fractureEnergyJm2: 0 })).toThrow();
  });
});
