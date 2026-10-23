import { describe, expect, it } from "vitest";
import { vesselApertures, vesselFrame, type VesselGeometryConfig } from "./geometry";
import { VesselFlowExperiment, createCardiovascularVesselPreset, type VesselFlowOptions, type VesselFlowSnapshot } from "./vesselFlow";
import { createVesselPreset } from "./vesselSolver";

function fixture(kind: "artery" | "vein" = "artery", maxSubsteps = 2048, options: VesselFlowOptions = {}) {
  const geometry: VesselGeometryConfig = {
    innerRadiusM: .003, wallThicknessM: .00065, holes: [],
    centrelineM: [[-.03, .025, 0], [-.015, .028, .002], [0, .026, .003], [.015, .023, .001], [.03, .025, 0]],
  };
  const frame = vesselFrame(geometry);
  const n = frame.point(.32, 0, 0).radial, b = frame.point(.32, Math.PI / 2, 0).radial;
  geometry.holes = [{ id: "puncture-1", arcFraction: .32, radiusM: .0004,
    angleRad: Math.atan2(-.3 * b.y + .95 * b.z, -.3 * n.y + .95 * n.z) }];
  const config = (options.cardiovascular ? createCardiovascularVesselPreset : createVesselPreset)(kind, {
    innerRadiusM: geometry.innerRadiusM, lengthM: frame.lengthM,
    pressureReferencePositionM: frame.curve.getPointAt(.5).toArray() as [number, number, number],
  });
  return { flow: new VesselFlowExperiment(config, { ...options, collector: { ...options.collector, maxSubsteps } }),
    holes: vesselApertures(geometry), config };
}

function inventory(state: VesselFlowSnapshot, initial: number, area: number) {
  const explicitFlight = state.breakup.ligaments.reduce((total, item) => total + item.volumeM3, 0)
    + state.breakup.droplets.reduce((total, item) => total + item.volumeM3, 0);
  expect(Math.abs(explicitFlight - state.inFlightVolumeM3)).toBeLessThan(1e-15);
  const filmVolume = state.collector.heightM.reduce((a, b) => a + b, 0) * area;
  const combined = (state.cardiovascular?.circulatingVolumeM3 ?? state.supplyVolumeM3 + state.distalCollectedVolumeM3) + state.vesselVolumeM3
    + explicitFlight + filmVolume + state.collector.escapedVolumeM3 - state.collector.initialFilmVolumeM3;
  expect(Math.abs(combined - initial)).toBeLessThan(1e-14);
  expect(Math.abs(state.collector.inputVolumeM3 - state.landedVolumeM3)).toBeLessThan(1e-15);
  expect(state.collector.timeSeconds).toBe(state.timeSeconds);
  expect(state.breakup.timeSeconds).toBe(state.timeSeconds);
}

describe("transactional vessel, flight and spatial collection", () => {
  it("transfers real local impacts once, retaining droplets and the complete volume ledger", () => {
    const { flow, holes, config } = fixture();
    flow.setHoles(holes);
    const c = flow.collectorConfig, area = c.widthM * c.depthM / c.nx / c.nz;
    const initial = config.initialSupplyVolumeM3 + config.initialVesselVolumeM3;
    let previousInput = 0, totalImpacts = 0, maxDrops = 0;
    for (let i = 0; i < 200; i++) {
      const result = flow.step(); expect(result.accepted, result.reason).toBe(true);
      const state = flow.snapshot(); inventory(state, initial, area);
      const incoming = state.breakup.landingEvents.reduce((total, impact) => total + impact.volumeM3, 0);
      expect(Math.abs(state.collector.inputVolumeM3 - previousInput - incoming)).toBeLessThan(1e-15);
      totalImpacts += state.breakup.landingEvents.length; previousInput = state.collector.inputVolumeM3;
      maxDrops = Math.max(maxDrops, state.breakup.droplets.length);
    }
    const final = flow.snapshot(), heights = final.collector.heightM;
    expect(final.breakup.pinchCount).toBeGreaterThan(0);
    expect(maxDrops).toBeGreaterThan(0); expect(totalImpacts).toBeGreaterThan(0);
    expect(final.collector.depositedVolumeM3).toBeGreaterThan(0);
    expect(Math.max(...heights)).toBeGreaterThan(c.precursorHeightM * 2);
    expect(Math.min(...heights)).toBeLessThan(Math.max(...heights) / 2);
  });

  it("occlusion stops new emissions while existing blood continues landing and spreading", () => {
    const { flow, holes } = fixture();
    flow.setHoles(holes);
    for (let i = 0; i < 100; i++) {
      const result = flow.step(); expect(result.accepted, result.reason).toBe(true);
    }
    const open = flow.snapshot(); flow.setHoles([]);
    for (let i = 0; i < 200; i++) {
      const result = flow.step(); expect(result.accepted, result.reason).toBe(true);
    }
    const closed = flow.snapshot();
    expect(closed.expelledVolumeM3).toBe(open.expelledVolumeM3);
    expect(closed.inFlightVolumeM3).toBe(0);
    expect(closed.collector.inputVolumeM3).toBeGreaterThan(open.collector.inputVolumeM3);
    expect(Math.abs(closed.collector.inputVolumeM3 - closed.expelledVolumeM3)).toBeLessThan(1e-15);
    expect(closed.jets).toHaveLength(0);
  });

  it("a rejected collection step rolls back pressure, supply, pinch events and all clocks together", () => {
    const { flow, holes } = fixture("artery", 1); flow.setHoles(holes);
    let rejected = false;
    for (let i = 0; i < 100; i++) {
      const before = flow.snapshot(), result = flow.step();
      if (!result.accepted) {
        expect(result.reason).toMatch(/budget|substep|collector|CFL/i);
        expect(flow.snapshot()).toEqual(before); rejected = true; break;
      }
    }
    expect(rejected).toBe(true);
  });

  it("copies exported arrays and preserves low-pressure venous inventory", () => {
    const { flow, holes, config } = fixture("vein"); flow.setHoles(holes);
    for (let i = 0; i < 100; i++) {
      const result = flow.step(); expect(result.accepted, result.reason).toBe(true);
    }
    const exported = flow.snapshot(); exported.collector.heightM.fill(NaN);
    const next = flow.step(); expect(next.accepted, next.reason).toBe(true);
    const c = flow.collectorConfig, valid = flow.snapshot();
    expect(valid.collector.heightM.every(Number.isFinite)).toBe(true);
    inventory(valid, config.initialSupplyVolumeM3 + config.initialVesselVolumeM3, c.widthM * c.depthM / c.nx / c.nz);
  });
});

describe("closed cardiovascular circulation coupled to an actual puncture and collector", () => {
  it("deducts the local inventory once and initializes its intact resistive pressure balance", () => {
    for (const kind of ["artery", "vein"] as const) {
      const { flow } = fixture(kind, 2048, { cardiovascular: {} });
      const s = flow.snapshot(), c = flow.vesselConfig, cv = s.cardiovascular!;
      expect(s.supplyVolumeM3).toBe(0); expect(flow.initialInventoryM3).toBe(.005);
      expect(cv.circulatingVolumeM3 + s.vesselVolumeM3).toBeCloseTo(.005, 13);
      const source = cv.pressuresPa.systemicArtery, distal = cv.pressuresPa.systemicVein;
      expect(s.sourcePressurePa).toBe(source);
      expect((source - s.pressurePa) / c.inletResistancePaSM3).toBeCloseTo(
        (s.pressurePa - distal) / c.outletResistancePaSM3, 15);
    }
  });

  it("converges terminal pressures and conserves circulation, local vessel, drops and localized film together", () => {
    const { flow, holes } = fixture("artery", 2048, { cardiovascular: {} });
    flow.setHoles(holes);
    const c = flow.collectorConfig, area = c.widthM * c.depthM / c.nx / c.nz;
    let minimum = Infinity, maximum = -Infinity;
    for (let i = 0; i < 450; i++) {
      const result = flow.step(); expect(result.accepted, result.reason).toBe(true);
      const s = flow.snapshot(), cv = s.cardiovascular!;
      inventory(s, .005, area);
      expect(Math.abs(s.timeSeconds - cv.timeSeconds)).toBeLessThan(1e-12);
      expect(Math.abs(s.sourcePressurePa - cv.pressuresPa.systemicArtery)).toBeLessThan(1e-6);
      expect(Math.abs(s.distalBoundaryPressurePa - cv.pressuresPa.systemicVein)).toBeLessThan(1e-6);
      expect(Math.abs(cv.netTransferredToLocalM3 - s.externalSuppliedVolumeM3 + s.distalCollectedVolumeM3)).toBeLessThan(1e-15);
      minimum = Math.min(minimum, s.sourcePressurePa); maximum = Math.max(maximum, s.sourcePressurePa);
    }
    const s = flow.snapshot();
    expect(maximum - minimum).toBeGreaterThan(1000);
    expect(s.breakup.pinchCount).toBeGreaterThan(0);
    expect(s.collector.depositedVolumeM3).toBeGreaterThan(0);
    expect(.005 - s.cardiovascular!.circulatingVolumeM3 - s.vesselVolumeM3).toBeCloseTo(s.expelledVolumeM3, 13);
    expect(flow.diagnostics().cardiovascular!.couplingIterations).toBeLessThan(10);
  }, 30000);

  it("blood loss changes cardiovascular pressures rather than drawing from a fixed-pressure source", () => {
    // Compare identical initialization and clock. Small puncture losses should
    // produce a small response; no artist gain amplifies the pressure drop.
    const baseline = fixture("artery", 2048, { cardiovascular: {} }).flow;
    const bleeding = fixture("artery", 2048, { cardiovascular: {} });
    bleeding.flow.setHoles(bleeding.holes);
    for (let i = 0; i < 300; i++) {
      for (const flow of [baseline, bleeding.flow]) {
        const result = flow.step(); expect(result.accepted, result.reason).toBe(true);
      }
    }
    const a = baseline.snapshot(), b = bleeding.flow.snapshot();
    expect(b.cardiovascular!.circulatingVolumeM3 + b.vesselVolumeM3)
      .toBeLessThan(a.cardiovascular!.circulatingVolumeM3 + a.vesselVolumeM3);
    expect(b.cardiovascular!.pressuresPa.systemicArtery).toBeLessThan(a.cardiovascular!.pressuresPa.systemicArtery);
    expect(a.expelledVolumeM3).toBe(0);
    bleeding.flow.setHoles([]);
    const lost = b.expelledVolumeM3;
    for (let i = 0; i < 100; i++) expect(bleeding.flow.step().accepted).toBe(true);
    expect(bleeding.flow.snapshot().expelledVolumeM3).toBe(lost);
  }, 30000);

  it("rejection rolls back cardiac valves, circulating volume and pressure together with all external flow", () => {
    const { flow, holes } = fixture("artery", 1, { cardiovascular: {} }); flow.setHoles(holes);
    let rejected = false;
    for (let i = 0; i < 100; i++) {
      const before = flow.snapshot(), diagnostics = flow.diagnostics(), result = flow.step();
      if (!result.accepted) {
        expect(flow.snapshot()).toEqual(before);
        expect(flow.diagnostics()).toEqual(diagnostics); rejected = true; break;
      }
    }
    expect(rejected).toBe(true);
  });
});
