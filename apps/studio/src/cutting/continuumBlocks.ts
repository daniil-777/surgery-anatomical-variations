import type { PhysicsParameters } from "../atlasPhysics";
import { cofactor, continuumProperties, determinant } from "../liverContinuumMaterial";

export interface Cell { ids: number[]; volume: number; gradients: Float64Array }
export interface NodalBlock { ids: number[]; values: Float64Array }
const r2 = 1 / Math.sqrt(2), r6 = 1 / Math.sqrt(6);
const bases = [
  [r2,0,0,0,-r2,0,0,0,0], [r6,0,0,0,r6,0,0,0,-2*r6],
  [0,r2,0,r2,0,0,0,0,0], [0,0,r2,0,0,0,r2,0,0], [0,0,0,0,0,r2,0,r2,0],
];

/** Positive semidefinite material Gram for a sparse global preconditioner.
 * It contains coupled tetrahedral DOFs instead of an uncoupled bulk diagonal.
 * The TOTAL equilibrium volumetric curvature is used, not only its correction.
 * Geometric prestress/strain curvature is intentionally omitted here. This is
 * not the physical Hessian; the exact energy, forces and gates remain elsewhere.
 * All cell blocks returned by a call own storage; inputs/history are untouched.
 */
export function continuumBlocks(positionsM: ArrayLike<number>, cells: readonly Cell[], parameters: PhysicsParameters,
  dtSeconds: number, equilibriumModel: "stable-neo-hookean" | "log-neo-hookean"): NodalBlock[] {
  const { bulk, muEquilibrium: mu, muBranch, tauShear } = continuumProperties(parameters);
  if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds) || ![bulk,mu,muBranch,tauShear].every(Number.isFinite)
    || bulk <= 0 || mu <= 0 || muBranch < 0 || tauShear <= 0) throw new Error("Invalid continuum Gram coefficients");
  if (equilibriumModel !== "stable-neo-hookean" && equilibriumModel !== "log-neo-hookean") throw new Error("Unknown equilibrium model");
  const ramp = -Math.expm1(-dtSeconds / tauShear) * tauShear / dtSeconds;
  const F = new Float64Array(9), cof = new Float64Array(9), dJ = new Float64Array(12), strainGradient = new Float64Array(12), FB = new Float64Array(9);
  const blocks: NodalBlock[] = [];
  for (const cell of cells) {
    const ids = cell.ids;
    if (ids.length !== 4 || cell.gradients.length !== 12 || !(cell.volume > 0) || !Number.isFinite(cell.volume)) throw new Error("Invalid tetrahedron Gram input");
    const i0 = ids[0]!, i1 = ids[1]!, i2 = ids[2]!, i3 = ids[3]!;
    if (i0 === i1 || i0 === i2 || i0 === i3 || i1 === i2 || i1 === i3 || i2 === i3
      || !Number.isInteger(i0) || !Number.isInteger(i1) || !Number.isInteger(i2) || !Number.isInteger(i3)
      || i0 < 0 || i1 < 0 || i2 < 0 || i3 < 0
      || 3 * i0 + 2 >= positionsM.length || 3 * i1 + 2 >= positionsM.length || 3 * i2 + 2 >= positionsM.length || 3 * i3 + 2 >= positionsM.length) throw new Error("Invalid tetrahedron Gram input");
    for (let k = 0; k < 12; k++) if (!Number.isFinite(cell.gradients[k]!)) throw new Error("Invalid tetrahedron Gram input");
    F.fill(0);
    for (let j = 1; j < 4; j++) for (let r = 0; r < 3; r++) {
      const difference = positionsM[3 * ids[j]! + r]! - positionsM[3 * i0 + r]!;
      for (let c = 0; c < 3; c++) F[3 * r + c]! += difference * cell.gradients[3 * j + c]!;
    }
    const J = determinant(F);
    for (let k = 0; k < 9; k++) if (!Number.isFinite(F[k]!)) throw new Error("Positive finite material Gram deformation required");
    if (!(J > 0) || !Number.isFinite(J)) throw new Error("Positive finite material Gram deformation required");
    cofactor(F, cof);
    const lambdaLog = bulk - 2 * mu / 3;
    const volumeCurvature = equilibriumModel === "log-neo-hookean" ? Math.max(0, (mu + lambdaLog * (1 - Math.log(J))) / (J * J)) : bulk + mu / 3;
    for (let j = 0; j < 4; j++) for (let r = 0; r < 3; r++)
      dJ[3 * j + r] = cof[3*r]! * cell.gradients[3*j]! + cof[3*r+1]! * cell.gradients[3*j+1]! + cof[3*r+2]! * cell.gradients[3*j+2]!;
    const values = new Float64Array(144), V = cell.volume;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      const dot = cell.gradients[3*a]! * cell.gradients[3*b]! + cell.gradients[3*a+1]! * cell.gradients[3*b+1]! + cell.gradients[3*a+2]! * cell.gradients[3*b+2]!;
      for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++)
        values[12*(3*a+r)+3*b+s] = V * ((r === s ? mu * dot : 0) + volumeCurvature * dJ[3*a+r]! * dJ[3*b+s]!);
    }
    for (const B of bases) {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
        FB[3*r+c] = F[3*r]! * B[c]! + F[3*r+1]! * B[3+c]! + F[3*r+2]! * B[6+c]!;
      for (let a = 0; a < 4; a++) for (let r = 0; r < 3; r++)
        strainGradient[3*a+r] = FB[3*r]! * cell.gradients[3*a]! + FB[3*r+1]! * cell.gradients[3*a+1]! + FB[3*r+2]! * cell.gradients[3*a+2]!;
      const coefficient = V * 2 * muBranch * ramp;
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) values[12*i+j]! += coefficient * strainGradient[i]! * strainGradient[j]!;
    }
    for (let k = 0; k < 144; k++) if (!Number.isFinite(values[k]!)) throw new Error("Continuum Gram overflow");
    blocks.push({ ids: [i0, i1, i2, i3], values });
  }
  return blocks;
}
