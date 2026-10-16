/** Exact closest point on a triangle, with barycentric weights. Distances use
 * the caller's units. Degenerate triangles reduce to their three segments. */
export type Point3 = readonly [number, number, number];
export interface TriangleClosestPoint { point: [number, number, number]; weights: [number, number, number]; distance: number }
export function closestTrianglePoint(p: Point3, a: Point3, b: Point3, c: Point3): TriangleClosestPoint {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (u: readonly number[], v: readonly number[]) => u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
  const build = (u: number, v: number, w: number): TriangleClosestPoint => {
    const q: [number, number, number] = [u * a[0] + v * b[0] + w * c[0], u * a[1] + v * b[1] + w * c[1], u * a[2] + v * b[2] + w * c[2]];
    return { point: q, weights: [u, v, w], distance: Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) };
  };
  const area2 = (ab[1]! * ac[2]! - ab[2]! * ac[1]!) ** 2 + (ab[2]! * ac[0]! - ab[0]! * ac[2]!) ** 2 + (ab[0]! * ac[1]! - ab[1]! * ac[0]!) ** 2;
  if (area2 <= 1e-28) {
    const vertices = [a, b, c]; let best = build(1, 0, 0);
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      const x = vertices[i!]!, y = vertices[j!]!, edge = [y[0] - x[0], y[1] - x[1], y[2] - x[2]], relative = [p[0] - x[0], p[1] - x[1], p[2] - x[2]];
      const t = Math.max(0, Math.min(1, dot(relative, edge) / Math.max(dot(edge, edge), 1e-30))), weights = [0, 0, 0]; weights[i!] = 1 - t; weights[j!] = t;
      const candidate = build(weights[0]!, weights[1]!, weights[2]!); if (candidate.distance < best.distance) best = candidate;
    }
    return best;
  }
  const d1 = dot(ab, ap), d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return build(1, 0, 0);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]], d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return build(0, 1, 0);
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return build(1 - v, v, 0); }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return build(0, 0, 1);
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return build(1 - w, 0, w); }
  const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return build(0, 1 - w, w); }
  const inverse = 1 / (va + vb + vc), v = vb * inverse, w = vc * inverse; return build(1 - v - w, v, w);
}
