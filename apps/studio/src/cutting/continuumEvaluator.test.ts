import { describe, expect, it } from "vitest";
import type { PhysicsParameters } from "../atlasPhysics";
import { continuumResponse, determinant, emptyMaxwellState, type MaxwellState } from "../liverContinuumMaterial";
import { CuttingContinuumEvaluator, type CuttingContinuumEvaluation } from "./continuumEvaluator";

const base: PhysicsParameters = { young_pa: 6000, poisson: .4, relaxation_fraction: .4, relaxation_time_s: .7, density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
const output = (): CuttingContinuumEvaluation => ({ energyDensity: NaN, jacobian: NaN, stress: new Float64Array(9) });
let seed = 91753;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
function history(): MaxwellState { return { previous: Float64Array.from({ length: 5 }, () => (random() - .5) * .4), memory: Float64Array.from({ length: 5 }, () => (random() - .5) * .3) }; }
function compare(actual: CuttingContinuumEvaluation, expected: ReturnType<typeof continuumResponse>) {
  // Exact energy and J operations are unchanged. Stress skips only zero basis
  // terms; a 2e-13 scaled tolerance also covers signed-zero/JIT differences.
  expect(actual.energyDensity).toBe(expected.energyDensity); expect(actual.jacobian).toBe(expected.jacobian);
  for (let i = 0; i < 9; i++) expect(Math.abs(actual.stress[i]! - expected.stress[i]!)).toBeLessThanOrEqual(2e-13 * Math.max(1, Math.abs(expected.stress[i]!)));
}

describe("cached cutting continuum trial evaluation", () => {
  it("matches original finite-strain energy and PK1 across materials, deformations, histories and timesteps", () => {
    seed = 91753;
    const materials = [base, { ...base, young_pa: 500, poisson: .2, relaxation_fraction: .75, relaxation_time_s: 2 },
      { ...base, young_pa: 20000, poisson: .48, relaxation_fraction: .05, relaxation_time_s: .05 },
      { ...base, young_pa: 90000, poisson: .4999, relaxation_fraction: .95, relaxation_time_s: .001 },
      { ...base, relaxation_fraction: 0 }];
    const deformations = [new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      new Float64Array([.100001, .2, -.1, 0, 1, .12, 0, 0, 1]),
      new Float64Array([2.3, .2, -.3, .1, .7, .1, 0, .2, 1.3]),
      new Float64Array([Math.cos(.7), -Math.sin(.7), 0, Math.sin(.7), Math.cos(.7), 0, 0, 0, 1])];
    for (let sample = 0; sample < 80; sample++) {
      const F = Float64Array.from({ length: 9 }, (_, i) => (i % 4 === 0 ? 1 : 0) + (random() - .5) * .7);
      expect(determinant(F)).toBeGreaterThan(.1); deformations.push(F);
    }
    for (const material of materials) {
      const evaluator = new CuttingContinuumEvaluator(material, 1 / 240), out = output();
      for (const dt of [1e-10, 1 / 7680, 1 / 480, 1 / 240, 1 / 30, .5, 10]) {
        evaluator.setTimeStep(dt);
        for (const F of deformations) for (const state of [emptyMaxwellState(), history()]) {
          evaluator.evaluate(F, state, out); compare(out, continuumResponse(F, material, state, dt));
        }
      }
    }
  });

  it("does not mutate input deformation/history or replace caller-owned output storage", () => {
    const evaluator = new CuttingContinuumEvaluator(base, 1 / 240), out = output(), stress = out.stress;
    const F = new Float64Array([1.03, .07, 0, .02, .97, .04, .01, 0, 1.01]), state = history();
    const savedF = F.slice(), previous = state.previous.slice(), memory = state.memory.slice();
    for (const dt of [1 / 240, 1 / 7680, 1 / 240]) {
      evaluator.setTimeStep(dt); evaluator.evaluate(F, state, out);
      compare(out, continuumResponse(F, base, state, dt));
      expect(out.stress).toBe(stress); expect(F).toEqual(savedF); expect(state.previous).toEqual(previous); expect(state.memory).toEqual(memory);
    }
    expect(Object.keys(out).sort()).toEqual(["energyDensity", "jacobian", "stress"]);
    for (const dt of [0, -1, Infinity, NaN]) expect(() => evaluator.setTimeStep(dt)).toThrow("positive and finite");
  });
});
