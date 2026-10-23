/**
 * Local 2D, prewetted, inertialess Newtonian collector in SI units.
 * h_t = div[M(h) grad p] + S, p = rho*g*h - sigma*laplacian(h),
 * M(h)=h^3/(3*mu). Closed rectangular walls, normal h-gradient and flux zero.
 * Actual landing events supply volume locally at their exact accepted time.
 * This does not model impact momentum, splash, contact-angle hysteresis or
 * surface-tension breakup. See COLLECTOR_MODEL.md for discretisation/limits.
 */
export interface CollectorConfig {
  widthM: number; depthM: number; originXM: number; originZM: number;
  nx: number; nz: number; precursorHeightM: number;
  viscosityPaS: number; surfaceTensionNm: number; densityKgM3: number; gravityMS2: number;
  dtSeconds: number; maxSubsteps: number; maxSlope: number;
}
export interface CollectorDeposit {
  id: number; timeSeconds: number;
  positionM: readonly [number, number, number];
  volumeM3: number;
}
export interface CollectorSnapshot {
  timeSeconds: number; heightM: Float64Array;
  initialFilmVolumeM3: number; depositedVolumeM3: number; escapedVolumeM3: number;
  inputVolumeM3: number; filmVolumeM3: number; volumeErrorM3: number;
  energyJ: number; sourceEnergyJ: number; dissipatedEnergyJ: number; energyBalanceErrorJ: number;
  maxSlope: number;
}
export interface CollectorTelemetry {
  substeps: number; minimumHeightM: number; maximumHeightM: number;
  minimumSubstepSeconds: number; relativeVolumeError: number;
  energyBalanceErrorJ: number; maxSlope: number; maxFilmReynolds: number;
}
export interface CollectorStep {
  accepted: boolean; reason?: string; snapshot: CollectorSnapshot; telemetry: CollectorTelemetry;
}
export interface CollectorPreparedStep extends CollectorStep {
  /** Single use. A newer prepare or commit invalidates an older transaction. */
  commit(): void;
}
/** Opaque owner-tagged rollback handle; not a serializable state format. */
export interface CollectorCheckpoint { readonly kind: "collector-checkpoint" }
export const DEFAULT_COLLECTOR_CONFIG: Readonly<CollectorConfig> = Object.freeze({
  widthM: .16, depthM: .2, originXM: -.08, originZM: -.1, nx: 64, nz: 64,
  precursorHeightM: 20e-6, viscosityPaS: .00345, surfaceTensionNm: .05,
  densityKgM3: 1060, gravityMS2: 9.81, dtSeconds: .001, maxSubsteps: 2048, maxSlope: .3,
});
const sum = (a: Float64Array) => {
  let total = 0, compensation = 0;
  for (const value of a) { const y = value - compensation, t = total + y; compensation = (t - total) - y; total = t; }
  return total;
};
interface Ledger { deposited: number; escaped: number; input: number; sourceEnergy: number; dissipated: number }
interface Shape { min: number; max: number; slope: number }

export class CollectorThinFilm {
  readonly config: Readonly<CollectorConfig>;
  private readonly dx: number; private readonly dz: number; private readonly area: number;
  private readonly h: Float64Array; private readonly candidate: Float64Array;
  private readonly pressure: Float64Array; private readonly rate: Float64Array;
  private readonly seen = new Set<number>();
  private readonly seenOrder: number[] = [];
  private readonly checkpoints = new WeakMap<CollectorCheckpoint, {
    h: Float64Array; ledger: Ledger; steps: number; seenCount: number; lineage: number;
  }>();
  private lineage = 0;
  private readonly initialVolume: number; private readonly initialEnergy: number;
  private ledger: Ledger = { deposited: 0, escaped: 0, input: 0, sourceEnergy: 0, dissipated: 0 };
  private steps = 0; private generation = 0;
  constructor(config: Partial<CollectorConfig> = {}, initialHeightM?: ArrayLike<number>) {
    const c = { ...DEFAULT_COLLECTOR_CONFIG, ...config };
    for (const k of ["widthM", "depthM", "precursorHeightM", "viscosityPaS", "densityKgM3", "dtSeconds", "maxSlope"] as const)
      if (!Number.isFinite(c[k]) || c[k] <= 0) throw new RangeError(`${k} must be positive and finite`);
    if (![c.originXM, c.originZM, c.surfaceTensionNm, c.gravityMS2].every(Number.isFinite)
      || c.surfaceTensionNm < 0 || c.gravityMS2 < 0 || c.widthM > 2 || c.depthM > 2
      || c.maxSlope > .3 || c.dtSeconds > .1)
      throw new RangeError("Invalid collector SI geometry/material or small-slope envelope");
    for (const k of ["nx", "nz"] as const)
      if (!Number.isInteger(c[k]) || c[k] < 8 || c[k] > 128) throw new RangeError("Use 8–128 cells per collector axis");
    if (!Number.isInteger(c.maxSubsteps) || c.maxSubsteps < 1 || c.maxSubsteps > 100_000)
      throw new RangeError("Invalid collector substep budget");
    this.config = Object.freeze(c); this.dx = c.widthM / c.nx; this.dz = c.depthM / c.nz; this.area = this.dx * this.dz;
    if (initialHeightM && initialHeightM.length !== c.nx * c.nz) throw new RangeError("Invalid initial collector grid");
    this.h = initialHeightM ? Float64Array.from(initialHeightM) : new Float64Array(c.nx * c.nz).fill(c.precursorHeightM);
    this.candidate = new Float64Array(this.h.length); this.pressure = new Float64Array(this.h.length); this.rate = new Float64Array(this.h.length);
    this.validate(this.h);
    this.initialVolume = sum(this.h) * this.area; this.initialEnergy = this.energy(this.h);
  }
  get timeSeconds() { return this.steps * this.config.dtSeconds; }
  checkpoint(): CollectorCheckpoint {
    const handle: CollectorCheckpoint = Object.freeze({ kind: "collector-checkpoint" });
    this.checkpoints.set(handle, { h: this.h.slice(), ledger: { ...this.ledger }, steps: this.steps,
      seenCount: this.seenOrder.length, lineage: this.lineage });
    return handle;
  }
  restore(handle: CollectorCheckpoint): void {
    const saved = this.checkpoints.get(handle);
    if (!saved || saved.lineage !== this.lineage) throw new Error("Foreign, reused or obsolete collector checkpoint");
    this.checkpoints.delete(handle);
    this.h.set(saved.h); this.ledger = { ...saved.ledger }; this.steps = saved.steps;
    for (let i = saved.seenCount; i < this.seenOrder.length; i++) this.seen.delete(this.seenOrder[i]!);
    this.seenOrder.length = saved.seenCount; this.lineage++; this.generation++;
  }
  private shape(h: Float64Array): Shape {
    let min = Infinity, max = 0, sx = 0, sz = 0;
    const { nx, nz } = this.config;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const i = z * nx + x, a = h[i]!;
      min = Math.min(min, a); max = Math.max(max, a);
      if (x + 1 < nx) sx = Math.max(sx, Math.abs(h[i + 1]! - a) / this.dx);
      if (z + 1 < nz) sz = Math.max(sz, Math.abs(h[i + nx]! - a) / this.dz);
    }
    return { min, max, slope: Math.hypot(sx, sz) };
  }
  private validate(h: Float64Array): Shape {
    const s = this.shape(h);
    if (!(s.min > 0) || !Number.isFinite(s.max)) throw new RangeError("Collector film lost positivity or finiteness");
    if (s.slope > this.config.maxSlope) throw new RangeError("Collector exceeds the validated small-slope envelope");
    if (s.max > .1 * Math.min(this.config.widthM, this.config.depthM))
      throw new RangeError("Collector exceeds the thin-film aspect-ratio envelope");
    return s;
  }
  private energy(h: Float64Array): number {
    const { nx, nz, densityKgM3, gravityMS2, surfaceTensionNm: sigma } = this.config;
    let e = 0;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const i = z * nx + x, a = h[i]!;
      e += densityKgM3 * gravityMS2 * a * a;
      if (x + 1 < nx) e += sigma * ((h[i + 1]! - a) / this.dx) ** 2;
      if (z + 1 < nz) e += sigma * ((h[i + nx]! - a) / this.dz) ** 2;
    }
    return .5 * e * this.area;
  }
  private snapshotOf(h: Float64Array, timeSeconds: number, l: Ledger): CollectorSnapshot {
    const filmVolumeM3 = sum(h) * this.area, energyJ = this.energy(h);
    return { timeSeconds, heightM: h.slice(), initialFilmVolumeM3: this.initialVolume,
      depositedVolumeM3: l.deposited, escapedVolumeM3: l.escaped, inputVolumeM3: l.input,
      filmVolumeM3, volumeErrorM3: filmVolumeM3 + l.escaped - this.initialVolume - l.input,
      energyJ, sourceEnergyJ: l.sourceEnergy, dissipatedEnergyJ: l.dissipated,
      energyBalanceErrorJ: energyJ + l.dissipated - this.initialEnergy - l.sourceEnergy, maxSlope: this.shape(h).slope };
  }
  snapshot(): CollectorSnapshot { return this.snapshotOf(this.h, this.timeSeconds, this.ledger); }
  private derivative(h: Float64Array) {
    const c = this.config, { nx, nz } = c, ix = 1 / this.dx ** 2, iz = 1 / this.dz ** 2;
    const p = this.pressure, f = this.rate, gravity = c.densityKgM3 * c.gravityMS2;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const i = z * nx + x, a = h[i]!;
      const lap = ((x ? h[i - 1]! - a : 0) + (x + 1 < nx ? h[i + 1]! - a : 0)) * ix
        + ((z ? h[i - nx]! - a : 0) + (z + 1 < nz ? h[i + nx]! - a : 0)) * iz;
      p[i] = gravity * a - c.surfaceTensionNm * lap;
    }
    f.fill(0); let dissipation = 0, maxReynolds = 0;
    const face = (i: number, j: number, inverseSquare: number, distance: number) => {
      const dp = p[j]! - p[i]!, donor = dp > 0 ? h[j]! : h[i]!;
      // Pressure-upwind mobility degenerates on the donating cell as h→0.
      // Pair updates telescope exactly; no volume clipping/redistribution.
      const mobility = donor ** 3 / (3 * c.viscosityPaS), transfer = mobility * dp * inverseSquare;
      f[i]! += transfer; f[j]! -= transfer;
      dissipation += mobility * dp * dp * inverseSquare;
      maxReynolds = Math.max(maxReynolds, c.densityKgM3 * Math.abs(mobility * dp / distance) / c.viscosityPaS);
    };
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const i = z * nx + x;
      if (x + 1 < nx) face(i, i + 1, ix, this.dx);
      if (z + 1 < nz) face(i, i + nx, iz, this.dz);
    }
    // E is quadratic. E(h+dt*f)-E(h)=-dt*D+dt²*Q/2 exactly.
    const q = 2 * this.energy(f);
    let positiveDt = Infinity;
    for (let i = 0; i < h.length; i++) if (f[i]! < 0) positiveDt = Math.min(positiveDt, -.9 * h[i]! / f[i]!);
    const d = dissipation * this.area;
    return { dissipation: d, maxReynolds, dt: Math.min(positiveDt, q > 0 ? .9 * d / q : Infinity) };
  }
  private deposit(event: CollectorDeposit, ledger: Ledger) {
    const c = this.config, x = event.positionM[0] - c.originXM, z = event.positionM[2] - c.originZM;
    ledger.input += event.volumeM3;
    if (x < 0 || z < 0 || x > c.widthM || z > c.depthM) { ledger.escaped += event.volumeM3; return; }
    const before = this.energy(this.candidate), gx = x / this.dx - .5, gz = z / this.dz - .5;
    const x0 = Math.floor(gx), z0 = Math.floor(gz), fx = gx - x0, fz = gz - z0;
    // Cloud-in-cell preserves the sub-cell barycentre away from walls. At a
    // wall its support is reflected into the adjacent cell, without mass loss.
    for (let dz = 0; dz <= 1; dz++) for (let dx = 0; dx <= 1; dx++) {
      const ix = Math.max(0, Math.min(c.nx - 1, x0 + dx)), iz = Math.max(0, Math.min(c.nz - 1, z0 + dz));
      this.candidate[iz * c.nx + ix]! += event.volumeM3 / this.area * (dx ? fx : 1 - fx) * (dz ? fz : 1 - fz);
    }
    ledger.deposited += event.volumeM3; ledger.sourceEnergy += this.energy(this.candidate) - before;
    this.validate(this.candidate);
  }
  prepareStep(events: readonly CollectorDeposit[] = []): CollectorPreparedStep {
    const generation = ++this.generation, nextTime = (this.steps + 1) * this.config.dtSeconds;
    const ledger = { ...this.ledger }, ids = new Set<number>(), ordered = [...events].sort((a, b) => a.timeSeconds - b.timeSeconds || a.id - b.id);
    this.candidate.set(this.h);
    let substeps = 0, minimumSubstepSeconds = Infinity, maxFilmReynolds = 0;
    const telemetry = (h: Float64Array, l: Ledger): CollectorTelemetry => {
      const s = this.shape(h), snapshot = this.snapshotOf(h, this.timeSeconds, l);
      return { substeps, minimumHeightM: s.min, maximumHeightM: s.max,
        minimumSubstepSeconds: Number.isFinite(minimumSubstepSeconds) ? minimumSubstepSeconds : 0,
        relativeVolumeError: snapshot.volumeErrorM3 / Math.max(this.initialVolume + l.input, 1e-30),
        energyBalanceErrorJ: snapshot.energyBalanceErrorJ, maxSlope: s.slope, maxFilmReynolds };
    };
    try {
      if (this.seen.size + ordered.length > 1_000_000) throw new RangeError("Collector deposit history capacity reached");
      for (const e of ordered) {
        if (!Number.isInteger(e.id) || e.id < 0 || ids.has(e.id) || this.seen.has(e.id)
          || !Number.isFinite(e.timeSeconds) || e.timeSeconds < this.timeSeconds - 1e-12 || e.timeSeconds > nextTime + 1e-12
          || e.positionM.length !== 3 || !e.positionM.every(Number.isFinite) || !Number.isFinite(e.volumeM3) || e.volumeM3 <= 0)
          throw new RangeError("Invalid, duplicate, stale or future collector landing event");
        ids.add(e.id);
      }
      let time = this.timeSeconds;
      const evolve = (until: number) => {
        while (until - time > 1e-14 * this.config.dtSeconds) {
          if (++substeps > this.config.maxSubsteps) throw new RangeError("Collector substep budget exhausted; transaction rejected");
          const derivative = this.derivative(this.candidate);
          const dt = Math.min(until - time, derivative.dt);
          if (!(dt > 1e-14 * this.config.dtSeconds) || !Number.isFinite(dt)) throw new RangeError("Collector stable step underflow");
          const before = this.energy(this.candidate);
          for (let i = 0; i < this.h.length; i++) this.candidate[i]! += dt * this.rate[i]!;
          const after = this.energy(this.candidate);
          if (!Number.isFinite(after) || after > before + Math.max(1e-24, Math.abs(before) * 2e-12))
            throw new RangeError("Collector dissipative energy check failed");
          this.validate(this.candidate);
          ledger.dissipated += before - after; time += dt;
          minimumSubstepSeconds = Math.min(minimumSubstepSeconds, dt);
          maxFilmReynolds = Math.max(maxFilmReynolds, derivative.maxReynolds);
        }
        time = until;
      };
      for (const event of ordered) { evolve(Math.max(time, Math.min(nextTime, event.timeSeconds))); this.deposit(event, ledger); }
      evolve(nextTime);
      const snapshot = this.snapshotOf(this.candidate, nextTime, ledger), stats = telemetry(this.candidate, ledger);
      if (Math.abs(stats.relativeVolumeError) > 2e-10) throw new RangeError("Collector global volume ledger failed");
      // Long-wave inertia requires Re*h/L <<1; report Re separately, and
      // reject Re>1 rather than silently claiming the creeping-film regime.
      if (maxFilmReynolds > 1) throw new RangeError("Collector exceeds inertialess film Reynolds envelope");
      let committed = false;
      return { accepted: true, snapshot, telemetry: stats, commit: () => {
        if (committed || this.generation !== generation) throw new Error("Stale or already committed collector transaction");
        this.h.set(this.candidate); this.ledger = ledger; this.steps++;
        ids.forEach(id => { this.seen.add(id); this.seenOrder.push(id); });
        committed = true; this.generation++;
      } };
    } catch (cause) {
      return { accepted: false, reason: cause instanceof Error ? cause.message : String(cause),
        snapshot: this.snapshot(), telemetry: telemetry(this.h, this.ledger),
        commit() { throw new Error("Cannot commit a rejected collector transaction"); } };
    }
  }
  step(events: readonly CollectorDeposit[] = []): CollectorStep {
    const prepared = this.prepareStep(events); if (prepared.accepted) prepared.commit();
    return { accepted: prepared.accepted, ...(prepared.reason ? { reason: prepared.reason } : {}),
      snapshot: prepared.snapshot, telemetry: prepared.telemetry };
  }
}
