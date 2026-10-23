import type { VesselVector } from "../experiments/vesselSolver";
import type { LiverAnatomy } from "./types";
import { runoffAttachedGeometry, RunoffUnsupportedSupportError, type RunoffSupportAnchor } from "./runoff";

type Vec = [number, number, number];
type Face = { source: number; a: Vec; b: Vec; c: Vec; normal: Vec; inset: [Vec, Vec, Vec];
  uu: number; uv: number; vv: number; denominator: number };
export interface RunoffSupportResolver {
  (positionM: VesselVector): RunoffSupportAnchor;
  readonly sourceFaceCount: number;
  readonly eligibleFaceCount: number;
  readonly contactRadiusM: number;
}
const sub = (a: VesselVector, b: VesselVector): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: VesselVector, b: VesselVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: VesselVector, b: VesselVector): Vec =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a: VesselVector, b: VesselVector, t: number): Vec => [a[0] + t * b[0], a[1] + t * b[1], a[2] + t * b[2]];
const finite = (v: VesselVector) => v.length === 3 && v.every(Number.isFinite);
function barycentric(a: Vec, b: Vec, c: Vec, point: VesselVector): Vec {
  const u = sub(b, a), v = sub(c, a), p = sub(point, a), uu = dot(u, u), uv = dot(u, v), vv = dot(v, v);
  const normal = cross(u, v), denominator = dot(normal, normal);
  const y = (vv * dot(p, u) - uv * dot(p, v)) / denominator;
  const z = (uu * dot(p, v) - uv * dot(p, u)) / denominator;
  return [1 - y - z, y, z];
}
function canonical(face: Face, point: Vec, refined: boolean) {
  const p = sub(point, face.a), u = sub(face.b, face.a), v = sub(face.c, face.a);
  const b = (face.vv * dot(p, u) - face.uv * dot(p, v)) / face.denominator;
  const c = (face.uu * dot(p, v) - face.uv * dot(p, u)) / face.denominator;
  const clean = [1 - b - c, b, c].map(value => Math.max(0, Math.min(1, value)));
  const total = clean[0]! + clean[1]! + clean[2]!;
  const [x, y, z] = clean.map(value => value / total) as Vec;
  if (!refined) return { triangle: face.source, barycentric: [x, y, z] as Vec };
  // Same source geometry and world point; only the canonical face address
  // changes under the existing uniform midpoint refinement.
  if (x >= .5) return { triangle: 4 * face.source, barycentric: [2 * x - 1, 2 * y, 2 * z] as Vec };
  if (y >= .5) return { triangle: 4 * face.source + 1, barycentric: [2 * y - 1, 2 * z, 2 * x] as Vec };
  if (z >= .5) return { triangle: 4 * face.source + 2, barycentric: [2 * z - 1, 2 * x, 2 * y] as Vec };
  return { triangle: 4 * face.source + 3, barycentric: [1 - 2 * z, 1 - 2 * x, 1 - 2 * y] as Vec };
}

/** Nearest circular support lying entirely in one original planar source face.
 *
 * For inradius r and incenter I, offsetting each edge inward by a produces the
 * triangle I+(1-a/r)(P-I). Thus every returned centre has edge clearance >=a.
 * Candidates and tie order are based on original source faces, never solver
 * vertices, so conforming midpoint refinement cannot move physical supports.
 * This certifies the flat circular footprint only. The caller must still
 * check the full attached volume against all retained tissue and the tray.
 */
function compileSourceFaces(
  anatomy: Pick<LiverAnatomy, "surface" | "refinement">,
  contactRadiusM: number, gravityMS2: VesselVector,
) {
  if (!Number.isFinite(contactRadiusM) || contactRadiusM <= 0 || contactRadiusM > .02
    || !finite(gravityMS2) || Math.hypot(...gravityMS2) === 0)
    throw new RangeError("Runoff support requires a positive physical radius and finite nonzero gravity");
  const { surface, refinement } = anatomy, positions = surface.positionsM, indices = surface.indices;
  const refined = !!refinement, count = positions.length / 3;
  const sourceFaceCount = refinement?.baseTriangleCount ?? indices.length / 3;
  if (!Number.isInteger(count) || count < 3 || !Number.isInteger(sourceFaceCount) || sourceFaceCount < 1
    || sourceFaceCount > 200_000 || !positions.every(Number.isFinite)
    || indices.length !== sourceFaceCount * (refined ? 12 : 3)
    || refinement && (refinement.level !== 1 || refinement.baseVertexCount > count
      || refinement.parentTriangles.length !== sourceFaceCount * 4))
    throw new RangeError("Invalid original source-face geometry for runoff support");
  const at = (index: number): Vec => {
    if (index >= count) throw new RangeError("Runoff source-face index is out of bounds");
    return [positions[3 * index]!, positions[3 * index + 1]!, positions[3 * index + 2]!];
  };
  const faces: Face[] = [];
  for (let t = 0; t < sourceFaceCount; t++) {
    const base = t * (refined ? 12 : 3);
    const ids = refined ? [indices[base]!, indices[base + 3]!, indices[base + 6]!]
      : [indices[base]!, indices[base + 1]!, indices[base + 2]!];
    const [a, b, c] = ids.map(at) as [Vec, Vec, Vec];
    if (refinement) {
      if (ids.some(id => id >= refinement.baseVertexCount)
        || [0, 1, 2, 3].some(k => refinement.parentTriangles[4 * t + k] !== t))
        throw new RangeError("Runoff source-face provenance does not match midpoint children");
      const ab = indices[base + 1]!, ca = indices[base + 2]!, bc = indices[base + 4]!;
      const expected = [ids[0]!, ab, ca, ids[1]!, bc, ab, ids[2]!, ca, bc, ab, bc, ca];
      if (expected.some((id, k) => indices[base + k] !== id))
        throw new RangeError("Runoff support requires the preserved original midpoint topology");
      for (const [id, first, second] of [[ab, a, b], [bc, b, c], [ca, c, a]] as const) {
        const midpoint = at(id);
        if (midpoint.some((value, k) => value !== (first[k]! + second[k]!) * .5))
          throw new RangeError("Runoff midpoint geometry no longer preserves its source face");
      }
    }
    const u = sub(b, a), v = sub(c, a), n = cross(u, v), twiceArea = Math.hypot(...n);
    if (!(twiceArea > 0)) throw new RangeError("Degenerate original runoff source face");
    const normal = n.map(value => value / twiceArea) as Vec;
    if (dot(normal, gravityMS2) <= 0) continue;
    const oppositeA = Math.hypot(...sub(c, b)), oppositeB = Math.hypot(...sub(a, c)), oppositeC = Math.hypot(...sub(b, a));
    const perimeter = oppositeA + oppositeB + oppositeC, inradius = twiceArea / perimeter;
    if (inradius < contactRadiusM) continue;
    const center = [0, 1, 2].map(k => (oppositeA * a[k]! + oppositeB * b[k]! + oppositeC * c[k]!) / perimeter) as Vec;
    const scale = 1 - contactRadiusM / inradius;
    const inset = [a, b, c].map(point => add(center, sub(point, center), scale)) as [Vec, Vec, Vec];
    faces.push({ source: t, a, b, c, normal, inset, uu: dot(u, u), uv: dot(u, v), vv: dot(v, v), denominator: dot(n, n) });
  }
  if (!faces.length) throw new RangeError("No outward-gravity original face can contain the physical runoff contact disk");
  return { faces, sourceFaceCount, refined };
}

function closestOnFace(face: Face, point: VesselVector): Vec {
  const [a, b, c] = face.inset;
  const projected = add(point, face.normal, -dot(sub(point, a), face.normal));
  const insetNormal = cross(sub(b, a), sub(c, a));
  if (dot(insetNormal, insetNormal) > 0 && barycentric(a, b, c, projected).every(weight => weight >= 0))
    return projected;
  let selected = a, distance = Infinity;
  for (let edge = 0; edge < 3; edge++) {
    const p = face.inset[edge]!, q = face.inset[(edge + 1) % 3]!, e = sub(q, p), lengthSquared = dot(e, e);
    const candidate = lengthSquared > 0 ? add(p, e, Math.max(0, Math.min(1, dot(sub(point, p), e) / lengthSquared))) : p;
    const delta = sub(candidate, point), d = dot(delta, delta);
    if (d < distance) { distance = d; selected = candidate; }
  }
  return selected;
}

export function createRunoffSupportResolver(
  anatomy: Pick<LiverAnatomy, "surface" | "refinement">,
  contactRadiusM: number, gravityMS2: VesselVector,
): RunoffSupportResolver {
  const { faces, sourceFaceCount, refined } = compileSourceFaces(anatomy, contactRadiusM, gravityMS2);
  const resolve = (point: VesselVector): RunoffSupportAnchor => {
    if (!finite(point)) throw new RangeError("Runoff support query must be finite");
    let chosen: Face | undefined, selected: Vec | undefined, distance = Infinity;
    for (const face of faces) {
      const candidate = closestOnFace(face, point), offset = sub(candidate, point), d = dot(offset, offset);
      const tolerance = 64 * Number.EPSILON * Math.max(d, Number.isFinite(distance) ? distance : 0, contactRadiusM ** 2);
      if (!chosen || d < distance - tolerance) {
        chosen = face; selected = candidate; distance = d;
      }
    }
    if (!chosen || !selected || !Number.isFinite(distance)) throw new RangeError("No finite runoff support projection");
    return { positionM: [...selected], normal: [...chosen.normal], surface: canonical(chosen, selected, refined) };
  };
  return Object.freeze(Object.assign(resolve, { sourceFaceCount, eligibleFaceCount: faces.length, contactRadiusM }));
}

export interface PackedRunoffSupportOptions {
  contactRadiusM: number;
  gravityMS2: VesselVector;
  supportSpacingM: number;
  gridOriginM: VesselVector;
  criticalVolumeM3: number;
  neckLengthM: number;
}
export interface PackedRunoffSupport extends RunoffSupportAnchor { supportId: string; }
export interface PackedRunoffSupportResolver extends RunoffSupportResolver {
  (positionM: VesselVector): PackedRunoffSupport;
  readonly supports: readonly PackedRunoffSupport[];
  readonly candidateCellCount: number;
  readonly supportedCellCount: number;
  readonly unsupportedCellCount: number;
}
type Sphere = { centre: Vec; radius: number };
type Envelope = { spheres: Sphere[]; neck: { a: Vec; b: Vec; radius: number } };
type Candidate = { index: Vec; key: string; centre: Vec; face: Face; position: Vec; distanceSquared: number };
type SourceGeometry = Pick<LiverAnatomy, "surface" | "refinement">;
type PackedCacheEntry = {
  key: string; positions: Float64Array; indices: Uint32Array;
  parents: Uint32Array | undefined; baseVertices: number | undefined; baseTriangles: number | undefined;
  level: number | undefined; resolver: PackedRunoffSupportResolver;
};
const packedCache = new WeakMap<SourceGeometry["surface"], PackedCacheEntry[]>();
const equalArray = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

function pointSegmentSquared(point: Vec, a: Vec, b: Vec) {
  const u = sub(b, a), d = dot(u, u);
  const t = d > 0 ? Math.max(0, Math.min(1, dot(sub(point, a), u) / d)) : 0;
  const v = sub(point, add(a, u, t)); return dot(v, v);
}
function segmentSquared(a: Vec, b: Vec, c: Vec, d: Vec) {
  let result = Math.min(pointSegmentSquared(a, c, d), pointSegmentSquared(b, c, d),
    pointSegmentSquared(c, a, b), pointSegmentSquared(d, a, b));
  const u = sub(b, a), v = sub(d, c), w = sub(a, c), uu = dot(u, u), vv = dot(v, v), uv = dot(u, v);
  const denominator = uu * vv - uv * uv;
  if (denominator > 64 * Number.EPSILON * uu * vv) {
    const uw = dot(u, w), vw = dot(v, w), s = (uv * vw - vv * uw) / denominator,
      t = (uu * vw - uv * uw) / denominator;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
      const offset = sub(add(a, u, s), add(c, v, t)); result = Math.min(result, dot(offset, offset));
    }
  }
  return result;
}
function envelope(anchor: Vec, normal: Vec, options: PackedRunoffSupportOptions): Envelope {
  const shape = runoffAttachedGeometry(anchor, normal, options.criticalVolumeM3,
    options.contactRadiusM, options.neckLengthM);
  const h = shape.capHeightM, a = options.contactRadiusM;
  const spheres: Sphere[] = [];
  if (h > 0) {
    const radius = (h * h + a * a) / (2 * h);
    spheres.push({ centre: add(anchor, normal, shape.neckLengthM + h - radius), radius });
  }
  spheres.push({ centre: [...shape.centreOfMassM], radius: Math.cbrt(3 * options.criticalVolumeM3 / (4 * Math.PI)) });
  return { spheres, neck: { a: [...anchor], b: add(anchor, normal, shape.neckLengthM), radius: a } };
}
function separated(a: Envelope, b: Envelope) {
  // A positive metric margin prevents float-roundoff from certifying touching
  // envelopes as separated. It does not move or resize any physical shape.
  const margin = 1e-10;
  for (const x of a.spheres) for (const y of b.spheres)
    if (Math.hypot(...sub(x.centre, y.centre)) < x.radius + y.radius + margin) return false;
  for (const [spheres, neck] of [[a.spheres, b.neck], [b.spheres, a.neck]] as const)
    for (const sphere of spheres)
      if (pointSegmentSquared(sphere.centre, neck.a, neck.b) < (sphere.radius + neck.radius + margin) ** 2) return false;
  return segmentSquared(a.neck.a, a.neck.b, b.neck.a, b.neck.b) >= (a.neck.radius + b.neck.radius + margin) ** 2;
}

/** An authored, immutable pinning map constructed before any blood arrives.
 * Greedy order is the fixed physical grid's numeric (x,y,z) order. All cells
 * are assigned before accumulation, so input event order cannot choose a pose.
 * Critical cap parent spheres contain every smaller cap (same contact circle);
 * a capsule bounds every finite neck, and the release sphere is also included.
 * Disjoint envelopes therefore certify all attached fill fractions and release
 * shapes at birth. This does NOT claim collision-free later ballistic flight.
 *
 * Unsupported cells stay unsupported: neither locality nor normal bounds are
 * relaxed to fill a gap in this reduced pinning model.
 */
export function createPackedRunoffSupportResolver(
  anatomy: SourceGeometry, options: PackedRunoffSupportOptions,
): PackedRunoffSupportResolver {
  const { contactRadiusM, gravityMS2, supportSpacingM: spacing,
    criticalVolumeM3, neckLengthM } = options;
  const origin = [...options.gridOriginM] as Vec;
  if (![spacing, criticalVolumeM3, neckLengthM].every(Number.isFinite) || !finite(origin)
    || spacing < 2 * contactRadiusM || spacing > .02 || criticalVolumeM3 <= 0
    || neckLengthM < 0 || neckLengthM > 4 * contactRadiusM)
    throw new RangeError("Invalid packed runoff support parameters");
  const key = JSON.stringify([contactRadiusM, ...gravityMS2, spacing, ...origin, criticalVolumeM3, neckLengthM]);
  const entries = packedCache.get(anatomy.surface) ?? [];
  const match = entries.find(entry => entry.key === key
    && entry.baseVertices === anatomy.refinement?.baseVertexCount
    && entry.baseTriangles === anatomy.refinement?.baseTriangleCount && entry.level === anatomy.refinement?.level
    && equalArray(entry.positions, anatomy.surface.positionsM) && equalArray(entry.indices, anatomy.surface.indices)
    && (entry.parents ? anatomy.refinement !== undefined && equalArray(entry.parents, anatomy.refinement.parentTriangles)
      : anatomy.refinement === undefined));
  // Exact source-array comparison makes reset reuse safe even if a caller has
  // mutated an anatomy object since the previous build. No probabilistic hash
  // identity or cached mutable world coordinates are used.
  if (match) return match.resolver;
  const { faces, sourceFaceCount, refined } = compileSourceFaces(anatomy, contactRadiusM, gravityMS2);
  const cells = new Map<string, Candidate>();
  let evaluations = 0;
  for (const face of faces) {
    const lo = [0, 1, 2].map(k => Math.ceil((Math.min(...face.inset.map(p => p[k]!)) - spacing - origin[k]!) / spacing - .5));
    const hi = [0, 1, 2].map(k => Math.floor((Math.max(...face.inset.map(p => p[k]!)) + spacing - origin[k]!) / spacing - .5));
    for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
      if (++evaluations > 5_000_000) throw new RangeError("Packed runoff source grid exceeds its construction budget");
      const index: Vec = [x, y, z], key = index.join(",");
      const centre = index.map((v, k) => origin[k]! + (v + .5) * spacing) as Vec;
      const position = closestOnFace(face, centre), delta = sub(position, centre), distanceSquared = dot(delta, delta);
      if (distanceSquared > spacing * spacing) continue;
      const current = cells.get(key);
      const tolerance = 64 * Number.EPSILON * Math.max(distanceSquared, current?.distanceSquared ?? 0, contactRadiusM ** 2);
      if (!current || distanceSquared < current.distanceSquared - tolerance)
        cells.set(key, { index, key, centre, face, position, distanceSquared });
      if (cells.size > 200_000) throw new RangeError("Packed runoff source cells exceed their construction budget");
    }
  }
  const candidates = [...cells.values()].sort((a, b) =>
    a.index[0] - b.index[0] || a.index[1] - b.index[1] || a.index[2] - b.index[2]);
  const bound = envelope([0, 0, 0], [0, 1, 0], options);
  const reach = Math.max(contactRadiusM + neckLengthM,
    ...bound.spheres.map(s => Math.hypot(...s.centre) + s.radius));
  if (!Number.isFinite(reach) || reach <= 0) throw new RangeError("Invalid packed runoff shape envelope");
  const bucketSize = 2 * reach + 1e-9;
  const bucketKey = (p: Vec) => p.map(v => Math.floor(v / bucketSize)) as Vec;
  const buckets = new Map<string, number[]>(), packed: { anchor: PackedRunoffSupport; envelope: Envelope }[] = [];
  for (const candidate of candidates) {
    const shape = envelope(candidate.position, candidate.face.normal, options), bucket = bucketKey(candidate.position);
    let clear = true;
    for (let dx = -1; dx <= 1 && clear; dx++) for (let dy = -1; dy <= 1 && clear; dy++) for (let dz = -1; dz <= 1 && clear; dz++)
      for (const id of buckets.get([bucket[0] + dx, bucket[1] + dy, bucket[2] + dz].join(",")) ?? [])
        if (!separated(shape, packed[id]!.envelope)) { clear = false; break; }
    if (!clear) continue;
    const anchor: PackedRunoffSupport = { supportId: `pinning:${candidate.key}`, positionM: [...candidate.position],
      normal: [...candidate.face.normal], surface: canonical(candidate.face, candidate.position, refined) };
    const id = packed.length; packed.push({ anchor, envelope: shape });
    const key = bucket.join(","), ids = buckets.get(key) ?? [];
    ids.push(id); buckets.set(key, ids);
  }
  const mapped = new Map<string, PackedRunoffSupport>();
  for (const candidate of candidates) {
    let closest: PackedRunoffSupport | undefined, distance = Infinity;
    for (const { anchor } of packed) {
      if (dot(anchor.normal, candidate.face.normal) < .8) continue;
      const delta = sub(anchor.positionM, candidate.centre), d = dot(delta, delta);
      if (d <= spacing * spacing && d < distance) { distance = d; closest = anchor; }
    }
    if (closest) mapped.set(candidate.key, closest);
  }
  const copyAnchor = (anchor: PackedRunoffSupport): PackedRunoffSupport => ({
    ...anchor, positionM: [...anchor.positionM], normal: [...anchor.normal],
    ...(anchor.surface ? { surface: { triangle: anchor.surface.triangle, barycentric: [...anchor.surface.barycentric] } } : {}),
  });
  const supports = packed.map(({ anchor }) => {
    const copy = copyAnchor(anchor);
    Object.freeze(copy.positionM); Object.freeze(copy.normal);
    if (copy.surface) { Object.freeze(copy.surface.barycentric); Object.freeze(copy.surface); }
    return Object.freeze(copy);
  });
  const resolve = (point: VesselVector): PackedRunoffSupport => {
    if (!finite(point)) throw new RangeError("Packed runoff support query must be finite");
    const index = point.map((value, k) => Math.floor((value - origin[k]!) / spacing)) as Vec;
    const centre = index.map((value, k) => origin[k]! + (value + .5) * spacing) as Vec;
    if (Math.hypot(...sub(point, centre)) > spacing * 1e-10)
      throw new RangeError("Packed runoff support requires the fixed source-cell centre");
    const anchor = mapped.get(index.join(","));
    if (!anchor) throw new RunoffUnsupportedSupportError(`No nonoverlapping local runoff support covers source cell ${index.join(",")}`);
    return copyAnchor(anchor);
  };
  const resolver = Object.freeze(Object.assign(resolve, { supports: Object.freeze(supports), sourceFaceCount,
    eligibleFaceCount: faces.length, contactRadiusM, candidateCellCount: candidates.length,
    supportedCellCount: mapped.size, unsupportedCellCount: candidates.length - mapped.size }));
  entries.push({ key, positions: anatomy.surface.positionsM.slice(), indices: anatomy.surface.indices.slice(),
    parents: anatomy.refinement?.parentTriangles.slice(), baseVertices: anatomy.refinement?.baseVertexCount,
    baseTriangles: anatomy.refinement?.baseTriangleCount, level: anatomy.refinement?.level, resolver });
  // Bounded cache per living anatomy; old source objects are garbage collectable.
  packedCache.set(anatomy.surface, entries.slice(-2));
  return resolver;
}
