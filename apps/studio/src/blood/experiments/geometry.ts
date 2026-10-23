import { CatmullRomCurve3, ShapeUtils, Vector2, Vector3 } from "three";
import { composeDiffuseSubstrate } from "../optics";
import { bloodAppearanceTransport } from "./bloodAppearanceOptics";

export type MetrePoint = readonly [number, number, number];
export interface TankGeometryConfig { widthM: number; depthM: number; heightM: number; nx: number; nz: number }
export interface ApertureSpec { id: string; arcFraction: number; angleRad: number; radiusM: number }
export interface VesselGeometryConfig {
  centrelineM: readonly MetrePoint[];
  innerRadiusM: number;
  wallThicknessM: number;
  holes: readonly ApertureSpec[];
}
export interface GeometryData {
  positions: Float32Array; normals: Float32Array; colours: Float32Array; indices: Uint32Array;
}
export function validateTankGeometry(c: TankGeometryConfig) {
  if (![c.widthM, c.depthM, c.heightM].every(v => Number.isFinite(v) && v > 0 && v <= 2) ||
      ![c.nx, c.nz].every(v => Number.isInteger(v) && v >= 4 && v <= 256))
    throw new RangeError("Tank geometry requires positive dimensions and 4–256 cells per axis");
}
function finitePoint(p: MetrePoint) { return p.length === 3 && p.every(Number.isFinite); }

/** Cell-centred accepted heights → a shared-edge height graph. Coordinates and
 * derivatives remain physical; only the scene's unit conversion is millimetres.
 * Boundaries use the adjacent no-flux cell, not periodic wrapping.
 */
export function tankSurfaceData(c: TankGeometryConfig, heights: ArrayLike<number>, reuse?: GeometryData, oxygenationFraction = .98,
  substrateRgb: readonly [number, number, number] = [.28, .28, .28], conservativeFaces = false): GeometryData {
  validateTankGeometry(c);
  if (heights.length !== c.nx * c.nz) throw new RangeError("Tank height field has the wrong dimensions");
  for (let i = 0; i < heights.length; i++)
    if (!Number.isFinite(heights[i]) || heights[i]! < 0 || heights[i]! > c.heightM)
      throw new RangeError("Tank heights must be finite and inside the enclosure");
  const corners = (c.nx + 1) * (c.nz + 1), count = corners + (conservativeFaces ? c.nx * c.nz : 0);
  const dx = c.widthM / c.nx, dz = c.depthM / c.nz;
  const data = reuse?.positions.length === count * 3 ? reuse : {
    positions: new Float32Array(count * 3), normals: new Float32Array(count * 3),
    colours: new Float32Array(count * 3), indices: new Uint32Array(c.nx * c.nz * (conservativeFaces ? 12 : 6)),
  };
  const at = (x: number, z: number) => heights[Math.min(c.nz - 1, Math.max(0, z)) * c.nx + Math.min(c.nx - 1, Math.max(0, x))]!;
  for (let z = 0; z <= c.nz; z++) for (let x = 0; x <= c.nx; x++) {
    const h00 = at(x - 1, z - 1), h10 = at(x, z - 1), h01 = at(x - 1, z), h11 = at(x, z);
    const h = (h00 + h10 + h01 + h11) * .25;
    const sx = (h10 + h11 - h00 - h01) / (2 * dx), sz = (h01 + h11 - h00 - h10) / (2 * dz);
    const inv = 1 / Math.hypot(sx, 1, sz), j = (z * (c.nx + 1) + x) * 3;
    data.positions.set([(x * dx - c.widthM / 2) * 1000, h * 1000, (z * dz - c.depthM / 2) * 1000], j);
    data.normals.set([-sx * inv, inv, -sz * inv], j);
    data.colours.set(composeDiffuseSubstrate(bloodAppearanceTransport(h, oxygenationFraction), substrateRgb), j);
    if (!conservativeFaces && x < c.nx && z < c.nz) {
      const a = z * (c.nx + 1) + x, b = a + c.nx + 1;
      data.indices.set([a, b, a + 1, a + 1, b, b + 1], (z * c.nx + x) * 6);
    }
  }
  if (conservativeFaces) for (let z = 0; z < c.nz; z++) for (let x = 0; x < c.nx; x++) {
    const a = z * (c.nx + 1) + x, b = a + c.nx + 1, center = corners + z * c.nx + x;
    const j = center * 3, h00 = data.positions[a * 3 + 1]! / 1000, h10 = data.positions[(a + 1) * 3 + 1]! / 1000;
    const h01 = data.positions[b * 3 + 1]! / 1000, h11 = data.positions[(b + 1) * 3 + 1]! / 1000;
    const h = (h00 + h10 + h01 + h11) / 4;
    const sx = (h10 + h11 - h00 - h01) / (2 * dx);
    const sz = (h01 + h11 - h00 - h10) / (2 * dz), inv = 1 / Math.hypot(sx, 1, sz);
    data.positions.set([((x + .5) * dx - c.widthM / 2) * 1000, h * 1000, ((z + .5) * dz - c.depthM / 2) * 1000], j);
    data.normals.set([-sx * inv, inv, -sz * inv], j);
    data.colours.set(composeDiffuseSubstrate(bloodAppearanceTransport(h, oxygenationFraction), substrateRgb), j);
    // A centre fan integrates the bilinear corner average exactly. With the
    // clamped cell-to-corner reconstruction above this preserves the total
    // finite-volume inventory, including arbitrary boundary/corner deposits.
    data.indices.set([a, b, center, b, b + 1, center, b + 1, a + 1, center, a + 1, a, center], (z * c.nx + x) * 12);
  }
  return data;
}

/** Wet boundary is a continuous wall of fluid down to the actual tank floor. */
export function tankBoundaryData(c: TankGeometryConfig, surface: GeometryData, reuse?: GeometryData, oxygenationFraction = .98): GeometryData {
  const edge: number[] = [];
  for (let x = 0; x <= c.nx; x++) edge.push(x);
  for (let z = 1; z <= c.nz; z++) edge.push(z * (c.nx + 1) + c.nx);
  for (let x = c.nx - 1; x >= 0; x--) edge.push(c.nz * (c.nx + 1) + x);
  for (let z = c.nz - 1; z >= 1; z--) edge.push(z * (c.nx + 1));
  const count = edge.length;
  const data = reuse?.positions.length === count * 12 ? reuse : {
    positions: new Float32Array(count * 12), normals: new Float32Array(count * 12),
    colours: new Float32Array(count * 12), indices: new Uint32Array(count * 6),
  };
  for (let i = 0; i < count; i++) {
    const a = edge[i]! * 3, b = edge[(i + 1) % count]! * 3, p = i * 12;
    const ax = surface.positions[a]!, az = surface.positions[a + 2]!, bx = surface.positions[b]!, bz = surface.positions[b + 2]!;
    data.positions.set([ax, 0, az, bx, 0, bz, ax, surface.positions[a + 1]!, az, bx, surface.positions[b + 1]!, bz], p);
    const norm = Math.hypot(bx - ax, bz - az), nx = (bz - az) / norm, nz = (ax - bx) / norm;
    const colour = bloodAppearanceTransport(Math.max(c.widthM, c.depthM), oxygenationFraction).reflectance;
    for (let v = 0; v < 4; v++) { data.normals.set([nx, 0, nz], p + v * 3); data.colours.set(colour, p + v * 3); }
    data.indices.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 2, i * 4 + 3, i * 4 + 1], i * 6);
  }
  return data;
}

export function vesselFrame(c: VesselGeometryConfig) {
  if (c.centrelineM.length < 2 || c.centrelineM.length > 64 || !c.centrelineM.every(finitePoint) ||
      !Number.isFinite(c.innerRadiusM) || c.innerRadiusM <= 0 || c.innerRadiusM > .05 ||
      !Number.isFinite(c.wallThicknessM) || c.wallThicknessM <= 0 || c.wallThicknessM > c.innerRadiusM)
    throw new RangeError("Invalid vessel geometry");
  const curve = new CatmullRomCurve3(c.centrelineM.map(p => new Vector3(...p)), false, "centripetal");
  curve.arcLengthDivisions = 1024; curve.updateArcLengths();
  const lengthM = curve.getLength(), frames = curve.computeFrenetFrames(512, false);
  if (!Number.isFinite(lengthM) || lengthM < 4 * c.innerRadiusM || lengthM > 2) throw new RangeError("Invalid vessel length");
  const point = (u: number, angle: number, radius: number) => {
    const f = Math.max(0, Math.min(1, u)), index = f * 512, i = Math.min(511, Math.floor(index)), t = index - i;
    const normal = frames.normals[i]!.clone().lerp(frames.normals[i + 1]!, t).normalize();
    const binormal = frames.binormals[i]!.clone().lerp(frames.binormals[i + 1]!, t).normalize();
    const radial = normal.multiplyScalar(Math.cos(angle)).addScaledVector(binormal, Math.sin(angle)).normalize();
    return { position: curve.getPointAt(f).addScaledVector(radial, radius), radial };
  };
  return { curve, lengthM, point };
}

/** The solver and wall share exactly these outlet origins and directions. */
export function vesselApertures(c: VesselGeometryConfig) {
  const frame = vesselFrame(c); validateApertures(c, frame.lengthM);
  return c.holes.map(h => {
    const { position, radial } = frame.point(h.arcFraction, h.angleRad, c.innerRadiusM + c.wallThicknessM);
    return { id: h.id, positionM: position.toArray() as [number, number, number],
      direction: radial.toArray() as [number, number, number], radiusM: h.radiusM, wallLengthM: c.wallThicknessM,
      dischargeCoefficient: .62 };
  });
}
function canonicalAngle(a: number) { return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; }
function validateApertures(c: VesselGeometryConfig, lengthM: number) {
  if (c.holes.length > 8 || new Set(c.holes.map(h => h.id)).size !== c.holes.length) throw new RangeError("Use up to eight uniquely named apertures");
  for (const h of c.holes) {
    if (!h.id || ![h.arcFraction, h.angleRad, h.radiusM].every(Number.isFinite) || h.radiusM <= 0 ||
        h.radiusM > c.innerRadiusM * .8 || h.arcFraction * lengthM <= h.radiusM ||
        (1 - h.arcFraction) * lengthM <= h.radiusM)
      throw new RangeError("Apertures must fit within the vessel wall");
  }
  for (let i = 0; i < c.holes.length; i++) for (let j = 0; j < i; j++) {
    const a = c.holes[i]!, b = c.holes[j]!;
    if (Math.hypot((a.arcFraction - b.arcFraction) * lengthM,
      canonicalAngle(a.angleRad - b.angleRad) * c.innerRadiusM) <= a.radiusM + b.radiusM)
      throw new RangeError("Vessel apertures must not overlap");
  }
}

/** Conforming subdivision of a triangulated parameter domain. Every shared edge
 * gets one midpoint, including edges adjacent to a true aperture boundary.
 */
function refine(points: Vector2[], initial: number[][], maxEdge: number) {
  let triangles = initial;
  for (let round = 0; round < 9; round++) {
    const split = new Map<string, number>();
    const key = (a: number, b: number) => a < b ? `${a}/${b}` : `${b}/${a}`;
    for (const [a, b, c] of triangles as [number, number, number][]) for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      if (points[u]!.distanceToSquared(points[v]!) <= maxEdge * maxEdge) continue;
      const k = key(u, v);
      if (!split.has(k)) { split.set(k, points.length); points.push(points[u]!.clone().add(points[v]!).multiplyScalar(.5)); }
    }
    if (!split.size) return triangles;
    const next: number[][] = [];
    for (const [a, b, c] of triangles as [number, number, number][]) {
      const ab = split.get(key(a, b)), bc = split.get(key(b, c)), ca = split.get(key(c, a));
      if (ab !== undefined && bc !== undefined && ca !== undefined) next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      else if (ab !== undefined && bc !== undefined) next.push([b, bc, ab], [a, ab, c], [ab, bc, c]);
      else if (bc !== undefined && ca !== undefined) next.push([c, ca, bc], [b, bc, a], [bc, ca, a]);
      else if (ca !== undefined && ab !== undefined) next.push([a, ab, ca], [c, ca, b], [ca, ab, b]);
      else if (ab !== undefined) next.push([a, ab, c], [ab, b, c]);
      else if (bc !== undefined) next.push([b, bc, a], [bc, c, a]);
      else if (ca !== undefined) next.push([c, ca, b], [ca, a, b]);
      else next.push([a, b, c]);
    }
    triangles = next;
    if (triangles.length > 250_000) throw new RangeError("Vessel geometry exceeds the tessellation budget");
  }
  throw new RangeError("Vessel geometry could not meet its edge tolerance");
}

/** Two curved wall surfaces with actual circular parameter-domain apertures,
 * joined by a wall-thickness rim. No transparent masks or dark hole decals.
 */
export function vesselWallData(c: VesselGeometryConfig) {
  const frame = vesselFrame(c); validateApertures(c, frame.lengthM);
  // Put the unwrapped seam in the largest angular gap between apertures.
  const angles = c.holes.map(h => ((h.angleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
  let seam = -Math.PI, largest = -1;
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i]!, b = i + 1 < angles.length ? angles[i + 1]! : angles[0]! + 2 * Math.PI;
    if (b - a > largest) { largest = b - a; seam = (a + b) / 2; }
  }
  const circumference = 2 * Math.PI * c.innerRadiusM;
  const contour = [new Vector2(0, 0), new Vector2(frame.lengthM, 0), new Vector2(frame.lengthM, circumference), new Vector2(0, circumference)];
  const holes = c.holes.map(h => {
    const theta = ((h.angleRad - seam) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI), v = theta * c.innerRadiusM;
    if (v <= h.radiusM || circumference - v <= h.radiusM) throw new RangeError("Aperture crosses the selected vessel seam");
    return Array.from({ length: 32 }, (_, i) => {
      const a = -2 * Math.PI * i / 32;
      return new Vector2(h.arcFraction * frame.lengthM + h.radiusM * Math.cos(a), v + h.radiusM * Math.sin(a));
    });
  });
  const triangles = ShapeUtils.triangulateShape(contour, holes), points = [...contour, ...holes.flat()];
  const refined = refine(points, triangles, Math.min(frame.lengthM / 48, c.innerRadiusM / 4));
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], uvs: number[] = [], colours: number[] = [];
  const append = (p: Vector3, n: Vector3, colour = [1, 1, 1]) => {
    positions.push(p.x * 1000, p.y * 1000, p.z * 1000); normals.push(n.x, n.y, n.z); colours.push(...colour); uvs.push(0, 0);
  };
  for (const radius of [c.innerRadiusM + c.wallThicknessM, c.innerRadiusM]) for (const uv of points) {
    const sample = frame.point(uv.x / frame.lengthM, seam + uv.y / c.innerRadiusM, radius);
    append(sample.position, sample.radial.multiplyScalar(radius === c.innerRadiusM ? -1 : 1));
    // Axial metres and absolute angular turns keep physical texture scale and
    // appearance unchanged when adding a hole moves the triangulation seam.
    uvs[uvs.length - 2] = uv.x; uvs[uvs.length - 1] = (seam + uv.y / c.innerRadiusM) / (2 * Math.PI);
  }
  // ShapeUtils returns positive parameter-domain orientation; mapping u/v has
  // outward normal -cross(du,dv). Reverse the outer side, preserve the inner.
  for (const [a, b, d] of refined as [number, number, number][]) indices.push(a, d, b);
  const outerCount = indices.length;
  for (const [a, b, d] of refined as [number, number, number][]) indices.push(a + points.length, b + points.length, d + points.length);
  const innerCount = indices.length - outerCount;
  const addRim = (uvs: Vector2[], close: boolean) => {
    const steps = close ? uvs.length : uvs.length - 1;
    for (let i = 0; i < steps; i++) {
      const a = uvs[i]!, b = uvs[(i + 1) % uvs.length]!;
      // Illustrative layer bands on the exposed cut wall. Fractions are an
      // authoring convention, not a patient- or vessel-specific measurement.
      const fractions = [0, .12, .7, 1], layerColours = [[.29, .095, .078], [.40, .14, .11], [.39, .235, .185]];
      for (let layer = 0; layer < 3; layer++) {
        const r0 = c.innerRadiusM + c.wallThicknessM * fractions[layer]!, r1 = c.innerRadiusM + c.wallThicknessM * fractions[layer + 1]!;
        const base = positions.length / 3;
        const pa = frame.point(a.x / frame.lengthM, seam + a.y / c.innerRadiusM, r0).position;
        const pb = frame.point(b.x / frame.lengthM, seam + b.y / c.innerRadiusM, r0).position;
        const qa = frame.point(a.x / frame.lengthM, seam + a.y / c.innerRadiusM, r1).position;
        const qb = frame.point(b.x / frame.lengthM, seam + b.y / c.innerRadiusM, r1).position;
        const n = pb.clone().sub(pa).cross(qa.clone().sub(pa)).normalize(), colour = layerColours[layer]!;
        append(pa, n, colour); append(pb, n, colour); append(qa, n, colour); append(qb, n, colour);
        indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }
  };
  for (const h of holes) addRim(h, true);
  for (const x of [0, frame.lengthM]) {
    const rim = Array.from({ length: 65 }, (_, i) => new Vector2(x, circumference * i / 64));
    addRim(x === 0 ? rim : rim.reverse(), false);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices),
    uvs: new Float32Array(uvs), colours: new Float32Array(colours),
    groups: [{ start: 0, count: outerCount, materialIndex: 0 }, { start: outerCount, count: innerCount, materialIndex: 1 },
      { start: outerCount + innerCount, count: indices.length - outerCount - innerCount, materialIndex: 2 }],
    lengthM: frame.lengthM, apertureCount: holes.length };
}
