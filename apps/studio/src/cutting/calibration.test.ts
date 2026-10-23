import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSyntheticCuttingObservation, inferCuttingObservation, parseCuttingModel, parseCuttingObservation } from "./calibration";
const envelope = JSON.parse(readFileSync(new URL("../../public/models/cutting-v1/model.json", import.meta.url), "utf8"));
const model = parseCuttingModel(JSON.parse(envelope.payload), envelope.sha256);
describe("cutting coupon calibration", () => {
  it("loads hashed safe JSON and matches frozen Python inference", () => {
    expect(createHash("sha256").update(envelope.payload).digest("hex")).toBe(envelope.sha256);
    const parity = JSON.parse(readFileSync(new URL("../../../../artifacts/cutting-learning-2026-10-20/browser-parity.json", import.meta.url), "utf8"));
    const result = inferCuttingObservation(model, parity.observation);
    expect(result.accepted).toBe(true); expect(result.humanLiverValidated).toBe(false);
    expect(result.modelId).toBe(parity.modelId);
    expect(result.parameters.fractureEnergyJm2 / parity.result.parameters.fractureEnergyJm2).toBeCloseTo(1, 7);
    expect(result.parameters.peakTractionPa / parity.result.parameters.peakTractionPa).toBeCloseTo(1, 7);
    expect(result.conditionNumber).toBeCloseTo(parity.result.conditionNumber, 5);
    expect(result.neuralParameters.fractureEnergyJm2).toBeCloseTo(parity.result.neuralParameters.fractureEnergyJm2, 8);
    expect(result.residualNrmse).toBeLessThan(1e-7);
    for (const row of parity.additional) {
      const browser = inferCuttingObservation(model, row.observation);
      expect(browser.accepted).toBe(row.result.accepted);
      expect(browser.reasons).toEqual(row.result.reasons);
      expect(browser.parameters.fractureEnergyJm2 / row.result.parameters.fractureEnergyJm2).toBeCloseTo(1, 7);
      expect(browser.parameters.peakTractionPa / row.result.parameters.peakTractionPa).toBeCloseTo(1, 7);
      expect(browser.residualNrmse).toBeCloseTo(row.result.residualNrmse, 8);
    }
  });
  it("reconstructs the full synthetic example and preserves calibrated area scaling", () => {
    const o = createSyntheticCuttingObservation(), fit = inferCuttingObservation(model, o);
    expect(fit.parameters.fractureEnergyJm2).toBeCloseTo(20, 5); expect(fit.parameters.peakTractionPa).toBeCloseTo(16000, 2);
    expect(fit.neuralUncertainty.fractureEnergyJm2).toBeGreaterThanOrEqual(0);
    expect(fit.neuralUncertainty.peakTractionPa).toBeGreaterThanOrEqual(0);
    expect(fit.parameterIntervals90.fractureEnergyJm2[0]).toBeLessThan(20);
    expect(fit.parameterIntervals90.fractureEnergyJm2[1]).toBeGreaterThan(20);
    expect(fit.parameterIntervals90.peakTractionPa[0]).toBeLessThan(16000);
    expect(fit.parameterIntervals90.peakTractionPa[1]).toBeGreaterThan(16000);
    expect(fit.diagnostics.criticalOpeningMm).toBeCloseTo(2.5, 5);
    expect(fit.diagnostics.onsetOpeningMm).toBeCloseTo(.3, 5);
    expect(fit.diagnostics.specificWorkJm2).toBeCloseTo(20, 2);
    expect(fit.diagnostics.cohesiveLengthScaleMm).toBeCloseTo(6000 * 20 / (16000 ** 2) * 1000, 4);
    const second = inferCuttingObservation(model, { ...o, area_mm2: 100, force_n: o.force_n.map(v => v * 4) });
    expect(second.parameters).toEqual(fit.parameters);
  });
  it("rejects partial failure and incompatible sustained force", () => {
    const o = createSyntheticCuttingObservation();
    const partial = inferCuttingObservation(model, { ...o, opening_mm: o.opening_mm.slice(0, 48), force_n: o.force_n.slice(0, 48) });
    expect(partial.accepted).toBe(false); expect(partial.reasons).toContain("complete_fracture_not_observed");
    const wrong = inferCuttingObservation(model, { ...o, force_n: o.force_n.map((v, i) => v + i / 160 * .2) });
    expect(wrong.accepted).toBe(false);
  });
  it("rejects invalid units, unresolvable samples and malformed weights", () => {
    const o = createSyntheticCuttingObservation();
    expect(() => parseCuttingObservation({ ...o, area_mm2: true })).toThrow();
    expect(() => parseCuttingObservation({ ...o, force_n: [NaN] })).toThrow();
    expect(() => parseCuttingObservation({ ...o, opening_mm: [...Array(160).fill(0), 3.25] })).toThrow(/sparse/);
    expect(() => parseCuttingModel({ ...model, alpha: .3 }, model.modelId)).toThrow();
    expect(() => parseCuttingModel({ ...model, members: [{ malicious: true }] }, model.modelId)).toThrow();
  });
});
