import { ballisticLandingTime, ballisticState, type VesselEmission, type VesselLandingEvent, type VesselVector } from "./vesselSolver";
import { JetCollectorCollision, type JetCollectorSurface, type JetSurfaceContact, type JetCollisionQuery } from "./jetCollision";
export type { JetCollectorSurface } from "./jetCollision";

export interface JetBreakupConfig {
  densityKgM3: number;
  viscosityPaS: number;
  surfaceTensionNM: number;
  /** Explicit disturbance assumption; zero disables this instability. */
  initialRelativeAmplitude: number;
  /** Radius-based Weber gate; an engineering eligibility limit, not a transition law. */
  minimumWeber: number;
  fixedDtSeconds: number;
  gravityMS2: VesselVector;
  collectionPlaneYM: number;
  /** Bound on all stored cohorts, constituent portions, and detached drops. */
  maxElements: number;
}
export interface JetMode {
  ohnesorge: number;
  dimensionlessWavenumber: number;
  wavelengthM: number;
  growthRateSInv: number;
  capillaryTimeSeconds: number;
  breakupAgeSeconds: number;
}
export interface JetLigament {
  id: number;
  holeId: string;
  volumeM3: number;
  points: { positionM: VesselVector; radiusM: number }[];
  connectedToSource: boolean;
  relativeAmplitude: number;
  mode: "capillary" | "unresolved-dripping" | "short-ligament" | "intercepted";
}
export interface JetDrop {
  id: number; holeId: string; positionM: VesselVector; velocityMS: VesselVector;
  radiusM: number; volumeM3: number; ageSeconds: number;
}
export interface JetPinchEvent {
  id: number; holeId: string; timeSeconds: number; volumeM3: number;
  positionM: VesselVector; velocityMS: VesselVector; radiusM: number;
  /** Kinetic energy lost by replacing constituent velocities with their mean.
   * Does not account for surface energy or unresolved capillary velocity modes.
   */
  mergeKineticEnergyLostJ: number;
}
export interface JetBreakupSnapshot {
  timeSeconds: number;
  emittedVolumeM3: number;
  inFlightVolumeM3: number;
  landedVolumeM3: number;
  volumeErrorM3: number;
  ligaments: JetLigament[];
  droplets: JetDrop[];
  landingEvents: VesselLandingEvent[];
  pinchEvents: JetPinchEvent[];
  pinchCount: number;
  mergeKineticEnergyLostJ: number;
  /** Current volume outside the radius-Weber eligibility gate. */
  lowWeberVolumeM3: number;
  model: "convected-viscous-rayleigh-plateau-closure";
}
declare const jetCheckpointBrand: unique symbol;
export interface JetBreakupCheckpoint { readonly [jetCheckpointBrand]: true; }

const finite = (value: number, min: number, max: number, name: string) => {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be finite within [${min}, ${max}]`);
};
const vec = (value: VesselVector, name: string) => {
  if (!value || value.length !== 3 || !value.every(Number.isFinite)) throw new RangeError(`${name} must be a finite vector`);
};
const copy = (v: VesselVector): VesselVector => [v[0], v[1], v[2]];
const norm = (v: VesselVector) => Math.hypot(...v);
const distance = (a: VesselVector, b: VesselVector) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Weber's viscous slender-jet growth relation, Driessen et al. 2013 Eq.4.
 * kappa=kR; only the unstable band 0<kappa<1 is returned. Stable modes
 * are deliberately not presented as an oscillation/damping solver.
 */
export function rayleighPlateauGrowthRate(radiusM: number, densityKgM3: number, viscosityPaS: number,
  surfaceTensionNM: number, kappa: number): number {
  finite(radiusM, 1e-8, 1, "Jet radius"); finite(densityKgM3, 1, 2e4, "Density");
  finite(viscosityPaS, 0, 100, "Viscosity"); finite(surfaceTensionNM, 0, 10, "Surface tension");
  finite(kappa, 0, 1e6, "Dimensionless wavenumber");
  if (surfaceTensionNM === 0 || kappa === 0 || kappa >= 1) return 0;
  const oh = viscosityPaS / Math.sqrt(densityKgM3 * surfaceTensionNM * radiusM);
  const capillaryTime = Math.sqrt(densityKgM3 * radiusM ** 3 / surfaceTensionNM);
  const drive = .5 * kappa ** 2 * (1 - kappa ** 2), damping = 1.5 * oh * kappa ** 2;
  // Rationalized positive root prevents cancellation at high viscosity.
  return drive / (Math.hypot(Math.sqrt(drive), damping) + damping) / capillaryTime;
}

export function fastestRayleighPlateauMode(radiusM: number, config: Pick<JetBreakupConfig,
  "densityKgM3" | "viscosityPaS" | "surfaceTensionNM" | "initialRelativeAmplitude">): JetMode {
  finite(config.initialRelativeAmplitude, 0, .1, "Initial relative disturbance");
  rayleighPlateauGrowthRate(radiusM, config.densityKgM3, config.viscosityPaS, config.surfaceTensionNM, .5);
  if (config.surfaceTensionNM === 0) return { ohnesorge: Infinity, dimensionlessWavenumber: 0,
    wavelengthM: Infinity, growthRateSInv: 0, capillaryTimeSeconds: Infinity, breakupAgeSeconds: Infinity };
  const ohnesorge = config.viscosityPaS / Math.sqrt(config.densityKgM3 * config.surfaceTensionNM * radiusM);
  const dimensionlessWavenumber = 1 / Math.sqrt(2 + 3 * Math.sqrt(2) * ohnesorge);
  const growthRateSInv = rayleighPlateauGrowthRate(radiusM, config.densityKgM3, config.viscosityPaS,
    config.surfaceTensionNM, dimensionlessWavenumber);
  return { ohnesorge, dimensionlessWavenumber, wavelengthM: 2 * Math.PI * radiusM / dimensionlessWavenumber,
    growthRateSInv, capillaryTimeSeconds: Math.sqrt(config.densityKgM3 * radiusM ** 3 / config.surfaceTensionNM),
    breakupAgeSeconds: config.initialRelativeAmplitude === 0 ? Infinity : -Math.log(config.initialRelativeAmplitude) / growthRateSInv };
}

interface Portion {
  id: number; volumeM3: number; originM: VesselVector; initialVelocityMS: VesselVector;
  emissionTimeSeconds: number; durationSeconds: number; materialStartM3: number; materialEndM3: number;
  landingTimeSeconds: number;
}
interface Cohort {
  id: number; key: string; holeId: string; runId: number; index: number; radiusM: number;
  targetVolumeM3: number; receivedVolumeM3: number; portions: Portion[];
  mode: JetMode; minWeber: number; intercepted: boolean; completionTimeSeconds: number;
}
interface StoredDrop {
  id: number; holeId: string; volumeM3: number; radiusM: number; originM: VesselVector;
  initialVelocityMS: VesselVector; birthTimeSeconds: number; landingTimeSeconds: number;
}
interface JetState {
  timeSeconds: number; stepIndex: number; lastEmissionId: number; nextId: number;
  cohorts: Map<string, Cohort>; drops: StoredDrop[]; runVolumes: Map<number, number>;
  emitted: number; landed: number; pinchCount: number; kineticLoss: number;
  landingEvents: VesselLandingEvent[]; pinchEvents: JetPinchEvent[];
}

/** Conservative reduced topology closure. Pressure/flow remain owned by the
 * vessel solver; this class owns external flight, pinch replacement and impacts.
 * It does not solve nonlinear slender-jet momentum, satellite drops, wetting,
 * air drag or turbulent atomization. See JET_BREAKUP.md.
 */
export class JetBreakupExperiment {
  readonly config: JetBreakupConfig;
  private state: JetState;
  private readonly checkpoints = new WeakMap<JetBreakupCheckpoint, JetState>();
  constructor(config: JetBreakupConfig) {
    finite(config.densityKgM3, 500, 2000, "Density"); finite(config.viscosityPaS, 0, 1, "Viscosity");
    finite(config.surfaceTensionNM, 0, .2, "Surface tension");
    finite(config.initialRelativeAmplitude, 0, .1, "Initial disturbance");
    finite(config.minimumWeber, 0, 1e4, "Minimum Weber number");
    finite(config.fixedDtSeconds, 1e-4, .01, "Fixed timestep");
    finite(config.collectionPlaneYM, -10, 10, "Collection plane"); vec(config.gravityMS2, "Gravity");
    config.gravityMS2.forEach(v => finite(v, -100, 100, "Gravity"));
    if (config.gravityMS2[1] > 0) throw new RangeError("Collector requires nonpositive vertical gravity");
    if (!Number.isInteger(config.maxElements) || config.maxElements < 8 || config.maxElements > 50000)
      throw new RangeError("Jet capacity must be an integer from 8 to 50000");
    this.config = Object.freeze({ ...config, gravityMS2: Object.freeze(copy(config.gravityMS2)) });
    this.state = this.initialState();
  }
  private initialState(): JetState {
    return { timeSeconds: 0, stepIndex: 0, lastEmissionId: -1, nextId: 0, cohorts: new Map(), drops: [], runVolumes: new Map(),
      emitted: 0, landed: 0, pinchCount: 0, kineticLoss: 0, landingEvents: [], pinchEvents: [] };
  }
  private clone(s: JetState): JetState {
    return { ...s, cohorts: new Map([...s.cohorts].map(([k, c]) => [k, { ...c, portions: [...c.portions] }])),
      drops: [...s.drops], runVolumes: new Map(s.runVolumes), landingEvents: [...s.landingEvents], pinchEvents: [...s.pinchEvents] };
  }
  checkpoint(): JetBreakupCheckpoint {
    const token = Object.freeze({}) as JetBreakupCheckpoint; this.checkpoints.set(token, this.clone(this.state)); return token;
  }
  restore(token: JetBreakupCheckpoint): void {
    const state = this.checkpoints.get(token);
    if (!state) throw new Error("Jet checkpoint does not belong to this experiment");
    this.state = this.clone(state);
  }
  reset(): void { this.state = this.initialState(); }

  private addEmission(s: JetState, e: VesselEmission, endTime: number): void {
    const c = this.config, tolerance = c.fixedDtSeconds * 1e-8;
    if (!Number.isSafeInteger(e.id) || e.id <= s.lastEmissionId || !Number.isSafeInteger(e.runId) || e.runId < 0)
      throw new Error("Emission ids must be new, ordered integers with a valid run id");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(e.holeId)) throw new Error("Invalid emission hole id");
    finite(e.radiusM, .00005, .0015, "Emission radius"); finite(e.volumeM3, Number.MIN_VALUE, .001, "Emission volume");
    finite(e.runVolumeStartM3, 0, .02, "Run material coordinate");
    finite(e.emissionTimeSeconds, 0, 121, "Emission time");
    finite(e.durationSeconds, c.fixedDtSeconds * (1 - 1e-10), c.fixedDtSeconds * (1 + 1e-10), "Emission duration");
    vec(e.originM, "Emission origin"); vec(e.initialVelocityMS, "Emission velocity");
    if (e.originM[1] <= c.collectionPlaneYM) throw new Error("Emission must start above collector");
    if (e.emissionTimeSeconds - e.durationSeconds / 2 < s.timeSeconds - tolerance
      || e.emissionTimeSeconds + e.durationSeconds / 2 > endTime + tolerance)
      throw new Error("Emission interval lies outside the accepted fixed step");
    const speed = norm(e.initialVelocityMS), area = Math.PI * e.radiusM ** 2;
    if (!(speed > 0) || Math.abs(e.volumeM3 - area * speed * e.durationSeconds) > Math.max(1e-22, e.volumeM3 * 1e-8))
      throw new Error("Emission volume does not match its aperture area, speed and duration");
    const previous = s.runVolumes.get(e.runId) ?? 0;
    if (Math.abs(e.runVolumeStartM3 - previous) > Math.max(1e-22, previous * 1e-10))
      throw new Error("Emission run material coordinate is discontinuous");
    const mode = fastestRayleighPlateauMode(e.radiusM, c);
    // With gamma=0 there is no capillary wavelength. One emission is retained
    // as an explicitly unbroken ballistic segment instead of inventing breakup.
    const hasWavelength = Number.isFinite(mode.wavelengthM);
    const target = hasWavelength ? area * mode.wavelengthM : e.volumeM3;
    const weber = c.surfaceTensionNM > 0 ? c.densityKgM3 * speed ** 2 * e.radiusM / c.surfaceTensionNM : 0;
    let consumed = 0, iterations = 0;
    while (consumed < e.volumeM3) {
      if (++iterations > c.maxElements) throw new Error("Jet emission subdivision capacity exceeded");
      const coordinate = e.runVolumeStartM3 + consumed, ratio = coordinate / target;
      const rounded = Math.round(ratio);
      const index = hasWavelength
        ? Math.abs(ratio - rounded) < 64 * Number.EPSILON * Math.max(1, ratio) ? rounded : Math.floor(ratio)
        : e.id;
      const start = hasWavelength ? index * target : e.runVolumeStartM3;
      const room = hasWavelength ? Math.max(0, (index + 1) * target - coordinate) : e.volumeM3 - consumed;
      let volume = Math.min(e.volumeM3 - consumed, room);
      if (!(volume > 0)) throw new Error("Jet material partition lost floating-point progress");
      // Retain an ulp-scale remainder in this portion instead of a zero-size
      // extra piece; no source volume is discarded.
      if (e.volumeM3 - consumed - volume < e.volumeM3 * 8 * Number.EPSILON) volume = e.volumeM3 - consumed;
      const key = `${e.runId}:${index}`;
      let cohort = s.cohorts.get(key);
      if (!cohort) {
        cohort = { id: s.nextId++, key, holeId: e.holeId, runId: e.runId, index, radiusM: e.radiusM,
          targetVolumeM3: target, receivedVolumeM3: 0, portions: [], mode, minWeber: weber,
          intercepted: false, completionTimeSeconds: Infinity };
        s.cohorts.set(key, cohort);
      }
      if (cohort.radiusM !== e.radiusM || cohort.holeId !== e.holeId) throw new Error("An aperture edit requires a new emission run");
      const durationSeconds = e.durationSeconds * volume / e.volumeM3;
      const emissionTimeSeconds = e.emissionTimeSeconds - e.durationSeconds / 2
        + e.durationSeconds * (consumed + volume / 2) / e.volumeM3;
      const portion: Portion = { id: s.nextId++, volumeM3: volume, originM: copy(e.originM),
        initialVelocityMS: copy(e.initialVelocityMS), emissionTimeSeconds, durationSeconds,
        materialStartM3: Math.max(0, coordinate - start), materialEndM3: Math.min(target, coordinate - start + volume),
        landingTimeSeconds: emissionTimeSeconds + ballisticLandingTime(e.originM[1] - c.collectionPlaneYM,
          e.initialVelocityMS[1], c.gravityMS2[1]) };
      cohort.portions.push(portion); cohort.receivedVolumeM3 += volume; cohort.minWeber = Math.min(cohort.minWeber, weber);
      if (cohort.receivedVolumeM3 >= target * (1 - 1e-12))
        cohort.completionTimeSeconds = emissionTimeSeconds + durationSeconds / 2;
      consumed += volume;
    }
    s.runVolumes.set(e.runId, e.runVolumeStartM3 + e.volumeM3);
    s.lastEmissionId = e.id; s.emitted += e.volumeM3;
  }

  private impact(s: JetState, id: number, holeId: string, origin: VesselVector, velocity: VesselVector,
    birth: number, landing: number, volume: number, radius: number, contactPosition?: VesselVector,
    surface?: JetSurfaceContact["surface"], sourceAttachment?: VesselLandingEvent["sourceAttachment"]): void {
    const physical = ballisticState(origin, velocity, this.config.gravityMS2, Math.max(0, landing - birth));
    s.landed += volume;
    s.landingEvents.push({ id, holeId, timeSeconds: landing,
      positionM: contactPosition ? copy(contactPosition) : [physical.positionM[0], this.config.collectionPlaneYM, physical.positionM[2]],
      velocityMS: physical.velocityMS, volumeM3: volume, supportRadiusM: radius,
      ...(surface ? { surface: { triangle: surface.triangle, barycentric: copy(surface.barycentric) } } : {}),
      ...(sourceAttachment ? { sourceAttachment: { ...sourceAttachment } } : {}) });
  }
  private eligible(s: JetState, cohort: Cohort): boolean {
    return !cohort.intercepted && cohort.minWeber >= this.config.minimumWeber && cohort.mode.growthRateSInv > 0
      && (s.runVolumes.get(cohort.runId) ?? 0) >= 4 * cohort.targetVolumeM3 * (1 - 1e-12);
  }
  private pinchTime(cohort: Cohort): number {
    if (!Number.isFinite(cohort.completionTimeSeconds) || !Number.isFinite(cohort.mode.breakupAgeSeconds)) return Infinity;
    const volume = cohort.portions.reduce((sum, p) => sum + p.volumeM3, 0);
    const meanBirth = cohort.portions.reduce((sum, p) => sum + p.volumeM3 * p.emissionTimeSeconds, 0) / volume;
    return Math.max(cohort.completionTimeSeconds, meanBirth + cohort.mode.breakupAgeSeconds);
  }

  /** Exactly one fixed step; each emission may be accepted once. Mutations are
   * committed only after all numeric/capacity/volume checks pass.
   */
  step(input: { timeSeconds: number; emissions: readonly VesselEmission[]; collectorSurface?: JetCollectorSurface;
    /** Replaces the default collector, and must include any desired escape
     * plane itself. Cannot be combined with collectorSurface. */
    collision?: JetCollisionQuery }): JetBreakupSnapshot {
    const before = this.state, c = this.config, expected = (before.stepIndex + 1) * c.fixedDtSeconds;
    if (!Number.isFinite(input.timeSeconds) || Math.abs(input.timeSeconds - expected) > c.fixedDtSeconds * 1e-8)
      throw new Error("Jet flight must advance by exactly one fixed timestep");
    if (!Array.isArray(input.emissions)) throw new Error("Jet emissions must be an array");
    // Reconstruct a private copy once. The caller's accepted field is never
    // mutated; it remains frozen throughout this explicit coupled step.
    if (input.collectorSurface && input.collision) throw new Error("Choose one flight collision surface");
    const sourceCollision = input.collectorSurface
      ? new JetCollectorCollision(input.collectorSurface, before.timeSeconds, c.collectionPlaneYM) : input.collision;
    // Validate callbacks at this boundary; invalid contacts cannot create
    // retroactive impacts, poisoned surface coordinates, or nonfinite geometry.
    const collision: JetCollisionQuery | undefined = sourceCollision ? { contact: (...args) => {
      const hit = sourceCollision.contact(...args); if (!hit) return undefined;
      const first = Math.max(args[3], args[4]), last = args[5];
      if (!Number.isFinite(hit.timeSeconds) || hit.timeSeconds < first - 1e-12 || hit.timeSeconds > last + 1e-12)
        throw new Error("Custom collision returned a time outside this accepted interval");
      vec(hit.positionM, "Collision position");
      if (hit.sourceAttachment !== undefined && typeof hit.sourceAttachment !== "boolean")
        throw new Error("Custom collision returned invalid source attachment");
      if (hit.sourceAttachment && (args[6] !== 0 || Math.abs(hit.timeSeconds - args[3]) > 1e-12
        || args[3] < before.timeSeconds - 1e-12 || !hit.surface))
        throw new Error("Source attachment must be an immediate newly emitted surface contact");
      if (hit.surface && (!Number.isSafeInteger(hit.surface.triangle) || hit.surface.triangle < 0
        || hit.surface.barycentric.length !== 3 || !hit.surface.barycentric.every(x => Number.isFinite(x) && x >= -1e-10 && x <= 1 + 1e-10)
        || Math.abs(hit.surface.barycentric.reduce((a, b) => a + b, 0) - 1) > 1e-8))
        throw new Error("Custom collision returned invalid surface coordinates");
      return hit;
    } } : undefined;
    const s = this.clone(before); s.landingEvents = []; s.pinchEvents = [];
    for (const emission of input.emissions) this.addEmission(s, emission, input.timeSeconds);
    const retained: StoredDrop[] = [];
    for (const drop of s.drops) {
      const contact = collision?.contact(drop.originM, drop.initialVelocityMS, c.gravityMS2, drop.birthTimeSeconds,
        before.timeSeconds, input.timeSeconds, drop.radiusM);
      const landingTime = collision ? contact?.timeSeconds ?? Infinity : drop.landingTimeSeconds;
      if (landingTime <= input.timeSeconds)
        this.impact(s, drop.id, drop.holeId, drop.originM, drop.initialVelocityMS, drop.birthTimeSeconds,
          landingTime, drop.volumeM3, drop.radiusM, contact?.positionM, contact?.surface);
      else retained.push(drop);
    }
    s.drops = retained;
    for (const [key, cohort] of s.cohorts) {
      const contacts = new Map<number, JetSurfaceContact>();
      if (collision) for (const portion of cohort.portions) {
        const contact = collision.contact(portion.originM, portion.initialVelocityMS, c.gravityMS2,
          portion.emissionTimeSeconds, before.timeSeconds, input.timeSeconds, 0);
        if (contact) contacts.set(portion.id, contact);
      }
      // Eligibility can first become established this step (four wavelengths).
      // Never emit a retroactive event before the accepted interval.
      const pinchTime = this.eligible(s, cohort) ? Math.max(before.timeSeconds, this.pinchTime(cohort)) : Infinity;
      const earliestImpact = Math.min(...cohort.portions.map(p => collision ? contacts.get(p.id)?.timeSeconds ?? Infinity : p.landingTimeSeconds));
      if (pinchTime <= input.timeSeconds && pinchTime < earliestImpact) {
        const volume = cohort.portions.reduce((sum, p) => sum + p.volumeM3, 0);
        const states = cohort.portions.map(p => ({ volume: p.volumeM3,
          ...ballisticState(p.originM, p.initialVelocityMS, c.gravityMS2, Math.max(0, pinchTime - p.emissionTimeSeconds)) }));
        const position: [number, number, number] = [0, 0, 0], velocity: [number, number, number] = [0, 0, 0];
        for (const state of states) for (let i = 0; i < 3; ++i) {
          position[i] = position[i]! + state.positionM[i]! * state.volume / volume;
          velocity[i] = velocity[i]! + state.velocityMS[i]! * state.volume / volume;
        }
        const energyLoss = .5 * c.densityKgM3 * states.reduce((sum, p) =>
          sum + p.volume * ((p.velocityMS[0] - velocity[0]) ** 2 + (p.velocityMS[1] - velocity[1]) ** 2
            + (p.velocityMS[2] - velocity[2]) ** 2), 0);
        const radius = Math.cbrt(3 * volume / (4 * Math.PI));
        const clearance = position[1] - radius - c.collectionPlaneYM;
        const landingTime = pinchTime + (clearance <= 0 ? 0 : ballisticLandingTime(clearance, velocity[1], c.gravityMS2[1]));
        const drop: StoredDrop = { id: cohort.id, holeId: cohort.holeId, volumeM3: volume, radiusM: radius,
          originM: position, initialVelocityMS: velocity, birthTimeSeconds: pinchTime, landingTimeSeconds: landingTime };
        const event: JetPinchEvent = { id: drop.id, holeId: drop.holeId, timeSeconds: pinchTime, volumeM3: volume,
          positionM: copy(position), velocityMS: copy(velocity), radiusM: radius, mergeKineticEnergyLostJ: energyLoss };
        s.pinchEvents.push(event); ++s.pinchCount; s.kineticLoss += energyLoss;
        const contact = collision?.contact(position, velocity, c.gravityMS2, pinchTime, pinchTime, input.timeSeconds, radius);
        const acceptedLanding = collision ? contact?.timeSeconds ?? Infinity : landingTime;
        if (acceptedLanding <= input.timeSeconds) this.impact(s, drop.id, drop.holeId, position, velocity,
          pinchTime, acceptedLanding, volume, radius, contact?.positionM, contact?.surface);
        else s.drops.push(drop);
        s.cohorts.delete(key);
      } else {
        const live: Portion[] = [];
        for (const portion of cohort.portions) {
          const contact = contacts.get(portion.id);
          const landingTime = collision ? contact?.timeSeconds ?? Infinity : portion.landingTimeSeconds;
          if (landingTime <= input.timeSeconds) {
            this.impact(s, portion.id, cohort.holeId, portion.originM, portion.initialVelocityMS, portion.emissionTimeSeconds,
              landingTime, portion.volumeM3, 0, contact?.positionM, contact?.surface,
              contact?.sourceAttachment ? {
                startTimeSeconds: portion.emissionTimeSeconds - portion.durationSeconds / 2,
                endTimeSeconds: portion.emissionTimeSeconds + portion.durationSeconds / 2, radiusM: cohort.radiusM,
              } : undefined);
            cohort.intercepted = true;
          } else live.push(portion);
        }
        cohort.portions = live;
        if (!live.length) s.cohorts.delete(key);
      }
    }
    const count = s.drops.length + [...s.cohorts.values()].reduce((sum, cohort) => sum + 1 + cohort.portions.length, 0);
    if (count > c.maxElements) throw new Error("Capillary flight capacity reached; whole step rolled back");
    const inFlight = s.drops.reduce((sum, p) => sum + p.volumeM3, 0)
      + [...s.cohorts.values()].reduce((sum, cohort) => sum + cohort.portions.reduce((v, p) => v + p.volumeM3, 0), 0);
    if (![inFlight, s.landed, s.emitted, s.kineticLoss].every(Number.isFinite)
      || Math.abs(inFlight + s.landed - s.emitted) > Math.max(1e-18, s.emitted * 1e-10))
      throw new Error("Capillary flight volume invariant failed; whole step rolled back");
    s.timeSeconds = input.timeSeconds; ++s.stepIndex;
    const relevantRuns = new Set([...input.emissions.map(e => e.runId), ...[...s.cohorts.values()].map(cohort => cohort.runId)]);
    for (const runId of s.runVolumes.keys()) if (!relevantRuns.has(runId)) s.runVolumes.delete(runId);
    s.landingEvents.sort((a, b) => a.timeSeconds - b.timeSeconds || a.id - b.id);
    s.pinchEvents.sort((a, b) => a.timeSeconds - b.timeSeconds || a.id - b.id);
    this.state = s;
    // Geometry validation is part of the transaction, rather than committing
    // physics that the renderer cannot faithfully represent.
    try { return this.snapshot(); } catch (error) { this.state = before; throw error; }
  }

  private ligamentGeometry(cohort: Cohort, portions: readonly Portion[], group: number): JetLigament {
    const s = this.state, c = this.config, first = portions[0]!, last = portions[portions.length - 1]!;
    const start = first.materialStartM3, end = last.materialEndM3;
    const volume = portions.reduce((sum, p) => sum + p.volumeM3, 0);
    const eligible = this.eligible(s, cohort);
    const meanBirth = portions.reduce((sum, p) => sum + p.volumeM3 * p.emissionTimeSeconds, 0) / volume;
    const amplitude = eligible && c.initialRelativeAmplitude > 0
      ? Math.min(1 - 1e-8, c.initialRelativeAmplitude * Math.exp(Math.min(50, cohort.mode.growthRateSInv * (s.timeSeconds - meanBirth)))) : 0;
    const points: JetLigament["points"] = [];
    let index = 0;
    for (let j = 0; j <= 16; ++j) {
      const material = start + (end - start) * j / 16;
      while (index < portions.length - 1 && material > portions[index]!.materialEndM3) ++index;
      const portion = portions[index]!;
      const fraction = Math.min(1, Math.max(0, (material - portion.materialStartM3)
        / Math.max(Number.MIN_VALUE, portion.materialEndM3 - portion.materialStartM3)));
      const emissionTime = portion.emissionTimeSeconds + (fraction - .5) * portion.durationSeconds;
      const position = ballisticState(portion.originM, portion.initialVelocityMS, c.gravityMS2,
        Math.max(0, s.timeSeconds - emissionTime)).positionM;
      const phase = material / cohort.targetVolumeM3;
      points.push({ positionM: position, radiusM: 1 - amplitude * Math.cos(2 * Math.PI * phase) });
    }
    let referenceVolume = 0;
    for (let i = 1; i < points.length; ++i) {
      const a = points[i - 1]!, b = points[i]!;
      referenceVolume += Math.PI * distance(a.positionM, b.positionM)
        * (a.radiusM ** 2 + a.radiusM * b.radiusM + b.radiusM ** 2) / 3;
    }
    if (!(referenceVolume > 0) || !Number.isFinite(referenceVolume)) throw new Error("Degenerate jet ligament support");
    const scale = Math.sqrt(volume / referenceVolume);
    for (const point of points) {
      point.radiusM *= scale;
      if (!(point.radiusM > 0) || !Number.isFinite(point.radiusM) || !point.positionM.every(Number.isFinite))
        throw new Error("Nonfinite capillary geometry");
    }
    const mode: JetLigament["mode"] = cohort.intercepted ? "intercepted"
      : cohort.minWeber < c.minimumWeber || cohort.mode.growthRateSInv === 0 ? "unresolved-dripping"
        : !eligible || !Number.isFinite(cohort.completionTimeSeconds) ? "short-ligament" : "capillary";
    return { id: cohort.id * c.maxElements + group, holeId: cohort.holeId, volumeM3: volume, points,
      connectedToSource: last.emissionTimeSeconds + last.durationSeconds / 2 >= s.timeSeconds - 1e-10,
      relativeAmplitude: amplitude, mode };
  }

  snapshot(): JetBreakupSnapshot {
    const s = this.state, c = this.config, ligaments: JetLigament[] = [];
    let lowWeberVolumeM3 = 0;
    for (const cohort of s.cohorts.values()) {
      let group: Portion[] = [], groupIndex = 0;
      for (const portion of cohort.portions) {
        if (group.length && portion.materialStartM3 - group[group.length - 1]!.materialEndM3 > cohort.targetVolumeM3 * 1e-10) {
          ligaments.push(this.ligamentGeometry(cohort, group, groupIndex++)); group = [];
        }
        group.push(portion);
        if (cohort.minWeber < c.minimumWeber) lowWeberVolumeM3 += portion.volumeM3;
      }
      if (group.length) ligaments.push(this.ligamentGeometry(cohort, group, groupIndex));
    }
    const droplets: JetDrop[] = s.drops.map(drop => ({ id: drop.id, holeId: drop.holeId, radiusM: drop.radiusM,
      volumeM3: drop.volumeM3, ageSeconds: s.timeSeconds - drop.birthTimeSeconds,
      ...ballisticState(drop.originM, drop.initialVelocityMS, c.gravityMS2, s.timeSeconds - drop.birthTimeSeconds) }));
    const inFlightVolumeM3 = ligaments.reduce((sum, p) => sum + p.volumeM3, 0) + droplets.reduce((sum, p) => sum + p.volumeM3, 0);
    return { timeSeconds: s.timeSeconds, emittedVolumeM3: s.emitted, inFlightVolumeM3, landedVolumeM3: s.landed,
      volumeErrorM3: inFlightVolumeM3 + s.landed - s.emitted, ligaments, droplets,
      landingEvents: s.landingEvents.map(e => ({ ...e, positionM: copy(e.positionM), velocityMS: copy(e.velocityMS),
        ...(e.surface ? { surface: { triangle: e.surface.triangle, barycentric: copy(e.surface.barycentric) } } : {}),
        ...(e.sourceAttachment ? { sourceAttachment: { ...e.sourceAttachment } } : {}) })),
      pinchEvents: s.pinchEvents.map(e => ({ ...e, positionM: copy(e.positionM), velocityMS: copy(e.velocityMS) })),
      pinchCount: s.pinchCount, mergeKineticEnergyLostJ: s.kineticLoss, lowWeberVolumeM3,
      model: "convected-viscous-rayleigh-plateau-closure" };
  }
}
