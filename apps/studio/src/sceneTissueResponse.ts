/** Authored reduced-order response extensions, separate from inverse-fit SLS data.
 * Qualitative motivation: nonlinear indentation in human liver/stomach
 * (PMCID PMC2693244) and tensile stiffening in human omental fat (PMID 24105412).
 * The coefficients below are design parameters, not fits to those experiments.
 */
export interface SceneTissueResponse {
  strainStiffening: number;
  localDampingRatio: number;
  supportRadiusRatio: number;
  /** Fixed coarse boundary; local contact can still indent the supported tissue. */
  fixedGlobalSupport?: boolean;
}
const response = (strainStiffening: number, localDampingRatio: number, supportRadiusRatio: number): SceneTissueResponse => ({ strainStiffening, localDampingRatio, supportRadiusRatio });
export const VIRTAMED_TISSUE_RESPONSE: Record<string, SceneTissueResponse> = {
  "abdominal-wall": { ...response(36, 1.05, .3), fixedGlobalSupport: true },
  liver: response(14, .9, .9), gallbladder: response(24, .95, .75),
  "cystic-duct": response(32, .9, .65), "hepatic-duct": response(32, .9, .65), "cystic-artery": response(40, .9, .6),
  colon: response(18, .95, .9), "small-intestine": response(18, .95, .9), duodenum: response(18, .95, .9),
  "hepatocystic-fat": response(28, 1.05, .9), "hepatoduodenal-ligament": response(55, .9, .75), "falciform-ligament": response(55, .9, .75),
};

/** Implicit convex local solve: D*q + C*|q|²*q + tool(q) = rhs.
 * C >= 0 adds a positive quartic equilibrium energy, preserving the original
 * small-strain modulus and relaxation branch. A push is unilateral.
 * Newton's SPD Jacobian is inverted with two rank-one updates; no 3×3 allocation.
 */
export function solveStrainStiffening(
  q: Float64Array, rhs: number[], denominator: number, cubic: number,
  contact: "none" | "push" | "grasp", stiffness: number, g: number, desired: number[], normal: number[],
) {
  const k = stiffness * g * g, n = normal;
  for (let iteration = 0; iteration < 12; iteration++) {
    const x = q[0]!, y = q[1]!, z = q[2]!, r2 = x * x + y * y + z * z;
    const a = denominator + cubic * r2;
    let rx = a * x - rhs[0]!, ry = a * y - rhs[1]!, rz = a * z - rhs[2]!;
    const push = contact === "push" && g * (x * n[0]! + y * n[1]! + z * n[2]!) > desired[0]! * n[0]! + desired[1]! * n[1]! + desired[2]! * n[2]!;
    if (contact === "grasp") { rx += k * x - stiffness * g * desired[0]!; ry += k * y - stiffness * g * desired[1]!; rz += k * z - stiffness * g * desired[2]!; }
    else if (push) {
      const force = stiffness * g * (g * (x * n[0]! + y * n[1]! + z * n[2]!) - desired[0]! * n[0]! - desired[1]! * n[1]! - desired[2]! * n[2]!);
      rx += force * n[0]!; ry += force * n[1]!; rz += force * n[2]!;
    }
    const diagonal = a + (contact === "grasp" ? k : 0);
    // Inverse of diagonal I + k n nᵀ (when the unilateral contact is active).
    const projection = push ? k / (diagonal * (diagonal + k)) : 0;
    const nr = n[0]! * rx + n[1]! * ry + n[2]! * rz, nq = n[0]! * x + n[1]! * y + n[2]! * z;
    const brx = rx / diagonal - projection * nr * n[0]!, bry = ry / diagonal - projection * nr * n[1]!, brz = rz / diagonal - projection * nr * n[2]!;
    const bqx = x / diagonal - projection * nq * n[0]!, bqy = y / diagonal - projection * nq * n[1]!, bqz = z / diagonal - projection * nq * n[2]!;
    const gain = 2 * cubic * (x * brx + y * bry + z * brz) / (1 + 2 * cubic * (x * bqx + y * bqy + z * bqz));
    const dx = brx - gain * bqx, dy = bry - gain * bqy, dz = brz - gain * bqz;
    q[0] = x - dx; q[1] = y - dy; q[2] = z - dz;
    if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) < 1e-12) return;
  }
  throw new Error("Nonlinear tissue response did not converge; reset the scene.");
}
