import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bloodSlabTransport, composeDiffuseSubstrate } from "../optics";
import { BLOOD_APPEARANCE_PROVENANCE, BLOOD_OXYGENATION_DEFAULTS, bloodAppearanceTransport } from "./bloodAppearanceOptics";
import { APPEARANCE_LUT_BASE64 } from "./bloodAppearanceLut.generated";

interface OpticalCase {
  thicknessM: number;
  oxygenationFraction: number;
  reflectance: number[];
  transmittance: number[];
}
const evidence = JSON.parse(readFileSync(new URL("../../../../../blood/optics/appearance-lut-validation.json", import.meta.url), "utf8")) as {
  maxAbsoluteRgbInterpolationError: number; maxSpectralPassivityExcess: number; offNodeInterpolationProbes: number;
  storedSha256: string; sourceSha256: Record<string, string>; selectedSpectralSolutions: OpticalCase[];
};
const oracle = JSON.parse(readFileSync(new URL("../../../../../blood/optics/appearance-matrix-oracle.json", import.meta.url), "utf8")) as {
  maxSpectralPassivityExcess: number; sourceCsvSha256: string; cases: OpticalCase[];
};

describe("experimental spectral oxygenation appearance", () => {
  it("retains the attributed source and generated-byte integrity", () => {
    const csv = readFileSync(new URL("../../../../../blood/optics/data/bosschaart2014-oxygenation-visible.csv", import.meta.url));
    const hash = createHash("sha256").update(csv).digest("hex");
    expect(hash).toBe(oracle.sourceCsvSha256);
    expect(hash).toBe(evidence.sourceSha256["bosschaart2014-oxygenation-visible.csv"]);
    expect(createHash("sha256").update(Buffer.from(APPEARANCE_LUT_BASE64, "base64")).digest("hex")).toBe(evidence.storedSha256);
    expect(BLOOD_APPEARANCE_PROVENANCE.conditions).toContain(">98%");
    expect(BLOOD_APPEARANCE_PROVENANCE.limitations).toContain("approximation");
    expect(BLOOD_OXYGENATION_DEFAULTS).toEqual({ artery: .98, vein: .75 });
  });

  it("meets the off-node spectral interpolation gate without declaring physical accuracy", () => {
    expect(evidence.offNodeInterpolationProbes).toBeGreaterThan(250000);
    expect(evidence.maxAbsoluteRgbInterpolationError).toBeLessThan(5e-4);
    expect(evidence.maxSpectralPassivityExcess).toBeLessThan(1e-12);
    expect(oracle.maxSpectralPassivityExcess).toBeLessThan(1e-12);
  });

  it.each(oracle.cases)("matches independent matrix-layer transport at $oxygenationFraction / $thicknessM m", sample => {
    const result = bloodAppearanceTransport(sample.thicknessM, sample.oxygenationFraction);
    for (let c = 0; c < 3; ++c) {
      expect(Math.abs(result.reflectance[c]! - sample.reflectance[c]!)).toBeLessThan(5e-4);
      expect(Math.abs(result.transmittance[c]! - sample.transmittance[c]!)).toBeLessThan(5e-4);
    }
  });

  it("independent matrix and closed-form spectral references agree more closely than the LUT budget", () => {
    for (const sample of oracle.cases) {
      const direct = evidence.selectedSpectralSolutions.find(p => p.thicknessM === sample.thicknessM && p.oxygenationFraction === sample.oxygenationFraction);
      if (!direct) continue;
      for (let c = 0; c < 3; ++c) {
        expect(Math.abs(sample.reflectance[c]! - direct.reflectance[c]!)).toBeLessThan(2e-10);
        expect(Math.abs(sample.transmittance[c]! - direct.transmittance[c]!)).toBeLessThan(2e-10);
      }
    }
  });

  it("preserves the existing oxygenated endpoint and does not change core optics", () => {
    for (let i = 0; i <= 200; ++i) {
      const thickness = 1e-6 * Math.expm1(Math.log1p(.05 / 1e-6) * i / 200);
      const old = bloodSlabTransport(thickness), current = bloodAppearanceTransport(thickness, 1);
      for (let c = 0; c < 3; ++c) {
        expect(Math.abs(current.reflectance[c]! - old.reflectance[c]!)).toBeLessThan(6e-8);
        expect(Math.abs(current.transmittance[c]! - old.transmittance[c]!)).toBeLessThan(6e-8);
      }
    }
  });

  it("is passive and finite at interpolation boundaries and extreme path lengths", () => {
    for (const d of [0, Number.MIN_VALUE, 1e-15, 1e-8, .0001, .001, .012, .05, 1, Number.MAX_VALUE]) {
      for (const s of [0, Number.EPSILON, .001, .37, .6, .75, .98, 1 - Number.EPSILON, 1]) {
        const { reflectance: r, transmittance: t } = bloodAppearanceTransport(d, s);
        for (let c = 0; c < 3; ++c) {
          expect(Number.isFinite(r[c]) && Number.isFinite(t[c])).toBe(true);
          expect(r[c]).toBeGreaterThanOrEqual(0);
          expect(t[c]).toBeGreaterThanOrEqual(0);
          expect(r[c]! + t[c]!).toBeLessThanOrEqual(1 + Number.EPSILON);
        }
        const backing = composeDiffuseSubstrate({ reflectance: r, transmittance: t }, [.18, .18, .18]);
        expect(backing.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
      }
    }
  });

  it("has exact empty-film identity and the documented opaque thickness saturation", () => {
    for (const s of [0, .37, .75, .98, 1]) {
      expect(bloodAppearanceTransport(0, s)).toEqual({ reflectance: [0, 0, 0], transmittance: [1, 1, 1] });
      expect(bloodAppearanceTransport(Number.MAX_VALUE, s)).toEqual(bloodAppearanceTransport(.05, s));
      expect(Math.max(...bloodAppearanceTransport(.05, s).transmittance)).toBeLessThan(1e-15);
    }
  });

  it("produces darker venous diffuse red under the specified equal D65 illumination and thick-path conditions", () => {
    // This is a conditional spectral-model result, not a universal camera pixel
    // ordering: light position, specular highlights, and exposure can reverse it.
    for (const d of [.001, .012]) {
      const vein = bloodAppearanceTransport(d, .75).reflectance;
      const artery = bloodAppearanceTransport(d, .98).reflectance;
      const luminance = (rgb: readonly number[]) => .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
      expect(vein[0]).toBeLessThan(artery[0]);
      expect(luminance(vein)).toBeLessThan(luminance(artery));
      expect(vein[0]).toBeGreaterThan(vein[1]! + vein[2]!);
    }
  });

  it("rejects invalid values instead of silently reinterpreting material conditions", () => {
    for (const d of [-1, NaN, Infinity, -Infinity])
      expect(() => bloodAppearanceTransport(d, .75)).toThrow(RangeError);
    for (const s of [-Number.EPSILON, 1 + Number.EPSILON, NaN, Infinity, -Infinity])
      expect(() => bloodAppearanceTransport(.001, s)).toThrow(RangeError);
  });
});
