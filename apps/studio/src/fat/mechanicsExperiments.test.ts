import { describe, expect, it } from "vitest";
import {
  advanceFatPronyStress, createFatPronyState, DEFAULT_FAT_MATERIAL, DEFAULT_FAT_PROTOCOL, DEFAULT_FAT_SPECIMEN,
  FAT_MATERIAL_PRESETS, fatDynamicShear, fatElasticResponse, type FatMaterialParameters,
} from "./physics";
import {
  advanceFatCreepState, compareFatMaterialExperiments, DEFAULT_FAT_CREEP_PROTOCOL, FAT_CREEP_MAX_STRAIN,
  FatCreepDomainError, fatCreepStressCapacityPa, fatStressAtTime, runFatCreep, validateFatStressProtocol,
  type FatCreepProtocol, type FatCreepResult, type FatStressProtocol,
} from "./mechanicsExperiments";

const material = DEFAULT_FAT_MATERIAL;
const elastic: FatMaterialParameters = { ...material, relaxation: [] };
const singleBranch: FatMaterialParameters = { ...material, relaxation: [{ fraction: 0.4, tauSec: 2 }] };
const brief: FatCreepProtocol = { ...DEFAULT_FAT_CREEP_PROTOCOL, rampSec: 0.4, holdSec: 3, releaseSec: 0.7, recoverySec: 6, stepSec: 0.05 };
const atTime = (result: FatCreepResult, timeSec: number) => result.frames.find(frame => Math.abs(frame.timeSec - timeSec) < 1e-10)!;
const relativeError = (actual: number, expected: number) => Math.abs(actual - expected) / Math.max(1e-14, Math.abs(expected));

function idealStep(materialParameters: FatMaterialParameters, stressPa: number, duration: number, stepSec: number) {
  let response = advanceFatCreepState(materialParameters, createFatPronyState(materialParameters), stressPa, 0);
  const steps = Math.round(duration / stepSec);
  for (let i = 0; i < steps; i++) response = advanceFatCreepState(materialParameters, response.state, stressPa, duration / steps);
  return response;
}

describe("stress-controlled constitutive inversion", () => {
  it("reconstructs the prescribed stress through the production recurrence without changing previous state", () => {
    let state = createFatPronyState(material);
    for (const [strain, dt] of [[0.03, 0], [0.12, 0.1], [0.18, 2], [0.18, 30], [0.13, 0.4]] as const) {
      const before = JSON.stringify(state);
      const forward = advanceFatPronyStress(material, state, fatElasticResponse(material, strain).stressPa, dt);
      const inverse = advanceFatCreepState(material, state, forward.stressPa, dt);
      expect(inverse.strain).toBeCloseTo(strain, 10);
      expect(Math.abs(inverse.stressResidualPa)).toBeLessThan(1e-7);
      expect(inverse.state.branchStressPa).toHaveLength(material.relaxation.length);
      inverse.state.branchStressPa.forEach((value, i) => expect(value).toBeCloseTo(forward.state.branchStressPa[i]!, 6));
      expect(JSON.stringify(state)).toBe(before);
      state = inverse.state;
    }
  });

  it("matches the nonlinear SLS analytical creep in elastic-stress coordinates with second-order convergence", () => {
    const stressPa = 1200, timeSec = 4, fraction = 0.4, tauSec = 2;
    const expectedElasticStress = stressPa / (1 - fraction) * (1 - fraction * Math.exp(-(1 - fraction) * timeSec / tauSec));
    const errors = [0.4, 0.2, 0.1, 0.05].map(stepSec => Math.abs(idealStep(singleBranch, stressPa, timeSec, stepSec).elasticStressPa - expectedElasticStress));
    for (let i = 1; i < errors.length; i++) expect(errors[i]!).toBeLessThan(errors[i - 1]! * 0.26);
    expect(errors.at(-1)! / expectedElasticStress).toBeLessThan(2e-5);
  });

  it("recovers the analytical small-strain creep compliance and distinct retardation time", () => {
    const stressPa = 0.02, timeSec = 5, g = 0.4, tau = 2;
    const youngPa = 2 * singleBranch.shearModulusPa * (1 + singleBranch.poisson);
    const initial = advanceFatCreepState(singleBranch, createFatPronyState(singleBranch), stressPa, 0);
    const final = idealStep(singleBranch, stressPa, timeSec, 0.01);
    const expected = stressPa / youngPa / (1 - g) * (1 - g * Math.exp(-(1 - g) * timeSec / tau));
    expect(relativeError(initial.strain, stressPa / youngPa)).toBeLessThan(1e-5);
    expect(relativeError(final.strain, expected)).toBeLessThan(1e-5);
    // Retardation tau/(1-g), rather than relaxation tau, is required under load control.
    const incorrectRelaxationTime = stressPa / youngPa / (1 - g) * (1 - g * Math.exp(-timeSec / tau));
    expect(Math.abs(final.strain - expected)).toBeLessThan(Math.abs(final.strain - incorrectRelaxationTime) * 0.001);
  });

  it("computes analytical zero-load recovery after a held ideal step", () => {
    const stressPa = 1000, heldSec = 4, recoveredSec = 6, g = 0.4, tau = 2;
    const loaded = idealStep(singleBranch, stressPa, heldSec, 0.01);
    let recovery = advanceFatCreepState(singleBranch, loaded.state, 0, 0);
    expect(recovery.elasticStressPa).toBeCloseTo(loaded.elasticStressPa - stressPa, 6);
    const immediateStrain = recovery.strain;
    for (let i = 0; i < 600; i++) recovery = advanceFatCreepState(singleBranch, recovery.state, 0, 0.01);
    const expected = stressPa * g / (1 - g) * (1 - Math.exp(-(1 - g) * heldSec / tau)) * Math.exp(-(1 - g) * recoveredSec / tau);
    expect(relativeError(recovery.elasticStressPa, expected)).toBeLessThan(1e-5);
    expect(recovery.strain).toBeGreaterThan(0);
    expect(recovery.strain).toBeLessThan(immediateStrain);
    expect(Math.abs(recovery.stressPa)).toBeLessThan(1e-7);
  });
});

describe("creep coupon protocols, SI units and recovery", () => {
  it("tracks nominal load, expands lateral area and preserves both force definitions", () => {
    const result = runFatCreep(material, brief);
    expect(result.diagnostics.finite).toBe(true);
    expect(result.diagnostics.referenceAreaM2).toBeCloseTo(0.0016, 12);
    expect(result.diagnostics.referenceVolumeM3).toBeCloseTo(0.000032, 12);
    expect(result.diagnostics.massKg).toBeCloseTo(0.0304, 12);
    expect(result.diagnostics.maximumStressResidualPa).toBeLessThan(1e-7);
    for (const frame of result.frames) {
      expect(frame.stressPa).toBeCloseTo(frame.targetStressPa, 6);
      expect(frame.forceN).toBeCloseTo(frame.stressPa * result.diagnostics.referenceAreaM2, 12);
      expect(frame.forceN).toBeCloseTo(frame.cauchyStressPa * frame.currentAreaM2, 12);
      expect(frame.heightMm).toBeCloseTo(DEFAULT_FAT_SPECIMEN.heightMm * (1 - frame.strain), 12);
      expect(frame.volumeRatio).toBeCloseTo(frame.stretch * frame.lateralStretch ** 2, 12);
      expect(frame.volumeRatio).toBeGreaterThan(0.99);
    }
    const loaded = atTime(result, brief.rampSec + brief.holdSec);
    expect(loaded.currentAreaM2).toBeGreaterThan(result.diagnostics.referenceAreaM2);
    expect(loaded.cauchyStressPa).toBeLessThan(loaded.stressPa);
    const wider = runFatCreep(material, brief, { ...DEFAULT_FAT_SPECIMEN, widthMm: 80 });
    expect(wider.frames.map(frame => frame.strain)).toEqual(result.frames.map(frame => frame.strain));
    expect(wider.diagnostics.peakForceN).toBeCloseTo(2 * result.diagnostics.peakForceN, 10);
  });

  it("produces monotone creep during a hold and free recovery at zero load", () => {
    const result = runFatCreep();
    const protocol = DEFAULT_FAT_CREEP_PROTOCOL;
    const held = result.frames.filter(frame => frame.timeSec >= protocol.rampSec && frame.timeSec <= protocol.rampSec + protocol.holdSec);
    const recovered = result.frames.filter(frame => frame.timeSec >= protocol.rampSec + protocol.holdSec + protocol.releaseSec);
    for (let i = 1; i < held.length; i++) expect(held[i]!.strain).toBeGreaterThanOrEqual(held[i - 1]!.strain - 1e-12);
    for (let i = 1; i < recovered.length; i++) expect(recovered[i]!.strain).toBeLessThanOrEqual(recovered[i - 1]!.strain + 1e-12);
    expect(result.diagnostics.holdCreepRatio).toBeGreaterThan(1.3);
    expect(result.diagnostics.recoveryFraction).toBeGreaterThan(0.85);
    expect(result.diagnostics.recoveryFraction).toBeLessThan(1);
    expect(result.diagnostics.residualStrain).toBeGreaterThan(0);
    expect(result.diagnostics.holdRelaxationRatio).toBeNull();
    expect(result.diagnostics.peakStrain).toBeLessThan(FAT_CREEP_MAX_STRAIN);
    expect(fatCreepStressCapacityPa(material)).toBeGreaterThan(4 * protocol.targetStressPa);
  });

  it("changes strain with stiffness and history while density changes mass only", () => {
    const reference = runFatCreep(material, brief);
    const stiff = runFatCreep({ ...material, shearModulusPa: material.shearModulusPa * 2 }, brief);
    const dense = runFatCreep({ ...material, densityKgM3: material.densityKgM3 * 2 }, brief);
    expect(stiff.diagnostics.peakStrain).toBeLessThan(reference.diagnostics.peakStrain);
    expect(stiff.diagnostics.peakForceN).toBeCloseTo(reference.diagnostics.peakForceN, 8);
    expect(dense.frames).toEqual(reference.frames);
    expect(dense.diagnostics.massKg).toBe(2 * reference.diagnostics.massKg);
    const noHistory = runFatCreep(elastic, brief);
    expect(noHistory.diagnostics.holdCreepRatio).toBeCloseTo(1, 12);
    expect(noHistory.diagnostics.residualStrain).toBe(0);
    expect(noHistory.diagnostics.recoveryFraction).toBe(1);
  });

  it("resolves exact events and converges with nonlinear ramp/hold/release refinement", () => {
    const parameters: FatCreepProtocol = { ...brief, rampSec: 0.73, holdSec: 1.31, releaseSec: 0.47, recoverySec: 0.26, stepSec: 0.19 };
    const result = runFatCreep(material, parameters);
    const events = [0, parameters.rampSec, parameters.rampSec + parameters.holdSec, parameters.rampSec + parameters.holdSec + parameters.releaseSec,
      parameters.rampSec + parameters.holdSec + parameters.releaseSec + parameters.recoverySec];
    for (const event of events) expect(result.frames.some(frame => frame.timeSec === event)).toBe(true);
    for (let i = 1; i < result.frames.length; i++) {
      expect(result.frames[i]!.timeSec).toBeGreaterThan(result.frames[i - 1]!.timeSec);
      expect(result.frames[i]!.timeSec - result.frames[i - 1]!.timeSec).toBeLessThanOrEqual(parameters.stepSec + 1e-12);
    }
    const protocol: FatCreepProtocol = { ...brief, rampSec: 0.8, holdSec: 1.2, releaseSec: 0.8, recoverySec: 0.4 };
    const results = [0.2, 0.1, 0.05, 0.00625].map(stepSec => runFatCreep(material, { ...protocol, stepSec }));
    for (const event of [0.8, 2, 2.8, 3.2]) {
      const reference = atTime(results[3]!, event).strain;
      const errors = results.slice(0, 3).map(run => Math.abs(atTime(run, event).strain - reference));
      expect(errors[1]!).toBeLessThan(errors[0]! * 0.3);
      expect(errors[2]!).toBeLessThan(errors[1]! * 0.3);
      expect(errors[2]!).toBeLessThan(2e-6);
    }
    expect(fatStressAtTime(parameters, 100).stressPa).toBe(0);
  });

  it("keeps zero-load runs and zero-duration holds/recovery well-defined", () => {
    const result = runFatCreep(material, { ...brief, targetStressPa: 0, holdSec: 0, recoverySec: 0 });
    expect(result.frames.every(frame => frame.strain === 0 && frame.stressPa === 0 && frame.volumeRatio === 1)).toBe(true);
    expect(result.diagnostics.holdCreepRatio).toBeNull();
    expect(result.diagnostics.recoveryFraction).toBeNull();
    expect(result.diagnostics.finite).toBe(true);
  });
});

describe("stress cycles and shared material/rate comparisons", () => {
  it("matches small-strain steady-cycle compliance loss and the zero-loss elastic control", () => {
    const parameters = { ...singleBranch, relaxation: [{ fraction: 0.4, tauSec: 0.4 }] };
    const protocol = { kind: "stress-cyclic", targetStressPa: 1, periodSec: 5, cycles: 8, stepSec: 0.01 } as const;
    const result = runFatCreep(parameters, protocol), control = runFatCreep({ ...parameters, relaxation: [] }, protocol);
    const lastCycle = result.frames.filter(frame => frame.timeSec >= protocol.periodSec * (protocol.cycles - 1));
    let work = 0;
    for (let i = 1; i < lastCycle.length; i++) work += 0.5 * (lastCycle[i]!.stressPa + lastCycle[i - 1]!.stressPa) * (lastCycle[i]!.strain - lastCycle[i - 1]!.strain);
    const shear = fatDynamicShear(parameters, 2 * Math.PI / protocol.periodSec);
    const storage = 2 * (1 + parameters.poisson) * shear.storagePa, loss = 2 * (1 + parameters.poisson) * shear.lossPa;
    const expected = Math.PI * (protocol.targetStressPa / 2) ** 2 * loss / (storage ** 2 + loss ** 2);
    expect(work).toBeGreaterThan(0);
    expect(relativeError(work, expected)).toBeLessThan(0.0003);
    expect(Math.abs(control.diagnostics.loadingWorkDensityJm3)).toBeLessThan(1e-11);
    expect(result.diagnostics.holdCreepRatio).toBeNull();
    expect(result.frames.at(-1)!.strain).toBeGreaterThan(0);
    expect(result.frames.at(-1)!.timeSec).toBe(40);
  });

  it("compares three loading rates at identical load and strain across two materials", () => {
    const comparison = compareFatMaterialExperiments(FAT_MATERIAL_PRESETS, {
      creepProtocol: brief,
      compressionProtocol: { ...DEFAULT_FAT_PROTOCOL, holdSec: 2, releaseSec: 1, restSec: 1, stepSec: 0.025 },
      rampTimesSec: [0.1, 1, 10],
    });
    expect(comparison).toHaveLength(2);
    for (const entry of comparison) {
      expect(entry.creep.diagnostics.holdCreepRatio).toBeGreaterThan(1);
      expect(entry.relaxation.diagnostics.holdRelaxationRatio).toBeLessThan(1);
      const peaks = entry.compressionRates.map(rate => rate.result.diagnostics.peakStressPa);
      expect(peaks[0]!).toBeGreaterThan(peaks[1]!);
      expect(peaks[1]!).toBeGreaterThan(peaks[2]!);
      expect(entry.compressionRates.map(rate => rate.rampSec)).toEqual([0.1, 1, 10]);
      expect(entry.compressionRates.every(rate => rate.result.protocol.compression === DEFAULT_FAT_PROTOCOL.compression)).toBe(true);
    }
    expect(comparison[1]!.creep.diagnostics.peakStrain).toBeLessThan(comparison[0]!.creep.diagnostics.peakStrain);
    expect(comparison[1]!.creep.diagnostics.peakStressPa).toBeCloseTo(comparison[0]!.creep.diagnostics.peakStressPa, 6);
    const slower = [0.1, 1, 10].map(rampSec => runFatCreep(material, { ...brief, rampSec, stepSec: 0.005 }));
    const endRamp = slower.map((result, index) => atTime(result, [0.1, 1, 10][index]!).strain);
    expect(endRamp[0]!).toBeLessThan(endRamp[1]!);
    expect(endRamp[1]!).toBeLessThan(endRamp[2]!);
  });

  it("stays finite and tracks load over 72 stiffness, compressibility, spectrum and load combinations", () => {
    let count = 0;
    for (const shearModulusPa of [1000, 8000]) for (const poisson of [0, 0.45, 0.49, 0.4999]) for (const fractionScale of [0, 0.5, 1.5]) for (const loadFraction of [0.05, 0.25, 0.75]) {
      const parameters = { ...material, shearModulusPa, poisson, relaxation: material.relaxation.map(branch => ({ ...branch, fraction: branch.fraction * fractionScale })) };
      const result = runFatCreep(parameters, { ...brief, targetStressPa: fatCreepStressCapacityPa(parameters) * loadFraction, holdSec: 1, recoverySec: 1, stepSec: 0.1 });
      expect(result.diagnostics.finite).toBe(true);
      expect(result.diagnostics.maximumStressResidualPa).toBeLessThan(1e-6);
      expect(result.diagnostics.peakStrain).toBeGreaterThan(0);
      expect(result.diagnostics.peakStrain).toBeLessThan(FAT_CREEP_MAX_STRAIN);
      expect(result.diagnostics.residualStrain).toBeLessThan(result.diagnostics.peakStrain);
      expect(result.frames.every(frame => frame.currentAreaM2 > 0 && frame.heightMm > 0)).toBe(true);
      count++;
    }
    expect(count).toBe(72);
  });
});

describe("load-control domain, guards and interpretation", () => {
  it("rejects unsupported loads instead of silently clipping strain", () => {
    const instantaneousCapacity = fatElasticResponse(material, FAT_CREEP_MAX_STRAIN).stressPa;
    expect(() => advanceFatCreepState(material, createFatPronyState(material), instantaneousCapacity * 1.01, 0)).toThrow(FatCreepDomainError);
    const protocol: FatCreepProtocol = { ...brief, targetStressPa: fatCreepStressCapacityPa(singleBranch) * 1.1, rampSec: 0.1, holdSec: 30, stepSec: 0.1 };
    try { runFatCreep(singleBranch, protocol); expect.fail("The held load must eventually exceed the model domain."); }
    catch (error) {
      expect(error).toBeInstanceOf(FatCreepDomainError);
      const domain = error as FatCreepDomainError;
      expect(domain.timeSec).toBeGreaterThan(protocol.rampSec);
      expect(domain.requestedStressPa).toBeGreaterThan(domain.maximumStressPa);
      expect(domain.maximumStrain).toBe(0.35);
      expect(domain.message).toContain("strain was not clipped");
    }
  });

  it("rejects malformed states, invalid inputs, coarse cycles and excessive allocation", () => {
    for (const override of [{ targetStressPa: NaN }, { targetStressPa: -1 }, { rampSec: 0 }, { holdSec: -1 }, { releaseSec: 0 }, { recoverySec: Infinity }, { stepSec: 0 }, { stepSec: 1e-6 }]) {
      expect(() => validateFatStressProtocol({ ...DEFAULT_FAT_CREEP_PROTOCOL, ...override })).toThrow(RangeError);
    }
    expect(() => validateFatStressProtocol({ kind: "unknown" } as unknown as FatStressProtocol)).toThrow(RangeError);
    expect(() => validateFatStressProtocol({ kind: "stress-cyclic", targetStressPa: 10, periodSec: 1, cycles: 1.5, stepSec: 0.01 })).toThrow(RangeError);
    expect(() => validateFatStressProtocol({ kind: "stress-cyclic", targetStressPa: 10, periodSec: 1, cycles: 1, stepSec: 0.1 })).toThrow(RangeError);
    expect(() => advanceFatCreepState(material, { elasticStressPa: 0, branchStressPa: [] }, 1, 0.1)).toThrow(RangeError);
    expect(() => advanceFatCreepState(material, createFatPronyState(material), 1, -1)).toThrow(RangeError);
    expect(() => advanceFatCreepState({ ...material, poisson: 0.5 }, createFatPronyState(material), 1, 1)).toThrow(RangeError);
    expect(() => runFatCreep(material, brief, { ...DEFAULT_FAT_SPECIMEN, widthMm: 0 })).toThrow(RangeError);
    expect(() => fatStressAtTime(brief, -1)).toThrow(RangeError);
    expect(() => compareFatMaterialExperiments([])).toThrow(RangeError);
    expect(() => compareFatMaterialExperiments([FAT_MATERIAL_PRESETS[0]!, FAT_MATERIAL_PRESETS[0]!])).toThrow(RangeError);
    expect(() => compareFatMaterialExperiments(FAT_MATERIAL_PRESETS, { rampTimesSec: [1, 1] })).toThrow(RangeError);
  });

  it("retains numerical precision over 45 extreme allowed parameter combinations, including unloaded stiff recovery", () => {
    let count = 0;
    for (const shearModulusPa of [1, 1000, 8000, 1e6, 1e9]) for (const loadFraction of [1e-6, 0.1, 0.99]) for (const poisson of [0, 0.49, 0.4999]) {
      const parameters = { ...material, shearModulusPa, poisson };
      const targetStressPa = fatCreepStressCapacityPa(parameters) * loadFraction;
      const result = runFatCreep(parameters, { ...brief, targetStressPa, holdSec: 2, recoverySec: 5, stepSec: 0.1 });
      expect(result.diagnostics.finite).toBe(true);
      expect(result.diagnostics.maximumStressResidualPa).toBeLessThan(Math.max(1e-8, targetStressPa * 2e-10, shearModulusPa * 1e-13));
      expect(result.diagnostics.peakStrain).toBeLessThan(FAT_CREEP_MAX_STRAIN);
      count++;
    }
    expect(count).toBe(45);
  });

  it("preserves caller snapshots and exposes the homogeneous, unvalidated scope", () => {
    const parameters = { ...material, relaxation: material.relaxation.map(branch => ({ ...branch })) };
    const protocol = { ...brief };
    const result = runFatCreep(parameters, protocol);
    parameters.relaxation[0]!.fraction = 0.01;
    protocol.targetStressPa = 123;
    expect(result.material.relaxation[0]!.fraction).toBe(0.25);
    expect(result.protocol.targetStressPa).toBe(1500);
    expect(result.assumptions.join(" ")).toContain("not fitted or clinically validated");
    expect(result.assumptions.join(" ")).toContain("zero nominal load");
    expect(result.assumptions.join(" ")).toContain("not labeled dissipated energy");
    expect(result.assumptions.some(note => note.startsWith("Displacement is prescribed."))).toBe(false);
  });
});
