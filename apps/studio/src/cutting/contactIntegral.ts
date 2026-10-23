/** Exact contact potential for the prepared cutting experiment.
 * Exact reference-area integral of the squared inside-distance penalty over an
 * affine triangle. This is finite penalty contact, not IPC, CCD or a guarantee
 * of nonpenetration. The positive Gram matrix omits medial-axis curvature.
 */
import type { ScalpelGeometry, ScalpelPose } from './types';

type V3 = [number, number, number];
export type Plane = { normal: V3; offset: number };
type Bary = V3;
export interface TriangleGramTerm { bary: Bary; normal: V3; stiffness: number }
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** SI halfspaces n·x+offset <= 0; first plane resolves positive-area ties. */
export function bladePlanes(planeXM: number, pose: ScalpelPose, shape: ScalpelGeometry, side: -1 | 1): Plane[] {
  const s = Math.tan(shape.halfAngleRadians), norm = Math.hypot(1, s);
  const t = shape.halfThicknessMm * .001, h = shape.heightMm * .001, l = shape.halfLengthMm * .001;
  const center: V3 = [planeXM, pose.tipYMm * .001, pose.centerZMm * .001];
  const planes: Plane[] = [];
  const add = (normal: V3, localOffset = 0) => planes.push({ normal, offset: localOffset - dot(normal, center) });
  add([side / norm, -s / norm, 0]); add([-side / norm, -s / norm, 0]);
  add([side, 0, 0], -t); add([-side, 0, 0], -t);
  const e = (shape.endBevelMm ?? 0) * .001;
  if (e > 0) {
    const n = Math.hypot(e, t), ex = e / n, ez = t / n;
    for (const sign of [side, -side]) for (const end of [-1, 1]) add([sign * ex, 0, end * ez], -ez * l);
  }
  add([0, 1, 0], -h); add([0, 0, 1], -l); add([0, 0, -1], -l);
  return planes;
}

function clip(polygon: Bary[], coefficients: V3): Bary[] {
  const result: Bary[] = [];
  for (let i = 0; i < polygon.length; ++i) {
    const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
    const da = dot(a, coefficients), db = dot(b, coefficients);
    if (da >= 0) result.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const r = da / (da - db);
      result.push([a[0] + r * (b[0] - a[0]), a[1] + r * (b[1] - a[1]), a[2] + r * (b[2] - a[2])]);
    }
  }
  return result;
}

export function integrateTrianglePenalty(points: readonly V3[], referenceAreaM2: number, planes: readonly Plane[], stiffnessPaPerM: number, options: { gram?: boolean; terms?: boolean } = {}) {
  if (points.length !== 3 || points.some(p => p.length !== 3 || !p.every(Number.isFinite)) || !(referenceAreaM2 > 0) || !Number.isFinite(referenceAreaM2) || !(stiffnessPaPerM > 0) || !Number.isFinite(stiffnessPaPerM)) throw new Error('Finite triangle, positive area and stiffness required');
  if (!planes.length || planes.some(p => p.normal.length !== 3 || !Number.isFinite(p.offset) || p.normal.some(v => !Number.isFinite(v)) || Math.abs(Math.hypot(...p.normal) - 1) > 1e-12)) throw new Error('Normalized finite blade halfspaces required');
  const distances = planes.map(p => points.map(x => dot(p.normal, x) + p.offset) as V3);
  const gradient = new Float64Array(9), gram = new Float64Array(options.gram === false ? 0 : 81), terms: TriangleGramTerm[] = [];
  let energyJ = 0, activeAreaM2 = 0, pieces = 0;
  // A single separating plane rejects the entire affine triangle exactly.
  if (distances.some(d => Math.min(...d) >= 0)) return { energyJ, gradient, gram, terms, activeAreaM2, pieces };
  for (let i = 0; i < planes.length; ++i) {
    const di = distances[i]!, normal = planes[i]!.normal;
    let polygon: Bary[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    polygon = clip(polygon, [-di[0], -di[1], -di[2]]);
    for (let j = 0; j < planes.length && polygon.length >= 3; ++j) {
      if (j === i) continue;
      const dj = distances[j]!, difference: V3 = [di[0] - dj[0], di[1] - dj[1], di[2] - dj[2]];
      // Coincident material halves are exactly on the blade medial plane at
      // first contact. One preferred side owns a positive-area tie; integrating
      // both tied planes would double energy and cancel the opening force.
      if (difference.every(v => Math.abs(v) < 1e-15)) {
        if (j < i) polygon = [];
        continue;
      }
      polygon = clip(polygon, difference);
    }
    if (polygon.length < 3) continue;
    const a = polygon[0]!;
    for (let k = 1; k + 1 < polygon.length; ++k) {
      const b = polygon[k]!, c = polygon[k + 1]!;
      const fraction = Math.abs((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]));
      const area = referenceAreaM2 * fraction;
      if (!(area > 1e-30)) continue;
      const q = [a, b, c], penetration = q.map(v => -dot(di, v));
      const sumP = penetration.reduce((sum, v) => sum + v, 0);
      const sumP2 = penetration.reduce((sum, v) => sum + v * v, 0);
      const integratedP2 = area * (sumP * sumP + sumP2) / 12;
      energyJ += .5 * stiffnessPaPerM * integratedP2;
      activeAreaM2 += area; pieces++;
      const sums = [0, 1, 2].map(j => a[j]! + b[j]! + c[j]!);
      for (let row = 0; row < 3; ++row) {
        const integratedPN = area * (sumP * sums[row]! + q.reduce((sum, v, k) => sum + penetration[k]! * v[row]!, 0)) / 12;
        for (let axis = 0; axis < 3; ++axis) gradient[3 * row + axis]! -= stiffnessPaPerM * integratedPN * normal[axis]!;
        if (options.gram !== false) for (let col = 0; col < 3; ++col) {
          const integratedNN = area * (sums[row]! * sums[col]! + q.reduce((sum, v) => sum + v[row]! * v[col]!, 0)) / 12;
          for (let r = 0; r < 3; ++r) for (let s = 0; s < 3; ++s) gram[9 * (3 * row + r) + 3 * col + s]! += stiffnessPaPerM * integratedNN * normal[r]! * normal[s]!;
        }
      }
      // A positive degree-two triangle rule factors the same Gram matrix.
      // These moving integration points are a factorization of the already
      // integrated potential; they are not a replacement contact sampling grid.
      if (options.terms) for (let vertex = 0; vertex < 3; ++vertex) {
        const bary: Bary = [0, 0, 0];
        for (let j = 0; j < 3; ++j) for (let corner = 0; corner < 3; ++corner) bary[j]! += q[corner]![j]! * (corner === vertex ? 2 / 3 : 1 / 6);
        terms.push({ bary, normal: [...normal], stiffness: stiffnessPaPerM * area / 3 });
      }
    }
  }
  return { energyJ, gradient, gram, terms, activeAreaM2, pieces };
}
