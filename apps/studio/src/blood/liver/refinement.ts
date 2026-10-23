import type { OrganMesh } from "@viscera/render";
import type { AtlasVesselAnchor } from "../../atlasVessels";
import type { LiverAnatomy, LiverVec3 } from "./types";

export const LIVER_REFINEMENT_VERTEX_LIMIT = 100_000;
type CapsuleAttributes = OrganMesh & { rest_positions?: number[]; material_regions?: number[] };

/** Coordinates in one of the four midpoint children, in the same winding as
 * [A,AB,CA], [B,BC,AB], [C,CA,BC], [AB,BC,CA]. Boundary ties are deterministic. */
function childAnchor(anchor: AtlasVesselAnchor, faceCount: number): AtlasVesselAnchor {
  if (!Number.isSafeInteger(anchor.triangle) || anchor.triangle < 0 || anchor.triangle >= faceCount
    || anchor.weights.length !== 3 || anchor.weights.some(w => !Number.isFinite(w) || w < -1e-9 || w > 1 + 1e-9)
    || Math.abs(anchor.weights.reduce((s, w) => s + w, 0) - 1) > 1e-9)
    throw new RangeError("Invalid base capsule anchor");
  const clean = anchor.weights.map(w => Math.max(0, Math.min(1, w)));
  const sum = clean.reduce((s, w) => s + w, 0);
  const [a, b, c] = clean.map(w => w / sum) as LiverVec3;
  let child: number, weights: LiverVec3;
  if (a >= .5) { child = 0; weights = [2 * a - 1, 2 * b, 2 * c]; }
  else if (b >= .5) { child = 1; weights = [2 * b - 1, 2 * c, 2 * a]; }
  else if (c >= .5) { child = 2; weights = [2 * c - 1, 2 * a, 2 * b]; }
  else { child = 3; weights = [1 - 2 * c, 1 - 2 * a, 1 - 2 * b]; }
  return { triangle: 4 * anchor.triangle + child, weights };
}

/** One bounded, conforming refinement of the complete canonical capsule.
 *
 * Midpoints stay on the original piecewise-planar surface. No smoothing,
 * displacement, welding, anatomy repair or new vessel generation occurs.
 * All continuous material attributes retain their original P1 interpolation.
 * Raw interpolated normals are deliberately not renormalized at midpoints:
 * consumers normalize the evaluated field, preserving its source direction.
 *
 * Level 0 is the unchanged reference. Level 1 is an initialization operation;
 * this function does not remesh a running film or transfer accepted state.
 */
export function refineLiverAnatomy(base: LiverAnatomy, level: 0 | 1 = 1): LiverAnatomy {
  if (level !== 0 && level !== 1) throw new RangeError("Liver refinement supports only levels 0 and 1");
  if (level === 0) return base;
  if (base.refinement) throw new RangeError("A liver capsule can be refined only once");
  const surface = base.surface, count = surface.positionsM.length / 3, faceCount = surface.indices.length / 3;
  if (!Number.isInteger(count) || count < 3 || count > LIVER_REFINEMENT_VERTEX_LIMIT
    || !Number.isInteger(faceCount) || faceCount < 1 || faceCount > 200_000
    || surface.normals.length !== count * 3 || !surface.positionsM.every(Number.isFinite)
    || !surface.normals.every(Number.isFinite))
    throw new RangeError("Invalid base capsule buffers");
  const attributes = base.organ as CapsuleAttributes;
  if (attributes.positions.length !== count * 3 || attributes.indices.length !== surface.indices.length
    || attributes.indices.some((v, i) => v !== surface.indices[i]))
    throw new RangeError("Capsule material and physical topology must agree");
  if (base.sourceTriangleIndices && base.sourceTriangleIndices.length !== faceCount)
    throw new RangeError("Invalid source-face provenance");

  const edgeVertices = new Map<string, number>(), endpoints: [number, number][] = [];
  const parentFaces: number[] = new Array(count).fill(-1);
  const parentWeights: number[] = new Array(count * 3).fill(0);
  const indices = new Uint32Array(surface.indices.length * 4);
  const parentTriangles = new Uint32Array(faceCount * 4);
  const midpoint = (a: number, b: number, face: number, cornerA: number, cornerB: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let id = edgeVertices.get(key);
    if (id !== undefined) return id;
    id = count + endpoints.length;
    if (id >= LIVER_REFINEMENT_VERTEX_LIMIT) throw new RangeError("Refined liver exceeds the 100,000-vertex budget");
    edgeVertices.set(key, id); endpoints.push([a, b]); parentFaces.push(face);
    const weights = [0, 0, 0]; weights[cornerA] = .5; weights[cornerB] = .5;
    parentWeights.push(...weights);
    return id;
  };
  for (let t = 0; t < faceCount; t++) {
    const a = surface.indices[3 * t]!, b = surface.indices[3 * t + 1]!, c = surface.indices[3 * t + 2]!;
    if (a >= count || b >= count || c >= count || a === b || b === c || c === a)
      throw new RangeError("Invalid base capsule triangle");
    const corners = [a, b, c];
    for (let j = 0; j < 3; j++) if (parentFaces[corners[j]!] === -1) {
      parentFaces[corners[j]!] = t; parentWeights[corners[j]! * 3 + j] = 1;
    }
    const ab = midpoint(a, b, t, 0, 1), bc = midpoint(b, c, t, 1, 2), ca = midpoint(c, a, t, 2, 0);
    indices.set([a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca], 12 * t);
    parentTriangles.fill(t, 4 * t, 4 * t + 4);
  }
  if (parentFaces.some(t => t < 0)) throw new RangeError("Unsupported isolated capsule vertex");
  const refinedCount = count + endpoints.length;
  const interpolate = (input: ArrayLike<number>, stride: number): number[] => {
    if (input.length !== count * stride) throw new RangeError("Invalid capsule material attribute length");
    const result = Array.from(input);
    if (!result.every(Number.isFinite)) throw new RangeError("Nonfinite capsule material attribute");
    for (const [a, b] of endpoints) for (let k = 0; k < stride; k++)
      result.push((input[stride * a + k]! + input[stride * b + k]!) * .5);
    return result;
  };
  const positionsM = Float64Array.from(interpolate(surface.positionsM, 3));
  const normals = Float32Array.from(interpolate(surface.normals, 3));
  const organ = structuredClone(base.organ) as CapsuleAttributes;
  organ.positions = interpolate(attributes.positions, 3);
  organ.indices = Array.from(indices); organ.normals = Array.from(normals);
  if (attributes.rest_positions) organ.rest_positions = interpolate(attributes.rest_positions, 3);
  if (attributes.material_regions) organ.material_regions = interpolate(attributes.material_regions, 1);
  if (attributes.colors) organ.colors = interpolate(attributes.colors, 3);
  if (attributes.uv) organ.uv = interpolate(attributes.uv, 2);
  const vertexParentTriangles = Uint32Array.from(parentFaces);
  const vertexParentBarycentrics = Float64Array.from(parentWeights);
  const refinement = { level: 1 as const, baseVertexCount: count, baseTriangleCount: faceCount,
    parentTriangles, vertexParentTriangles, vertexParentBarycentrics };
  const network = structuredClone(base.network);
  for (const segment of network.segments) {
    segment.a_anchor = childAnchor(segment.a_anchor, faceCount);
    segment.b_anchor = childAnchor(segment.b_anchor, faceCount);
  }
  // Segment ordering and exact world geometry are retained; attachment IDs
  // refer to the refined capsule just like target picks and mouse picking.
  const vessels = base.vessels.map((v, i) => {
    const segment = network.segments[i];
    if (!segment) throw new RangeError("Surface vessel attachments are missing");
    return { ...structuredClone(v), aTriangle: segment.a_anchor.triangle, bTriangle: segment.b_anchor.triangle };
  });
  const targets = base.targets.map(target => {
    const mapped = childAnchor({ triangle: target.pick.triangle, weights: target.pick.barycentric }, faceCount);
    return { ...structuredClone(target), pick: { ...structuredClone(target.pick),
      triangle: mapped.triangle, barycentric: mapped.weights } };
  });
  const metadata = { ...organ.metadata };
  delete metadata.liver_capsule_source_vertices;
  delete metadata.liver_capsule_source_triangles;
  metadata.liver_capsule_refinement = { level: 1, method: "conforming-midpoint-subdivision",
    base_vertices: count, base_triangles: faceCount, vertices: refinedCount, triangles: faceCount * 4,
    geometry: "Original piecewise-planar capsule preserved; no smoothing or anatomy repair" };
  if (base.sourceVertexIndices)
    metadata.liver_capsule_refinement_base_source_vertices = Array.from(base.sourceVertexIndices);
  const sourceTriangleIndices = base.sourceTriangleIndices
    ? Uint32Array.from(parentTriangles, t => base.sourceTriangleIndices![t]!) : undefined;
  const sourceVertexTriangles = base.sourceTriangleIndices
    ? Uint32Array.from(vertexParentTriangles, t => base.sourceTriangleIndices![t]!) : undefined;
  if (sourceTriangleIndices && sourceVertexTriangles) {
    metadata.liver_capsule_source_triangles = Array.from(sourceTriangleIndices);
    metadata.liver_capsule_source_vertex_faces = Array.from(sourceVertexTriangles);
    metadata.liver_capsule_source_vertex_barycentrics = Array.from(vertexParentBarycentrics);
  }
  organ.metadata = metadata;
  return { surface: { positionsM, normals, indices }, organ, network, vessels, targets, refinement,
    ...(sourceTriangleIndices ? { sourceTriangleIndices } : {}),
    ...(sourceVertexTriangles ? { sourceVertexTriangles, sourceVertexBarycentrics: vertexParentBarycentrics.slice() } : {}),
    provenance: { ...base.provenance,
      detail: `${base.provenance.detail} One conforming midpoint subdivision: ${refinedCount} vertices, ${faceCount * 4} triangles. Source-face barycentrics replace original-vertex IDs for interpolated vertices; physical and material fields share this refined canonical mesh.` } };
}
