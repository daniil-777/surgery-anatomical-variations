import { Quaternion, Vector3 } from "three";
import type { MetrePoint } from "./geometry";

export interface LigamentGeometryInput {
  id: number; holeId: string; volumeM3: number;
  points: readonly { positionM: MetrePoint; radiusM: number }[];
}
export interface DropletGeometryInput {
  id: number; holeId: string; positionM: MetrePoint; radiusM: number; volumeM3: number;
}

/** Signed volume of the actual triangles. Scene coordinates are millimetres;
 * translating to a nearby origin avoids cancellation for tiny distant jets. */
export function closedTriangleVolumeM3(positions: ArrayLike<number>, indices: ArrayLike<number>,
  start = 0, end = indices.length, originM = new Vector3()) {
  let sum = 0;
  for (let i = start; i < end; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const ax = positions[a]! / 1000 - originM.x, ay = positions[a + 1]! / 1000 - originM.y, az = positions[a + 2]! / 1000 - originM.z;
    const bx = positions[b]! / 1000 - originM.x, by = positions[b + 1]! / 1000 - originM.y, bz = positions[b + 2]! / 1000 - originM.z;
    const cx = positions[c]! / 1000 - originM.x, cy = positions[c + 1]! / 1000 - originM.y, cz = positions[c + 2]! / 1000 - originM.z;
    sum += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

const finitePoint = (p: MetrePoint) => p.length === 3 && p.every(Number.isFinite);
export function validateDroplets(droplets: readonly DropletGeometryInput[]) {
  if (droplets.length > 8192) throw new RangeError("Too many accepted droplets");
  for (const drop of droplets) {
    if (!finitePoint(drop.positionM) || !Number.isFinite(drop.radiusM) || drop.radiusM <= 0 ||
      !Number.isFinite(drop.volumeM3) || drop.volumeM3 <= 0 ||
      Math.abs(4 * Math.PI * drop.radiusM ** 3 / (3 * drop.volumeM3) - 1) > 1e-6)
      throw new RangeError("A droplet must have finite geometry and a volume-equivalent radius");
  }
}

/** Render only the solver's accepted radii and centreline. There is no
 * renderer-side neck-growth, pinch-off, ballistic update or packet joining. */
export function ligamentGeometryData(ligaments: readonly LigamentGeometryInput[]) {
  let pointCount = 0;
  for (const ligament of ligaments) {
    pointCount += ligament.points.length;
    if (!Number.isFinite(ligament.volumeM3) || ligament.volumeM3 <= 0 ||
      ligament.points.length < 2 || pointCount > 17 * 8192)
      throw new RangeError("Invalid accepted ligament geometry");
    for (let i = 0; i < ligament.points.length; i++) {
      const p = ligament.points[i]!;
      if (!finitePoint(p.positionM) || !Number.isFinite(p.radiusM) || p.radiusM <= 0 ||
        i > 0 && new Vector3(...p.positionM).distanceTo(new Vector3(...ligament.points[i - 1]!.positionM)) <= 1e-12)
        throw new RangeError("Ligament rings must be finite, positive and spatially distinct");
    }
  }
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], thickness: number[] = [];
  const groups: { start: number; end: number; origin: Vector3; expectedM3: number }[] = [];
  const sides = 32;
  for (const ligament of ligaments) {
    const points = ligament.points.map(p => new Vector3(...p.positionM)), base = positions.length / 3, start = indices.length;
    const tangents: Vector3[] = [];
    let normal: Vector3 | undefined, previous: Vector3 | undefined;
    for (let i = 0; i < points.length; i++) {
      const prev = Math.max(0, i - 1), next = Math.min(points.length - 1, i + 1);
      const tangent = points[next]!.clone().sub(points[prev]!).normalize();
      if (tangent.lengthSq() < .5) throw new RangeError("A ligament cannot reverse onto itself");
      if (normal && previous) normal.applyQuaternion(new Quaternion().setFromUnitVectors(previous, tangent));
      else normal = tangent.clone().cross(Math.abs(tangent.y) < .85 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize();
      const binormal = tangent.clone().cross(normal).normalize(), point = points[i]!, radius = ligament.points[i]!.radiusM;
      const slope = (ligament.points[next]!.radiusM - ligament.points[prev]!.radiusM) / points[next]!.distanceTo(points[prev]!);
      for (let j = 0; j < sides; j++) {
        const angle = j * 2 * Math.PI / sides;
        const radial = normal.clone().multiplyScalar(Math.cos(angle)).addScaledVector(binormal, Math.sin(angle));
        positions.push((point.x + radial.x * radius) * 1000, (point.y + radial.y * radius) * 1000, (point.z + radial.z * radius) * 1000);
        const n = radial.addScaledVector(tangent, -slope).normalize();
        normals.push(n.x, n.y, n.z); thickness.push(radius * 2);
        if (i < points.length - 1) {
          const u = base + i * sides + j, v = base + i * sides + (j + 1) % sides;
          indices.push(u, v, u + sides, v, v + sides, u + sides);
        }
      }
      tangents.push(tangent); previous = tangent;
    }
    for (const end of [0, points.length - 1]) {
      const p = points[end]!, n = tangents[end]!.clone().multiplyScalar(end === 0 ? -1 : 1), center = positions.length / 3;
      positions.push(p.x * 1000, p.y * 1000, p.z * 1000); normals.push(n.x, n.y, n.z); thickness.push(ligament.points[end]!.radiusM * 2);
      for (let j = 0; j < sides; j++) {
        const a = base + end * sides + j, b = base + end * sides + (j + 1) % sides;
        if (end === 0) indices.push(center, b, a); else indices.push(center, a, b);
      }
    }
    const measured = Math.abs(closedTriangleVolumeM3(positions, indices, start, indices.length, points[0]));
    if (!Number.isFinite(measured) || measured <= 0) throw new RangeError("Degenerate accepted ligament");
    const correction = Math.sqrt(ligament.volumeM3 / measured);
    // Polygonal rings have slightly less area than circular rings. Correct the
    // closed mesh volume, retaining the accepted centreline and relative neck
    // profile. No arbitrary cross-section modulation is introduced here.
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!, prev = Math.max(0, i - 1), next = Math.min(points.length - 1, i + 1);
      const slope = (ligament.points[next]!.radiusM - ligament.points[prev]!.radiusM) * correction / points[next]!.distanceTo(points[prev]!);
      for (let j = 0; j < sides; j++) {
        const index = (base + i * sides + j) * 3;
        const radial = new Vector3(positions[index]! / 1000 - point.x, positions[index + 1]! / 1000 - point.y, positions[index + 2]! / 1000 - point.z);
        positions[index] = (point.x + radial.x * correction) * 1000;
        positions[index + 1] = (point.y + radial.y * correction) * 1000;
        positions[index + 2] = (point.z + radial.z * correction) * 1000;
        const n = radial.normalize().addScaledVector(tangents[i]!, -slope).normalize();
        normals[index] = n.x; normals[index + 1] = n.y; normals[index + 2] = n.z;
        thickness[base + i * sides + j] = thickness[base + i * sides + j]! * correction;
      }
    }
    thickness[base + points.length * sides] = thickness[base + points.length * sides]! * correction;
    thickness[base + points.length * sides + 1] = thickness[base + points.length * sides + 1]! * correction;
    groups.push({ start, end: indices.length, origin: points[0]!, expectedM3: ligament.volumeM3 });
  }
  const packed = new Float32Array(positions), packedIndices = new Uint32Array(indices);
  const measuredVolumeM3 = groups.reduce((sum, g) => sum + Math.abs(closedTriangleVolumeM3(packed, packedIndices, g.start, g.end, g.origin)), 0);
  return { positions: packed, normals: new Float32Array(normals), indices: packedIndices,
    thicknessM: new Float32Array(thickness), volumeM3: measuredVolumeM3,
    inputVolumeM3: groups.reduce((sum, g) => sum + g.expectedM3, 0) };
}
