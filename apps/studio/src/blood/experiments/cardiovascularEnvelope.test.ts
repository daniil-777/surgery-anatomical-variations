import { describe, expect, it } from "vitest";
import { createCardiovascularVesselPreset, VesselFlowExperiment } from "./vesselFlow";

describe("displayed cardiovascular parameter envelope", () => {
  for (const kind of ["artery", "vein"] as const) it(`${kind}: initializes every displayed corner and accepts the coupled intact branch`, () => {
    // Match the displayed curved vessel's approximate initialized inventory.
    // All actual inventories below come from the accepted configuration.
    const localVolumeM3 = 1.733e-6;
    let cases = 0, maxResidualPa = 0, maxVolumeErrorM3 = 0;
    for (const heartRateBpm of [45, 140]) for (const systemicResistanceScale of [.75, 1, 1.25])
      for (const contractilityScale of [.75, 1, 1.25]) for (const totalBloodVolumeM3 of [.0045, .005, .0055]) {
        const config = createCardiovascularVesselPreset(kind, { initialVesselVolumeM3: localVolumeM3,
          minimumVesselVolumeM3: localVolumeM3 / 2 });
        const flow = new VesselFlowExperiment(config, { cardiovascular: { heartRateBpm,
          systemicResistanceScale, contractilityScale, totalBloodVolumeM3 } });
        const initial = flow.snapshot(), cv = initial.cardiovascular!;
        expect(initial.supplyVolumeM3).toBe(0);
        expect(Math.abs(cv.circulatingVolumeM3 + initial.vesselVolumeM3 - totalBloodVolumeM3)).toBeLessThan(2e-12);
        expect(initial.sourcePressurePa).toBe(cv.pressuresPa.systemicArtery);
        expect(initial.distalBoundaryPressurePa).toBe(cv.pressuresPa.systemicVein);
        expect(initial.pressurePa).toBeGreaterThan(initial.distalBoundaryPressurePa);
        expect(initial.pressurePa).toBeLessThan(initial.sourcePressurePa);
        const fraction = (initial.pressurePa - initial.distalBoundaryPressurePa)
          / (initial.sourcePressurePa - initial.distalBoundaryPressurePa);
        expect(fraction).toBeCloseTo(config.outletResistancePaSM3 /
          (config.inletResistancePaSM3 + config.outletResistancePaSM3), 12);
        // No hole, but perfusion must flow and return; do not create a hidden
        // reserve, discard returned volume, or bypass a cardiac valve.
        for (let step = 0; step < 2; step++) {
          const result = flow.step(); expect(result.accepted, result.reason).toBe(true);
          const s = flow.snapshot();
          expect(s.externalSuppliedVolumeM3).toBeGreaterThan(0);
          expect(s.distalCollectedVolumeM3).toBeGreaterThan(0);
          expect(s.expelledVolumeM3).toBe(0);
          expect(s.sourcePressurePa).toBeCloseTo(s.cardiovascular!.pressuresPa.systemicArtery, 5);
          expect(s.distalBoundaryPressurePa).toBeCloseTo(s.cardiovascular!.pressuresPa.systemicVein, 5);
          maxVolumeErrorM3 = Math.max(maxVolumeErrorM3, Math.abs(s.coupledVolumeErrorM3));
          maxResidualPa = Math.max(maxResidualPa, flow.diagnostics().cardiovascular!.couplingResidualPa);
        }
        cases++;
      }
    expect(cases).toBe(54); expect(maxVolumeErrorM3).toBeLessThan(2e-12); expect(maxResidualPa).toBeLessThanOrEqual(1e-6);
    console.info("CV coupled UI envelope", { kind, cases, maxVolumeErrorM3, maxResidualPa });
  }, 30000);

  it("refines coupled pressure and expelled volume through a complete pulse with an open puncture", () => {
    const traces = [.002, .001, .0005, .00025].map(fixedDtSeconds => {
      const flow = new VesselFlowExperiment(createCardiovascularVesselPreset("artery", { fixedDtSeconds }), {
        cardiovascular: {}, collector: { nx: 16, nz: 16 },
      });
      const norm = Math.hypot(.3, .95);
      flow.setHoles([{ id: "refinement-puncture", positionM: [0, .025, .00365],
        direction: [0, -.3 / norm, .95 / norm], radiusM: .0004, wallLengthM: .00065,
        dischargeCoefficient: .62 }]);
      const trace: { pressuresPa: number[]; expelledVolumeM3: number }[] = [];
      const sampleStride = Math.round(.2 / fixedDtSeconds);
      for (let step = 1; step <= Math.round(1 / fixedDtSeconds); step++) {
        const accepted = flow.step(); expect(accepted.accepted, accepted.reason).toBe(true);
        if (step % sampleStride === 0) {
          const s = flow.snapshot();
          expect(Math.abs(s.coupledVolumeErrorM3)).toBeLessThan(2e-12);
          expect(Math.abs(s.sourcePressurePa - s.cardiovascular!.pressuresPa.systemicArtery)).toBeLessThanOrEqual(1e-6);
          expect(Math.abs(s.distalBoundaryPressurePa - s.cardiovascular!.pressuresPa.systemicVein)).toBeLessThanOrEqual(1e-6);
          trace.push({ pressuresPa: [s.pressurePa, s.sourcePressurePa, s.distalBoundaryPressurePa],
            expelledVolumeM3: s.expelledVolumeM3 });
        }
      }
      const final = flow.snapshot();
      expect(final.expelledVolumeM3).toBeGreaterThan(0);
      expect(final.collector.depositedVolumeM3).toBeGreaterThan(0);
      expect(final.breakup.pinchCount).toBeGreaterThan(0);
      return trace;
    });
    const reference = traces[3]!;
    const errors = traces.slice(0, 3).map(trace => ({
      pressureRmsPa: Math.sqrt(trace.reduce((sum, point, i) => sum +
        point.pressuresPa.reduce((s, p, c) => s + (p - reference[i]!.pressuresPa[c]!) ** 2, 0), 0) / 15),
      expelledRmsM3: Math.sqrt(trace.reduce((sum, point, i) =>
        sum + (point.expelledVolumeM3 - reference[i]!.expelledVolumeM3) ** 2, 0) / 5),
    }));
    expect(errors[0]!.pressureRmsPa).toBeLessThan(133.322 * .1);
    expect(errors[0]!.expelledRmsM3 / reference[4]!.expelledVolumeM3).toBeLessThan(.002);
    console.info("CV open-puncture coupled refinement against 0.25 ms", {
      errors, referenceExpelledVolumeM3: reference[4]!.expelledVolumeM3,
    });
    // A backward-Euler integration should improve under refinement; do not
    // demand exact topology identity from phase-sensitive discrete pinch events.
    for (let i = 1; i < errors.length; i++) {
      expect(errors[i]!.pressureRmsPa).toBeLessThan(errors[i - 1]!.pressureRmsPa * .7);
      expect(errors[i]!.expelledRmsM3).toBeLessThan(errors[i - 1]!.expelledRmsM3 * .7);
    }
  }, 60000);
});
