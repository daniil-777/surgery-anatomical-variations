/**
 * Inertial local collector: 2D depth-averaged mass and horizontal momentum.
 * Conservative Rusanov Saint-Venant fluxes, variational graph capillary pressure,
 * SSPRK2 and exact split laminar basal drag. SI throughout; closed tray walls.
 * Incoming horizontal momentum is deposited; vertical impact energy is lost
 * explicitly, with no invented radial splash impulse. See COLLECTOR_MODEL.md.
 */
import type { CollectorCheckpoint, CollectorConfig } from "./collectorThinFilm";
export type { CollectorCheckpoint, CollectorConfig } from "./collectorThinFilm";
export { DEFAULT_COLLECTOR_CONFIG } from "./collectorThinFilm";
import { DEFAULT_COLLECTOR_CONFIG } from "./collectorThinFilm";

export interface CollectorDeposit {
  id: number; timeSeconds: number; positionM: readonly [number, number, number];
  velocityMS: readonly [number, number, number]; volumeM3: number;
}
export interface CollectorSnapshot {
  timeSeconds: number; heightM: Float64Array; momentumXM2S: Float64Array; momentumZM2S: Float64Array;
  initialFilmVolumeM3: number; depositedVolumeM3: number; escapedVolumeM3: number;
  inputVolumeM3: number; filmVolumeM3: number; volumeErrorM3: number;
  energyJ: number; sourceEnergyJ: number; dissipatedEnergyJ: number; energyBalanceErrorJ: number;
  basalDissipatedEnergyJ: number; numericalDissipatedEnergyJ: number; impactDissipatedEnergyJ: number;
  depositedMomentumXKgMS: number; depositedMomentumZKgMS: number;
  maxSlope: number; steepFrontWarning: boolean;
}
export interface CollectorTelemetry {
  substeps: number; retries: number; minimumHeightM: number; maximumHeightM: number;
  minimumSubstepSeconds: number; relativeVolumeError: number; energyBalanceErrorJ: number;
  maxSlope: number; steepFrontWarning: boolean; maxFilmReynolds: number; maxSpeedMS: number; maxCourant: number;
}
export interface CollectorStep { accepted: boolean; reason?: string; snapshot: CollectorSnapshot; telemetry: CollectorTelemetry }
export interface CollectorPreparedStep extends CollectorStep { commit(): void }
interface Ledger {
  deposited: number; escaped: number; input: number; sourceEnergy: number;
  basal: number; numerical: number; impact: number; momentumX: number; momentumZ: number;
}
function compensated(a: Float64Array, offset: number, count: number) {
  let total = 0, compensation = 0;
  for (let i = offset; i < offset + count; i++) { const y = a[i]! - compensation, t = total + y; compensation = (t - total) - y; total = t; }
  return total;
}
/** Symmetric four-quadrant graph-area quadrature, with the exact discrete
 * variational pressure. No linear-curvature approximation at steep fronts.
 * Interior differences converge to -sigma div(grad h/sqrt(1+|grad h|²)).
 */
function graphCapillarity(h: ArrayLike<number>, nx: number, nz: number, dx: number, dz: number,
  sigma: number, pressure?: Float64Array) {
  pressure?.fill(0); let energy = 0;
  if (sigma === 0) return 0;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const i = z * nx + x, a = h[i]!;
    for (let sideX = -1; sideX <= 1; sideX += 2) for (let sideZ = -1; sideZ <= 1; sideZ += 2) {
      const j = x + sideX < 0 || x + sideX >= nx ? i : i + sideX;
      const k = z + sideZ < 0 || z + sideZ >= nz ? i : i + sideZ * nx;
      const sx = (h[j]! - a) / dx, sz = (h[k]! - a) / dz, square = sx * sx + sz * sz, norm = Math.sqrt(1 + square);
      energy += sigma * .25 * square / (norm + 1); // stable sqrt(1+s²)-1
      if (pressure) {
        const px = sigma * .25 * sx / (norm * dx), pz = sigma * .25 * sz / (norm * dz);
        pressure[i]! -= px + pz; pressure[j]! += px; pressure[k]! += pz;
      }
    }
  }
  return energy * dx * dz;
}
export function collectorCapillaryGeometry(h: ArrayLike<number>, nx: number, nz: number, dx: number, dz: number, sigma: number) {
  if (!Number.isInteger(nx) || !Number.isInteger(nz) || nx < 2 || nz < 2 || h.length !== nx * nz
    || ![dx, dz, sigma].every(Number.isFinite) || dx <= 0 || dz <= 0 || sigma < 0
    || !Array.from(h).every(Number.isFinite)) throw new RangeError("Invalid capillary graph");
  const pressurePa = new Float64Array(nx * nz), energyJ = graphCapillarity(h, nx, nz, dx, dz, sigma, pressurePa);
  return { energyJ, pressurePa };
}

/** Name retained for the collector integration API; this model includes inertia.
 * The independently restricted creeping-film oracle is CollectorThinFilm.
 */
export class CollectorFilm {
  readonly config: Readonly<CollectorConfig>;
  private readonly n: number; private readonly dx: number; private readonly dz: number; private readonly area: number;
  private readonly state: Float64Array; private readonly candidate: Float64Array;
  private readonly start: Float64Array; private readonly middle: Float64Array; private readonly trial: Float64Array;
  private readonly rate: Float64Array; private readonly capillary: Float64Array;
  private readonly seen = new Set<number>(); private readonly seenOrder: number[] = [];
  private readonly checkpoints = new WeakMap<CollectorCheckpoint, {
    state: Float64Array; ledger: Ledger; steps: number; seenCount: number; lineage: number;
  }>();
  private lineage = 0; private generation = 0; private steps = 0;
  private readonly initialVolume: number; private readonly initialEnergy: number;
  private ledger: Ledger = { deposited: 0, escaped: 0, input: 0, sourceEnergy: 0, basal: 0, numerical: 0,
    impact: 0, momentumX: 0, momentumZ: 0 };
  constructor(config: Partial<CollectorConfig> = {}, initialHeightM?: ArrayLike<number>) {
    const c = { ...DEFAULT_COLLECTOR_CONFIG, ...config };
    for (const k of ["widthM", "depthM", "precursorHeightM", "densityKgM3", "dtSeconds", "maxSlope"] as const)
      if (!Number.isFinite(c[k]) || c[k] <= 0) throw new RangeError(`${k} must be finite and positive`);
    if (![c.originXM, c.originZM, c.viscosityPaS, c.surfaceTensionNm, c.gravityMS2].every(Number.isFinite)
      || c.viscosityPaS < 0 || c.surfaceTensionNm < 0 || c.gravityMS2 < 0 || c.widthM > 2 || c.depthM > 2
      || c.maxSlope > .3 || c.dtSeconds > .1) throw new RangeError("Invalid collector geometry, material or slope-warning threshold");
    for (const k of ["nx", "nz"] as const)
      if (!Number.isInteger(c[k]) || c[k] < 8 || c[k] > 128) throw new RangeError("Use 8–128 collector cells per axis");
    if (!Number.isInteger(c.maxSubsteps) || c.maxSubsteps < 1 || c.maxSubsteps > 100_000) throw new RangeError("Invalid collector work budget");
    this.config = Object.freeze(c); this.n = c.nx * c.nz; this.dx = c.widthM / c.nx; this.dz = c.depthM / c.nz; this.area = this.dx * this.dz;
    if (initialHeightM && initialHeightM.length !== this.n) throw new RangeError("Invalid collector initial grid");
    this.state = new Float64Array(3 * this.n);
    this.state.set(initialHeightM ? Float64Array.from(initialHeightM) : new Float64Array(this.n).fill(c.precursorHeightM));
    this.candidate = new Float64Array(this.state.length); this.start = new Float64Array(this.state.length);
    this.middle = new Float64Array(this.state.length); this.trial = new Float64Array(this.state.length);
    this.rate = new Float64Array(this.state.length); this.capillary = new Float64Array(this.n);
    this.validate(this.state); this.initialVolume = compensated(this.state, 0, this.n) * this.area;
    this.initialEnergy = this.energy(this.state);
  }
  get timeSeconds() { return this.steps * this.config.dtSeconds; }
  checkpoint(): CollectorCheckpoint {
    const handle: CollectorCheckpoint = Object.freeze({ kind: "collector-checkpoint" });
    this.checkpoints.set(handle, { state: this.state.slice(), ledger: { ...this.ledger }, steps: this.steps,
      seenCount: this.seenOrder.length, lineage: this.lineage }); return handle;
  }
  restore(handle: CollectorCheckpoint) {
    const saved = this.checkpoints.get(handle);
    if (!saved || saved.lineage !== this.lineage) throw new Error("Foreign, reused or obsolete collector checkpoint");
    this.checkpoints.delete(handle); this.state.set(saved.state); this.ledger = { ...saved.ledger }; this.steps = saved.steps;
    for (let i = saved.seenCount; i < this.seenOrder.length; i++) this.seen.delete(this.seenOrder[i]!);
    this.seenOrder.length = saved.seenCount; this.lineage++; this.generation++;
  }
  private shape(a: Float64Array) {
    const c = this.config; let min = Infinity, max = 0, sx = 0, sz = 0, speed = 0, reynolds = 0, frequency = 0;
    for (let z = 0; z < c.nz; z++) for (let x = 0; x < c.nx; x++) {
      const i = z * c.nx + x, h = a[i]!, u = a[this.n + i]! / h, v = a[2 * this.n + i]! / h;
      min = Math.min(min, h); max = Math.max(max, h); speed = Math.max(speed, Math.hypot(u, v));
      reynolds = Math.max(reynolds, c.viscosityPaS ? c.densityKgM3 * Math.hypot(u, v) * h / c.viscosityPaS : 0);
      const wave = Math.sqrt(c.gravityMS2 * h);
      frequency = Math.max(frequency, (Math.abs(u) + wave) / this.dx + (Math.abs(v) + wave) / this.dz);
      if (x + 1 < c.nx) sx = Math.max(sx, Math.abs(a[i + 1]! - h) / this.dx);
      if (z + 1 < c.nz) sz = Math.max(sz, Math.abs(a[i + c.nx]! - h) / this.dz);
    }
    const capillaryFrequency = 4 * (1 / this.dx ** 2 + 1 / this.dz ** 2) * Math.sqrt(c.surfaceTensionNm * max / c.densityKgM3);
    return { min, max, slope: Math.hypot(sx, sz), speed, reynolds, frequency,
      stableDt: Math.min(frequency > 0 ? .3 / frequency : Infinity, capillaryFrequency > 0 ? .3 / capillaryFrequency : Infinity) };
  }
  private validate(a: Float64Array) {
    for (const value of a) if (!Number.isFinite(value)) throw new RangeError("Nonfinite collector state");
    const s = this.shape(a);
    if (!(s.min > 0)) throw new RangeError("Collector film lost positivity");
    if (s.max > .1 * Math.min(this.config.widthM, this.config.depthM)) throw new RangeError("Collector exceeds shallow-layer aspect ratio");
    return s;
  }
  /** RK stages need the same finite/positive/aspect guards, but their speed,
   * Reynolds number and next-step CFL diagnostics are not consumed. Avoid
   * computing those diagnostics twice per trial (including rejected trials).
   * Accepted-state validate() remains the authoritative timestep diagnostic.
   */
  private validateStage(a: Float64Array) {
    let minimum = Infinity, maximum = 0;
    for (let i = 0; i < this.n; i++) {
      const h = a[i]!;
      if (!Number.isFinite(h) || !Number.isFinite(a[this.n + i]) || !Number.isFinite(a[2 * this.n + i]))
        throw new RangeError("Nonfinite collector state");
      minimum = Math.min(minimum, h); maximum = Math.max(maximum, h);
    }
    if (!(minimum > 0)) throw new RangeError("Collector film lost positivity");
    if (maximum > .1 * Math.min(this.config.widthM, this.config.depthM))
      throw new RangeError("Collector exceeds shallow-layer aspect ratio");
  }
  private energy(a: Float64Array) {
    const c = this.config, n = this.n; let e = 0;
    for (let z = 0; z < c.nz; z++) for (let x = 0; x < c.nx; x++) {
      const i = z * c.nx + x, h = a[i]!;
      e += c.densityKgM3 * ((a[n + i]! ** 2 + a[2 * n + i]! ** 2) / h + c.gravityMS2 * h * h);
    }
    return .5 * this.area * e + graphCapillarity(a, c.nx, c.nz, this.dx, this.dz, c.surfaceTensionNm);
  }
  /** Only these cells' graph-area terms can change when a source updates its
   * four CIC cells. This evaluates the identical energy, without two full-grid
   * traversals per impact. Neighbour contributions cancel in the difference.
   */
  private localEnergy(a: Float64Array, indices: readonly number[]) {
    const c = this.config, n = this.n; let energy = 0;
    for (const i of indices) {
      const h = a[i]!, x = i % c.nx, z = Math.floor(i / c.nx);
      energy += .5 * c.densityKgM3 * ((a[n + i]! ** 2 + a[2 * n + i]! ** 2) / h + c.gravityMS2 * h * h);
      if (c.surfaceTensionNm) for (let sideX = -1; sideX <= 1; sideX += 2) for (let sideZ = -1; sideZ <= 1; sideZ += 2) {
        const j = x + sideX < 0 || x + sideX >= c.nx ? i : i + sideX;
        const k = z + sideZ < 0 || z + sideZ >= c.nz ? i : i + sideZ * c.nx;
        const sx = (a[j]! - h) / this.dx, sz = (a[k]! - h) / this.dz, square = sx * sx + sz * sz;
        energy += c.surfaceTensionNm * .25 * square / (Math.sqrt(1 + square) + 1);
      }
    }
    return energy * this.area;
  }
  private derivative(a: Float64Array) {
    const c = this.config, n = this.n, f = this.rate; f.fill(0);
    const face = (i: number, j: number, axis: 0 | 1, distance: number) => {
      const hl = a[i]!, hr = a[j]!, xl = a[n + i]!, xr = a[n + j]!, zl = a[2 * n + i]!, zr = a[2 * n + j]!;
      const ul = (axis ? zl : xl) / hl, ur = (axis ? zr : xr) / hr;
      const wave = Math.max(Math.abs(ul) + Math.sqrt(c.gravityMS2 * hl), Math.abs(ur) + Math.sqrt(c.gravityMS2 * hr));
      const mass = (.5 * (ul * hl + ur * hr) - .5 * wave * (hr - hl)) / distance;
      const mx = (.5 * (xl * ul + xr * ur + (axis ? 0 : .5 * c.gravityMS2 * (hl * hl + hr * hr))) - .5 * wave * (xr - xl)) / distance;
      const mz = (.5 * (zl * ul + zr * ur + (axis ? .5 * c.gravityMS2 * (hl * hl + hr * hr) : 0)) - .5 * wave * (zr - zl)) / distance;
      f[i]! -= mass; f[j]! += mass; f[n + i]! -= mx; f[n + j]! += mx; f[2 * n + i]! -= mz; f[2 * n + j]! += mz;
    };
    for (let z = 0; z < c.nz; z++) for (let x = 0; x < c.nx; x++) {
      const i = z * c.nx + x, h = a[i]!;
      if (x + 1 < c.nx) face(i, i + 1, 0, this.dx);
      if (z + 1 < c.nz) face(i, i + c.nx, 1, this.dz);
      // Reflective ghost state: zero mass flux, correctly signed wall force.
      if (x === 0 || x === c.nx - 1) {
        const q = a[n + i]!, sign = x === 0 ? 1 : -1, speed = Math.abs(q / h) + Math.sqrt(c.gravityMS2 * h);
        f[n + i]! += (sign * (q * q / h + .5 * c.gravityMS2 * h * h) - speed * q) / this.dx;
      }
      if (z === 0 || z === c.nz - 1) {
        const q = a[2 * n + i]!, sign = z === 0 ? 1 : -1, speed = Math.abs(q / h) + Math.sqrt(c.gravityMS2 * h);
        f[2 * n + i]! += (sign * (q * q / h + .5 * c.gravityMS2 * h * h) - speed * q) / this.dz;
      }
    }
    if (c.surfaceTensionNm) graphCapillarity(a, c.nx, c.nz, this.dx, this.dz, c.surfaceTensionNm, this.capillary);
    if (c.surfaceTensionNm) for (let z = 0; z < c.nz; z++) for (let x = 0; x < c.nx; x++) {
      const i = z * c.nx + x, scale = a[i]! / c.densityKgM3, p = this.capillary;
      f[n + i]! -= scale * (p[x + 1 < c.nx ? i + 1 : i]! - p[x ? i - 1 : i]!) / (2 * this.dx);
      f[2 * n + i]! -= scale * (p[z + 1 < c.nz ? i + c.nx : i]! - p[z ? i - c.nx : i]!) / (2 * this.dz);
    }
  }
  private drag(a: Float64Array, dt: number) {
    const c = this.config; let loss = 0;
    for (let i = 0; i < this.n; i++) {
      const h = a[i]!, factor = Math.exp(-3 * c.viscosityPaS * dt / (c.densityKgM3 * h * h));
      const before = a[this.n + i]! ** 2 + a[2 * this.n + i]! ** 2;
      a[this.n + i]! *= factor; a[2 * this.n + i]! *= factor;
      loss += before * (1 - factor * factor) / h;
    }
    return .5 * c.densityKgM3 * this.area * loss;
  }
  private integrate(dt: number) {
    this.start.set(this.candidate); let basal = this.drag(this.start, .5 * dt);
    this.derivative(this.start);
    for (let i = 0; i < this.state.length; i++) this.middle[i] = this.start[i]! + dt * this.rate[i]!;
    this.validateStage(this.middle); this.derivative(this.middle);
    for (let i = 0; i < this.state.length; i++) this.trial[i] = .5 * (this.start[i]! + this.middle[i]! + dt * this.rate[i]!);
    this.validateStage(this.trial); basal += this.drag(this.trial, .5 * dt);
    return basal;
  }
  private snapshotOf(a: Float64Array, timeSeconds: number, l: Ledger): CollectorSnapshot {
    const volume = compensated(a, 0, this.n) * this.area, energy = this.energy(a), slope = this.shape(a).slope;
    return { timeSeconds, heightM: a.slice(0, this.n), momentumXM2S: a.slice(this.n, 2 * this.n),
      momentumZM2S: a.slice(2 * this.n), initialFilmVolumeM3: this.initialVolume, depositedVolumeM3: l.deposited,
      escapedVolumeM3: l.escaped, inputVolumeM3: l.input, filmVolumeM3: volume,
      volumeErrorM3: volume + l.escaped - this.initialVolume - l.input,
      energyJ: energy, sourceEnergyJ: l.sourceEnergy, dissipatedEnergyJ: l.basal + l.numerical,
      basalDissipatedEnergyJ: l.basal, numericalDissipatedEnergyJ: l.numerical, impactDissipatedEnergyJ: l.impact,
      depositedMomentumXKgMS: l.momentumX, depositedMomentumZKgMS: l.momentumZ,
      energyBalanceErrorJ: energy + l.basal + l.numerical - this.initialEnergy - l.sourceEnergy,
      maxSlope: slope, steepFrontWarning: slope > this.config.maxSlope };
  }
  snapshot() { return this.snapshotOf(this.state, this.timeSeconds, this.ledger); }
  private deposit(e: CollectorDeposit, l: Ledger) {
    const c = this.config, x = e.positionM[0] - c.originXM, z = e.positionM[2] - c.originZM;
    l.input += e.volumeM3;
    if (x < 0 || z < 0 || x > c.widthM || z > c.depthM) { l.escaped += e.volumeM3; return; }
    const gx = x / this.dx - .5, gz = z / this.dz - .5;
    const x0 = Math.floor(gx), z0 = Math.floor(gz), fx = gx - x0, fz = gz - z0;
    const affected: number[] = [];
    const include = (i: number) => { if (!affected.includes(i)) affected.push(i); };
    for (let dz = 0; dz <= 1; dz++) for (let dx = 0; dx <= 1; dx++) {
      const ix = Math.max(0, Math.min(c.nx - 1, x0 + dx)), iz = Math.max(0, Math.min(c.nz - 1, z0 + dz)), i = iz * c.nx + ix;
      include(i); if (ix) include(i - 1); if (ix + 1 < c.nx) include(i + 1);
      if (iz) include(i - c.nx); if (iz + 1 < c.nz) include(i + c.nx);
    }
    const before = this.localEnergy(this.candidate, affected);
    let horizontalMixing = 0;
    for (let dz = 0; dz <= 1; dz++) for (let dx = 0; dx <= 1; dx++) {
      const ix = Math.max(0, Math.min(c.nx - 1, x0 + dx)), iz = Math.max(0, Math.min(c.nz - 1, z0 + dz)), i = iz * c.nx + ix;
      const dh = e.volumeM3 / this.area * (dx ? fx : 1 - fx) * (dz ? fz : 1 - fz);
      const h = this.candidate[i]!, qx = this.candidate[this.n + i]!, qz = this.candidate[2 * this.n + i]!;
      const nx = qx + dh * e.velocityMS[0], nz = qz + dh * e.velocityMS[2], nh = h + dh;
      horizontalMixing += (qx * qx + qz * qz) / h + dh * (e.velocityMS[0] ** 2 + e.velocityMS[2] ** 2) - (nx * nx + nz * nz) / nh;
      this.candidate[i] = nh; this.candidate[this.n + i] = nx; this.candidate[2 * this.n + i] = nz;
    }
    l.deposited += e.volumeM3; l.sourceEnergy += this.localEnergy(this.candidate, affected) - before;
    l.impact += .5 * c.densityKgM3 * (e.volumeM3 * e.velocityMS[1] ** 2 + this.area * horizontalMixing);
    l.momentumX += c.densityKgM3 * e.volumeM3 * e.velocityMS[0]; l.momentumZ += c.densityKgM3 * e.volumeM3 * e.velocityMS[2];
    this.validate(this.candidate);
  }
  prepareStep(events: readonly CollectorDeposit[] = []): CollectorPreparedStep {
    const generation = ++this.generation, nextTime = (this.steps + 1) * this.config.dtSeconds, ids = new Set<number>();
    const ordered = [...events].sort((a, b) => a.timeSeconds - b.timeSeconds || a.id - b.id), l = { ...this.ledger };
    this.candidate.set(this.state);
    let substeps = 0, retries = 0, minimumSubstepSeconds = Infinity, maxFilmReynolds = 0, maxSpeedMS = 0, maxCourant = 0;
    const telemetry = (a: Float64Array, ledger: Ledger): CollectorTelemetry => {
      const s = this.shape(a), volume = compensated(a, 0, this.n) * this.area;
      return { substeps, retries, minimumHeightM: s.min, maximumHeightM: s.max,
        minimumSubstepSeconds: Number.isFinite(minimumSubstepSeconds) ? minimumSubstepSeconds : 0,
        relativeVolumeError: (volume + ledger.escaped - this.initialVolume - ledger.input) / Math.max(this.initialVolume + ledger.input, 1e-30),
        energyBalanceErrorJ: this.energy(a) + ledger.basal + ledger.numerical - this.initialEnergy - ledger.sourceEnergy,
        maxSlope: s.slope, steepFrontWarning: s.slope > this.config.maxSlope, maxFilmReynolds, maxSpeedMS, maxCourant };
    };
    try {
      if (this.seen.size + ordered.length > 1_000_000) throw new RangeError("Collector event capacity reached");
      for (const e of ordered) {
        if (!Number.isInteger(e.id) || e.id < 0 || this.seen.has(e.id) || ids.has(e.id)
          || !Number.isFinite(e.timeSeconds) || e.timeSeconds < this.timeSeconds - 1e-12 || e.timeSeconds > nextTime + 1e-12
          || e.positionM.length !== 3 || !e.positionM.every(Number.isFinite)
          || !e.velocityMS || e.velocityMS.length !== 3 || !e.velocityMS.every(Number.isFinite)
          || !Number.isFinite(e.volumeM3) || e.volumeM3 <= 0) throw new RangeError("Invalid, duplicate, stale or future collector event");
        ids.add(e.id);
      }
      let time = this.timeSeconds;
      const evolve = (until: number) => {
        while (until - time > 1e-14 * this.config.dtSeconds) {
          const s = this.validate(this.candidate), before = this.energy(this.candidate);
          let dt = Math.min(until - time, s.stableDt), basal = 0, after = Infinity, lastRejection = "energy increase";
          for (;;) {
            if (++substeps + retries > this.config.maxSubsteps) throw new RangeError("Collector work budget exhausted");
            if (!(dt > 1e-14 * this.config.dtSeconds)) throw new RangeError(
              `Collector stable step underflow (${lastRejection}; time=${time}, slope=${s.slope}, remaining=${until - time}, dt=${dt}, retries=${retries})`);
            try { basal = this.integrate(dt); after = this.energy(this.trial); }
            catch (cause) { after = Infinity; lastRejection = cause instanceof Error ? cause.message : String(cause); }
            if (Number.isFinite(after) && after <= before + Math.max(1e-24, Math.abs(before) * 2e-12)) break;
            dt *= .5; retries++;
          }
          this.candidate.set(this.trial); l.basal += basal; l.numerical += before - after - basal;
          time += dt; minimumSubstepSeconds = Math.min(minimumSubstepSeconds, dt);
          maxFilmReynolds = Math.max(maxFilmReynolds, s.reynolds); maxSpeedMS = Math.max(maxSpeedMS, s.speed);
          maxCourant = Math.max(maxCourant, dt * s.frequency);
        }
        time = until;
      };
      for (const event of ordered) { evolve(Math.max(time, Math.min(nextTime, event.timeSeconds))); this.deposit(event, l); }
      evolve(nextTime);
      const stats = telemetry(this.candidate, l);
      if (Math.abs(stats.relativeVolumeError) > 2e-10) throw new RangeError("Collector global volume ledger failed");
      const snapshot = this.snapshotOf(this.candidate, nextTime, l); let committed = false;
      return { accepted: true, snapshot, telemetry: stats, commit: () => {
        if (committed || this.generation !== generation) throw new Error("Stale or already committed collector transaction");
        this.state.set(this.candidate); this.ledger = l; this.steps++; ids.forEach(id => { this.seen.add(id); this.seenOrder.push(id); });
        committed = true; this.generation++;
      } };
    } catch (cause) {
      return { accepted: false, reason: cause instanceof Error ? cause.message : String(cause),
        snapshot: this.snapshot(), telemetry: telemetry(this.state, this.ledger),
        commit() { throw new Error("Cannot commit rejected collector state"); } };
    }
  }
  step(events: readonly CollectorDeposit[] = []): CollectorStep {
    const prepared = this.prepareStep(events); if (prepared.accepted) prepared.commit();
    return { accepted: prepared.accepted, ...(prepared.reason ? { reason: prepared.reason } : {}),
      snapshot: prepared.snapshot, telemetry: prepared.telemetry };
  }
}
