import type { PhysicsParameters } from "../atlasPhysics";
import { cofactor, continuumProperties, determinant, deviatoricGreen, type MaxwellState } from "../liverContinuumMaterial";

export interface CuttingContinuumEvaluation { energyDensity: number; jacobian: number; stress: Float64Array }
const INV_SQRT2 = 1 / Math.sqrt(2), INV_SQRT6 = 1 / Math.sqrt(6), NEG_TWO_SQRT6 = -2 / Math.sqrt(6);

/** Allocation-free trial evaluation of the existing Green-Maxwell material.
 * Parameters are fixed for this evaluator; time coefficients change only when
 * the attempted timestep changes. Inputs/history remain untouched. This helper
 * deliberately does not create or commit Maxwell history: the shared original
 * continuumResponse remains the authority for final accepted-state publication.
 * One instance owns scratch buffers and must not be used concurrently. */
export class CuttingContinuumEvaluator {
  private readonly mu: number;
  private readonly muBranch: number;
  private readonly tau: number;
  private readonly lambda: number;
  private readonly gamma: number;
  private dt = NaN;
  private ramp = 1;
  private decayOverRamp = 1;
  private readonly cof = new Float64Array(9);
  private readonly dev = new Float64Array(5);
  private readonly branch = new Float64Array(5);

  constructor(parameters: PhysicsParameters, dtSeconds: number) {
    const properties = continuumProperties(parameters);
    this.mu = properties.muEquilibrium; this.muBranch = properties.muBranch; this.tau = properties.tauShear;
    this.lambda = properties.bulk + this.mu / 3; this.gamma = 1 + this.mu / this.lambda;
    this.setTimeStep(dtSeconds);
  }

  setTimeStep(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) throw new Error("Continuum trial timestep must be positive and finite");
    if (dtSeconds === this.dt) return;
    const decay = Math.exp(-dtSeconds / this.tau);
    this.ramp = -Math.expm1(-dtSeconds / this.tau) * this.tau / dtSeconds;
    this.decayOverRamp = decay / this.ramp; this.dt = dtSeconds;
  }

  evaluate(F: ArrayLike<number>, state: MaxwellState, out: CuttingContinuumEvaluation): void {
    const J = determinant(F), mu = this.mu, lambda = this.lambda, gamma = this.gamma, ramp = this.ramp, muBranch = this.muBranch;
    cofactor(F, this.cof); deviatoricGreen(F, this.dev);
    let I1 = 0; for (let i = 0; i < 9; i++) I1 += F[i]! ** 2;
    let energy = mu / 2 * (I1 - 3) + lambda / 2 * ((J - gamma) ** 2 - (1 - gamma) ** 2);
    const stress = out.stress;
    for (let i = 0; i < 9; i++) stress[i] = mu * F[i]! + lambda * (J - gamma) * this.cof[i]!;
    for (let mode = 0; mode < 5; mode++) {
      const c = this.dev[mode]! - state.previous[mode]! + this.decayOverRamp * state.memory[mode]!;
      const memory = ramp * c;
      energy += muBranch * ramp * c * c;
      this.branch[mode] = 2 * muBranch * memory;
    }
    // F times the five sparse trace-free basis matrices, preserving each PK1
    // component's original mode-addition order. Zero matrix terms are omitted;
    // no trial gradient arrays or next-state objects are produced.
    for (let row = 0; row < 3; row++) {
      const offset = 3 * row, x = F[offset]!, y = F[offset + 1]!, z = F[offset + 2]!;
      stress[offset]! += this.branch[0]! * (x * INV_SQRT2);
      stress[offset + 1]! += this.branch[0]! * (y * -INV_SQRT2);
      stress[offset]! += this.branch[1]! * (x * INV_SQRT6);
      stress[offset + 1]! += this.branch[1]! * (y * INV_SQRT6);
      stress[offset + 2]! += this.branch[1]! * (z * NEG_TWO_SQRT6);
      stress[offset]! += this.branch[2]! * (y * INV_SQRT2);
      stress[offset + 1]! += this.branch[2]! * (x * INV_SQRT2);
      stress[offset]! += this.branch[3]! * (z * INV_SQRT2);
      stress[offset + 2]! += this.branch[3]! * (x * INV_SQRT2);
      stress[offset + 1]! += this.branch[4]! * (z * INV_SQRT2);
      stress[offset + 2]! += this.branch[4]! * (y * INV_SQRT2);
    }
    out.energyDensity = energy; out.jacobian = J;
  }
}
