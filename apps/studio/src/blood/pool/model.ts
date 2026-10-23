/**
 * Blood pool heightfield model — SI parameterization of the webgpu-water
 * wave scheme (jeantimex/webgpu-water, MIT; after Evan Wallace's WebGL Water).
 *
 * The upstream update
 *     v += (average(neighbours) - h) * 2;  v *= 0.995;  h += v
 * is the symplectic-Euler discretisation of the damped wave equation
 *     η_tt + λ η_t = c² ∇²η
 * with Courant number squared C² = c²Δt²/Δx² = 0.5 and e^{-λΔt} = 0.995, in
 * unitless texture coordinates. Here the same scheme is given physical meaning
 * as the linearised shallow-water equations for a blood layer of rest depth H
 * in a closed rectangular tray:
 *     u_t = -g ∇η - λ u,   η_t = -H ∇·u   ⇒   η_tt + λ η_t = gH ∇²η.
 * State is stored nondimensionally (h = η/H, w = Δt η_t / H), so the GPU kernel
 * keeps the upstream form exactly and FP32 keeps its relative precision.
 *
 * Every number below is SI unless its name says otherwise. This is a reduced
 * visual model. It does not resolve capillary waves, finite-depth dispersion,
 * nonlinear steepening, wetting/contact lines, splash or clotting; those limits
 * are quantified by poolValidity() rather than hidden.
 */
import { surfaceTensionCitrated } from "../material";

export const STANDARD_GRAVITY = 9.80665;
export const BLOOD_DENSITY = 1060;
/** Citrated whole blood at 37 °C (Rosina fit, see material.ts). */
export const BLOOD_SURFACE_TENSION = surfaceTensionCitrated(37);
/** The 2D five-point symplectic scheme has |z| = 1 only for C² < 1/2. At the
 *  upstream value C² = 1/2 the checkerboard mode has a double root and grows
 *  linearly; upstream relied on its 0.995 damping to hide this. */
export const MAX_COURANT_SQUARED = .45;
export const POOL_GRIDS = [128, 192, 256] as const;
export type PoolGrid = typeof POOL_GRIDS[number];
export type PoolDamping = "laminar" | "stokes-drop-scale";

export interface PoolConfig {
  /** Inner side of the square stainless tray. */
  lengthM: number;
  /** Rest depth H of the blood layer. */
  depthM: number;
  grid: PoolGrid;
  /** Newtonian dynamic viscosity used for bottom friction. */
  viscosityPaS: number;
  densityKgM3: number;
  surfaceTensionNM: number;
  gravityMS2: number;
  courantSquared: number;
  damping: PoolDamping;
  /** Volume fraction of whole blood after saline irrigation (optics only). */
  bloodFraction: number;
  /** Haemoglobin oxygen saturation used by the spectral optics LUT. */
  oxygenation: number;
  /** Contact radius used by Tate's law for the detaching drop volume. */
  dripContactRadiusM: number;
  /** Instrument (blunt spherical palpator) radius. */
  instrumentRadiusM: number;
}

export const DEFAULT_POOL_CONFIG: Readonly<PoolConfig> = Object.freeze({
  lengthM: .08, depthM: .005, grid: 256, viscosityPaS: .00345, densityKgM3: BLOOD_DENSITY,
  surfaceTensionNM: BLOOD_SURFACE_TENSION, gravityMS2: STANDARD_GRAVITY, courantSquared: .4,
  damping: "stokes-drop-scale", bloodFraction: 1, oxygenation: .75, dripContactRadiusM: .0005,
  instrumentRadiusM: .003,
});

export const POOL_LIMITS = Object.freeze({
  lengthM: [.04, .12], depthM: [.001, .01], viscosityPaS: [.001, .1], courantSquared: [.05, MAX_COURANT_SQUARED],
  bloodFraction: [.02, 1], oxygenation: [0, 1], dripContactRadiusM: [.0002, .0015], instrumentRadiusM: [.002, .01],
} as const);

export interface PoolScheme {
  n: number;
  dxM: number;
  waveSpeedMS: number;
  dtSeconds: number;
  courant: number;
  /** Velocity friction coefficient λ in s⁻¹ (amplitude decays as e^{-λt/2}). */
  frictionPerSecond: number;
  laminarFrictionPerSecond: number;
  stokesFrictionPerSecond: number;
  dampPerStep: number;
  /** Authored drop-deposit footprint radius and the reference wavelength 4R. */
  depositRadiusM: number;
  referenceWavelengthM: number;
  dropVolumeM3: number;
  dropRadiusM: number;
  capillaryLengthM: number;
}

function inRange(name: string, value: number, [lo, hi]: readonly [number, number]) {
  if (!Number.isFinite(value) || value < lo || value > hi) throw new RangeError(`${name} must be within [${lo}, ${hi}]`);
}

export function validatePoolConfig(config: PoolConfig): void {
  for (const key of Object.keys(POOL_LIMITS) as (keyof typeof POOL_LIMITS)[]) inRange(key, config[key], POOL_LIMITS[key]);
  if (!POOL_GRIDS.includes(config.grid)) throw new RangeError(`grid must be one of ${POOL_GRIDS.join(", ")}`);
  if (config.damping !== "laminar" && config.damping !== "stokes-drop-scale") throw new RangeError("Unknown damping law");
  for (const key of ["densityKgM3", "surfaceTensionNM", "gravityMS2"] as const)
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new RangeError(`${key} must be positive`);
  if (config.instrumentRadiusM * 2 >= config.lengthM / 2) throw new RangeError("Instrument is too large for the tray");
}

/** Tate's law: a pendant drop detaches when ρ g V = 2π a σ. Same closure as
 *  the liver runoff release volume; the Harkins–Brown correction is omitted. */
export function tateDropVolumeM3(contactRadiusM: number, surfaceTensionNM: number, densityKgM3: number, gravityMS2: number): number {
  if (![contactRadiusM, surfaceTensionNM, densityKgM3, gravityMS2].every(v => Number.isFinite(v) && v > 0)) throw new RangeError("Tate's law inputs must be positive");
  return 2 * Math.PI * contactRadiusM * surfaceTensionNM / (densityKgM3 * gravityMS2);
}

export function derivePoolScheme(config: PoolConfig): PoolScheme {
  validatePoolConfig(config);
  const n = config.grid, dxM = config.lengthM / n, H = config.depthM;
  const waveSpeedMS = Math.sqrt(config.gravityMS2 * H), courant = Math.sqrt(config.courantSquared);
  const dtSeconds = courant * dxM / waveSpeedMS, nu = config.viscosityPaS / config.densityKgM3;
  const dropVolumeM3 = tateDropVolumeM3(config.dripContactRadiusM, config.surfaceTensionNM, config.densityKgM3, config.gravityMS2);
  const dropRadiusM = Math.cbrt(3 * dropVolumeM3 / (4 * Math.PI));
  // Authored spreading footprint (crater scale ≈ 3 drop radii, at least three
  // cells so the deposit is resolved without grid-scale checkerboarding).
  // Impact momentum, crater/crown dynamics and splash are not modelled.
  const depositRadiusM = Math.max(3 * dropRadiusM, 3 * dxM), referenceWavelengthM = 4 * depositRadiusM;
  const omega = waveSpeedMS * 2 * Math.PI / referenceWavelengthM;
  // Depth-averaged Poiseuille friction (low-frequency limit) and the
  // oscillatory Stokes-layer wall stress Re[τ]/(ρHU) = √(νω/2)/H.
  const laminarFrictionPerSecond = 3 * nu / (H * H), stokesFrictionPerSecond = Math.sqrt(nu * omega / 2) / H;
  const frictionPerSecond = config.damping === "laminar" ? laminarFrictionPerSecond : Math.max(laminarFrictionPerSecond, stokesFrictionPerSecond);
  return {
    n, dxM, waveSpeedMS, dtSeconds, courant, frictionPerSecond, laminarFrictionPerSecond, stokesFrictionPerSecond,
    dampPerStep: Math.exp(-frictionPerSecond * dtSeconds), depositRadiusM, referenceWavelengthM, dropVolumeM3, dropRadiusM,
    capillaryLengthM: Math.sqrt(config.surfaceTensionNM / (config.densityKgM3 * config.gravityMS2)),
  };
}

export interface PoolValidity {
  /** Linear finite-depth phase speed √(tanh(kH)/(kH)) relative to the shallow model at the reference wavelength. */
  dispersionSpeedRatio: number;
  kH: number;
  /** Stokes-layer thickness at the reference frequency and the ratio H/δ. */
  stokesLayerM: number;
  depthToStokesLayer: number;
  /** Capillary-to-gravity restoring ratio (kℓc)² at the reference wavelength. */
  capillaryRatio: number;
  /** Largest |η|/H; the linear model requires ≪ 1. */
  maxRelativeElevation: number;
  status: "within-indicators" | "outside-indicators";
  notes: string[];
}

export function poolValidity(config: PoolConfig, scheme: PoolScheme, maxRelativeElevation = 0): PoolValidity {
  const k = 2 * Math.PI / scheme.referenceWavelengthM, kH = k * config.depthM;
  const dispersionSpeedRatio = Math.sqrt(Math.tanh(kH) / kH);
  const omega = scheme.waveSpeedMS * k, nu = config.viscosityPaS / config.densityKgM3;
  const stokesLayerM = Math.sqrt(2 * nu / omega), capillaryRatio = (k * scheme.capillaryLengthM) ** 2;
  const notes: string[] = [];
  if (kH > .3) notes.push(`Drop-scale ripples travel ${((1 / dispersionSpeedRatio - 1) * 100).toFixed(0)}% faster than linear finite-depth theory (kH = ${kH.toFixed(2)}).`);
  if (capillaryRatio > .1) notes.push(`Surface tension would add ${(capillaryRatio * 100).toFixed(0)}% restoring force at drop scale; capillary waves are not modelled.`);
  if (config.damping === "laminar" && config.depthM / stokesLayerM > 3) notes.push(`Laminar friction under-damps drop-scale waves about ${(config.depthM / (3 * stokesLayerM)).toFixed(1)}× (Stokes layer ${(stokesLayerM * 1e3).toFixed(2)} mm).`);
  if (maxRelativeElevation > .2) notes.push(`Elevation reached ${(maxRelativeElevation * 100).toFixed(0)}% of depth; the linear model is not reliable.`);
  return { dispersionSpeedRatio, kH, stokesLayerM, depthToStokesLayer: config.depthM / stokesLayerM, capillaryRatio,
    maxRelativeElevation, status: notes.length ? "outside-indicators" : "within-indicators", notes };
}

/** Cell-centre x/z in metres, origin at the tray centre. */
export const cellCentreM = (index: number, scheme: Pick<PoolScheme, "n" | "dxM">) => (index + .5 - scheme.n / 2) * scheme.dxM;

/** Raised-cosine deposit weight; identical to the upstream drop profile. */
export function depositWeight(distanceM: number, radiusM: number): number {
  const t = Math.max(0, 1 - distanceM / radiusM);
  return .5 - .5 * Math.cos(t * Math.PI);
}

/** Exact discrete normalisation so a deposit adds precisely `volumeM3`
 *  (including footprints truncated by a wall). Returns the h-amplitude. */
export function depositAmplitude(scheme: Pick<PoolScheme, "n" | "dxM">, depthM: number, xM: number, zM: number, radiusM: number, volumeM3: number): number {
  if (![xM, zM, radiusM, volumeM3, depthM].every(Number.isFinite) || radiusM <= 0 || volumeM3 < 0 || depthM <= 0) throw new RangeError("Invalid deposit");
  let total = 0;
  const lo = (c: number) => Math.max(0, Math.floor((c - radiusM) / scheme.dxM + scheme.n / 2 - .5));
  const hi = (c: number) => Math.min(scheme.n - 1, Math.ceil((c + radiusM) / scheme.dxM + scheme.n / 2 - .5));
  for (let j = lo(zM); j <= hi(zM); j++) for (let i = lo(xM); i <= hi(xM); i++)
    total += depositWeight(Math.hypot(cellCentreM(i, scheme) - xM, cellCentreM(j, scheme) - zM), radiusM);
  if (!(total > 0)) throw new RangeError("The deposit footprint lies outside the tray");
  return volumeM3 / (depthM * scheme.dxM * scheme.dxM * total);
}

/** Vertical chord of a sphere inside the fluid slab [0, H] at horizontal
 *  distance ρ from its centre (linearised about the rest surface). */
export function submergedChordM(rhoM: number, centreYM: number, radiusM: number, depthM: number): number {
  if (rhoM >= radiusM) return 0;
  const half = Math.sqrt(radiusM * radiusM - rhoM * rhoM);
  return Math.max(0, Math.min(depthM, centreYM + half) - Math.max(0, centreYM - half));
}

/** 2×2 supersampled cell average used by both the CPU reference and WGSL. */
export function cellChordM(i: number, j: number, scheme: Pick<PoolScheme, "n" | "dxM">, centre: readonly [number, number, number], radiusM: number, depthM: number): number {
  let sum = 0;
  for (const oy of [-.25, .25]) for (const ox of [-.25, .25]) {
    const x = cellCentreM(i, scheme) + ox * scheme.dxM - centre[0], z = cellCentreM(j, scheme) + oy * scheme.dxM - centre[2];
    sum += submergedChordM(Math.hypot(x, z), centre[1], radiusM, depthM);
  }
  return sum / 4;
}

export interface PoolState { h: Float64Array | Float32Array; w: Float64Array | Float32Array }
export const createPoolState = (n: number, precision: "f64" | "f32" = "f64"): PoolState =>
  precision === "f64" ? { h: new Float64Array(n * n), w: new Float64Array(n * n) } : { h: new Float32Array(n * n), w: new Float32Array(n * n) };

/** CPU reference of the GPU step kernel (clamped/Neumann neighbours). */
export function stepPool(state: PoolState, scheme: Pick<PoolScheme, "n" | "dampPerStep">, courantSquared: number, scratch?: PoolState): PoolState {
  const { n } = scheme, out = scratch ?? createPoolState(n, state.h instanceof Float32Array ? "f32" : "f64"), h = state.h, w = state.w;
  const f = state.h instanceof Float32Array ? Math.fround : (x: number) => x;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const c = j * n + i, hc = h[c]!;
    const lap = f(f(f(f(h[j * n + Math.max(i - 1, 0)]! + h[j * n + Math.min(i + 1, n - 1)]!) + h[Math.max(j - 1, 0) * n + i]!) + h[Math.min(j + 1, n - 1) * n + i]!) - f(4 * hc));
    const next = f(f(w[c]! + f(courantSquared * lap)) * scheme.dampPerStep);
    out.w[c] = next; out.h[c] = f(hc + next);
  }
  return out;
}

export function applyDeposit(state: PoolState, scheme: Pick<PoolScheme, "n" | "dxM">, xM: number, zM: number, radiusM: number, amplitude: number): void {
  for (let j = 0; j < scheme.n; j++) for (let i = 0; i < scheme.n; i++) {
    const weight = depositWeight(Math.hypot(cellCentreM(i, scheme) - xM, cellCentreM(j, scheme) - zM), radiusM);
    if (weight > 0) state.h[j * scheme.n + i] = state.h[j * scheme.n + i]! + amplitude * weight;
  }
}

/** Moving the instrument displaces exactly the change in submerged volume. */
export function applyInstrumentMove(state: PoolState, scheme: Pick<PoolScheme, "n" | "dxM">, depthM: number, from: readonly [number, number, number], to: readonly [number, number, number], radiusM: number): void {
  for (let j = 0; j < scheme.n; j++) for (let i = 0; i < scheme.n; i++) {
    const delta = cellChordM(i, j, scheme, to, radiusM, depthM) - cellChordM(i, j, scheme, from, radiusM, depthM);
    if (delta) state.h[j * scheme.n + i] = state.h[j * scheme.n + i]! + delta / depthM;
  }
}

/** Blood volume in the tray: Σ (H(1+h) − submerged chord) Δx². */
export function poolFluidVolumeM3(state: PoolState, scheme: Pick<PoolScheme, "n" | "dxM">, depthM: number,
  instrument?: { centre: readonly [number, number, number]; radiusM: number }): number {
  let sum = 0;
  for (let j = 0; j < scheme.n; j++) for (let i = 0; i < scheme.n; i++)
    sum += depthM * (1 + state.h[j * scheme.n + i]!) - (instrument ? cellChordM(i, j, scheme, instrument.centre, instrument.radiusM, depthM) : 0);
  return sum * scheme.dxM * scheme.dxM;
}

/** Exact angular frequency of a separable Neumann mode under the discrete scheme
 *  (without damping): sin(ωΔt/2) = C √(sin²(kₓΔx/2) + sin²(k_zΔx/2)). */
export function discreteModeFrequency(scheme: Pick<PoolScheme, "dxM" | "dtSeconds">, courantSquared: number, kx: number, kz: number): number {
  const s = Math.sqrt(courantSquared * (Math.sin(kx * scheme.dxM / 2) ** 2 + Math.sin(kz * scheme.dxM / 2) ** 2));
  if (s > 1) throw new RangeError("Mode is unstable for this Courant number");
  return 2 * Math.asin(s) / scheme.dtSeconds;
}
