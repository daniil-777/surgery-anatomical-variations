import { ballisticLandingTime, ballisticState, type VesselVector } from "./vesselSolver";

/** Frozen previous-step collector depth, above the flight solver's base plane.
 * Cell averages are reconstructed into the renderer's shared-corner triangle fan.
 */
export interface JetCollectorSurface {
  timeSeconds: number;
  nx: number; nz: number; widthM: number; depthM: number; originXM: number; originZM: number;
  heightM: ArrayLike<number>;
}
export interface JetSurfaceContact {
  timeSeconds: number; positionM: VesselVector;
  /** Optional canonical surface coordinates for a conservative receiving mesh. */
  surface?: { triangle: number; barycentric: VesselVector };
  /** Explicit complete-dissipation source boundary, only at emission time.
   * The flight solver carries its actual emission interval to the receiver. */
  sourceAttachment?: boolean;
}
/** A frozen, caller-owned surface query. Implementations must not mutate any
 * solver state. Throwing aborts the entire flight transaction. */
export interface JetCollisionQuery {
  contact(originM: VesselVector, initialVelocityMS: VesselVector, gravityMS2: VesselVector,
    birthTimeSeconds: number, startTimeSeconds: number, endTimeSeconds: number,
    supportRadiusM: number): JetSurfaceContact | undefined;
}
type Polynomial = readonly [number, number, number]; // a*s²+b*s+c, s within [0,1]
const at = (p: Polynomial, s: number) => (p[0] * s + p[1]) * s + p[2];
const combine = (a: Polynomial, x: number, b: Polynomial, y: number, c = 0): Polynomial =>
  [a[0] * x + b[0] * y, a[1] * x + b[1] * y, a[2] * x + b[2] * y + c];
function roots(p: Polynomial): number[] {
  const scale = Math.max(...p.map(Math.abs));
  if (scale === 0) return [];
  const [a, b, c] = p.map(x => x / scale) as [number, number, number];
  if (a === 0) return b === 0 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  const tolerance = 16 * Number.EPSILON * (b * b + Math.abs(4 * a * c));
  if (discriminant < -tolerance) return [];
  const q = -.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(Math.max(0, discriminant)));
  return q === 0 ? [-b / (2 * a)] : [q / a, c / q];
}

/** Continuous parabola/height-graph intersections over one accepted timestep.
 * Drop support remains a vertical radius offset, not a full sphere/facet-edge
 * collision. No splash, radial impulse, or post-impact trajectory is added.
 */
export class JetCollectorCollision {
  private readonly corners: Float64Array;
  private readonly dx: number; private readonly dz: number;
  private readonly maximumHeightM: number;
  private readonly surface: Omit<JetCollectorSurface, "heightM">;
  constructor(input: JetCollectorSurface, previousTimeSeconds: number, private readonly baseYM: number) {
    if (![input.timeSeconds, input.widthM, input.depthM, input.originXM, input.originZM, baseYM].every(Number.isFinite)
      || Math.abs(input.timeSeconds - previousTimeSeconds) > Math.max(1e-12, Math.abs(previousTimeSeconds) * 1e-12)
      || ![input.nx, input.nz].every(n => Number.isInteger(n) && n >= 2 && n <= 256)
      || input.widthM < 1e-6 || input.widthM > 2 || input.depthM < 1e-6 || input.depthM > 2
      || Math.abs(input.originXM) > 10 || Math.abs(input.originZM) > 10
      || input.heightM.length !== input.nx * input.nz)
      throw new RangeError("Collector collision requires the previous accepted finite height-field geometry");
    let maximumDepthM = 0;
    for (let i = 0; i < input.heightM.length; i++) {
      if (!Number.isFinite(input.heightM[i]) || input.heightM[i]! < 0 || input.heightM[i]! > 2)
        throw new RangeError("Collector collision depths must be finite within 0–2 metres");
      maximumDepthM = Math.max(maximumDepthM, input.heightM[i]!);
    }
    this.maximumHeightM = baseYM + maximumDepthM;
    const { heightM: _heights, ...shape } = input; this.surface = shape;
    this.dx = input.widthM / input.nx; this.dz = input.depthM / input.nz;
    this.corners = new Float64Array((input.nx + 1) * (input.nz + 1));
    const cell = (x: number, z: number) => input.heightM[Math.max(0, Math.min(input.nz - 1, z)) * input.nx
      + Math.max(0, Math.min(input.nx - 1, x))]!;
    for (let z = 0; z <= input.nz; z++) for (let x = 0; x <= input.nx; x++)
      this.corners[z * (input.nx + 1) + x] = (cell(x - 1, z - 1) + cell(x, z - 1) + cell(x - 1, z) + cell(x, z)) * .25;
  }
  private heights(x: number, z: number) {
    const i = z * (this.surface.nx + 1) + x, stride = this.surface.nx + 1;
    return [this.corners[i]!, this.corners[i + 1]!, this.corners[i + stride]!, this.corners[i + stride + 1]!] as const;
  }
  /** Graph height in world metres; outside the finite tray is the base plane. */
  heightAt(xM: number, zM: number): number {
    const c = this.surface, x = (xM - c.originXM) / this.dx, z = (zM - c.originZM) / this.dz;
    if (x < 0 || x > c.nx || z < 0 || z > c.nz) return this.baseYM;
    const ix = Math.min(c.nx - 1, Math.floor(x)), iz = Math.min(c.nz - 1, Math.floor(z));
    const u = x - ix, v = z - iz, [a, b, d, e] = this.heights(ix, iz), h = (a + b + d + e) / 4;
    const depth = v <= Math.min(u, 1 - u) ? (1 - u - v) * a + (u - v) * b + 2 * v * h
      : u >= Math.max(v, 1 - v) ? (u - v) * b + (u + v - 1) * e + 2 * (1 - u) * h
        : v >= Math.max(u, 1 - u) ? (v - u) * d + (u + v - 1) * e + 2 * (1 - v) * h
          : (1 - u - v) * a + (v - u) * d + 2 * u * h;
    return this.baseYM + depth;
  }
  contact(originM: VesselVector, initialVelocityMS: VesselVector, gravityMS2: VesselVector,
    birthTimeSeconds: number, startTimeSeconds: number, endTimeSeconds: number, supportRadiusM: number): JetSurfaceContact | undefined {
    const start = Math.max(startTimeSeconds, birthTimeSeconds), duration = endTimeSeconds - start;
    if (![...originM, ...initialVelocityMS, ...gravityMS2, birthTimeSeconds, start, duration, supportRadiusM].every(Number.isFinite)
      || duration < 0 || supportRadiusM < 0 || gravityMS2[1] > 0)
      throw new RangeError("Invalid continuous collector trajectory");
    const initial = ballisticState(originM, initialVelocityMS, gravityMS2, start - birthTimeSeconds);
    const p = initial.positionM, velocity = initial.velocityMS;
    const firstHeight = this.heightAt(p[0], p[2]);
    if (p[1] - supportRadiusM <= firstHeight)
      return { timeSeconds: start, positionM: [p[0], firstHeight, p[2]] };
    if (duration === 0) return undefined;
    let contact: JetSurfaceContact | undefined;
    const floorAge = ballisticLandingTime(Math.max(0, p[1] - supportRadiusM - this.baseYM), velocity[1], gravityMS2[1]);
    if (floorAge <= duration) {
      const hit = ballisticState(p, velocity, gravityMS2, floorAge).positionM;
      contact = { timeSeconds: start + floorAge, positionM: [hit[0], this.baseYM, hit[2]] };
    }
    // Vertical acceleration is nonpositive, so the interval minimum is at an
    // endpoint. Most airborne material cannot reach even the tallest film cell.
    if (Math.min(p[1], p[1] + velocity[1] * duration + .5 * gravityMS2[1] * duration ** 2)
      - supportRadiusM > this.maximumHeightM) return contact;
    const x: Polynomial = [.5 * gravityMS2[0] * duration ** 2, velocity[0] * duration, p[0]];
    const y: Polynomial = [.5 * gravityMS2[1] * duration ** 2, velocity[1] * duration, p[1] - supportRadiusM];
    const z: Polynomial = [.5 * gravityMS2[2] * duration ** 2, velocity[2] * duration, p[2]];
    const extent = (q: Polynomial) => {
      const values = [at(q, 0), at(q, 1)], turning = -q[1] / (2 * q[0]);
      if (turning > 0 && turning < 1) values.push(at(q, turning));
      return [Math.min(...values), Math.max(...values)] as const;
    };
    const c = this.surface, [minX, maxX] = extent(x), [minZ, maxZ] = extent(z);
    if (maxX < c.originXM || minX > c.originXM + c.widthM || maxZ < c.originZM || minZ > c.originZM + c.depthM) return contact;
    const x0 = Math.max(0, Math.min(c.nx - 1, Math.floor((minX - c.originXM) / this.dx)));
    const x1 = Math.max(0, Math.min(c.nx - 1, Math.floor((maxX - c.originXM) / this.dx)));
    const z0 = Math.max(0, Math.min(c.nz - 1, Math.floor((minZ - c.originZM) / this.dz)));
    const z1 = Math.max(0, Math.min(c.nz - 1, Math.floor((maxZ - c.originZM) / this.dz)));
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096)
      throw new RangeError("Collector collision traversal exceeds 4096 cells per trajectory; step rolled back");
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const [a, b, d, e] = this.heights(ix, iz), h = (a + b + d + e) / 4;
      if (Math.min(at(y, 0), at(y, 1)) > this.baseYM + Math.max(a, b, d, e)) continue;
      const vertices = [[0, 0, a], [1, 0, b], [1, 1, e], [0, 1, d], [.5, .5, h]] as const;
      const u: Polynomial = [x[0] / this.dx, x[1] / this.dx, (x[2] - c.originXM) / this.dx - ix];
      const v: Polynomial = [z[0] / this.dz, z[1] / this.dz, (z[2] - c.originZM) / this.dz - iz];
      for (let edge = 0; edge < 4; edge++) {
        const A = vertices[edge]!, B = vertices[(edge + 1) % 4]!, C = vertices[4];
        const bu = B[0] - A[0], bv = B[1] - A[1], cu = C[0] - A[0], cv = C[1] - A[1], determinant = bu * cv - bv * cu;
        const beta = combine(u, cv / determinant, v, -cu / determinant, (-A[0] * cv + A[1] * cu) / determinant);
        const gamma = combine(u, -bv / determinant, v, bu / determinant, (A[0] * bv - A[1] * bu) / determinant);
        const alpha = combine(beta, -1, gamma, -1, 1);
        const height = combine(beta, B[2] - A[2], gamma, C[2] - A[2], this.baseYM + A[2]);
        const gap = combine(y, 1, height, -1);
        const candidates = [0, 1, ...roots(gap), ...roots(alpha), ...roots(beta), ...roots(gamma)]
          .filter(t => Number.isFinite(t) && t >= -1e-12 && t <= 1 + 1e-12).map(t => Math.max(0, Math.min(1, t))).sort((a, b) => a - b);
        for (const t of candidates) {
          const time = start + t * duration;
          if (contact && time >= contact.timeSeconds) break;
          if (at(alpha, t) < -1e-10 || at(beta, t) < -1e-10 || at(gamma, t) < -1e-10 || at(gap, t) > 1e-12) continue;
          contact = { timeSeconds: time, positionM: [Math.max(c.originXM, Math.min(c.originXM + c.widthM, at(x, t))),
            at(height, t), Math.max(c.originZM, Math.min(c.originZM + c.depthM, at(z, t)))] };
          break;
        }
      }
    }
    return contact;
  }
}
