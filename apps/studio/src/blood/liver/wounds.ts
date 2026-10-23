import type { LiverAnatomy, LiverCutGeometry, LiverCutRequest, LiverCutResult, LiverSurface, LiverSurfacePick, LiverVec3, LiverVesselSegment, LiverWound } from "./types";

export const LIVER_PUNCH_SIDES = 32;
export const LIVER_MAX_WOUNDS = 3;
type V = LiverVec3;
type Vertex = { p: V; b: V };
type Piece = { vertices: Vertex[]; triangle: number };
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V) => Math.hypot(...a);
const unit = (a: V): V => mul(a, 1 / norm(a));
const read = (a: ArrayLike<number>, i: number): V => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
const valid3 = (a: ArrayLike<number>) => a.length === 3 && [a[0], a[1], a[2]].every(n => typeof n === "number" && Number.isFinite(n));
const EPS = 1e-13;
function basis(n: V): [V, V] { const u = unit(cross(n, Math.abs(n[1]) < .8 ? [0, 1, 0] : [1, 0, 0])); return [u, cross(n, u)]; }
function area(vertices: Vertex[]): number {
  let total = 0; for (let i = 1; i + 1 < vertices.length; i++) total += norm(cross(sub(vertices[i]!.p, vertices[0]!.p), sub(vertices[i + 1]!.p, vertices[0]!.p))) * .5; return total;
}
function interpolate(a: Vertex, b: Vertex, t: number): Vertex { return { p: add(a.p, mul(sub(b.p, a.p), t)), b: add(a.b, mul(sub(b.b, a.b), t)) }; }
function clip(poly: Vertex[], n: V, c: V, limit: number, inside: boolean): Vertex[] {
  const result: Vertex[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!, da = dot(sub(a.p, c), n) - limit, db = dot(sub(b.p, c), n) - limit;
    const aIn = inside ? da <= 0 : da >= 0, bIn = inside ? db <= 0 : db >= 0;
    if (aIn) result.push(a);
    if (aIn !== bIn) result.push(interpolate(a, b, Math.max(0, Math.min(1, da / (da - db)))));
  }
  return result.filter((v, i) => norm(sub(v.p, result[(i + result.length - 1) % result.length]!.p)) > EPS);
}
function sourcePieces(surface: LiverSurface): Piece[] {
  const result: Piece[] = [];
  for (let t = 0; t < surface.indices.length / 3; t++) result.push({ triangle: t, vertices: [0, 1, 2].map(j => ({ p: read(surface.positionsM, surface.indices[t * 3 + j]!), b: [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0] })) });
  return result;
}
function planes(wound: LiverCutRequest): V[] {
  const [u, v] = basis(wound.pick.normal);
  return Array.from({ length: LIVER_PUNCH_SIDES }, (_, i) => add(mul(u, Math.cos((i + .5) * 2 * Math.PI / LIVER_PUNCH_SIDES)), mul(v, Math.sin((i + .5) * 2 * Math.PI / LIVER_PUNCH_SIDES))));
}
/** Subtract an inscribed regular polygon extruded along the local punch axis.
 * Every retained vertex retains exact barycentric provenance on its source face. */
function subtractPunch(pieces: Piece[], wound: LiverCutRequest): { retained: Piece[]; removed: Piece[]; planeNormals: V[] } {
  const retained: Piece[] = [], removed: Piece[] = [], planeNormals = planes(wound), limit = wound.radiusM * Math.cos(Math.PI / LIVER_PUNCH_SIDES);
  for (const piece of pieces) {
    const p = piece.vertices, n = cross(sub(p[1]!.p, p[0]!.p), sub(p[2]!.p, p[0]!.p));
    // One local, front-facing surface sheet. A second/backside capsule cannot be punched through accidentally.
    if (dot(unit(n), wound.pick.normal) < .35) { retained.push(piece); continue; }
    const ds = p.map(v => dot(sub(v.p, wound.pick.positionM), wound.pick.normal));
    if (Math.min(...ds) > wound.radiusM || Math.max(...ds) < -wound.radiusM) { retained.push(piece); continue; }
    let interior = p;
    for (const side of planeNormals) { interior = clip(interior, side, wound.pick.positionM, limit, true); if (interior.length < 3) break; }
    if (interior.length < 3 || area(interior) < 1e-20) { retained.push(piece); continue; }
    removed.push({ triangle: piece.triangle, vertices: interior });
    let remaining = p;
    for (const side of planeNormals) {
      const outside = clip(remaining, side, wound.pick.positionM, limit, false);
      if (outside.length >= 3 && area(outside) > 1e-20) retained.push({ triangle: piece.triangle, vertices: outside });
      remaining = clip(remaining, side, wound.pick.positionM, limit, true);
      if (remaining.length < 3) break;
    }
  }
  return { retained, removed, planeNormals };
}
/** Split shared polygon edges at every introduced point before triangulation.
 * Convex half-plane subtraction alone creates coincident T-junctions. Candidate
 * points are propagated across canonical mesh edges, so untouched neighbours
 * also conform. A centroid fan preserves collinear boundary subdivisions. */
function conformPieces(pieces: Piece[], removed: Piece[], source: LiverSurface): Piece[] {
  const candidates = new Map<number, V[]>(), edgePoints = new Map<string, V[]>();
  const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const collect = (piece: Piece) => {
    for (const v of piece.vertices) {
      // Original corners are already shared; only introduced positions matter.
      if (v.b.some(w => w > 1 - 1e-12)) continue;
      const values = candidates.get(piece.triangle) ?? []; values.push(v.p); candidates.set(piece.triangle, values);
      for (let k = 0; k < 3; k++) if (Math.abs(v.b[k]!) < 1e-10) {
        const a = source.indices[piece.triangle * 3 + (k + 1) % 3]!, b = source.indices[piece.triangle * 3 + (k + 2) % 3]!;
        const key = edgeKey(a, b), points = edgePoints.get(key) ?? []; points.push(v.p); edgePoints.set(key, points);
      }
    }
  };
  pieces.forEach(collect); removed.forEach(collect);
  for (let t = 0; t < source.indices.length / 3; t++) for (let k = 0; k < 3; k++) {
    const key = edgeKey(source.indices[t * 3 + k]!, source.indices[t * 3 + (k + 1) % 3]!), points = edgePoints.get(key);
    if (points) { const values = candidates.get(t) ?? []; values.push(...points); candidates.set(t, values); }
  }
  const result: Piece[] = [];
  for (const piece of pieces) {
    const points = candidates.get(piece.triangle);
    if (!points?.length && piece.vertices.length === 3) { result.push(piece); continue; }
    const boundary: Vertex[] = [];
    for (let i = 0; i < piece.vertices.length; i++) {
      const a = piece.vertices[i]!, b = piece.vertices[(i + 1) % piece.vertices.length]!, edge = sub(b.p, a.p), length2 = dot(edge, edge), cuts: number[] = [0];
      for (const p of points ?? []) {
        const t = dot(sub(p, a.p), edge) / length2;
        if (t > 1e-10 && t < 1 - 1e-10 && norm(sub(p, add(a.p, mul(edge, t)))) < 1e-11) cuts.push(t);
      }
      cuts.sort((a, b) => a - b);
      for (let j = 0; j < cuts.length; j++) if (!j || Math.abs(cuts[j]! - cuts[j - 1]!) * Math.sqrt(length2) > 1e-11) boundary.push(interpolate(a, b, cuts[j]!));
    }
    if (boundary.length === 3) { result.push({ triangle: piece.triangle, vertices: boundary }); continue; }
    const center: Vertex = { p: [0, 0, 0], b: [0, 0, 0] };
    for (const v of boundary) { center.p = add(center.p, mul(v.p, 1 / boundary.length)); center.b = add(center.b, mul(v.b, 1 / boundary.length)); }
    for (let i = 0; i < boundary.length; i++) result.push({ triangle: piece.triangle, vertices: [center, boundary[i]!, boundary[(i + 1) % boundary.length]!] });
  }
  return result;
}
function canonicalPick(anatomy: LiverAnatomy, pick: LiverSurfacePick): LiverSurfacePick | null {
  const s = anatomy.surface;
  if (!Number.isSafeInteger(pick.triangle) || pick.triangle < 0 || pick.triangle >= s.indices.length / 3 || !valid3(pick.positionM) || !valid3(pick.normal) || !valid3(pick.barycentric) || pick.barycentric.some(w => w < -1e-8 || w > 1 + 1e-8) || Math.abs(pick.barycentric.reduce((a, b) => a + b, 0) - 1) > 1e-8) return null;
  const b = pick.barycentric.map(w => Math.max(0, Math.min(1, w))) as V, total = b.reduce((a, v) => a + v, 0);
  for (let k = 0; k < 3; k++) b[k] = b[k]! / total;
  const p: V = [0, 0, 0], n: V = [0, 0, 0];
  for (let j = 0; j < 3; j++) { const id = s.indices[pick.triangle * 3 + j]!; for (let k = 0; k < 3; k++) { p[k] = p[k]! + s.positionsM[id * 3 + k]! * b[j]!; n[k] = n[k]! + s.normals[id * 3 + k]! * b[j]!; } }
  if (norm(sub(p, pick.positionM)) > 1e-7 || !Number.isFinite(norm(n)) || norm(n) < .1 || norm(pick.normal) < .9 || norm(pick.normal) > 1.1 || dot(unit(n), unit(pick.normal)) < .98) return null;
  return { triangle: pick.triangle, positionM: p, normal: unit(n), barycentric: b };
}
/** A geometrical floor must remain inside the local tissue sheet. Ray probes
 * at every clipped footprint vertex and face centroid reject a second capsule
 * intersection before the prescribed depth; no watertight-volume claim is made. */
function crossesAnotherSurface(surface: LiverSurface, removed: Piece[], wound: LiverCutRequest): boolean {
  const rays = removed.flatMap(piece => [...piece.vertices.map(v => v.p), mul(piece.vertices.reduce((a, v) => add(a, v.p), [0, 0, 0] as V), 1 / piece.vertices.length)]);
  const direction = mul(wound.pick.normal, -1), extent = wound.radiusM + wound.depthM;
  for (let t = 0; t < surface.indices.length / 3; t++) {
    const a = read(surface.positionsM, surface.indices[t * 3]!), b = read(surface.positionsM, surface.indices[t * 3 + 1]!), c = read(surface.positionsM, surface.indices[t * 3 + 2]!);
    if ([0, 1, 2].some(k => Math.min(a[k]!, b[k]!, c[k]!) > wound.pick.positionM[k]! + extent || Math.max(a[k]!, b[k]!, c[k]!) < wound.pick.positionM[k]! - extent)) continue;
    const e1 = sub(b, a), e2 = sub(c, a), h = cross(direction, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-16) continue;
    for (const origin of rays) {
      const s = sub(origin, a), u = dot(s, h) / det; if (u < -1e-8 || u > 1 + 1e-8) continue;
      const q = cross(s, e1), v = dot(direction, q) / det; if (v < -1e-8 || u + v > 1 + 1e-8) continue;
      const distance = dot(e2, q) / det;
      if (distance > 1e-8 && distance <= wound.depthM + 1e-9) return true;
    }
  }
  return false;
}
function cylinderDistance(point: V, wound: LiverCutRequest): number {
  const d = sub(point, wound.pick.positionM), z = -dot(d, wound.pick.normal), radial = norm(add(d, mul(wound.pick.normal, z)));
  return Math.hypot(Math.max(0, radial - wound.radiusM), Math.max(0, -z, z - wound.depthM));
}
/** Convex capsule/capped-cylinder distance minimization. A finite vessel tube,
 * not the visible pigmentation halo, must intersect the removed tissue. */
export function interceptedRadius(segment: LiverVesselSegment, wound: LiverCutRequest): number {
  if (![...segment.aM, ...segment.bM, segment.radiusAM, segment.radiusBM].every(Number.isFinite) || segment.radiusAM <= 0 || segment.radiusBM <= 0 || dot(segment.normal, wound.pick.normal) < .35) return 0;
  const value = (t: number) => cylinderDistance(add(segment.aM, mul(sub(segment.bM, segment.aM), t)), wound) - (segment.radiusAM * (1 - t) + segment.radiusBM * t);
  let lo = 0, hi = 1;
  // Distance to a convex body minus an affine radius is convex along the segment.
  for (let i = 0; i < 56; i++) { const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3; if (value(a) < value(b)) hi = b; else lo = a; }
  const t = (lo + hi) * .5, candidates = [0, t, 1].sort((a, b) => value(a) - value(b)), best = candidates[0]!, penetration = -value(best);
  if (!(penetration > 1e-10)) return 0; // A tangency has zero exposed cross-section.
  const r = segment.radiusAM * (1 - best) + segment.radiusBM * best;
  // Explicit aperture approximation for partial tube exposure, bounded by actual calibre and punch radius.
  const d = Math.max(0, r - penetration);
  return Math.min(wound.radiusM, Math.sqrt(Math.max(0, r * r - d * d)));
}
export function prepareLiverCut(anatomy: LiverAnatomy, existingWounds: readonly LiverWound[], request: LiverCutRequest): LiverCutResult {
  const invalid = (reason: string): LiverCutResult => ({ accepted: false, outcome: "invalid", reason });
  if (!request || !request.pick || !Number.isFinite(request.radiusM) || request.radiusM < .00075 || request.radiusM > .002 || !Number.isFinite(request.depthM) || request.depthM < .00025 || request.depthM > .002 || !Number.isFinite(request.timeSeconds) || request.timeSeconds < 0) return invalid("Choose a 0.75–2 mm radius and 0.25–2 mm depth.");
  const pick = canonicalPick(anatomy, request.pick); if (!pick) return invalid("The cut must be anchored to the current capsule triangle.");
  const candidate = { ...request, pick };
  if (existingWounds.some(w => norm(sub(w.pick.positionM, pick.positionM)) <= w.radiusM + request.radiusM + 1e-7)) return { accepted: false, outcome: "duplicate", reason: "This punch overlaps an existing wound." };
  if (existingWounds.length >= LIVER_MAX_WOUNDS) return invalid("This experiment supports at most three nonoverlapping punches.");
  const split = subtractPunch(sourcePieces(anatomy.surface), candidate);
  let projectedArea = 0;
  for (const p of split.removed) {
    const n = unit(cross(sub(p.vertices[1]!.p, p.vertices[0]!.p), sub(p.vertices[2]!.p, p.vertices[0]!.p)));
    projectedArea += area(p.vertices) * dot(n, pick.normal);
    if (p.vertices.some(v => Math.abs(dot(sub(v.p, pick.positionM), pick.normal)) > Math.min(request.radiusM * .65, request.depthM * .75))) return invalid("The local surface curvature exceeds this punch's supported depth.");
  }
  const expected = .5 * LIVER_PUNCH_SIDES * Math.sin(2 * Math.PI / LIVER_PUNCH_SIDES) * request.radiusM ** 2;
  if (Math.abs(projectedArea - expected) > expected * 1e-5) return invalid("The punch reaches an open boundary or an overlapping surface sheet; choose an interior capsule site.");
  if (crossesAnotherSurface(anatomy.surface, split.removed, candidate)) return invalid("The punch reaches another capsule sheet before its requested floor depth.");
  let vesselId: string | null = null, apertureRadiusM = 0;
  for (const segment of anatomy.vessels) { const r = interceptedRadius(segment, candidate); if (r > apertureRadiusM) { vesselId = segment.id; apertureRadiusM = r; } }
  const wound: LiverWound = { ...candidate, id: `liver-wound-${existingWounds.length + 1}`, vesselId, apertureRadiusM };
  return { accepted: true, outcome: vesselId ? "vessel-hit" : "tissue-only", wound };
}

/** Actual retained capsule plus independently shaded cut walls and bottom.
 * The polygonal punch removes source triangles by clipping, not transparency.
 * Bottom follows the removed surface translated by the stated depth; this is a
 * bounded geometric punch, not a volumetric tissue fracture/deformation model. */
export function buildLiverCutGeometry(anatomy: LiverAnatomy, wounds: readonly LiverWound[]): LiverCutGeometry {
  if (wounds.length > LIVER_MAX_WOUNDS) throw new RangeError("At most three liver punches are supported.");
  let pieces = sourcePieces(anatomy.surface), removedAreaM2 = 0;
  const removedPieces: Piece[] = [];
  const cavityPositions: number[] = [], cavityNormals: number[] = [];
  const appendCavity = (a: V, b: V, c: V) => {
    const normal = cross(sub(b, a), sub(c, a)); if (norm(normal) < 1e-18) return;
    const n = unit(normal); cavityPositions.push(...a, ...b, ...c); cavityNormals.push(...n, ...n, ...n);
  };
  for (let i = 0; i < wounds.length; i++) {
    const w = wounds[i]!;
    if (!canonicalPick(anatomy, w.pick) || !Number.isFinite(w.radiusM) || w.radiusM < .00075 || w.radiusM > .002 || !Number.isFinite(w.depthM) || w.depthM < .00025 || w.depthM > .002 || wounds.slice(0, i).some(other => norm(sub(other.pick.positionM, w.pick.positionM)) <= other.radiusM + w.radiusM + 1e-7)) throw new RangeError("Invalid or overlapping liver punch geometry.");
    const split = subtractPunch(pieces, w), offset = mul(w.pick.normal, -w.depthM), limit = w.radiusM * Math.cos(Math.PI / LIVER_PUNCH_SIDES);
    pieces = split.retained; removedPieces.push(...split.removed);
    for (const p of split.removed) {
      removedAreaM2 += area(p.vertices);
      for (let j = 1; j + 1 < p.vertices.length; j++) appendCavity(add(p.vertices[0]!.p, offset), add(p.vertices[j]!.p, offset), add(p.vertices[j + 1]!.p, offset));
      for (let j = 0; j < p.vertices.length; j++) {
        const a = p.vertices[j]!.p, b = p.vertices[(j + 1) % p.vertices.length]!.p;
        if (!split.planeNormals.some(n => Math.abs(dot(sub(a, w.pick.positionM), n) - limit) < 1e-10 && Math.abs(dot(sub(b, w.pick.positionM), n) - limit) < 1e-10)) continue;
        const lowA = add(a, offset), lowB = add(b, offset);
        appendCavity(a, b, lowB); appendCavity(a, lowB, lowA);
      }
    }
  }
  if (wounds.length) pieces = conformPieces(pieces, removedPieces, anatomy.surface);
  const positions: number[] = [], normals: number[] = [], sourceTriangles: number[] = [], sourceBarycentrics: number[] = [];
  for (const p of pieces) for (let j = 1; j + 1 < p.vertices.length; j++) {
    const tri = [p.vertices[0]!, p.vertices[j]!, p.vertices[j + 1]!];
    if (area(tri) < 1e-20) continue;
    for (const v of tri) {
      const n: V = [0, 0, 0]; for (let a = 0; a < 3; a++) { const id = anatomy.surface.indices[p.triangle * 3 + a]!; for (let k = 0; k < 3; k++) n[k] = n[k]! + anatomy.surface.normals[id * 3 + k]! * v.b[a]!; }
      positions.push(...v.p); normals.push(...unit(n)); sourceTriangles.push(p.triangle); sourceBarycentrics.push(...v.b);
    }
  }
  const surface = { positionsM: Float64Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) };
  const cavity = { positionsM: Float64Array.from(cavityPositions), normals: Float32Array.from(cavityNormals), indices: Uint32Array.from({ length: cavityPositions.length / 3 }, (_, i) => i) };
  return { surface, cavity, removedAreaM2, sourceTriangles: Uint32Array.from(sourceTriangles), sourceBarycentrics: Float64Array.from(sourceBarycentrics) };
}
