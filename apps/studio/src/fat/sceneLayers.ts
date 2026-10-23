import * as THREE from "three";
import { SceneSurfaceContact, type ContactVector } from "../wholeSceneContact";
import { createOmentalDepotField } from "./depotFields";

/** World-space atlas inputs: millimetres, +X patient left, +Y superior, +Z anterior. */
export interface FatLayerPart { readonly id: string; readonly geometry: THREE.BufferGeometry }
export interface FatLayerConfig { readonly seed: number; readonly thicknessMm: number }
export interface FatSceneLayer { readonly id: string; readonly label: string; readonly geometry: THREE.BufferGeometry }
export interface FatLayerDiagnostics {
  readonly seed: number;
  readonly thicknessMm: number;
  readonly generatedLayers: number;
  readonly vertices: number;
  readonly triangles: number;
  readonly checkedSamples: number;
  readonly rejectedTriangles: number;
  readonly discardedDisconnectedTriangles: number;
  /** Desired initial surface separation used while constructing depots. */
  readonly targetClearanceMm: number;
  /** Minimum accepted sampled separation; not a continuous clearance guarantee. */
  readonly minimumAcceptedClearanceMm: number;
  /** Conservative minimum of passing checks, including checks on later-rejected triangles. */
  readonly minimumSampledClearanceMm: number | null;
  readonly finite: boolean;
  readonly sourceOrganIds: readonly string[];
  readonly missingOrganIds: readonly string[];
  readonly limitations: readonly string[];
}
export interface FatLayerResult { readonly geometries: readonly FatSceneLayer[]; readonly diagnostics: FatLayerDiagnostics }

type Point = [number, number, number];
interface Surface { id: string; bounds: THREE.Box3; contact: SceneSurfaceContact }
interface Grid { columns: number; rows: number; inner: Point[]; outer: Point[]; valid: boolean[]; regions: Point[]; depotUvs: [number, number][] }
interface Counters { checked: number; rejected: number; discarded: number; minimum: number }

export const FAT_LAYER_LIMITATIONS: readonly string[] = Object.freeze([
  "Procedural anatomical illustration: the greater-omentum footprint and perirenal envelopes are inferred from organ surfaces, not segmented patient fat.",
  "The anterior apron approximates greater omentum over bowel. It does not reproduce its vascular pedicles, gastrocolic attachment, fusion planes or four serosal layers.",
  "Perirenal patches preserve a broad medial opening; renal fascia, adrenal relationships and individual hilar vessels are not reconstructed.",
  "Omental fatty sleeves and descending branch paths share one authored morphology field; they are not traced patient vessels. Intercord sheets remain closed, without invented fenestrations.",
  "Optical thickness is the paired-shell gap projected onto the middle-sheet normal in the reference state, not a measured optical path or deforming contact thickness.",
  "Clearance is checked at vertices, edge midpoints and triangle centroids on the reference mesh. This is a discrete surface check, not a continuous collision guarantee.",
  "Ray-parity containment assumes closed obstacle surfaces; fragmented atlas sheets limit its reliability. No simulated gravity, adhesion, sliding or organ-contact mechanics are claimed.",
]);

export const FAT_LAYER_CLEARANCE_TARGET_MM = 0.8;
export const FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM = 0.6;
// Additional room protects the returned Float32 mesh and points between the
// sampled locations. It does not establish a continuous clearance guarantee.
const SAMPLE_MARGIN_MM = 0.1;
const SUPPORT_IDS = new Set(["small-intestine", "colon", "mesentery", "duodenum"]);
const ABDOMINAL_IDS = new Set([
  ...SUPPORT_IDS, "liver", "stomach", "gallbladder", "pancreas", "spleen", "left-kidney", "right-kidney",
  "urinary-bladder", "left-ureter", "right-ureter", "aorta", "vena-cava", "portal-vein", "hepatic-artery",
  "superior-mesenteric-artery", "inferior-mesenteric-artery", "left-renal-artery", "right-renal-artery",
  "left-renal-vein", "right-renal-vein", "splenic-artery", "celiac-trunk", "diaphragm", "spine", "pelvis", "rib-cage",
]);

const pointAt = (array: readonly Point[], index: number): Point => array[index]!;
const blend = (a: Point, b: Point, t = 0.5): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const centroid = (a: Point, b: Point, c: Point): Point => [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];

function seeded(seed: number, channel: number): number {
  let value = (seed ^ Math.imul(channel + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ value >>> 16, 0x21f0aaad);
  value = Math.imul(value ^ value >>> 15, 0x735a2d97);
  return ((value ^ value >>> 15) >>> 0) / 4294967296;
}

function sourceSurface(part: FatLayerPart): Surface | null {
  const position = part.geometry.getAttribute("position");
  if (!position || position.itemSize !== 3 || position.count < 3) return null;
  const positions = new Float32Array(position.count * 3);
  const bounds = new THREE.Box3();
  for (let i = 0; i < position.count; i++) {
    const point: Point = [position.getX(i), position.getY(i), position.getZ(i)];
    if (!point.every(Number.isFinite)) throw new RangeError(`Non-finite geometry for ${part.id}.`);
    positions.set(point, i * 3);
    bounds.expandByPoint(new THREE.Vector3(...point));
  }
  const sourceIndex = part.geometry.getIndex();
  const indices = sourceIndex ? Uint32Array.from(sourceIndex.array) : Uint32Array.from({ length: position.count }, (_, i) => i);
  if (indices.length % 3) throw new RangeError(`Incomplete triangles for ${part.id}.`);
  return { id: part.id, bounds, contact: new SceneSurfaceContact(part.id, positions, indices) };
}

function nearestDistance(point: Point, surfaces: readonly Surface[], maxDistance = Infinity): number {
  let distance = maxDistance;
  for (const surface of surfaces) {
    const dx = Math.max(surface.bounds.min.x - point[0], 0, point[0] - surface.bounds.max.x);
    const dy = Math.max(surface.bounds.min.y - point[1], 0, point[1] - surface.bounds.max.y);
    const dz = Math.max(surface.bounds.min.z - point[2], 0, point[2] - surface.bounds.max.z);
    if (dx * dx + dy * dy + dz * dz >= distance * distance) continue;
    const hit = surface.contact.closestPoint(point, distance);
    if (hit) distance = hit.distanceMm;
  }
  return distance;
}

/** Surface parity is only used inside bounding boxes and never treats bounds as
 * collision geometry. The skew ray reduces shared-edge degeneracy. */
function insideSurface(point: Point, surface: Surface): boolean {
  if (point[0] < surface.bounds.min.x || point[0] > surface.bounds.max.x || point[1] < surface.bounds.min.y || point[1] > surface.bounds.max.y || point[2] < surface.bounds.min.z || point[2] > surface.bounds.max.z) return false;
  const direction: Point = [0.93810825, 0.29534144, 0.18127752];
  let origin: Point = [...point], intersections = 0;
  for (let i = 0; i < 64; i++) {
    const hit = surface.contact.raycast(origin, direction);
    if (!hit) return intersections % 2 === 1;
    intersections++;
    origin = [hit.pointMm[0] + direction[0] * 1e-4, hit.pointMm[1] + direction[1] * 1e-4, hit.pointMm[2] + direction[2] * 1e-4];
  }
  return true; // Ambiguous excessively fragmented rays are conservatively excluded.
}

function frontSurface(x: number, y: number, surfaces: readonly Surface[], originZ: number): { z: number; id: string } | null {
  let z = -Infinity, id = "";
  for (const surface of surfaces) {
    if (x < surface.bounds.min.x || x > surface.bounds.max.x || y < surface.bounds.min.y || y > surface.bounds.max.y) continue;
    const hit = surface.contact.raycast([x, y, originZ], [0, 0, -1], "double", originZ - z);
    if (hit && hit.pointMm[2] > z) { z = hit.pointMm[2]; id = surface.id; }
  }
  return id ? { z, id } : null;
}

function triangleSamples(a: Point, b: Point, c: Point): Point[] {
  const center = centroid(a, b, c);
  return [a, b, c, blend(a, b), blend(b, c), blend(c, a), center,
    blend(center, a, 0.4), blend(center, b, 0.4), blend(center, c, 0.4)];
}

/** Connected clusters with broad lobules and recessed boundaries. All values
 * are positive: detail changes local thickness, never indents source anatomy.
 * Millimetre-scale spacing is an illustrative morphology control, not a fit. */
function lobuleRelief(x: number, y: number, seed: number): number {
  const spacing = 10, cellX = Math.floor(x / spacing), cellY = Math.floor(y / spacing);
  let strongest = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const ix = cellX + dx, iy = cellY + dy, hash = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ seed) >>> 0;
    const px = (ix + 0.2 + 0.6 * seeded(hash, 0)) * spacing;
    const py = (iy + 0.2 + 0.6 * seeded(hash, 1)) * spacing;
    const radius = 2.8 + 1.6 * seeded(hash, 2);
    strongest = Math.max(strongest, Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * radius ** 2)));
  }
  return 0.35 + 0.65 * strongest;
}

function largestTriangleComponent(triangles: number[][], counters: Counters): number[][] {
  if (!triangles.length) return triangles;
  const edgeOwners = new Map<string, number[]>(), neighbors = triangles.map(() => [] as number[]);
  triangles.forEach(([a, b, c], index) => {
    for (const [i, j] of [[a!, b!], [b!, c!], [c!, a!]]) {
      const key = i! < j! ? `${i}:${j}` : `${j}:${i}`, owners = edgeOwners.get(key) ?? [];
      for (const other of owners) { neighbors[index]!.push(other); neighbors[other]!.push(index); }
      owners.push(index); edgeOwners.set(key, owners);
    }
  });
  const seen = new Set<number>(); let largest: number[] = [];
  for (let start = 0; start < triangles.length; start++) {
    if (seen.has(start)) continue;
    const component: number[] = [], pending = [start]; seen.add(start);
    while (pending.length) {
      const index = pending.pop()!; component.push(index);
      for (const adjacent of neighbors[index]!) if (!seen.has(adjacent)) { seen.add(adjacent); pending.push(adjacent); }
    }
    if (component.length > largest.length) largest = component;
  }
  counters.discarded += triangles.length - largest.length;
  return largest.sort((a, b) => a - b).map(index => triangles[index]!);
}

interface MarginRefinement { boundaryLoops: number; smoothedVertices: number; taperedVertices: number; maximumShiftMm: number }

/** Smooth only already-retained renal patch margins. Every move rechecks all
 * affected faces and extrusion walls against actual obstacle surfaces. We do
 * not fill clearance holes or extend the patch into excluded anatomy. */
function refineRenalMargins(grid: Grid, triangles: number[][], accepted: (point: Point) => boolean): MarginRefinement {
  const edges = new Map<string, { a: number; b: number; count: number }>();
  const incidents = new Map<number, number[]>(), neighbors = new Map<number, Set<number>>();
  triangles.forEach((triangle, index) => {
    for (const vertex of triangle) { const list = incidents.get(vertex) ?? []; list.push(index); incidents.set(vertex, list); }
    for (const [a, b] of [[triangle[0]!, triangle[1]!], [triangle[1]!, triangle[2]!], [triangle[2]!, triangle[0]!]] as [number, number][]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`, previous = edges.get(key);
      if (previous) previous.count++; else edges.set(key, { a, b, count: 1 });
      const aa = neighbors.get(a) ?? new Set<number>(), bb = neighbors.get(b) ?? new Set<number>();
      aa.add(b); bb.add(a); neighbors.set(a, aa); neighbors.set(b, bb);
    }
  });
  const boundary = new Map<number, number[]>();
  for (const { a, b, count } of edges.values()) if (count === 1) {
    boundary.set(a, [...boundary.get(a) ?? [], b]); boundary.set(b, [...boundary.get(b) ?? [], a]);
  }
  const seen = new Set<number>(); let boundaryLoops = 0;
  for (const start of boundary.keys()) if (!seen.has(start)) {
    boundaryLoops++; const pending = [start]; seen.add(start);
    while (pending.length) for (const next of boundary.get(pending.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); pending.push(next); }
  }
  const normal = (points: Point[], triangle: number[]) => {
    const [a, b, c] = triangle.map(i => new THREE.Vector3(...points[i]!));
    return b!.sub(a!).cross(c!.sub(a!));
  };
  let smoothedVertices = 0, taperedVertices = 0, maximumShiftMm = 0;
  const propose = (vertex: number, inner: Point, outer: Point): boolean => {
    const oldInner = grid.inner[vertex]!, oldOuter = grid.outer[vertex]!;
    const faces = incidents.get(vertex)!;
    const oldNormals = faces.map(index => [normal(grid.inner, triangles[index]!), normal(grid.outer, triangles[index]!)]);
    grid.inner[vertex] = inner; grid.outer[vertex] = outer;
    let passes = true;
    for (let i = 0; i < faces.length && passes; i++) {
      const triangle = triangles[faces[i]!]!;
      for (const [side, points] of [grid.inner, grid.outer].entries()) {
        const next = normal(points, triangle), old = oldNormals[i]![side]!;
        // Preserve orientation and reject near-collapsed triangles. The
        // operation may round a margin, never turn its incident fan inside out.
        if (next.dot(old) <= 0 || next.lengthSq() < old.lengthSq() * .04) { passes = false; break; }
        if (!triangleSamples(points[triangle[0]!]!, points[triangle[1]!]!, points[triangle[2]!]!).every(accepted)) { passes = false; break; }
      }
    }
    for (const other of boundary.get(vertex) ?? []) if (passes) {
      passes = [...triangleSamples(grid.outer[vertex]!, grid.inner[vertex]!, grid.outer[other]!),
        ...triangleSamples(grid.outer[other]!, grid.inner[vertex]!, grid.inner[other]!),
        ...triangleSamples(grid.outer[other]!, grid.inner[other]!, grid.outer[vertex]!),
        ...triangleSamples(grid.outer[vertex]!, grid.inner[other]!, grid.inner[vertex]!)].every(accepted);
    }
    if (!passes) { grid.inner[vertex] = oldInner; grid.outer[vertex] = oldOuter; return false; }
    maximumShiftMm = Math.max(maximumShiftMm, new THREE.Vector3(...inner).distanceTo(new THREE.Vector3(...oldInner)), new THREE.Vector3(...outer).distanceTo(new THREE.Vector3(...oldOuter)));
    return true;
  };
  const ids = [...boundary.keys()];
  for (let sweep = 0; sweep < 4; sweep++) for (const vertex of sweep % 2 ? [...ids].reverse() : ids) {
    const adjacent = boundary.get(vertex)!;
    if (adjacent.length !== 2) continue;
    const targetInner = blend(grid.inner[adjacent[0]!]!, grid.inner[adjacent[1]!]!);
    const targetOuter = blend(grid.outer[adjacent[0]!]!, grid.outer[adjacent[1]!]!);
    for (const amount of [.24, .12, .06]) if (propose(vertex, blend(grid.inner[vertex]!, targetInner, amount), blend(grid.outer[vertex]!, targetOuter, amount))) { smoothedVertices++; break; }
  }
  // Shortest edge distance gives a physical-width band around ALL retained
  // boundaries, including collision exclusions. Thin feathered lips replace
  // the formerly full-thickness vertical walls at clipped grid cells.
  const distances = new Map<number, number>(ids.map(id => [id, 0]));
  const pending = ids.map(id => ({ id, distance: 0 }));
  while (pending.length) {
    pending.sort((a, b) => b.distance - a.distance);
    const { id, distance } = pending.pop()!;
    if (distance !== distances.get(id) || distance >= 8) continue;
    for (const neighbor of neighbors.get(id) ?? []) {
      const a = grid.inner[id]!, b = grid.inner[neighbor]!;
      const next = distance + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (next < 8 && next < (distances.get(neighbor) ?? Infinity)) { distances.set(neighbor, next); pending.push({ id: neighbor, distance: next }); }
    }
  }
  for (const [vertex, distance] of [...distances].sort((a, b) => a[1] - b[1])) {
    const inner = grid.inner[vertex]!, outer = grid.outer[vertex]!;
    const gap = Math.hypot(outer[0] - inner[0], outer[1] - inner[1], outer[2] - inner[2]);
    const t = distance / 8, profile = t * t * (3 - 2 * t);
    const edgeGap = Math.min(.08, gap * .25), target = blend(inner, outer, (edgeGap + (gap - edgeGap) * profile) / gap);
    for (const amount of [1, .5, .25]) if (propose(vertex, inner, blend(outer, target, amount))) { taperedVertices++; break; }
  }
  return { boundaryLoops, smoothedVertices, taperedVertices, maximumShiftMm };
}

function makeGridGeometry(grid: Grid, accept: (point: Point) => boolean, counters: Counters, refineMargins = false): THREE.BufferGeometry | null {
  let triangles: number[][] = [];
  const checked = new Map<string, boolean>();
  const accepted = (point: Point): boolean => {
    // Reused vertices/edges are checked once. Sub-micrometre key rounding is
    // many orders below the explicit 0.6 mm rejection threshold.
    const key = point.map(value => value.toFixed(7)).join(":");
    const previous = checked.get(key);
    if (previous !== undefined) return previous;
    const value = accept(point); checked.set(key, value); return value;
  };
  // Validate inner and outer faces first. Boundary extrusion faces are checked
  // below with iterative whole-cell removal; a failing wall is never simply
  // omitted from an otherwise retained solid.
  for (let row = 0; row < grid.rows; row++) for (let column = 0; column < grid.columns; column++) {
    const a = row * (grid.columns + 1) + column, b = a + 1, c = a + grid.columns + 1, d = c + 1;
    for (const candidate of [[a, b, c], [b, d, c]]) {
      if (!candidate.every(index => grid.valid[index])) { counters.rejected++; continue; }
      let [i, j, k] = candidate as [number, number, number];
      const pa = grid.outer[i]!, pb = grid.outer[j]!, pc = grid.outer[k]!;
      const ab = new THREE.Vector3(...pb).sub(new THREE.Vector3(...pa));
      const ac = new THREE.Vector3(...pc).sub(new THREE.Vector3(...pa));
      const outward = new THREE.Vector3(...pa).sub(new THREE.Vector3(...grid.inner[i]!));
      if (ab.cross(ac).dot(outward) < 0) [j, k] = [k, j];
      const samples = [...triangleSamples(pointAt(grid.inner, i), pointAt(grid.inner, j), pointAt(grid.inner, k)),
        ...triangleSamples(pointAt(grid.outer, i), pointAt(grid.outer, j), pointAt(grid.outer, k))];
      if (!samples.every(accepted)) { counters.rejected++; continue; }
      triangles.push([i, j, k]);
    }
  }
  if (!triangles.length) return null;
  // Removing a failed boundary cell exposes neighboring walls. Recompute until
  // all retained boundary faces pass. Shared interior walls are not rendered;
  // testing them all would multiply cost without strengthening surface checks.
  for (let iteration = 0; iteration < 32; iteration++) {
    const boundary = new Map<string, { a: number; b: number; owner: number; count: number }>();
    triangles.forEach(([a, b, c], owner) => {
      for (const [i, j] of [[a!, b!], [b!, c!], [c!, a!]]) {
        const key = i! < j! ? `${i}:${j}` : `${j}:${i}`, previous = boundary.get(key);
        if (previous) previous.count++;
        else boundary.set(key, { a: i!, b: j!, owner, count: 1 });
      }
    });
    const rejected = new Set<number>();
    for (const edge of boundary.values()) if (edge.count === 1) {
      const { a, b } = edge;
      if (![...triangleSamples(grid.outer[a]!, grid.inner[a]!, grid.outer[b]!),
        ...triangleSamples(grid.outer[b]!, grid.inner[a]!, grid.inner[b]!)].every(accepted)) rejected.add(edge.owner);
    }
    if (!rejected.size) break;
    counters.rejected += rejected.size;
    triangles = triangles.filter((_, index) => !rejected.has(index));
    if (!triangles.length || iteration === 31) return null;
  }
  triangles = largestTriangleComponent(triangles, counters);
  // Clipping may leave two disconnected triangle fans touching at one grid
  // vertex. Split those fans before extrusion so their side walls do not create
  // an edge with four incident triangles.
  const incidents = new Map<number, number[]>();
  triangles.forEach((triangle, index) => triangle.forEach(vertex => {
    const list = incidents.get(vertex) ?? []; list.push(index); incidents.set(vertex, list);
  }));
  for (const [vertex, incident] of incidents) {
    const remaining = new Set(incident); let first = true;
    while (remaining.size) {
      const firstTriangle = remaining.values().next().value as number;
      const pending = [firstTriangle], fan: number[] = []; remaining.delete(firstTriangle);
      while (pending.length) {
        const index = pending.pop()!; fan.push(index);
        const neighbors = triangles[index]!.filter(candidate => candidate !== vertex);
        for (const candidate of remaining) if (triangles[candidate]!.some(other => other !== vertex && neighbors.includes(other))) {
          remaining.delete(candidate); pending.push(candidate);
        }
      }
      if (first) { first = false; continue; }
      const replacement = grid.inner.length;
      grid.inner.push([...grid.inner[vertex]!]); grid.outer.push([...grid.outer[vertex]!]);
      grid.regions.push([...grid.regions[vertex]!]);
      grid.depotUvs.push([...grid.depotUvs[vertex]!]);
      for (const index of fan) triangles[index] = triangles[index]!.map(candidate => candidate === vertex ? replacement : candidate);
    }
  }
  const marginRefinement = refineMargins ? refineRenalMargins(grid, triangles, accepted) : null;
  const count = grid.inner.length;
  const edgeMap = new Map<string, { a: number; b: number; count: number }>();
  for (const [a, b, c] of triangles as [number, number, number][]) for (const [i, j] of [[a, b], [b, c], [c, a]] as [number, number][]) {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    const previous = edgeMap.get(key);
    if (previous) previous.count++;
    else edgeMap.set(key, { a: i, b: j, count: 1 });
  }
  const indices: number[] = [];
  for (const [a, b, c] of triangles as [number, number, number][]) indices.push(a + count, b + count, c + count, a, c, b);
  for (const edge of edgeMap.values()) if (edge.count === 1) {
    const { a, b } = edge;
    // Every retained boundary side was checked above. These boundaries can now be
    // capped without selectively deleting walls and leaving an open solid.
    indices.push(a + count, a, b + count, b + count, a, b);
  }
  // Compact unused grid points so geometry bounds and saved files reflect only
  // visible triangles. Rest-space attributes remain independent buffers.
  // Area-weighted middle-sheet normals are independent of the wall normals.
  // Project the actual paired gap onto this normal: nominal requested layer
  // thickness otherwise turns a thin intercord membrane into an opaque pad.
  const middleNormals = Array.from({ length: count }, () => new THREE.Vector3());
  for (const [a, b, c] of triangles as [number, number, number][]) {
    const pa = new THREE.Vector3(...blend(grid.inner[a]!, grid.outer[a]!));
    const pb = new THREE.Vector3(...blend(grid.inner[b]!, grid.outer[b]!));
    const pc = new THREE.Vector3(...blend(grid.inner[c]!, grid.outer[c]!));
    const normal = pb.sub(pa).cross(pc.sub(pa));
    for (const vertex of [a, b, c]) middleNormals[vertex]!.add(normal);
  }
  const gaps = grid.inner.map((inner, i) => new THREE.Vector3(...grid.outer[i]!).sub(new THREE.Vector3(...inner)));
  const projectedThicknesses = gaps.map((gap, i) => Math.abs(gap.dot(middleNormals[i]!.normalize())));
  const allPoints = [...grid.inner, ...grid.outer], remap = new Map<number, number>(), positions: number[] = [], compactIndices: number[] = [];
  const thicknesses: number[] = [], columnThicknesses: number[] = [], regions: number[] = [], depotUvs: number[] = [];
  for (const oldIndex of indices) {
    let index = remap.get(oldIndex);
    if (index === undefined) {
      index = positions.length / 3; remap.set(oldIndex, index); positions.push(...allPoints[oldIndex]!);
      const column = oldIndex % count;
      thicknesses.push(projectedThicknesses[column]!); columnThicknesses.push(gaps[column]!.length());
      regions.push(...grid.regions[column]!);
      depotUvs.push(...grid.depotUvs[column]!);
    }
    compactIndices.push(index);
  }
  const array = Float32Array.from(positions), geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(array, 3));
  geometry.setAttribute("fatRestPosition", new THREE.BufferAttribute(array.slice(), 3));
  geometry.setAttribute("fatThicknessMm", new THREE.BufferAttribute(Float32Array.from(thicknesses), 1));
  geometry.setAttribute("fatColumnThicknessMm", new THREE.BufferAttribute(Float32Array.from(columnThicknesses), 1));
  geometry.setAttribute("fatRegion", new THREE.BufferAttribute(Float32Array.from(regions), 3));
  geometry.setAttribute("fatDepotUv", new THREE.BufferAttribute(Float32Array.from(depotUvs), 2));
  geometry.setIndex(compactIndices);
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData = { generator: "viscera-anatomical-fat-v5", units: "mm", thicknessDefinition: "normal-projected-paired-shell-gap", regionDefinition: ["authored lipid coverage", "footprint-filtered illustrative vessel path", "intercord membrane coverage"], ...(marginRefinement ? { marginRefinement } : {}), clearanceCheck: "discrete vertices, edge midpoints, centroids and interior face samples, including complete boundary caps", clinicalValidation: false };
  return geometry;
}

function makeApron(surfaces: readonly Surface[], seed: number, thickness: number, counters: Counters): THREE.BufferGeometry | null {
  const bowel = surfaces.find(surface => surface.id === "small-intestine") ?? surfaces.find(surface => surface.id === "colon");
  const stomach = surfaces.find(surface => surface.id === "stomach");
  if (!bowel || !stomach) return null;
  const supports = surfaces.filter(surface => SUPPORT_IDS.has(surface.id));
  // Anterior ribs can legitimately overlie abdominal fat. They constrain
  // clearance and containment but must not become the apron support envelope.
  const projectionSurfaces = surfaces.filter(surface => surface.id !== "rib-cage");
  const ribs = surfaces.filter(surface => surface.id === "rib-cage");
  const bounds = bowel.bounds, size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  const top = Math.min(stomach.bounds.min.y - 2, bounds.max.y + 18);
  const bottom = bounds.min.y + size.y * (0.07 + 0.06 * seeded(seed, 2));
  if (top - bottom < 10 || size.x < 10) return null;
  const rows = 64, columns = 64, inner: Point[] = [], outer: Point[] = [], valid: boolean[] = [], raw: number[] = [], regions: Point[] = [], depotUvs: [number, number][] = [];
  const originZ = Math.max(...surfaces.map(surface => surface.bounds.max.z)) + 100;
  const xCenter = center.x + (seeded(seed, 0) - 0.5) * Math.min(8, size.x * 0.04);
  const halfWidth = size.x * (0.43 + 0.065 * seeded(seed, 1));
  const asymmetry = (seeded(seed, 4) - 0.5) * 0.2;
  const bend = (seeded(seed, 5) - 0.5) * 12;
  const phase = seeded(seed, 3) * Math.PI * 2;
  const depotField = createOmentalDepotField(seed, halfWidth * 2, top - bottom);
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const v = row / rows, u = 2 * col / columns - 1;
    const height = top - bottom;
    // A square-to-disk parameterization gives a continuous rounded shoulder
    // where the attachment edge meets each side. Merely drawing a curved top
    // on a rectangular grid left two conspicuous clipped corners.
    const q = 2 * v - 1;
    const roundedU = u * Math.sqrt(1 - .5 * q * q);
    const roundedV = .5 + .5 * q * Math.sqrt(1 - .5 * u * u);
    const widthProfile = .83 + .14 * Math.sin(Math.PI * roundedV) - .13 * roundedV;
    const sideScallop = Math.sign(roundedU) * Math.abs(roundedU) ** 5 * Math.sin(Math.PI * roundedV)
      * (2.2 * Math.sin(7 * Math.PI * roundedV + phase + u) + .8 * Math.sin(13 * Math.PI * roundedV - phase));
    const x = xCenter + roundedU * halfWidth * widthProfile * (1 + asymmetry * roundedU) + sideScallop + bend * Math.sin(Math.PI * roundedV);
    const upperContour = -3 - .025 * height * (1 - u * u)
      + (1 - u * u) ** 2 * (2.2 * Math.sin(5 * u + phase) + 1.2 * Math.sin(9 * u - phase));
    const lowerContour = 5 * Math.sin(7 * u + phase) + 2.5 * Math.sin(13 * u - phase);
    const y = top - roundedV * height + (1 - roundedV) ** 3 * upperContour + roundedV ** 4 * lowerContour;
    const support = frontSurface(x, y, supports, originZ);
    inner.push([x, y, support?.z ?? NaN]); outer.push([0, 0, 0]); raw.push(support?.z ?? NaN); valid.push(true);
  }
  const supported = raw.map((z, index) => Number.isFinite(z) ? index : -1).filter(index => index >= 0);
  if (!supported.length) return null;
  // Bridge short inter-loop gaps with the nearest supported height, then build
  // a gently varying upper envelope; never depress the raw support surface.
  for (let i = 0; i < inner.length; i++) if (!Number.isFinite(raw[i])) {
    let closest = -1, distance2 = Infinity;
    for (const j of supported) {
      const dx = inner[i]![0] - inner[j]![0], dy = inner[i]![1] - inner[j]![1], candidate = dx * dx + dy * dy;
      if (candidate < distance2) { closest = j; distance2 = candidate; }
    }
    raw[i] = raw[closest]!;
    valid[i] = distance2 <= 25 * 25;
  }
  const envelope = [...raw];
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const i = row * (columns + 1) + col;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const rr = row + dy, cc = col + dx;
      if (rr < 0 || rr > rows || cc < 0 || cc > columns) continue;
      const j = rr * (columns + 1) + cc;
      const distance = Math.hypot(inner[i]![0] - inner[j]![0], inner[i]![1] - inner[j]![1]);
      envelope[i] = Math.max(envelope[i]!, raw[j]! - 0.6 * distance);
    }
  }
  for (let i = 0; i < inner.length; i++) {
    const point = inner[i]!, v = Math.floor(i / (columns + 1)) / rows, u = (i % (columns + 1)) / columns;
    // A small positive thickness modulation resembles lobules without displacing
    // the organ-facing surface into the source anatomy.
    point[2] = envelope[i]! + FAT_LAYER_CLEARANCE_TARGET_MM + 1.2;
    for (let attempt = 0; attempt < 6; attempt++) {
      const distance = nearestDistance(point, supports, FAT_LAYER_CLEARANCE_TARGET_MM + 0.2);
      if (distance >= FAT_LAYER_CLEARANCE_TARGET_MM) break;
      point[2] += (FAT_LAYER_CLEARANCE_TARGET_MM - distance) * 2 + 0.15;
    }
    const edge = Math.sin(Math.PI * u) ** 0.5 * (0.5 + 0.5 * Math.sin(Math.PI * v));
    const field = depotField.sample(u, v);
    // The same nonperiodic gross field controls joined fatty sleeves, their
    // descending branches, thin intervening sheets and shader appearance.
    const localThickness = Math.max(.025, thickness * (.22 + .78 * edge) * field.thicknessScale);
    outer[i] = [point[0], point[1], point[2] + localThickness];
    regions.push([field.lipidCoverage, field.vesselMask, field.membraneCoverage]);
    depotUvs.push([u, v]);
    const obstacle = frontSurface(point[0], point[1], projectionSurfaces, originZ);
    if (obstacle && !SUPPORT_IDS.has(obstacle.id) && obstacle.z > envelope[i]! - FAT_LAYER_CLEARANCE_TARGET_MM) valid[i] = false;
  }
  const foregroundCache = new Map<string, ReturnType<typeof frontSurface>>();
  const accept = (point: Point): boolean => {
    counters.checked++;
    const key = `${point[0].toFixed(7)}:${point[1].toFixed(7)}`;
    let foreground = foregroundCache.get(key);
    if (foreground === undefined) { foreground = frontSurface(point[0], point[1], projectionSurfaces, originZ); foregroundCache.set(key, foreground); }
    if (foreground && point[2] - foreground.z < FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM + SAMPLE_MARGIN_MM) return false;
    const distance = nearestDistance(point, surfaces, 10);
    if (distance < FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM + SAMPLE_MARGIN_MM) return false;
    if (ribs.some(surface => insideSurface(point, surface))) return false;
    counters.minimum = Math.min(counters.minimum, distance);
    return true;
  };
  const geometry = makeGridGeometry({ columns, rows, inner, outer, valid, regions, depotUvs }, accept, counters);
  if (geometry) {
    geometry.userData.vesselFootprintMm = depotField.vesselFootprintMm;
    geometry.userData.depotField = { kind: "omental", seed, widthMm: halfWidth * 2, heightMm: top - bottom };
  }
  return geometry;
}

function makePerirenal(kidney: Surface, surfaces: readonly Surface[], seed: number, thickness: number, counters: Counters): THREE.BufferGeometry | null {
  const center = kidney.bounds.getCenter(new THREE.Vector3()), size = kidney.bounds.getSize(new THREE.Vector3());
  const side = kidney.id === "left-kidney" ? 1 : -1;
  const rows = 30, columns = 40, inner: Point[] = [], outer: Point[] = [], valid: boolean[] = [], regions: Point[] = [], depotUvs: [number, number][] = [];
  const directions: Point[] = [], localThicknesses: number[] = [];
  const castRadius = size.length() + thickness + 20, phase = seeded(seed, side + 5) * Math.PI * 2;
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const v = row / rows, u = col / columns;
    depotUvs.push([u, v]);
    const upperPolar = Math.PI * (0.12 + 0.018 * Math.sin(5 * u + phase) + 0.008 * Math.sin(13 * u - phase));
    const lowerPolar = Math.PI * (0.88 + 0.016 * Math.sin(7 * u - phase) + 0.007 * Math.cos(11 * u + phase));
    const polar = upperPolar + (lowerPolar - upperPolar) * v;
    // Widen the medial opening at the hilum; soft scallops avoid a straight
    // vertical cut while retaining the essential medial exclusion.
    const halfSpan = Math.PI * (0.68 - 0.08 * Math.sin(Math.PI * v) ** 2 + 0.012 * Math.sin(7 * Math.PI * v + phase));
    const azimuth = (2 * u - 1) * halfSpan;
    const direction: ContactVector = [side * Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
    const origin: Point = [center.x + direction[0] * castRadius, center.y + direction[1] * castRadius, center.z + direction[2] * castRadius];
    const hit = kidney.contact.raycast(origin, direction.map(value => -value));
    if (!hit) { inner.push([center.x, center.y, center.z]); outer.push([center.x, center.y, center.z]); valid.push(false); directions.push(direction); localThicknesses.push(0); regions.push([0, 0, 1]); continue; }
    const edge = Math.sin(Math.PI * u) ** 0.5 * Math.sin(Math.PI * v) ** 0.5;
    const base: Point = [hit.pointMm[0] + direction[0] * (FAT_LAYER_CLEARANCE_TARGET_MM + 1.5), hit.pointMm[1] + direction[1] * (FAT_LAYER_CLEARANCE_TARGET_MM + 1.5), hit.pointMm[2] + direction[2] * (FAT_LAYER_CLEARANCE_TARGET_MM + 1.5)];
    let localThickness = thickness * (0.12 + 0.88 * edge) * lobuleRelief(base[0] + base[2] * 0.37, base[1], seed ^ (side > 0 ? 0x31ac : 0x754b));
    const lipidCoverage = .6 + .38 * edge;
    // A renal pad is a different depot, not an omental branch-map wrapped onto
    // a kidney. No invented individual renal vascular paths are painted here.
    regions.push([lipidCoverage, 0, 1 - lipidCoverage]);
    // Fit a thinner pad when another real organ surface bounds the available
    // space. The later triangle checks still reject enclosed/ambiguous regions.
    for (const surface of surfaces) {
      const obstacle = surface.contact.raycast(base, direction, "double", localThickness + FAT_LAYER_CLEARANCE_TARGET_MM);
      if (obstacle) localThickness = Math.min(localThickness, Math.max(0.15, obstacle.distanceMm - FAT_LAYER_CLEARANCE_TARGET_MM));
    }
    inner.push(base);
    outer.push([base[0] + direction[0] * localThickness, base[1] + direction[1] * localThickness, base[2] + direction[2] * localThickness]);
    valid.push(true); directions.push(direction); localThicknesses.push(localThickness);
  }
  // Nearby surfaces can abruptly cap one radial ray. Without this bounded
  // thickness gradient, an adjacent thick column creates long side triangles
  // that cross anatomy or break into slivers when clipped. A lower envelope
  // spreads the restriction; it never enlarges a previously limited column.
  for (let sweep = 0; sweep < 32; sweep++) {
    let changed = false;
    for (let ordinal = 0; ordinal < inner.length; ordinal++) {
      const i = sweep % 2 ? inner.length - 1 - ordinal : ordinal;
      if (!valid[i]) continue;
      const row = Math.floor(i / (columns + 1)), column = i % (columns + 1);
      const neighbors = [row > 0 ? i - columns - 1 : -1, row < rows ? i + columns + 1 : -1, column > 0 ? i - 1 : -1, column < columns ? i + 1 : -1];
      for (const j of neighbors) if (j >= 0 && valid[j]) {
        const a = inner[i]!, b = inner[j]!;
        const bound = localThicknesses[j]! + 0.35 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        if (localThicknesses[i]! > bound + 1e-7) { localThicknesses[i] = bound; changed = true; }
      }
    }
    if (!changed) break;
  }
  for (let i = 0; i < inner.length; i++) {
    const base = inner[i]!, direction = directions[i]!, localThickness = localThicknesses[i]!;
    outer[i] = [base[0] + direction[0] * localThickness, base[1] + direction[1] * localThickness, base[2] + direction[2] * localThickness];
  }
  const accept = (point: Point): boolean => {
    counters.checked++;
    const distance = nearestDistance(point, surfaces, 10);
    if (distance < FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM + SAMPLE_MARGIN_MM) return false;
    if (surfaces.some(surface => insideSurface(point, surface))) return false;
    counters.minimum = Math.min(counters.minimum, distance);
    return true;
  };
  return makeGridGeometry({ columns, rows, inner, outer, valid, regions, depotUvs }, accept, counters, true);
}

/** Produces independently disposable reference-world geometries. Source positions,
 * indices, normals and bounds are never mutated. Only anatomical depots are added;
 * this intentionally does not wrap every organ in a uniform fat coating.
 */
export function createFatLayers(parts: readonly FatLayerPart[], config: FatLayerConfig): FatLayerResult {
  if (!Number.isInteger(config.seed) || !Number.isFinite(config.seed)) throw new RangeError("Fat layer seed must be a finite integer.");
  if (!Number.isFinite(config.thicknessMm) || config.thicknessMm < 0.25 || config.thicknessMm > 30) throw new RangeError("Fat layer thickness must be between 0.25 and 30 mm.");
  const duplicateIds = parts.map(part => part.id);
  if (new Set(duplicateIds).size !== duplicateIds.length) throw new RangeError("Fat layer source organ ids must be unique.");
  const surfaces = parts.filter(part => ABDOMINAL_IDS.has(part.id)).map(sourceSurface).filter((surface): surface is Surface => surface !== null);
  const counters: Counters = { checked: 0, rejected: 0, discarded: 0, minimum: Infinity }, geometries: FatSceneLayer[] = [];
  const apron = makeApron(surfaces, config.seed, config.thicknessMm, counters);
  if (apron) geometries.push({ id: "fat-omentum", label: "Greater omentum · procedural apron", geometry: apron });
  for (const id of ["left-kidney", "right-kidney"]) {
    const kidney = surfaces.find(surface => surface.id === id);
    if (!kidney) continue;
    const geometry = makePerirenal(kidney, surfaces, config.seed, config.thicknessMm, counters);
    if (geometry) geometries.push({ id: `fat-${id}-perirenal`, label: `${id === "left-kidney" ? "Left" : "Right"} perirenal fat · partial envelope`, geometry });
  }
  const sourceOrganIds = surfaces.map(surface => surface.id);
  return { geometries, diagnostics: {
    seed: config.seed >>> 0, thicknessMm: config.thicknessMm, generatedLayers: geometries.length,
    vertices: geometries.reduce((sum, layer) => sum + layer.geometry.getAttribute("position").count, 0),
    triangles: geometries.reduce((sum, layer) => sum + (layer.geometry.getIndex()?.count ?? 0) / 3, 0),
    checkedSamples: counters.checked, rejectedTriangles: counters.rejected,
    discardedDisconnectedTriangles: counters.discarded,
    targetClearanceMm: FAT_LAYER_CLEARANCE_TARGET_MM,
    minimumAcceptedClearanceMm: FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM,
    minimumSampledClearanceMm: Number.isFinite(counters.minimum) ? counters.minimum : null,
    finite: geometries.every(layer => Array.from(layer.geometry.getAttribute("position").array).every(Number.isFinite)),
    sourceOrganIds,
    missingOrganIds: ["stomach", "small-intestine", "left-kidney", "right-kidney"].filter(id => !sourceOrganIds.includes(id)),
    limitations: FAT_LAYER_LIMITATIONS,
  } };
}
