import { describe, expect, it } from "vitest";
import { DEFAULT_TANK_CONFIG, TankSolver, submergedGeometry, type TankStep } from "./tankSolver";

function accept(result: TankStep) {
  expect(result.accepted, result.reason).toBe(true);
  expect(result.telemetry.relativeVolumeError).toBeLessThan(1e-10);
  expect(result.telemetry.relativeEnergyBalanceError).toBeLessThanOrEqual(2e-4);
  expect(result.telemetry.maxColumnVolumeResidualM).toBeLessThanOrEqual(1e-11);
  return result.snapshot;
}
function advance(solver: TankSolver, seconds: number) {
  let result: TankStep | undefined;
  for (let i = 0; i < Math.round(seconds / solver.config.dtSeconds); ++i) result = solver.step(), accept(result);
  return result!;
}
function amplitude(solver: TankSolver) {
  const s = solver.snapshot(), c = solver.config;
  return s.heightM.reduce((sum, h, i) => sum + 2 / (c.nx * c.nz)
    * (h - c.fillDepthM) * Math.cos(Math.PI * (i % c.nx + .5) / c.nx), 0);
}

describe("conservative SI reduced tank", () => {
  it("has exact sphere-cap/box hydrostatics and geometric first moments", () => {
    const r = .004;
    for (const shape of ["sphere", "cube"] as const) {
      const full = submergedGeometry(shape, r, 2 * r), half = submergedGeometry(shape, r, 0);
      const expected = shape === "sphere" ? 4 / 3 * Math.PI * r ** 3 : (2 * r) ** 3;
      expect(full.volumeM3 / expected).toBeCloseTo(1, 14);
      expect(half.volumeM3 / expected).toBeCloseTo(.5, 14);
      expect(full.momentM4).toBeCloseTo(0, 20);
      expect(submergedGeometry(shape, r, -2 * r).volumeM3).toBeCloseTo(0, 20);
      // Independent planar slice identity: dV/dd=A; dM/dd=d A.
      const d = .3 * r, eps = 1e-7 * r, above = submergedGeometry(shape, r, d + eps), below = submergedGeometry(shape, r, d - eps);
      const area = shape === "sphere" ? Math.PI * (r * r - d * d) : 4 * r * r;
      expect((above.volumeM3 - below.volumeM3) / (2 * eps) / area).toBeCloseTo(1, 7);
      expect((above.momentM4 - below.momentM4) / (2 * eps) / (d * area)).toBeCloseTo(1, 7);
    }
  });
  it("keeps a closed resting tank exactly still and output detached", () => {
    const solver = new TankSolver({ nx: 16, nz: 16 }), start = solver.snapshot();
    const end = advance(solver, .2).snapshot;
    expect(end.heightM).toEqual(start.heightM);
    expect(end.dischargeXM2S.every(q => q === 0)).toBe(true);
    expect(end.body).toBeNull();
    end.heightM.fill(9); expect(solver.snapshot().heightM).toEqual(start.heightM);
  });
  it("matches the independent standing-wave dispersion and shows second-order space convergence", () => {
    const errors: number[] = [];
    for (const n of [8, 16, 32]) {
      const solver = new TankSolver({ nx: n, nz: 8, initialWaveAmplitudeM: 1e-5, viscosityPaS: 0, dtSeconds: .0005 });
      const omega = Math.sqrt(9.81 * .012) * Math.PI / .15, t = .12;
      advance(solver, t);
      errors.push(Math.abs(amplitude(solver) / 1e-5 - Math.cos(omega * t)));
    }
    expect(errors[0]! / errors[1]!).toBeGreaterThan(3.9);
    expect(errors[1]! / errors[2]!).toBeGreaterThan(3.9);
  });
  it("matches viscous decay using the independent damped-oscillator solution", () => {
    const mu = .2, c = { ...DEFAULT_TANK_CONFIG, nx: 32, nz: 8, viscosityPaS: mu, initialWaveAmplitudeM: 1e-5, dtSeconds: .0005 };
    const solver = new TankSolver(c), t = .5, gamma = 3 * mu / (c.densityKgM3 * c.fillDepthM ** 2);
    const omega = Math.sqrt(c.gravityMS2 * c.fillDepthM) * 2 * Math.sin(Math.PI / (2 * c.nx)) / (c.widthM / c.nx);
    const damped = Math.sqrt(omega * omega - gamma * gamma / 4);
    const expected = Math.exp(-gamma * t / 2) * (Math.cos(damped * t) + gamma / (2 * damped) * Math.sin(damped * t));
    const result = advance(solver, t);
    expect(amplitude(solver) / c.initialWaveAmplitudeM).toBeCloseTo(expected, 8);
    expect(result.snapshot.dissipatedEnergyJ).toBeGreaterThan(0);
    expect(result.telemetry.relativeEnergyBalanceError).toBeLessThan(1e-8);
  });
  it("free fall before entry is exact and no ripples are prescribed while dry", () => {
    const solver = new TankSolver({ nx: 16, nz: 16 });
    const start = accept(solver.drop({ shape: "sphere", xM: .075, zM: .075, radiusM: .004, dropHeightM: .001, densityKgM3: 750 }));
    const end = advance(solver, .01).snapshot;
    expect(end.body!.positionM[1]).toBeCloseTo(start.body!.positionM[1] - .5 * 9.81 * .01 ** 2, 12);
    expect(end.body!.velocityMS).toBeCloseTo(-9.81 * .01, 12);
    expect(end.heightM).toEqual(start.heightM);
    expect(end.body!.submergedVolumeM3).toBeCloseTo(0, 20);
  });
  it("couples actual body motion, displaced volume, buoyancy and wave energy without volume injection", () => {
    const solver = new TankSolver();
    const initial = accept(solver.drop({ shape: "sphere", xM: .075, zM: .075, radiusM: .004, dropHeightM: .0005, densityKgM3: 750 }));
    const result = advance(solver, 1);
    expect(result.snapshot.body!.submergedVolumeM3).toBeGreaterThan(0);
    expect(result.telemetry.bodyBuoyancyN).toBeGreaterThan(0);
    expect(Math.max(...result.snapshot.heightM) - Math.min(...result.snapshot.heightM)).toBeGreaterThan(1e-6);
    expect(result.snapshot.fluidVolumeM3 / initial.fluidVolumeM3).toBeCloseTo(1, 12);
    expect(result.snapshot.totalEnergyJ).toBeLessThan(initial.totalEnergyJ + 1e-8);
  });
  it("runs both discrete object presets at several real viscosities with bounded energy and exact volume", () => {
    const metrics = [];
    for (const shape of ["sphere", "cube"] as const) for (const viscosityPaS of [.00345, .02, .1]) {
      const solver = new TankSolver({ viscosityPaS, nx: 24, nz: 24 });
      accept(solver.drop({ shape, xM: .075, zM: .075, radiusM: .004, sizeM: .008, dropHeightM: .0005, densityKgM3: 750 }));
      const result = advance(solver, 1);
      metrics.push({ shape, viscosityPaS, ...result.telemetry });
    }
    console.log("Tank preset envelope", JSON.stringify(metrics));
  });
  it("rejects unsafe configuration and an overlapping second object without changing the accepted state", () => {
    expect(() => new TankSolver({ fillDepthM: .1 })).toThrow(/shallow/);
    expect(() => new TankSolver({ dtSeconds: .1 })).toThrow(/stability/);
    expect(() => new TankSolver({ viscosityPaS: -1 })).toThrow();
    const solver = new TankSolver();
    expect(solver.drop({ shape: "sphere", xM: .075, zM: .075, radiusM: .02, dropHeightM: .001, densityKgM3: 750 }).accepted).toBe(false);
    expect(solver.snapshot().body).toBeNull();
    const input = { shape: "sphere" as const, xM: .075, zM: .075, radiusM: .004, dropHeightM: .0005, densityKgM3: 750 };
    accept(solver.drop(input)); const before = solver.snapshot();
    expect(solver.drop(input).accepted).toBe(false);
    expect(solver.snapshot()).toEqual(before);
  });
  it("transactionally rejects an under-resolved low-mass entry instead of hiding energy injection", () => {
    const solver = new TankSolver({ nx: 24, nz: 24, dtSeconds: .002 });
    accept(solver.drop({ shape: "cube", xM: .075, zM: .075, sizeM: .0096, dropHeightM: .0012, densityKgM3: 25 }));
    let rejected = false;
    for (let i = 0; i < 30; ++i) {
      const before = solver.snapshot(), result = solver.step();
      if (!result.accepted) {
        expect(result.reason).toMatch(/energy/);
        expect(result.telemetry.relativeEnergyBalanceError).toBeGreaterThan(2e-4);
        expect(result.snapshot).toEqual(before); expect(solver.snapshot()).toEqual(before);
        rejected = true; break;
      }
    }
    expect(rejected).toBe(true);
  });
  it("refines coupled entry/contact in time without changing the physical object", () => {
    const positions: number[] = [], velocities: number[] = [];
    for (const dtSeconds of [.002, .001, .0005, .00025]) {
      const solver = new TankSolver({ nx: 24, nz: 24, dtSeconds });
      accept(solver.drop({ shape: "sphere", xM: .075, zM: .075, radiusM: .004, dropHeightM: .0005, densityKgM3: 750 }));
      const result = advance(solver, .08); positions.push(result.snapshot.body!.positionM[1]); velocities.push(result.snapshot.body!.velocityMS);
      expect(result.telemetry.contactDissipationJ).toBeGreaterThan(0);
    }
    expect(Math.abs(positions[0]! - positions[1]!) / Math.abs(positions[1]! - positions[2]!)).toBeGreaterThan(8);
    expect(Math.abs(velocities[1]! - velocities[2]!) / Math.abs(velocities[2]! - velocities[3]!)).toBeGreaterThan(8);
  });
  it("accepts every shipped object control combination and five-second wave-decay runs", () => {
    let runs = 0, steps = 0, maxEnergy = 0, maxVolume = 0, maxSlope = 0, maxFroude = 0, maxColumnResidualM = 0;
    const inspect = (result: TankStep) => {
      if (!result.accepted) throw new Error(result.reason);
      maxEnergy = Math.max(maxEnergy, result.telemetry.relativeEnergyBalanceError);
      maxVolume = Math.max(maxVolume, result.telemetry.relativeVolumeError);
      maxSlope = Math.max(maxSlope, result.telemetry.maxSurfaceSlope);
      maxFroude = Math.max(maxFroude, result.telemetry.maxHorizontalFroude);
      maxColumnResidualM = Math.max(maxColumnResidualM, result.telemetry.maxColumnVolumeResidualM);
      steps++;
    };
    for (const shape of ["sphere", "cube"] as const)
      for (const densityKgM3 of [500, 750, 1000])
        for (const dropHeightM of [.00025, .0005, .001])
          for (const viscosityPaS of [.00345, .01, .03]) {
            const solver = new TankSolver({ viscosityPaS });
            accept(solver.drop({ shape, xM: .075, zM: .075, radiusM: .004, sizeM: .008, dropHeightM, densityKgM3 }));
            for (let i = 0; i < 2000; ++i) inspect(solver.step());
            runs++;
          }
    for (const viscosityPaS of [.00345, .01, .03]) {
      const solver = new TankSolver({ viscosityPaS, initialWaveAmplitudeM: .0005 });
      const start = solver.snapshot();
      for (let i = 0; i < 5000; ++i) inspect(solver.step());
      const final = solver.snapshot();
      expect(final.totalEnergyJ).toBeLessThan(start.totalEnergyJ);
      expect(final.dissipatedEnergyJ).toBeGreaterThan(0);
    }
    expect(runs).toBe(54); expect(maxVolume).toBeLessThan(1e-12); expect(maxEnergy).toBeLessThan(2e-4);
    expect(maxColumnResidualM).toBeLessThan(1e-11);
    console.log("Shipped tank controls", JSON.stringify({ runs, steps, maxEnergy, maxVolume, maxSlope, maxFroude, maxColumnResidualM }));
  }, 120000);
});
