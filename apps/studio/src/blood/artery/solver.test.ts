import { describe, expect, it } from "vitest";
import { BLOOD_PROFILES, type CYProfile } from "../material";
import { ArteryFlowSolver, DEFAULT_ARTERY_CONFIG, type ArteryConfig, type ArteryStepResult } from "./solver";
import womersleyReference from "./womersley-reference.json";
import carreauReference from "./carreau-steady-reference.json";

const R = .003, MU = .00345, RHO = 1060;
const newtonian = { kind: "newtonian" as const, viscosityPaS: MU };
function accepted(result: ArteryStepResult) {
  expect(result.status, result.reason).toBe("accepted");
  expect(result.telemetry.converged).toBe(true);
  return result.snapshot;
}
function l2(actual: ArrayLike<number>, reference: ArrayLike<number>, weights: ArrayLike<number>) {
  let error = 0, norm = 0;
  for (let i = 0; i < actual.length; ++i) {
    error += weights[i]! * (actual[i]! - reference[i]!) ** 2;
    norm += weights[i]! * reference[i]! ** 2;
  }
  return Math.sqrt(error / norm);
}
// Independent steady reference: stress balance tau(r)=G*r/2, inversion of the
// published algebraic law, and Simpson quadrature; no FV matrix or face stencil.
function inverseCY(tau: number, p: CYProfile) {
  let lo = 0, hi = tau / p.muInf;
  for (let i = 0; i < 64; ++i) {
    const rate = (lo + hi) / 2;
    const mu = p.muInf + (p.mu0 - p.muInf) * Math.pow(1 + Math.pow(p.lambda * rate, p.a), (p.n - 1) / p.a);
    if (rate * mu > tau) hi = rate; else lo = rate;
  }
  return (lo + hi) / 2;
}
function simpson(f: (x: number) => number, start: number, end: number, panels = 2048) {
  const h = (end - start) / panels;
  let value = f(start) + f(end);
  for (let i = 1; i < panels; ++i) value += (i % 2 ? 4 : 2) * f(start + i * h);
  return value * h / 3;
}
function j0(x: number) {
  let value = 1, term = 1;
  for (let k = 1; k < 40; ++k) { term *= -x * x / (4 * k * k); value += term; }
  return value;
}
function harmonic(samples: number[], reference: { re: number; im: number; phaseRad: number }) {
  let re = 0, im = 0;
  for (let i = 0; i < samples.length; ++i) {
    const phase = 2 * Math.PI * (i + 1) / samples.length;
    re += 2 / samples.length * samples[i]! * Math.cos(phase);
    im -= 2 / samples.length * samples[i]! * Math.sin(phase);
  }
  return {
    relativeError: Math.hypot(re - reference.re, im - reference.im) / Math.hypot(reference.re, reference.im),
    phaseErrorRad: Math.abs(Math.atan2(im, re) - reference.phaseRad), re, im,
  };
}

describe("arterial finite-volume geometry and public contract", () => {
  it("uses the physical radius, exact annular areas and an explicit no-slip wall face", () => {
    const solver = new ArteryFlowSolver({ radialCells: 32, rheology: newtonian });
    const state = accepted(solver.solveSteady({ pressureGradientPaPerM: 500 }));
    expect(state.radialCentresM[0]).toBe(R / 64);
    expect(state.radialCentresM[31]).toBe(R - R / 64);
    expect(state.annularAreasM2.reduce((a, b) => a + b, 0)).toBeCloseTo(Math.PI * R ** 2, 15);
    expect(state.volumeM3).toBeCloseTo(Math.PI * R ** 2 * DEFAULT_ARTERY_CONFIG.lengthM, 15);
    expect(state.volumeRelativeError).toBeLessThan(5e-15);
    expect(solver.velocityAtRadius(R)).toBe(0);
    expect(solver.velocityAtRadius(0)).toBe(solver.velocityAtRadius(R / 128));
    expect(state.axialVelocityMS.at(-1)).toBeGreaterThan(0);
    expect(state.wallShearRateS).toBeCloseTo(state.axialVelocityMS[31]! / (R / 64), 12);
    expect(state.wallShearPa).toBeCloseTo(MU * state.wallShearRateS, 12);
  });

  it.each([
    { radiusM: 0 }, { lengthM: NaN }, { densityKgM3: -1 }, { radialCells: 3 },
    { radialCells: 16.5 }, { maxNonlinearIterations: 0 }, { nonlinearRelativeTolerance: .1 },
    { rheology: { kind: "newtonian", viscosityPaS: 0 } },
    { rheology: { kind: "carreau-yasuda", profileId: "invented" } },
  ])("rejects invalid SI configuration %j", patch => {
    expect(() => new ArteryFlowSolver(patch as Partial<ArteryConfig>)).toThrow();
  });

  it("protects internal state from caller mutation and rejects malformed inputs", () => {
    const solver = new ArteryFlowSolver({ rheology: newtonian });
    const state = solver.snapshot(); state.axialVelocityMS[0] = 123; state.radialCentresM[0] = 9;
    expect(solver.snapshot().axialVelocityMS[0]).toBe(0);
    expect(solver.snapshot().radialCentresM[0]).toBe(R / 128);
    expect(() => solver.step({ dtSeconds: 0, pressureGradientPaPerM: 1 })).toThrow();
    expect(() => solver.step({ dtSeconds: .01, pressureGradientPaPerM: Infinity })).toThrow();
    expect(() => solver.velocityAtRadius(-1)).toThrow();
    expect(() => solver.velocityAtRadius(R * 1.001)).toThrow();
    expect(() => new ArteryFlowSolver({}, [0])).toThrow();
  });

  it("rejects unrepresentable derived SI quantities and timesteps before mutation", () => {
    expect(() => new ArteryFlowSolver({ lengthM: 1e-320 })).toThrow("volume");
    const longTube = new ArteryFlowSolver({ lengthM: 1e300, rheology: newtonian });
    expect(() => longTube.solveSteady({ pressureGradientPaPerM: 1e100 })).toThrow("Pressure drop");
    const solver = new ArteryFlowSolver({ rheology: newtonian });
    accepted(solver.step({ dtSeconds: 1e100, pressureGradientPaPerM: 0 }));
    const before = solver.snapshot();
    expect(() => solver.step({ dtSeconds: .01, pressureGradientPaPerM: 0 })).toThrow("clock");
    expect(solver.snapshot()).toEqual(before);
  });
});

describe("independent steady tube-flow verification", () => {
  it("converges to physical-radius Poiseuille velocity and Q at second order on three meshes", () => {
    const gradient = 500, exactQ = Math.PI * gradient * R ** 4 / (8 * MU);
    const errors = [16, 32, 64].map(radialCells => {
      const solver = new ArteryFlowSolver({ radialCells, rheology: newtonian });
      const result = solver.solveSteady({ pressureGradientPaPerM: gradient }), state = accepted(result);
      const reference = state.radialCentresM.map(r => gradient * (R ** 2 - r ** 2) / (4 * MU));
      const velocityError = l2(state.axialVelocityMS, reference, state.annularAreasM2);
      const flowError = Math.abs(state.flowRateM3S / exactQ - 1);
      expect(state.wallShearPa).toBeCloseTo(gradient * R / 2, 10);
      expect(result.telemetry.momentumBalanceRelativeError).toBeLessThan(1e-11);
      expect(state.viscousDissipationW / (gradient * DEFAULT_ARTERY_CONFIG.lengthM * state.flowRateM3S)).toBeCloseTo(1, 10);
      expect(result.telemetry.iterations).toBe(1);
      expect(state.timeSeconds).toBe(0); expect(state.acceptedSteps).toBe(0);
      return { radialCells, velocityError, flowError, momentumResidualPaPerM: result.telemetry.momentumResidualPaPerM };
    });
    expect(errors[0]!.flowError).toBeLessThan(.004);
    expect(errors[2]!.velocityError).toBeLessThan(.00012);
    for (let i = 1; i < errors.length; ++i) {
      expect(errors[i - 1]!.flowError / errors[i]!.flowError).toBeGreaterThan(3.95);
      expect(errors[i - 1]!.velocityError / errors[i]!.velocityError).toBeGreaterThan(3.95);
    }
    console.info("Poiseuille mesh convergence:", JSON.stringify(errors));
  });

  it.each(BLOOD_PROFILES.map(profile => [profile.id, profile] as const))(
    "matches independent inverse-stress CY quadrature for %s on three meshes", (_id, profile) => {
      const gradient = 500, gamma = (r: number) => inverseCY(gradient * r / 2, profile);
      const exactQ = Math.PI * simpson(r => gamma(r) * r ** 2, 0, R);
      const errors = [16, 32, 64].map(radialCells => {
        const solver = new ArteryFlowSolver({
          radialCells, rheology: { kind: "carreau-yasuda", profileId: profile.id },
          nonlinearRelativeTolerance: 1e-10, maxNonlinearIterations: 200,
        });
        const result = solver.solveSteady({ pressureGradientPaPerM: gradient }), state = accepted(result);
        const reference = state.radialCentresM.map(r => simpson(gamma, r, R, 128));
        expect(Math.abs(state.wallShearPa / (gradient * R / 2) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(state.wallShearRateS / gamma(R) - 1)).toBeLessThan(1e-9);
        expect(result.telemetry.relativeMomentumResidual).toBeLessThanOrEqual(1e-10);
        expect(result.telemetry.iterations).toBeGreaterThan(1);
        return { radialCells, q: Math.abs(state.flowRateM3S / exactQ - 1), velocity: l2(state.axialVelocityMS, reference, state.annularAreasM2),
          iterations: result.telemetry.iterations, momentumResidualPaPerM: result.telemetry.momentumResidualPaPerM };
      });
      expect(errors[2]!.q).toBeLessThan(.0005);
      expect(errors[2]!.velocity).toBeLessThan(.0003);
      for (let i = 1; i < errors.length; ++i) {
        expect(errors[i - 1]!.q / errors[i]!.q).toBeGreaterThan(3.5);
        expect(errors[i - 1]!.velocity / errors[i]!.velocity).toBeGreaterThan(3.5);
      }
      console.info(`CY mesh convergence ${profile.id}:`, JSON.stringify(errors));
    },
  );

  it("supports signed reverse flow and distinguishes both published CY laws", () => {
    const values = BLOOD_PROFILES.map(profile => {
      const make = () => new ArteryFlowSolver({ rheology: { kind: "carreau-yasuda", profileId: profile.id } });
      const forward = accepted(make().solveSteady({ pressureGradientPaPerM: 500 }));
      const reverse = accepted(make().solveSteady({ pressureGradientPaPerM: -500 }));
      expect(reverse.flowRateM3S).toBeCloseTo(-forward.flowRateM3S, 14);
      expect(reverse.wallShearPa).toBeCloseTo(-forward.wallShearPa, 12);
      expect(reverse.kineticEnergyJ).toBeCloseTo(forward.kineticEnergyJ, 14);
      expect(reverse.viscousDissipationW).toBeGreaterThan(0);
      return forward.flowRateM3S;
    });
    expect(Math.abs(values[0]! / values[1]! - 1)).toBeGreaterThan(.005);
  });

  it("also matches the independent 80-digit mpmath/SciPy steady CY oracle", () => {
    const solver = new ArteryFlowSolver({ radialCells: 128, nonlinearRelativeTolerance: 1e-10, maxNonlinearIterations: 200 });
    const state = accepted(solver.solveSteady({ pressureGradientPaPerM: carreauReference.inputs.pressureGradientPaPerM }));
    expect(Math.abs(state.flowRateM3S / carreauReference.flowRateM3S.value - 1)).toBeLessThan(.0001);
    expect(Math.abs(state.wallShearPa / carreauReference.wallTractionOnSolidPa.value - 1)).toBeLessThan(1e-9);
    expect(Math.abs(state.wallShearRateS / carreauReference.wallShearRatePerS.value - 1)).toBeLessThan(1e-9);
    for (const row of carreauReference.radialProfiles) {
      const actual = solver.velocityAtRadius(row.radiusFraction * R);
      expect(Math.abs(actual - row.velocityMS.value)).toBeLessThan(2e-5);
    }
  });
});

describe("transient momentum, dissipation and pulsatile response", () => {
  it("preserves rest and tube volume without inventing transport", () => {
    const solver = new ArteryFlowSolver();
    for (let i = 0; i < 20; ++i) {
      const state = accepted(solver.step({ dtSeconds: .01, pressureGradientPaPerM: 0 }));
      expect(state.axialVelocityMS.every(v => v === 0)).toBe(true);
      expect(state.flowRateM3S).toBe(0); expect(state.netTransportedVolumeM3).toBe(0);
      expect(state.volumeRelativeError).toBeLessThan(5e-15);
    }
    expect(solver.snapshot().timeSeconds).toBeCloseTo(.2, 14);
  });

  it.each(["newtonian", "carreau-yasuda"] as const)("dissipates energy and balances momentum for %s", kind => {
    const solver = new ArteryFlowSolver({ rheology: kind === "newtonian" ? newtonian : DEFAULT_ARTERY_CONFIG.rheology });
    let previous = accepted(solver.solveSteady({ pressureGradientPaPerM: 500 }));
    for (let i = 0; i < 60; ++i) {
      const result = solver.step({ dtSeconds: .005, pressureGradientPaPerM: 0 }), state = accepted(result);
      expect(state.kineticEnergyJ).toBeLessThan(previous.kineticEnergyJ);
      expect(state.axialVelocityMS.every(v => v > 0)).toBe(true);
      expect(state.viscousDissipationW).toBeGreaterThan(0);
      expect(Math.abs(result.telemetry.energyBalanceResidualJ!) / previous.kineticEnergyJ).toBeLessThan(1e-8);
      expect(result.telemetry.backwardEulerDissipationJ).toBeGreaterThan(0);
      expect(result.telemetry.momentumBalanceRelativeError).toBeLessThan(1e-7);
      expect(state.volumeM3).toBe(previous.volumeM3);
      previous = state;
    }
  });

  it("converges in time toward independent Bessel eigenmode decay", () => {
    const radialCells = 128, alpha = 2.404825557695773, finalTime = .08;
    const initial = Float64Array.from({ length: radialCells }, (_, i) => .2 * j0(alpha * (i + .5) / radialCells));
    const errors = [.004, .002, .001].map(dtSeconds => {
      const solver = new ArteryFlowSolver({ radialCells, rheology: newtonian }, initial);
      for (let i = 0; i < Math.round(finalTime / dtSeconds); ++i) accepted(solver.step({ dtSeconds, pressureGradientPaPerM: 0 }));
      const state = solver.snapshot(), decay = Math.exp(-MU / RHO * (alpha / R) ** 2 * finalTime);
      const reference = initial.map(v => v * decay);
      return l2(state.axialVelocityMS, reference, state.annularAreasM2);
    });
    expect(errors[2]).toBeLessThan(.0002);
    expect(errors[0]! / errors[1]!).toBeGreaterThan(1.8);
    expect(errors[1]! / errors[2]!).toBeGreaterThan(1.8);
    console.info("Bessel transient refinement:", JSON.stringify(errors));
  });

  it("converges to the independent Womersley complex flow, traction and profile over complete cycles", () => {
    const period = womersleyReference.derived.periodSeconds.value, omega = womersleyReference.derived.omegaRadS.value;
    const errors = [128, 256, 512].map(stepsPerCycle => {
      const dtSeconds = period / stepsPerCycle;
      const solver = new ArteryFlowSolver({ radialCells: 128, rheology: newtonian });
      const q: number[] = [], wall: number[] = [], profiles = womersleyReference.radialProfiles.map(() => [] as number[]);
      for (let i = 1; i <= 9 * stepsPerCycle; ++i) {
        const gradient = womersleyReference.inputs.meanPressureGradientPaPerM
          + womersleyReference.inputs.harmonicPressureGradientPaPerM * Math.cos(omega * i * dtSeconds);
        const state = accepted(solver.step({ dtSeconds, pressureGradientPaPerM: gradient }));
        if (i > 8 * stepsPerCycle) {
          q.push(state.flowRateM3S); wall.push(state.wallShearPa);
          womersleyReference.radialProfiles.forEach((p, index) => profiles[index]!.push(solver.velocityAtRadius(p.radiusM)));
        }
      }
      const flow = harmonic(q, womersleyReference.flowRate.harmonicM3S);
      const traction = harmonic(wall, womersleyReference.wallTractionOnSolid.harmonicPa);
      const velocity = profiles.slice(0, -1).map((samples, i) => harmonic(samples, womersleyReference.radialProfiles[i]!.harmonicVelocityMS));
      expect(Math.abs(q.reduce((a, b) => a + b, 0) / stepsPerCycle / womersleyReference.flowRate.meanM3S.value - 1)).toBeLessThan(.0001);
      expect(profiles.at(-1)!.every(v => v === 0)).toBe(true);
      return { stepsPerCycle, flow, traction, maximumVelocityError: Math.max(...velocity.map(v => v.relativeError)) };
    });
    expect(errors[2]!.flow.relativeError).toBeLessThan(.006);
    expect(errors[2]!.flow.phaseErrorRad).toBeLessThan(.006);
    expect(errors[2]!.traction.relativeError).toBeLessThan(.006);
    expect(errors[2]!.maximumVelocityError).toBeLessThan(.01);
    for (let i = 1; i < errors.length; ++i) {
      expect(errors[i - 1]!.flow.relativeError / errors[i]!.flow.relativeError).toBeGreaterThan(1.8);
      expect(errors[i - 1]!.traction.relativeError / errors[i]!.traction.relativeError).toBeGreaterThan(1.7);
    }
    console.info("Independent Womersley convergence:", JSON.stringify(errors));
  });
});

describe("deterministic UI parameter envelope", () => {
  it("integrates boundary combinations for two cycles with finite conservative state and explicit reversal", () => {
    const cases = [
      { radiusM: .001, mean: 0, amplitude: 1200, bpm: 150, dt: .002, radialCells: 32 },
      { radiusM: .005, mean: 1000, amplitude: 1200, bpm: 40, dt: .0005, radialCells: 128 },
      { radiusM: .005, mean: 0, amplitude: 1200, bpm: 150, dt: .0005, radialCells: 32 },
      { radiusM: .001, mean: 1000, amplitude: 0, bpm: 40, dt: .002, radialCells: 128 },
      { radiusM: .005, mean: 0, amplitude: 0, bpm: 40, dt: .0005, radialCells: 128 },
      { radiusM: .001, mean: 0, amplitude: 1200, bpm: 40, dt: .002, radialCells: 128 },
    ];
    const reports = [];
    for (const kind of ["newtonian", "carreau-yasuda"] as const) for (const parameters of cases) {
      const { radiusM, mean, amplitude, bpm, dt, radialCells } = parameters;
      const solver = new ArteryFlowSolver({ radiusM, radialCells, rheology: kind === "newtonian" ? newtonian : DEFAULT_ARTERY_CONFIG.rheology });
      const count = Math.ceil(120 / bpm / dt), initialVolume = solver.snapshot().volumeM3;
      let minQ = Infinity, maxQ = -Infinity, maxIterations = 0, maxResidual = 0, maxEnergyResidual = 0;
      let previousEnergy = 0, minEnergy = Infinity, minDissipation = Infinity, maxVolumeError = 0;
      for (let step = 1; step <= count; ++step) {
        const gradient = mean + amplitude * Math.cos(2 * Math.PI * bpm / 60 * step * dt);
        const result = solver.step({ dtSeconds: dt, pressureGradientPaPerM: gradient });
        if (result.status !== "accepted")
          throw new Error(`Envelope rejected ${JSON.stringify({ kind, ...parameters, step, reason: result.reason, telemetry: result.telemetry })}`);
        const state = result.snapshot;
        if (!state.axialVelocityMS.every(Number.isFinite) || ![state.flowRateM3S, state.wallShearPa, state.kineticEnergyJ, state.viscousDissipationW].every(Number.isFinite))
          throw new Error(`Non-finite envelope state at ${kind}, step ${step}`);
        const energyScale = Math.max(previousEnergy, state.kineticEnergyJ, Math.abs(dt * gradient * DEFAULT_ARTERY_CONFIG.lengthM * state.flowRateM3S), 1e-24);
        maxEnergyResidual = Math.max(maxEnergyResidual, Math.abs(result.telemetry.energyBalanceResidualJ!) / energyScale);
        previousEnergy = state.kineticEnergyJ;
        minEnergy = Math.min(minEnergy, state.kineticEnergyJ);
        minDissipation = Math.min(minDissipation, state.viscousDissipationW);
        maxVolumeError = Math.max(maxVolumeError, Math.abs(state.volumeM3 / initialVolume - 1), state.volumeRelativeError);
        minQ = Math.min(minQ, state.flowRateM3S); maxQ = Math.max(maxQ, state.flowRateM3S);
        maxIterations = Math.max(maxIterations, result.telemetry.iterations);
        maxResidual = Math.max(maxResidual, result.telemetry.relativeMomentumResidual);
      }
      expect(solver.snapshot().acceptedSteps).toBe(count);
      expect(maxVolumeError).toBeLessThan(5e-15);
      expect(minEnergy).toBeGreaterThanOrEqual(0); expect(minDissipation).toBeGreaterThanOrEqual(0);
      expect(maxResidual).toBeLessThanOrEqual(DEFAULT_ARTERY_CONFIG.nonlinearRelativeTolerance);
      expect(maxEnergyResidual).toBeLessThan(1e-7);
      if (mean === 0 && amplitude > 0) { expect(minQ).toBeLessThan(0); expect(maxQ).toBeGreaterThan(0); }
      reports.push({ kind, ...parameters, acceptedSteps: count, minQ, maxQ, maxIterations, maxResidual, maxEnergyResidual, maxVolumeError });
    }
    console.info("Deterministic artery envelope:", JSON.stringify(reports));
  }, 30000);
});

describe("nonlinear acceptance and failure isolation", () => {
  it("rejects insufficient nonlinear iteration budgets without advancing state, clock or transport", () => {
    const solver = new ArteryFlowSolver({ maxNonlinearIterations: 1 });
    const before = solver.snapshot();
    const result = solver.step({ dtSeconds: .2, pressureGradientPaPerM: 2000 });
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("iteration limit");
    expect(result.telemetry.converged).toBe(false);
    expect(result.telemetry.iterations).toBe(1);
    expect(result.telemetry.relativeMomentumResidual).toBeGreaterThan(DEFAULT_ARTERY_CONFIG.nonlinearRelativeTolerance);
    expect(solver.snapshot()).toEqual(before);
    accepted(solver.step({ dtSeconds: .01, pressureGradientPaPerM: 0 }));
    expect(solver.snapshot().acceptedSteps).toBe(1);
  });

  it("rejects rates outside the evaluated constitutive domain and retains the previous state", () => {
    const solver = new ArteryFlowSolver();
    const before = solver.snapshot();
    const result = solver.solveSteady({ pressureGradientPaPerM: 1e12 });
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("Shear rate");
    expect(solver.snapshot()).toEqual(before);
  });
});
