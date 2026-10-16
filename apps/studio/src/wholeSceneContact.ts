/** Refittable triangle contact for a finite spherical laparoscopic tip.
 * BVH boxes are only a broad phase. Narrow phase tests actual triangle faces,
 * edges and vertices continuously along the requested tip segment. Atlas sheets
 * are treated two-sided; this makes no watertight-lumen or volume assumption.
 */
export type ContactVector = [number, number, number];
type Indices = Uint16Array | Uint32Array;
export interface SceneSurfaceHit {
  organId: string; triangleIndex: number; vertexIndices: [number, number, number];
  barycentric: ContactVector; restPointMm: ContactVector; pointMm: ContactVector;
  normal: ContactVector; distanceMm: number;
}
export interface SceneSphereContact extends SceneSurfaceHit {
  time: number; tipCenterMm: ContactVector; penetrationMm: number;
}
export interface SceneCapsuleContact extends SceneSurfaceHit {
  segmentPointMm: ContactVector; clearanceMm: number; penetrationMm: number;
  time: number; conservativeStop: boolean; iterations: number;
}
interface Node { min: ContactVector; max: ContactVector; start: number; end: number; left?: Node; right?: Node }
const EPS = 1e-9;
const add = (a: ArrayLike<number>, b: ArrayLike<number>): ContactVector => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): ContactVector => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const scale = (a: ArrayLike<number>, s: number): ContactVector => [a[0]! * s, a[1]! * s, a[2]! * s];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): ContactVector => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const length = (a: ArrayLike<number>) => Math.sqrt(dot(a, a));
const unit = (a: ArrayLike<number>, fallback: ContactVector = [0, 0, 1]): ContactVector => length(a) > EPS ? scale(a, 1 / length(a)) : fallback;
const vertex = (p: Float32Array, i: number): ContactVector => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
const finiteVector = (p: ArrayLike<number>) => p.length === 3 && [p[0], p[1], p[2]].every(Number.isFinite);
export function barycentricSurfacePoint(positions: Float32Array, indices: ArrayLike<number>, weights: ArrayLike<number>): ContactVector {
  const out: ContactVector = [0, 0, 0];
  for (let corner = 0; corner < 3; corner++) for (let a = 0; a < 3; a++) out[a]! += positions[3 * indices[corner]! + a]! * weights[corner]!;
  return out;
}

function closestTriangle(p: ContactVector, a: ContactVector, b: ContactVector, c: ContactVector): { point: ContactVector; barycentric: ContactVector } {
  const ab = sub(b, a), ac = sub(c, a);
  if (dot(cross(ab, ac), cross(ab, ac)) < 1e-18) {
    let best = Infinity, result = { point: a, barycentric: [1, 0, 0] as ContactVector };
    for (const [start, end, i, j] of [[a, b, 0, 1], [b, c, 1, 2], [c, a, 2, 0]] as [ContactVector, ContactVector, number, number][]) {
      const edge = sub(end, start), t = Math.max(0, Math.min(1, dot(sub(p, start), edge) / Math.max(dot(edge, edge), EPS)));
      const point = add(start, scale(edge, t)), d = dot(sub(point, p), sub(point, p));
      if (d < best) { const barycentric: ContactVector = [0, 0, 0]; barycentric[i] = 1 - t; barycentric[j] = t; best = d; result = { point, barycentric }; }
    }
    return result;
  }
  const ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, barycentric: [1, 0, 0] };
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, barycentric: [0, 1, 0] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return { point: add(a, scale(ab, v)), barycentric: [1 - v, v, 0] }; }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, barycentric: [0, 0, 1] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return { point: add(a, scale(ac, w)), barycentric: [1 - w, 0, w] }; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); return { point: add(b, scale(sub(c, b), w)), barycentric: [0, 1 - w, w] }; }
  const inverse = 1 / (va + vb + vc), v = vb * inverse, w = vc * inverse;
  return { point: add(a, add(scale(ab, v), scale(ac, w))), barycentric: [1 - v - w, v, w] };
}
function sphereTimes(offset: ContactVector, velocity: ContactVector, radius: number): number[] {
  const speed2 = dot(velocity, velocity); if (speed2 < 1e-20) return [];
  // Closest approach avoids subtracting huge nearly equal quadratic terms on
  // long sweeps, which otherwise turns a near-graze miss into a false hit.
  const center = -dot(offset, velocity) / speed2;
  const perpendicular = add(offset, scale(velocity, center));
  const height2 = radius * radius - dot(perpendicular, perpendicular);
  if (height2 < -1e-10 * Math.max(1, radius * radius)) return [];
  const half = Math.sqrt(Math.max(0, height2) / speed2); return [center - half, center + half];
}
function triangleSweep(from: ContactVector, to: ContactVector, radius: number, a: ContactVector, b: ContactVector, c: ContactVector): number | null {
  const velocity = sub(to, from), initial = closestTriangle(from, a, b, c);
  const initialVector = sub(from, initial.point), initialDistance = length(initialVector);
  if (initialDistance <= radius + 1e-7) {
    // A convex expanded triangle cannot be entered later along a straight line
    // once its closest-feature directional derivative is nonnegative.
    if (dot(velocity, velocity) > 1e-18) {
      const derivative = dot(velocity, initialVector), shallow = initialDistance >= radius - 1e-4;
      if (initialDistance > 1e-8 && (derivative > 1e-9 || (shallow && derivative >= -1e-9))) return null;
      if (initialDistance <= 1e-8) {
        const probe = add(from, scale(velocity, Math.min(1, 1e-3 / length(velocity))));
        if (length(sub(probe, closestTriangle(probe, a, b, c).point)) > 1e-8) return null;
      }
    }
    return 0;
  }
  if (dot(velocity, velocity) < 1e-18) return null;
  let earliest = Infinity;
  const consider = (t: number) => { if (t >= -1e-9 && t <= 1 + 1e-9) earliest = Math.min(earliest, Math.max(0, Math.min(1, t))); };
  const face = cross(sub(b, a), sub(c, a)), faceLength = length(face);
  if (faceLength > EPS) {
    const normal = scale(face, 1 / faceLength), signed = dot(sub(from, a), normal), speed = dot(velocity, normal);
    if (Math.abs(speed) > 1e-12) for (const side of [-1, 1]) {
      const t = (side * radius - signed) / speed;
      if (t < 0 || t > 1) continue;
      const center = add(from, scale(velocity, t)), projected = sub(center, scale(normal, side * radius));
      if (length(sub(closestTriangle(projected, a, b, c).point, projected)) < 1e-6) consider(t);
    }
  }
  for (const [start, end] of [[a, b], [b, c], [c, a]] as [ContactVector, ContactVector][]) {
    const edge = sub(end, start), edge2 = dot(edge, edge), relative = sub(from, start);
    if (edge2 > 1e-18) {
      const along = dot(relative, edge) / edge2, rate = dot(velocity, edge) / edge2;
      const perpendicular = sub(relative, scale(edge, along)), transverse = sub(velocity, scale(edge, rate));
      for (const t of sphereTimes(perpendicular, transverse, radius)) {
        if (along + t * rate >= -1e-9 && along + t * rate <= 1 + 1e-9) consider(t);
      }
    }
    for (const t of sphereTimes(relative, velocity, radius)) consider(t);
  }
  return Number.isFinite(earliest) ? earliest : null;
}
function boxDistance2(point: ArrayLike<number>, node: Node) {
  let distance = 0;
  for (let a = 0; a < 3; a++) { const d = Math.max(node.min[a]! - point[a]!, 0, point[a]! - node.max[a]!); distance += d * d; }
  return distance;
}
function closestSegments(p: ContactVector, q: ContactVector, a: ContactVector, b: ContactVector): [ContactVector, ContactVector] {
  const d1 = sub(q, p), d2 = sub(b, a), r = sub(p, a), aa = dot(d1, d1), ee = dot(d2, d2), ff = dot(d2, r);
  let s = 0, t = 0;
  if (aa < 1e-18 && ee < 1e-18) return [p, a];
  if (aa < 1e-18) t = Math.max(0, Math.min(1, ff / ee));
  else {
    const cc = dot(d1, r);
    if (ee < 1e-18) s = Math.max(0, Math.min(1, -cc / aa));
    else {
      const bb = dot(d1, d2), denominator = aa * ee - bb * bb;
      s = denominator > 1e-18 ? Math.max(0, Math.min(1, (bb * ff - cc * ee) / denominator)) : 0;
      t = (bb * s + ff) / ee;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -cc / aa)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (bb - cc) / aa)); }
    }
  }
  return [add(p, scale(d1, s)), add(a, scale(d2, t))];
}
function segmentTriangle(start: ContactVector, end: ContactVector, a: ContactVector, b: ContactVector, c: ContactVector) {
  let segmentPoint = start, trianglePoint = closestTriangle(start, a, b, c).point;
  let distance = length(sub(segmentPoint, trianglePoint));
  const last = closestTriangle(end, a, b, c).point, lastDistance = length(sub(end, last));
  if (lastDistance < distance) { distance = lastDistance; segmentPoint = end; trianglePoint = last; }
  const direction = sub(end, start), normal = cross(sub(b, a), sub(c, a)), denominator = dot(normal, direction);
  if (Math.abs(denominator) > 1e-15) {
    const time = dot(normal, sub(a, start)) / denominator;
    if (time >= 0 && time <= 1) {
      const point = add(start, scale(direction, time));
      if (length(sub(closestTriangle(point, a, b, c).point, point)) < 1e-7) return { segmentPoint: point, trianglePoint: point, distance: 0 };
    }
  }
  for (const [u, v] of [[a, b], [b, c], [c, a]] as [ContactVector, ContactVector][]) {
    const [sp, tp] = closestSegments(start, end, u, v), d = length(sub(sp, tp));
    if (d < distance) { distance = d; segmentPoint = sp; trianglePoint = tp; }
  }
  return { segmentPoint, trianglePoint, distance };
}

export class SceneSurfaceContact {
  private positions: Float32Array;
  private readonly order: Uint32Array;
  private readonly root: Node;
  private readonly triangleBounds: Float64Array;
  private readonly centroids: Float64Array;
  private lastTriangles = 0;
  private refits = 0;
  private vertexFaceOffsets: Uint32Array | null = null;
  private vertexFaces: Uint32Array | null = null;
  constructor(readonly organId: string, private readonly rest: Float32Array, private readonly indices: Indices) {
    if (!rest.length || rest.length % 3 || indices.length % 3 || !rest.every(Number.isFinite) || !indices.length || Array.from(indices).some(i => i * 3 >= rest.length)) throw new Error("Contact geometry is invalid.");
    this.positions = rest;
    this.order = new Uint32Array(indices.length / 3);
    for (let i = 0; i < this.order.length; i++) this.order[i] = i;
    this.triangleBounds = new Float64Array(this.order.length * 6);
    this.centroids = new Float64Array(this.order.length * 3);
    this.updateTriangleBounds();
    for (let i = 0; i < this.order.length; i++) for (let a = 0; a < 3; a++) this.centroids[i * 3 + a] = this.triangleBounds[i * 6 + a]! + this.triangleBounds[i * 6 + a + 3]!;
    this.root = this.build(0, this.order.length);
  }
  private updateTriangleBounds() {
    for (let t = 0; t < this.order.length; t++) for (let a = 0; a < 3; a++) {
      const v0 = this.positions[this.indices[t * 3]! * 3 + a]!, v1 = this.positions[this.indices[t * 3 + 1]! * 3 + a]!, v2 = this.positions[this.indices[t * 3 + 2]! * 3 + a]!;
      this.triangleBounds[t * 6 + a] = Math.min(v0, v1, v2); this.triangleBounds[t * 6 + a + 3] = Math.max(v0, v1, v2);
    }
  }
  private bounds(node: Node) {
    node.min.fill(Infinity); node.max.fill(-Infinity);
    if (node.left && node.right) for (let a = 0; a < 3; a++) { node.min[a] = Math.min(node.left.min[a]!, node.right.min[a]!); node.max[a] = Math.max(node.left.max[a]!, node.right.max[a]!); }
    else for (let i = node.start; i < node.end; i++) for (let a = 0; a < 3; a++) { const offset = this.order[i]! * 6; node.min[a] = Math.min(node.min[a]!, this.triangleBounds[offset + a]!); node.max[a] = Math.max(node.max[a]!, this.triangleBounds[offset + a + 3]!); }
  }
  private build(start: number, end: number): Node {
    const node: Node = { min: [0, 0, 0], max: [0, 0, 0], start, end }; this.bounds(node);
    if (end - start > 12) {
      const extent = sub(node.max, node.min), axis = extent.indexOf(Math.max(...extent));
      const middle = (start + end) >> 1;
      this.partitionMedian(start, end - 1, middle, axis);
      node.left = this.build(start, middle); node.right = this.build(middle, end);
    }
    return node;
  }
  /** In-place median partition: O(n) average work instead of sorting and
   * allocating each subtree at every depth. Equal-centroid triangles still split. */
  private partitionMedian(left: number, right: number, middle: number, axis: number) {
    const order = this.order, centers = this.centroids;
    while (left < right) {
      const a = centers[order[left]! * 3 + axis]!, b = centers[order[(left + right) >> 1]! * 3 + axis]!, c = centers[order[right]! * 3 + axis]!;
      const pivot = a < b ? (b < c ? b : Math.max(a, c)) : (a < c ? a : Math.max(b, c));
      let i = left, j = right;
      while (i <= j) {
        while (centers[order[i]! * 3 + axis]! < pivot) i++;
        while (centers[order[j]! * 3 + axis]! > pivot) j--;
        if (i <= j) { const value = order[i]!; order[i] = order[j]!; order[j] = value; i++; j--; }
      }
      if (middle <= j) right = j;
      else if (middle >= i) left = i;
      else return;
    }
  }
  refit(deformed: Float32Array) {
    if (deformed.length !== this.rest.length || !deformed.every(Number.isFinite)) throw new Error("Deformed contact positions are invalid.");
    this.positions = deformed; this.updateTriangleBounds();
    const visit = (node: Node) => { if (node.left) visit(node.left); if (node.right) visit(node.right); this.bounds(node); };
    visit(this.root); this.refits++;
  }
  /** A source-connected local grip patch, never all triangles of an organ.
   * Adjacent disconnected bowel loops cannot enter this shared-index flood.
   * Source coarse triangles are atomic exclusions and may extend past radius. */
  contactPatch(triangleIndex: number, restPointMm: number[], radiusMm: number): ReadonlySet<number> {
    if (!Number.isInteger(triangleIndex) || triangleIndex < 0 || triangleIndex >= this.order.length || !finiteVector(restPointMm) || !Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Invalid local contact patch.");
    if (!this.vertexFaceOffsets || !this.vertexFaces) {
      const offsets = new Uint32Array(this.rest.length / 3 + 1);
      for (const index of this.indices) offsets[index + 1]!++;
      for (let i = 1; i < offsets.length; i++) offsets[i]! += offsets[i - 1]!;
      const cursor = offsets.slice(), faces = new Uint32Array(this.indices.length);
      for (let i = 0; i < this.indices.length; i++) faces[cursor[this.indices[i]!]!++] = Math.floor(i / 3);
      this.vertexFaceOffsets = offsets; this.vertexFaces = faces;
    }
    const patch = new Set<number>(), seen = new Uint8Array(this.order.length), pending = [triangleIndex];
    seen[triangleIndex] = 1;
    while (pending.length) {
      const triangle = pending.pop()!, ids = [this.indices[triangle * 3]!, this.indices[triangle * 3 + 1]!, this.indices[triangle * 3 + 2]!];
      const corners = ids.map(i => vertex(this.rest, i)) as [ContactVector, ContactVector, ContactVector];
      if (triangle !== triangleIndex && length(sub(closestTriangle(restPointMm as ContactVector, ...corners).point, restPointMm)) > radiusMm) continue;
      patch.add(triangle);
      for (const id of ids) for (let i: number = this.vertexFaceOffsets[id]!; i < this.vertexFaceOffsets[id + 1]!; i++) {
        const neighbor = this.vertexFaces[i]!;
        if (!seen[neighbor]) { seen[neighbor] = 1; pending.push(neighbor); }
      }
    }
    return patch;
  }
  private triangle(t: number): [ContactVector, ContactVector, ContactVector] { return [vertex(this.positions, this.indices[t * 3]!), vertex(this.positions, this.indices[t * 3 + 1]!), vertex(this.positions, this.indices[t * 3 + 2]!)]; }
  private hit(t: number, point: ContactVector, fallback?: ContactVector): SceneSurfaceHit {
    const triangle = this.triangle(t), closest = closestTriangle(point, ...triangle), displacement = sub(point, closest.point);
    const vertexIndices: [number, number, number] = [this.indices[t * 3]!, this.indices[t * 3 + 1]!, this.indices[t * 3 + 2]!];
    return { organId: this.organId, triangleIndex: t, vertexIndices, barycentric: closest.barycentric,
      restPointMm: barycentricSurfacePoint(this.rest, vertexIndices, closest.barycentric), pointMm: closest.point,
      normal: unit(displacement, fallback ?? unit(cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0])))), distanceMm: length(displacement) };
  }
  /** Nearest actual triangle under the pointer, using the same refitted BVH as
   * instrument contact. Avoid full-mesh ray scans on every hover/diagnostic tick. */
  raycast(origin: number[], direction: number[], side: "front" | "back" | "double" = "double", maxDistanceMm = Infinity): SceneSurfaceHit | null {
    if (!finiteVector(origin) || !finiteVector(direction) || length(direction) < EPS || !(maxDistanceMm >= 0)) throw new Error("Invalid surface ray.");
    const ray = unit(direction), start = origin as ContactVector;
    let best = maxDistanceMm, triangle = -1;
    this.lastTriangles = 0;
    const entry = (node: Node) => {
      let lo = 0, hi = best;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(ray[a]!) < 1e-15) {
          if (start[a]! < node.min[a]! || start[a]! > node.max[a]!) return Infinity;
        } else {
          const t0 = (node.min[a]! - start[a]!) / ray[a]!, t1 = (node.max[a]! - start[a]!) / ray[a]!;
          lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
          if (lo > hi) return Infinity;
        }
      }
      return lo;
    };
    const visit = (node: Node) => {
      if (!Number.isFinite(entry(node))) return;
      if (node.left && node.right) {
        const first = entry(node.left) <= entry(node.right) ? node.left : node.right;
        visit(first); visit(first === node.left ? node.right : node.left); return;
      }
      for (let i = node.start; i < node.end; i++) {
        this.lastTriangles++;
        const t = this.order[i]!, [a, b, c] = this.triangle(t);
        const ab = sub(b, a), ac = sub(c, a), p = cross(ray, ac), det = dot(ab, p);
        if (Math.abs(det) < 1e-12 || (side === "front" && det < 0) || (side === "back" && det > 0)) continue;
        const offset = sub(start, a), u = dot(offset, p) / det;
        if (u < 0 || u > 1) continue;
        const q = cross(offset, ab), v = dot(ray, q) / det;
        if (v < 0 || u + v > 1) continue;
        const distance = dot(ac, q) / det;
        if (distance < 0 || distance > best || (distance === best && triangle >= 0 && t > triangle)) continue;
        best = distance; triangle = t;
      }
    };
    visit(this.root);
    if (triangle < 0) return null;
    const hit = this.hit(triangle, add(start, scale(ray, best)));
    const [a, b, c] = this.triangle(triangle), normal = unit(cross(sub(b, a), sub(c, a)));
    return { ...hit, distanceMm: best, normal: dot(normal, ray) > 0 ? scale(normal, -1) : normal };
  }
  closestPoint(point: number[], maxDistanceMm = Infinity, ignoreTriangles?: ReadonlySet<number>): SceneSurfaceHit | null {
    if (!finiteVector(point) || !(maxDistanceMm >= 0)) throw new Error("Invalid contact query.");
    let best = maxDistanceMm * maxDistanceMm, result: SceneSurfaceHit | null = null; this.lastTriangles = 0;
    const visit = (node: Node) => {
      if (boxDistance2(point, node) > best) return;
      if (node.left && node.right) {
        const first = boxDistance2(point, node.left) <= boxDistance2(point, node.right) ? node.left : node.right;
        visit(first); visit(first === node.left ? node.right : node.left); return;
      }
      for (let i = node.start; i < node.end; i++) { if (ignoreTriangles?.has(this.order[i]!)) continue; this.lastTriangles++; const hit = this.hit(this.order[i]!, point as ContactVector); if (hit.distanceMm ** 2 <= best) { best = hit.distanceMm ** 2; result = hit; } }
    };
    visit(this.root); return result;
  }
  sweepSphere(from: number[], to: number[], radiusMm: number, ignoreTriangles?: ReadonlySet<number>): SceneSphereContact | null {
    if (!finiteVector(from) || !finiteVector(to) || !Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Invalid spherical tool sweep.");
    const lo = from.map((v, a) => Math.min(v, to[a]!) - radiusMm), hi = from.map((v, a) => Math.max(v, to[a]!) + radiusMm);
    let earliest = Infinity, triangle = -1; this.lastTriangles = 0;
    const visit = (node: Node) => {
      if ([0, 1, 2].some(a => node.min[a]! > hi[a]! || node.max[a]! < lo[a]!)) return;
      if (node.left && node.right) { visit(node.left); visit(node.right); return; }
      for (let i = node.start; i < node.end; i++) {
        const t = this.order[i]!; if (ignoreTriangles?.has(t)) continue; this.lastTriangles++;
        const time = triangleSweep(from as ContactVector, to as ContactVector, radiusMm, ...this.triangle(t));
        if (time !== null && time < earliest) { earliest = time; triangle = t; }
      }
    };
    visit(this.root); if (triangle < 0) return null;
    const tipCenterMm = add(from, scale(sub(to, from), earliest));
    const hit = this.hit(triangle, tipCenterMm, unit(sub(from, to)));
    return { ...hit, time: earliest, tipCenterMm, penetrationMm: Math.max(0, radiusMm - hit.distanceMm) };
  }
  /** Current shaft/jaw capsule contact. Its entire segment is tested, not samples. */
  closestCapsule(start: number[], end: number[], radiusMm: number, ignoreTriangles?: ReadonlySet<number>): SceneCapsuleContact | null {
    return this.sweepCapsule(start, end, start, end, radiusMm, ignoreTriangles);
  }
  /** Continuous guard for linearly moving capsule endpoints. Advancement uses
   * the endpoint-speed Lipschitz bound; an iteration cap stops conservatively. */
  sweepCapsule(fromStart: number[], fromEnd: number[], toStart: number[], toEnd: number[], radiusMm: number, ignoreTriangles?: ReadonlySet<number>): SceneCapsuleContact | null {
    if (![fromStart, fromEnd, toStart, toEnd].every(finiteVector) || !Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Invalid capsule sweep.");
    const points = [fromStart, fromEnd, toStart, toEnd];
    const lo = [0, 1, 2].map(a => Math.min(...points.map(p => p[a]!)) - radiusMm);
    const hi = [0, 1, 2].map(a => Math.max(...points.map(p => p[a]!)) + radiusMm);
    const ds = sub(toStart, fromStart), de = sub(toEnd, fromEnd), speed = Math.max(length(ds), length(de));
    let result: SceneCapsuleContact | null = null, earliest = Infinity; this.lastTriangles = 0;
    const visit = (node: Node) => {
      if ([0, 1, 2].some(a => node.min[a]! > hi[a]! || node.max[a]! < lo[a]!)) return;
      if (node.left && node.right) { visit(node.left); visit(node.right); return; }
      for (let i = node.start; i < node.end; i++) {
        const triangleIndex = this.order[i]!; if (ignoreTriangles?.has(triangleIndex)) continue;
        const triangle = this.triangle(triangleIndex); this.lastTriangles++;
        let time = 0;
        for (let iteration = 0; iteration < 64 && time <= Math.min(1, earliest); iteration++) {
          const start = add(fromStart, scale(ds, time)), end = add(fromEnd, scale(de, time));
          const closest = segmentTriangle(start, end, ...triangle), clearance = closest.distance - radiusMm;
          if (time === 0 && clearance <= 1e-5 && speed > 1e-12) {
            // Probe the actual segment distance derivative, including endpoint
            // rotation. Static closestCapsule still reports existing overlap.
            const probeTime = Math.min(1, 1e-3 / speed);
            const probe = segmentTriangle(add(fromStart, scale(ds, probeTime)), add(fromEnd, scale(de, probeTime)), ...triangle);
            if (probe.distance >= closest.distance - 1e-10) {
              // A rotating capsule can separate at one endpoint while its other
              // endpoint approaches later. Cover the full shaft with inflated
              // spheres (spacing <= radius; <=11.9% radial conservatism), whose
              // individual linear sweeps have exact separating-contact rules.
              const span = Math.max(length(sub(fromEnd, fromStart)), length(sub(toEnd, toStart)));
              const divisions = Math.max(1, Math.ceil(span / radiusMm));
              const coverRadius = Math.hypot(radiusMm, span / divisions / 2);
              let guardTime = Infinity;
              for (let sample = 0; sample <= divisions; sample++) {
                const u = sample / divisions;
                const before = add(fromStart, scale(sub(fromEnd, fromStart), u));
                const after = add(toStart, scale(sub(toEnd, toStart), u));
                const hit = triangleSweep(before, after, coverRadius, ...triangle);
                if (hit !== null) guardTime = Math.min(guardTime, hit);
              }
              if (guardTime < earliest) {
                const at = segmentTriangle(add(fromStart, scale(ds, guardTime)), add(fromEnd, scale(de, guardTime)), ...triangle);
                const hit = this.hit(triangleIndex, at.segmentPoint, unit(scale(add(ds, de), -1)));
                earliest = guardTime; result = { ...hit, segmentPointMm: at.segmentPoint, clearanceMm: at.distance - radiusMm, penetrationMm: Math.max(0, radiusMm - at.distance), time: guardTime, conservativeStop: true, iterations: 1 };
              }
              break;
            }
          }
          const contact = clearance <= 1e-5, capped = iteration === 63;
          if (contact || capped) {
            if (time < earliest || (Math.abs(time - earliest) <= 1e-12 && clearance < (result?.clearanceMm ?? Infinity))) {
              const hit = this.hit(triangleIndex, closest.segmentPoint, unit(scale(add(ds, de), -1)));
              earliest = time; result = { ...hit, segmentPointMm: closest.segmentPoint, clearanceMm: clearance, penetrationMm: Math.max(0, -clearance), time, conservativeStop: !contact, iterations: iteration + 1 };
            }
            break;
          }
          if (speed < 1e-12 || time + clearance / speed > 1 + 1e-10) break;
          time += Math.max(1e-12, clearance / speed * .95);
        }
      }
    };
    visit(this.root); return result;
  }
  snapshot() { return { organId: this.organId, triangles: this.order.length, testedTriangles: this.lastTriangles, refits: this.refits, method: "two-sided-triangle-BVH-continuous-sphere" }; }
}
