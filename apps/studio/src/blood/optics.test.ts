import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  absorptionFlatteningFactor, ballisticTransmittance, bloodSlabTransport,
  BLOOD_OPTICS_PROVENANCE, composeDiffuseSubstrate, projectPassiveRgb, slabTwoStream,
} from "./optics";
import { bloodOpticsSubstrateFixtures } from "./opticsBench";

const evidence = JSON.parse(readFileSync(new URL("../../../../blood/optics/lut-validation.json", import.meta.url), "utf8")) as {
  maxAbsoluteRgbInterpolationError: number;
  maxSpectralPassivityExcess: number;
  selectedThicknesses: { thicknessM: number; reflectance: number[]; transmittance: number[] }[];
};
const oracle = JSON.parse(readFileSync(new URL("../../../../blood/optics/two-stream-oracle.json", import.meta.url), "utf8")) as {
  cases: { absorptionMInv: number; reducedScatteringMInv: number; thicknessM: number; reflectance: number; transmittance: number }[];
};

describe("blood optical transport", () => {
  it("uses the corrected negative exponential and intracellular absorption in the flattening factor", () => {
    expect(absorptionFlatteningFactor(0, 4e-6)).toBe(1);
    expect(absorptionFlatteningFactor(1e5, 0)).toBe(1);
    expect(absorptionFlatteningFactor(1e5, 1e-5)).toBeCloseTo(0.6321205588285577, 14);
    expect(absorptionFlatteningFactor(1e-6, 1e-6)).toBeCloseTo(1 - .5e-12, 14);
    expect(absorptionFlatteningFactor(1e6, 1)).toBeCloseTo(1e-6, 14);
  });

  it("distinguishes ballistic extinction from reduced-scattering transport", () => {
    // μa=160/m, μs=94610/m: actual unscattered beam, not μs(1-g).
    // Independent 80-digit mpmath exp(-0.9477), rounded to binary64.
    expect(ballisticTransmittance(160, 94610, 1e-5)).toBeCloseTo(0.3876315515231510847, 12);
    expect(ballisticTransmittance(160, 94610, .01)).toBe(0);
    expect(ballisticTransmittance(160, 94610, 0)).toBe(1);
    const first = ballisticTransmittance(160, 94610, 1e-6);
    const second = ballisticTransmittance(160, 94610, 2e-6);
    expect(first * second).toBeCloseTo(ballisticTransmittance(160, 94610, 3e-6), 14);
  });

  it("preserves the empty/vacuum identity without epsilon opacity", () => {
    expect(slabTwoStream(0, 0, 100)).toEqual({ reflectance: 0, transmittance: 1 });
    expect(slabTwoStream(100, 2000, 0)).toEqual({ reflectance: 0, transmittance: 1 });
    expect(bloodSlabTransport(0)).toEqual({ reflectance: [0, 0, 0], transmittance: [1, 1, 1] });
  });

  it("matches pure absorption for the declared ±1/√3 propagation directions", () => {
    const result = slabTwoStream(200, 0, .01);
    expect(result.reflectance).toBe(0);
    expect(result.transmittance).toBeCloseTo(Math.exp(-200 * .01 * Math.sqrt(3)), 14);
  });

  it("conserves flux for a purely scattering slab", () => {
    for (const thickness of [0, 1e-10, 1e-5, .01, 1, 1e10]) {
      const { reflectance, transmittance } = slabTwoStream(0, 20, thickness);
      expect(reflectance + transmittance).toBeCloseTo(1, 14);
      expect(transmittance).toBeCloseTo(1 / (1 + 10 * Math.sqrt(3) * thickness), 14);
    }
  });

  it.each(oracle.cases)("matches independent matrix-exponential boundary solution $absorptionMInv/$reducedScatteringMInv/$thicknessM", (sample) => {
    const result = slabTwoStream(sample.absorptionMInv, sample.reducedScatteringMInv, sample.thicknessM);
    expect(result.reflectance).toBeCloseTo(sample.reflectance, 12);
    expect(result.transmittance).toBeCloseTo(sample.transmittance, 12);
  });

  it("composes adjacent homogeneous slabs including internal exchanges", () => {
    for (const [absorption, scattering] of [[0, 1200], [160, 1400], [24000, 1200], [100, 0]]) {
      const first = slabTwoStream(absorption!, scattering!, 1e-5);
      const second = slabTwoStream(absorption!, scattering!, 2e-5);
      const denominator = 1 - first.reflectance * second.reflectance;
      const combined = slabTwoStream(absorption!, scattering!, 3e-5);
      expect(first.transmittance * second.transmittance / denominator).toBeCloseTo(combined.transmittance, 13);
      expect(first.reflectance + first.transmittance ** 2 * second.reflectance / denominator).toBeCloseTo(combined.reflectance, 13);
    }
  });

  it("remains finite and passive over thin, thick, and high-optical-depth cases", () => {
    for (const absorption of [0, 1e-12, 160, 1e5, 1e12]) {
      for (const scattering of [0, 1e-12, 1400, 1e5, 1e12]) {
        for (const thickness of [0, 1e-15, 1e-6, .01, 1, 1e12]) {
          const { reflectance: r, transmittance: t } = slabTwoStream(absorption, scattering, thickness);
          expect(Number.isFinite(r) && Number.isFinite(t)).toBe(true);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(t).toBeGreaterThanOrEqual(0);
          expect(r + t).toBeLessThanOrEqual(1 + 5e-15);
        }
      }
    }
  });

  it("approaches a fixed semi-infinite reflectance rather than becoming a black opaque paint", () => {
    const small = slabTwoStream(160, 1400, .02);
    const huge = slabTwoStream(160, 1400, 1e12);
    expect(huge.transmittance).toBe(0);
    expect(huge.reflectance).toBeCloseTo(small.reflectance, 12);
    expect(huge.reflectance).toBeGreaterThan(0);
    expect(huge.reflectance).toBeLessThan(1);
  });

  it("projects out-of-gamut RGB explicitly without negative energy or amplification", () => {
    const projected = projectPassiveRgb([-.02, .4, 1.2], [.6, .8, -.1]);
    expect(projected.reflectance).toEqual([0, 1 / 3, 1]);
    expect(projected.transmittance).toEqual([.6, 2 / 3, 0]);
    const extreme = projectPassiveRgb([1e308, 0, 1e308], [1e308, 0, 0]);
    expect(extreme.reflectance).toEqual([.5, 0, 1]);
    expect(extreme.transmittance).toEqual([.5, 0, 0]);
  });

  it("keeps a valid in-gamut response unchanged", () => {
    expect(projectPassiveRgb([.2, 0, .4], [.1, 1, .5])).toEqual({ reflectance: [.2, 0, .4], transmittance: [.1, 1, .5] });
  });

  it("bounds all interpolated RGB responses and very large thicknesses", () => {
    for (let i = 0; i <= 1000; ++i) {
      const thickness = 10 ** (-14 + i * 20 / 1000);
      const result = bloodSlabTransport(thickness);
      for (let c = 0; c < 3; ++c) {
        const r = result.reflectance[c]!, t = result.transmittance[c]!;
        expect(Number.isFinite(r) && Number.isFinite(t)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(r + t).toBeLessThanOrEqual(1 + Number.EPSILON);
      }
    }
    expect(bloodSlabTransport(1e12)).toEqual(bloodSlabTransport(BLOOD_OPTICS_PROVENANCE.maxThicknessM));
  });

  it("matches full spectral integration at independent between-node thicknesses", () => {
    expect(evidence.maxAbsoluteRgbInterpolationError).toBeLessThan(2e-4);
    expect(evidence.maxSpectralPassivityExcess).toBeLessThan(1e-12);
    for (const expected of evidence.selectedThicknesses) {
      const actual = bloodSlabTransport(expected.thicknessM);
      for (let c = 0; c < 3; ++c) {
        expect(Math.abs(actual.reflectance[c]! - expected.reflectance[c]!)).toBeLessThan(2e-4);
        expect(Math.abs(actual.transmittance[c]! - expected.transmittance[c]!)).toBeLessThan(2e-4);
      }
    }
  });

  it.each([-1, NaN, Infinity, -Infinity])("rejects invalid physical inputs (%s)", (invalid) => {
    expect(() => bloodSlabTransport(invalid)).toThrow(RangeError);
    expect(() => slabTwoStream(invalid, 1, 1)).toThrow(RangeError);
    expect(() => slabTwoStream(1, invalid, 1)).toThrow(RangeError);
    expect(() => slabTwoStream(1, 1, invalid)).toThrow(RangeError);
    expect(() => ballisticTransmittance(invalid, 1, 1)).toThrow(RangeError);
    expect(() => ballisticTransmittance(1, invalid, 1)).toThrow(RangeError);
    expect(() => ballisticTransmittance(1, 1, invalid)).toThrow(RangeError);
    expect(() => absorptionFlatteningFactor(invalid, 1)).toThrow(RangeError);
    expect(() => absorptionFlatteningFactor(1, invalid)).toThrow(RangeError);
  });
});

describe("diffuse blood slab over a reflective substrate", () => {
  const repeat = (value: number): [number, number, number] => [value, value, value];
  const compose = (r: number, t: number, s: number) =>
    composeDiffuseSubstrate({ reflectance: repeat(r), transmittance: repeat(t) }, repeat(s))[0];

  it("requires incoming and outgoing traversal for substrate reflection", () => {
    // Two independent traversals of a half-transmitting, nonreflective slab.
    expect(compose(0, .5, .8)).toBeCloseTo(.2, 15);
    expect(compose(0, .5, .8)).not.toBeCloseTo(.4, 15);
  });

  it("matches an independently accumulated sequence of substrate bounces", () => {
    // Propagate flux bounce by bounce instead of evaluating the closed form.
    let incoming = .6, outgoing = .2;
    for (let bounce = 0; bounce < 100; ++bounce) {
      const reflectedBySubstrate = incoming * .7;
      outgoing += reflectedBySubstrate * .6;
      incoming = reflectedBySubstrate * .2;
    }
    expect(compose(.2, .6, .7)).toBeCloseTo(outgoing, 14);
    expect(compose(.2, .6, .7)).toBeCloseTo(.4930232558139535, 14);
  });

  it("preserves vacuum, black substrate, opaque slab, and perfect reflector limits", () => {
    const substrate = [.1, .5, .9] as const;
    expect(composeDiffuseSubstrate(bloodSlabTransport(0), substrate)).toEqual(substrate);
    expect(compose(.2, .7, 0)).toBe(.2);
    expect(compose(.2, 0, .8)).toBe(.2);
    expect(compose(1, 0, 1)).toBe(1); // No unphysical 0/0 from a sealed cavity.
    for (const r of [0, .1, .5, .99, 1 - Number.EPSILON])
      expect(compose(r, 1 - r, 1)).toBeCloseTo(1, 15);
  });

  it("is finite, passive, and monotone in substrate reflectance over the whole LUT", () => {
    for (let i = 0; i <= 1000; ++i) {
      const transport = bloodSlabTransport(10 ** (-14 + 20 * i / 1000));
      const black = composeDiffuseSubstrate(transport, repeat(0));
      const neutral = composeDiffuseSubstrate(transport, repeat(.72));
      const white = composeDiffuseSubstrate(transport, repeat(1));
      for (let c = 0; c < 3; ++c) {
        expect(Number.isFinite(neutral[c]!)).toBe(true);
        expect(black[c]).toBe(transport.reflectance[c]);
        expect(neutral[c]!).toBeGreaterThanOrEqual(black[c]!);
        expect(neutral[c]!).toBeLessThanOrEqual(white[c]!);
        expect(white[c]!).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps near-conservative and subnormal cases finite without epsilon opacity", () => {
    const r = 1 - Number.EPSILON, t = Number.EPSILON;
    expect(compose(r, t, r)).toBeGreaterThanOrEqual(r);
    expect(compose(0, Number.MIN_VALUE, 1)).toBe(0); // Squared flux is below binary64 range.
    expect(compose(0, 1, Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    expect(compose(.5, .5 + Number.EPSILON, 1)).toBe(1); // Addition roundoff only.
  });

  it.each([-1, 1.0001, NaN, Infinity, -Infinity])("rejects invalid RGB components (%s)", invalid => {
    expect(() => compose(invalid, 0, 0)).toThrow(RangeError);
    expect(() => compose(0, invalid, 0)).toThrow(RangeError);
    expect(() => compose(0, 0, invalid)).toThrow(RangeError);
  });

  it("rejects nonpassive transport instead of concealing it by output clamping", () => {
    expect(() => compose(.4, .7, .72)).toThrow(RangeError);
    expect(() => compose(1, 1e-12, 0)).toThrow(RangeError);
  });

  it("preflights every float32 GPU fixture against an independent bounce or limiting-case oracle", () => {
    const fixtures = bloodOpticsSubstrateFixtures();
    expect(fixtures).toHaveLength(16);
    for (const fixture of fixtures) {
      const result = composeDiffuseSubstrate(fixture.transport, fixture.substrate);
      for (let channel = 0; channel < 3; ++channel) {
        expect(result[channel]).toBeGreaterThanOrEqual(0);
        expect(result[channel]).toBeLessThanOrEqual(1);
        expect(Math.abs(result[channel]! - fixture.oracle[channel]!)).toBeLessThan(1e-12);
      }
    }
  });
});
