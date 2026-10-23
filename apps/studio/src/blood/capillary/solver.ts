/**
 * Newtonian, inertialess, one-dimensional thin-film gradient dynamics in SI.
 * A periodic height graph on a flat impermeable substrate, extruded by widthM.
 * This is not a three-dimensional drop or a calibrated blood/tissue model.
 *
 * h_t = div(M grad p), M=h^3/(3 mu), p=-sigma h_xx + phi'(h).
 * phi=A[h_*^3/(5h^5)-1/(2h^2)], A=(5/3)sigma theta^2 h_*^2.
 * Backward Euler / convex split: capillarity and repulsion implicit,
 * attraction explicit; positive old-state face mobility. See README.md.
 */
export interface FilmWetting {
  precursorHeightM: number;
  /** Long-wave equilibrium slope parameter, radians; not arbitrary-angle wetting. */
  equilibriumAngleRadians: number;
}
export interface FilmConfig {
  lengthM: number;
  widthM: number;
  cells: number;
  surfaceTensionNm: number;
  viscosityPaS: number;
  densityKgM3: number;
  wetting: FilmWetting | null;
  maxSlope: number;
  maxNewtonIterations: number;
  relativeTolerance: number;
}
export const DEFAULT_FILM_CONFIG: Readonly<FilmConfig> = Object.freeze({
  lengthM: .004, widthM: .001, cells: 96,
  surfaceTensionNm: .05, viscosityPaS: .01, densityKgM3: 1060,
  wetting: Object.freeze({ precursorHeightM: 8e-6, equilibriumAngleRadians: .12 }),
  maxSlope: .3, maxNewtonIterations: 30, relativeTolerance: 1e-10,
});
export interface FilmSnapshot {
  timeSeconds: number;
  xM: Float64Array;
  heightM: Float64Array;
  pressurePa: Float64Array;
  capillaryPressurePa: Float64Array;
  /** Force conjugate to a cell's vertical displacement: -dE_surface/dh, N. */
  capillaryNormalForceN: Float64Array;
  volumeM3: number;
  energyJ: number;
  maxSlope: number;
}
export interface FilmTelemetry {
  newtonIterations: number;
  normalizedResidual: number;
  relativeVolumeError: number;
  dissipationW: number;
  energyDeltaJ: number;
  /** Delta E + dt D <= 0 for a converged convex-split step, up to roundoff. */
  energyInequalityDefectJ: number;
  minimumHeightM: number;
  maxFilmReynolds: number;
}
export interface FilmStep {
  accepted: boolean;
  reason?: string;
  telemetry: FilmTelemetry;
  snapshot: FilmSnapshot;
}

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
}
function maxAbs(values: ArrayLike<number>): number {
  let result = 0;
  for (let i = 0; i < values.length; i++) result = Math.max(result, Math.abs(values[i]!));
  return result;
}
function sum(values: ArrayLike<number>): number {
  // Compensated summation avoids hiding small volume changes in a large sum.
  let total = 0, correction = 0;
  for (let i = 0; i < values.length; i++) {
    const adjusted = values[i]! - correction, next = total + adjusted;
    correction = next - total - adjusted; total = next;
  }
  return total;
}

export class CapillaryFilmSolver {
  readonly config: Readonly<FilmConfig>;
  private readonly dx: number;
  private readonly area: number;
  private readonly a: number;
  private readonly b: number;
  private readonly height: Float64Array;
  private readonly candidate: Float64Array;
  private readonly trial: Float64Array;
  private readonly pressure: Float64Array;
  private readonly residual: Float64Array;
  private readonly trialResidual: Float64Array;
  private readonly mobility: Float64Array;
  private readonly matrix: Float64Array;
  private readonly rhs: Float64Array;
  private readonly initialVolume: number;
  private clock = 0;

  constructor(config: Partial<FilmConfig> = {}, initialHeightM?: ArrayLike<number>) {
    const c = { ...DEFAULT_FILM_CONFIG, ...config };
    for (const key of ["lengthM", "widthM", "surfaceTensionNm", "viscosityPaS", "densityKgM3",
      "maxSlope", "relativeTolerance"] as const) positive(c[key], key);
    if (!Number.isInteger(c.cells) || c.cells < 8 || c.cells > 256)
      throw new RangeError("This CPU reference supports 8–256 periodic cells");
    if (!Number.isInteger(c.maxNewtonIterations) || c.maxNewtonIterations < 1 || c.maxNewtonIterations > 100)
      throw new RangeError("maxNewtonIterations must be an integer in [1, 100]");
    if (c.maxSlope > .3 || c.relativeTolerance < 1e-13 || c.relativeTolerance > 1e-6)
      throw new RangeError("Small-slope bound must be <=0.3; relativeTolerance must be in [1e-13, 1e-6]");
    if (c.wetting) {
      positive(c.wetting.precursorHeightM, "precursorHeightM");
      positive(c.wetting.equilibriumAngleRadians, "equilibriumAngleRadians");
      if (c.wetting.equilibriumAngleRadians > .25)
        throw new RangeError("The long-wave contact-angle parameter is restricted to <=0.25 radians");
      c.wetting = Object.freeze({ ...c.wetting });
    }
    this.config = Object.freeze(c);
    this.dx = c.lengthM / c.cells; this.area = this.dx * c.widthM;
    this.a = c.wetting ? 5 / 3 * c.surfaceTensionNm * c.wetting.equilibriumAngleRadians ** 2
      * c.wetting.precursorHeightM ** 2 : 0;
    this.b = c.wetting ? this.a * c.wetting.precursorHeightM ** 3 : 0;
    if (c.wetting && (!(this.a > 0) || !(this.b > 0) || !Number.isFinite(this.a) || !Number.isFinite(this.b)))
      throw new RangeError("Wetting coefficients cannot be represented in Float64 SI arithmetic");
    if (initialHeightM && initialHeightM.length !== c.cells) throw new RangeError("Height count must equal cells");
    this.height = initialHeightM ? Float64Array.from(initialHeightM)
      : Float64Array.from({ length: c.cells }, () => c.wetting?.precursorHeightM ?? 20e-6);
    this.validateHeight(this.height);
    this.candidate = new Float64Array(c.cells); this.trial = new Float64Array(c.cells);
    this.pressure = new Float64Array(c.cells); this.residual = new Float64Array(c.cells);
    this.trialResidual = new Float64Array(c.cells); this.mobility = new Float64Array(c.cells);
    this.matrix = new Float64Array(c.cells * c.cells); this.rhs = new Float64Array(c.cells);
    this.initialVolume = sum(this.height) * this.area;
    if (!Number.isFinite(this.energy(this.height)) || !Number.isFinite(this.initialVolume) || this.initialVolume <= 0)
      throw new RangeError("Geometry or energy cannot be represented in Float64 SI arithmetic");
  }
  get timeSeconds(): number { return this.clock; }
  private prev(i: number): number { return (i + this.config.cells - 1) % this.config.cells; }
  private next(i: number): number { return (i + 1) % this.config.cells; }
  private slope(height: Float64Array): number {
    let value = 0;
    for (let i = 0; i < height.length; i++)
      value = Math.max(value, Math.abs(height[this.next(i)]! - height[i]!) / this.dx);
    return value;
  }
  private validateHeight(height: Float64Array): void {
    for (const value of height) positive(value, "heightM");
    if (this.slope(height) > this.config.maxSlope) throw new RangeError("Height profile exceeds the declared small-slope domain");
    if (maxAbs(height) / this.config.lengthM > .1) throw new RangeError("Film thickness/domain length exceeds the long-wave bound 0.1");
  }
  private potential(height: number): number {
    return this.b / (5 * height ** 5) - this.a / (2 * height ** 2);
  }
  private energy(height: Float64Array): number {
    let result = 0;
    for (let i = 0; i < height.length; i++) {
      const slope = (height[this.next(i)]! - height[i]!) / this.dx;
      result += (.5 * this.config.surfaceTensionNm * slope * slope + this.potential(height[i]!)) * this.area;
    }
    return result;
  }
  private capillaryPressure(height: Float64Array, i: number): number {
    return this.config.surfaceTensionNm * (2 * height[i]! - height[this.prev(i)]! - height[this.next(i)]!) / this.dx ** 2;
  }
  snapshot(): FilmSnapshot {
    const c = this.config, pressure = new Float64Array(c.cells), capillary = new Float64Array(c.cells);
    for (let i = 0; i < c.cells; i++) {
      const h = this.height[i]!;
      capillary[i] = this.capillaryPressure(this.height, i);
      pressure[i] = capillary[i]! + this.a / h ** 3 - this.b / h ** 6;
    }
    return {
      timeSeconds: this.clock, xM: Float64Array.from({ length: c.cells }, (_, i) => (i + .5) * this.dx),
      heightM: this.height.slice(), pressurePa: pressure, capillaryPressurePa: capillary,
      capillaryNormalForceN: Float64Array.from(capillary, p => -p * this.area),
      volumeM3: sum(this.height) * this.area, energyJ: this.energy(this.height), maxSlope: this.slope(this.height),
    };
  }
  private evaluate(height: Float64Array, dt: number, residual: Float64Array): number {
    for (let i = 0; i < height.length; i++) {
      this.pressure[i] = this.capillaryPressure(height, i)
        - this.b / height[i]! ** 6 + this.a / this.height[i]! ** 3;
    }
    for (let i = 0; i < height.length; i++) {
      const left = this.prev(i), right = this.next(i);
      residual[i] = height[i]! - this.height[i]! - dt / this.dx ** 2
        * (this.mobility[i]! * (this.pressure[right]! - this.pressure[i]!)
          - this.mobility[left]! * (this.pressure[i]! - this.pressure[left]!));
    }
    return maxAbs(residual);
  }
  private jacobian(height: Float64Array, dt: number): void {
    const n = height.length, capillary = this.config.surfaceTensionNm / this.dx ** 2;
    this.matrix.fill(0);
    for (let i = 0; i < n; i++) {
      const left = this.prev(i), right = this.next(i), scale = dt / this.dx ** 2;
      this.matrix[i * n + i] = 1;
      for (const [j, mobility] of [[left, this.mobility[left]!],
        [i, -this.mobility[left]! - this.mobility[i]!], [right, this.mobility[i]!]]) {
        const factor = -scale * mobility!;
        const column = j!;
        this.matrix[i * n + this.prev(column)]! -= factor * capillary;
        this.matrix[i * n + column]! += factor * (2 * capillary + 6 * this.b / height[column]! ** 7);
        this.matrix[i * n + this.next(column)]! -= factor * capillary;
      }
    }
  }
  /** Dense, pivoted reference solve. Bounded cell count; no hidden external dependency. */
  private solveLinear(): boolean {
    const a = this.matrix, b = this.rhs, n = b.length;
    for (let k = 0; k < n; k++) {
      let pivot = k;
      for (let i = k + 1; i < n; i++) if (Math.abs(a[i * n + k]!) > Math.abs(a[pivot * n + k]!)) pivot = i;
      if (!Number.isFinite(a[pivot * n + k]) || Math.abs(a[pivot * n + k]!) < 1e-300) return false;
      if (pivot !== k) {
        for (let j = k; j < n; j++) {
          const old = a[k * n + j]!; a[k * n + j] = a[pivot * n + j]!; a[pivot * n + j] = old;
        }
        const old = b[k]!; b[k] = b[pivot]!; b[pivot] = old;
      }
      for (let i = k + 1; i < n; i++) {
        const factor = a[i * n + k]! / a[k * n + k]!;
        if (factor === 0) continue;
        a[i * n + k] = 0;
        for (let j = k + 1; j < n; j++) a[i * n + j]! -= factor * a[k * n + j]!;
        b[i]! -= factor * b[k]!;
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      let value = b[i]!;
      for (let j = i + 1; j < n; j++) value -= a[i * n + j]! * b[j]!;
      b[i] = value / a[i * n + i]!;
      if (!Number.isFinite(b[i])) return false;
    }
    return true;
  }
  step(dtSeconds: number): FilmStep {
    positive(dtSeconds, "dtSeconds");
    if (!Number.isFinite(this.clock + dtSeconds) || this.clock + dtSeconds === this.clock)
      throw new RangeError("Step cannot advance the represented clock");
    const n = this.height.length, scale = maxAbs(this.height), energyBefore = this.energy(this.height);
    const telemetry: FilmTelemetry = {
      newtonIterations: 0, normalizedResidual: Infinity, relativeVolumeError: 0,
      dissipationW: 0, energyDeltaJ: 0, energyInequalityDefectJ: 0,
      minimumHeightM: Math.min(...this.height), maxFilmReynolds: 0,
    };
    const reject = (reason: string): FilmStep => ({ accepted: false, reason, telemetry, snapshot: this.snapshot() });
    this.candidate.set(this.height);
    for (let i = 0; i < n; i++) {
      const faceHeight = .5 * (this.height[i]! + this.height[this.next(i)]!);
      this.mobility[i] = faceHeight ** 3 / (3 * this.config.viscosityPaS);
    }
    let residual = this.evaluate(this.candidate, dtSeconds, this.residual);
    for (let iteration = 0; iteration < this.config.maxNewtonIterations; iteration++) {
      telemetry.normalizedResidual = residual / scale;
      if (!Number.isFinite(residual)) return reject("Nonfinite nonlinear residual");
      if (telemetry.normalizedResidual <= this.config.relativeTolerance) break;
      this.jacobian(this.candidate, dtSeconds);
      for (let i = 0; i < n; i++) this.rhs[i] = -this.residual[i]!;
      if (!this.solveLinear()) return reject("Singular or nonfinite Newton system");
      let alpha = 1;
      for (let i = 0; i < n; i++) if (this.rhs[i]! < 0)
        alpha = Math.min(alpha, -.9 * this.candidate[i]! / this.rhs[i]!);
      let improved = false;
      for (let search = 0; search < 24; search++, alpha *= .5) {
        for (let i = 0; i < n; i++) this.trial[i] = this.candidate[i]! + alpha * this.rhs[i]!;
        const nextResidual = this.evaluate(this.trial, dtSeconds, this.trialResidual);
        if (Number.isFinite(nextResidual) && (nextResidual < residual * (1 - 1e-4 * alpha)
          || nextResidual / scale <= this.config.relativeTolerance)) {
          this.candidate.set(this.trial); this.residual.set(this.trialResidual); residual = nextResidual;
          improved = true; break;
        }
      }
      telemetry.newtonIterations = iteration + 1;
      if (!improved) return reject("Newton line search failed without changing the accepted state");
    }
    telemetry.normalizedResidual = this.evaluate(this.candidate, dtSeconds, this.residual) / scale;
    if (telemetry.normalizedResidual > this.config.relativeTolerance || !Number.isFinite(telemetry.normalizedResidual))
      return reject("Nonlinear iteration limit exceeded");
    telemetry.minimumHeightM = Math.min(...this.candidate);
    if (!(telemetry.minimumHeightM > 0)) return reject("Candidate has nonpositive film thickness");
    if (this.slope(this.candidate) > this.config.maxSlope || maxAbs(this.candidate) / this.config.lengthM > .1)
      return reject("Candidate left the declared long-wave domain");
    const nextVolume = sum(this.candidate) * this.area;
    telemetry.relativeVolumeError = Math.abs(nextVolume - this.initialVolume) / this.initialVolume;
    if (!Number.isFinite(nextVolume) || telemetry.relativeVolumeError > 2e-10)
      return reject("Closed-film volume conservation failed");
    for (let i = 0; i < n; i++) {
      const gradient = (this.pressure[this.next(i)]! - this.pressure[i]!) / this.dx;
      const flux = -this.mobility[i]! * gradient;
      telemetry.dissipationW += this.mobility[i]! * gradient * gradient * this.area;
      telemetry.maxFilmReynolds = Math.max(telemetry.maxFilmReynolds,
        this.config.densityKgM3 * Math.abs(flux) / this.config.viscosityPaS);
    }
    if (!Number.isFinite(telemetry.maxFilmReynolds) || telemetry.maxFilmReynolds > 1)
      return reject("Candidate exceeds the inertialess film Reynolds bound of 1");
    const nextEnergy = this.energy(this.candidate);
    telemetry.energyDeltaJ = nextEnergy - energyBefore;
    telemetry.energyInequalityDefectJ = telemetry.energyDeltaJ + dtSeconds * telemetry.dissipationW;
    const energyScale = Math.max(Math.abs(energyBefore), Math.abs(nextEnergy),
      this.config.surfaceTensionNm * this.config.widthM * this.config.lengthM * 1e-12);
    if (!Number.isFinite(telemetry.energyInequalityDefectJ)
      || telemetry.energyInequalityDefectJ > energyScale * 2e-8)
      return reject("Capillary/wetting energy inequality failed");
    this.height.set(this.candidate); this.clock += dtSeconds;
    return { accepted: true, telemetry, snapshot: this.snapshot() };
  }
}
