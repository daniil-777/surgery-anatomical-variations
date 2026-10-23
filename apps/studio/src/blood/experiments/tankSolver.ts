/**
 * Reduced hydrostatic tank, SI units. This is NOT a 3D impact/splash solver.
 *
 * Conserved water-column volume w = H - W(x,z) V(H-y); H is the surface,
 * V is exact sphere-cap/box submerged volume and integral W dA = 1. W is a
 * disclosed spatial regularization, not the sharp immersed body boundary.
 * Constant reference-depth discharge q obeys q_t=-g H0 grad(H)-gamma q,
 * w_t=-div(q), gamma=3 mu/(rho H0²). Body: m y_tt=-mg+rho g integral WV dA.
 * These are reciprocal derivatives of ONE hydrostatic potential energy,
 * not an independently prescribed ripple/buoyancy animation.
 *
 * Face fluxes telescope, closed walls have zero discharge. RK4 integrates the
 * method-of-lines and its viscous-work ledger. Steps are transactional: volume,
 * cumulative energy balance, CFL, depth and slope are checked before commit.
 * The linear horizontal inertia omits advection, vertical added mass, surface
 * tension, shear thinning, impacts/spray, rotation and horizontal body motion.
 */
export interface TankConfig {
  widthM: number; depthM: number; heightM: number; nx: number; nz: number;
  fillDepthM: number; densityKgM3: number; viscosityPaS: number;
  gravityMS2: number; dtSeconds: number; initialWaveAmplitudeM: number;
}
export interface TankDrop {
  shape: "sphere" | "cube";
  radiusM?: number; sizeM?: number;
  xM: number; zM: number; dropHeightM: number; densityKgM3: number;
}
export interface TankBodySnapshot {
  shape: "sphere" | "cube"; positionM: readonly [number, number, number];
  radiusM?: number; sizeM?: number; velocityMS: number;
  submergedVolumeM3: number; densityKgM3: number; massKg: number;
  couplingRadiusM: number; onFloor: boolean;
}
export interface TankSnapshot {
  timeSeconds: number; acceptedSteps: number;
  heightM: Float64Array; fluidColumnM: Float64Array;
  dischargeXM2S: Float64Array; dischargeZM2S: Float64Array;
  body: TankBodySnapshot | null;
  fluidVolumeM3: number; totalEnergyJ: number; dissipatedEnergyJ: number;
}
export interface TankTelemetry {
  relativeVolumeError: number; energyBalanceErrorJ: number;
  relativeEnergyBalanceError: number; viscousDissipationW: number;
  maxColumnVolumeResidualM: number;
  maxSurfaceSlope: number; maxRelativeSurfaceDisplacement: number;
  maxHorizontalFroude: number; cfl: number; couplingOccupancy: number;
  bodyBuoyancyN: number; contactDissipationJ: number;
}
export interface TankStep {
  accepted: boolean; reason?: string; snapshot: TankSnapshot; telemetry: TankTelemetry;
}
export const DEFAULT_TANK_CONFIG: Readonly<TankConfig> = Object.freeze({
  widthM: .15, depthM: .15, heightM: .15, nx: 32, nz: 32,
  fillDepthM: .012, densityKgM3: 1060, viscosityPaS: .00345,
  gravityMS2: 9.81, dtSeconds: .001, initialWaveAmplitudeM: 0,
});

/** Exact volume and first vertical moment about the body centre below plane d. */
export function submergedGeometry(shape: "sphere" | "cube", halfExtentM: number, d: number) {
  const r = halfExtentM, a = Math.max(-r, Math.min(r, d));
  if (d <= -r) return { volumeM3: 0, momentM4: 0, waterplaneAreaM2: 0 };
  if (d >= r) return { volumeM3: shape === "sphere" ? 4 * Math.PI * r ** 3 / 3 : (2 * r) ** 3,
    momentM4: 0, waterplaneAreaM2: 0 };
  if (shape === "cube") {
    const area = 4 * r * r;
    return { volumeM3: area * (a + r), momentM4: area * (a * a - r * r) / 2,
      waterplaneAreaM2: d > -r && d < r ? area : 0 };
  }
  return { volumeM3: Math.PI * (r * r * a - a ** 3 / 3 + 2 * r ** 3 / 3),
    momentM4: Math.PI * (r * r * a * a / 2 - a ** 4 / 4 - r ** 4 / 4),
    waterplaneAreaM2: d > -r && d < r ? Math.PI * (r * r - a * a) : 0 };
}

interface Body {
  shape: "sphere" | "cube"; half: number; x: number; z: number; density: number;
  mass: number; couplingRadius: number; occupancy: number; weights: Float64Array;
}
function finite(value: number, name: string) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

export class TankSolver {
  readonly config: Readonly<TankConfig>;
  private readonly n: number;
  private readonly xOffset: number;
  private readonly zOffset: number;
  private readonly yIndex: number;
  private readonly vIndex: number;
  private readonly lossIndex: number;
  private readonly dx: number; private readonly dz: number; private readonly area: number;
  private readonly a: Float64Array; private readonly next: Float64Array;
  private readonly k1: Float64Array; private readonly k2: Float64Array;
  private readonly k3: Float64Array; private readonly k4: Float64Array;
  private readonly temp: Float64Array; private readonly heights: Float64Array;
  private body: Body | null = null;
  private columnResidualM = 0;
  private steps = 0; private initialVolume: number; private referenceEnergy: number;
  private energyScale: number; private contactLoss = 0;
  get timeSeconds() { return this.steps * this.config.dtSeconds; }

  constructor(config: Partial<TankConfig> = {}) {
    const c = { ...DEFAULT_TANK_CONFIG, ...config };
    for (const [key, value] of Object.entries(c)) finite(value, key);
    if (!(c.widthM > 0 && c.depthM > 0 && c.heightM > 0 && c.fillDepthM > 0
      && c.fillDepthM < c.heightM && c.fillDepthM <= .15 * Math.min(c.widthM, c.depthM)))
      throw new RangeError("The reduced tank needs positive geometry and a shallow fill (depth/width ≤0.15)");
    if (!Number.isInteger(c.nx) || !Number.isInteger(c.nz) || c.nx < 8 || c.nz < 8 || c.nx > 96 || c.nz > 96)
      throw new RangeError("Tank resolution must be 8–96 cells per direction");
    if (!(c.densityKgM3 > 0 && c.viscosityPaS >= 0 && c.gravityMS2 > 0 && c.dtSeconds > 0))
      throw new RangeError("Density, gravity and timestep must be positive; viscosity cannot be negative");
    if (Math.abs(c.initialWaveAmplitudeM) > .05 * c.fillDepthM)
      throw new RangeError("The initial standing wave must be at most 5% of fill depth");
    this.config = Object.freeze(c); this.n = c.nx * c.nz;
    this.dx = c.widthM / c.nx; this.dz = c.depthM / c.nz; this.area = this.dx * this.dz;
    const cfl = c.dtSeconds * Math.sqrt(c.gravityMS2 * c.fillDepthM) * Math.hypot(1 / this.dx, 1 / this.dz);
    const dragStep = c.dtSeconds * 3 * c.viscosityPaS / (c.densityKgM3 * c.fillDepthM ** 2);
    if (cfl > .4 || dragStep > .4) throw new RangeError("Fixed timestep exceeds the validated wave/viscous stability envelope");
    this.xOffset = this.n; this.zOffset = this.xOffset + (c.nx - 1) * c.nz;
    this.yIndex = this.zOffset + c.nx * (c.nz - 1); this.vIndex = this.yIndex + 1; this.lossIndex = this.yIndex + 2;
    const length = this.lossIndex + 1;
    this.a = new Float64Array(length); this.next = new Float64Array(length);
    this.k1 = new Float64Array(length); this.k2 = new Float64Array(length);
    this.k3 = new Float64Array(length); this.k4 = new Float64Array(length);
    this.temp = new Float64Array(length); this.heights = new Float64Array(this.n);
    for (let z = 0; z < c.nz; ++z) for (let x = 0; x < c.nx; ++x)
      this.a[z * c.nx + x] = c.fillDepthM + c.initialWaveAmplitudeM * Math.cos(Math.PI * (x + .5) / c.nx);
    this.initialVolume = c.widthM * c.depthM * c.fillDepthM;
    this.referenceEnergy = this.energy(this.a);
    // A meaningful dynamic scale, avoiding a large constant water-energy offset.
    this.energyScale = Math.max(1e-12, .5 * c.densityKgM3 * c.gravityMS2 * c.widthM * c.depthM * c.initialWaveAmplitudeM ** 2);
  }

  /** One object only. Reset the experiment to repeat; dropping is explicit external work. */
  drop(input: TankDrop): TankStep {
    if (this.body) return this.result(false, "This experiment already contains an object; reset before another drop");
    const c = this.config, half = input.shape === "sphere" ? input.radiusM ?? .004 : (input.sizeM ?? .008) / 2;
    for (const [name, value] of Object.entries({ half, xM: input.xM, zM: input.zM, dropHeightM: input.dropHeightM, densityKgM3: input.densityKgM3 })) finite(value, name);
    if (input.shape !== "sphere" && input.shape !== "cube") throw new RangeError("Object must be a sphere or cube");
    if (!(half > 0 && half <= .4 * c.fillDepthM && input.densityKgM3 > 0 && input.dropHeightM >= 0
      && input.dropHeightM <= .1 * c.fillDepthM))
      return this.result(false, "Object size/drop height exceeds the small-entry model (half-size ≤0.4 depth, drop ≤0.1 depth)");
    const couplingRadius = Math.max(5 * half, 3 * Math.max(this.dx, this.dz));
    if (!(input.xM >= couplingRadius && input.xM <= c.widthM - couplingRadius
      && input.zM >= couplingRadius && input.zM <= c.depthM - couplingRadius))
      return this.result(false, "Object must be far enough from the walls for its regularized coupling footprint");
    const weights = new Float64Array(this.n); let sum = 0, maxWeight = 0;
    for (let z = 0; z < c.nz; ++z) for (let x = 0; x < c.nx; ++x) {
      const r2 = (((x + .5) * this.dx - input.xM) ** 2 + ((z + .5) * this.dz - input.zM) ** 2) / couplingRadius ** 2;
      const value = r2 < 1 ? (1 - r2) ** 3 : 0; weights[z * c.nx + x] = value; sum += value * this.area;
    }
    for (let i = 0; i < this.n; ++i) { weights[i] = weights[i]! / sum; maxWeight = Math.max(maxWeight, weights[i]!); }
    const volume = submergedGeometry(input.shape, half, half).volumeM3;
    const occupancy = maxWeight * (input.shape === "sphere" ? Math.PI : 4) * half ** 2;
    if (occupancy >= .45) return this.result(false, "Coupling footprint is too narrow for a positive volume function");
    this.surface(this.a, this.heights);
    let surface = 0; for (let i = 0; i < this.n; ++i) surface += weights[i]! * this.heights[i]! * this.area;
    this.body = { shape: input.shape, half, x: input.xM, z: input.zM, density: input.densityKgM3,
      mass: volume * input.densityKgM3, couplingRadius, occupancy, weights };
    this.a[this.yIndex] = surface + half + input.dropHeightM;
    this.a[this.vIndex] = 0;
    // A trough can be below the footprint average. Ensure insertion is dry.
    this.a[this.yIndex] = Math.max(this.a[this.yIndex]!, Math.max(...this.heights) + half + input.dropHeightM);
    this.referenceEnergy = this.energy(this.a) + this.a[this.lossIndex]! + this.contactLoss;
    this.energyScale = Math.max(this.energyScale, this.body.mass * c.gravityMS2 * (half * 2 + input.dropHeightM));
    return this.result(true);
  }

  /** Solve the strictly monotone local fluid-volume function, not a height clamp. */
  private surface(a: Float64Array, target: Float64Array) {
    const b = this.body; this.columnResidualM = 0;
    for (let i = 0; i < this.n; ++i) {
      const w = a[i]!, weight = b?.weights[i] ?? 0;
      if (!b || weight === 0) { target[i] = w; continue; }
      let h = w;
      for (let iteration = 0; iteration < 12; ++iteration) {
        const geo = submergedGeometry(b.shape, b.half, h - a[this.yIndex]!);
        const residual = h - weight * geo.volumeM3 - w;
        h -= residual / (1 - weight * geo.waterplaneAreaM2);
        if (Math.abs(residual) < 1e-14) break;
      }
      this.columnResidualM = Math.max(this.columnResidualM,
        Math.abs(h - weight * submergedGeometry(b.shape, b.half, h - a[this.yIndex]!).volumeM3 - w));
      target[i] = h;
    }
  }
  private derivative(a: Float64Array, out: Float64Array) {
    out.fill(0); this.surface(a, this.heights);
    const c = this.config, h = this.heights, gamma = 3 * c.viscosityPaS / (c.densityKgM3 * c.fillDepthM ** 2);
    let dischargeSquared = 0;
    for (let z = 0; z < c.nz; ++z) for (let x = 0; x < c.nx - 1; ++x) {
      const left = z * c.nx + x, face = this.xOffset + z * (c.nx - 1) + x, q = a[face]!;
      out[left] = out[left]! - q / this.dx; out[left + 1] = out[left + 1]! + q / this.dx;
      out[face] = -c.gravityMS2 * c.fillDepthM * (h[left + 1]! - h[left]!) / this.dx - gamma * q;
      dischargeSquared += q * q;
    }
    for (let z = 0; z < c.nz - 1; ++z) for (let x = 0; x < c.nx; ++x) {
      const back = z * c.nx + x, face = this.zOffset + z * c.nx + x, q = a[face]!;
      out[back] = out[back]! - q / this.dz; out[back + c.nx] = out[back + c.nx]! + q / this.dz;
      out[face] = -c.gravityMS2 * c.fillDepthM * (h[back + c.nx]! - h[back]!) / this.dz - gamma * q;
      dischargeSquared += q * q;
    }
    out[this.lossIndex] = c.densityKgM3 * this.area / c.fillDepthM * gamma * dischargeSquared;
    if (this.body) {
      const b = this.body, acceleration = -c.gravityMS2 + this.buoyancy(a, h) / b.mass;
      const supported = a[this.yIndex]! <= b.half + 1e-12 && a[this.vIndex]! <= 0 && acceleration <= 0;
      out[this.yIndex] = supported ? 0 : a[this.vIndex]!;
      out[this.vIndex] = supported ? 0 : acceleration;
    }
  }
  private buoyancy(a: Float64Array, h: Float64Array) {
    if (!this.body) return 0;
    let volume = 0; const b = this.body;
    for (let i = 0; i < this.n; ++i) if (b.weights[i])
      volume += b.weights[i]! * submergedGeometry(b.shape, b.half, h[i]! - a[this.yIndex]!).volumeM3 * this.area;
    return this.config.densityKgM3 * this.config.gravityMS2 * volume;
  }
  private rk4(a: Float64Array, dt: number, target: Float64Array) {
    this.derivative(a, this.k1);
    for (let i = 0; i < a.length; ++i) this.temp[i] = a[i]! + .5 * dt * this.k1[i]!;
    this.derivative(this.temp, this.k2);
    for (let i = 0; i < a.length; ++i) this.temp[i] = a[i]! + .5 * dt * this.k2[i]!;
    this.derivative(this.temp, this.k3);
    for (let i = 0; i < a.length; ++i) this.temp[i] = a[i]! + dt * this.k3[i]!;
    this.derivative(this.temp, this.k4);
    for (let i = 0; i < a.length; ++i) target[i] = a[i]! + dt / 6 * (this.k1[i]! + 2 * this.k2[i]! + 2 * this.k3[i]! + this.k4[i]!);
  }
  private energy(a: Float64Array) {
    this.surface(a, this.heights);
    const c = this.config, b = this.body; let potential = 0, kinetic = 0;
    for (let i = 0; i < this.n; ++i) {
      const h = this.heights[i]!; let moment = .5 * h * h;
      if (b && b.weights[i]) {
        const geo = submergedGeometry(b.shape, b.half, h - a[this.yIndex]!);
        moment -= b.weights[i]! * (a[this.yIndex]! * geo.volumeM3 + geo.momentM4);
      }
      potential += moment;
    }
    for (let i = this.xOffset; i < this.yIndex; ++i) kinetic += a[i]! ** 2;
    return c.densityKgM3 * this.area * (c.gravityMS2 * potential + kinetic / (2 * c.fillDepthM))
      + (b ? b.mass * (c.gravityMS2 * a[this.yIndex]! + .5 * a[this.vIndex]! ** 2) : 0);
  }
  private diagnostics(a: Float64Array, contactLoss = this.contactLoss): TankTelemetry {
    const c = this.config, energy = this.energy(a), error = energy + a[this.lossIndex]! + contactLoss - this.referenceEnergy;
    let volume = 0, slope = 0, displacement = 0, maxQX = 0, maxQZ = 0, q2 = 0;
    for (let i = 0; i < this.n; ++i) {
      volume += a[i]! * this.area; displacement = Math.max(displacement, Math.abs(this.heights[i]! - c.fillDepthM) / c.fillDepthM);
      const x = i % c.nx, z = Math.floor(i / c.nx);
      if (x + 1 < c.nx) slope = Math.max(slope, Math.abs(this.heights[i + 1]! - this.heights[i]!) / this.dx);
      if (z + 1 < c.nz) slope = Math.max(slope, Math.abs(this.heights[i + c.nx]! - this.heights[i]!) / this.dz);
    }
    for (let i = this.xOffset; i < this.yIndex; ++i) {
      if (i < this.zOffset) maxQX = Math.max(maxQX, Math.abs(a[i]!));
      else maxQZ = Math.max(maxQZ, Math.abs(a[i]!));
      q2 += a[i]! ** 2;
    }
    const gamma = 3 * c.viscosityPaS / (c.densityKgM3 * c.fillDepthM ** 2);
    return { relativeVolumeError: Math.abs(volume / this.initialVolume - 1), energyBalanceErrorJ: error,
      relativeEnergyBalanceError: Math.abs(error) / this.energyScale,
      maxColumnVolumeResidualM: this.columnResidualM,
      viscousDissipationW: c.densityKgM3 * this.area / c.fillDepthM * gamma * q2,
      maxSurfaceSlope: slope, maxRelativeSurfaceDisplacement: displacement,
      // Conservative vector bound for the staggered discharge field.
      maxHorizontalFroude: Math.hypot(maxQX, maxQZ) / (c.fillDepthM * Math.sqrt(c.gravityMS2 * c.fillDepthM)),
      cfl: c.dtSeconds * Math.sqrt(c.gravityMS2 * c.fillDepthM) * Math.hypot(1 / this.dx, 1 / this.dz),
      couplingOccupancy: this.body?.occupancy ?? 0, bodyBuoyancyN: this.buoyancy(a, this.heights), contactDissipationJ: contactLoss };
  }
  step(): TankStep {
    const dt = this.config.dtSeconds; this.rk4(this.a, dt, this.next);
    let contactLoss = this.contactLoss;
    if (this.body && this.next[this.yIndex]! < this.body.half) {
      // Locate a perfectly inelastic floor contact; no unaccounted velocity clamp.
      let lo = 0, hi = dt;
      for (let i = 0; i < 32; ++i) {
        const mid = .5 * (lo + hi); this.rk4(this.a, mid, this.next);
        if (this.next[this.yIndex]! < this.body.half) hi = mid; else lo = mid;
      }
      this.rk4(this.a, lo, this.next);
      const beforeContact = this.energy(this.next);
      this.next[this.yIndex] = this.body.half; this.next[this.vIndex] = 0;
      contactLoss += beforeContact - this.energy(this.next);
      // Reuse a detached scratch for this rare contact split. The accepted state
      // is still untouched until every guard below passes.
      const contactState = this.next.slice(); this.rk4(contactState, dt - lo, this.next);
    }
    const telemetry = this.diagnostics(this.next, contactLoss);
    const finiteState = this.next.every(Number.isFinite);
    let reason: string | undefined;
    if (!finiteState) reason = "Non-finite candidate";
    else if (telemetry.maxColumnVolumeResidualM > 1e-11) reason = "Nonlinear column-volume solve did not converge";
    else if (telemetry.relativeVolumeError > 1e-10) reason = "Conservative water-volume guard failed";
    else if (contactLoss < this.contactLoss - 1e-13) reason = "Floor-contact energy loss became negative";
    else if (telemetry.relativeEnergyBalanceError > 2e-4) reason = "Cumulative mechanical-energy balance exceeded 0.02%; reduce the fixed timestep";
    else if (telemetry.maxRelativeSurfaceDisplacement > .25 || telemetry.maxSurfaceSlope > .3 || telemetry.maxHorizontalFroude > .3)
      reason = "Motion exceeded the small-amplitude hydrostatic envelope; use a smaller/lighter object or lower drop";
    else if (this.heights.some(h => h <= 0 || h >= this.config.heightM)) reason = "Drying or overflow requires a different fluid model";
    if (reason) return { accepted: false, reason, snapshot: this.snapshot(), telemetry };
    this.a.set(this.next); this.contactLoss = contactLoss; this.steps++;
    return { accepted: true, snapshot: this.snapshot(), telemetry };
  }
  snapshot(): TankSnapshot {
    const c = this.config, totalEnergyJ = this.energy(this.a), b = this.body;
    let volume = 0; for (let i = 0; i < this.n; ++i) volume += this.a[i]! * this.area;
    const body: TankBodySnapshot | null = b ? { shape: b.shape, positionM: [b.x, this.a[this.yIndex]!, b.z],
      ...(b.shape === "sphere" ? { radiusM: b.half } : { sizeM: b.half * 2 }),
      velocityMS: this.a[this.vIndex]!, submergedVolumeM3: this.buoyancy(this.a, this.heights) / (c.densityKgM3 * c.gravityMS2),
      densityKgM3: b.density, massKg: b.mass, couplingRadiusM: b.couplingRadius,
      onFloor: this.a[this.yIndex]! <= b.half + 1e-10 && this.a[this.vIndex]! === 0 } : null;
    return { timeSeconds: this.timeSeconds, acceptedSteps: this.steps, heightM: this.heights.slice(),
      fluidColumnM: this.a.slice(0, this.n), dischargeXM2S: this.a.slice(this.xOffset, this.zOffset),
      dischargeZM2S: this.a.slice(this.zOffset, this.yIndex), body, fluidVolumeM3: volume,
      totalEnergyJ, dissipatedEnergyJ: this.a[this.lossIndex]! + this.contactLoss };
  }
  private result(accepted: boolean, reason?: string): TankStep {
    return { accepted, ...(reason ? { reason } : {}), snapshot: this.snapshot(), telemetry: this.diagnostics(this.a) };
  }
}
