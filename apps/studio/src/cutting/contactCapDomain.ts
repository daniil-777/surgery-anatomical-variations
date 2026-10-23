import type { CuttingEmbeddedSurface } from "./types";

type Point = readonly [number, number];
interface Triangle { points: Point[]; minimumY: number; maximumY: number; minimumZ: number; maximumZ: number; area: number }

/** Compensated accumulation matters for source caps containing tiny clipped faces. */
class Sum {
  value = 0;
  private correction = 0;
  add(value: number): void {
    const adjusted = value - this.correction, next = this.value + adjusted;
    this.correction = (next - this.value) - adjusted;
    this.value = next;
  }
}

const cross = (a: Point, b: Point, p: Point): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

function area(points: Point[]): number {
  if (points.length < 3) return 0;
  const sum = new Sum();
  for (let i = 1; i + 1 < points.length; i++) sum.add(cross(points[0]!, points[i]!, points[i + 1]!));
  return .5 * Math.abs(sum.value);
}

/** Convex clipping uses exact sign comparisons: a geometric epsilon would fill
 * narrow gaps. Only the final accumulated area has a roundoff tolerance. */
function intersectionArea(a: Triangle, b: Triangle): number {
  let polygon = a.points;
  for (let edge = 0; edge < 3 && polygon.length >= 3; edge++) {
    const start = b.points[edge]!, end = b.points[(edge + 1) % 3]!, clipped: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i]!, q = polygon[(i + 1) % polygon.length]!, dp = cross(start, end, p), dq = cross(start, end, q);
      if (dp >= 0) clipped.push(p);
      if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
        const fraction = dp / (dp - dq);
        clipped.push([p[0] + fraction * (q[0] - p[0]), p[1] + fraction * (q[1] - p[1])]);
      }
    }
    polygon = clipped;
  }
  return area(polygon);
}

function groupFaces(surface: CuttingEmbeddedSurface): Map<number, number[][]> {
  const groups = new Map<number, number[][]>();
  for (let face = 0; face < surface.indices.length; face += 3) {
    const ids = surface.indices.slice(face, face + 3), tet = surface.tetIndices[ids[0]!]!;
    const group = groups.get(tet) ?? [];
    group.push(ids); groups.set(tet, group);
  }
  return groups;
}

function triangles(surface: CuttingEmbeddedSurface, faces: number[][], origin: Point): Triangle[] {
  return faces.map(ids => {
    // Use a common local origin for both surfaces to avoid world-coordinate
    // cancellation. The cap plane is X=constant, so areas are in YZ mm².
    const points: Point[] = ids.map(id => [surface.positionsMm[3 * id + 1]! - origin[0], surface.positionsMm[3 * id + 2]! - origin[1]]);
    if (cross(points[0]!, points[1]!, points[2]!) < 0) [points[1], points[2]] = [points[2]!, points[1]!];
    const y = points.map(p => p[0]), z = points.map(p => p[1]);
    return { points, minimumY: Math.min(...y), maximumY: Math.max(...y), minimumZ: Math.min(...z), maximumZ: Math.max(...z), area: area(points) };
  }).sort((a, b) => a.minimumY - b.minimumY);
}

/** Check a contact-only tessellation against the ORIGINAL cap, per affine
 * support tet. Matching area/moments alone cannot prove domain equivalence.
 * First reject overlapping triangles within either partition. Then the sum of
 * pairwise intersections is their common area, which must cover both domains.
 * Holes, disconnected components, changed diagonals and hanging vertices need
 * no topology welding or inferred convex hull. Called once after structural,
 * winding and embedding validation; it does not change the supplied geometry.
 */
export function validateContactCapDomain(original: CuttingEmbeddedSurface, replacement: CuttingEmbeddedSurface): void {
  const fail = (reason: string): never => { throw new Error(`The contact cap does not preserve the original cut domain: ${reason}.`); };
  const oldGroups = groupFaces(original), newGroups = groupFaces(replacement);
  if (oldGroups.size !== newGroups.size) fail("different support tetrahedra");
  // Bound pairwise work including bounding-box misses, not only actual clips.
  let comparisons = 0;
  const total = (faces: Triangle[]): number => { const sum = new Sum(); for (const face of faces) sum.add(face.area); return sum.value; };
  const commonArea = (a: Triangle[], b: Triangle[], samePartition: boolean): number => {
    const sum = new Sum();
    for (let i = 0; i < a.length; i++) {
      const left = a[i]!;
      for (let j = samePartition ? i + 1 : 0; j < b.length; j++) {
        if (++comparisons > 2_000_000) return fail("intersection validation budget exceeded");
        const right = b[j]!;
        if (right.minimumY >= left.maximumY) break;
        if (right.maximumY <= left.minimumY || right.minimumZ >= left.maximumZ || right.maximumZ <= left.minimumZ) continue;
        sum.add(intersectionArea(left, right));
      }
    }
    return sum.value;
  };
  for (const [tet, oldFaces] of oldGroups) {
    const newFaces = newGroups.get(tet);
    if (!newFaces) fail("missing support tetrahedron");
    const id = oldFaces[0]![0]!, origin: Point = [original.positionsMm[3 * id + 1]!, original.positionsMm[3 * id + 2]!];
    const a = triangles(original, oldFaces, origin), b = triangles(replacement, newFaces!, origin);
    const areaA = total(a), areaB = total(b);
    let extentSquared = 0;
    for (const triangle of [...a, ...b]) for (const point of triangle.points) extentSquared = Math.max(extentSquared, point[0] * point[0] + point[1] * point[1]);
    // Relative area allowance plus local floating-point scale, in mm². This
    // tolerates clipping roundoff, not a millimetre-scale positional weld.
    const tolerance = 1e-10 * Math.max(areaA, areaB) + 4096 * Number.EPSILON * extentSquared;
    if (!(areaA > 0) || !(areaB > 0) || !Number.isFinite(tolerance)) fail("nonfinite or empty area");
    if (Math.abs(areaA - areaB) > tolerance) fail("different area");
    if (commonArea(a, a, true) > tolerance || commonArea(b, b, true) > tolerance) fail("overlapping triangles");
    const shared = commonArea(a, b, false);
    if (!Number.isFinite(shared) || Math.abs(areaA - shared) > tolerance || Math.abs(areaB - shared) > tolerance) fail("missing or extra surface area");
  }
}
