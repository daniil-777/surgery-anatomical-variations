import { describe, expect, it } from "vitest";
import {
  advanceFatPronyStress, createFatPronyState, DEFAULT_FAT_MATERIAL, DEFAULT_FAT_PROTOCOL, DEFAULT_FAT_SPECIMEN,
  FAT_MATERIAL_PRESETS, fatAffineDeformation, fatCompressionAtTime, fatDynamicShear, fatElasticResponse,
  runFatCompression, validateFatMaterial, validateFatProtocol,
  type FatMaterialParameters, type FatRampHoldReleaseProtocol,
} from "./physics";

const material = DEFAULT_FAT_MATERIAL;
const protocol = DEFAULT_FAT_PROTOCOL;
const elasticMaterial: FatMaterialParameters = { ...material, relaxation: [] };
const atTime = (result: ReturnType<typeof runFatCompression>, time: number) => result.frames.find(frame => Math.abs(frame.timeSec - time) < 1e-10)!;
const relativeError = (actual: number, expected: number) => Math.abs(actual - expected) / Math.max(1e-12, Math.abs(expected));

describe("fat material units and elastic response", () => {
  it("starts stress-free and reproduces small-strain Young modulus", () => {
    for (const poisson of [0, 0.2, 0.45, 0.49, 0.4999]) {
      const parameters = { ...material, poisson }, epsilon = 1e-7;
      expect(fatElasticResponse(parameters, 0).stressPa).toBe(0);
      const response = fatElasticResponse(parameters, epsilon);
      expect(relativeError(response.stressPa / epsilon, 2 * parameters.shearModulusPa * (1 + poisson))).toBeLessThan(5e-7);
    }
  });

  it("solves traction-free lateral stretch and approaches the incompressible NH limit", () => {
    for (const strain of [0.001, 0.05, 0.2, 0.35]) {
      const response = fatAffineDeformation(strain, 0.49);
      const lambdaL = 2 * material.shearModulusPa * 0.49 / (1 - 2 * 0.49);
      const lateralNumerator = material.shearModulusPa * (response.x ** 2 - 1) + lambdaL * Math.log(response.volumeRatio);
      expect(Math.abs(lateralNumerator)).toBeLessThan(1e-8);
      expect(response.x).toBeGreaterThan(1);
      expect(response.x).toBe(response.z);
      expect(response.volumeRatio).toBeLessThanOrEqual(1);
      expect(response.volumeRatio).toBeGreaterThan(0.98);
      const almostIncompressible = fatElasticResponse({ ...material, poisson: 0.4999 }, strain);
      const stretch = 1 - strain;
      const expectedNominal = material.shearModulusPa * (stretch ** -2 - stretch);
      expect(relativeError(almostIncompressible.stressPa, expectedNominal)).toBeLessThan(0.0003);
      expect(Math.abs(almostIncompressible.volumeRatio - 1)).toBeLessThan(0.0002);
    }
  });

  it("converts mm to SI and distinguishes current from reference area", () => {
    const result = runFatCompression(elasticMaterial);
    expect(result.diagnostics.referenceAreaM2).toBeCloseTo(0.0016, 12);
    expect(result.diagnostics.referenceVolumeM3).toBeCloseTo(0.000032, 12);
    expect(result.diagnostics.massKg).toBeCloseTo(0.0304, 12);
    const compressed = atTime(result, protocol.rampSec);
    expect(compressed.heightMm).toBe(15);
    expect(compressed.currentAreaM2).toBeGreaterThan(result.diagnostics.referenceAreaM2);
    expect(compressed.forceN).toBeCloseTo(compressed.stressPa * result.diagnostics.referenceAreaM2, 12);
    expect(compressed.forceN).toBeCloseTo(compressed.cauchyStressPa * compressed.currentAreaM2, 12);
    expect(compressed.cauchyStressPa).toBeLessThan(compressed.stressPa);
    const wide = runFatCompression(elasticMaterial, protocol, { ...DEFAULT_FAT_SPECIMEN, widthMm: 80 });
    expect(wide.diagnostics.peakForceN).toBeCloseTo(2 * result.diagnostics.peakForceN, 10);
    expect(wide.diagnostics.massKg).toBeCloseTo(2 * result.diagnostics.massKg, 12);
    expect(wide.diagnostics.peakStressPa).toBe(result.diagnostics.peakStressPa);
  });

  it("keeps displacement independent of modulus, density and relaxing stress", () => {
    const soft = runFatCompression(material);
    const stiff = runFatCompression({ ...material, shearModulusPa: material.shearModulusPa * 3, densityKgM3: 1900 });
    expect(stiff.frames.map(frame => [frame.stretch, frame.lateralStretch])).toEqual(soft.frames.map(frame => [frame.stretch, frame.lateralStretch]));
    expect(stiff.diagnostics.peakStressPa).toBeCloseTo(3 * soft.diagnostics.peakStressPa, 8);
    expect(stiff.diagnostics.massKg).toBe(2 * soft.diagnostics.massKg);
    const start = atTime(soft, protocol.rampSec), end = atTime(soft, protocol.rampSec + protocol.holdSec);
    expect(end.stressPa).toBeLessThan(start.stressPa);
    expect(end.stretch).toBe(start.stretch);
    expect(end.lateralStretch).toBe(start.lateralStretch);
  });
});

describe("fat exact Prony recurrence", () => {
  it("matches the analytical multi-branch ideal step relaxation", () => {
    const elasticStress = 10_000;
    let response = advanceFatPronyStress(material, createFatPronyState(material), elasticStress, 0);
    expect(response.stressPa).toBe(elasticStress);
    let time = 0;
    for (const dt of [1e-9, 0.001, 0.1, 1, 4, 25, 100, 2000]) {
      time += dt;
      response = advanceFatPronyStress(material, response.state, elasticStress, dt);
      const expected = elasticStress * (1 - material.relaxation.reduce((sum, branch) => sum + branch.fraction, 0)
        + material.relaxation.reduce((sum, branch) => sum + branch.fraction * Math.exp(-time / branch.tauSec), 0));
      expect(relativeError(response.stressPa, expected)).toBeLessThan(1e-13);
    }
  });

  it("is exact and subdivision-independent for a linear elastic-stress ramp", () => {
    const endStress = 4000, duration = 2.3;
    const expected = endStress * (0.5 + material.relaxation.reduce((sum, branch) => sum + branch.fraction * branch.tauSec / duration * (1 - Math.exp(-duration / branch.tauSec)), 0));
    for (const steps of [1, 3, 10, 1000]) {
      let response = advanceFatPronyStress(material, createFatPronyState(material), 0, 0);
      for (let index = 1; index <= steps; index++) response = advanceFatPronyStress(material, response.state, endStress * index / steps, duration / steps);
      expect(relativeError(response.stressPa, expected)).toBeLessThan(1e-12);
    }
  });

  it("preserves signed tensile reaction after displacement-controlled release", () => {
    let response = advanceFatPronyStress(material, createFatPronyState(material), 1000, 0);
    response = advanceFatPronyStress(material, response.state, 1000, 3000);
    response = advanceFatPronyStress(material, response.state, 0, 0);
    expect(response.stressPa).toBeCloseTo(-500, 10);
    response = advanceFatPronyStress(material, response.state, 0, 3000);
    expect(Math.abs(response.stressPa)).toBeLessThan(1e-30);
    const result = runFatCompression();
    expect(result.diagnostics.minimumStressPa).toBeLessThan(0);
    expect(result.assumptions.join(" ")).toContain("tensile constraint");
  });

  it("does not mutate material or previous branch state", () => {
    const state = Object.freeze({ elasticStressPa: 100, branchStressPa: Object.freeze([10, 20]) });
    const before = JSON.stringify({ material, state });
    const response = advanceFatPronyStress(material, state, 300, 0.1);
    expect(response.state).not.toBe(state);
    expect(JSON.stringify({ material, state })).toBe(before);
  });

  it("returns correct dynamic shear limits and a nonnegative loss modulus", () => {
    expect(fatDynamicShear(material, 0)).toEqual({ storagePa: 4000, lossPa: 0 });
    expect(fatDynamicShear(material, 1e9).storagePa).toBeCloseTo(8000, 8);
    for (const omega of [0.001, 0.01, 0.1, 1, 10, 100, 1000]) {
      const response = fatDynamicShear(material, omega);
      expect(response.storagePa).toBeGreaterThan(4000);
      expect(response.storagePa).toBeLessThanOrEqual(8000);
      expect(response.lossPa).toBeGreaterThan(0);
    }
    expect(fatDynamicShear(elasticMaterial, 10)).toEqual({ storagePa: 8000, lossPa: 0 });
  });
});

describe("fat loading protocols and convergence", () => {
  it("stiffens with ramp rate and relaxes monotonically during a hold", () => {
    const fast = runFatCompression(material, { ...protocol, rampSec: 0.1, stepSec: 0.005 });
    const slow = runFatCompression(material, { ...protocol, rampSec: 10, stepSec: 0.025 });
    expect(fast.diagnostics.peakStressPa).toBeGreaterThan(slow.diagnostics.peakStressPa);
    for (const result of [fast, slow]) {
      const hold = result.frames.filter(frame => frame.phase === "hold");
      for (let i = 1; i < hold.length; i++) expect(hold[i]!.stressPa).toBeLessThanOrEqual(hold[i - 1]!.stressPa);
      expect(result.diagnostics.holdRelaxationRatio).toBeGreaterThan(0.5);
      expect(result.diagnostics.holdRelaxationRatio).toBeLessThan(1);
    }
  });

  it("converges under nonlinear strain-ramp timestep refinement", () => {
    const parameters = { ...protocol, compression: 0.35, rampSec: 0.9, holdSec: 1.1, releaseSec: 0.8, restSec: 0.4 } satisfies FatRampHoldReleaseProtocol;
    const values = [0.15, 0.075, 0.0375, 0.009375].map(stepSec => atTime(runFatCompression(material, { ...parameters, stepSec }), parameters.rampSec).stressPa);
    const reference = values[3]!;
    expect(Math.abs(values[1]! - reference)).toBeLessThan(Math.abs(values[0]! - reference) * 0.3);
    expect(Math.abs(values[2]! - reference)).toBeLessThan(Math.abs(values[1]! - reference) * 0.3);
    expect(relativeError(values[2]!, reference)).toBeLessThan(0.0001);
  });

  it("includes exact protocol events and never exceeds the prescribed range", () => {
    const irregular = { ...protocol, rampSec: 0.73, holdSec: 1.31, releaseSec: 0.47, restSec: 0.26, stepSec: 0.19 };
    const result = runFatCompression(material, irregular);
    for (const event of [0, 0.73, 0.73 + 1.31, 0.73 + 1.31 + 0.47, 0.73 + 1.31 + 0.47 + 0.26]) {
      expect(result.frames.some(frame => frame.timeSec === event)).toBe(true);
    }
    for (let i = 1; i < result.frames.length; i++) {
      expect(result.frames[i]!.timeSec).toBeGreaterThan(result.frames[i - 1]!.timeSec);
      expect(result.frames[i]!.timeSec - result.frames[i - 1]!.timeSec).toBeLessThanOrEqual(irregular.stepSec + 1e-12);
      expect(result.frames[i]!.strain).toBeGreaterThanOrEqual(0);
      expect(result.frames[i]!.strain).toBeLessThanOrEqual(irregular.compression);
    }
    expect(fatCompressionAtTime(irregular, 100).strain).toBe(0);
  });

  it("exhibits cyclic hysteresis with zero closed-cycle work for the elastic control", () => {
    const cyclic = { kind: "cyclic", compression: 0.3, periodSec: 3, cycles: 3, stepSec: 0.01 } as const;
    const viscoelastic = runFatCompression(material, cyclic), elastic = runFatCompression(elasticMaterial, cyclic);
    expect(viscoelastic.diagnostics.loadingWorkDensityJm3).toBeGreaterThan(100);
    expect(Math.abs(elastic.diagnostics.loadingWorkDensityJm3)).toBeLessThan(1e-8);
    expect(viscoelastic.diagnostics.holdRelaxationRatio).toBeNull();
    expect(viscoelastic.frames.at(-1)!.strain).toBe(0);
    expect(viscoelastic.frames.at(-1)!.timeSec).toBe(9);
  });

  it("handles zero compression and zero hold/rest without dividing by zero", () => {
    const result = runFatCompression(material, { ...protocol, compression: 0, holdSec: 0, restSec: 0 });
    expect(result.diagnostics.finite).toBe(true);
    expect(result.diagnostics.holdRelaxationRatio).toBeNull();
    expect(result.frames.every(frame => frame.stressPa === 0 && frame.stretch === 1 && frame.volumeRatio === 1)).toBe(true);
  });

  it("remains finite throughout 72 representative parameter/protocol sweeps", () => {
    let count = 0;
    for (const preset of FAT_MATERIAL_PRESETS) for (const poisson of [0.45, 0.49, 0.4999]) for (const compression of [0, 0.05, 0.2, 0.35]) for (const rampSec of [0.1, 1, 10]) {
      const result = runFatCompression({ ...preset.parameters, poisson }, { ...protocol, compression, rampSec, holdSec: 3, releaseSec: rampSec, restSec: 0.2, stepSec: 0.05 });
      expect(result.diagnostics.finite).toBe(true);
      expect(result.diagnostics.minimumVolumeRatio).toBeGreaterThan(0.94);
      expect(result.diagnostics.maximumVolumeRatio).toBeLessThanOrEqual(1 + 1e-12);
      expect(result.frames.every(frame => frame.currentAreaM2 > 0 && frame.heightMm > 0)).toBe(true);
      count++;
    }
    expect(count).toBe(72);
  });
});

describe("fat model input guards and provenance", () => {
  it("rejects non-finite, unstable and malformed material parameters", () => {
    for (const override of [
      { densityKgM3: NaN }, { densityKgM3: -10 }, { shearModulusPa: Infinity }, { shearModulusPa: 0 },
      { poisson: 0.5 }, { poisson: -0.1 }, { relaxation: [{ fraction: 0.5, tauSec: 0 }] },
      { relaxation: [{ fraction: -0.1, tauSec: 1 }] }, { relaxation: [{ fraction: 1, tauSec: 1 }] },
      { relaxation: [{ fraction: 0.6, tauSec: 1 }, { fraction: 0.4, tauSec: 3 }] },
      { relaxation: [{ fraction: 0.5, tauSec: NaN }] },
    ]) expect(() => validateFatMaterial({ ...material, ...override })).toThrow(RangeError);
    expect(() => advanceFatPronyStress(material, { elasticStressPa: 0, branchStressPa: [] }, 1, 0.01)).toThrow(RangeError);
    expect(() => advanceFatPronyStress(material, createFatPronyState(material), NaN, 0.01)).toThrow(RangeError);
    expect(() => advanceFatPronyStress(material, createFatPronyState(material), 1, -1)).toThrow(RangeError);
  });

  it("rejects invalid protocols, dimensions and excessive allocations", () => {
    for (const override of [{ compression: 0.36 }, { compression: -0.1 }, { rampSec: 0 }, { holdSec: -1 }, { releaseSec: 0 }, { restSec: NaN }, { stepSec: 0 }, { stepSec: 1e-6 }]) {
      expect(() => validateFatProtocol({ ...protocol, ...override })).toThrow(RangeError);
    }
    expect(() => validateFatProtocol({ kind: "cyclic", compression: 0.2, periodSec: 1, cycles: 1.5, stepSec: 0.01 })).toThrow(RangeError);
    expect(() => validateFatProtocol({ kind: "cyclic", compression: 0.2, periodSec: 1, cycles: 2, stepSec: 0.1 })).toThrow(RangeError);
    expect(() => runFatCompression(material, protocol, { ...DEFAULT_FAT_SPECIMEN, heightMm: 0 })).toThrow(RangeError);
    expect(() => fatAffineDeformation(0.5, 0.49)).toThrow(RangeError);
    expect(() => fatCompressionAtTime(protocol, -1)).toThrow(RangeError);
  });

  it("exposes uncalibrated model assumptions and preserves caller snapshots", () => {
    const inputMaterial = { ...material, relaxation: material.relaxation.map(branch => ({ ...branch })) };
    const inputProtocol = { ...protocol };
    const result = runFatCompression(inputMaterial, inputProtocol);
    inputMaterial.relaxation[0]!.fraction = 0.01;
    inputProtocol.compression = 0.1;
    expect(result.material.relaxation[0]!.fraction).toBe(0.25);
    expect(result.protocol.compression).toBe(0.25);
    expect(result.assumptions.join(" ")).toContain("not fitted or clinically validated");
    expect(FAT_MATERIAL_PRESETS.every(preset => preset.provenance.includes("not a fit"))).toBe(true);
  });
});
