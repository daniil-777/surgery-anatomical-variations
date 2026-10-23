import { BLOOD_PROFILES, viscosity, type CYProfile } from "../material";

/**
 * Rigid, straight, fully developed, axisymmetric, laminar tube flow, in SI units:
 * rho du/dt = G(t) + (1/r) d/dr [r mu(|du/dr|) du/dr], G = -dp/dz.
 *
 * Exact annular control volumes; zero axis flux; no slip at the PHYSICAL face R.
 * Backward Euler in time, face-consistent Carreau–Yasuda stress, Picard iteration,
 * and a positive tridiagonal solve. There is no radial or axial pressure-wave
 * propagation, vessel compliance, entrance region, stenosis, branch or blood–air
 * interface. This reduced model is not a patient-specific vascular simulator.
 *
 * Sources:
 * Womersley (1955), doi:10.1113/jphysiol.1955.sp005276 (tube-flow equation).
 * Weddell et al. (2015), doi:10.1371/journal.pone.0124575 (CY constitutive tuple).
 * Sochi (2015), https://arxiv.org/pdf/1502.03314 (independent steady stress/Q).
 */
export type ArteryRheology =
  | { kind: "newtonian"; viscosityPaS: number }
  | { kind: "carreau-yasuda"; profileId: string };

export interface ArteryConfig {
  radiusM: number;
  lengthM: number;
  densityKgM3: number;
  radialCells: number;
  rheology: ArteryRheology;
  nonlinearRelativeTolerance: number;
  nonlinearAbsoluteToleranceMS: number;
  maxNonlinearIterations: number;
}

export const DEFAULT_ARTERY_CONFIG: Readonly<ArteryConfig> = Object.freeze({
  radiusM: .003,
  lengthM: .08,
  densityKgM3: 1060,
  radialCells: 64,
  rheology: Object.freeze({ kind: "carreau-yasuda" as const, profileId: "weddell-2015" }),
  nonlinearRelativeTolerance: 1e-8,
  nonlinearAbsoluteToleranceMS: 1e-11,
  maxNonlinearIterations: 100,
});

export interface ArteryTelemetry {
  mode: "transient" | "steady";
  converged: boolean;
  iterations: number;
  dtSeconds: number | null;
  pressureGradientPaPerM: number;
  velocityUpdateMS: number;
  relativeVelocityUpdate: number;
  momentumResidualPaPerM: number;
  relativeMomentumResidual: number;
  /** Integrated axial momentum balance; not an independent 3D continuity test. */
  momentumBalanceRelativeError: number;
  /** Discrete backward-Euler energy identity, in joules; null for a steady solve. */
  energyBalanceResidualJ: number | null;
  backwardEulerDissipationJ: number | null;
}

export interface ArterySnapshot {
  timeSeconds: number;
  acceptedSteps: number;
  radialCentresM: Float64Array;
  annularAreasM2: Float64Array;
  axialVelocityMS: Float64Array;
  flowRateM3S: number;
  meanVelocityMS: number;
  /** Signed axial fluid-on-wall shear; positive for forward pressure-driven flow. */
  wallShearPa: number;
  wallShearRateS: number;
  referenceViscosityPaS: number;
  /** rho |U_mean| (2R) / mu_ref; CY uses muInf, not a transition criterion. */
  reynolds: number;
  volumeM3: number;
  volumeRelativeError: number;
  kineticEnergyJ: number;
  viscousDissipationW: number;
  pressureGradientPaPerM: number;
  pressureDropPa: number;
  /** Backward-Euler integral of signed Q. Inlet and outlet transport are identical
   * by the fully-developed, incompressible ansatz, not by a solved 3D network. */
  netTransportedVolumeM3: number;
}

export interface ArteryStepResult {
  status: "accepted" | "rejected";
  reason?: string;
  telemetry: ArteryTelemetry;
  snapshot: ArterySnapshot;
}

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
}

export class ArteryFlowSolver {
  readonly config: Readonly<ArteryConfig>;
  private readonly profile: CYProfile | undefined;
  private readonly dr: number;
  private readonly area: number;
  private readonly centres: Float64Array;
  private readonly areas: Float64Array;
  private readonly velocity: Float64Array;
  private readonly guess: Float64Array;
  private readonly candidate: Float64Array;
  private readonly faceConductance: Float64Array;
  private readonly lower: Float64Array;
  private readonly diagonal: Float64Array;
  private readonly upper: Float64Array;
  private readonly rhs: Float64Array;
  private readonly cPrime: Float64Array;
  private readonly dPrime: Float64Array;
  private time = 0;
  private steps = 0;
  private gradient = 0;
  private transport = 0;

  get timeSeconds(): number { return this.time; }

  constructor(config: Partial<ArteryConfig> = {}, initialVelocityMS?: ArrayLike<number>) {
    const c = { ...DEFAULT_ARTERY_CONFIG, ...config };
    for (const key of ["radiusM", "lengthM", "densityKgM3", "nonlinearRelativeTolerance", "nonlinearAbsoluteToleranceMS"] as const)
      positive(c[key], key);
    if (!Number.isInteger(c.radialCells) || c.radialCells < 4 || c.radialCells > 4096)
      throw new RangeError("radialCells must be an integer in [4, 4096]");
    if (!Number.isInteger(c.maxNonlinearIterations) || c.maxNonlinearIterations < 1 || c.maxNonlinearIterations > 1000)
      throw new RangeError("maxNonlinearIterations must be an integer in [1, 1000]");
    if (c.nonlinearRelativeTolerance < 1e-12 || c.nonlinearRelativeTolerance > 1e-3)
      throw new RangeError("nonlinearRelativeTolerance must be in [1e-12, 1e-3]");
    if (c.rheology.kind === "newtonian") positive(c.rheology.viscosityPaS, "viscosityPaS");
    else if (c.rheology.kind === "carreau-yasuda") {
      // Narrow the discriminated union before the callback; copy the published
      // profile so a caller cannot mutate the material during an integration.
      const id = c.rheology.profileId, profile = BLOOD_PROFILES.find(p => p.id === id);
      if (!profile) throw new RangeError(`Unknown Carreau–Yasuda profile: ${id}`);
      this.profile = { ...profile };
    } else throw new RangeError("Unsupported artery rheology");
    this.config = Object.freeze({ ...c, rheology: Object.freeze({ ...c.rheology }) });
    const n = c.radialCells;
    this.dr = c.radiusM / n;
    this.area = Math.PI * c.radiusM ** 2;
    this.centres = Float64Array.from({ length: n }, (_, i) => (i + .5) * this.dr);
    this.areas = Float64Array.from({ length: n }, (_, i) => Math.PI * ((i + 1) ** 2 - i ** 2) * this.dr ** 2);
    if (!Number.isFinite(this.area) || this.dr <= 0 || this.areas.some(a => !Number.isFinite(a) || a <= 0))
      throw new RangeError("Tube geometry cannot be represented at this resolution");
    positive(this.area * c.lengthM, "Representable tube volume");
    if (initialVelocityMS && initialVelocityMS.length !== n) throw new RangeError("Initial velocity must contain one value per radial cell");
    this.velocity = initialVelocityMS ? Float64Array.from(initialVelocityMS) : new Float64Array(n);
    if (this.velocity.some(v => !Number.isFinite(v))) throw new RangeError("Initial velocity must be finite");
    this.guess = new Float64Array(n); this.candidate = new Float64Array(n);
    this.faceConductance = new Float64Array(n + 1);
    this.lower = new Float64Array(n); this.diagonal = new Float64Array(n);
    this.upper = new Float64Array(n); this.rhs = new Float64Array(n);
    this.cPrime = new Float64Array(n); this.dPrime = new Float64Array(n);
    this.metrics(this.velocity); // Enforce finite SI state and the constitutive domain.
  }

  private mu(gamma: number): number {
    return this.profile ? viscosity(gamma, this.profile) : (this.config.rheology as { viscosityPaS: number }).viscosityPaS;
  }

  private conductances(u: Float64Array): void {
    const n = this.config.radialCells;
    this.faceConductance[0] = 0; // Exact cylindrical symmetry: no area at r=0.
    for (let face = 1; face <= n; face++) {
      const distance = face === n ? this.dr / 2 : this.dr;
      const delta = face === n ? -u[n - 1]! : u[face]! - u[face - 1]!;
      const mu = this.mu(Math.abs(delta / distance));
      this.faceConductance[face] = 2 * Math.PI * (face * this.dr) * mu / distance;
      if (!Number.isFinite(this.faceConductance[face])) throw new RangeError("Non-finite viscous conductance");
    }
  }

  private linearSolve(dt: number | null, gradient: number): void {
    const n = this.config.radialCells, rho = this.config.densityKgM3;
    for (let i = 0; i < n; ++i) {
      const mass = dt === null ? 0 : rho * this.areas[i]! / dt;
      this.lower[i] = -this.faceConductance[i]!;
      this.upper[i] = i === n - 1 ? 0 : -this.faceConductance[i + 1]!;
      this.diagonal[i] = mass + this.faceConductance[i]! + this.faceConductance[i + 1]!;
      this.rhs[i] = mass * this.velocity[i]! + gradient * this.areas[i]!;
      const pivot = this.diagonal[i]! - (i ? this.lower[i]! * this.cPrime[i - 1]! : 0);
      if (!Number.isFinite(pivot) || pivot <= 0) throw new RangeError("Non-positive or non-finite tridiagonal pivot");
      this.cPrime[i] = this.upper[i]! / pivot;
      this.dPrime[i] = (this.rhs[i]! - (i ? this.lower[i]! * this.dPrime[i - 1]! : 0)) / pivot;
    }
    for (let i = n - 1; i >= 0; --i) {
      this.candidate[i] = this.dPrime[i]! - (i < n - 1 ? this.cPrime[i]! * this.candidate[i + 1]! : 0);
      if (!Number.isFinite(this.candidate[i])) throw new RangeError("Non-finite tridiagonal solution");
    }
  }

  private residual(dt: number | null, gradient: number): { maximum: number; relative: number } {
    let maximum = 0, scale = Math.abs(gradient);
    const n = this.config.radialCells, rho = this.config.densityKgM3;
    for (let i = 0; i < n; ++i) {
      const left = i ? this.faceConductance[i]! * (this.candidate[i]! - this.candidate[i - 1]!) : 0;
      const right = this.faceConductance[i + 1]! * ((i + 1 < n ? this.candidate[i + 1]! : 0) - this.candidate[i]!);
      const diffusion = (right - left) / this.areas[i]!;
      const inertia = dt === null ? 0 : rho * (this.candidate[i]! - this.velocity[i]!) / dt;
      maximum = Math.max(maximum, Math.abs(inertia - gradient - diffusion));
      scale = Math.max(scale, Math.abs(inertia), Math.abs(diffusion));
    }
    // Convert the absolute velocity tolerance to a physical force-density scale.
    const absoluteForce = (rho * (dt === null ? 0 : 1 / dt) + this.mu(0) / this.config.radiusM ** 2)
      * this.config.nonlinearAbsoluteToleranceMS;
    return { maximum, relative: maximum / Math.max(scale, absoluteForce / this.config.nonlinearRelativeTolerance) };
  }

  private metrics(u: Float64Array) {
    this.conductances(u);
    let q = 0, energy = 0, dissipation = 0;
    const c = this.config, n = c.radialCells;
    for (let i = 0; i < n; ++i) {
      q += this.areas[i]! * u[i]!;
      energy += .5 * c.densityKgM3 * c.lengthM * this.areas[i]! * u[i]! ** 2;
      if (i) dissipation += this.faceConductance[i]! * (u[i]! - u[i - 1]!) ** 2 * c.lengthM;
    }
    dissipation += this.faceConductance[n]! * u[n - 1]! ** 2 * c.lengthM;
    const wallGradient = -u[n - 1]! / (this.dr / 2);
    if (![q, energy, dissipation, wallGradient, this.area * c.lengthM].every(Number.isFinite))
      throw new RangeError("Non-finite integrated flow, energy or tube volume");
    return { q, energy, dissipation, wallGradient, wallShear: -this.mu(Math.abs(wallGradient)) * wallGradient };
  }

  snapshot(): ArterySnapshot {
    const c = this.config, m = this.metrics(this.velocity);
    const volume = this.areas.reduce((sum, a) => sum + a * c.lengthM, 0);
    const referenceMu = this.profile ? this.profile.muInf : (c.rheology as { viscosityPaS: number }).viscosityPaS;
    return {
      timeSeconds: this.time, acceptedSteps: this.steps,
      radialCentresM: this.centres.slice(), annularAreasM2: this.areas.slice(), axialVelocityMS: this.velocity.slice(),
      flowRateM3S: m.q, meanVelocityMS: m.q / this.area,
      wallShearPa: m.wallShear, wallShearRateS: Math.abs(m.wallGradient),
      referenceViscosityPaS: referenceMu, reynolds: c.densityKgM3 * Math.abs(m.q / this.area) * 2 * c.radiusM / referenceMu,
      volumeM3: volume, volumeRelativeError: Math.abs(volume / (this.area * c.lengthM) - 1),
      kineticEnergyJ: m.energy, viscousDissipationW: m.dissipation,
      pressureGradientPaPerM: this.gradient, pressureDropPa: this.gradient * c.lengthM,
      netTransportedVolumeM3: this.transport,
    };
  }

  /** Piecewise-linear read-only display interpolation, with symmetry and exact
   * wall value. Q uses the finite-volume state, never this display interpolant. */
  velocityAtRadius(radiusM: number): number {
    if (!Number.isFinite(radiusM) || radiusM < 0 || radiusM > this.config.radiusM) throw new RangeError("Radius must lie in [0, physical R]");
    if (radiusM === this.config.radiusM) return 0;
    if (radiusM <= this.centres[0]!) return this.velocity[0]!;
    const t = radiusM / this.dr - .5, i = Math.floor(t), fraction = t - i;
    if (i >= this.config.radialCells - 1) return this.velocity[this.config.radialCells - 1]! * (this.config.radiusM - radiusM) / (this.dr / 2);
    return this.velocity[i]! * (1 - fraction) + this.velocity[i + 1]! * fraction;
  }

  /** The prescribed gradient is evaluated at the END of this backward-Euler
   * step, t + dt. Waveform sampling belongs to the caller. */
  step(input: { dtSeconds: number; pressureGradientPaPerM: number }): ArteryStepResult {
    positive(input.dtSeconds, "dtSeconds");
    return this.solve(input.dtSeconds, input.pressureGradientPaPerM);
  }

  /** Solve the steady boundary-value problem explicitly, without pretending
   * that it advanced physical time or transported a finite fluid volume. */
  solveSteady(input: { pressureGradientPaPerM: number }): ArteryStepResult {
    return this.solve(null, input.pressureGradientPaPerM);
  }

  private solve(dt: number | null, gradient: number): ArteryStepResult {
    if (!Number.isFinite(gradient)) throw new RangeError("pressureGradientPaPerM must be finite");
    if (!Number.isFinite(gradient * this.config.lengthM)) throw new RangeError("Pressure drop would overflow");
    if (dt !== null && (!Number.isFinite(this.time + dt) || this.time + dt <= this.time))
      throw new RangeError("Physical clock cannot represent this timestep");
    const c = this.config;
    const telemetry: ArteryTelemetry = {
      mode: dt === null ? "steady" : "transient", converged: false, iterations: 0,
      dtSeconds: dt, pressureGradientPaPerM: gradient,
      velocityUpdateMS: Infinity, relativeVelocityUpdate: Infinity,
      momentumResidualPaPerM: Infinity, relativeMomentumResidual: Infinity,
      momentumBalanceRelativeError: Infinity, energyBalanceResidualJ: null, backwardEulerDissipationJ: null,
    };
    this.guess.set(this.velocity);
    let reason = "Nonlinear iteration limit reached; prior state and time retained";
    try {
      for (let iteration = 1; iteration <= c.maxNonlinearIterations; ++iteration) {
        telemetry.iterations = iteration;
        this.conductances(this.guess);
        this.linearSolve(dt, gradient);
        let update = 0, scale = 0;
        for (let i = 0; i < c.radialCells; ++i) {
          update = Math.max(update, Math.abs(this.candidate[i]! - this.guess[i]!));
          scale = Math.max(scale, Math.abs(this.candidate[i]!));
        }
        // Evaluate the ACTUAL nonlinear stress at the new state, not the frozen
        // viscosity of the linear solve. Never accept solely on iterate change.
        this.conductances(this.candidate);
        const residual = this.residual(dt, gradient);
        telemetry.velocityUpdateMS = update;
        telemetry.relativeVelocityUpdate = update / Math.max(scale, c.nonlinearAbsoluteToleranceMS / c.nonlinearRelativeTolerance);
        telemetry.momentumResidualPaPerM = residual.maximum;
        telemetry.relativeMomentumResidual = residual.relative;
        const updateConverged = !this.profile || telemetry.relativeVelocityUpdate <= c.nonlinearRelativeTolerance;
        if (updateConverged && residual.relative <= c.nonlinearRelativeTolerance) {
          telemetry.converged = true;
          break;
        }
        this.guess.set(this.candidate); // Picard: keep the stated physical step.
      }
      if (telemetry.converged) {
        const previous = this.metrics(this.velocity), next = this.metrics(this.candidate);
        const accelerationForce = dt === null ? 0 : c.densityKgM3 * (next.q - previous.q) / dt;
        const pressureForce = gradient * this.area, wallForce = 2 * Math.PI * c.radiusM * next.wallShear;
        telemetry.momentumBalanceRelativeError = Math.abs(accelerationForce - pressureForce + wallForce)
          / Math.max(Math.abs(accelerationForce), Math.abs(pressureForce), Math.abs(wallForce), 1e-30);
        if (dt !== null) {
          let numericalDissipation = 0;
          for (let i = 0; i < c.radialCells; ++i)
            numericalDissipation += .5 * c.densityKgM3 * c.lengthM * this.areas[i]! * (this.candidate[i]! - this.velocity[i]!) ** 2;
          telemetry.backwardEulerDissipationJ = numericalDissipation;
          telemetry.energyBalanceResidualJ = next.energy - previous.energy + numericalDissipation
            + dt * next.dissipation - dt * gradient * c.lengthM * next.q;
          if (![numericalDissipation, telemetry.energyBalanceResidualJ, this.transport + dt * next.q].every(Number.isFinite))
            throw new RangeError("Non-finite energy or transported-volume update");
          this.time += dt; this.steps++; this.transport += dt * next.q;
        }
        this.velocity.set(this.candidate);
        this.gradient = gradient;
        return { status: "accepted", telemetry, snapshot: this.snapshot() };
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      telemetry.converged = false;
    }
    return { status: "rejected", reason, telemetry, snapshot: this.snapshot() };
  }
}
