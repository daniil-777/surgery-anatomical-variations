import type { LiverCutGeometry, LiverSurface } from "./types";

export interface LiverFilmSlopeDiagnostics {
  /** Dimensionless |grad_S h| of the reconstructed P1 thickness. */
  maximumSurfaceSlope: number;
  /** sqrt(integral_retained |grad_S h|² dA / retained area). */
  areaWeightedRmsSurfaceSlope: number;
  evaluatedAreaM2: number;
  evaluatedSourceTriangles: number;
  /** Work performed; optional active support can omit exactly zero-gradient faces. */
  sampledSourceTriangles: number;
  /** Canonical face attaining a positive maximum; -1 for a constant/dry field. */
  maximumSurfaceSlopeTriangle: number;
}

/** Compile geometry once per accepted cut, then evaluate accepted film states.
 *
 * A retained triangle is the restriction of its canonical face's affine P1
 * field, so its exact gradient is the same as the parent's. We verify the
 * retained position/barycentric mapping and sum its actual area, then evaluate
 * each remaining parent once. This avoids redundant work on cut subdivisions
 * and avoids ill-conditioning from tiny retained fragments.
 *
 * For e1=B-A, e2=C-A and N=e1×e2:
 *   grad h = (hB-hA)(e2×N)/|N|² + (hC-hA)(N×e1)/|N|².
 * Unlike h/mesh-edge, this physical slope is invariant under a conforming
 * subdivision that preserves the same P1 thickness field.
 *
 * Small slopes are one lubrication assumption, not a complete validity test.
 * Substrate curvature, velocity variation, inertia, wetting and impact remain
 * separate considerations. In particular Re_h>1 is only a conservative
 * heuristic: convective inertia scales as Re_h*h/L for physical length L.
 * Sources (equations independently implemented):
 * https://www-thphys.physics.ox.ac.uk/people/JuliaYeomans/flowsC-G_2016.pdf
 * https://arxiv.org/pdf/patt-sol/9705002
 */
export function createLiverFilmSlopeEvaluator(canonical: LiverSurface, retained: LiverCutGeometry) {
  const vertexCount = canonical.positionsM.length / 3, faceCount = canonical.indices.length / 3;
  if (!Number.isInteger(vertexCount) || !Number.isInteger(faceCount) || vertexCount < 3 || faceCount < 1
    || !canonical.positionsM.every(Number.isFinite) || canonical.indices.some(i => i >= vertexCount))
    throw new RangeError("Invalid canonical geometry for film slopes");
  const mesh = retained.surface, retainedCount = mesh.positionsM.length / 3;
  if (!Number.isInteger(retainedCount) || mesh.indices.length % 3
    || retained.sourceTriangles.length !== retainedCount || retained.sourceBarycentrics.length !== retainedCount * 3
    || !mesh.positionsM.every(Number.isFinite) || mesh.indices.some(i => i >= retainedCount))
    throw new RangeError("Invalid retained geometry for film slopes");
  for (let i = 0; i < retainedCount; i++) {
    const t = retained.sourceTriangles[i]!;
    if (t >= faceCount) throw new RangeError("Invalid retained source face for film slopes");
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const w = retained.sourceBarycentrics[i * 3 + j]!;
      if (!Number.isFinite(w) || w < -1e-9 || w > 1 + 1e-9)
        throw new RangeError("Invalid retained barycentric mapping for film slopes");
      sum += w;
    }
    if (Math.abs(sum - 1) > 1e-9) throw new RangeError("Retained film weights must sum to one");
    for (let k = 0; k < 3; k++) {
      let mapped = 0;
      for (let j = 0; j < 3; j++) mapped += retained.sourceBarycentrics[i * 3 + j]!
        * canonical.positionsM[canonical.indices[t * 3 + j]! * 3 + k]!;
      if (Math.abs(mapped - mesh.positionsM[i * 3 + k]!) > 1e-10 + Math.abs(mapped) * 1e-9)
        throw new RangeError("Retained film geometry disagrees with its canonical mapping");
    }
  }
  const areaBySource = new Float64Array(faceCount);
  for (let k = 0; k < mesh.indices.length; k += 3) {
    const ia = mesh.indices[k]!, ib = mesh.indices[k + 1]!, ic = mesh.indices[k + 2]!;
    const t = retained.sourceTriangles[ia]!;
    if (retained.sourceTriangles[ib] !== t || retained.sourceTriangles[ic] !== t)
      throw new RangeError("Retained film triangle crosses canonical faces");
    const ax = mesh.positionsM[3 * ia]!, ay = mesh.positionsM[3 * ia + 1]!, az = mesh.positionsM[3 * ia + 2]!;
    const ux = mesh.positionsM[3 * ib]! - ax, uy = mesh.positionsM[3 * ib + 1]! - ay, uz = mesh.positionsM[3 * ib + 2]! - az;
    const vx = mesh.positionsM[3 * ic]! - ax, vy = mesh.positionsM[3 * ic + 1]! - ay, vz = mesh.positionsM[3 * ic + 2]! - az;
    const area = .5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (!(area > 0) || !Number.isFinite(area)) throw new RangeError("Degenerate retained film triangle");
    areaBySource[t] = areaBySource[t]! + area;
  }
  let count = 0;
  for (const area of areaBySource) if (area > 0) count++;
  const sourceFaces = new Uint32Array(count), vertexIds = new Uint32Array(count * 3);
  const gradients = new Float64Array(count * 6), areas = new Float64Array(count);
  let index = 0, evaluatedAreaM2 = 0;
  for (let t = 0; t < faceCount; t++) {
    if (areaBySource[t] === 0) continue;
    const a = canonical.indices[3 * t]!, b = canonical.indices[3 * t + 1]!, c = canonical.indices[3 * t + 2]!;
    const ax = canonical.positionsM[3 * a]!, ay = canonical.positionsM[3 * a + 1]!, az = canonical.positionsM[3 * a + 2]!;
    const ux = canonical.positionsM[3 * b]! - ax, uy = canonical.positionsM[3 * b + 1]! - ay, uz = canonical.positionsM[3 * b + 2]! - az;
    const vx = canonical.positionsM[3 * c]! - ax, vy = canonical.positionsM[3 * c + 1]! - ay, vz = canonical.positionsM[3 * c + 2]! - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const denominator = nx * nx + ny * ny + nz * nz;
    if (!(denominator > 0) || !Number.isFinite(denominator)) throw new RangeError("Degenerate canonical film triangle");
    const g = [(vy * nz - vz * ny) / denominator, (vz * nx - vx * nz) / denominator, (vx * ny - vy * nx) / denominator,
      (ny * uz - nz * uy) / denominator, (nz * ux - nx * uz) / denominator, (nx * uy - ny * ux) / denominator];
    if (!g.every(Number.isFinite)) throw new RangeError("Nonfinite canonical film gradient");
    sourceFaces[index] = t; vertexIds.set([a, b, c], index * 3); gradients.set(g, index * 6);
    areas[index] = areaBySource[t]!; evaluatedAreaM2 += areas[index]!;
    index++;
  }
  if (!Number.isFinite(evaluatedAreaM2)) throw new RangeError("Nonfinite retained film area");
  const vertexOffsets = new Uint32Array(vertexCount + 1);
  for (const vertex of vertexIds) vertexOffsets[vertex + 1] = vertexOffsets[vertex + 1]! + 1;
  for (let i = 1; i <= vertexCount; i++) vertexOffsets[i] = vertexOffsets[i]! + vertexOffsets[i - 1]!;
  const adjacency = new Uint32Array(count * 3), cursor = vertexOffsets.slice();
  for (let i = 0; i < count; i++) for (let j = 0; j < 3; j++) {
    const vertex = vertexIds[i * 3 + j]!, offset = cursor[vertex]!;
    adjacency[offset] = i; cursor[vertex] = offset + 1;
  }

  /** Pure in the supplied accepted heights; compiled geometry is private and
   * never changed, including after a rejected or invalid evaluation.
   * If supplied, activeVertices MUST include every nonzero canonical thickness.
   * Faces with no active corner then have exactly zero gradient. Duplicates
   * are harmless; the caller's iterator and vertices are never modified. */
  return (depthAtVertex: (index: number) => number, activeVertices?: Iterable<number>): LiverFilmSlopeDiagnostics => {
    let selected: number[] | undefined;
    if (activeVertices !== undefined) {
      const faces = new Set<number>();
      for (const vertex of activeVertices) {
        if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= vertexCount)
          throw new RangeError("Invalid active film vertex");
        for (let k = vertexOffsets[vertex]!; k < vertexOffsets[vertex + 1]!; k++) faces.add(adjacency[k]!);
      }
      // Preserve the full-scan accumulation order for deterministic diagnostics.
      selected = [...faces].sort((a, b) => a - b);
    }
    const sampledSourceTriangles = selected?.length ?? count;
    let maximumSquared = 0, areaIntegral = 0, maximumSurfaceSlopeTriangle = -1;
    for (let row = 0; row < sampledSourceTriangles; row++) {
      const i = selected ? selected[row]! : row;
      const ha = depthAtVertex(vertexIds[3 * i]!), hb = depthAtVertex(vertexIds[3 * i + 1]!), hc = depthAtVertex(vertexIds[3 * i + 2]!);
      if (!Number.isFinite(ha) || !Number.isFinite(hb) || !Number.isFinite(hc) || ha < 0 || hb < 0 || hc < 0)
        throw new RangeError("Film slopes require finite nonnegative accepted thickness");
      const db = hb - ha, dc = hc - ha, off = i * 6;
      const x = gradients[off]! * db + gradients[off + 3]! * dc;
      const y = gradients[off + 1]! * db + gradients[off + 4]! * dc;
      const z = gradients[off + 2]! * db + gradients[off + 5]! * dc;
      const squared = x * x + y * y + z * z;
      if (!Number.isFinite(squared)) throw new RangeError("Nonfinite film slope");
      if (squared > maximumSquared) { maximumSquared = squared; maximumSurfaceSlopeTriangle = sourceFaces[i]!; }
      areaIntegral += areas[i]! * squared;
    }
    if (!Number.isFinite(areaIntegral)) throw new RangeError("Nonfinite integrated film slope");
    return { maximumSurfaceSlope: Math.sqrt(maximumSquared),
      areaWeightedRmsSurfaceSlope: evaluatedAreaM2 > 0 ? Math.sqrt(areaIntegral / evaluatedAreaM2) : 0,
      evaluatedAreaM2, evaluatedSourceTriangles: count, sampledSourceTriangles, maximumSurfaceSlopeTriangle };
  };
}
