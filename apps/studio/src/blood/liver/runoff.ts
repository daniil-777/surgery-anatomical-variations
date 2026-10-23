import { ballisticState, type VesselLandingEvent, type VesselVector } from "../experiments/vesselSolver";
import type { JetCollisionQuery } from "../experiments/jetCollision";
import type { LiverDrainageEvent } from "./types";
import { closestPointOnRunoffAttached, distanceToRunoffAttached, runoffGrowingAttachedContactTime, runoffSphereContactTime } from "./runoffContact";

export interface LiverRunoffConfig {
  fixedDtSeconds: number;
  densityKgM3: number;
  surfaceTensionNM: number;
  gravityMS2: VesselVector;
  /** Authored physical support; not a measured tissue contact radius. */
  contactRadiusM: number;
  /** Explicit finite support-shape closure, not a solved liquid neck. */
  neckLengthM: number;
  supportSpacingM: number;
  gridOriginM: VesselVector;
  collectionPlaneYM: number;
  maxReservoirs: number;
  maxDrops: number;
  /** Explicit wet-contact closure; aggregation is retained for isolated fixtures. */
  attachedContactModel: "capture-to-film" | "aggregate";
  /** Declared domain bound for an axial pendant shape; cosine to gravity. */
  minimumGravityAlignment: number;
}
export interface RunoffSupportAnchor { positionM: VesselVector; normal: VesselVector;
  /** Immutable identity from a precomputed physical support map, never arrival order. */
  supportId?: string;
  surface?: { triangle: number; barycentric: VesselVector }; }
export interface RunoffAttachedGeometry {
  anchorM: VesselVector; normal: VesselVector;
  contactRadiusM: number; neckLengthM: number; capHeightM: number;
  volumeM3: number; centreOfMassM: VesselVector;
  anchorSurface?: { triangle: number; barycentric: VesselVector };
}
export interface RunoffAttached extends RunoffAttachedGeometry { id: string; }
export interface RunoffDroplet {
  id: number; positionM: VesselVector; velocityMS: VesselVector;
  radiusM: number; volumeM3: number; birthTimeSeconds: number;
}
export interface RunoffContact extends VesselLandingEvent { phase: "runoff";
  wetCapture?: { model: "direct-contact" | "aggregate-relaxation"; supportId: string; contactPositionM: VesselVector; sourceCentreM: VesselVector;
    destinationM: VesselVector; relocationM: number };
}
/** Explicit physical-support coverage failure, distinct from invalid inputs or
 * programmer errors. A film boundary may retain this inventory instead. */
export class RunoffUnsupportedSupportError extends Error {
  constructor(message: string) { super(message); this.name = "RunoffUnsupportedSupportError"; }
}
export class RunoffEventBudgetError extends Error {
  constructor(readonly details: {
    intervalStartSeconds: number; intervalEndSeconds: number; lastTimeSeconds: number;
    recentEvents: readonly { timeSeconds: number; key: string }[];
  }) { super("Runoff continuous-contact event budget exceeded"); this.name = "RunoffEventBudgetError"; }
}
export interface LiverRunoffSnapshot {
  timeSeconds: number;
  inputVolumeM3: number;
  attachedVolumeM3: number;
  inFlightVolumeM3: number;
  organReturnedVolumeM3: number;
  collectorTransferredVolumeM3: number;
  volumeErrorM3: number;
  attached: RunoffAttached[];
  droplets: RunoffDroplet[];
  contacts: RunoffContact[];
  telemetry: {
    criticalVolumeM3: number; releasedDrops: number; collectorBridgeTransfers: number;
    /** Signed σ(A_sphere−A_neck_and_cap), excluding unresolved solid/wetting work. */
    pinchFreeSurfaceEnergyChangeJ: number;
    physicalSupportCount: number; mappedSourceCellCount: number;
    coalescenceEvents: number; coalescenceKineticEnergyRemovedJ: number;
    coalescenceFreeSurfaceEnergyChangeJ: number;
    wetCaptureCount: number; wetCaptureVolumeM3: number; aggregateRelaxationCaptureCount: number; aggregateRelaxationCaptureVolumeM3: number; wetCaptureKineticEnergyRemovedJ: number;
    wetCaptureMomentumRemovedKgMS: VesselVector; wetCapturePotentialEnergyChangeJ: number; maximumWetCaptureRelocationM: number;
    maximumRelocationM: number; minimumNormalAgreement: number;
    supportModel: string; momentumModel: string;
  };
}
type Reservoir = { id: string; anchor: RunoffSupportAnchor; volumeM3: number };
type Drop = { id: number; originM: VesselVector; initialVelocityMS: VesselVector;
  radiusM: number; volumeM3: number; birthTimeSeconds: number; birthSupportId?: string };
type State = { time: number; input: number; returned: number; collected: number;
  reservoirs: Map<string, Reservoir>; cellToSupport: Map<string, string>; drops: Map<number, Drop>; contacts: RunoffContact[];
  nextDrop: number; lastDrainageId: number; releases: number; bridges: number;
  relocation: number; agreement: number; pinchFreeSurfaceEnergyChangeJ: number;
  coalescences: number; coalescenceKineticEnergyRemovedJ: number; coalescenceFreeSurfaceEnergyChangeJ: number;
  captures: number; capturedVolume: number; relaxationCaptures: number; relaxationCapturedVolume: number; capturedKinetic: number; capturedMomentum: VesselVector;
  capturePotentialChange: number; captureRelocation: number };
declare const runoffCheckpoint: unique symbol;
export interface LiverRunoffCheckpoint { readonly [runoffCheckpoint]: true; }
const dot = (a: VesselVector, b: VesselVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: VesselVector, b: VesselVector): VesselVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: VesselVector, b: VesselVector): VesselVector =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const plus = (a: VesselVector, b: VesselVector, scale: number): VesselVector =>
  [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
const unit = (v: VesselVector): VesselVector => {
  const length = Math.hypot(...v);
  if (!v.every(Number.isFinite) || length < 1e-12) throw new RangeError("Runoff normal must be finite and nonzero");
  return [v[0] / length, v[1] / length, v[2] / length];
};
const contactCopy = (e: RunoffContact): RunoffContact => ({ ...e, positionM: [...e.positionM],
  velocityMS: [...e.velocityMS], ...(e.surface ? { surface: { triangle: e.surface.triangle,
    barycentric: [...e.surface.barycentric] } } : {}), ...(e.wetCapture ? { wetCapture: { ...e.wetCapture,
      contactPositionM: [...e.wetCapture.contactPositionM], sourceCentreM: [...e.wetCapture.sourceCentreM],
      destinationM: [...e.wetCapture.destinationM] } } : {}) });

/** Exact volume and first moment of a circular cylinder plus a spherical cap.
 * Small inventories fill the neck first. This is an authored support geometry,
 * not a solution of pendant-drop shape or capillary neck dynamics. */
export function runoffAttachedGeometry(anchorM: VesselVector, normal: VesselVector, volumeM3: number,
  contactRadiusM: number, maximumNeckLengthM: number): RunoffAttachedGeometry {
  if (![...anchorM, volumeM3, contactRadiusM, maximumNeckLengthM].every(Number.isFinite)
    || volumeM3 < 0 || contactRadiusM <= 0 || maximumNeckLengthM < 0)
    throw new RangeError("Invalid runoff attached geometry");
  const n = unit(normal), a = contactRadiusM, area = Math.PI * a * a;
  const neckVolume = Math.min(volumeM3, area * maximumNeckLengthM), neckLengthM = neckVolume / area;
  const capVolume = volumeM3 - neckVolume;
  // h³+3a²h=6V/π. Hyperbolic form avoids subtracting near-equal cube roots.
  const capHeightM = capVolume > 0 ? 2 * a * Math.sinh(Math.asinh(3 * capVolume / (Math.PI * a ** 3)) / 3) : 0;
  const h = capHeightM;
  const capCentroid = h > 0 ? h * (2 * a * a + h * h) / (2 * (3 * a * a + h * h)) : 0;
  const mean = volumeM3 > 0 ? (neckVolume * neckLengthM / 2 + capVolume * (neckLengthM + capCentroid)) / volumeM3 : 0;
  return { anchorM: [...anchorM], normal: n, contactRadiusM: a, neckLengthM, capHeightM,
    volumeM3, centreOfMassM: plus(anchorM, n, mean) };
}
/** Bounded surface quadrature for the explicit attached-contact closure.
 * Ring nodes are physical geometry, not arbitrary decorative perturbations. */
function attachedPoints(shape: RunoffAttachedGeometry): VesselVector[] {
  const { anchorM: a, normal: n, contactRadiusM: radius, neckLengthM: neck, capHeightM: h } = shape;
  const u = unit(cross(n, Math.abs(n[0]) < .8 ? [1, 0, 0] : [0, 1, 0])), v = cross(n, u);
  const points: VesselVector[] = [];
  const ring = (z: number, r: number) => {
    const centre = plus(a, n, z);
    if (r === 0) { points.push(centre); return; }
    for (let i = 0; i < 16; i++) {
      const angle = 2 * Math.PI * i / 16;
      points.push(plus(plus(centre, u, r * Math.cos(angle)), v, r * Math.sin(angle)));
    }
  };
  ring(0, radius); ring(neck, radius);
  const verticalSide = Math.sqrt(Math.max(0, 1 - n[1] ** 2));
  if (verticalSide > 1e-12) {
    const down: VesselVector = [n[0] * n[1] / verticalSide, (n[1] * n[1] - 1) / verticalSide,
      n[2] * n[1] / verticalSide];
    points.push(plus(plus(a, n, n[1] < 0 ? neck : 0), down, radius));
  }
  if (h > 0) {
    const c = (h * h - radius * radius) / (2 * h), R = h - c, lowestZ = c - R * n[1];
    if (lowestZ >= 0 && lowestZ <= h) points.push(plus(plus(a, n, neck + c), [0, -1, 0], R));
    for (let j = 1; j <= 8; j++) {
      const z = h * j / 8;
      ring(neck + z, j === 8 ? 0 : Math.sqrt(Math.max(0, radius * radius + 2 * c * z - z * z)));
    }
  }
  return points;
}
function minimumAttachedY(shape: RunoffAttachedGeometry) {
  const { anchorM: a, normal: n, contactRadiusM: radius, neckLengthM: neck, capHeightM: h } = shape;
  const side = Math.sqrt(Math.max(0, 1 - n[1] ** 2));
  let minimum = Math.min(a[1], a[1] + neck * n[1]) - radius * side;
  if (h > 0) {
    const R = (h * h + radius * radius) / (2 * h), c = h - R, z = c - R * n[1];
    minimum = Math.min(minimum, a[1] + (neck + h) * n[1]);
    if (z >= 0 && z <= h) minimum = Math.min(minimum, a[1] + (neck + c) * n[1] - R);
  }
  return minimum;
}
type FloorLimit = { volumeM3: number; positionM?: VesselVector };

/** Conservative experimental runoff boundary. The force scale ρgV=2πaσ
 * fixes release volume independently of timestep/mesh packets. It is not a
 * calibrated pendant-drop law. Reservoir support and zero-impulse instantaneous
 * pinch geometry are explicit assumptions; contact/surface work is unresolved. */
export class LiverRunoffExperiment {
  readonly config: Readonly<LiverRunoffConfig>;
  readonly criticalVolumeM3: number;
  private state: State = { time: 0, input: 0, returned: 0, collected: 0,
    reservoirs: new Map(), cellToSupport: new Map(), drops: new Map(), contacts: [], nextDrop: 1_000_000_000, lastDrainageId: -1,
    releases: 0, bridges: 0, relocation: 0, agreement: 1, pinchFreeSurfaceEnergyChangeJ: 0,
    coalescences: 0, coalescenceKineticEnergyRemovedJ: 0, coalescenceFreeSurfaceEnergyChangeJ: 0,
    captures: 0, capturedVolume: 0, relaxationCaptures: 0, relaxationCapturedVolume: 0, capturedKinetic: 0, capturedMomentum: [0, 0, 0], capturePotentialChange: 0, captureRelocation: 0 };
  private readonly checkpoints = new WeakMap<LiverRunoffCheckpoint, State>();

  constructor(config: Partial<LiverRunoffConfig>, private readonly resolveSupport: (cellCentreM: VesselVector) => RunoffSupportAnchor,
    private readonly nearestSurface: (pointM: VesselVector) => RunoffSupportAnchor = resolveSupport) {
    const a = config.contactRadiusM ?? .001;
    const c = { fixedDtSeconds: .002, densityKgM3: 1060, surfaceTensionNM: .055,
      gravityMS2: [0, -9.81, 0] as VesselVector, contactRadiusM: a, neckLengthM: .5 * a,
      supportSpacingM: 4 * a, gridOriginM: [0, 0, 0] as VesselVector, collectionPlaneYM: -.1,
      maxReservoirs: 1024, maxDrops: 8192, minimumGravityAlignment: 0, attachedContactModel: "capture-to-film" as const, ...config };
    if (![c.fixedDtSeconds, c.densityKgM3, c.surfaceTensionNM, ...c.gravityMS2, c.contactRadiusM,
      c.neckLengthM, c.supportSpacingM, ...c.gridOriginM, c.collectionPlaneYM, c.minimumGravityAlignment].every(Number.isFinite)
      || c.fixedDtSeconds < .0001 || c.fixedDtSeconds > .01 || c.densityKgM3 < 500 || c.densityKgM3 > 2000
      || c.surfaceTensionNM < 0 || c.surfaceTensionNM > .2 || c.contactRadiusM < .0001 || c.contactRadiusM > .003
      || c.neckLengthM < 0 || c.neckLengthM > 4 * c.contactRadiusM
      || c.supportSpacingM < 2 * c.contactRadiusM || c.supportSpacingM > .02
      || ![c.maxReservoirs, c.maxDrops].every(v => Number.isSafeInteger(v) && v > 0 && v <= 16384)
      || c.minimumGravityAlignment < 0 || c.minimumGravityAlignment > 1
      || !["capture-to-film", "aggregate"].includes(c.attachedContactModel)
      || Math.hypot(...c.gravityMS2) === 0 || c.gravityMS2[1] >= 0)
      throw new RangeError("Invalid runoff support/material parameters");
    this.config = Object.freeze({ ...c, gravityMS2: [...c.gravityMS2] as VesselVector, gridOriginM: [...c.gridOriginM] as VesselVector });
    this.criticalVolumeM3 = 2 * Math.PI * c.contactRadiusM * c.surfaceTensionNM / (c.densityKgM3 * Math.hypot(...c.gravityMS2));
    if (this.criticalVolumeM3 > 0) {
      const shape = runoffAttachedGeometry([0, 0, 0], [0, 1, 0], this.criticalVolumeM3, c.contactRadiusM, c.neckLengthM);
      const r = Math.cbrt(3 * this.criticalVolumeM3 / (4 * Math.PI));
      if (shape.centreOfMassM[1] < r + 1e-9)
        throw new RangeError("Runoff support cannot release an equivalent sphere at the same centre of mass without surface overlap");
    }
  }
  private clone(s: State): State {
    return { ...s, reservoirs: new Map([...s.reservoirs].map(([key, r]) => [key, { ...r,
      anchor: { positionM: [...r.anchor.positionM], normal: [...r.anchor.normal],
        ...(r.anchor.supportId !== undefined ? { supportId: r.anchor.supportId } : {}),
        ...(r.anchor.surface ? { surface: { triangle: r.anchor.surface.triangle, barycentric: [...r.anchor.surface.barycentric] } } : {}) } }])),
    cellToSupport: new Map(s.cellToSupport),
    drops: new Map([...s.drops].map(([key, d]) => [key, { ...d, originM: [...d.originM], initialVelocityMS: [...d.initialVelocityMS] }])),
    contacts: s.contacts.map(contactCopy), capturedMomentum: [...s.capturedMomentum] };
  }
  checkpoint(): LiverRunoffCheckpoint {
    const key = Object.freeze({}) as LiverRunoffCheckpoint; this.checkpoints.set(key, this.clone(this.state)); return key;
  }
  restore(key: LiverRunoffCheckpoint) {
    const state = this.checkpoints.get(key);
    if (!state) throw new Error("Runoff checkpoint belongs to another experiment");
    this.state = this.clone(state);
  }
  private key(position: VesselVector): { key: string; centre: VesselVector } {
    const { supportSpacingM: size, gridOriginM: origin } = this.config;
    const index: VesselVector = [Math.floor((position[0] - origin[0]) / size),
      Math.floor((position[1] - origin[1]) / size), Math.floor((position[2] - origin[2]) / size)];
    return { key: index.join(","), centre: [origin[0] + (index[0] + .5) * size,
      origin[1] + (index[1] + .5) * size, origin[2] + (index[2] + .5) * size] };
  }
  private reservoir(s: State, event: LiverDrainageEvent, options: {
    resolveSupport?: (cellCentreM: VesselVector) => RunoffSupportAnchor;
    nearestSurface?: (pointM: VesselVector) => RunoffSupportAnchor;
    ignoreActiveCapacity?: boolean;
  } = {}): Reservoir {
    const cell = this.key(event.positionM), c = this.config;
    const gravity = unit(c.gravityMS2);
    if (dot(unit(event.normal), gravity) < c.minimumGravityAlignment)
      throw new RunoffUnsupportedSupportError("Runoff source lies outside the axial pendant gravity-alignment domain");
    const knownId = s.cellToSupport.get(cell.key);
    let r = knownId === undefined ? undefined : s.reservoirs.get(knownId);
    if (knownId === undefined) {
      const resolved = (options.resolveSupport ?? this.resolveSupport)(cell.centre), anchor: RunoffSupportAnchor = {
        positionM: [...resolved.positionM], normal: unit(resolved.normal),
        ...(resolved.supportId !== undefined ? { supportId: resolved.supportId } : {}),
        ...(resolved.surface ? { surface: { triangle: resolved.surface.triangle, barycentric: [...resolved.surface.barycentric] } } : {}) };
      if (anchor.supportId !== undefined && (typeof anchor.supportId !== "string" || anchor.supportId.length === 0
        || anchor.supportId.length > 128)) throw new Error("Runoff physical support identity is invalid");
      if (!anchor.positionM.every(Number.isFinite) || dot(anchor.normal, c.gravityMS2) <= 0
        || Math.hypot(...minus(anchor.positionM, cell.centre)) > c.supportSpacingM)
        throw new RunoffUnsupportedSupportError("Runoff support projection is nonlocal or does not face outward gravity");
      if (dot(anchor.normal, gravity) < c.minimumGravityAlignment)
        throw new RunoffUnsupportedSupportError("Runoff support lies outside the axial pendant gravity-alignment domain");
      const id = anchor.supportId ?? cell.key;
      r = s.reservoirs.get(id);
      if (r) {
        if (Math.hypot(...minus(anchor.positionM, r.anchor.positionM)) > 1e-12
          || Math.hypot(...minus(anchor.normal, r.anchor.normal)) > 1e-12
          || anchor.surface?.triangle !== r.anchor.surface?.triangle
          || anchor.surface && r.anchor.surface
          && Math.hypot(...minus(anchor.surface.barycentric, r.anchor.surface.barycentric)) > 1e-12)
          throw new Error("Runoff physical support identity changed geometry");
      } else {
        if (!options.ignoreActiveCapacity && s.reservoirs.size >= c.maxReservoirs) throw new Error("Runoff support capacity exceeded");
        r = { id, anchor, volumeM3: 0 };
        this.validateSupport(r, options.nearestSurface);
        s.reservoirs.set(id, r);
      }
      s.cellToSupport.set(cell.key, id);
    }
    if (!r) throw new Error("Runoff support map is inconsistent");
    const distance = Math.hypot(...minus(event.positionM, r.anchor.positionM));
    const agreement = dot(unit(event.normal), r.anchor.normal);
    if (distance > Math.sqrt(3) * c.supportSpacingM || agreement < .8)
      throw new RunoffUnsupportedSupportError("Runoff support would merge nonlocal or oppositely oriented surface drainage");
    s.relocation = Math.max(s.relocation, distance); s.agreement = Math.min(s.agreement, agreement);
    return r;
  }
  /** Compile synchronously for one immutable accepted/proposed cut geometry.
   * Local caches avoid repeating whole-body clearance for every source vertex.
   * This never edits accepted inventory; use a new evaluator after a cut. */
  createDrainageEligibilityEvaluator(options: {
    resolveSupport?: (cellCentreM: VesselVector) => RunoffSupportAnchor;
    nearestSurface?: (pointM: VesselVector) => RunoffSupportAnchor;
  } = {}): (positionM: VesselVector, normal: VesselVector) => { eligible: boolean; reason?: string } {
    const scratch: State = { ...this.state, reservoirs: new Map(), cellToSupport: new Map(), drops: new Map(), contacts: [] };
    return (positionM, normal) => {
      if (positionM.length !== 3 || normal.length !== 3 || !positionM.every(Number.isFinite)
        || !normal.every(Number.isFinite) || Math.hypot(...normal) < 1e-12)
        throw new RangeError("Runoff eligibility requires a finite source position and nonzero normal");
      if (dot(normal, this.config.gravityMS2) <= 0) return { eligible: false, reason: "Source normal does not face outward gravity" };
      if (this.criticalVolumeM3 <= 0) return { eligible: false, reason: "Zero-surface-tension runoff requires a continuous-stream model" };
      try {
        this.reservoir(scratch, { id: 0, stepIndex: 0, sourceVertex: 0, startTimeSeconds: 0, endTimeSeconds: 0,
          volumeM3: 0, positionM: [...positionM], normal: [...normal] }, { ...options, ignoreActiveCapacity: true });
        return { eligible: true };
      } catch (error) {
        if (error instanceof RunoffUnsupportedSupportError) return { eligible: false, reason: error.message };
        throw error;
      }
    };
  }
  private validateSupport(r: Reservoir, nearestSurface = this.nearestSurface) {
    const c = this.config, shape = runoffAttachedGeometry(r.anchor.positionM, r.anchor.normal,
      this.criticalVolumeM3, c.contactRadiusM, c.neckLengthM);
    if (Math.hypot(...minus(nearestSurface(r.anchor.positionM).positionM, r.anchor.positionM)) > 1e-9)
      throw new RunoffUnsupportedSupportError("Runoff contact anchor is absent from the retained organ surface");
    // The complete critical cap's parent sphere contains every smaller cap.
    // Its exact nearest-triangle distance is a conservative clearance test.
    const h = shape.capHeightM, R = (h * h + c.contactRadiusM ** 2) / (2 * h);
    const capCentre = plus(r.anchor.positionM, r.anchor.normal, c.neckLengthM + h - R);
    for (const [centre, radius] of [[capCentre, R], [shape.centreOfMassM,
      Math.cbrt(3 * this.criticalVolumeM3 / (4 * Math.PI))]] as const) {
      const nearest = nearestSurface(centre), delta = minus(centre, nearest.positionM);
      if (dot(delta, nearest.normal) < -1e-9 || Math.hypot(...delta) < radius - 1e-9)
        throw new RunoffUnsupportedSupportError("Runoff attached body or released sphere intersects the organ; physical support is unresolved");
    }
    // The finite cylinder's base is an authored contact patch. Reject sampled
    // intrusion instead of moving its anchor off the source surface.
    const neckShape = runoffAttachedGeometry(r.anchor.positionM, r.anchor.normal,
      Math.PI * c.contactRadiusM ** 2 * c.neckLengthM, c.contactRadiusM, c.neckLengthM);
    for (const point of attachedPoints(neckShape)) {
      const nearest = nearestSurface(point);
      if (dot(minus(point, nearest.positionM), nearest.normal) < -1e-8)
        throw new RunoffUnsupportedSupportError("Runoff pinning patch penetrates the organ; contact geometry is unresolved");
    }
  }
  private floorLimit(r: Reservoir, time: number, collision: JetCollisionQuery, collectorMaximumYM: number): FloorLimit {
    const shape = (volume: number) => runoffAttachedGeometry(r.anchor.positionM, r.anchor.normal,
      volume, this.config.contactRadiusM, this.config.neckLengthM);
    if (minimumAttachedY(shape(this.criticalVolumeM3)) > collectorMaximumYM + 1e-10) return { volumeM3: Infinity };
    const contact = (volume: number) => {
      for (const point of attachedPoints(shape(volume))) {
        const hit = collision.contact(point, [0, 0, 0], [0, 0, 0], time, time, time, 0);
        if (hit && !hit.surface) return hit.positionM;
      }
      return undefined;
    };
    const atMaximum = contact(this.criticalVolumeM3);
    if (!atMaximum) return { volumeM3: Infinity };
    let lo = 0, hi = this.criticalVolumeM3, position = atMaximum;
    for (let i = 0; i < 48; i++) {
      const middle = (lo + hi) / 2, hit = contact(middle);
      if (hit) { hi = middle; position = hit; } else lo = middle;
    }
    return { volumeM3: hi, positionM: [...position] };
  }
  private bridge(s: State, r: Reservoir, volume: number, time: number, position: VesselVector) {
    if (s.nextDrop >= 2_000_000_000) throw new Error("Runoff contact namespace exhausted");
    s.contacts.push({ id: s.nextDrop++, holeId: "runoff", phase: "runoff", timeSeconds: time,
      positionM: [...position], velocityMS: [0, 0, 0], volumeM3: volume, supportRadiusM: 0 });
    s.collected += volume; s.bridges++; r.volumeM3 -= volume;
  }
  private release(s: State, r: Reservoir, time: number, collision: JetCollisionQuery) {
    if (s.drops.size >= this.config.maxDrops || s.nextDrop >= 2_000_000_000) throw new Error("Runoff drop capacity exceeded");
    const shape = runoffAttachedGeometry(r.anchor.positionM, r.anchor.normal, this.criticalVolumeM3,
      this.config.contactRadiusM, this.config.neckLengthM);
    const drop: Drop = { id: s.nextDrop++, originM: shape.centreOfMassM, initialVelocityMS: [0, 0, 0],
      radiusM: Math.cbrt(3 * this.criticalVolumeM3 / (4 * Math.PI)), volumeM3: this.criticalVolumeM3, birthTimeSeconds: time, birthSupportId: r.id };
    // Count only exposed liquid/air area. The contact disk's solid/liquid and
    // solid/air energies are unknown; this signed difference is not a complete
    // energy budget and is not forced negative by adding a fictitious impulse.
    const beforeArea = 2 * Math.PI * shape.contactRadiusM * shape.neckLengthM
      + Math.PI * (shape.contactRadiusM ** 2 + shape.capHeightM ** 2);
    s.pinchFreeSurfaceEnergyChangeJ += this.config.surfaceTensionNM
      * (4 * Math.PI * drop.radiusM ** 2 - beforeArea);
    const immediate = collision.contact(drop.originM, [0, 0, 0], this.config.gravityMS2, time, time, time, drop.radiusM);
    // An actual immediate contact is returned, never hidden by moving the centre.
    if (immediate) this.land(s, drop, immediate.timeSeconds, immediate.positionM, immediate.surface);
    else s.drops.set(drop.id, drop);
    r.volumeM3 = Math.max(0, r.volumeM3 - this.criticalVolumeM3); s.releases++;
  }
  private land(s: State, drop: Drop, time: number, positionM: VesselVector, surface?: VesselLandingEvent["surface"]) {
    if (!Number.isFinite(time) || time < drop.birthTimeSeconds - 1e-12 || !positionM.every(Number.isFinite)
      || surface && (!Number.isSafeInteger(surface.triangle) || surface.triangle < 0
      || !surface.barycentric.every(x => Number.isFinite(x) && x >= -1e-10 && x <= 1 + 1e-10)
      || Math.abs(surface.barycentric.reduce((a, b) => a + b, 0) - 1) > 1e-9))
      throw new Error("Invalid runoff contact response");
    const state = ballisticState(drop.originM, drop.initialVelocityMS, this.config.gravityMS2, time - drop.birthTimeSeconds);
    s.contacts.push({ id: drop.id, holeId: "runoff", phase: "runoff", timeSeconds: time,
      positionM: [...positionM], velocityMS: state.velocityMS, volumeM3: drop.volumeM3, supportRadiusM: drop.radiusM,
      ...(surface ? { surface: { triangle: surface.triangle, barycentric: [...surface.barycentric] } } : {}) });
    if (surface) s.returned += drop.volumeM3; else s.collected += drop.volumeM3;
    s.drops.delete(drop.id);
  }
  private fill(s: State, r: Reservoir, volume: number, start: number, end: number, collision: JetCollisionQuery, floor: FloorLimit) {
    const total = volume, duration = end - start; let used = 0;
    if (floor.volumeM3 <= this.criticalVolumeM3 * 1e-12) {
      r.volumeM3 += volume; this.bridge(s, r, r.volumeM3, (start + end) / 2, floor.positionM!); return;
    }
    const target = Math.min(this.criticalVolumeM3, floor.volumeM3);
    while (volume > 0) {
      const needed = target - r.volumeM3;
      const amount = Math.min(volume, needed);
      r.volumeM3 += amount; volume -= amount; used += amount;
      if (r.volumeM3 >= target * (1 - 8 * Number.EPSILON)) {
        const time = duration > 0 ? Math.min(end, start + duration * (used / total)) : start;
        if (floor.volumeM3 < this.criticalVolumeM3) this.bridge(s, r, r.volumeM3, time, floor.positionM!);
        else this.release(s, r, time, collision);
      }
      else break;
      if (amount <= 0) throw new Error("Runoff release integration lost progress");
    }
  }
  private attached(r: Reservoir) {
    return runoffAttachedGeometry(r.anchor.positionM, r.anchor.normal, r.volumeM3,
      this.config.contactRadiusM, this.config.neckLengthM);
  }
  /** Imposed perfectly absorbing wet-support boundary. Only incoming free
   * volume returns to the film; the stationary attached donor stays intact.
   * Film receives zero momentum so it cannot dissipate this same KE twice.
   * The spatial transfer/support work is recorded, not claimed conservative. */
  private captureToFilm(s: State, drop: Drop, r: Reservoir, time: number,
    model: "direct-contact" | "aggregate-relaxation" = "direct-contact") {
    if (drop.birthSupportId === r.id && Math.abs(time - drop.birthTimeSeconds) <= 1e-12)
      throw new Error("Runoff zero-time self-recapture is unresolved; release intersects its own residual support");
    const surface = r.anchor.surface;
    if (!surface || !Number.isSafeInteger(surface.triangle) || surface.triangle < 0
      || surface.barycentric.length !== 3
      || !surface.barycentric.every(x => Number.isFinite(x) && x >= -1e-10 && x <= 1 + 1e-10)
      || Math.abs(surface.barycentric.reduce((a, b) => a + b, 0) - 1) > 1e-9)
      throw new Error("Runoff wet-contact support has an invalid canonical film destination");
    const x = ballisticState(drop.originM, drop.initialVelocityMS, this.config.gravityMS2, time - drop.birthTimeSeconds);
    const contactPositionM = closestPointOnRunoffAttached(this.attached(r), x.positionM);
    const relocation = Math.hypot(...minus(r.anchor.positionM, x.positionM)), mass = this.config.densityKgM3 * drop.volumeM3;
    s.contacts.push({ id: drop.id, holeId: "runoff", phase: "runoff", timeSeconds: time,
      positionM: [...r.anchor.positionM], velocityMS: [0, 0, 0], volumeM3: drop.volumeM3,
      supportRadiusM: drop.radiusM, surface: { triangle: surface.triangle, barycentric: [...surface.barycentric] },
      wetCapture: { model, supportId: r.id, contactPositionM, sourceCentreM: x.positionM,
        destinationM: [...r.anchor.positionM], relocationM: relocation } });
    s.returned += drop.volumeM3; s.drops.delete(drop.id);
    s.captures++; s.capturedVolume += drop.volumeM3;
    if (model === "aggregate-relaxation") { s.relaxationCaptures++; s.relaxationCapturedVolume += drop.volumeM3; }
    s.capturedKinetic += .5 * mass * dot(x.velocityMS, x.velocityMS);
    s.capturedMomentum = plus(s.capturedMomentum, x.velocityMS, mass);
    s.capturePotentialChange -= mass * dot(this.config.gravityMS2, minus(r.anchor.positionM, x.positionM));
    s.captureRelocation = Math.max(s.captureRelocation, relocation);
  }
  /** Instantaneous inelastic aggregate closure. Linear momentum and first
   * moment are conserved; spin, wetting/support work and relaxation are not
   * resolved. A newly intersecting third body joins the same closure before
   * any external landing decision, avoiding arbitrary pair-order mass loss. */
  private coalesce(s: State, first: Drop, second: Drop | Reservoir, time: number, collision: JetCollisionQuery) {
    const drops = new Map<number, Drop>([[first.id, first]]), reservoirs = new Map<string, Reservoir>();
    if ("birthTimeSeconds" in second) drops.set(second.id, second); else reservoirs.set(second.id, second);
    let aggregate: Drop | undefined;
    let initialKinetic = 0, initialArea = 0;
    for (let iteration = 0; iteration <= this.config.maxDrops + this.config.maxReservoirs; iteration++) {
      let volume = 0; const moment = [0, 0, 0], momentum = [0, 0, 0];
      initialKinetic = 0; initialArea = 0;
      for (const d of [...drops.values()].sort((a, b) => a.id - b.id)) {
        const x = ballisticState(d.originM, d.initialVelocityMS, this.config.gravityMS2, time - d.birthTimeSeconds);
        volume += d.volumeM3;
        for (let k = 0; k < 3; k++) { moment[k]! += d.volumeM3 * x.positionM[k]!; momentum[k]! += d.volumeM3 * x.velocityMS[k]!; }
        initialKinetic += .5 * this.config.densityKgM3 * d.volumeM3 * dot(x.velocityMS, x.velocityMS);
        initialArea += 4 * Math.PI * d.radiusM ** 2;
      }
      for (const r of [...reservoirs.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const shape = this.attached(r); volume += r.volumeM3;
        for (let k = 0; k < 3; k++) moment[k]! += r.volumeM3 * shape.centreOfMassM[k]!;
        initialArea += 2 * Math.PI * shape.contactRadiusM * shape.neckLengthM
          + Math.PI * (shape.contactRadiusM ** 2 + shape.capHeightM ** 2);
      }
      if (!(volume > 0)) throw new Error("Runoff contact has no positive inventory");
      aggregate = { id: s.nextDrop, originM: moment.map(v => v / volume) as unknown as VesselVector,
        initialVelocityMS: momentum.map(v => v / volume) as unknown as VesselVector,
        radiusM: Math.cbrt(3 * volume / (4 * Math.PI)), volumeM3: volume, birthTimeSeconds: time };
      let grew = false;
      for (const d of s.drops.values()) if (!drops.has(d.id)) {
        const x = ballisticState(d.originM, d.initialVelocityMS, this.config.gravityMS2, time - d.birthTimeSeconds);
        if (Math.hypot(...minus(x.positionM, aggregate.originM)) <= d.radiusM + aggregate.radiusM + 1e-10) {
          drops.set(d.id, d); grew = true;
        }
      }
      for (const r of s.reservoirs.values()) if (r.volumeM3 > 0 && !reservoirs.has(r.id)
        && distanceToRunoffAttached(this.attached(r), aggregate.originM) <= aggregate.radiusM + 1e-10) {
        if (this.config.attachedContactModel === "aggregate") { reservoirs.set(r.id, r); grew = true; }
      }
      if (!grew) break;
      if (iteration === this.config.maxDrops + this.config.maxReservoirs)
        throw new Error("Runoff coalescence component budget exceeded");
    }
    if (!aggregate || s.nextDrop >= 2_000_000_000) throw new Error("Runoff coalescence capacity exceeded");
    if (this.config.attachedContactModel === "capture-to-film") {
      // The modeled relaxation sphere can meet a wet support before its
      // constituent spheres. Route ORIGINAL free donors to that boundary;
      // never create then hide an intersecting equivalent sphere.
      const contacted = [...s.reservoirs.values()].filter(r => r.volumeM3 > 0)
        .map(r => ({ r, distance: distanceToRunoffAttached(this.attached(r), aggregate!.originM) }))
        .filter(x => x.distance <= aggregate!.radiusM + 1e-10)
        .sort((a, b) => a.distance - b.distance || a.r.id.localeCompare(b.r.id))[0];
      if (contacted) {
        for (const d of [...drops.values()].sort((a, b) => a.id - b.id))
          this.captureToFilm(s, d, contacted.r, time, "aggregate-relaxation");
        return;
      }
    }
    // The flight query uses facet-normal radius support. Supplement it with
    // exact closest-triangle distance so a sphere cannot miss a source edge
    // merely because its centre projects outside that facet.
    const nearest = this.nearestSurface(aggregate.originM), separation = minus(aggregate.originM, nearest.positionM);
    if (dot(separation, nearest.normal) < -1e-9 || Math.hypot(...separation) < aggregate.radiusM - 1e-9)
      throw new Error("Runoff merged sphere intersects organ or collector; aggregate shape is unresolved");
    const hit = collision.contact(aggregate.originM, aggregate.initialVelocityMS, this.config.gravityMS2,
      time, time, time, aggregate.radiusM);
    if (hit) throw new Error("Runoff merged sphere intersects organ or collector; aggregate shape is unresolved");
    const finalKinetic = .5 * this.config.densityKgM3 * aggregate.volumeM3
      * dot(aggregate.initialVelocityMS, aggregate.initialVelocityMS);
    if (finalKinetic > initialKinetic + 1e-14)
      throw new Error("Runoff inelastic coalescence created kinetic energy");
    s.coalescenceKineticEnergyRemovedJ += Math.max(0, initialKinetic - finalKinetic);
    s.coalescenceFreeSurfaceEnergyChangeJ += this.config.surfaceTensionNM
      * (4 * Math.PI * aggregate.radiusM ** 2 - initialArea);
    for (const d of drops.values()) s.drops.delete(d.id);
    for (const r of reservoirs.values()) r.volumeM3 = 0;
    s.drops.set(s.nextDrop++, aggregate); s.coalescences++;
  }
  private advanceInterval(s: State, start: number, end: number, rates: ReadonlyMap<string, number>,
    limits: ReadonlyMap<string, FloorLimit>, collision: JetCollisionQuery) {
    type Event = { time: number; priority: number; key: string; apply(): void };
    let clock = start;
    const recentEvents: { timeSeconds: number; key: string }[] = [];
    for (let iteration = 0; iteration < 4096; iteration++) {
      let event: Event | undefined;
      const consider = (candidate: Event) => {
        if (candidate.time < clock - 1e-10 || candidate.time > end + 1e-10 || !Number.isFinite(candidate.time))
          throw new Error("Runoff contact event is outside its accepted interval");
        if (!event || candidate.time < event.time - 1e-12
          || Math.abs(candidate.time - event.time) <= 1e-12
          && (candidate.priority < event.priority || candidate.priority === event.priority && candidate.key < event.key))
          event = candidate;
      };
      for (const [id, rate] of rates) if (rate > 0) {
        const r = s.reservoirs.get(id)!, floor = limits.get(id)!;
        const threshold = Math.min(floor.volumeM3, this.criticalVolumeM3);
        if (threshold <= 0) throw new Error("Runoff submerged support requires direct source transfer");
        const delay = Math.max(0, (threshold - r.volumeM3) / rate);
        if (delay <= end - clock + 1e-12) {
          const time = Math.min(end, clock + delay);
          consider({ time, priority: 1, key: `support:${id}`, apply: () => {
            if (floor.volumeM3 < this.criticalVolumeM3) this.bridge(s, r, r.volumeM3, time, floor.positionM!);
            else this.release(s, r, time, collision);
          } });
        }
      }
      let horizon = event?.time ?? end;
      const drops = [...s.drops.values()].sort((a, b) => a.id - b.id);
      for (const d of drops) {
        const hit = collision.contact(d.originM, d.initialVelocityMS, this.config.gravityMS2,
          d.birthTimeSeconds, clock, horizon, d.radiusM);
        if (hit) consider({ time: hit.timeSeconds, priority: 2, key: `landing:${d.id}`, apply: () =>
          this.land(s, d, hit.timeSeconds, hit.positionM, hit.surface) });
        horizon = event?.time ?? end;
      }
      for (let i = 0; i < drops.length; i++) {
        const a = drops[i]!;
        for (let j = i + 1; j < drops.length; j++) {
          const b = drops[j]!, time = runoffSphereContactTime(a, b, this.config.gravityMS2, clock, horizon);
          if (time !== undefined) consider({ time, priority: 0, key: `drops:${a.id}:${b.id}`,
            apply: () => this.coalesce(s, a, b, time, collision) });
          horizon = event?.time ?? end;
        }
        for (const r of s.reservoirs.values()) {
          const rate = rates.get(r.id) ?? 0;
          if (r.volumeM3 <= 0 && rate <= 0) continue;
          if (a.birthSupportId === r.id && (clock > a.birthTimeSeconds + 1e-12 || r.volumeM3 <= 0)) continue;
          const time = runoffGrowingAttachedContactTime(a, r.anchor, r.volumeM3, rate, clock, horizon,
            this.config.contactRadiusM, this.config.neckLengthM, this.config.gravityMS2);
          if (time !== undefined) consider({ time, priority: 0, key: `attached:${a.id}:${r.id}`,
            apply: () => this.config.attachedContactModel === "capture-to-film"
              ? this.captureToFilm(s, a, r, time) : this.coalesce(s, a, r, time, collision) });
          horizon = event?.time ?? end;
        }
      }
      const target = event?.time ?? end, elapsed = Math.max(0, target - clock);
      for (const [id, rate] of rates) s.reservoirs.get(id)!.volumeM3 += rate * elapsed;
      clock = target;
      if (!event) return;
      recentEvents.push({ timeSeconds: clock, key: event.key });
      if (recentEvents.length > 8) recentEvents.shift();
      event.apply();
    }
    throw new RunoffEventBudgetError({ intervalStartSeconds: start, intervalEndSeconds: end,
      lastTimeSeconds: clock, recentEvents });
  }
  step(input: { timeSeconds: number; drainageEvents: readonly LiverDrainageEvent[]; collision: JetCollisionQuery;
    /** Actual previous accepted collector height bound; omit for conservative full queries. */
    collectorMaximumYM?: number }): LiverRunoffSnapshot {
    const before = this.state, next = input.timeSeconds;
    if (!Number.isFinite(next) || Math.abs(next - (before.time + this.config.fixedDtSeconds)) > 1e-10)
      throw new RangeError("Runoff requires the next fixed accepted time");
    if (input.drainageEvents.length && this.criticalVolumeM3 === 0)
      throw new RangeError("Zero-surface-tension runoff requires a continuous-stream model");
    const s = this.clone(before); s.contacts = [];
    if (input.collectorMaximumYM !== undefined && (!Number.isFinite(input.collectorMaximumYM)
      || input.collectorMaximumYM < this.config.collectionPlaneYM))
      throw new RangeError("Invalid accepted collector height bound");
    const limits = new Map<string, FloorLimit>();
    const groups = new Map<string, { r: Reservoir; events: LiverDrainageEvent[] }>(), ids = new Set<number>();
    for (const e of input.drainageEvents) {
      if (!Number.isSafeInteger(e.id) || e.id <= before.lastDrainageId || ids.has(e.id)
        || ![e.startTimeSeconds, e.endTimeSeconds, e.volumeM3, ...e.positionM, ...e.normal].every(Number.isFinite)
        || e.volumeM3 <= 0 || e.startTimeSeconds < before.time - 1e-11 || e.endTimeSeconds > next + 1e-11
        || e.endTimeSeconds < e.startTimeSeconds || dot(e.normal, this.config.gravityMS2) <= 0)
        throw new RangeError("Invalid, duplicate, stale or unsupported runoff drainage event");
      ids.add(e.id); s.lastDrainageId = Math.max(s.lastDrainageId, e.id); s.input += e.volumeM3;
      const r = this.reservoir(s, e), group = groups.get(r.id) ?? { r, events: [] };
      group.events.push({ ...e, startTimeSeconds: Math.max(before.time, Math.min(next, e.startTimeSeconds)),
        endTimeSeconds: Math.max(before.time, Math.min(next, e.endTimeSeconds)) }); groups.set(r.id, group);
    }
    for (const r of s.reservoirs.values()) {
      const floor = this.floorLimit(r, before.time, input.collision, input.collectorMaximumYM ?? Infinity);
      limits.set(r.id, floor);
      if (r.volumeM3 > 0 && r.volumeM3 >= floor.volumeM3)
        this.bridge(s, r, r.volumeM3, before.time, floor.positionM!);
    }
    const ordered = [...groups.values()].sort((a, b) => a.r.id.localeCompare(b.r.id));
    const times = [...new Set([before.time, next, ...ordered.flatMap(g =>
      g.events.flatMap(e => [e.startTimeSeconds, e.endTimeSeconds]))])].sort((a, b) => a - b);
    for (let k = 0; k < times.length; k++) {
      const start = times[k]!, end = times[k + 1] ?? start, rates = new Map<string, number>();
      for (const { r, events } of ordered) {
        const instant = events.filter(e => e.startTimeSeconds === start && e.endTimeSeconds === start)
          .reduce((sum, e) => sum + e.volumeM3, 0);
        if (instant > 0) this.fill(s, r, instant, start, start, input.collision, limits.get(r.id)!);
        const middle = (start + end) / 2;
        const rate = events.filter(e => e.startTimeSeconds < e.endTimeSeconds && e.startTimeSeconds <= middle && e.endTimeSeconds >= middle)
          .reduce((sum, e) => sum + e.volumeM3 / (e.endTimeSeconds - e.startTimeSeconds), 0);
        if (rate > 0 && end > start) {
          const floor = limits.get(r.id)!;
          if (floor.volumeM3 <= this.criticalVolumeM3 * 1e-12) {
            r.volumeM3 += rate * (end - start);
            this.bridge(s, r, r.volumeM3, middle, floor.positionM!);
          } else rates.set(r.id, rate);
        }
      }
      this.advanceInterval(s, start, end, rates, limits, input.collision);
    }
    s.time = input.timeSeconds;
    const snapshot = this.snapshotOf(s);
    if (Math.abs(snapshot.volumeErrorM3) > Math.max(1e-18, s.input * 1e-10))
      throw new Error("Runoff phase inventory invariant failed");
    this.state = s; return snapshot;
  }
  private snapshotOf(s: State): LiverRunoffSnapshot {
    const attached = [...s.reservoirs.values()].filter(r => r.volumeM3 > 0).map(r => ({ id: r.id,
      ...(r.anchor.surface ? { anchorSurface: { triangle: r.anchor.surface.triangle, barycentric: [...r.anchor.surface.barycentric] as VesselVector } } : {}),
      ...runoffAttachedGeometry(r.anchor.positionM, r.anchor.normal, r.volumeM3, this.config.contactRadiusM, this.config.neckLengthM) }));
    const droplets = [...s.drops.values()].map(d => ({ id: d.id, ...ballisticState(d.originM, d.initialVelocityMS,
      this.config.gravityMS2, s.time - d.birthTimeSeconds), radiusM: d.radiusM, volumeM3: d.volumeM3, birthTimeSeconds: d.birthTimeSeconds }));
    const attachedVolumeM3 = attached.reduce((sum, r) => sum + r.volumeM3, 0);
    const inFlightVolumeM3 = droplets.reduce((sum, d) => sum + d.volumeM3, 0);
    return { timeSeconds: s.time, inputVolumeM3: s.input, attachedVolumeM3, inFlightVolumeM3,
      organReturnedVolumeM3: s.returned, collectorTransferredVolumeM3: s.collected,
      volumeErrorM3: attachedVolumeM3 + inFlightVolumeM3 + s.returned + s.collected - s.input,
      attached, droplets, contacts: s.contacts.map(contactCopy), telemetry: {
        criticalVolumeM3: this.criticalVolumeM3, releasedDrops: s.releases, collectorBridgeTransfers: s.bridges,
        pinchFreeSurfaceEnergyChangeJ: s.pinchFreeSurfaceEnergyChangeJ,
        physicalSupportCount: s.reservoirs.size, mappedSourceCellCount: s.cellToSupport.size,
        coalescenceEvents: s.coalescences, coalescenceKineticEnergyRemovedJ: s.coalescenceKineticEnergyRemovedJ,
        coalescenceFreeSurfaceEnergyChangeJ: s.coalescenceFreeSurfaceEnergyChangeJ,
        wetCaptureCount: s.captures, wetCaptureVolumeM3: s.capturedVolume,
        aggregateRelaxationCaptureCount: s.relaxationCaptures, aggregateRelaxationCaptureVolumeM3: s.relaxationCapturedVolume, wetCaptureKineticEnergyRemovedJ: s.capturedKinetic,
        wetCaptureMomentumRemovedKgMS: [...s.capturedMomentum], wetCapturePotentialEnergyChangeJ: s.capturePotentialChange,
        maximumWetCaptureRelocationM: s.captureRelocation,
        maximumRelocationM: s.relocation, minimumNormalAgreement: s.agreement,
        supportModel: "Uncalibrated fixed physical pinning map; shared support identities aggregate source cells; rho*g*V=2*pi*a*sigma force-scale release; explicit neck-plus-cap geometry",
        momentumModel: this.config.attachedContactModel === "capture-to-film"
          ? "Absorbing wet-support capture returns incoming free volume to film with zero momentum and preserves attached donor; spatial/support work is unresolved. Free-drop aggregates conserve COM and linear momentum."
          : "Zero-impulse pinch; instantaneous inelastic contact aggregates conserve volume, centre of mass and linear momentum; substrate-supported donors rest; spin and wetting/support work are unresolved",
      } };
  }
  snapshot(): LiverRunoffSnapshot { return this.snapshotOf(this.state); }
}
