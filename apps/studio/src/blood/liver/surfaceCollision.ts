import { ballisticLandingTime, ballisticState, type VesselVector } from "../experiments/vesselSolver";
import type { JetCollisionQuery, JetSurfaceContact } from "../experiments/jetCollision";
import type { LiverCutGeometry, LiverSurface, LiverVec3 } from "./types";

type Box = { lo: LiverVec3; hi: LiverVec3 };
interface Triangle extends Box {
  a: LiverVec3; u: LiverVec3; v: LiverVec3; n: LiverVec3;
  uu: number; uv: number; vv: number; inverse: number;
  canonical: number; mapping: [LiverVec3, LiverVec3, LiverVec3];
}
interface Node extends Box { left?: Node; right?: Node; triangles?: number[]; }
export interface LiverSurfaceAnchor extends JetSurfaceContact {
  retainedTriangle: number;
  retainedBarycentric: LiverVec3;
}
const dot = (a: VesselVector, b: VesselVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: VesselVector, b: VesselVector): LiverVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const plus = (a: VesselVector, b: VesselVector, scale = 1): LiverVec3 => [a[0] + scale * b[0], a[1] + scale * b[1], a[2] + scale * b[2]];
const cross = (a: VesselVector, b: VesselVector): LiverVec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const point = (p: ArrayLike<number>, i: number): LiverVec3 => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
function roots(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return [];
  a /= scale; b /= scale; c /= scale;
  if (Math.abs(a) < 1e-15) return b === 0 ? [] : [-c / b];
  const d = b * b - 4 * a * c;
  if (d < -32 * Number.EPSILON * (b * b + Math.abs(4 * a * c))) return [];
  const q = -.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, d)));
  return q === 0 ? [-b / (2 * a)] : [q / a, c / q];
}
const overlap = (a: Box, b: Box, margin: number) => a.lo.every((v, k) => v <= b.hi[k]! + margin && a.hi[k]! >= b.lo[k]! - margin);
function bounds(items: readonly Box[]): Box {
  // A refined capsule contains over 120,000 faces. Argument spreading here
  // exceeds some engines' call-stack/argument limits during BVH construction.
  const lo: LiverVec3 = [Infinity, Infinity, Infinity], hi: LiverVec3 = [-Infinity, -Infinity, -Infinity];
  for (const item of items) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k]!, item.lo[k]!); hi[k] = Math.max(hi[k]!, item.hi[k]!);
  }
  return { lo, hi };
}

/** Static retained-mesh BVH, rebuilt only when a wound changes topology.
 * Trajectories intersect planar triangles continuously; a drop uses its
 * facet-normal radius support, not a complete sphere/triangle-edge solver.
 * Film depth is frozen at the previous accepted step and linearly interpolated.
 */
export class LiverSurfaceCollision implements JetCollisionQuery {
  private readonly triangles: Triangle[];
  private readonly root: Node;
  private depthAtVertex: (i: number) => number = () => 0;
  private depthBoundM = 0;
  private attached: { originM: VesselVector; anchor: LiverSurfaceAnchor }[] = [];
  private filmEpoch = 1;
  private readonly triangleEpoch: Uint32Array;
  private readonly displacedCache: (Triangle | undefined)[];
  constructor(private readonly canonical: LiverSurface, cut: LiverCutGeometry, private readonly escapePlaneYM: number) {
    const mesh = cut.surface;
    this.triangles = [];
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const ids = [mesh.indices[k]!, mesh.indices[k + 1]!, mesh.indices[k + 2]!];
      const a = point(mesh.positionsM, ids[0]!), b = point(mesh.positionsM, ids[1]!), c = point(mesh.positionsM, ids[2]!);
      const u = sub(b, a), v = sub(c, a), normal = cross(u, v), length = Math.hypot(...normal);
      if (!(length > 1e-14)) continue;
      const uu = dot(u, u), uv = dot(u, v), vv = dot(v, v), determinant = uu * vv - uv * uv;
      if (!(determinant > 0)) continue;
      this.triangles.push({ a, u, v, n: normal.map(x => x / length) as LiverVec3,
        uu, uv, vv, inverse: 1 / determinant, canonical: cut.sourceTriangles[ids[0]!]!,
        mapping: ids.map(i => point(cut.sourceBarycentrics, i)) as Triangle["mapping"],
        lo: [0, 1, 2].map(j => Math.min(a[j]!, b[j]!, c[j]!)) as LiverVec3,
        hi: [0, 1, 2].map(j => Math.max(a[j]!, b[j]!, c[j]!)) as LiverVec3 });
    }
    if (!this.triangles.length) throw new Error("Liver collision requires retained surface");
    this.triangleEpoch = new Uint32Array(this.triangles.length); this.displacedCache = new Array(this.triangles.length);
    this.root = this.build(this.triangles.map((_, i) => i));
  }
  private build(ids: number[]): Node {
    const box = bounds(ids.map(i => this.triangles[i]!));
    if (ids.length <= 8) return { ...box, triangles: ids };
    const axis = [0, 1, 2].reduce((best, k) => box.hi[k]! - box.lo[k]! > box.hi[best]! - box.lo[best]! ? k : best, 0);
    ids.sort((a, b) => this.triangles[a]!.lo[axis]! + this.triangles[a]!.hi[axis]!
      - this.triangles[b]!.lo[axis]! - this.triangles[b]!.hi[axis]!);
    const half = Math.floor(ids.length / 2);
    return { ...box, left: this.build(ids.slice(0, half)), right: this.build(ids.slice(half)) };
  }
  /** Query is read-only until the whole coupled step commits. */
  setAcceptedFilm(depthAtVertex: (i: number) => number, maximumDepthM: number): void {
    if (!Number.isFinite(maximumDepthM) || maximumDepthM < 0 || maximumDepthM > .02) throw new RangeError("Invalid film collision bound");
    this.depthAtVertex = depthAtVertex; this.depthBoundM = maximumDepthM;
    if (++this.filmEpoch >= 0xffffffff) { this.triangleEpoch.fill(0); this.filmEpoch = 1; }
  }
  /** The low-We attachment boundary is an explicit complete-dissipation
   * closure at the wound lip, not a prediction of contact-angle hysteresis. */
  setAttachedSources(sources: { originM: VesselVector; anchor: LiverSurfaceAnchor }[]) {
    this.attached = sources;
  }
  private barycentric(t: Triangle, p: VesselVector): LiverVec3 {
    const d = sub(p, t.a), du = dot(d, t.u), dv = dot(d, t.v);
    const b = (t.vv * du - t.uv * dv) * t.inverse, c = (t.uu * dv - t.uv * du) * t.inverse;
    return [1 - b - c, b, c];
  }
  private mapped(t: Triangle, bary: VesselVector): LiverVec3 {
    const b: LiverVec3 = [0, 0, 0];
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) b[k] = b[k]! + bary[j]! * t.mapping[j]![k]!;
    const total = b.reduce((a, c) => a + Math.max(0, c), 0);
    return b.map(x => Math.max(0, x) / total) as LiverVec3;
  }
  private displacedTriangle(index: number): Triangle {
    const source = this.triangles[index]!;
    if (this.depthBoundM === 0) return source;
    if (this.triangleEpoch[index] === this.filmEpoch) return this.displacedCache[index]!;
    const points = [source.a, plus(source.a, source.u), plus(source.a, source.v)].map((base, vertex) => {
      const weights = source.mapping[vertex]!, normal: LiverVec3 = [0, 0, 0]; let h = 0;
      for (let j = 0; j < 3; j++) {
        const i = this.canonical.indices[3 * source.canonical + j]!;
        h += weights[j]! * this.depthAtVertex(i);
        for (let k = 0; k < 3; k++) normal[k] = normal[k]! + weights[j]! * this.canonical.normals[3 * i + k]!;
      }
      const length = Math.hypot(...normal);
      if (!(length > 0) || h < 0 || !Number.isFinite(h)) throw new Error("Invalid accepted film displacement");
      return plus(base, normal, h / length);
    });
    const a = points[0]!, u = sub(points[1]!, a), v = sub(points[2]!, a), normal = cross(u, v), length = Math.hypot(...normal);
    const uu = dot(u, u), uv = dot(u, v), vv = dot(v, v), determinant = uu * vv - uv * uv;
    if (!(length > 1e-14) || !(determinant > 0)) throw new Error("Degenerate displaced film collision triangle");
    const result: Triangle = { ...source, a, u, v, n: normal.map(x => x / length) as LiverVec3, uu, uv, vv, inverse: 1 / determinant };
    this.triangleEpoch[index] = this.filmEpoch; this.displacedCache[index] = result;
    return result;
  }
  /** Closest retained point. Branch-and-bound also supports deterministic
   * runoff-anchor/geometry queries without scanning every refined face. */
  nearest(positionM: VesselVector, outwardGravityMS2?: VesselVector): LiverSurfaceAnchor {
    if (!positionM.every(Number.isFinite) || outwardGravityMS2 && !outwardGravityMS2.every(Number.isFinite))
      throw new RangeError("Invalid nearest liver surface query");
    let distance = Infinity, result: LiverSurfaceAnchor | undefined;
    const boxDistance = (box: Box) => positionM.reduce((sum, x, k) =>
      sum + Math.max(box.lo[k]! - x, 0, x - box.hi[k]!) ** 2, 0);
    const stack = [this.root];
    while (stack.length) {
      const node = stack.pop()!;
      if (boxDistance(node) > distance) continue;
      if (!node.triangles) {
        const a = node.left!, b = node.right!;
        if (boxDistance(a) < boxDistance(b)) stack.push(b, a); else stack.push(a, b);
        continue;
      }
      for (const index of node.triangles) {
      const t = this.triangles[index]!;
      if (outwardGravityMS2 && dot(t.n, outwardGravityMS2) <= 1e-10) continue;
      const projected = plus(positionM, t.n, -dot(sub(positionM, t.a), t.n));
      const bary = this.barycentric(t, projected), candidates: LiverVec3[] = [];
      if (bary.every(v => v >= 0)) candidates.push(projected);
      const p = [t.a, plus(t.a, t.u), plus(t.a, t.v)];
      for (let j = 0; j < 3; j++) {
        const a = p[j]!, b = p[(j + 1) % 3]!, edge = sub(b, a);
        candidates.push(plus(a, edge, Math.max(0, Math.min(1, dot(sub(positionM, a), edge) / dot(edge, edge)))));
      }
      for (const p of candidates) {
        const d = dot(sub(p, positionM), sub(p, positionM));
        if (d < distance || d === distance && index < (result?.retainedTriangle ?? Infinity)) {
          distance = d; result = { timeSeconds: 0, positionM: p, retainedTriangle: index,
            retainedBarycentric: this.barycentric(t, p),
            surface: { triangle: t.canonical, barycentric: this.mapped(t, this.barycentric(t, p)) } };
        }
      }
      }
    }
    if (!result) throw new Error("No retained liver facet supports the requested outward-gravity direction");
    return result;
  }
  contact(originM: VesselVector, initialVelocityMS: VesselVector, gravityMS2: VesselVector,
    birthTimeSeconds: number, startTimeSeconds: number, endTimeSeconds: number, supportRadiusM: number): JetSurfaceContact | undefined {
    const start = Math.max(birthTimeSeconds, startTimeSeconds), duration = endTimeSeconds - start;
    if (duration < 0 || ![...originM, ...initialVelocityMS, ...gravityMS2, start, duration, supportRadiusM].every(Number.isFinite))
      throw new RangeError("Invalid liver trajectory");
    for (const source of this.attached) if (supportRadiusM === 0 && birthTimeSeconds >= startTimeSeconds - 1e-12
      && Math.hypot(...sub(source.originM, originM)) < 1e-10)
      {
        const t = this.displacedTriangle(source.anchor.retainedTriangle), b = source.anchor.retainedBarycentric;
        return { timeSeconds: birthTimeSeconds, positionM: plus(plus(t.a, t.u, b[1]), t.v, b[2]),
          surface: { triangle: t.canonical, barycentric: this.mapped(t, b) }, sourceAttachment: true };
      }
    const initial = ballisticState(originM, initialVelocityMS, gravityMS2, start - birthTimeSeconds);
    const p = initial.positionM, v = initial.velocityMS;
    let answer: JetSurfaceContact | undefined;
    const clearance = p[1] - supportRadiusM - this.escapePlaneYM;
    const floor = clearance <= 0 ? 0 : ballisticLandingTime(clearance, v[1], gravityMS2[1]);
    if (floor <= duration) {
      const hit = ballisticState(p, v, gravityMS2, floor).positionM;
      answer = { timeSeconds: start + floor, positionM: [hit[0], this.escapePlaneYM, hit[2]] };
    }
    const lo: LiverVec3 = [0, 0, 0], hi: LiverVec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const values = [p[k]!, p[k]! + v[k]! * duration + .5 * gravityMS2[k]! * duration ** 2];
      const turn = -v[k]! / gravityMS2[k]!;
      if (turn > 0 && turn < duration) values.push(p[k]! + v[k]! * turn + .5 * gravityMS2[k]! * turn ** 2);
      lo[k] = Math.min(...values); hi[k] = Math.max(...values);
    }
    const box = { lo, hi }, candidates: number[] = [], stack = [this.root], margin = supportRadiusM + this.depthBoundM + 1e-12;
    while (stack.length) {
      const node = stack.pop()!; if (!overlap(node, box, margin)) continue;
      if (node.triangles) candidates.push(...node.triangles); else { stack.push(node.left!, node.right!); }
    }
    if (candidates.length > 8192) throw new Error("Liver collision budget exceeded; step rolled back");
    for (const index of candidates) {
      const t = this.displacedTriangle(index);
      const A = .5 * dot(gravityMS2, t.n), B = dot(v, t.n);
      const C = dot(sub(p, t.a), t.n) - supportRadiusM;
      const times = roots(A, B, C).filter(time => Number.isFinite(time) && time >= -1e-12 && time <= duration + 1e-12);
      if (C <= 1e-12 && C >= -margin && B <= 0) times.push(0);
      times.sort((a, b) => a - b);
      for (const time0 of times) {
        const time = Math.max(0, Math.min(duration, time0));
        if (2 * A * time + B > 1e-10 || answer && start + time >= answer.timeSeconds) continue;
        const centre = ballisticState(p, v, gravityMS2, time).positionM, bary = this.barycentric(t, centre);
        if (bary.some(x => x < -1e-9 || x > 1 + 1e-9)) continue;
        const base = plus(centre, t.n, -dot(sub(centre, t.a), t.n));
        answer = { timeSeconds: start + time, positionM: base,
          surface: { triangle: t.canonical, barycentric: this.mapped(t, bary) } };
        break;
      }
    }
    return answer;
  }
}
