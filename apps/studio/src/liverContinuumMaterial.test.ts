import { describe, expect, it } from "vitest";
import type { PhysicsParameters } from "./atlasPhysics";
import parity from "./fixtures/liver-continuum-python-parity.json";
import { continuumProperties, continuumResponse, floorConstrainedNewtonDirection, emptyMaxwellState, TetContinuumMaterial } from "./liverContinuumMaterial";
const p: PhysicsParameters = { young_pa: 5000, poisson: .45, relaxation_fraction: .4, relaxation_time_s: .7, density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const multiply = (A: ArrayLike<number>, B: ArrayLike<number>) => Array.from({ length: 9 }, (_, i) => [0, 1, 2].reduce((s, k) => s + A[3 * Math.floor(i / 3) + k]! * B[3 * k + i % 3]!, 0));
const norm = (a: ArrayLike<number>) => Math.hypot(...Array.from(a));

describe("continuum liver material", () => {
  it("is stress-free at rest and objective under rigid rotation with material history", () => {
    const rest = continuumResponse(I, p, emptyMaxwellState(), 1 / 240);
    expect(norm(rest.stress)).toBeLessThan(1e-10); expect(Math.abs(rest.energyDensity)).toBeLessThan(1e-12);
    const angle = .63, R = [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1];
    const F = [1.13, .06, 0, -.02, .94, .04, 0, 0, 1.01];
    const state = continuumResponse(F, p, emptyMaxwellState(), .03).state;
    const a = continuumResponse(F, p, state, .03), b = continuumResponse(multiply(R, F), p, state, .03), rotatedStress = multiply(R, a.stress);
    expect(b.energyDensity).toBeCloseTo(a.energyDensity, 10);
    expect(norm(Array.from(b.stress, (v, i) => v - rotatedStress[i]!))).toBeLessThan(1e-9);
  });
  it("matches the finite-difference derivative of the incremental strain energy", () => {
    const F = [1.14, .11, -.03, .02, .87, .06, .01, -.02, 1.03], state = continuumResponse(F, p, emptyMaxwellState(), .02).state;
    F[1]! += .04; F[4]! += .03;
    const response = continuumResponse(F, p, state, .04), gradient = Array.from({ length: 9 }, (_, i) => { const lo = [...F], hi = [...F]; lo[i]! -= 1e-6; hi[i]! += 1e-6; return (continuumResponse(hi, p, state, .04).energyDensity - continuumResponse(lo, p, state, .04).energyDensity) / 2e-6; });
    expect(norm(gradient.map((v, i) => v - response.stress[i]!)) / norm(response.stress)).toBeLessThan(1e-8);
  });
  it("reproduces continuum small-strain Young and bulk moduli in SI units", () => {
    for (const poisson of [.2, .45, .48]) {
      const parameters = { ...p, poisson }, e = 1e-7, F = [1 + e, 0, 0, 0, 1 - poisson * e, 0, 0, 0, 1 - poisson * e];
      const stress = continuumResponse(F, parameters, emptyMaxwellState(), 1e-9).stress;
      expect(stress[0]! / e / parameters.young_pa).toBeCloseTo(1, 5);
      expect(Math.abs(stress[4]!) / (parameters.young_pa * e)).toBeLessThan(1e-5);
      const dilation = [1 + e, 0, 0, 0, 1 + e, 0, 0, 0, 1 + e], pressure = continuumResponse(dilation, parameters, emptyMaxwellState(), .1).stress[0]!;
      expect(pressure / (3 * e) / continuumProperties(parameters).bulk).toBeCloseTo(1, 5);
    }
  });
  it("relaxes a held shear strain with the mapped material time, independent of velocity damping", () => {
    const strain = 1e-6, F = [1, strain, 0, 0, 1, 0, 0, 0, 1], dt = .01, property = continuumProperties(p), ramp = -Math.expm1(-dt / property.tauShear) * property.tauShear / dt;
    let state = emptyMaxwellState();
    for (let frame = 0; frame < 201; frame++) {
      const response = continuumResponse(F, p, state, dt); state = response.state;
      const expected = strain * (property.muEquilibrium + property.muBranch * ramp * Math.exp(-frame * dt / property.tauShear));
      expect(response.stress[1]! / expected).toBeCloseTo(1, 6);
    }
  });
  it("matches the recorded Python finite-element constitutive law over48 history states", () => {
    for (const testCase of parity.cases) {
      let state = emptyMaxwellState();
      for (const frame of testCase.frames) {
        const response = continuumResponse(frame.F, testCase.parameters, state, frame.dt); state = response.state;
        expect(Math.abs(response.energyDensity - frame.energy_density_pa)).toBeLessThan(1e-8);
        expect(norm(Array.from(response.stress, (v, i) => v - frame.piola_pa[i]!))).toBeLessThan(1e-7);
      }
    }
  });
  it("dissipates nonnegative work in a closed shear cycle with an elastic zero-work control", () => {
    const cycle = (fraction: number, steps: number) => {
      const parameter = { ...p, relaxation_fraction: fraction }, duration = 2, dt = duration / steps;
      let state = emptyMaxwellState(), previousShear = 0, previousStress = 0, work = 0;
      for (let frame = 1; frame <= steps; frame++) {
        const shear = .3 * Math.sin(2 * Math.PI * frame / steps), F = [1, shear, 0, 0, 1, 0, 0, 0, 1];
        const response = continuumResponse(F, parameter, state, dt); state = response.state;
        work += .5 * (response.stress[1]! + previousStress) * (shear - previousShear);
        previousShear = shear; previousStress = response.stress[1]!;
      }
      // Subtract Maxwell energy still stored at the closed geometric endpoint.
      const stored = continuumProperties(parameter).muBranch * Array.from(state.memory).reduce((sum, value) => sum + value * value, 0);
      return { work, dissipated: work - stored }; // J per reference m³.
    };
    expect(Math.abs(cycle(0, 256).work)).toBeLessThan(1e-9);
    const coarse = cycle(.4, 128), fine = cycle(.4, 256);
    expect(fine.work).toBeGreaterThan(1); expect(fine.dissipated).toBeGreaterThan(1);
    expect(Math.abs(coarse.dissipated - fine.dissipated) / fine.dissipated).toBeLessThan(.01);
  });
  it("solves the coupled floor block instead of clipping a non-descent Newton direction", () => {
    const H = Float64Array.from([2, -3, 3, -3, 15, -14, 3, -14, 15]), g = Float64Array.from([-1, 4, -2]);
    const unconstrained = new Float64Array(3); expect(floorConstrainedNewtonDirection(H, g, -10, unconstrained)).toBe(true);
    const clipped = [unconstrained[0]!, -.1, unconstrained[2]!];
    expect(clipped.reduce((sum, value, i) => sum + value * g[i]!, 0)).toBeGreaterThan(1);
    const step = new Float64Array(3); expect(floorConstrainedNewtonDirection(H, g, -.1, step)).toBe(true);
    expect(step[1]).toBe(-.1); expect(step[0]).toBeCloseTo(29 / 70, 12); expect(step[2]).toBeCloseTo(-3 / 70, 12);
    const residual = [0, 1, 2].map(r => g[r]! + [0, 1, 2].reduce((sum, c) => sum + H[3 * r + c]! * step[c]!, 0));
    expect(Math.abs(residual[0]!)).toBeLessThan(1e-12); expect(Math.abs(residual[2]!)).toBeLessThan(1e-12);
    expect(residual[1]).toBeGreaterThan(0); expect(Array.from(step).reduce((sum, value, i) => sum + value * g[i]!, 0)).toBeLessThan(0);
  });
  it("keeps a free tetrahedron stress-free in vertex block descent", () => {
    const reference = Float64Array.from([0, 0, 0, .04, 0, 0, 0, .04, 0, 0, 0, .04]), positions = reference.slice(), volume = .04 ** 3 / 6;
    const material = new TetContinuumMaterial(reference, [{ ids: [0, 1, 2, 3], volume }]), inverseMass = Float64Array.from([0, 0, 0, 0], () => 4 / (p.density_kg_m3 * volume));
    for (let step = 0; step < 240; step++) { material.beginStep(p, 1 / 240, positions); for (let iteration = 0; iteration < 4; iteration++) material.solveVertices(positions, inverseMass, -1, () => 0); material.commit(positions); }
    expect(norm(Array.from(positions, (v, i) => v - reference[i]!))).toBeLessThan(1e-12);
  });
});
