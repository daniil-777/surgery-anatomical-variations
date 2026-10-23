import { describe, expect, it } from "vitest";
import { CapillaryFilmSolver, DEFAULT_FILM_CONFIG, type FilmStep } from "./solver";

const sigma = .05, mu = .01, base = 20e-6;
function accepted(step: FilmStep) {
  expect(step.accepted, step.reason).toBe(true);
  expect(step.telemetry.normalizedResidual).toBeLessThanOrEqual(1e-10);
  return step.snapshot;
}
function cosineHeight(cells: number, lengthM: number, amplitude = 1e-4 * base) {
  return Float64Array.from({ length: cells }, (_, i) => base + amplitude * Math.cos(2 * Math.PI * (i + .5) / cells));
}
function amplitude(height: Float64Array) {
  let value = 0;
  for (let i = 0; i < height.length; i++) value += 2 / height.length * (height[i]! - base)
    * Math.cos(2 * Math.PI * (i + .5) / height.length);
  return value;
}
function profile(cells = DEFAULT_FILM_CONFIG.cells) {
  return Float64Array.from({ length: cells }, (_, i) => 8e-6
    + 80e-6 * Math.exp(-Math.pow(((i + .5) / cells * .004 - .002) / .0008, 4)));
}

/**
 * Independent continuum first integral, NOT the FV pressure operator/Newton solve.
 * Solve sigma h'^2/2 = phi(h)-phi(h_min)-p(h-h_min), with p chosen so h_max
 * is the second turning point. sin² substitution removes both endpoint square
 * root singularities. 32768 quadrature panels resolve the continuum reference.
 */
function periodicRidgeReference() {
  const hp = 8e-6, theta = .12, lo = 1.03, hi = 10, delta = hi - lo;
  const potential = (r: number) => r ** -5 / 5 - r ** -2 / 2;
  const derivative = (r: number) => r ** -3 - r ** -6;
  const pressure = (potential(hi) - potential(lo)) / delta;
  const excess = (r: number) => potential(r) - potential(lo) - pressure * (r - lo);
  const scale = hp / Math.sqrt(10 / 3 * theta ** 2), panels = 32768;
  const xs = new Float64Array(panels + 1), hs = new Float64Array(panels + 1);
  let previous = 0;
  for (let i = 0; i <= panels; i++) {
    const t = Math.PI / 2 * i / panels, r = lo + delta * Math.sin(t) ** 2;
    hs[i] = hp * r;
    const integrand = scale * (i === 0 ? 2 * Math.sqrt(delta / (derivative(lo) - pressure))
      : i === panels ? 2 * Math.sqrt(delta / (pressure - derivative(hi)))
        : 2 * delta * Math.sin(t) * Math.cos(t) / Math.sqrt(excess(r)));
    if (i > 0) xs[i] = xs[i - 1]! + .5 * (previous + integrand) * Math.PI / (2 * panels);
    previous = integrand;
  }
  const half = xs[panels]!, lengthM = 2 * half;
  const heightAt = (x: number) => {
    const at = x <= half ? x : lengthM - x;
    let low = 0, high = panels;
    while (high - low > 1) { const mid = (low + high) >> 1; if (xs[mid]! < at) low = mid; else high = mid; }
    const fraction = (at - xs[low]!) / (xs[high]! - xs[low]!);
    return hs[low]! * (1 - fraction) + hs[high]! * fraction;
  };
  let slopeLow = Math.cbrt(2), slopeHigh = hi;
  for (let i = 0; i < 64; i++) {
    const mid = .5 * (slopeLow + slopeHigh);
    if (derivative(mid) > pressure) slopeLow = mid; else slopeHigh = mid;
  }
  return {
    lengthM, hp, theta, heightAt,
    pressurePa: 5 / 3 * sigma * theta ** 2 / hp * pressure,
    maxSlope: Math.sqrt(10 / 3 * theta ** 2 * excess(.5 * (slopeLow + slopeHigh))),
  };
}

describe("SI thin-film capillary reference", () => {
  it("keeps a flat precursor stationary and defines actual extruded volume", () => {
    const solver = new CapillaryFilmSolver();
    const before = solver.snapshot();
    expect(before.volumeM3).toBeCloseTo(.004 * .001 * 8e-6, 20);
    const after = accepted(solver.step(.25));
    expect(Array.from(after.heightM)).toEqual(Array.from(before.heightM));
    expect(after.pressurePa.every(p => Math.abs(p) < 1e-10)).toBe(true);
    expect(solver.timeSeconds).toBe(.25);
  });

  it("converges to the continuum capillary Fourier leveling rate in space", () => {
    const lengthM = .002, rate = sigma * base ** 3 / (3 * mu) * (2 * Math.PI / lengthM) ** 4;
    const errors: number[] = [];
    for (const cells of [16, 32, 64]) {
      const initial = cosineHeight(cells, lengthM);
      const solver = new CapillaryFilmSolver({ cells, lengthM, wetting: null }, initial);
      const dt = .05 / rate;
      const measured = (amplitude(initial) / amplitude(accepted(solver.step(dt)).heightM) - 1) / dt;
      errors.push(Math.abs(measured / rate - 1));
    }
    expect(errors[0]! / errors[1]!).toBeGreaterThan(3.8);
    expect(errors[1]! / errors[2]!).toBeGreaterThan(3.8);
    expect(errors[2]).toBeLessThan(.002);
    console.log("film Fourier spatial", { ratePerSecond: rate, errors });
  });

  it("converges in time to exponential capillary relaxation, not an inertial oscillation", () => {
    const lengthM = .002, rate = sigma * base ** 3 / (3 * mu) * (2 * Math.PI / lengthM) ** 4;
    const duration = .5 / rate, initial = cosineHeight(128, lengthM);
    const target = amplitude(initial) * Math.exp(-rate * duration), errors: number[] = [];
    for (const steps of [8, 16, 32]) {
      const solver = new CapillaryFilmSolver({ cells: 128, lengthM, wetting: null }, initial);
      for (let i = 0; i < steps; i++) accepted(solver.step(duration / steps));
      errors.push(Math.abs(amplitude(solver.snapshot().heightM) / target - 1));
    }
    expect(errors[0]! / errors[1]!).toBeGreaterThan(1.8);
    expect(errors[1]! / errors[2]!).toBeGreaterThan(1.8);
    expect(errors[2]).toBeLessThan(.005);
    console.log("film Fourier temporal", { errors });
  });

  it("uses the declared physical viscosity and surface tension in the relaxation rate", () => {
    const lengthM = .002, initial = cosineHeight(64, lengthM);
    const observed = (surfaceTensionNm: number, viscosityPaS: number) => {
      const solver = new CapillaryFilmSolver({ cells: 64, lengthM, wetting: null, surfaceTensionNm, viscosityPaS }, initial);
      return (amplitude(initial) / amplitude(accepted(solver.step(.01)).heightM) - 1) / .01;
    };
    const rate = observed(sigma, mu);
    expect(observed(2 * sigma, mu) / rate).toBeCloseTo(2, 5);
    expect(observed(sigma, 2 * mu) / rate).toBeCloseTo(.5, 5);
  });

  it("converges to the cylindrical Young–Laplace pressure at three circular-ridge apex radii", () => {
    const report: unknown[] = [];
    for (const radius of [.0005, .001, .002]) {
      const lengthM = .1 * radius, errors: number[] = [];
      for (const cells of [16, 32, 64]) {
        const height = Float64Array.from({ length: cells }, (_, i) => {
          const x = lengthM * ((i + .5) / cells - .5);
          return .002 * radius + Math.sqrt(radius ** 2 - x ** 2) - radius;
        });
        const state = new CapillaryFilmSolver({ cells, lengthM, wetting: null }, height).snapshot();
        const measured = .5 * (state.capillaryPressurePa[cells / 2 - 1]! + state.capillaryPressurePa[cells / 2]!);
        errors.push(Math.abs(measured / (sigma / radius) - 1));
      }
      expect(errors[0]! / errors[1]!).toBeGreaterThan(3.9);
      expect(errors[1]! / errors[2]!).toBeGreaterThan(3.9);
      expect(errors[2]).toBeLessThan(2e-6);
      report.push({ radiusM: radius, expectedPressurePa: sigma / radius, errors });
    }
    console.log("film cylindrical apex Laplace", report);
  });

  it("surface forces sum to zero and pressure is the derivative of actual interface energy", () => {
    const cells = 64, lengthM = .004, initial = cosineHeight(cells, lengthM, 5e-6);
    const state = new CapillaryFilmSolver({ cells, lengthM, wetting: null }, initial).snapshot();
    const absoluteForce = state.capillaryNormalForceN.reduce((a, b) => a + Math.abs(b), 0);
    expect(Math.abs(state.capillaryNormalForceN.reduce((a, b) => a + b, 0)) / absoluteForce).toBeLessThan(1e-12);
    const index = 9, delta = 1e-10, plus = initial.slice(), minus = initial.slice();
    plus[index]! += delta; minus[index]! -= delta;
    const energyPlus = new CapillaryFilmSolver({ cells, lengthM, wetting: null }, plus).snapshot().energyJ;
    const energyMinus = new CapillaryFilmSolver({ cells, lengthM, wetting: null }, minus).snapshot().energyJ;
    const force = -(energyPlus - energyMinus) / (2 * delta);
    expect(Math.abs(force / state.capillaryNormalForceN[index]! - 1)).toBeLessThan(1e-8);
  });

  it("matches an independent wetting-ridge continuum equilibrium and contact-region slope", () => {
    const reference = periodicRidgeReference(), pressureErrors: number[] = [], slopeErrors: number[] = [];
    for (const cells of [64, 128, 256]) {
      const height = Float64Array.from({ length: cells }, (_, i) => reference.heightAt((i + .5) / cells * reference.lengthM));
      const state = new CapillaryFilmSolver({
        cells, lengthM: reference.lengthM, wetting: { precursorHeightM: reference.hp, equilibriumAngleRadians: reference.theta },
      }, height).snapshot();
      pressureErrors.push(Math.sqrt(state.pressurePa.reduce((s, p) => s + (p - reference.pressurePa) ** 2, 0) / cells) / reference.pressurePa);
      slopeErrors.push(Math.abs(state.maxSlope / reference.maxSlope - 1));
    }
    expect(pressureErrors[0]! / pressureErrors[1]!).toBeGreaterThan(3.4);
    expect(pressureErrors[1]! / pressureErrors[2]!).toBeGreaterThan(3.4);
    expect(pressureErrors[2]).toBeLessThan(.012);
    expect(slopeErrors[2]).toBeLessThan(.001);
    console.log("film independent wetting ridge", { ...reference, heightAt: undefined, pressureErrors, slopeErrors });
  });

  it("evolves a wetting ridge with conserved volume, positive height and dissipated surface energy", () => {
    const solver = new CapillaryFilmSolver({}, profile()), before = solver.snapshot();
    let iterations = 0, residual = 0, volumeError = 0, reynolds = 0;
    let energy = before.energyJ;
    for (let i = 0; i < 200; i++) {
      const step = solver.step(.005), state = accepted(step), t = step.telemetry;
      expect(state.energyJ).toBeLessThanOrEqual(energy + Math.abs(energy) * 2e-10);
      expect(t.energyInequalityDefectJ).toBeLessThanOrEqual(Math.abs(energy) * 2e-8);
      expect(Math.min(...state.heightM)).toBeGreaterThan(0);
      expect(Math.abs(state.volumeM3 / before.volumeM3 - 1)).toBeLessThan(2e-10);
      iterations = Math.max(iterations, t.newtonIterations); residual = Math.max(residual, t.normalizedResidual);
      volumeError = Math.max(volumeError, t.relativeVolumeError); reynolds = Math.max(reynolds, t.maxFilmReynolds);
      energy = state.energyJ;
    }
    expect(Math.abs(energy - before.energyJ)).toBeGreaterThan(Math.abs(before.energyJ) * .01);
    const after = solver.snapshot();
    expect(Math.abs(Math.max(...after.heightM) - Math.max(...before.heightM))).toBeGreaterThan(2e-6);
    console.log("film demonstrator 1s", { iterations, residual, volumeError, reynolds,
      energyBeforeJ: before.energyJ, energyAfterJ: energy, minHeightM: Math.min(...after.heightM),
      peakBeforeM: Math.max(...before.heightM), peakAfterM: Math.max(...after.heightM) });
  }, 30_000);

  it("retains the exact accepted profile, clock and energy when an attempt cannot converge", () => {
    const solver = new CapillaryFilmSolver({ maxNewtonIterations: 1 }, profile());
    const before = solver.snapshot(), rejected = solver.step(1);
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toMatch(/iteration|search/);
    expect(solver.snapshot()).toEqual(before);
    expect(solver.timeSeconds).toBe(0);
  });

  it("predicts physical spinodal wetting instability and converges to its independent continuum growth rate", () => {
    const hp = 8e-6, h0 = 2 * hp, theta = .12, lengthM = .001, cells = 128;
    const a = 5 / 3 * sigma * theta ** 2 * hp ** 2, b = a * hp ** 3, k = 2 * Math.PI / lengthM;
    const potentialCurvature = -3 * a / h0 ** 4 + 6 * b / h0 ** 7;
    const growthRate = -(h0 ** 3) / (3 * mu) * k * k * (sigma * k * k + potentialCurvature);
    expect(growthRate).toBeGreaterThan(0);
    const amplitudeOf = (height: Float64Array) => height.reduce((value, h, i) =>
      value + 2 / cells * (h - h0) * Math.cos(2 * Math.PI * (i + .5) / cells), 0);
    const initial = Float64Array.from({ length: cells }, (_, i) => h0 * (1 + 1e-4 * Math.cos(2 * Math.PI * (i + .5) / cells)));
    const errors: number[] = [];
    for (const steps of [25, 50, 100]) {
      const solver = new CapillaryFilmSolver({ lengthM, cells }, initial);
      for (let i = 0; i < steps; i++) accepted(solver.step(.1 / steps));
      const measured = amplitudeOf(solver.snapshot().heightM);
      expect(measured).toBeGreaterThan(amplitudeOf(initial));
      errors.push(Math.abs(measured / (amplitudeOf(initial) * Math.exp(.1 * growthRate)) - 1));
    }
    expect(errors[0]! / errors[1]!).toBeGreaterThan(1.75);
    expect(errors[1]! / errors[2]!).toBeGreaterThan(1.75);
    expect(errors[2]).toBeLessThan(.01);
    console.log("film spinodal wetting growth", { growthRatePerSecond: growthRate, errors });
  });

  it("preserves a continuum wetting equilibrium with profile error decreasing under refinement", () => {
    const reference = periodicRidgeReference(), errors: number[] = [];
    for (const cells of [64, 128, 256]) {
      const initial = Float64Array.from({ length: cells }, (_, i) => reference.heightAt((i + .5) / cells * reference.lengthM));
      const solver = new CapillaryFilmSolver({ cells, lengthM: reference.lengthM }, initial);
      // A smaller common dt is required at N=256 to keep Float64 cancellation
      // in the stiff fourth-order residual below the unchanged 1e-10 gate.
      for (let i = 0; i < 200; i++) {
        const result = solver.step(.001);
        expect(result.accepted, JSON.stringify({ cells, step: i, reason: result.reason, telemetry: result.telemetry })).toBe(true);
        accepted(result);
      }
      const final = solver.snapshot().heightM;
      errors.push(Math.sqrt(final.reduce((total, h, i) => total + (h - initial[i]!) ** 2, 0)
        / initial.reduce((total, h) => total + h * h, 0)));
    }
    expect(errors[0]! / errors[1]!).toBeGreaterThan(3.5);
    expect(errors[1]! / errors[2]!).toBeGreaterThan(3.5);
    expect(errors[2]).toBeLessThan(.001);
    console.log("film wetting equilibrium evolution", { durationSeconds: .2, profileErrors: errors });
  }, 30_000);

  it("accepts all 12 exposed playground combinations for one physical second with volume/energy accounting", () => {
    const cases: unknown[] = [];
    for (const surfaceTensionNm of [.04, .05, .06]) for (const angle of [null, .08, .12, .16]) {
      const solver = new CapillaryFilmSolver({
        surfaceTensionNm,
        wetting: angle === null ? null : { precursorHeightM: 8e-6, equilibriumAngleRadians: angle },
      }, profile());
      const before = solver.snapshot();
      let volumeError = 0, maxRe = 0, maxIterations = 0, maxResidual = 0, energy = before.energyJ;
      for (let i = 0; i < 200; i++) {
        const result = solver.step(.005), state = accepted(result);
        expect(state.energyJ).toBeLessThanOrEqual(energy + Math.abs(energy) * 2e-10);
        expect(state.maxSlope).toBeLessThanOrEqual(.3);
        expect(result.telemetry.minimumHeightM).toBeGreaterThan(0);
        volumeError = Math.max(volumeError, result.telemetry.relativeVolumeError);
        maxRe = Math.max(maxRe, result.telemetry.maxFilmReynolds);
        maxIterations = Math.max(maxIterations, result.telemetry.newtonIterations);
        maxResidual = Math.max(maxResidual, result.telemetry.normalizedResidual);
        energy = state.energyJ;
      }
      expect(volumeError).toBeLessThan(2e-10);
      expect(solver.timeSeconds).toBeCloseTo(1, 12);
      cases.push({ surfaceTensionNm, angle, volumeError, maxRe, maxIterations, maxResidual });
    }
    console.log("film playground envelope", { cases: 12, acceptedSteps: 2400, results: cases });
  }, 30_000);

  it("does not introduce a preferred location or direction at the periodic seam", () => {
    const cells = 64, shift = 19, initial = profile(cells);
    const shifted = Float64Array.from({ length: cells }, (_, i) => initial[(i + shift) % cells]!);
    const a = new CapillaryFilmSolver({ cells }, initial), b = new CapillaryFilmSolver({ cells }, shifted);
    for (let i = 0; i < 40; i++) { accepted(a.step(.005)); accepted(b.step(.005)); }
    const first = a.snapshot(), second = b.snapshot(), peak = Math.max(...first.heightM);
    for (let i = 0; i < cells; i++) {
      expect(Math.abs(first.heightM[(i + shift) % cells]! - second.heightM[i]!) / peak).toBeLessThan(1e-10);
      expect(Math.abs(first.heightM[i]! - first.heightM[cells - 1 - i]!) / peak).toBeLessThan(1e-10);
    }
  });

  it("rejects inertia-dominated candidates instead of silently applying an overdamped model", () => {
    const solver = new CapillaryFilmSolver({ viscosityPaS: .0001 }, profile()), before = solver.snapshot();
    const result = solver.step(.0001);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/Reynolds/);
    expect(result.telemetry.maxFilmReynolds).toBeGreaterThan(1);
    expect(solver.snapshot()).toEqual(before);
  });

  it("rejects invalid or out-of-scope inputs and returns detached snapshot arrays", () => {
    expect(() => new CapillaryFilmSolver({ viscosityPaS: 0 })).toThrow();
    expect(() => new CapillaryFilmSolver({ wetting: { precursorHeightM: 1e-6, equilibriumAngleRadians: Math.PI / 2 } })).toThrow(/0.25/);
    expect(() => new CapillaryFilmSolver({ cells: 7 })).toThrow();
    expect(() => new CapillaryFilmSolver({}, new Float64Array(96))).toThrow(/positive/);
    const solver = new CapillaryFilmSolver(), before = solver.snapshot();
    expect(() => solver.step(-1)).toThrow(); expect(() => solver.step(NaN)).toThrow();
    const snapshot = solver.snapshot(); snapshot.heightM.fill(0);
    expect(solver.snapshot()).toEqual(before);
  });
});
