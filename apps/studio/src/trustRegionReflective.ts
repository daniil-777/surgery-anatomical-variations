/** scipy.optimize.least_squares for a small dense problem with box bounds — method "trf", tr_solver "exact",
 *  jac "2-point", loss "linear", x_scale 1 — as scipy 1.17.1 writes it (scipy/optimize/_lsq/least_squares.py,
 *  trf.py: trf_bounds and select_step, common.py, _numdiff.py: approx_derivative with bound-aware steps), in
 *  float64 and in numpy's operation order wherever numpy fixes one. Two pieces of numpy's arithmetic cannot be
 *  repeated to the bit: the SVD of the augmented Jacobian (LAPACK gesdd there, one-sided Jacobi rotations here,
 *  both accurate to ~1e-15 relative) and the BLAS dot products. The iterates therefore agree to that level and the
 *  solver takes the same decisions unless a termination test falls within rounding of its threshold. The atlas
 *  shape sampler's dimension refinement (atlasShapeSampler.ts) is its caller; atlasShapeSampler.test.ts replays
 *  scipy's results on small bounded problems and on the sampler itself.
 *  The optional `loss` / `fScale` options add scipy's robust losses ("soft_l1", "huber", "cauchy", "arctan" with
 *  f_scale C): construct_loss_function's rho(z = (f/C)²) scaled as least_squares scales it (rho·C², rho″/C²), the
 *  cost 0.5·Σrho by numpy's pairwise summation, and scale_for_robust_loss_function's √(rho′ + 2 rho″ f²) on the
 *  residuals and Jacobian rows before every step — the Jacobian itself still differences the true residuals, as
 *  VectorFunction does. Without them (loss "linear", the default) the solver runs the very same operations as
 *  before. The liver physics calibration (atlasPhysicsCalibration.ts, soft_l1 with f_scale 0.02) is that caller;
 *  atlasPhysicsCalibration.test.ts replays scipy on robust-loss problems and checks the default path bit for bit. */

export type Residuals = (x: Float64Array) => Float64Array;
/** least_squares' `loss`: "linear" is the plain sum of squares, the others its robust losses. */
export type RobustLoss = "linear" | "soft_l1" | "huber" | "cauchy" | "arctan";
export interface TrfOptions {
  lower: number; upper: number; ftol: number; xtol: number; gtol: number; maxNfev: number;
  /** least_squares(loss=…), "linear" when absent */ loss?: RobustLoss;
  /** least_squares(f_scale=…), the soft margin C between inlier and outlier residuals; 1 when absent */ fScale?: number;
}
export interface TrfResult {
  x: Float64Array; cost: number; optimality: number; activeMask: number[];
  /** residual evaluations the trust-region loop counts (the finite-difference Jacobians are not among them) */
  nfev: number; njev: number; status: number; success: boolean; message: string;
}

export const TERMINATION_MESSAGES: Readonly<Record<number, string>> = {
  0: "The maximum number of function evaluations is exceeded.",
  1: "`gtol` termination condition is satisfied.",
  2: "`ftol` termination condition is satisfied.",
  3: "`xtol` termination condition is satisfied.",
  4: "Both `ftol` and `xtol` termination conditions are satisfied.",
};
const EPS = 2.220446049250313e-16;   // np.finfo(float).eps
const SQRT_EPS = Math.sqrt(EPS);      // the 2-point relative step, EPS**0.5

/** Row-major dense matrix. */
interface Matrix { rows: number; cols: number; data: Float64Array }

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!; return sum; };
const norm = (a: ArrayLike<number>): number => Math.sqrt(dot(a, a));
const normInf = (a: ArrayLike<number>): number => { let max = 0; for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]!)); return max; };
const product = (a: Float64Array, b: ArrayLike<number>): Float64Array => a.map((value, i) => value * b[i]!);
const scaled = (a: Float64Array, factor: number): Float64Array => a.map((value) => value * factor);
function matVec(m: Matrix, v: ArrayLike<number>): Float64Array {
  const out = new Float64Array(m.rows);
  for (let i = 0; i < m.rows; i++) { let sum = 0; for (let j = 0; j < m.cols; j++) sum += m.data[i * m.cols + j]! * v[j]!; out[i] = sum; }
  return out;
}
function matTVec(m: Matrix, v: ArrayLike<number>): Float64Array {
  const out = new Float64Array(m.cols);
  for (let j = 0; j < m.cols; j++) { let sum = 0; for (let i = 0; i < m.rows; i++) sum += m.data[i * m.cols + j]! * v[i]!; out[j] = sum; }
  return out;
}

/** np.nextafter for float64. */
function nextAfter(from: number, to: number): number {
  if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
  if (from === to) return to;
  if (from === 0) return to > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, from);
  const towardLargerMagnitude = (to > from) === (from > 0);
  view.setBigUint64(0, view.getBigUint64(0) + (towardLargerMagnitude ? 1n : -1n));
  return view.getFloat64(0);
}

/** np.sum of a contiguous float64 vector: add.reduce from its identity 0 over numpy's pairwise summation (eight
 *  interleaved accumulators per block of at most 128, halving larger ranges at multiples of 8). */
export function pairwiseSum(a: ArrayLike<number>): number {
  const sum = (start: number, n: number): number => {
    if (n < 8) { let res = 0; for (let i = 0; i < n; i++) res += a[start + i]!; return res; }
    if (n <= 128) {
      const r = [a[start]!, a[start + 1]!, a[start + 2]!, a[start + 3]!, a[start + 4]!, a[start + 5]!, a[start + 6]!, a[start + 7]!];
      let i = 8;
      for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] = r[j]! + a[start + i + j]!;
      let res = ((r[0]! + r[1]!) + (r[2]! + r[3]!)) + ((r[4]! + r[5]!) + (r[6]! + r[7]!));
      for (; i < n; i++) res += a[start + i]!;
      return res;
    }
    let half = Math.floor(n / 2);
    half -= half % 8;
    return sum(start, half) + sum(start + half, n - half);
  };
  return 0 + sum(0, a.length);
}

// ---------------------------------------------------------------------------------------------- robust losses (least_squares.py)
/** The loss of z = (f/C)², one residual: rho(z), and with `derivatives` also rho′(z) and rho″(z) (huber, soft_l1,
 *  cauchy, arctan as least_squares.py writes them; numpy's ** 0.5 is a square root, ** 2 a product). */
function rhoOf(loss: Exclude<RobustLoss, "linear">, z: number, derivatives: boolean): [number, number, number] {
  switch (loss) {
    case "huber":
      if (z <= 1) return [z, 1, 0];
      return [2 * Math.sqrt(z) - 1, derivatives ? z ** -0.5 : 0, derivatives ? -0.5 * z ** -1.5 : 0];
    case "soft_l1": {
      const t = 1 + z;
      return [2 * (Math.sqrt(t) - 1), derivatives ? t ** -0.5 : 0, derivatives ? -0.5 * t ** -1.5 : 0];
    }
    case "cauchy": {
      const t = 1 + z;
      return [Math.log1p(z), derivatives ? 1 / t : 0, derivatives ? -1 / (t * t) : 0];
    }
    case "arctan": {
      const t = 1 + z * z;
      return [Math.atan(z), derivatives ? 1 / t : 0, derivatives ? -2 * z / (t * t) : 0];
    }
  }
}
/** construct_loss_function(f): rows rho·C², rho′, rho″/C² of the scaled loss C²·rho(f²/C²). */
function lossRho(loss: Exclude<RobustLoss, "linear">, f: Float64Array, fScale: number): [Float64Array, Float64Array, Float64Array] {
  const m = f.length, rho0 = new Float64Array(m), rho1 = new Float64Array(m), rho2 = new Float64Array(m);
  const c2 = fScale * fScale;
  for (let i = 0; i < m; i++) {
    const q = f[i]! / fScale;
    const [r0, r1, r2] = rhoOf(loss, q * q, true);
    rho0[i] = r0 * c2; rho1[i] = r1; rho2[i] = r2 / c2;
  }
  return [rho0, rho1, rho2];
}
/** construct_loss_function(f, cost_only=True): 0.5 · C² · Σ rho(f²/C²). */
function lossCost(loss: Exclude<RobustLoss, "linear">, f: Float64Array, fScale: number): number {
  const rho0 = new Float64Array(f.length);
  for (let i = 0; i < f.length; i++) { const q = f[i]! / fScale; rho0[i] = rhoOf(loss, q * q, false)[0]; }
  return 0.5 * (fScale * fScale) * pairwiseSum(rho0);
}
/** scale_for_robust_loss_function: J_scale = √max(rho′ + 2 rho″ f², eps); f ← f · rho′/J_scale, J rows ← · J_scale. */
function scaleForRobustLoss(J: Matrix, f: Float64Array, [, rho1, rho2]: [Float64Array, Float64Array, Float64Array]): { J: Matrix; f: Float64Array } {
  const m = f.length, n = J.cols;
  const scaledJ: Matrix = { rows: m, cols: n, data: new Float64Array(m * n) }, scaledF = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let jScale = rho1[i]! + 2 * rho2[i]! * (f[i]! * f[i]!);
    if (jScale < EPS) jScale = EPS;
    jScale = Math.sqrt(jScale);
    scaledF[i] = f[i]! * (rho1[i]! / jScale);
    for (let j = 0; j < n; j++) scaledJ.data[i * n + j] = J.data[i * n + j]! * jScale;
  }
  return { J: scaledJ, f: scaledF };
}

// ---------------------------------------------------------------------------------------------- bounds (common.py)
const inBounds = (x: ArrayLike<number>, lb: ArrayLike<number>, ub: ArrayLike<number>): boolean => { for (let i = 0; i < x.length; i++) if (!(x[i]! >= lb[i]! && x[i]! <= ub[i]!)) return false; return true; };

/** find_active_constraints: -1 at a lower bound, 1 at an upper bound (an upper hit wins), 0 elsewhere. */
function findActiveConstraints(x: ArrayLike<number>, lb: ArrayLike<number>, ub: ArrayLike<number>, rtol: number): number[] {
  const active = new Array<number>(x.length).fill(0);
  for (let i = 0; i < x.length; i++) {
    if (rtol === 0) { if (x[i]! <= lb[i]!) active[i] = -1; if (x[i]! >= ub[i]!) active[i] = 1; continue; }
    const lowerDistance = x[i]! - lb[i]!, upperDistance = ub[i]! - x[i]!;
    if (Number.isFinite(lb[i]!) && lowerDistance <= Math.min(upperDistance, rtol * Math.max(1, Math.abs(lb[i]!)))) active[i] = -1;
    if (Number.isFinite(ub[i]!) && upperDistance <= Math.min(lowerDistance, rtol * Math.max(1, Math.abs(ub[i]!)))) active[i] = 1;
  }
  return active;
}

/** make_strictly_feasible: rstep 0 steps one ulp inside, otherwise a relative distance rstep. */
function makeStrictlyFeasible(x: ArrayLike<number>, lb: ArrayLike<number>, ub: ArrayLike<number>, rstep: number): Float64Array {
  const out = Float64Array.from(x);
  const active = findActiveConstraints(x, lb, ub, rstep);
  for (let i = 0; i < out.length; i++) {
    if (active[i] === -1) out[i] = rstep === 0 ? nextAfter(lb[i]!, ub[i]!) : lb[i]! + rstep * Math.max(1, Math.abs(lb[i]!));
    else if (active[i] === 1) out[i] = rstep === 0 ? nextAfter(ub[i]!, lb[i]!) : ub[i]! - rstep * Math.max(1, Math.abs(ub[i]!));
  }
  for (let i = 0; i < out.length; i++) if (out[i]! < lb[i]! || out[i]! > ub[i]!) out[i] = 0.5 * (lb[i]! + ub[i]!);
  return out;
}

/** step_size_to_bound: the step along s that first reaches a bound, and which bound each variable hits there. */
function stepSizeToBound(x: ArrayLike<number>, s: ArrayLike<number>, lb: ArrayLike<number>, ub: ArrayLike<number>): { step: number; hits: number[] } {
  const steps = new Float64Array(x.length).fill(Infinity);
  for (let i = 0; i < x.length; i++) if (s[i] !== 0) steps[i] = Math.max((lb[i]! - x[i]!) / s[i]!, (ub[i]! - x[i]!) / s[i]!);
  let step = Infinity;
  for (const value of steps) if (value < step) step = value;
  return { step, hits: Array.from(steps, (value, i) => (value === step ? 1 : 0) * Math.sign(s[i]!)) };
}

/** intersect_trust_region: both roots of ||x + s t|| = Delta, the smaller first. */
function intersectTrustRegion(x: ArrayLike<number>, s: ArrayLike<number>, delta: number): [number, number] {
  const a = dot(s, s);
  if (a === 0) throw new Error("`s` is zero.");
  const b = dot(x, s);
  const c = dot(x, x) - delta * delta;
  if (c > 0) throw new Error("`x` is not within the trust region.");
  const d = Math.sqrt(b * b - a * c);
  const q = -(b + (b < 0 || Object.is(b, -0) ? -d : d));   // copysign(d, b): no cancellation
  const t1 = q / a, t2 = c / q;
  return t1 < t2 ? [t1, t2] : [t2, t1];
}

/** CL_scaling_vector: Coleman–Li distances to the bound the anti-gradient points at, and their derivatives. */
function clScalingVector(x: ArrayLike<number>, g: ArrayLike<number>, lb: ArrayLike<number>, ub: ArrayLike<number>): { v: Float64Array; dv: Float64Array } {
  const v = new Float64Array(x.length).fill(1), dv = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    if (g[i]! < 0 && Number.isFinite(ub[i]!)) { v[i] = ub[i]! - x[i]!; dv[i] = -1; }
    if (g[i]! > 0 && Number.isFinite(lb[i]!)) { v[i] = x[i]! - lb[i]!; dv[i] = 1; }
  }
  return { v, dv };
}

// ---------------------------------------------------------------------------------------------- quadratics (common.py)
/** build_quadratic_1d: f(t) = ½ (s0 + s t)ᵀ (JᵀJ + diag) (s0 + s t) + gᵀ (s0 + s t) as a, b (and c with s0). */
function buildQuadratic1d(J: Matrix, g: Float64Array, s: Float64Array, diag: Float64Array, s0?: Float64Array): [number, number, number] {
  const v = matVec(J, s);
  let a = dot(v, v);
  a += dot(product(s, diag), s);
  a *= 0.5;
  let b = dot(g, s);
  if (!s0) return [a, b, 0];
  const u = matVec(J, s0);
  b += dot(u, v);
  let c = 0.5 * dot(u, u) + dot(g, s0);
  b += dot(product(s0, diag), s);
  c += 0.5 * dot(product(s0, diag), s0);
  return [a, b, c];
}

/** minimize_quadratic_1d on [lb, ub]: the first of the candidates (bounds, interior extremum) with the least value. */
function minimizeQuadratic1d(a: number, b: number, lb: number, ub: number, c = 0): [number, number] {
  const t = [lb, ub];
  if (a !== 0) { const extremum = -0.5 * b / a; if (lb < extremum && extremum < ub) t.push(extremum); }
  const y = t.map((value) => value * (a * value + b) + c);
  let best = 0;
  for (let i = 1; i < y.length; i++) if (y[i]! < y[best]!) best = i;
  return [t[best]!, y[best]!];
}

/** evaluate_quadratic: ½ sᵀ (JᵀJ + diag) s + gᵀ s. */
function evaluateQuadratic(J: Matrix, g: Float64Array, s: Float64Array, diag: Float64Array): number {
  const Js = matVec(J, s);
  let q = dot(Js, Js);
  q += dot(product(s, diag), s);
  return 0.5 * q + dot(s, g);
}

/** update_tr_radius */
function updateTrRadius(delta: number, actualReduction: number, predictedReduction: number, stepNorm: number, boundHit: boolean): [number, number] {
  let ratio: number;
  if (predictedReduction > 0) ratio = actualReduction / predictedReduction;
  else if (predictedReduction === 0 && actualReduction === 0) ratio = 1;
  else ratio = 0;
  if (ratio < 0.25) delta = 0.25 * stepNorm;
  else if (ratio > 0.75 && boundHit) delta *= 2;
  return [delta, ratio];
}

/** check_termination: 4 both, 2 ftol, 3 xtol, null neither. */
function checkTermination(dF: number, F: number, dxNorm: number, xNorm: number, ratio: number, ftol: number, xtol: number): number | null {
  const ftolSatisfied = dF < ftol * F && ratio > 0.25;
  const xtolSatisfied = dxNorm < xtol * (xtol + xNorm);
  return ftolSatisfied && xtolSatisfied ? 4 : ftolSatisfied ? 2 : xtolSatisfied ? 3 : null;
}

// ---------------------------------------------------------------------------------------------- the trust-region step
/** Thin SVD of a tall matrix, A = U diag(s) Vᵀ with s descending, by one-sided Jacobi rotations (Hestenes): the
 *  columns of a working copy are rotated pairwise until mutually orthogonal, the same rotations accumulate V. */
function thinSvd(a: Matrix): { u: Matrix; s: Float64Array; v: Matrix } {
  const { rows, cols } = a;
  const w = Float64Array.from(a.data);
  const v = new Float64Array(cols * cols);
  for (let j = 0; j < cols; j++) v[j * cols + j] = 1;
  const rotate = (data: Float64Array, count: number, i: number, j: number, c: number, s: number) => {
    for (let k = 0; k < count; k++) { const wi = data[k * cols + i]!, wj = data[k * cols + j]!; data[k * cols + i] = c * wi - s * wj; data[k * cols + j] = s * wi + c * wj; }
  };
  for (let sweep = 0; sweep < 60; sweep++) {
    let rotated = false;
    for (let i = 0; i < cols - 1; i++) for (let j = i + 1; j < cols; j++) {
      let alpha = 0, beta = 0, gamma = 0;
      for (let k = 0; k < rows; k++) { const wi = w[k * cols + i]!, wj = w[k * cols + j]!; alpha += wi * wi; beta += wj * wj; gamma += wi * wj; }
      if (gamma === 0 || Math.abs(gamma) <= EPS * Math.sqrt(alpha * beta)) continue;
      rotated = true;
      const zeta = (beta - alpha) / (2 * gamma);
      const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
      const c = 1 / Math.sqrt(1 + t * t), s = c * t;
      rotate(w, rows, i, j, c, s);
      rotate(v, cols, i, j, c, s);
    }
    if (!rotated) break;
  }
  const lengths = new Float64Array(cols);
  for (let j = 0; j < cols; j++) { let sum = 0; for (let k = 0; k < rows; k++) sum += w[k * cols + j]! ** 2; lengths[j] = Math.sqrt(sum); }
  const order = Array.from(lengths.keys()).sort((p, q) => lengths[q]! - lengths[p]!);
  const u: Matrix = { rows, cols, data: new Float64Array(rows * cols) }, vOut: Matrix = { rows: cols, cols, data: new Float64Array(cols * cols) };
  const s = new Float64Array(cols);
  order.forEach((j, jj) => {
    s[jj] = lengths[j]!;
    for (let k = 0; k < rows; k++) u.data[k * cols + jj] = s[jj]! > 0 ? w[k * cols + j]! / s[jj]! : 0;
    for (let k = 0; k < cols; k++) vOut.data[k * cols + jj] = v[k * cols + j]!;
  });
  return { u, s, v: vOut };
}

/** solve_lsq_trust_region (Moré's method on one SVD): the step of norm ≤ Delta and its Levenberg–Marquardt
 *  parameter; n variables, m residuals of the original problem (the SVD is of the augmented matrix). */
function solveLsqTrustRegion(n: number, m: number, uf: Float64Array, s: Float64Array, V: Matrix, delta: number, initialAlpha: number): { p: Float64Array; alpha: number } {
  const suf = product(s, uf);
  const phiAndDerivative = (alpha: number): [number, number] => {
    const denominator = s.map((value) => value * value + alpha);
    const pNorm = norm(suf.map((value, i) => value / denominator[i]!));
    let sum = 0;
    for (let i = 0; i < suf.length; i++) sum += suf[i]! ** 2 / denominator[i]! ** 3;
    return [pNorm - delta, -sum / pNorm];
  };
  const fullRank = m >= n && s[n - 1]! > EPS * m * s[0]!;
  if (fullRank) {
    const p = scaled(matVec(V, uf.map((value, i) => value / s[i]!)), -1);
    if (norm(p) <= delta) return { p, alpha: 0 };
  }
  let alphaUpper = norm(suf) / delta;
  let alphaLower = 0;
  if (fullRank) { const [phi, phiPrime] = phiAndDerivative(0); alphaLower = -phi / phiPrime; }
  let alpha = !fullRank && initialAlpha === 0 ? Math.max(0.001 * alphaUpper, Math.sqrt(alphaLower * alphaUpper)) : initialAlpha;
  for (let iteration = 0; iteration < 10; iteration++) {
    if (alpha < alphaLower || alpha > alphaUpper) alpha = Math.max(0.001 * alphaUpper, Math.sqrt(alphaLower * alphaUpper));
    const [phi, phiPrime] = phiAndDerivative(alpha);
    if (phi < 0) alphaUpper = alpha;
    const ratio = phi / phiPrime;
    alphaLower = Math.max(alphaLower, alpha - ratio);
    alpha -= (phi + delta) * ratio / delta;
    if (Math.abs(phi) < 0.01 * delta) break;
  }
  const p = scaled(matVec(V, suf.map((value, i) => value / (s[i]! * s[i]! + alpha))), -1);
  return { p: scaled(p, delta / norm(p)), alpha };
}

/** select_step: the trust-region step if it stays in bounds, else the best of the step cut at the bound, its
 *  reflection and the scaled anti-gradient; returns the step, its "hat" counterpart and the predicted reduction. */
function selectStep(x: Float64Array, Jh: Matrix, diagH: Float64Array, gH: Float64Array, p: Float64Array, pH: Float64Array, d: Float64Array, delta: number, lb: Float64Array, ub: Float64Array, theta: number): [Float64Array, Float64Array, number] {
  if (inBounds(x.map((value, i) => value + p[i]!), lb, ub)) return [p, pH, -evaluateQuadratic(Jh, gH, pH, diagH)];
  const { step: pStride, hits } = stepSizeToBound(x, p, lb, ub);
  let rH = pH.map((value, i) => (hits[i] !== 0 ? -value : value));
  let r = product(d, rH);
  p = scaled(p, pStride);
  pH = scaled(pH, pStride);
  const xOnBound = x.map((value, i) => value + p[i]!);
  const [, toTrustRegion] = intersectTrustRegion(pH, rH, delta);
  const { step: toBound } = stepSizeToBound(xOnBound, r, lb, ub);
  const rStride = Math.min(toBound, toTrustRegion);
  let rStrideLower = 0, rStrideUpper = -1;
  if (rStride > 0) {
    rStrideLower = (1 - theta) * pStride / rStride;
    rStrideUpper = rStride === toBound ? theta * toBound : toTrustRegion;
  }
  let rValue = Infinity;
  if (rStrideLower <= rStrideUpper) {
    const [a, b, c] = buildQuadratic1d(Jh, gH, rH, diagH, pH);
    const [stride, value] = minimizeQuadratic1d(a, b, rStrideLower, rStrideUpper, c);
    rValue = value;
    rH = rH.map((v, i) => v * stride + pH[i]!);
    r = product(rH, d);
  }
  p = scaled(p, theta);
  pH = scaled(pH, theta);
  const pValue = evaluateQuadratic(Jh, gH, pH, diagH);
  let agH = scaled(gH, -1);
  let ag = product(d, agH);
  const toTrustRegionAg = delta / norm(agH);
  const { step: toBoundAg } = stepSizeToBound(x, ag, lb, ub);
  const [a, b] = buildQuadratic1d(Jh, gH, agH, diagH);
  const [agStride, agValue] = minimizeQuadratic1d(a, b, 0, toBoundAg < toTrustRegionAg ? theta * toBoundAg : toTrustRegionAg);
  agH = scaled(agH, agStride);
  ag = scaled(ag, agStride);
  if (pValue < rValue && pValue < agValue) return [p, pH, -pValue];
  if (rValue < pValue && rValue < agValue) return [r, rH, -rValue];
  return [ag, agH, -agValue];
}

/** approx_derivative(method="2-point") with bounds: h = √eps · sign(x) · max(1, |x|), reversed when the forward
 *  point leaves the box and shortened to the far bound when neither direction fits. */
function jacobian2Point(fun: Residuals, x0: Float64Array, f0: Float64Array, lb: Float64Array, ub: Float64Array): Matrix {
  const n = x0.length, m = f0.length;
  const J: Matrix = { rows: m, cols: n, data: new Float64Array(m * n) };
  for (let i = 0; i < n; i++) {
    let h = SQRT_EPS * (x0[i]! >= 0 ? 1 : -1) * Math.max(1, Math.abs(x0[i]!));
    const lowerDistance = x0[i]! - lb[i]!, upperDistance = ub[i]! - x0[i]!;
    const forward = x0[i]! + h;
    const fitting = Math.abs(h) <= Math.max(lowerDistance, upperDistance);
    if ((forward < lb[i]! || forward > ub[i]!) && fitting) h = -h;
    if (!fitting) h = upperDistance >= lowerDistance ? upperDistance : -lowerDistance;
    const x1 = Float64Array.from(x0);
    x1[i] = x0[i]! + h;
    const f1 = fun(x1);
    const dx = (x0[i]! + h) - x0[i]!;
    for (let k = 0; k < m; k++) J.data[k * n + i] = (f1[k]! - f0[k]!) / dx;
  }
  return J;
}

/** least_squares(fun, x0, bounds=(lower, upper), max_nfev, ftol, xtol, gtol[, loss, f_scale]) with scipy's defaults
 *  otherwise. */
export function leastSquaresTrf(fun: Residuals, x0Input: ArrayLike<number>, options: TrfOptions): TrfResult {
  const n = x0Input.length;
  if (options.loss !== undefined && !["linear", "soft_l1", "huber", "cauchy", "arctan"].includes(options.loss)) throw new Error("`loss` must be one of linear, soft_l1, huber, cauchy, arctan.");
  if (options.fScale !== undefined && !(Number.isFinite(options.fScale) && options.fScale > 0)) throw new Error("`f_scale` must be a positive finite number.");
  const lb = new Float64Array(n).fill(options.lower), ub = new Float64Array(n).fill(options.upper);
  if (!inBounds(x0Input, lb, ub)) throw new Error("Initial guess is outside of provided bounds");
  const x0 = makeStrictlyFeasible(x0Input, lb, ub, 1e-10);
  const f0 = fun(x0);
  if (!f0.every(Number.isFinite)) throw new Error("Residuals are not finite in the initial point.");
  const J0 = jacobian2Point(fun, x0, f0, lb, ub);
  return trfBounds(fun, x0, f0, J0, lb, ub, options);
}

/** trf_bounds with tr_solver "exact" and x_scale 1: the Coleman–Li scaled trust region in "hat" variables, the
 *  augmented system [J·D; diag(diag_h)^½] solved by one SVD per iteration. A robust loss replaces the cost and
 *  scales f and J (from the true residuals at each accepted point) before the gradient and the step. */
function trfBounds(fun: Residuals, x0: Float64Array, f0: Float64Array, J0: Matrix, lb: Float64Array, ub: Float64Array, { ftol, xtol, gtol, maxNfev, loss = "linear", fScale = 1 }: TrfOptions): TrfResult {
  const n = x0.length, m = f0.length;
  let x: Float64Array = Float64Array.from(x0), f = f0, J = J0;
  let nfev = 1, njev = 1;
  let cost: number;
  if (loss === "linear") cost = 0.5 * dot(f, f);
  else {
    const rho = lossRho(loss, f, fScale);
    cost = 0.5 * pairwiseSum(rho[0]);
    ({ J, f } = scaleForRobustLoss(J, f, rho));
  }
  let g = matTVec(J, f);
  let { v, dv } = clScalingVector(x, g, lb, ub);
  let delta = norm(x0.map((value, i) => value / Math.sqrt(v[i]!)));
  if (delta === 0) delta = 1;
  let gNorm = normInf(product(g, v));
  let alpha = 0;   // the Levenberg–Marquardt parameter, carried between iterations
  let terminationStatus: number | null = null;
  for (;;) {
    ({ v, dv } = clScalingVector(x, g, lb, ub));
    gNorm = normInf(product(g, v));
    if (gNorm < gtol) terminationStatus = 1;
    if (terminationStatus !== null || nfev === maxNfev) break;
    const d = v.map(Math.sqrt);
    const diagH = product(g, dv);
    const gH = product(d, g);
    const augmented: Matrix = { rows: m + n, cols: n, data: new Float64Array((m + n) * n) };
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) augmented.data[i * n + j] = J.data[i * n + j]! * d[j]!;
    for (let j = 0; j < n; j++) augmented.data[(m + j) * n + j] = Math.sqrt(diagH[j]!);
    const Jh: Matrix = { rows: m, cols: n, data: augmented.data.subarray(0, m * n) };
    const { u, s, v: V } = thinSvd(augmented);
    const uf = new Float64Array(n);   // Uᵀ [f; 0]
    for (let j = 0; j < n; j++) { let sum = 0; for (let i = 0; i < m; i++) sum += u.data[i * n + j]! * f[i]!; uf[j] = sum; }
    const theta = Math.max(0.995, 1 - gNorm);
    let actualReduction = -1;
    let xNew = x, fNew = f, costNew = cost;
    while (actualReduction <= 0 && nfev < maxNfev) {
      const solved = solveLsqTrustRegion(n, m, uf, s, V, delta, alpha);
      alpha = solved.alpha;
      const pH = solved.p;
      const p = product(d, pH);
      const [step, stepH, predictedReduction] = selectStep(x, Jh, diagH, gH, p, pH, d, delta, lb, ub, theta);
      xNew = makeStrictlyFeasible(x.map((value, i) => value + step[i]!), lb, ub, 0);
      fNew = fun(xNew);
      nfev += 1;
      const stepHNorm = norm(stepH);
      if (!fNew.every(Number.isFinite)) { delta = 0.25 * stepHNorm; continue; }
      costNew = loss === "linear" ? 0.5 * dot(fNew, fNew) : lossCost(loss, fNew, fScale);
      actualReduction = cost - costNew;
      const [deltaNew, ratio] = updateTrRadius(delta, actualReduction, predictedReduction, stepHNorm, stepHNorm > 0.95 * delta);
      terminationStatus = checkTermination(actualReduction, cost, norm(step), norm(x), ratio, ftol, xtol);
      if (terminationStatus !== null) break;
      alpha *= delta / deltaNew;
      delta = deltaNew;
    }
    if (actualReduction > 0) {
      x = xNew; f = fNew; cost = costNew;
      J = jacobian2Point(fun, x, f, lb, ub);
      njev += 1;
      if (loss !== "linear") ({ J, f } = scaleForRobustLoss(J, f, lossRho(loss, f, fScale)));
      g = matTVec(J, f);
    }
  }
  const status = terminationStatus ?? 0;
  return { x, cost, optimality: gNorm, activeMask: findActiveConstraints(x, lb, ub, xtol), nfev, njev, status, success: status > 0, message: TERMINATION_MESSAGES[status]! };
}
