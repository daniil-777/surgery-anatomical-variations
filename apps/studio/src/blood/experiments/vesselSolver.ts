/** Conservative 0D perfusion experiment, not a resolved artery/vein CFD model.
 * SI throughout; +Y is up. See VESSEL_PHYSICS.md for equations and limitations.
 */
export type VesselVector = readonly [number, number, number];
export interface VesselHole {
  id: string;
  positionM: VesselVector;
  direction: VesselVector;
  radiusM: number;
  wallLengthM: number;
  /** Empirical loss coefficient; not a measured blood/tissue constant. */
  dischargeCoefficient: number;
}
export interface VesselConfig {
  kind: "artery" | "vein";
  innerRadiusM: number;
  lengthM: number;
  densityKgM3: number;
  viscosityPaS: number;
  sourcePressureMeanPa: number;
  /** Peak-to-trough pressure of the prescribed boundary waveform. */
  sourcePulsePressurePa: number;
  heartRateBpm: number;
  inletResistancePaSM3: number;
  outletResistancePaSM3: number;
  inletOpen: boolean;
  outletOpen: boolean;
  distalPressurePa: number;
  complianceM3Pa: number;
  initialPressurePa: number;
  initialVesselVolumeM3: number;
  minimumVesselVolumeM3: number;
  initialSupplyVolumeM3: number;
  pressureReferencePositionM: VesselVector;
  gravityMS2: VesselVector;
  collectionPlaneYM: number;
  fixedDtSeconds: number;
  maxTimeSeconds: number;
  maxParcels: number;
}
export interface VesselJet {
  holeId: string;
  positionM: VesselVector;
  direction: VesselVector;
  radiusM: number;
  flowM3S: number;
  /** Area-averaged aperture speed Q/A; no assumed vena-contracta radius. */
  velocityMS: number;
  expelledVolumeM3: number;
  drivingPressurePa: number;
  reynoldsNumber: number | null;
}
export interface VesselParcel {
  id: number;
  holeId: string;
  positionM: VesselVector;
  velocityMS: VesselVector;
  volumeM3: number;
  ageSeconds: number;
  emissionTimeSeconds: number;
}
/** Accepted constant-flow emission interval, represented at its midpoint.
 * Run coordinates restart after an occlusion, zero-flow step, or aperture edit.
 */
export interface VesselEmission {
  id: number;
  holeId: string;
  runId: number;
  runVolumeStartM3: number;
  originM: VesselVector;
  initialVelocityMS: VesselVector;
  radiusM: number;
  volumeM3: number;
  emissionTimeSeconds: number;
  durationSeconds: number;
}
export interface VesselLandingEvent {
  id: number; holeId: string; timeSeconds: number; positionM: VesselVector;
  velocityMS: VesselVector; volumeM3: number; supportRadiusM: number;
  /** Optional receiving mesh coordinates; absent for the legacy collector. */
  surface?: { triangle: number; barycentric: VesselVector };
  /** Actual constant-flow portion interval for an explicit immediate source
   * attachment. Ordinary ballistic impacts remain instantaneous events. */
  sourceAttachment?: { startTimeSeconds: number; endTimeSeconds: number; radiusM: number };
}
export interface VesselPerfusionBoundary {
  sourcePressurePa: number;
  distalPressurePa: number;
  /** Available donor inventory for forward inlet flow. */
  inletVolumeLimitM3: number;
  /** Available donor inventory for reverse distal flow. */
  distalVolumeLimitM3: number;
}
declare const vesselCheckpointBrand: unique symbol;
export interface VesselCheckpoint { readonly [vesselCheckpointBrand]: true; }
export interface VesselSnapshot {
  timeSeconds: number;
  stepIndex: number;
  pressurePa: number;
  sourcePressurePa: number;
  vesselVolumeM3: number;
  supplyVolumeM3: number;
  /** Signed net transfer leaving the distal port in external-circulation mode. */
  distalCollectedVolumeM3: number;
  expelledVolumeM3: number;
  inFlightVolumeM3: number;
  landedVolumeM3: number;
  volumeErrorM3: number;
  inletFlowM3S: number;
  distalFlowM3S: number;
  inventoryLimited: boolean;
  status: "ready" | "running" | "source-empty" | "drained" | "complete";
  holeExpelledVolumeM3: Readonly<Record<string, number>>;
  jets: VesselJet[];
  /** Oldest first, only accepted volume-bearing parcels still in flight. */
  parcels: VesselParcel[];
  /** Only the latest accepted step batch; snapshots do not consume events. */
  emissions: VesselEmission[];
  landingEvents: VesselLandingEvent[];
  flightModel: "ballistic-parcels" | "external-capillary";
  perfusionModel: "finite-reservoir" | "external-circulation";
  /** Signed net transfer entering the source port in external-circulation mode. */
  externalSuppliedVolumeM3: number;
  distalBoundaryPressurePa: number;
}
interface StoredParcel extends VesselEmission { landingTimeSeconds: number; }
interface State {
  stepIndex: number; volume: number; supply: number; distal: number; landed: number; expelled: number;
  nextParcel: number; parcels: StoredParcel[]; byHole: Map<string, number>;
  inletFlow: number; distalFlow: number; holeFlows: Map<string, number>; limited: boolean;
  emissions: VesselEmission[]; landingEvents: VesselLandingEvent[]; externalInFlight: number;
  nextRun: number; runs: Map<string, { id: number; lastStep: number; volume: number; signature: string }>;
  externalSupplied: number; sourceBoundaryPa: number; distalBoundaryPa: number;
}
const PULSE_PHASE = [0, .08, .18, .33, .43, .55, 1] as const;
const PULSE_VALUE = [0, 1, .55, .3, .36, .2, 0] as const;
const PULSE_MEAN = PULSE_PHASE.slice(1).reduce<number>((sum, phase, i) =>
  sum + (phase - PULSE_PHASE[i]!) * (PULSE_VALUE[i]! + PULSE_VALUE[i + 1]!) / 2, 0);
const dot = (a: VesselVector, b: VesselVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const copyVector = (v: VesselVector): VesselVector => [v[0], v[1], v[2]];
const inRange = (v: number, lo: number, hi: number, name: string) => {
  if (!Number.isFinite(v) || v < lo || v > hi) throw new RangeError(`${name} must be finite within [${lo}, ${hi}]`);
};
function vector(v: VesselVector, name: string): void {
  if (!v || v.length !== 3 || !v.every(Number.isFinite)) throw new RangeError(`${name} must have three finite components`);
}

/** A prescribed pressure boundary; flow itself is always solved from losses.
 * Shape is an illustrative periodic piecewise-linear pulse, not patient data.
 */
export function vesselSourcePressure(config: Pick<VesselConfig, "sourcePressureMeanPa" | "sourcePulsePressurePa" | "heartRateBpm">, timeSeconds: number): number {
  inRange(timeSeconds, 0, 1e9, "Time");
  inRange(config.sourcePressureMeanPa, 0, 1e5, "Mean source pressure");
  inRange(config.sourcePulsePressurePa, 0, 1e5, "Pulse pressure");
  inRange(config.heartRateBpm, 1, 300, "Heart rate");
  const phase = (timeSeconds * config.heartRateBpm / 60) % 1;
  let index = 0;
  while (index < PULSE_PHASE.length - 2 && phase > PULSE_PHASE[index + 1]!) ++index;
  const fraction = (phase - PULSE_PHASE[index]!) / (PULSE_PHASE[index + 1]! - PULSE_PHASE[index]!);
  const value = PULSE_VALUE[index]! + fraction * (PULSE_VALUE[index + 1]! - PULSE_VALUE[index]!);
  return config.sourcePressureMeanPa + config.sourcePulsePressurePa * (value - PULSE_MEAN);
}

/** Positive root of Δp = R Q + K Q², evaluated without root subtraction. */
export function pressureDrivenDischarge(pressureDropPa: number, resistancePaSM3: number, inertiaPaS2M6: number): number {
  if (!Number.isFinite(pressureDropPa)) throw new RangeError("Pressure drop must be finite");
  inRange(resistancePaSM3, 0, 1e30, "Viscous resistance");
  inRange(inertiaPaS2M6, 0, 1e30, "Inertial coefficient");
  if (resistancePaSM3 === 0 && inertiaPaS2M6 === 0) throw new RangeError("A discharge requires positive resistance or inertia");
  if (pressureDropPa <= 0) return 0;
  if (inertiaPaS2M6 === 0) return pressureDropPa / resistancePaSM3;
  const root = Math.hypot(resistancePaSM3, 2 * Math.sqrt(inertiaPaS2M6) * Math.sqrt(pressureDropPa));
  return 2 * pressureDropPa / (resistancePaSM3 + root);
}

export function punctureCoefficients(radiusM: number, wallLengthM: number, viscosityPaS: number, densityKgM3: number, dischargeCoefficient: number) {
  inRange(radiusM, 1e-6, .1, "Aperture radius");
  inRange(wallLengthM, 0, .1, "Aperture length");
  inRange(viscosityPaS, 0, 1, "Viscosity");
  inRange(densityKgM3, 1, 2e4, "Density");
  inRange(dischargeCoefficient, .05, 1, "Discharge coefficient");
  const areaM2 = Math.PI * radiusM ** 2;
  return {
    areaM2,
    resistancePaSM3: viscosityPaS * (3 / radiusM ** 3 + 8 * wallLengthM / (Math.PI * radiusM ** 4)),
    inertiaPaS2M6: densityKgM3 / (2 * (dischargeCoefficient * areaM2) ** 2),
  };
}

export function ballisticState(originM: VesselVector, velocityMS: VesselVector, gravityMS2: VesselVector, ageSeconds: number) {
  vector(originM, "Origin"); vector(velocityMS, "Velocity"); vector(gravityMS2, "Gravity");
  inRange(ageSeconds, 0, 1e6, "Parcel age");
  const positionM = originM.map((x, c) => x + velocityMS[c]! * ageSeconds + .5 * gravityMS2[c]! * ageSeconds ** 2) as unknown as VesselVector;
  const instantaneousVelocity = velocityMS.map((v, c) => v + gravityMS2[c]! * ageSeconds) as unknown as VesselVector;
  return { positionM, velocityMS: instantaneousVelocity };
}

/** First intersection with a horizontal collector, no bounce or splash model. */
export function ballisticLandingTime(heightM: number, verticalVelocityMS: number, verticalGravityMS2: number): number {
  inRange(heightM, 0, 1e6, "Height above collector");
  inRange(verticalVelocityMS, -1e6, 1e6, "Vertical velocity");
  inRange(verticalGravityMS2, -1e4, 0, "Vertical gravity");
  if (heightM === 0 && verticalVelocityMS <= 0) return 0;
  if (verticalGravityMS2 === 0) return verticalVelocityMS < 0 ? heightM / -verticalVelocityMS : Infinity;
  const acceleration = -verticalGravityMS2;
  const root = Math.hypot(verticalVelocityMS, Math.sqrt(2 * acceleration * heightM));
  return verticalVelocityMS < 0 ? 2 * heightM / (root - verticalVelocityMS) : (verticalVelocityMS + root) / acceleration;
}

function validateConfig(c: VesselConfig): VesselConfig {
  if (c.kind !== "artery" && c.kind !== "vein") throw new RangeError("Unknown vessel preset");
  inRange(c.innerRadiusM, .0005, .02, "Vessel radius"); inRange(c.lengthM, .005, 1, "Vessel length");
  inRange(c.densityKgM3, 500, 2000, "Density"); inRange(c.viscosityPaS, 0, 1, "Viscosity");
  vesselSourcePressure(c, 0);
  if (c.sourcePressureMeanPa - c.sourcePulsePressurePa * PULSE_MEAN < 0) throw new RangeError("Source waveform cannot have negative gauge pressure");
  inRange(c.inletResistancePaSM3, 1e6, 1e14, "Inlet resistance");
  inRange(c.outletResistancePaSM3, 1e6, 1e14, "Outlet resistance");
  if (typeof c.inletOpen !== "boolean" || typeof c.outletOpen !== "boolean") throw new RangeError("Boundary switches must be boolean");
  inRange(c.distalPressurePa, 0, 1e5, "Distal pressure"); inRange(c.initialPressurePa, -1e4, 1e5, "Initial pressure");
  inRange(c.complianceM3Pa, 1e-14, 1e-6, "Compliance");
  inRange(c.initialVesselVolumeM3, 1e-9, .001, "Initial vessel volume");
  inRange(c.minimumVesselVolumeM3, 0, c.initialVesselVolumeM3, "Minimum vessel volume");
  inRange(c.initialSupplyVolumeM3, 0, .01, "Supply volume");
  vector(c.pressureReferencePositionM, "Pressure reference"); vector(c.gravityMS2, "Gravity");
  c.pressureReferencePositionM.forEach(v => inRange(v, -10, 10, "Reference position"));
  c.gravityMS2.forEach(v => inRange(v, -100, 100, "Gravity"));
  if (c.gravityMS2[1] > 0) throw new RangeError("Collector assumes nonpositive vertical gravity");
  inRange(c.collectionPlaneYM, -10, 10, "Collection height");
  inRange(c.fixedDtSeconds, 1e-4, .01, "Fixed timestep");
  inRange(c.maxTimeSeconds, c.fixedDtSeconds, 120, "Experiment duration");
  if (!Number.isInteger(c.maxParcels) || c.maxParcels < 8 || c.maxParcels > 50000) throw new RangeError("Parcel capacity must be 8–50000");
  return Object.freeze({ ...c, pressureReferencePositionM: Object.freeze(copyVector(c.pressureReferencePositionM)),
    gravityMS2: Object.freeze(copyVector(c.gravityMS2)) });
}

export function createVesselPreset(kind: "artery" | "vein", overrides: Partial<VesselConfig> = {}): VesselConfig {
  const artery = kind === "artery";
  const innerRadiusM = overrides.innerRadiusM ?? .003, lengthM = overrides.lengthM ?? .08;
  const initialVesselVolumeM3 = Math.PI * innerRadiusM ** 2 * lengthM;
  const sourcePressureMeanPa = overrides.sourcePressureMeanPa ?? (artery ? 13332 : 1066.56);
  const distalPressurePa = overrides.distalPressurePa ?? (artery ? 1333.2 : 533.28);
  const inletResistancePaSM3 = overrides.inletResistancePaSM3 ?? (artery ? 3e9 : 8e8);
  const outletResistancePaSM3 = overrides.outletResistancePaSM3 ?? (artery ? 2e10 : 2e9);
  const initialPressurePa = (sourcePressureMeanPa * outletResistancePaSM3 + distalPressurePa * inletResistancePaSM3)
    / (inletResistancePaSM3 + outletResistancePaSM3);
  return validateConfig({
    kind, innerRadiusM, lengthM, densityKgM3: 1060, viscosityPaS: .0035,
    sourcePressureMeanPa, sourcePulsePressurePa: artery ? 5332.8 : 0, heartRateBpm: 72,
    inletResistancePaSM3, outletResistancePaSM3, inletOpen: true, outletOpen: true, distalPressurePa,
    complianceM3Pa: artery ? 2e-11 : 2e-10, initialPressurePa, initialVesselVolumeM3,
    minimumVesselVolumeM3: initialVesselVolumeM3 * .5, initialSupplyVolumeM3: 20e-6,
    pressureReferencePositionM: [0, .03, 0], gravityMS2: [0, -9.81, 0], collectionPlaneYM: 0,
    fixedDtSeconds: .002, maxTimeSeconds: 30, maxParcels: 8192, ...overrides,
  });
}

export class VesselExperiment {
  readonly config: VesselConfig;
  readonly externalFlight: boolean;
  readonly externalPerfusion: boolean;
  private holes: readonly VesselHole[] = [];
  private state: State;
  private revision = 0;
  private readonly checkpoints = new WeakMap<VesselCheckpoint, { state: State; holes: readonly VesselHole[] }>();
  constructor(config: VesselConfig, options: { externalFlight?: boolean; externalPerfusion?: boolean } = {}) {
    this.config = validateConfig(config); this.externalFlight = options.externalFlight ?? false;
    this.externalPerfusion = options.externalPerfusion ?? false;
    this.state = this.initialState();
  }
  private initialState(): State {
    return { stepIndex: 0, volume: this.config.initialVesselVolumeM3, supply: this.externalPerfusion ? 0 : this.config.initialSupplyVolumeM3,
      distal: 0, landed: 0, expelled: 0, nextParcel: 0, parcels: [], byHole: new Map(),
      inletFlow: 0, distalFlow: 0, holeFlows: new Map(), limited: false,
      emissions: [], landingEvents: [], externalInFlight: 0, nextRun: 0, runs: new Map(), externalSupplied: 0,
      sourceBoundaryPa: this.externalPerfusion ? this.config.sourcePressureMeanPa : vesselSourcePressure(this.config, 0),
      distalBoundaryPa: this.config.distalPressurePa };
  }
  private cloneState(state: State): State {
    return { ...state, parcels: [...state.parcels], byHole: new Map(state.byHole),
      holeFlows: new Map(state.holeFlows), emissions: [...state.emissions], landingEvents: [...state.landingEvents],
      runs: new Map([...state.runs].map(([id, run]) => [id, { ...run }])) };
  }
  checkpoint(): VesselCheckpoint {
    const token = Object.freeze({}) as VesselCheckpoint;
    this.checkpoints.set(token, { state: this.cloneState(this.state), holes: this.holes });
    return token;
  }
  restore(token: VesselCheckpoint): void {
    const saved = this.checkpoints.get(token);
    if (!saved) throw new Error("Vessel checkpoint does not belong to this experiment");
    this.state = this.cloneState(saved.state); this.holes = saved.holes; ++this.revision;
  }
  /** Reconcile an authoritative external flight solver after all coupled
   * previews succeed. Pressure/supply are unaffected; no volume may be created.
   */
  reconcileExternalFlight(ledger: { inFlightVolumeM3: number; landedVolumeM3: number }): void {
    if (!this.externalFlight) throw new Error("External flight was not enabled");
    inRange(ledger.inFlightVolumeM3, 0, .02, "External in-flight volume");
    inRange(ledger.landedVolumeM3, 0, .02, "External landed volume");
    const tolerance = Math.max(1e-18, this.state.expelled * 1e-10);
    if (Math.abs(ledger.inFlightVolumeM3 + ledger.landedVolumeM3 - this.state.expelled) > tolerance
      || ledger.landedVolumeM3 < this.state.landed - tolerance)
      throw new Error("External flight volume ledger does not match emitted inventory");
    this.state = { ...this.state, externalInFlight: ledger.inFlightVolumeM3, landed: ledger.landedVolumeM3 };
    ++this.revision;
  }
  private pressure(volume: number) {
    return this.config.initialPressurePa + (volume - this.config.initialVesselVolumeM3) / this.config.complianceM3Pa;
  }
  /** Atomic edits preserve all previously emitted/collected volume. */
  setHoles(holes: readonly VesselHole[]): void {
    if (!Array.isArray(holes) || holes.length > 3) throw new RangeError("Use at most three punctures");
    const ids = new Set<string>();
    const accepted = holes.map((hole: VesselHole) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(hole.id) || ids.has(hole.id)) throw new RangeError("Hole ids must be unique simple names");
      ids.add(hole.id);
      vector(hole.positionM, "Hole position"); vector(hole.direction, "Hole direction");
      hole.positionM.forEach(v => inRange(v, -10, 10, "Hole position"));
      if (hole.positionM[1] <= this.config.collectionPlaneYM) throw new RangeError("Hole must be above the collector");
      const magnitude = Math.hypot(...hole.direction);
      if (!(magnitude > 0) || !Number.isFinite(magnitude)) throw new RangeError("Hole direction cannot be zero");
      inRange(hole.radiusM, .00005, Math.min(.0015, this.config.innerRadiusM * .5), "Hole radius");
      punctureCoefficients(hole.radiusM, hole.wallLengthM, this.config.viscosityPaS, this.config.densityKgM3, hole.dischargeCoefficient);
      return Object.freeze({ ...hole, positionM: Object.freeze(copyVector(hole.positionM)),
        direction: Object.freeze(hole.direction.map(v => v / magnitude) as unknown as VesselVector) });
    });
    this.holes = accepted;
    this.state.holeFlows = new Map(); // No stale discharge for edited apertures.
    // Closing and reopening without an intervening timestep is still a new run.
    for (const id of this.state.runs.keys()) if (!ids.has(id)) this.state.runs.delete(id);
    ++this.revision;
  }
  /** Resets the finite inventory and removes punctures and old parcels. */
  reset(): void { this.holes = []; this.state = this.initialState(); ++this.revision; }

  private holeFlow(hole: VesselHole, pressure: number) {
    const displacement: VesselVector = [hole.positionM[0] - this.config.pressureReferencePositionM[0],
      hole.positionM[1] - this.config.pressureReferencePositionM[1], hole.positionM[2] - this.config.pressureReferencePositionM[2]];
    const drivingPressurePa = pressure + this.config.densityKgM3 * dot(this.config.gravityMS2, displacement);
    const coefficients = punctureCoefficients(hole.radiusM, hole.wallLengthM, this.config.viscosityPaS,
      this.config.densityKgM3, hole.dischargeCoefficient);
    const flow = pressureDrivenDischarge(drivingPressurePa, coefficients.resistancePaSM3, coefficients.inertiaPaS2M6);
    return { flow, drivingPressurePa, area: coefficients.areaM2 };
  }

  /** A whole requested batch is committed or rolled back. Rendering cadence
   * changes only the number of fixed steps, never the integration timestep.
   */
  step(count = 1, boundary?: VesselPerfusionBoundary): VesselSnapshot {
    if (!Number.isInteger(count) || count < 0 || count > 10000) throw new RangeError("Step count must be an integer from 0 to 10000");
    if (this.externalPerfusion) {
      if (count > 1) throw new Error("External perfusion requires a fresh boundary for each fixed step");
      if (count > 0 && !boundary) throw new Error("External perfusion requires source and return pressures");
      if (boundary) {
        inRange(boundary.sourcePressurePa, -1e4, 1e5, "External source pressure");
        inRange(boundary.distalPressurePa, -1e4, 1e5, "External return pressure");
        inRange(boundary.inletVolumeLimitM3, 0, .02, "External source availability");
        inRange(boundary.distalVolumeLimitM3, 0, .02, "External return availability");
      }
    } else if (boundary) throw new Error("Boundary override requires external perfusion mode");
    const s = this.cloneState(this.state);
    s.emissions = []; s.landingEvents = [];
    const maxSteps = Math.floor(this.config.maxTimeSeconds / this.config.fixedDtSeconds + 1e-9);
    for (let step = 0; step < count && s.stepIndex < maxSteps; ++step) this.advance(s, boundary);
    s.landingEvents.sort((a, b) => a.timeSeconds - b.timeSeconds || a.id - b.id);
    this.state = s; ++this.revision;
    return this.snapshot();
  }

  prepareStep(count = 1, boundary?: VesselPerfusionBoundary): { snapshot: VesselSnapshot; commit(): void } {
    const revision = this.revision, before = this.state;
    let after: State, snapshot: VesselSnapshot;
    try { snapshot = this.step(count, boundary); after = this.state; }
    finally { this.state = before; this.revision = revision; }
    let consumed = false;
    return { snapshot, commit: () => {
      if (consumed || this.revision !== revision) throw new Error("Vessel preview is stale or already committed");
      consumed = true; this.state = after; ++this.revision;
    } };
  }

  private advance(s: State, boundary?: VesselPerfusionBoundary): void {
    const c = this.config, dt = c.fixedDtSeconds, nextTime = (s.stepIndex + 1) * dt;
    const source = this.externalPerfusion ? boundary!.sourcePressurePa : vesselSourcePressure(c, nextTime);
    const distalPressure = this.externalPerfusion ? boundary!.distalPressurePa : c.distalPressurePa;
    const sourceAvailability = this.externalPerfusion ? boundary!.inletVolumeLimitM3 : s.supply;
    const distalAvailability = this.externalPerfusion ? boundary!.distalVolumeLimitM3 : 0;
    s.sourceBoundaryPa = source; s.distalBoundaryPa = distalPressure;
    const flowsAt = (volume: number) => {
      const pressure = this.pressure(volume);
      const inletGradient = (source - pressure) / c.inletResistancePaSM3;
      const distalGradient = (pressure - distalPressure) / c.outletResistancePaSM3;
      const inlet = c.inletOpen ? Math.min(this.externalPerfusion ? inletGradient : Math.max(0, inletGradient), sourceAvailability / dt) : 0;
      const distal = c.outletOpen ? Math.max(this.externalPerfusion ? -distalAvailability / dt : 0, distalGradient) : 0;
      const holes = this.holes.map(hole => this.holeFlow(hole, pressure).flow);
      return { inlet, distal, holes, totalOut: distal + holes.reduce((sum, q) => sum + q, 0) };
    };
    const residual = (volume: number) => {
      const flow = flowsAt(volume);
      return volume - s.volume - dt * (flow.inlet - flow.totalOut);
    };
    let low = c.minimumVesselVolumeM3, high = s.volume + sourceAvailability + distalAvailability;
    const atMinimum = residual(low);
    s.limited = atMinimum > 0;
    if (!s.limited) {
      // Both possible external donor inflows are inventory-bounded, so this endpoint is mathematically
      // nonnegative. Subtracting almost equal binary64 volumes can leave a
      // few ulps below zero when the complete supply enters in one step.
      const endpointTolerance = 8 * Number.EPSILON * Math.max(high, c.initialVesselVolumeM3);
      if (residual(high) < -endpointTolerance) throw new Error("Vessel pressure root was not bracketed");
      for (let i = 0; i < 56; ++i) {
        const middle = low + (high - low) / 2;
        if (residual(middle) > 0) high = middle; else low = middle;
      }
    }
    const solvedVolume = s.limited ? c.minimumVesselVolumeM3 : low + (high - low) / 2;
    const flows = flowsAt(solvedVolume);
    const sourceInVolume = Math.min(sourceAvailability, Math.max(0, flows.inlet) * dt);
    const distalInVolume = Math.min(distalAvailability, Math.max(0, -flows.distal) * dt);
    const available = Math.max(0, s.volume - c.minimumVesselVolumeM3) + sourceInVolume + distalInVolume;
    const requestedOut = (Math.max(0, -flows.inlet) + Math.max(0, flows.distal)
      + flows.holes.reduce((sum, q) => sum + q, 0)) * dt;
    const scale = requestedOut > available ? available / requestedOut : 1;
    s.limited ||= scale < 1;
    // Debit a shared budget, bounding the final rounding of proportional
    // allocations instead of letting a near-empty vessel go negative.
    let remainingBudget = available;
    const sourceOutVolume = Math.min(remainingBudget, Math.max(0, -flows.inlet) * dt * scale);
    remainingBudget -= sourceOutVolume;
    const distalOutVolume = Math.min(remainingBudget, Math.max(0, flows.distal) * dt * scale);
    remainingBudget -= distalOutVolume;
    const holeVolumes = flows.holes.map(q => {
      const volume = Math.min(remainingBudget, q * dt * scale);
      remainingBudget -= volume;
      return volume;
    });
    const holeVolume = holeVolumes.reduce((sum, volume) => sum + volume, 0);
    const inletVolume = sourceInVolume - sourceOutVolume;
    const distalVolume = distalOutVolume - distalInVolume;
    s.volume = c.minimumVesselVolumeM3 + remainingBudget;
    if (this.externalPerfusion) s.externalSupplied += inletVolume; else s.supply -= inletVolume;
    s.distal += distalVolume; s.expelled += holeVolume;
    s.inletFlow = inletVolume / dt; s.distalFlow = distalVolume / dt;
    s.holeFlows = new Map();
    const remaining: StoredParcel[] = [];
    const land = (parcel: StoredParcel) => {
      const physical = ballisticState(parcel.originM, parcel.initialVelocityMS, c.gravityMS2,
        parcel.landingTimeSeconds - parcel.emissionTimeSeconds);
      s.landed += parcel.volumeM3;
      s.landingEvents.push({ id: parcel.id, holeId: parcel.holeId, timeSeconds: parcel.landingTimeSeconds,
        positionM: [physical.positionM[0], c.collectionPlaneYM, physical.positionM[2]],
        velocityMS: physical.velocityMS, volumeM3: parcel.volumeM3, supportRadiusM: 0 });
    };
    for (const parcel of s.parcels) {
      if (parcel.landingTimeSeconds <= nextTime) land(parcel);
      else remaining.push(parcel);
    }
    for (let i = 0; i < this.holes.length; ++i) {
      const hole = this.holes[i]!, volume = holeVolumes[i]!, flow = volume / dt;
      s.holeFlows.set(hole.id, flow);
      if (volume === 0) continue;
      const speed = flow / (Math.PI * hole.radiusM ** 2);
      const velocity = hole.direction.map(component => component * speed) as unknown as VesselVector;
      const emissionTimeSeconds = nextTime - dt / 2;
      const landingTimeSeconds = emissionTimeSeconds + ballisticLandingTime(hole.positionM[1] - c.collectionPlaneYM, velocity[1], c.gravityMS2[1]);
      const signature = [hole.radiusM, ...hole.positionM, ...hole.direction].join(",");
      let run = s.runs.get(hole.id);
      if (!run || run.lastStep !== s.stepIndex - 1 || run.signature !== signature)
        run = { id: s.nextRun++, lastStep: s.stepIndex, volume: 0, signature };
      const emission: VesselEmission = { id: s.nextParcel++, holeId: hole.id, runId: run.id,
        runVolumeStartM3: run.volume, originM: hole.positionM, initialVelocityMS: velocity,
        radiusM: hole.radiusM, volumeM3: volume, emissionTimeSeconds, durationSeconds: dt };
      s.emissions.push(emission);
      run.volume += volume; run.lastStep = s.stepIndex; s.runs.set(hole.id, run);
      const parcel: StoredParcel = { ...emission, landingTimeSeconds };
      if (this.externalFlight) s.externalInFlight += volume;
      else if (landingTimeSeconds <= nextTime) land(parcel); else remaining.push(parcel);
      s.byHole.set(hole.id, (s.byHole.get(hole.id) ?? 0) + volume);
    }
    if (remaining.length > c.maxParcels) throw new Error("Ballistic parcel capacity reached; batch rolled back without losing volume");
    s.parcels = remaining; ++s.stepIndex;
    const inFlight = s.externalInFlight + s.parcels.reduce((sum, parcel) => sum + parcel.volumeM3, 0);
    const initial = c.initialVesselVolumeM3 + (this.externalPerfusion ? s.externalSupplied : c.initialSupplyVolumeM3);
    const error = s.volume + s.supply + s.distal + s.landed + inFlight - initial;
    if (![s.volume, s.supply, s.distal, s.landed, s.expelled, s.externalSupplied, error].every(Number.isFinite)
      || s.volume < c.minimumVesselVolumeM3 - 1e-18 || s.supply < 0
      || Math.abs(error) > Math.max(1e-18, Math.abs(initial) * 1e-10))
      throw new Error("Vessel inventory invariant failed; batch rolled back");
  }

  snapshot(): VesselSnapshot {
    const s = this.state, c = this.config, timeSeconds = s.stepIndex * c.fixedDtSeconds, pressurePa = this.pressure(s.volume);
    const parcels: VesselParcel[] = s.parcels.map(parcel => {
      const ageSeconds = Math.max(0, timeSeconds - parcel.emissionTimeSeconds);
      return { id: parcel.id, holeId: parcel.holeId, volumeM3: parcel.volumeM3, emissionTimeSeconds: parcel.emissionTimeSeconds,
        ageSeconds, ...ballisticState(parcel.originM, parcel.initialVelocityMS, c.gravityMS2, ageSeconds) };
    });
    const inFlightVolumeM3 = s.externalInFlight + parcels.reduce((sum, parcel) => sum + parcel.volumeM3, 0);
    const jets = this.holes.map(hole => {
      const reference = this.holeFlow(hole, pressurePa), flowM3S = s.holeFlows.get(hole.id) ?? 0;
      const velocityMS = flowM3S / reference.area;
      return { holeId: hole.id, positionM: copyVector(hole.positionM), direction: copyVector(hole.direction),
        radiusM: hole.radiusM, flowM3S, velocityMS, expelledVolumeM3: s.byHole.get(hole.id) ?? 0,
        drivingPressurePa: reference.drivingPressurePa,
        reynoldsNumber: c.viscosityPaS > 0 ? c.densityKgM3 * velocityMS * 2 * hole.radiusM / c.viscosityPaS : null };
    });
    const complete = s.stepIndex >= Math.floor(c.maxTimeSeconds / c.fixedDtSeconds + 1e-9);
    return { timeSeconds, stepIndex: s.stepIndex, pressurePa, sourcePressurePa: s.sourceBoundaryPa,
      vesselVolumeM3: s.volume, supplyVolumeM3: s.supply, distalCollectedVolumeM3: s.distal, expelledVolumeM3: s.expelled,
      inFlightVolumeM3, landedVolumeM3: s.landed,
      volumeErrorM3: s.volume + s.supply + s.distal + s.landed + inFlightVolumeM3 - c.initialVesselVolumeM3
        - (this.externalPerfusion ? s.externalSupplied : c.initialSupplyVolumeM3),
      inletFlowM3S: s.inletFlow, distalFlowM3S: s.distalFlow, inventoryLimited: s.limited,
      status: complete ? "complete" : !this.externalPerfusion && s.supply === 0 && s.volume <= c.minimumVesselVolumeM3 + 1e-18 ? "drained"
        : !this.externalPerfusion && s.supply === 0 ? "source-empty" : s.stepIndex === 0 ? "ready" : "running",
      holeExpelledVolumeM3: Object.fromEntries(s.byHole), jets, parcels,
      emissions: s.emissions.map(e => ({ ...e, originM: copyVector(e.originM), initialVelocityMS: copyVector(e.initialVelocityMS) })),
      landingEvents: s.landingEvents.map(e => ({ ...e, positionM: copyVector(e.positionM), velocityMS: copyVector(e.velocityMS) })),
      flightModel: this.externalFlight ? "external-capillary" : "ballistic-parcels",
      perfusionModel: this.externalPerfusion ? "external-circulation" : "finite-reservoir",
      externalSuppliedVolumeM3: s.externalSupplied, distalBoundaryPressurePa: s.distalBoundaryPa };
  }
}
