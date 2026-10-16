import type { PhysicsParameters } from "./atlasPhysics";

/** Row-major deformation gradients; SI strain energy density is Pa = J/m³.
 * Same rest-stable Neo-Hookean + objective Green-Maxwell law as recorded FEM.
 * Browser vertex block descent minimizes the same implicit incremental energy. */
export interface ContinuumProperties { bulk: number; muEquilibrium: number; muBranch: number; tauShear: number }
export interface MaxwellState { previous: Float64Array; memory: Float64Array }
const SQRT2 = Math.sqrt(2), SQRT6 = Math.sqrt(6);
const BASES = [
  [1 / SQRT2, 0, 0, 0, -1 / SQRT2, 0, 0, 0, 0],
  [1 / SQRT6, 0, 0, 0, 1 / SQRT6, 0, 0, 0, -2 / SQRT6],
  [0, 1 / SQRT2, 0, 1 / SQRT2, 0, 0, 0, 0, 0],
  [0, 0, 1 / SQRT2, 0, 0, 0, 1 / SQRT2, 0, 0],
  [0, 0, 0, 0, 0, 1 / SQRT2, 0, 1 / SQRT2, 0],
];
export function continuumProperties(p: PhysicsParameters): ContinuumProperties {
  const bulk = p.young_pa / (3 * (1 - 2 * p.poisson)), mu0 = p.young_pa / (2 * (1 + p.poisson));
  const relaxedE = p.young_pa * (1 - p.relaxation_fraction), muEquilibrium = 3 * bulk * relaxedE / (9 * bulk - relaxedE);
  return { bulk, muEquilibrium, muBranch: mu0 - muEquilibrium, tauShear: p.relaxation_time_s * (3 * bulk + muEquilibrium) / (3 * bulk + mu0) };
}
export function cofactor(F: ArrayLike<number>, out = new Float64Array(9)): Float64Array {
  out[0] = F[4]! * F[8]! - F[5]! * F[7]!; out[1] = F[5]! * F[6]! - F[3]! * F[8]!; out[2] = F[3]! * F[7]! - F[4]! * F[6]!;
  out[3] = F[2]! * F[7]! - F[1]! * F[8]!; out[4] = F[0]! * F[8]! - F[2]! * F[6]!; out[5] = F[1]! * F[6]! - F[0]! * F[7]!;
  out[6] = F[1]! * F[5]! - F[2]! * F[4]!; out[7] = F[2]! * F[3]! - F[0]! * F[5]!; out[8] = F[0]! * F[4]! - F[1]! * F[3]!; return out;
}
export function determinant(F: ArrayLike<number>): number { return F[0]! * (F[4]! * F[8]! - F[5]! * F[7]!) + F[1]! * (F[5]! * F[6]! - F[3]! * F[8]!) + F[2]! * (F[3]! * F[7]! - F[4]! * F[6]!); }
function basisGradient(F: ArrayLike<number>, basis: number, out: Float64Array): void {
  const B = BASES[basis]!;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[3 * r + c] = F[3 * r]! * B[c]! + F[3 * r + 1]! * B[3 + c]! + F[3 * r + 2]! * B[6 + c]!;
}
export function deviatoricGreen(F: ArrayLike<number>, out = new Float64Array(5)): Float64Array {
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let r = 0; r < 3; r++) { const x = F[3 * r]!, y = F[3 * r + 1]!, z = F[3 * r + 2]!; xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z; }
  out[0] = (xx - yy) / (2 * SQRT2); out[1] = (xx + yy - 2 * zz) / (2 * SQRT6); out[2] = xy / SQRT2; out[3] = xz / SQRT2; out[4] = yz / SQRT2; return out;
}
export function emptyMaxwellState(): MaxwellState { return { previous: new Float64Array(5), memory: new Float64Array(5) }; }
/** Incremental energy derivative is PK1; state is returned, never modified. */
export function continuumResponse(F: ArrayLike<number>, p: PhysicsParameters, state: MaxwellState, dt: number) {
  const { bulk, muEquilibrium: mu, muBranch, tauShear } = continuumProperties(p), lambda = bulk + mu / 3, gamma = 1 + mu / lambda;
  const J = determinant(F), cof = cofactor(F), dev = deviatoricGreen(F), decay = Math.exp(-dt / tauShear), ramp = -Math.expm1(-dt / tauShear) * tauShear / dt;
  let I1 = 0; for (let i = 0; i < 9; i++) I1 += F[i]! ** 2;
  let energyDensity = mu / 2 * (I1 - 3) + lambda / 2 * ((J - gamma) ** 2 - (1 - gamma) ** 2);
  const stress = new Float64Array(9), gradient = new Float64Array(9), memory = new Float64Array(5);
  for (let i = 0; i < 9; i++) stress[i] = mu * F[i]! + lambda * (J - gamma) * cof[i]!;
  for (let a = 0; a < 5; a++) {
    const c = dev[a]! - state.previous[a]! + decay / ramp * state.memory[a]!; memory[a] = ramp * c;
    energyDensity += muBranch * ramp * c * c; basisGradient(F, a, gradient);
    for (let i = 0; i < 9; i++) stress[i]! += 2 * muBranch * memory[a]! * gradient[i]!;
  }
  return { energyDensity, stress, jacobian: J, state: { previous: dev, memory } };
}

type TetInput = { ids: readonly number[]; volume: number };
type Cell = { ids: readonly number[]; volume: number; gradients: Float64Array; modeGradients: Float64Array; modeSecond: Float64Array; state: MaxwellState; shifts: Float64Array };
/** Exact minimizer of a positive-definite 3D quadratic with one floor bound.
 * Clipping only the unconstrained y component can create a non-descent x/z
 * direction when the Hessian is coupled. Re-solve the free block instead. */
export function floorConstrainedNewtonDirection(hessian: Float64Array, gradient: Float64Array, minimumDy: number, output = new Float64Array(3), scratch = new Float64Array(9)): boolean {
  cofactor(hessian, scratch); const det = determinant(hessian); if (!(det > 1e-30)) return false;
  output[0] = -(scratch[0]! * gradient[0]! + scratch[3]! * gradient[1]! + scratch[6]! * gradient[2]!) / det;
  output[1] = -(scratch[1]! * gradient[0]! + scratch[4]! * gradient[1]! + scratch[7]! * gradient[2]!) / det;
  output[2] = -(scratch[2]! * gradient[0]! + scratch[5]! * gradient[1]! + scratch[8]! * gradient[2]!) / det;
  if (output[1]! < minimumDy) {
    const detXZ = hessian[0]! * hessian[8]! - hessian[2]! * hessian[6]!;
    if (!(detXZ > 1e-30)) return false;
    const rx = -gradient[0]! - hessian[1]! * minimumDy, rz = -gradient[2]! - hessian[7]! * minimumDy;
    output[0] = (hessian[8]! * rx - hessian[2]! * rz) / detXZ;
    output[1] = minimumDy;
    output[2] = (hessian[0]! * rz - hessian[6]! * rx) / detXZ;
  }
  return output.every(Number.isFinite);
}

/** Vertex block descent for the objective finite-strain material.
 * Five orthonormal trace-free components store the Maxwell tensor exactly. */
export class TetContinuumMaterial {
  private readonly cells: Cell[];
  private readonly adjacent: { cell: Cell; corner: number; jacobian: number; volumeGradient: Float64Array }[][];
  private prediction = new Float64Array(0);
  private properties: ContinuumProperties = { bulk: 1, muEquilibrium: 1, muBranch: 0, tauShear: 1 };
  private decay = 1; private ramp = 1; private h = 1;
  private readonly F = new Float64Array(9); private readonly cof = new Float64Array(9);
  private readonly dev = new Float64Array(5);
  private backtracks = 0; private volumeLimits = 0; private rejectedUpdates = 0; private lastSweepDisplacement = 0;
  constructor(reference: Float64Array, tetrahedra: readonly TetInput[]) {
    this.cells = tetrahedra.map(tet => {
      const D = new Float64Array(9), origin = tet.ids[0]!;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) D[3 * r + c] = reference[3 * tet.ids[c + 1]! + r]! - reference[3 * origin + r]!;
      const cof = cofactor(D), det = determinant(D), gradients = new Float64Array(12);
      for (let j = 1; j < 4; j++) for (let k = 0; k < 3; k++) { const v = cof[3 * k + j - 1]! / det; gradients[3 * j + k] = v; gradients[k]! -= v; }
      const modeGradients = new Float64Array(60), modeSecond = new Float64Array(20);
      for (let j = 0; j < 4; j++) for (let mode = 0; mode < 5; mode++) { const B = BASES[mode]!; for (let r = 0; r < 3; r++) { const bg = B[3 * r]! * gradients[3 * j]! + B[3 * r + 1]! * gradients[3 * j + 1]! + B[3 * r + 2]! * gradients[3 * j + 2]!; modeGradients[15 * j + 3 * mode + r] = bg; modeSecond[5 * j + mode]! += gradients[3 * j + r]! * bg; } }
      return { ids: [...tet.ids], volume: tet.volume, gradients, modeGradients, modeSecond, state: emptyMaxwellState(), shifts: new Float64Array(5) };
    });
    this.adjacent = Array.from({ length: reference.length / 3 }, () => []);
    for (const cell of this.cells) cell.ids.forEach((id, corner) => this.adjacent[id]!.push({ cell, corner, jacobian: 1, volumeGradient: new Float64Array(3) }));
  }
  reset(): void { this.lastSweepDisplacement = 0; this.backtracks = 0; this.volumeLimits = 0; this.rejectedUpdates = 0; for (const cell of this.cells) { cell.state.previous.fill(0); cell.state.memory.fill(0); } }
  beginStep(parameters: PhysicsParameters, h: number, prediction?: Float64Array): void {
    if (prediction) this.prediction = prediction.slice();
    this.properties = continuumProperties(parameters); this.h = h; this.decay = Math.exp(-h / this.properties.tauShear); this.ramp = -Math.expm1(-h / this.properties.tauShear) * this.properties.tauShear / h;
    for (const cell of this.cells) { for (let a = 0; a < 5; a++) cell.shifts[a] = cell.state.previous[a]! - this.decay / this.ramp * cell.state.memory[a]!; }
  }
  private deformation(x: Float64Array, cell: Cell): void {
    this.F.fill(0); const origin = cell.ids[0]!;
    for (let j = 1; j < 4; j++) for (let r = 0; r < 3; r++) { const d = x[3 * cell.ids[j]! + r]! - x[3 * origin + r]!; for (let c = 0; c < 3; c++) this.F[3 * r + c]! += d * cell.gradients[3 * j + c]!; }
  }
  /** Primal vertex block descent on the implicit-Euler incremental potential.
   * Exact local equilibrium Hessian; positive scalar stabilization for Maxwell.
   * External callbacks add work-conjugate grasp/contact potentials. */
  solveVertices(x: Float64Array, inverseMass: Float64Array, floor: number, external: (id: number, gradient?: Float64Array, hessian?: Float64Array) => number): void {
    this.evaluateAndSweep(x, inverseMass, floor, external);
  }
  /** Exact final incremental-potential y gradients, before memory commit.
   * Only actual floor nodes need evaluation; no position or history is changed. */
  floorIncrementalGradients(x: Float64Array, inverseMass: Float64Array, floor: number, external: (id: number, gradient?: Float64Array, hessian?: Float64Array) => number): Float64Array {
    const result = new Float64Array(inverseMass.length);
    this.evaluateAndSweep(x, inverseMass, floor, external, result); return result;
  }
  private evaluateAndSweep(x: Float64Array, inverseMass: Float64Array, floor: number, external: (id: number, gradient?: Float64Array, hessian?: Float64Array) => number, floorGradients?: Float64Array): void {
    if (!floorGradients) this.lastSweepDisplacement = 0;
    const gradient = new Float64Array(3), hessian = new Float64Array(9), inverse = new Float64Array(9), direction = new Float64Array(3);
    const local = (id: number, derivatives: boolean): number => {
      const weight = 1 / (inverseMass[id]! * this.h * this.h);
      let energy = 0;
      if (derivatives) { gradient.fill(0); hessian.fill(0); }
      for (let r = 0; r < 3; r++) { const d = x[3 * id + r]! - this.prediction[3 * id + r]!; energy += .5 * weight * d * d; if (derivatives) { gradient[r] = weight * d; hessian[4 * r] = weight; } }
      const { bulk, muEquilibrium: mu, muBranch } = this.properties, lambda = bulk + mu / 3, branch = 2 * muBranch * this.ramp;
      for (const entry of this.adjacent[id]!) {
        const { cell, corner } = entry;
        this.deformation(x, cell); if (derivatives) cofactor(this.F, this.cof); deviatoricGreen(this.F, this.dev);
        let I1 = 0; for (let i = 0; i < 9; i++) I1 += this.F[i]! ** 2;
        const dJ = determinant(this.F) - 1, coefficient = lambda * dJ - mu;
        energy += cell.volume * (mu / 2 * (I1 - 3) - mu * dJ + lambda / 2 * dJ * dJ);
        for (let mode = 0; mode < 5; mode++) { this.dev[mode]! -= cell.shifts[mode]!; energy += .5 * branch * cell.volume * this.dev[mode]! ** 2; }
        if (!derivatives) continue;
        const gx = cell.gradients[3 * corner]!, gy = cell.gradients[3 * corner + 1]!, gz = cell.gradients[3 * corner + 2]!, gradientNorm2 = gx * gx + gy * gy + gz * gz;
        const vx = this.cof[0]! * gx + this.cof[1]! * gy + this.cof[2]! * gz, vy = this.cof[3]! * gx + this.cof[4]! * gy + this.cof[5]! * gz, vz = this.cof[6]! * gx + this.cof[7]! * gy + this.cof[8]! * gz;
        entry.jacobian = dJ + 1; entry.volumeGradient[0] = vx; entry.volumeGradient[1] = vy; entry.volumeGradient[2] = vz;
        gradient[0]! += cell.volume * (mu * (this.F[0]! * gx + this.F[1]! * gy + this.F[2]! * gz) + coefficient * vx);
        gradient[1]! += cell.volume * (mu * (this.F[3]! * gx + this.F[4]! * gy + this.F[5]! * gz) + coefficient * vy);
        gradient[2]! += cell.volume * (mu * (this.F[6]! * gx + this.F[7]! * gy + this.F[8]! * gz) + coefficient * vz);
        const scale = cell.volume * lambda;
        hessian[0]! += scale * vx * vx; hessian[1]! += scale * vx * vy; hessian[2]! += scale * vx * vz; hessian[4]! += scale * vy * vy; hessian[5]! += scale * vy * vz; hessian[8]! += scale * vz * vz;
        let isotropic = mu * gradientNorm2;
        for (let mode = 0; mode < 5; mode++) {
          const offset = 15 * corner + 3 * mode, bx = cell.modeGradients[offset]!, by = cell.modeGradients[offset + 1]!, bz = cell.modeGradients[offset + 2]!;
          const ax = this.F[0]! * bx + this.F[1]! * by + this.F[2]! * bz, ay = this.F[3]! * bx + this.F[4]! * by + this.F[5]! * bz, az = this.F[6]! * bx + this.F[7]! * by + this.F[8]! * bz;
          const scale = cell.volume * branch, stress = scale * this.dev[mode]!;
          isotropic += branch * this.dev[mode]! * cell.modeSecond[5 * corner + mode]!;
          gradient[0]! += stress * ax; gradient[1]! += stress * ay; gradient[2]! += stress * az;
          hessian[0]! += scale * ax * ax; hessian[1]! += scale * ax * ay; hessian[2]! += scale * ax * az; hessian[4]! += scale * ay * ay; hessian[5]! += scale * ay * az; hessian[8]! += scale * az * az;
        }
        for (let r = 0; r < 3; r++) hessian[4 * r]! += cell.volume * Math.max(isotropic, .001 * mu * gradientNorm2);
      }
      if (derivatives) { hessian[3] = hessian[1]!; hessian[6] = hessian[2]!; hessian[7] = hessian[5]!; }
      return energy + external(id, derivatives ? gradient : undefined, derivatives ? hessian : undefined);
    };
    if (floorGradients) {
      for (let id = 0; id < this.adjacent.length; id++) if (x[3 * id + 1]! <= floor + 1e-9) { local(id, true); floorGradients[id] = gradient[1]!; }
      return;
    }
    for (let id = 0; id < this.adjacent.length; id++) {
      const energy = local(id, true);
      if (Math.hypot(...gradient) < 1e-11) continue;
      if (!floorConstrainedNewtonDirection(hessian, gradient, floor - x[3 * id + 1]!, direction, inverse)) continue;
      const dx = direction[0]!, dy = direction[1]!, dz = direction[2]!;
      if (Math.hypot(dx, dy, dz) < 1e-16) continue;
      let fraction = 1;
      // J is affine in one vertex, so this bound is exact along this update.
      for (const entry of this.adjacent[id]!) {
        const change = dx * entry.volumeGradient[0]! + dy * entry.volumeGradient[1]! + dz * entry.volumeGradient[2]!;
        if (change < 0) fraction = Math.min(fraction, .9 * Math.max(0, entry.jacobian - .1) / -change);
      }
      if (fraction < 1) this.volumeLimits++;
      const ox = x[3 * id]!, oy = x[3 * id + 1]!, oz = x[3 * id + 2]!;
      for (let attempt = 0; attempt < 8; attempt++) {
        x[3 * id] = ox + fraction * dx; x[3 * id + 1] = oy + fraction * dy; x[3 * id + 2] = oz + fraction * dz;
        if (local(id, false) <= energy + 1e-13) break;
        this.backtracks++; fraction *= .5;
        if (attempt === 7) { this.rejectedUpdates++; x[3 * id] = ox; x[3 * id + 1] = oy; x[3 * id + 2] = oz; }
      }
      this.lastSweepDisplacement = Math.max(this.lastSweepDisplacement, Math.hypot(x[3 * id]! - ox, x[3 * id + 1]! - oy, x[3 * id + 2]! - oz));
    }
  }
  diagnostics() { return { lastSweepDisplacement: this.lastSweepDisplacement, lineSearchBacktracks: this.backtracks, volumeLimits: this.volumeLimits, rejectedVertexUpdates: this.rejectedUpdates }; }
  commit(x: Float64Array): void {
    for (const cell of this.cells) { this.deformation(x, cell); deviatoricGreen(this.F, this.dev); for (let a = 0; a < 5; a++) { cell.state.memory[a] = this.decay * cell.state.memory[a]! + this.ramp * (this.dev[a]! - cell.state.previous[a]!); cell.state.previous[a] = this.dev[a]!; } }
  }
}
