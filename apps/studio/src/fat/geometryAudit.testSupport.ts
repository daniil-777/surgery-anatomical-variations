import type { FatGeometryData } from "./generator";

type Vec3 = readonly [number, number, number];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
interface Triangle {
  ids: Vec3;
  points: readonly [Vec3, Vec3, Vec3];
  edges: readonly [Vec3, Vec3, Vec3];
  normal: Vec3;
  low: Vec3;
  high: Vec3;
}

/** Independent triangle SAT audit, including coplanar overlap. Shared-vertex
 * pairs are excluded because their intentional contact is not an intersection
 * defect; projected-sheet orientation/order tests cover local foldovers too. */
export function countNonAdjacentTriangleIntersections(mesh: Pick<FatGeometryData, "positions" | "indices">): number {
  const triangles: Triangle[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!] as const;
    const points = ids.map((id) => [mesh.positions[id * 3]!, mesh.positions[id * 3 + 1]!, mesh.positions[id * 3 + 2]!] as const) as unknown as Triangle["points"];
    const edges = [subtract(points[1], points[0]), subtract(points[2], points[1]), subtract(points[0], points[2])] as const;
    const low = [0, 1, 2].map((axis) => Math.min(...points.map((p) => p[axis]!))) as unknown as Vec3;
    const high = [0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis]!))) as unknown as Vec3;
    triangles.push({ ids, points, edges, normal: cross(edges[0], edges[1]), low, high });
  }
  triangles.sort((a, b) => a.low[0] - b.low[0]);
  let count = 0;
  const overlap = (a: Triangle, b: Triangle): boolean => {
    const axes = [a.normal, b.normal];
    for (const x of a.edges) for (const y of b.edges) axes.push(cross(x, y));
    // Triangle normals and edge cross products alone cannot separate coplanar
    // triangles. These in-plane axes make that case an actual audit too.
    for (const edge of a.edges) axes.push(cross(a.normal, edge));
    for (const edge of b.edges) axes.push(cross(b.normal, edge));
    for (const axis of axes) {
      const length = Math.hypot(...axis);
      if (length < 1e-18) continue;
      const av = a.points.map((p) => dot(p, axis)), bv = b.points.map((p) => dot(p, axis));
      const tolerance = length * 1e-8;
      if (Math.max(...av) < Math.min(...bv) - tolerance || Math.max(...bv) < Math.min(...av) - tolerance) return false;
    }
    return true;
  };
  for (let i = 0; i < triangles.length; i++) {
    const a = triangles[i]!;
    for (let j = i + 1; j < triangles.length && triangles[j]!.low[0] <= a.high[0]; j++) {
      const b = triangles[j]!;
      if (a.low[1] > b.high[1] || b.low[1] > a.high[1] || a.low[2] > b.high[2] || b.low[2] > a.high[2]) continue;
      if (a.ids.some((id) => b.ids.includes(id))) continue;
      if (overlap(a, b)) count++;
    }
  }
  return count;
}
