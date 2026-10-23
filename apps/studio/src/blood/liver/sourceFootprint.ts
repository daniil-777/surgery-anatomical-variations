import type { LiverCutGeometry, LiverSurface, LiverVec3 } from "./types";

export interface LiverAttachmentFootprint {
  /** Canonical P1 integrals divided by the actual retained footprint area. */
  indices: Uint32Array;
  weights: Float64Array;
  areaM2: number;
  radiusM: number;
}
interface Vertex { position: LiverVec3; bary: LiverVec3; }
const dot = (a: LiverVec3, b: LiverVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: LiverVec3, b: LiverVec3): LiverVec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const difference = (a: LiverVec3, b: LiverVec3): LiverVec3 => a.map((x, k) => x - b[k]!) as LiverVec3;
const point = (p: ArrayLike<number>, i: number): LiverVec3 => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
function clip(input: Vertex[], normal: LiverVec3, centre: LiverVec3, offset: number): Vertex[] {
  const output: Vertex[] = [];
  if (!input.length) return output;
  let previous = input[input.length - 1]!, distanceBefore = dot(difference(previous.position, centre), normal) - offset;
  for (const current of input) {
    const distance = dot(difference(current.position, centre), normal) - offset;
    if ((distance <= 0) !== (distanceBefore <= 0)) {
      const fraction = distanceBefore / (distanceBefore - distance);
      output.push({ position: previous.position.map((v, k) => v + fraction * (current.position[k]! - v)) as LiverVec3,
        bary: previous.bary.map((v, k) => v + fraction * (current.bary[k]! - v)) as LiverVec3 });
    }
    if (distance <= 0) output.push(current);
    previous = current; distanceBefore = distance;
  }
  return output;
}

/** Uniform attachment flux over an aperture-radius tangent disk intersected
 * with the actual retained capsule. This is an explicit uncalibrated source
 * boundary, not a measured blood/tissue contact-angle or spreading law.
 *
 * A 64-sided inscribed disk gives an area deficit below 0.161% on a plane.
 * The +/-radius axial bound excludes remote surface sheets. Canonical P1
 * basis integrals are evaluated on the clipped polygons in actual SI area.
 * There is no mesh-spacing-dependent broadening or painted blood support.
 */
export function buildLiverAttachmentFootprint(canonical: LiverSurface, retained: LiverCutGeometry,
  centreM: LiverVec3, normal: LiverVec3, radiusM: number): LiverAttachmentFootprint {
  if (![...centreM, ...normal, radiusM].every(Number.isFinite) || radiusM < .00005 || radiusM > .0015)
    throw new RangeError("Attachment footprint requires a finite physical aperture radius");
  const norm = Math.hypot(...normal);
  if (!(norm > 0)) throw new RangeError("Attachment footprint normal is degenerate");
  const n = normal.map(x => x / norm) as LiverVec3;
  const axis: LiverVec3 = Math.abs(n[0]) < .8 ? [1, 0, 0] : [0, 0, 1];
  const tangent = cross(n, axis), length = Math.hypot(...tangent);
  const u = tangent.map(x => x / length) as LiverVec3, v = cross(n, u);
  const planes: { normal: LiverVec3; offset: number }[] = [
    { normal: n, offset: radiusM }, { normal: n.map(x => -x) as LiverVec3, offset: radiusM },
  ];
  for (let k = 0; k < 64; k++) {
    const angle = 2 * Math.PI * (k + .5) / 64;
    planes.push({ normal: u.map((x, j) => x * Math.cos(angle) + v[j]! * Math.sin(angle)) as LiverVec3,
      offset: radiusM * Math.cos(Math.PI / 64) });
  }
  const m = retained.surface, integrals = new Map<number, number>();
  let areaM2 = 0;
  for (let k = 0; k < m.indices.length; k += 3) {
    const ids = [m.indices[k]!, m.indices[k + 1]!, m.indices[k + 2]!];
    const canonicalTriangle = retained.sourceTriangles[ids[0]!]!;
    let polygon = ids.map(i => ({ position: point(m.positionsM, i), bary: point(retained.sourceBarycentrics, i) }));
    // A cheap world AABB cull before all aperture-cylinder clipping planes.
    if ([0, 1, 2].some(j => polygon.every(p => p.position[j]! < centreM[j]! - 2 * radiusM)
      || polygon.every(p => p.position[j]! > centreM[j]! + 2 * radiusM))) continue;
    if (canonicalTriangle >= canonical.indices.length / 3 || ids.some(i => retained.sourceTriangles[i] !== canonicalTriangle))
      throw new RangeError("Attachment footprint has invalid canonical mappings");
    for (const plane of planes) {
      polygon = clip(polygon, plane.normal, centreM, plane.offset);
      if (polygon.length < 3) break;
    }
    for (let j = 1; j + 1 < polygon.length; j++) {
      const a = polygon[0]!, b = polygon[j]!, c = polygon[j + 1]!;
      const area = Math.hypot(...cross(difference(b.position, a.position), difference(c.position, a.position))) / 2;
      if (!(area > 0)) continue;
      areaM2 += area;
      for (let corner = 0; corner < 3; corner++) {
        const i = canonical.indices[3 * canonicalTriangle + corner]!;
        const amount = area * Math.max(0, a.bary[corner]! + b.bary[corner]! + c.bary[corner]!) / 3;
        integrals.set(i, (integrals.get(i) ?? 0) + amount);
      }
    }
  }
  if (!Number.isFinite(areaM2) || areaM2 < Math.PI * radiusM ** 2 * 1e-6 || integrals.size > 2048)
    throw new Error("Attachment aperture has no bounded resolved retained footprint");
  const entries = [...integrals].filter(([, weight]) => weight > 0).sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const weights = Float64Array.from(entries, ([, weight]) => weight / total);
  // Normalization is geometric quadrature roundoff only; it does not enlarge
  // the aperture footprint or change the accepted emitted volume.
  return { indices: Uint32Array.from(entries, ([i]) => i), weights, areaM2, radiusM };
}
