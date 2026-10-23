import { describe, expect, it } from "vitest";
import type { PhysicsParameters } from "../atlasPhysics";
import { cofactor, continuumProperties, continuumResponse, determinant, emptyMaxwellState } from "../liverContinuumMaterial";
import { createLogVolumeCorrection, LOG_VOLUME_PROVENANCE } from "./logVolume";

const parameters: PhysicsParameters = { young_pa: 4800, poisson: .45, relaxation_fraction: .42, relaxation_time_s: .65,
  density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
const relative = (actual: number, expected: number, tolerance = 2e-7) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(expected)));
const multiply = (a: number[], b: ArrayLike<number>) => Float64Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3), column = index % 3;
  return a[3 * row]! * b[column]! + a[3 * row + 1]! * b[3 + column]! + a[3 * row + 2]! * b[6 + column]!;
});

describe("cutting-only canonical log-volume equilibrium", () => {
  it("replaces rather than adds the stable potential and preserves the rest tangent", () => {
    for (const material of [parameters, { ...parameters, relaxation_fraction: 0 }, { ...parameters, poisson: .2 }, { ...parameters, poisson: .49 }]) {
      const correction = createLogVolumeCorrection(material), { bulk: K, muEquilibrium: mu } = continuumProperties(material);
      expect(correction.evaluate(1)).toEqual({ energyDensity: 0, firstDerivativePa: 0, secondDerivativePa: 0 });
      for (const J of [.10001, .2, .6, .99, 1, 1.01, 1.5, 3]) {
        const F = new Float64Array([J, 0, 0, 0, 1, 0, 0, 0, 1]);
        // Suppress only the Maxwell branch here to isolate equilibrium; compare
        // against the canonical closed form, independent of delta derivation.
        const gamma = 1 + mu / (K + mu / 3);
        const original = mu / 2 * (J * J - 1) + (K + mu / 3) / 2 * ((J - gamma) ** 2 - (1 - gamma) ** 2);
        const expected = mu / 2 * (J * J - 1) - mu * Math.log(J) + (K - 2 * mu / 3) / 2 * Math.log(J) ** 2;
        relative(original + correction.evaluate(determinant(F)).energyDensity, expected, 2e-11);
      }
      const h = 1e-4;
      const hydrostaticEnergy = (strain: number) => {
        const stretch = 1 + strain, J = stretch ** 3;
        return mu / 2 * (3 * stretch * stretch - 3) - mu * Math.log(J) + (K - 2 * mu / 3) / 2 * Math.log(J) ** 2;
      };
      relative((hydrostaticEnergy(h) + hydrostaticEnergy(-h)) / h ** 2, 9 * K, 1e-6);
      // The correction itself has no linearized stiffness at rest.
      expect(Math.abs(correction.evaluate(1 + 1e-6).firstDerivativePa) / 1e-6).toBeLessThan(1e-5 * K);
    }
  });

  it("has energy-conjugate scalar and deformation-gradient derivatives", () => {
    const correction = createLogVolumeCorrection(parameters);
    for (const J of [.10001, .2, .55, .9, 1, 1.1, 1.8, 3]) {
      const h = J * 2e-6, response = correction.evaluate(J);
      relative((correction.evaluate(J + h).energyDensity - correction.evaluate(J - h).energyDensity) / (2 * h), response.firstDerivativePa, 3e-7);
      relative((correction.evaluate(J + h).firstDerivativePa - correction.evaluate(J - h).firstDerivativePa) / (2 * h), response.secondDerivativePa, 5e-7);
    }
    const F = new Float64Array([.63, .21, -.08, .03, 1.08, .12, .04, -.07, .91]);
    const J = determinant(F), cof = cofactor(F), response = correction.evaluate(J);
    for (let i = 0; i < 9; i++) {
      const plus = F.slice(), minus = F.slice(), h = 1e-6; plus[i]! += h; minus[i]! -= h;
      const derivative = (correction.evaluate(determinant(plus)).energyDensity - correction.evaluate(determinant(minus)).energyDensity) / (2 * h);
      relative(derivative, response.firstDerivativePa * cof[i]!, 3e-7);
    }
  });

  it("is objective under rigid rotation and preserves Maxwell history ownership", () => {
    const correction = createLogVolumeCorrection(parameters), angle = .71, c = Math.cos(angle), s = Math.sin(angle);
    const R = [c, -s, 0, s, c, 0, 0, 0, 1], F = new Float64Array([.7, .16, 0, .03, 1.1, .11, 0, -.04, .94]), rotated = multiply(R, F);
    const state = emptyMaxwellState(); state.previous[1] = .05; state.memory[3] = .13;
    const savedPrevious = state.previous.slice(), savedMemory = state.memory.slice();
    const original = continuumResponse(F, parameters, state, 1 / 480), turned = continuumResponse(rotated, parameters, state, 1 / 480);
    const a = correction.evaluate(original.jacobian), b = correction.evaluate(turned.jacobian);
    relative(original.energyDensity + a.energyDensity, turned.energyDensity + b.energyDensity, 1e-12);
    const firstCof = cofactor(F), secondCof = cofactor(rotated);
    const stress = Float64Array.from(original.stress, (v, i) => v + a.firstDerivativePa * firstCof[i]!);
    const expected = multiply(R, stress);
    for (let i = 0; i < 9; i++) relative(turned.stress[i]! + b.firstDerivativePa * secondCof[i]!, expected[i]!, 1e-11);
    expect(state.previous).toEqual(savedPrevious); expect(state.memory).toEqual(savedMemory);
    expect(original.state.previous).not.toBe(state.previous); expect(original.state.memory).not.toBe(state.memory);
  });

  it("resists compression without a new fitted penalty coefficient", () => {
    const correction = createLogVolumeCorrection(parameters), { muEquilibrium: mu, lambdaLog } = correction;
    let previousPressure = 0, previousEnergy = 0;
    for (const J of [.8, .5, .2, .1, .01, .001]) {
      const pressureMagnitude = (mu - lambdaLog * Math.log(J)) / J;
      const volumeEnergy = -mu * Math.log(J) + .5 * lambdaLog * Math.log(J) ** 2;
      expect(pressureMagnitude).toBeGreaterThan(previousPressure); expect(volumeEnergy).toBeGreaterThan(previousEnergy);
      previousPressure = pressureMagnitude; previousEnergy = volumeEnergy;
    }
    expect(LOG_VOLUME_PROVENANCE.smallStrainMatched).toBe(true); expect(LOG_VOLUME_PROVENANCE.finiteStrainCalibrated).toBe(false);
  });

  it("accepts the zero-Lame boundary across material scales without changing positive coefficients", () => {
    for (let i = 0; i < 1000; i++) {
      const young_pa = 1000 + i * 450600 / 999;
      for (const relaxation_fraction of [0, Number.EPSILON]) {
        const material = { ...parameters, young_pa, poisson: 0, relaxation_fraction };
        const correction = createLogVolumeCorrection(material);
        expect(correction.lambdaLog).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(correction.evaluate(.2).energyDensity)).toBe(true);
      }
    }
    for (const poisson of [.01, .2, .45, .49]) {
      const material = { ...parameters, poisson }, { bulk, muEquilibrium } = continuumProperties(material);
      expect(createLogVolumeCorrection(material).lambdaLog).toBe(bulk - 2 * muEquilibrium / 3);
    }
  });

  it("owns coefficients and outputs and rejects invalid states before mutating scratch", () => {
    const source = { ...parameters }, correction = createLogVolumeCorrection(source), first = correction.evaluate(.8);
    source.young_pa = 1; source.poisson = .2;
    expect(correction.evaluate(.8)).toEqual(first); expect(correction.evaluate(.8)).not.toBe(first);
    const scratch = { energyDensity: 7, firstDerivativePa: 8, secondDerivativePa: 9 };
    expect(correction.evaluate(.9, scratch)).toBe(scratch);
    for (const J of [0, -1, NaN, Infinity, Number.MIN_VALUE]) {
      const before = { ...scratch }; expect(() => correction.evaluate(J, scratch)).toThrow(); expect(scratch).toEqual(before);
    }
    for (const patch of [{ young_pa: 0 }, { young_pa: NaN }, { poisson: .5 }, { poisson: -.1 }, { relaxation_fraction: 1 }])
      expect(() => createLogVolumeCorrection({ ...parameters, ...patch })).toThrow();
  });
});
