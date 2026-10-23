import { describe, expect, it } from "vitest";
import { createVesselPreset, VesselExperiment } from "./vesselSolver";

describe("explicit external circulation boundary", () => {
  it("matches the independent RC backward-Euler response without a fictitious supply reservoir", () => {
    const c = createVesselPreset("artery", { initialPressurePa: 1000, complianceM3Pa: 2e-10,
      inletResistancePaSM3: 1e9, outletOpen: false, sourcePulsePressurePa: 0 });
    const solver = new VesselExperiment(c, { externalPerfusion: true });
    expect(solver.snapshot().supplyVolumeM3).toBe(0);
    expect(solver.snapshot().perfusionModel).toBe("external-circulation");
    expect(solver.snapshot().sourcePressurePa).toBe(c.sourcePressureMeanPa);
    expect(solver.snapshot().pressurePa).toBe(c.initialPressurePa);
    const dtRC = c.fixedDtSeconds / (c.complianceM3Pa * c.inletResistancePaSM3);
    const expectedPressure = (1000 + dtRC * 2000) / (1 + dtRC);
    const frame = solver.step(1, { sourcePressurePa: 2000, distalPressurePa: 300, inletVolumeLimitM3: 1e-3, distalVolumeLimitM3: 1e-3 });
    expect(frame.pressurePa).toBeCloseTo(expectedPressure, 10);
    expect(frame.sourcePressurePa).toBe(2000); expect(frame.distalBoundaryPressurePa).toBe(300);
    expect(frame.supplyVolumeM3).toBe(0);
    expect(frame.externalSuppliedVolumeM3).toBeCloseTo(c.complianceM3Pa * (expectedPressure - 1000), 18);
    expect(Math.abs(frame.volumeErrorM3)).toBeLessThan(1e-19);
  });
  it("caps actual inlet transfer by external inventory and counts distal returns exactly once locally", () => {
    const c = createVesselPreset("artery", { initialPressurePa: 1000, sourcePulsePressurePa: 0 });
    const solver = new VesselExperiment(c, { externalPerfusion: true });
    const limit = 1e-12;
    const frame = solver.step(1, { sourcePressurePa: 100000, distalPressurePa: 0, inletVolumeLimitM3: limit, distalVolumeLimitM3: 1e-3 });
    expect(frame.externalSuppliedVolumeM3).toBe(limit);
    expect(frame.inletFlowM3S).toBe(limit / c.fixedDtSeconds);
    expect(frame.distalCollectedVolumeM3).toBeGreaterThan(0);
    expect(frame.vesselVolumeM3 + frame.distalCollectedVolumeM3 + frame.expelledVolumeM3)
      .toBeCloseTo(c.initialVesselVolumeM3 + limit, 18);
    const reversed = solver.step(1, { sourcePressurePa: -1000, distalPressurePa: 100000,
      inletVolumeLimitM3: 1e-3, distalVolumeLimitM3: 1e-3 });
    expect(reversed.inletFlowM3S).toBeLessThan(0); expect(reversed.distalFlowM3S).toBeLessThan(0);
    expect(Math.abs(reversed.volumeErrorM3)).toBeLessThan(1e-19);
  });
  it("requires a fresh boundary per step and makes repeated coupling previews side-effect free", () => {
    const solver = new VesselExperiment(createVesselPreset("artery"), { externalPerfusion: true });
    const before = solver.snapshot(), boundary = { sourcePressurePa: 16000, distalPressurePa: 500, inletVolumeLimitM3: 1e-3, distalVolumeLimitM3: 1e-3 };
    expect(() => solver.step()).toThrow();
    expect(() => solver.step(2, boundary)).toThrow();
    expect(() => solver.step(1, { ...boundary, sourcePressurePa: NaN })).toThrow();
    const first = solver.prepareStep(1, boundary);
    const second = solver.prepareStep(1, { ...boundary, sourcePressurePa: 12000 });
    expect(solver.snapshot()).toEqual(before);
    second.commit(); expect(solver.snapshot()).toEqual(second.snapshot);
    expect(() => first.commit()).toThrow();
    const checkpoint = solver.checkpoint(), accepted = solver.snapshot();
    solver.step(1, boundary); solver.restore(checkpoint); expect(solver.snapshot()).toEqual(accepted);
    expect(() => new VesselExperiment(createVesselPreset("artery")).step(1, boundary)).toThrow();
  });
  it.each([[0, 2000], [500, 0], [2000, 3000], [-500, -1000], [2000, 0]])(
    "matches the independent two-port signed RC response for source %s and distal %s Pa",
    (sourcePressurePa, distalPressurePa) => {
      const c = createVesselPreset("artery", { initialPressurePa: 1000, complianceM3Pa: 2e-10,
        inletResistancePaSM3: 1e9, outletResistancePaSM3: 2e9, sourcePulsePressurePa: 0 });
      const solver = new VesselExperiment(c, { externalPerfusion: true });
      const sourceGain = c.fixedDtSeconds / (c.complianceM3Pa * c.inletResistancePaSM3);
      const distalGain = c.fixedDtSeconds / (c.complianceM3Pa * c.outletResistancePaSM3);
      const expectedPressure = (1000 + sourceGain * sourcePressurePa + distalGain * distalPressurePa)
        / (1 + sourceGain + distalGain);
      const frame = solver.step(1, { sourcePressurePa, distalPressurePa,
        inletVolumeLimitM3: 1e-3, distalVolumeLimitM3: 1e-3 });
      const expectedInlet = (sourcePressurePa - expectedPressure) / c.inletResistancePaSM3;
      const expectedDistal = (expectedPressure - distalPressurePa) / c.outletResistancePaSM3;
      expect(frame.pressurePa).toBeCloseTo(expectedPressure, 10);
      expect(frame.inletFlowM3S).toBeCloseTo(expectedInlet, 18);
      expect(frame.distalFlowM3S).toBeCloseTo(expectedDistal, 18);
      expect(frame.externalSuppliedVolumeM3).toBeCloseTo(expectedInlet * c.fixedDtSeconds, 20);
      expect(frame.distalCollectedVolumeM3).toBeCloseTo(expectedDistal * c.fixedDtSeconds, 20);
      expect(Math.abs(frame.volumeErrorM3)).toBeLessThan(1e-19);
    });
  it("bounds simultaneous donor inflow independently at both ports without fabricating volume", () => {
    const c = createVesselPreset("artery", { initialPressurePa: 0, sourcePulsePressurePa: 0 });
    const solver = new VesselExperiment(c, { externalPerfusion: true });
    const inletVolumeLimitM3 = 1e-12, distalVolumeLimitM3 = 3e-12;
    const frame = solver.step(1, { sourcePressurePa: 1e5, distalPressurePa: 1e5,
      inletVolumeLimitM3, distalVolumeLimitM3 });
    expect(frame.externalSuppliedVolumeM3).toBe(inletVolumeLimitM3);
    expect(frame.distalCollectedVolumeM3).toBe(-distalVolumeLimitM3);
    expect(frame.vesselVolumeM3).toBeCloseTo(c.initialVesselVolumeM3 + 4e-12, 20);
    expect(Math.abs(frame.volumeErrorM3)).toBeLessThan(1e-19);
    const closedDonors = solver.step(1, { sourcePressurePa: 1e5, distalPressurePa: 1e5,
      inletVolumeLimitM3: 0, distalVolumeLimitM3: 0 });
    expect(closedDonors.inletFlowM3S).toBe(0);
    expect(closedDonors.distalFlowM3S).toBe(0);
    expect(closedDonors.vesselVolumeM3).toBe(frame.vesselVolumeM3);
  });
  it("shares finite local inventory between reverse source and forward distal outflow", () => {
    const initialVolume = Math.PI * .003 ** 2 * .08;
    const c = createVesselPreset("artery", { initialPressurePa: 10000, sourcePulsePressurePa: 0,
      inletResistancePaSM3: 1e6, outletResistancePaSM3: 2e6,
      minimumVesselVolumeM3: initialVolume - 1e-12 });
    const solver = new VesselExperiment(c, { externalPerfusion: true });
    const frame = solver.step(1, { sourcePressurePa: -10000, distalPressurePa: -10000,
      inletVolumeLimitM3: 0, distalVolumeLimitM3: 0 });
    expect(frame.inventoryLimited).toBe(true);
    expect(frame.inletFlowM3S).toBeLessThan(0);
    expect(frame.distalFlowM3S).toBeGreaterThan(0);
    expect(-frame.inletFlowM3S / frame.distalFlowM3S).toBeCloseTo(2, 12);
    expect(frame.vesselVolumeM3).toBe(c.minimumVesselVolumeM3);
    expect(-frame.externalSuppliedVolumeM3 + frame.distalCollectedVolumeM3)
      .toBeCloseTo(c.initialVesselVolumeM3 - c.minimumVesselVolumeM3, 22);
    expect(Math.abs(frame.volumeErrorM3)).toBeLessThan(1e-19);
    const drained = solver.step(1, { sourcePressurePa: -10000, distalPressurePa: -10000,
      inletVolumeLimitM3: 0, distalVolumeLimitM3: 0 });
    expect(drained.inletFlowM3S).toBe(0); expect(drained.distalFlowM3S).toBe(0);
    expect(drained.vesselVolumeM3).toBe(c.minimumVesselVolumeM3);
  });
  it("rejects invalid reverse-donor inventory atomically and retains signed transfer state on restore", () => {
    const solver = new VesselExperiment(createVesselPreset("artery"), { externalPerfusion: true });
    const boundary = { sourcePressurePa: -1000, distalPressurePa: 50000,
      inletVolumeLimitM3: 1e-3, distalVolumeLimitM3: 1e-3 };
    const before = solver.snapshot();
    expect(() => solver.step(1, { ...boundary, distalVolumeLimitM3: NaN })).toThrow();
    expect(() => solver.step(1, { ...boundary, distalVolumeLimitM3: -1e-12 })).toThrow();
    expect(solver.snapshot()).toEqual(before);
    const reverse = solver.step(1, boundary), checkpoint = solver.checkpoint();
    expect(reverse.externalSuppliedVolumeM3).toBeLessThan(0);
    expect(reverse.distalCollectedVolumeM3).toBeLessThan(0);
    solver.step(1, { ...boundary, sourcePressurePa: 50000, distalPressurePa: 0 });
    solver.restore(checkpoint);
    expect(solver.snapshot()).toEqual(reverse);
  });
});
