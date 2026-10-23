import { describe, expect, it } from "vitest";
import {
  ballisticLandingTime, ballisticState, createVesselPreset, pressureDrivenDischarge,
  punctureCoefficients, VesselExperiment, vesselSourcePressure,
  type VesselConfig, type VesselHole,
} from "./vesselSolver";

const hole = (overrides: Partial<VesselHole> = {}): VesselHole => ({
  id: "puncture-1", positionM: [0, .03, .0036], direction: [0, 0, 1],
  radiusM: .0004, wallLengthM: .0006, dischargeCoefficient: .62, ...overrides,
});
const preset = (overrides: Partial<VesselConfig> = {}) => createVesselPreset("artery", {
  sourcePulsePressurePa: 0, ...overrides,
});
const relative = (actual: number, expected: number, tolerance = 1e-12) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-30, Math.abs(expected) * tolerance));

describe("puncture pressure/discharge law", () => {
  it("satisfies independently specified viscous and inertial limiting laws", () => {
    expect(pressureDrivenDischarge(120, 40, 0)).toBe(3);
    expect(pressureDrivenDischarge(18, 0, 2)).toBe(3);
    for (const dp of [-1e4, -1, 0]) expect(pressureDrivenDischarge(dp, 40, 2)).toBe(0);
    // Known forward balance: Δp = 17*3 + 11*3² = 150.
    expect(pressureDrivenDischarge(150, 17, 11)).toBeCloseTo(3, 14);
  });
  it("retains the low-pressure limit without quadratic-root cancellation", () => {
    relative(pressureDrivenDischarge(1e-16, 1e12, 1e15), 1e-28);
    const r = 4e29, k = 2e29, dp = 1e20;
    const q = pressureDrivenDischarge(dp, r, k);
    relative(r * q + k * q * q, dp);
  });
  it("uses both aperture access resistance and the finite-length Poiseuille resistance", () => {
    const thin = punctureCoefficients(.001, 0, .004, 1000, 1);
    relative(thin.resistancePaSM3, 12e6);
    const finite = punctureCoefficients(.001, .002, .004, 1000, 1);
    relative(finite.resistancePaSM3 - thin.resistancePaSM3, 64e6 / Math.PI);
    relative(thin.areaM2, Math.PI * 1e-6);
    relative(thin.inertiaPaS2M6, 1000 / (2 * Math.PI ** 2 * 1e-12));
  });
  it("has area scaling in the inviscid limit and radius-cubed scaling in low-Re access flow", () => {
    const flow = (r: number, mu: number, dp: number) => {
      const c = punctureCoefficients(r, 0, mu, 1060, .62);
      return pressureDrivenDischarge(dp, c.resistancePaSM3, c.inertiaPaS2M6);
    };
    relative(flow(.0004, 0, 10000) / flow(.0002, 0, 10000), 4);
    relative(flow(.0004, .0035, 1e-8) / flow(.0002, .0035, 1e-8), 8, 1e-8);
    expect(flow(.0004, .007, 1000)).toBeLessThan(flow(.0004, .0035, 1000));
  });
  it("rejects undefined or nonphysical discharge parameters", () => {
    expect(() => pressureDrivenDischarge(1, 0, 0)).toThrow();
    expect(() => pressureDrivenDischarge(NaN, 1, 1)).toThrow();
    expect(() => pressureDrivenDischarge(1, -1, 1)).toThrow();
    expect(() => punctureCoefficients(0, 0, .0035, 1060, .62)).toThrow();
    expect(() => punctureCoefficients(.001, -.1, .0035, 1060, .62)).toThrow();
  });
});

describe("lumped vessel pressure and finite inventory", () => {
  it("recomputes equilibrium pressure and geometric volume for preset overrides", () => {
    const config = preset({ sourcePressureMeanPa: 1000, distalPressurePa: 100,
      inletResistancePaSM3: 1e9, outletResistancePaSM3: 2e9, innerRadiusM: .004, lengthM: .06 });
    expect(config.initialPressurePa).toBe(700);
    relative(config.initialVesselVolumeM3, Math.PI * .004 ** 2 * .06);
    const state = new VesselExperiment(config).step(100);
    relative(state.pressurePa, 700);
    relative(state.inletFlowM3S, 3e-7);
    relative(state.distalFlowM3S, 3e-7);
    expect(Math.abs(state.volumeErrorM3)).toBeLessThan(1e-18);
  });
  it("keeps a sealed chamber unchanged", () => {
    const solver = new VesselExperiment(preset({ inletOpen: false, outletOpen: false }));
    const initial = solver.snapshot(), final = solver.step(100);
    expect(final.vesselVolumeM3).toBe(initial.vesselVolumeM3);
    expect(final.pressurePa).toBe(initial.pressurePa);
    expect(final.supplyVolumeM3).toBe(initial.supplyVolumeM3);
    expect(final.expelledVolumeM3).toBe(0);
  });
  it("matches the backward-Euler RC recurrence and converges to exponential pressure decay", () => {
    const errors: number[] = [];
    for (const dt of [.01, .005, .0025]) {
      const config = preset({ fixedDtSeconds: dt, inletOpen: false, outletOpen: true,
        initialPressurePa: 1000, distalPressurePa: 0, complianceM3Pa: 1e-10,
        outletResistancePaSM3: 1e9, initialVesselVolumeM3: 3e-6, minimumVesselVolumeM3: 0 });
      const steps = Math.round(.1 / dt), final = new VesselExperiment(config).step(steps);
      const discrete = 1000 / (1 + dt / .1) ** steps;
      relative(final.pressurePa, discrete, 2e-11);
      relative(final.distalCollectedVolumeM3, 1e-10 * (1000 - discrete), 2e-11);
      errors.push(Math.abs(final.pressurePa - 1000 * Math.exp(-1)));
    }
    expect(errors[0]! / errors[1]!).toBeGreaterThan(1.9);
    expect(errors[1]! / errors[2]!).toBeGreaterThan(1.9);
  });
  it("lowers pressure with a leak and predicts more discharge through a larger aperture", () => {
    const run = (radiusM: number) => {
      const solver = new VesselExperiment(preset());
      if (radiusM) solver.setHoles([hole({ radiusM })]);
      return solver.step(500);
    };
    const sealed = run(0), small = run(.0002), large = run(.0006);
    expect(small.pressurePa).toBeLessThan(sealed.pressurePa);
    expect(large.pressurePa).toBeLessThan(small.pressurePa);
    expect(large.expelledVolumeM3).toBeGreaterThan(small.expelledVolumeM3);
    expect(large.jets[0]!.flowM3S).toBeGreaterThan(small.jets[0]!.flowM3S);
  });
  it("uses signed gravitational elevation, including suppression above a low-pressure chamber", () => {
    const run = (y: number) => {
      const solver = new VesselExperiment(preset({ inletOpen: false, outletOpen: false, initialPressurePa: 0 }));
      solver.setHoles([hole({ positionM: [0, y, 0] })]);
      return solver.step();
    };
    const below = run(.02), above = run(.04);
    expect(below.jets[0]!.drivingPressurePa).toBeGreaterThan(0);
    expect(below.jets[0]!.flowM3S).toBeGreaterThan(0);
    expect(above.jets[0]!.drivingPressurePa).toBeLessThan(0);
    expect(above.jets[0]!.flowM3S).toBe(0);
  });
  it("conserves supply, chamber, distal, airborne, and landed volumes with three punctures", () => {
    const solver = new VesselExperiment(preset());
    solver.setHoles([hole(), hole({ id: "puncture-2", positionM: [.01, .03, 0], direction: [0, -1, 0] }),
      hole({ id: "puncture-3", positionM: [-.01, .03, 0], direction: [0, 1, 0] })]);
    const final = solver.step(1000);
    expect(final.expelledVolumeM3).toBeGreaterThan(0);
    expect(final.landedVolumeM3).toBeGreaterThan(0);
    relative(final.expelledVolumeM3, final.inFlightVolumeM3 + final.landedVolumeM3, 2e-12);
    relative(Object.values(final.holeExpelledVolumeM3).reduce((sum, v) => sum + v, 0), final.expelledVolumeM3, 2e-12);
    expect(Math.abs(final.volumeErrorM3)).toBeLessThan(1e-17);
    expect(final.parcels.every(p => p.volumeM3 > 0 && p.positionM[1] > 0)).toBe(true);
    expect(final.parcels.every((p, i) => !i || p.emissionTimeSeconds >= final.parcels[i - 1]!.emissionTimeSeconds)).toBe(true);
  });
  it("stops withdrawal exactly at finite supply and chamber limits without deleting expelled volume", () => {
    const supply = new VesselExperiment(preset({ initialSupplyVolumeM3: 1e-10, outletOpen: false,
      initialPressurePa: 0, sourcePressureMeanPa: 20000 }));
    const supplied = supply.step();
    expect(supplied.supplyVolumeM3).toBe(0);
    expect(supplied.status).toBe("source-empty");
    const drained = new VesselExperiment(preset({ initialVesselVolumeM3: 1e-9, minimumVesselVolumeM3: 0,
      initialSupplyVolumeM3: 0, inletOpen: false, outletOpen: false, complianceM3Pa: 1e-6, initialPressurePa: 1000 }));
    drained.setHoles([hole({ radiusM: .0006 })]);
    const first = drained.step(10), later = drained.step(1000);
    expect(first.vesselVolumeM3).toBeGreaterThanOrEqual(-1e-24);
    expect(first.status).toBe("drained");
    relative(first.expelledVolumeM3, 1e-9);
    expect(later.expelledVolumeM3).toBe(first.expelledVolumeM3);
    expect(later.jets[0]!.flowM3S).toBe(0);
    relative(later.landedVolumeM3, 1e-9);
    expect(Math.abs(later.volumeErrorM3)).toBeLessThan(1e-23);
  });
  it("is invariant to render-batch scheduling", () => {
    const a = new VesselExperiment(createVesselPreset("artery")), b = new VesselExperiment(createVesselPreset("artery"));
    a.setHoles([hole()]); b.setHoles([hole()]);
    const expected = a.step(120);
    const emissions = [], landingEvents = [];
    for (let i = 0; i < 15; ++i) {
      const frame = b.step(8); emissions.push(...frame.emissions); landingEvents.push(...frame.landingEvents);
    }
    // Events describe the latest call, while physical state is cadence-invariant.
    // Concatenating event batches must recover the exact single-batch stream.
    expect({ ...b.snapshot(), emissions, landingEvents }).toEqual(expected);
  });
  it("preserves emitted parcels and history when an aperture is occluded", () => {
    const solver = new VesselExperiment(preset());
    solver.setHoles([hole()]);
    const before = solver.step(20);
    solver.setHoles([]);
    const closed = solver.snapshot(), final = solver.step(1000);
    expect(closed.parcels).toEqual(before.parcels);
    expect(final.expelledVolumeM3).toBe(before.expelledVolumeM3);
    expect(final.holeExpelledVolumeM3).toEqual(before.holeExpelledVolumeM3);
    expect(final.jets).toEqual([]);
    relative(final.landedVolumeM3, before.expelledVolumeM3);
  });
  it("emits exact accepted step volumes at midstep and transfers landing at the first containing time boundary", () => {
    const solver = new VesselExperiment(preset());
    const aperture = hole({ direction: [0, -.3, .95] });
    solver.setHoles([aperture]);
    const first = solver.step(), parcel = first.parcels[0]!, dt = solver.config.fixedDtSeconds;
    expect(parcel.emissionTimeSeconds).toBe(dt / 2);
    expect(parcel.ageSeconds).toBe(dt / 2);
    relative(parcel.volumeM3, first.jets[0]!.flowM3S * dt);
    const initialVelocity = first.jets[0]!.direction.map(v => v * first.jets[0]!.velocityMS) as [number, number, number];
    const reference = ballisticState(aperture.positionM, initialVelocity, solver.config.gravityMS2, dt / 2);
    expect(parcel.positionM).toEqual(reference.positionM);
    expect(parcel.velocityMS).toEqual(reference.velocityMS);
    const physicalLanding = parcel.emissionTimeSeconds + ballisticLandingTime(aperture.positionM[1], initialVelocity[1], -9.81);
    solver.setHoles([]);
    let state = first;
    while (state.parcels.length) state = solver.step();
    expect(state.timeSeconds).toBeGreaterThanOrEqual(physicalLanding);
    expect(state.timeSeconds - dt).toBeLessThan(physicalLanding);
    relative(state.landedVolumeM3, parcel.volumeM3);
    relative(state.expelledVolumeM3, parcel.volumeM3);
  });
  it("rolls back the whole batch at capacity failure and permits a smaller valid batch", () => {
    const solver = new VesselExperiment(preset({ gravityMS2: [0, 0, 0], maxParcels: 8 }));
    solver.setHoles([hole()]);
    const initial = solver.snapshot();
    expect(() => solver.step(9)).toThrow(/capacity/);
    expect(solver.snapshot()).toEqual(initial);
    expect(solver.step(8).parcels).toHaveLength(8);
    const accepted = solver.snapshot();
    expect(() => solver.step()).toThrow(/capacity/);
    expect(solver.snapshot()).toEqual(accepted);
  });
  it("rejects invalid edits atomically and snapshots do not expose mutable solver state", () => {
    const solver = new VesselExperiment(preset());
    solver.setHoles([hole()]);
    const accepted = solver.step(2);
    expect(() => solver.setHoles([hole(), hole()])).toThrow();
    expect(() => solver.setHoles([hole({ direction: [0, 0, 0] })])).toThrow();
    expect(() => solver.setHoles([hole({ radiusM: NaN })])).toThrow();
    expect(solver.snapshot()).toEqual(accepted);
    accepted.parcels[0]!.volumeM3 = 100;
    accepted.jets[0]!.flowM3S = 100;
    expect(solver.snapshot().parcels[0]!.volumeM3).not.toBe(100);
    expect(solver.snapshot().jets[0]!.flowM3S).not.toBe(100);
    expect(() => solver.step(-1)).toThrow();
    expect(() => solver.step(.5)).toThrow();
  });
  it("stops at the configured duration and reset clears punctures and all transfer history", () => {
    const solver = new VesselExperiment(preset({ maxTimeSeconds: .01 }));
    solver.setHoles([hole()]);
    const final = solver.step(100);
    expect(final.timeSeconds).toBe(.01);
    expect(final.status).toBe("complete");
    expect(solver.step(100)).toEqual({ ...final, emissions: [], landingEvents: [] });
    solver.reset();
    expect(solver.snapshot().timeSeconds).toBe(0);
    expect(solver.snapshot().jets).toHaveLength(0);
    expect(solver.snapshot().expelledVolumeM3).toBe(0);
  });
});

describe("pressure waveform and ballistic reference", () => {
  it("has the declared mean and pulse pressure while the vein boundary is steady", () => {
    const artery = createVesselPreset("artery"), vein = createVesselPreset("vein");
    const period = 60 / artery.heartRateBpm;
    const values = Array.from({ length: 10000 }, (_, i) => vesselSourcePressure(artery, i * period / 10000));
    relative(values.reduce((sum, v) => sum + v, 0) / values.length, artery.sourcePressureMeanPa);
    relative(Math.max(...values) - Math.min(...values), artery.sourcePulsePressurePa);
    expect(vesselSourcePressure(vein, 0)).toBe(vesselSourcePressure(vein, .4));
  });
  it("matches the projectile trajectory, mechanical energy, and analytic floor intersection", () => {
    const origin = [0, .03, 0] as const, velocity = [2, 1, -1] as const, gravity = [0, -9.81, 0] as const;
    const time = .1, state = ballisticState(origin, velocity, gravity, time);
    expect(state.positionM[0]).toBe(.2);
    expect(state.positionM[2]).toBe(-.1);
    expect(state.positionM[1]).toBeCloseTo(.03 + .1 - .04905, 15);
    const initialEnergy = velocity.reduce((sum, v) => sum + v * v / 2, 0) + 9.81 * origin[1];
    const energy = state.velocityMS.reduce((sum, v) => sum + v * v / 2, 0) + 9.81 * state.positionM[1];
    expect(energy).toBeCloseTo(initialEnergy, 14);
    const land = ballisticLandingTime(.03, 1, -9.81);
    expect(ballisticState(origin, velocity, gravity, land).positionM[1]).toBeCloseTo(0, 14);
    expect(ballisticLandingTime(.03, -.5, 0)).toBe(.06);
    expect(ballisticLandingTime(.03, .5, 0)).toBe(Infinity);
    expect(ballisticLandingTime(0, -1, -9.81)).toBe(0);
  });
});
