/**
 * Geometry-aware elastic sculpting for atlas triangle surfaces.
 *
 * A regularized Kelvinlet grab is restricted to a mesh-geodesic support, then
 * regularized in displacement space. A local volume projection is enabled only
 * for consistently oriented, closed manifold components. This is an artistic
 * surface deformer, not a patient-calibrated finite-element tissue simulation.
 * See docs/research/ANATOMY_SCULPT_2026-10-07.md for derivation and limitations.
 */

export type SculptPoint = readonly [number, number, number];

export interface SurfaceSculptOptions {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Immutable generated specimen used to guard cumulative stroke orientation. */
  guardPositions?: ArrayLike<number>;
  /** Triangle ordinal from the raycast, not an offset into indices. */
  faceIndex: number;
  /** Mesh-local raycast point, in the same units as positions. */
  point: SculptPoint;
  radius: number;
  /** Artistic resistance in [0,1], not a measured elastic modulus. */
  stiffness?: number;
  /** Closed-component volume correction strength in [0,1]. */
  preserveVolume?: number;
}

export interface SurfaceSculptDiagnostics {
  affectedVertices: number;
  effectiveRadius: number;
  appliedFraction: number;
  maxDisplacement: number;
  volumeChangeFraction: number | null;
  guarded: boolean;
  closedComponent: boolean;
}

export interface SurfaceSculptResult {
  positions: Float32Array;
  diagnostics: SurfaceSculptDiagnostics;
}

export interface SurfaceSculptStroke {
  /** Always relative to the immutable stroke-start positions. */
  update(delta: SculptPoint): SurfaceSculptResult;
}

class MinHeap {
  private ids: number[] = [];
  private values: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, value: number) {
    let i = this.ids.length;
    this.ids.push(id); this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent]! <= value) break;
      this.ids[i] = this.ids[parent]!; this.values[i] = this.values[parent]!;
      i = parent;
    }
    this.ids[i] = id; this.values[i] = value;
  }
  pop(): [number, number] {
    const result: [number, number] = [this.ids[0]!, this.values[0]!];
    const id = this.ids.pop()!, value = this.values.pop()!;
    if (!this.ids.length) return result;
    let i = 0;
    while (i * 2 + 1 < this.ids.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.ids.length && this.values[child + 1]! < this.values[child]!) child++;
      if (this.values[child]! >= value) break;
      this.ids[i] = this.ids[child]!; this.values[i] = this.values[child]!;
      i = child;
    }
    this.ids[i] = id; this.values[i] = value;
    return result;
  }
}

function unit(value: number | undefined, fallback: number) {
  return value === undefined ? fallback : Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

/** Signed volume in a translated coordinate frame, to avoid large-offset cancellation. */
function faceVolume(p: ArrayLike<number>, a: number, b: number, c: number, origin: SculptPoint) {
  const ax = p[a]! - origin[0], ay = p[a + 1]! - origin[1], az = p[a + 2]! - origin[2];
  const bx = p[b]! - origin[0], by = p[b + 1]! - origin[1], bz = p[b + 2]! - origin[2];
  const cx = p[c]! - origin[0], cy = p[c + 1]! - origin[1], cz = p[c + 2]! - origin[2];
  return (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
}

export function beginSurfaceSculpt(options: SurfaceSculptOptions): SurfaceSculptStroke {
  const { point, faceIndex } = options;
  if (!Number.isFinite(options.radius) || options.radius <= 0) throw new Error("Sculpt radius must be positive and finite.");
  if (!point.every(Number.isFinite)) throw new Error("Sculpt point must be finite.");
  const rest = Float32Array.from(options.positions);
  const vertexCount = rest.length / 3;
  if (!Number.isInteger(vertexCount) || vertexCount < 3 || !rest.every(Number.isFinite)) throw new Error("Sculpt positions must contain finite XYZ vertices.");
  const guard = options.guardPositions ? Float32Array.from(options.guardPositions) : rest;
  if (guard.length !== rest.length || !guard.every(Number.isFinite)) throw new Error("Sculpt guard positions must match the source vertices.");
  if (options.indices.length % 3 || !options.indices.length) throw new Error("Sculpt indices must contain triangles.");
  const faces = Uint32Array.from(options.indices);
  for (let i = 0; i < options.indices.length; i++) {
    const index = options.indices[i]!;
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) throw new Error("Sculpt triangle index is out of range.");
  }
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex * 3 >= faces.length) throw new Error("Sculpt raycast triangle is out of range.");
  const stiffness = unit(options.stiffness, 0.45);
  const preserveVolume = unit(options.preserveVolume, 0.9);
  const neighbors = Array.from({ length: vertexCount }, () => new Set<number>());
  const edges = new Map<number, { a: number; b: number; count: number; orientation: number }>();
  for (let f = 0; f < faces.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = faces[f + k]!, b = faces[f + (k + 1) % 3]!;
      if (a === b) continue;
      neighbors[a]!.add(b); neighbors[b]!.add(a);
      const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * vertexCount + hi;
      const edge = edges.get(key);
      const orientation = a < b ? 1 : -1;
      if (edge) { edge.count++; edge.orientation += orientation; }
      else edges.set(key, { a: lo, b: hi, count: 1, orientation });
    }
  }
  const adjacency = neighbors.map((row) => Array.from(row));
  const seed = [faces[faceIndex * 3]!, faces[faceIndex * 3 + 1]!, faces[faceIndex * 3 + 2]!];
  const seedDistances = seed.map((v) => Math.hypot(rest[v * 3]! - point[0], rest[v * 3 + 1]! - point[1], rest[v * 3 + 2]! - point[2]));
  // A brush smaller than its hit triangle otherwise moves one vertex as a spike.
  const radius = Math.max(options.radius, Math.max(...seedDistances) * 2.05, 1e-9);
  const distances = new Float64Array(vertexCount).fill(Infinity);
  const heap = new MinHeap();
  seed.forEach((v, i) => { distances[v] = seedDistances[i]!; heap.push(v, distances[v]!); });
  while (heap.size) {
    const [v, distance] = heap.pop();
    if (distance !== distances[v] || distance >= radius) continue;
    for (const n of adjacency[v]!) {
      const d = distance + Math.hypot(rest[v * 3]! - rest[n * 3]!, rest[v * 3 + 1]! - rest[n * 3 + 1]!, rest[v * 3 + 2]! - rest[n * 3 + 2]!);
      if (d < radius && d < distances[n]!) { distances[n] = d; heap.push(n, d); }
    }
  }
  const active: number[] = [];
  const weights = new Float64Array(vertexCount);
  const mobility = new Float64Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const q = distances[v]! / radius;
    if (q >= 1) continue;
    active.push(v);
    weights[v] = (1 - q) ** 4 * (1 + 4 * q);
    // Compensating bulge in the surrounding tissue; keep the grasp core stable.
    mobility[v] = weights[v]! * (1 - weights[v]!) ** 2;
  }
  const component = new Uint8Array(vertexCount);
  const queue = [seed[0]!];
  component[seed[0]!] = 1;
  for (let i = 0; i < queue.length; i++) {
    for (const n of adjacency[queue[i]!]!) if (!component[n]) { component[n] = 1; queue.push(n); }
  }
  let closedComponent = true;
  const guardedEdges: { a: number; b: number; lengthSquared: number }[] = [];
  for (const edge of edges.values()) {
    if (component[edge.a] && (edge.count !== 2 || edge.orientation !== 0)) closedComponent = false;
    if (!weights[edge.a] && !weights[edge.b]) continue;
    const a = edge.a * 3, b = edge.b * 3;
    guardedEdges.push({ a, b, lengthSquared: (rest[a]! - rest[b]!) ** 2 + (rest[a + 1]! - rest[b + 1]!) ** 2 + (rest[a + 2]! - rest[b + 2]!) ** 2 });
  }
  const changedFaces: { a: number; b: number; c: number; nx: number; ny: number; nz: number; areaSquared: number; gx: number; gy: number; gz: number; guardAreaSquared: number }[] = [];
  let restVolume = 0, fixedVolume = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const ai = faces[f]!, bi = faces[f + 1]!, ci = faces[f + 2]!;
    if (!component[ai]) continue;
    const a = ai * 3, b = bi * 3, c = ci * 3;
    const volume = faceVolume(rest, a, b, c, point);
    restVolume += volume;
    const ux = rest[b]! - rest[a]!, uy = rest[b + 1]! - rest[a + 1]!, uz = rest[b + 2]! - rest[a + 2]!;
    const vx = rest[c]! - rest[a]!, vy = rest[c + 1]! - rest[a + 1]!, vz = rest[c + 2]! - rest[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const areaSquared = nx * nx + ny * ny + nz * nz;
    const gux = guard[b]! - guard[a]!, guy = guard[b + 1]! - guard[a + 1]!, guz = guard[b + 2]! - guard[a + 2]!;
    const gvx = guard[c]! - guard[a]!, gvy = guard[c + 1]! - guard[a + 1]!, gvz = guard[c + 2]! - guard[a + 2]!;
    const gx = guy * gvz - guz * gvy, gy = guz * gvx - gux * gvz, gz = gux * gvy - guy * gvx;
    const guardAreaSquared = gx * gx + gy * gy + gz * gz;
    if (areaSquared <= 1e-28) closedComponent = false;
    if (weights[ai] || weights[bi] || weights[ci]) changedFaces.push({ a, b, c, nx, ny, nz, areaSquared, gx, gy, gz, guardAreaSquared });
    else fixedVolume += volume;
  }
  if (Math.abs(restVolume) < radius ** 3 * 1e-10) closedComponent = false;
  const volumeOf = (p: ArrayLike<number>) => {
    let volume = fixedVolume;
    for (const { a, b, c } of changedFaces) volume += faceVolume(p, a, b, c, point);
    return volume;
  };
  const target = new Float64Array(rest.length);
  let displacement = new Float64Array(rest.length);
  let scratch = new Float64Array(rest.length);
  const gradient = new Float64Array(rest.length);
  const candidate = new Float64Array(rest.length);
  const epsilon = radius * 0.45;
  // Kelvinlet constants after cancelling the shear modulus in a displacement-driven brush.
  const b = 1 / (4 * (1 - 0.49));
  const normalization = epsilon / (1.5 - b);
  const smoothing = 0.3 + stiffness * 1.7;

  const safe = (positions: ArrayLike<number>) => {
    for (const { a, b, lengthSquared } of guardedEdges) {
      if (lengthSquared < 1e-20) continue;
      const ratio = ((positions[a]! - positions[b]!) ** 2 + (positions[a + 1]! - positions[b + 1]!) ** 2 + (positions[a + 2]! - positions[b + 2]!) ** 2) / lengthSquared;
      if (!Number.isFinite(ratio) || ratio < 0.16 || ratio > 4) return false;
    }
    for (const { a, b, c, nx, ny, nz, areaSquared, gx, gy, gz, guardAreaSquared } of changedFaces) {
      if (areaSquared <= 1e-28) continue;
      const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
      const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
      const projection = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
      if (!Number.isFinite(projection) || projection < areaSquared * 0.12) return false;
      const referenceProjection = (uy * vz - uz * vy) * gx + (uz * vx - ux * vz) * gy + (ux * vy - uy * vx) * gz;
      if (guardAreaSquared > 1e-28 && (!Number.isFinite(referenceProjection) || referenceProjection < guardAreaSquared * 0.02)) return false;
    }
    return true;
  };

  return {
    update(delta) {
      if (!delta.every(Number.isFinite)) throw new Error("Sculpt displacement must be finite.");
      const magnitude = Math.hypot(...delta);
      const limit = radius * 0.7;
      const limitedFraction = magnitude > limit ? limit / magnitude : 1;
      const response = limitedFraction / (1 + stiffness * 1.8);
      const dx = delta[0] * response, dy = delta[1] * response, dz = delta[2] * response;
      for (const v of active) {
        const i = v * 3;
        const rx = rest[i]! - point[0], ry = rest[i + 1]! - point[1], rz = rest[i + 2]! - point[2];
        const r = Math.sqrt(rx * rx + ry * ry + rz * rz + epsilon * epsilon);
        const isotropic = ((1 - b) / r + 0.5 * epsilon * epsilon / r ** 3) * normalization * weights[v]!;
        const radial = b / r ** 3 * normalization * weights[v]! * (rx * dx + ry * dy + rz * dz);
        target[i] = isotropic * dx + radial * rx;
        target[i + 1] = isotropic * dy + radial * ry;
        target[i + 2] = isotropic * dz + radial * rz;
      }
      displacement.set(target);
      // Screened displacement smoothing preserves the input surface's fine details.
      for (let iteration = 0; iteration < 5; iteration++) {
        for (const v of active) {
          const row = adjacency[v]!, i = v * 3;
          let x = 0, y = 0, z = 0;
          for (const n of row) { x += displacement[n * 3]!; y += displacement[n * 3 + 1]!; z += displacement[n * 3 + 2]!; }
          const inverseDegree = row.length ? 1 / row.length : 0;
          scratch[i] = (target[i]! + smoothing * x * inverseDegree) / (1 + smoothing);
          scratch[i + 1] = (target[i + 1]! + smoothing * y * inverseDegree) / (1 + smoothing);
          scratch[i + 2] = (target[i + 2]! + smoothing * z * inverseDegree) / (1 + smoothing);
        }
        [scratch, displacement] = [displacement, scratch];
      }
      candidate.set(rest);
      for (const v of active) for (let k = 0; k < 3; k++) candidate[v * 3 + k] = candidate[v * 3 + k]! + displacement[v * 3 + k]!;
      if (closedComponent && preserveVolume > 0 && magnitude > 0) {
        const desiredVolume = restVolume + (volumeOf(candidate) - restVolume) * (1 - preserveVolume);
        for (let iteration = 0; iteration < 3; iteration++) {
          gradient.fill(0);
          for (const { a, b, c } of changedFaces) {
            const corners = [a, b, c];
            for (let corner = 0; corner < 3; corner++) {
              const i = corners[corner]!, j = corners[(corner + 1) % 3]!, k = corners[(corner + 2) % 3]!;
              if (!mobility[i / 3]) continue;
              const jx = candidate[j]! - point[0], jy = candidate[j + 1]! - point[1], jz = candidate[j + 2]! - point[2];
              const kx = candidate[k]! - point[0], ky = candidate[k + 1]! - point[1], kz = candidate[k + 2]! - point[2];
              gradient[i] = gradient[i]! + (jy * kz - jz * ky) / 6;
              gradient[i + 1] = gradient[i + 1]! + (jz * kx - jx * kz) / 6;
              gradient[i + 2] = gradient[i + 2]! + (jx * ky - jy * kx) / 6;
            }
          }
          let denominator = 0;
          for (const v of active) {
            const i = v * 3;
            denominator += mobility[v]! * (gradient[i]! ** 2 + gradient[i + 1]! ** 2 + gradient[i + 2]! ** 2);
          }
          if (denominator < 1e-24) break;
          const lambda = (desiredVolume - volumeOf(candidate)) / denominator;
          let largestCorrection = 0;
          for (const v of active) largestCorrection = Math.max(largestCorrection, Math.abs(lambda) * mobility[v]! * Math.hypot(gradient[v * 3]!, gradient[v * 3 + 1]!, gradient[v * 3 + 2]!));
          const scale = Math.min(1, radius * 0.12 / Math.max(largestCorrection, 1e-20));
          for (const v of active) for (let k = 0; k < 3; k++) candidate[v * 3 + k] = candidate[v * 3 + k]! + lambda * scale * mobility[v]! * gradient[v * 3 + k]!;
        }
      }
      const positions = new Float32Array(rest);
      let fraction = 1;
      let accepted = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        for (const v of active) for (let k = 0; k < 3; k++) {
          const i = v * 3 + k;
          positions[i] = rest[i]! + (candidate[i]! - rest[i]!) * fraction;
        }
        if (safe(positions)) { accepted = true; break; }
        fraction *= 0.5;
      }
      if (!accepted) { positions.set(rest); fraction = 0; }
      let maxDisplacement = 0;
      for (const v of active) maxDisplacement = Math.max(maxDisplacement, Math.hypot(positions[v * 3]! - rest[v * 3]!, positions[v * 3 + 1]! - rest[v * 3 + 1]!, positions[v * 3 + 2]! - rest[v * 3 + 2]!));
      return {
        positions,
        diagnostics: {
          affectedVertices: active.length, effectiveRadius: radius,
          appliedFraction: fraction * limitedFraction,
          maxDisplacement,
          volumeChangeFraction: closedComponent ? (volumeOf(positions) - restVolume) / Math.abs(restVolume) : null,
          guarded: fraction < 1 || limitedFraction < 1,
          closedComponent,
        },
      };
    },
  };
}
