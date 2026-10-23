import { CardiovascularCircuit, CARDIOVASCULAR_PROVENANCE } from "../experiments/cardiovascular";
import { JetBreakupExperiment } from "../experiments/jetBreakup";
import { createCardiovascularVesselPreset } from "../experiments/vesselFlow";
import { VesselExperiment, type VesselCheckpoint, type VesselConfig, type VesselHole, type VesselVector,
  type VesselLandingEvent } from "../experiments/vesselSolver";
import type { JetCollisionQuery } from "../experiments/jetCollision";
import { LiverSurfaceFlow, intactLiverFilmGeometry } from "./surfaceFlow";
import { LiverSurfaceCollision } from "./surfaceCollision";
import { buildLiverAttachmentFootprint, type LiverAttachmentFootprint } from "./sourceFootprint";
import { createLiverFilmSlopeEvaluator } from "./filmDiagnostics";
import { liverCollectionPlaneYM } from "./collectionPlane";
import { buildLiverCutGeometry } from "./wounds";
import { LiverRunoffExperiment, RunoffUnsupportedSupportError, type RunoffSupportAnchor } from "./runoff";
import { createPackedRunoffSupportResolver, createRunoffSupportResolver } from "./runoffSupport";
import { DryCollectorFilm, liverDryCollectorConfig, type DryCollectorDeposit } from "./dryCollector";
import type { LiverAnatomy, LiverFlowSnapshot, LiverVec3, LiverWound } from "./types";

export interface LiverFlowOptions {
  kind?: "vein" | "artery";
  viscosityPaS?: number;
  fixedDtSeconds?: number;
  heartRateBpm?: number;
  systemicResistanceScale?: number;
  contractilityScale?: number;
  totalBloodVolumeM3?: number;
  surfaceTensionNM?: number;
  /** Provisional exposed vessel-wall/bore length, independent of tissue depth. */
  effectiveWallLengthM?: number;
  /** Authored pinning footprint; experimental, not measured liver wetting. */
  runoffContactRadiusM?: number;
  /** Domain restriction for the axial pendant closure; cosine to gravity. */
  runoffMinimumGravityAlignment?: number;
  /** Retained hanging-film candidate; does not resolve neck breakup. */
  undersideBoundary?: "drain" | "retain";
  /** Subgrid rivulet mobility factor (>= 0.1). Defaults to 1. */
  mobilityScale?: number;
  /** Maximum substeps per film step. Defaults to 128. */
  maxFilmSubsteps?: number;
}
const cloneWound = (w: LiverWound): LiverWound => ({ ...w, pick: { ...w.pick,
  positionM: [...w.pick.positionM], normal: [...w.pick.normal], barycentric: [...w.pick.barycentric] } });
const dot = (a: VesselVector, b: VesselVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const plus = (a: VesselVector, b: VesselVector, scale: number): LiverVec3 => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
/** Disjoint safe-integer namespaces at shared receivers. Internal owner IDs
 * remain unchanged; even IDs are wound flight, odd IDs are runoff. */
export function liverTransferId(id: number, owner: "wound" | "runoff"): number {
  if (!["wound", "runoff"].includes(owner) || !Number.isSafeInteger(id) || id < 0 ||
      id > Math.floor((Number.MAX_SAFE_INTEGER - 1) / 2))
    throw new RangeError("Blood transfer ID exceeds its safe owner namespace");
  return 2 * id + (owner === "runoff" ? 1 : 0);
}
/** Select a source inside the actual synthetic tube/punch intersection.
 * Projection onto a slightly inset cylinder avoids emitting from the retained
 * skin or the cavity floor; it is an aperture-origin approximation, not FSI. */
export function liverWoundSourcePosition(anatomy: LiverAnatomy, wound: LiverWound): LiverVec3 {
  const source = anatomy.vessels.find(v => v.id === wound.vesselId);
  if (!source) throw new Error("The wound references no synthetic surface vessel");
  const n = wound.pick.normal, centre = wound.pick.positionM;
  const direction = source.bM.map((x, k) => x - source.aM[k]!) as LiverVec3;
  const radius = wound.radiusM * Math.cos(Math.PI / 32) - 1e-9;
  const project = (p: VesselVector): LiverVec3 => {
    const d = p.map((x, k) => x - centre[k]!) as LiverVec3;
    const depth = Math.max(1e-9, Math.min(wound.depthM - 1e-9, -dot(d, n)));
    const radial = plus(d, n, -dot(d, n)), size = Math.hypot(...radial);
    return plus(plus(centre, n, -depth), radial, size > radius ? radius / size : 1);
  };
  const at = (t: number) => plus(source.aM, direction, t);
  const objective = (t: number) => {
    const p = at(t), q = project(p);
    return Math.hypot(...p.map((x, k) => x - q[k]!)) - (source.radiusAM * (1 - t) + source.radiusBM * t);
  };
  let lo = 0, hi = 1;
  for (let i = 0; i < 64; i++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (objective(a) < objective(b)) hi = b; else lo = a;
  }
  const t = [0, (lo + hi) / 2, 1].sort((a, b) => objective(a) - objective(b))[0]!;
  if (objective(t) > 1e-8) throw new Error("No resolved source point inside the exposed tube/cavity intersection");
  return project(at(t));
}

/** Synthetic exposed surface branch, not a complete hepatic circulation.
 * Both comparison modes connect systemic artery -> local segment -> systemic
 * vein. The venous mode includes a large upstream microvascular resistance.
 * There is no portal compartment and no patient-specific pressure calibration.
 */
export class LiverFlowExperiment {
  readonly vesselConfig: Readonly<VesselConfig>;
  readonly initialInventoryM3: number;
  readonly options: Readonly<Required<LiverFlowOptions>>;
  private readonly vessel: VesselExperiment;
  private readonly circulation: CardiovascularCircuit;
  private readonly breakup: JetBreakupExperiment;
  private readonly film: LiverSurfaceFlow;
  private readonly runoff: LiverRunoffExperiment;
  private readonly supportPacking: { candidateCells: number; supportedCells: number;
    unsupportedCells: number; physicalSupports: number } | null;
  private readonly pinningResolver: (positionM: VesselVector) => RunoffSupportAnchor;
  private readonly collector: DryCollectorFilm;
  private collision: LiverSurfaceCollision;
  private wounds: LiverWound[] = [];
  private holes: VesselHole[] = [];
  private lips = new Map<string, ReturnType<LiverSurfaceCollision["nearest"]>>();
  private footprints = new Map<string, LiverAttachmentFootprint>();
  private evaluateSlope: ReturnType<typeof createLiverFilmSlopeEvaluator>;
  private occluded = false;
  private clock = 0;
  private couplingIterations = 0;
  private couplingResidualPa = 0;
  private maxAcceptedFilmDepthM = 0;
  private pendingReturns: (VesselLandingEvent & { detectedTimeSeconds: number })[] = [];
  private woundOrganDeliveredM3 = 0;
  private woundCollectorDeliveredM3 = 0;
  private returnedToFilmM3 = 0;
  private terminalEscapeVolumeM3 = 0;

  constructor(private readonly anatomy: LiverAnatomy, options: LiverFlowOptions = {}) {
    this.options = Object.freeze({ kind: "vein", viscosityPaS: .00345, fixedDtSeconds: .002,
      heartRateBpm: 72, systemicResistanceScale: 1, contractilityScale: 1,
      totalBloodVolumeM3: .005, surfaceTensionNM: .055, effectiveWallLengthM: .0001,
      runoffContactRadiusM: .0005, runoffMinimumGravityAlignment: 0, undersideBoundary: "drain",
      mobilityScale: 1, maxFilmSubsteps: 128, ...options });
    const o = this.options, positions = anatomy.surface.positionsM;
    if (!Number.isFinite(o.effectiveWallLengthM) || o.effectiveWallLengthM < 0 || o.effectiveWallLengthM > .002)
      throw new RangeError("Effective vessel-wall length must be within 0–2 mm");
    let minY = Infinity, maxY = -Infinity;
    const mean: LiverVec3 = [0, 0, 0];
    for (let i = 0; i < positions.length; i += 3) {
      minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    }
    if (!Number.isFinite(minY) || maxY - minY > 2) throw new Error("Liver experiment requires finite metre-scale geometry");
    // A pressure-gauge reference, not an anatomical pressure measurement.
    // Integrate the canonical surface centroid so exact planar subdivision
    // cannot alter hydrostatic head merely by adding vertices.
    let areaSum = 0;
    const indices = anatomy.surface.indices;
    for (let k = 0; k < indices.length; k += 3) {
      const a = indices[k]! * 3, b = indices[k + 1]! * 3, c = indices[k + 2]! * 3;
      const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
      const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      if (!(area > 0) || !Number.isFinite(area)) throw new Error("Invalid pressure-reference surface triangle");
      areaSum += area;
      for (let j = 0; j < 3; j++) mean[j] = mean[j]! + area * (positions[a + j]! + positions[b + j]! + positions[c + j]!) / 3;
    }
    if (!(areaSum > 0)) throw new Error("Empty pressure-reference surface");
    for (let j = 0; j < 3; j++) mean[j] = mean[j]! / areaSum;
    const base = createCardiovascularVesselPreset(o.kind, { viscosityPaS: o.viscosityPaS,
      fixedDtSeconds: o.fixedDtSeconds, lengthM: .06, heartRateBpm: o.heartRateBpm,
      pressureReferencePositionM: mean, collectionPlaneYM: liverCollectionPlaneYM(anatomy.surface) });
    this.circulation = new CardiovascularCircuit({
      initialBloodVolumeM3: o.totalBloodVolumeM3 - base.initialVesselVolumeM3, fixedDtSeconds: o.fixedDtSeconds,
      heartRateBpm: o.heartRateBpm, systemicResistanceScale: o.systemicResistanceScale, contractilityScale: o.contractilityScale,
    });
    const pressure = this.circulation.snapshot().pressuresPa;
    const config = { ...base, sourcePressureMeanPa: pressure.systemicArtery, sourcePulsePressurePa: 0,
      distalPressurePa: pressure.systemicVein, initialSupplyVolumeM3: 0,
      initialPressurePa: (pressure.systemicArtery * base.outletResistancePaSM3 + pressure.systemicVein * base.inletResistancePaSM3)
        / (base.inletResistancePaSM3 + base.outletResistancePaSM3) };
    this.vessel = new VesselExperiment(config, { externalFlight: true, externalPerfusion: true });
    this.vesselConfig = this.vessel.config; this.initialInventoryM3 = o.totalBloodVolumeM3;
    this.breakup = new JetBreakupExperiment({ densityKgM3: base.densityKgM3, viscosityPaS: o.viscosityPaS,
      fixedDtSeconds: o.fixedDtSeconds, gravityMS2: base.gravityMS2, collectionPlaneYM: base.collectionPlaneYM,
      surfaceTensionNM: o.surfaceTensionNM, initialRelativeAmplitude: .01, minimumWeber: 4, maxElements: 8192 });
    this.film = new LiverSurfaceFlow(anatomy.surface, { fixedDtSeconds: o.fixedDtSeconds,
      viscosityPaS: o.viscosityPaS, densityKgM3: base.densityKgM3, gravityMS2: base.gravityMS2,
      surfaceTensionNM: o.surfaceTensionNM, rejectOpenBoundaryContact: true,
      undersideBoundary: o.undersideBoundary, mobilityScale: o.mobilityScale, maxSubsteps: o.maxFilmSubsteps });
    const intact = intactLiverFilmGeometry(anatomy.surface);
    this.collision = new LiverSurfaceCollision(anatomy.surface, intact, base.collectionPlaneYM);
    this.evaluateSlope = createLiverFilmSlopeEvaluator(anatomy.surface, intact);
    this.collector = new DryCollectorFilm(liverDryCollectorConfig(anatomy.surface, {
      densityKgM3: base.densityKgM3, viscosityPaS: o.viscosityPaS,
      surfaceTensionNm: o.surfaceTensionNM, dtSeconds: o.fixedDtSeconds,
    }));
    const contactRadiusM = o.runoffContactRadiusM, supportSpacingM = .004;
    const neckLengthM = .5 * contactRadiusM, gridOriginM: VesselVector = [0, 0, 0];
    const criticalVolumeM3 = 2 * Math.PI * contactRadiusM * o.surfaceTensionNM
      / (base.densityKgM3 * Math.hypot(...base.gravityMS2));
    const packed = criticalVolumeM3 > 0 ? createPackedRunoffSupportResolver(anatomy, {
      contactRadiusM, gravityMS2: base.gravityMS2, supportSpacingM, gridOriginM, criticalVolumeM3, neckLengthM,
    }) : null;
    // With zero surface tension the runoff owner rejects nonzero transfers:
    // a continuous-stream boundary is needed. Preserve dry-only operation.
    this.pinningResolver = packed ?? createRunoffSupportResolver(anatomy, contactRadiusM, base.gravityMS2);
    this.supportPacking = packed ? { candidateCells: packed.candidateCellCount,
      supportedCells: packed.supportedCellCount, unsupportedCells: packed.unsupportedCellCount,
      physicalSupports: packed.supports.length } : null;
    this.runoff = new LiverRunoffExperiment({
      densityKgM3: base.densityKgM3, surfaceTensionNM: o.surfaceTensionNM,
      gravityMS2: base.gravityMS2, fixedDtSeconds: o.fixedDtSeconds,
      collectionPlaneYM: base.collectionPlaneYM, contactRadiusM, supportSpacingM, neckLengthM, gridOriginM,
      minimumGravityAlignment: o.runoffMinimumGravityAlignment,
    }, position => this.pinningSupport(this.collision, this.wounds, position),
    position => this.surfaceSupport(this.collision, position));
    this.film.setDrainageEligibility(this.compileDrainageEligibility(this.collision, []));
  }

  private surfaceSupport(collision: LiverSurfaceCollision, position: VesselVector): RunoffSupportAnchor {
    const anchor = collision.nearest(position), p = this.anatomy.surface.positionsM;
    const ids = [0, 1, 2].map(j => 3 * this.anatomy.surface.indices[3 * anchor.surface!.triangle + j]!);
    const u = [0, 1, 2].map(k => p[ids[1]! + k]! - p[ids[0]! + k]!);
    const v = [0, 1, 2].map(k => p[ids[2]! + k]! - p[ids[0]! + k]!);
    // Physical clearance uses the facet normal, never the shading normal.
    const normal: LiverVec3 = [u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const size = Math.hypot(...normal);
    if (!(size > 0)) throw new Error("Runoff support has no finite surface normal");
    return { positionM: anchor.positionM, normal: normal.map(n => n / size) as LiverVec3, surface: anchor.surface! };
  }

  private pinningSupport(collision: LiverSurfaceCollision, wounds: readonly LiverWound[],
    position: VesselVector): RunoffSupportAnchor {
    const anchor = this.pinningResolver(position), retained = collision.nearest(anchor.positionM);
    if (Math.hypot(...retained.positionM.map((x, k) => x - anchor.positionM[k]!)) > 1e-9
      || wounds.some(wound => dot(anchor.normal, wound.pick.normal) > 0
        && Math.hypot(...anchor.positionM.map((x, k) => x - wound.pick.positionM[k]!))
          < this.options.runoffContactRadiusM + wound.radiusM))
      throw new RunoffUnsupportedSupportError("The runoff contact patch is removed by an incision.");
    return anchor;
  }

  private compileDrainageEligibility(collision: LiverSurfaceCollision, wounds: readonly LiverWound[]) {
    if (this.options.undersideBoundary === "retain") return undefined;
    const evaluate = this.runoff.createDrainageEligibilityEvaluator({
      resolveSupport: position => this.pinningSupport(collision, wounds, position),
      nearestSurface: position => this.surfaceSupport(collision, position),
    });
    const { positionsM, normals } = this.anatomy.surface, mask = new Uint8Array(positionsM.length / 3);
    for (let i = 0; i < mask.length; i++) {
      const position: VesselVector = [positionsM[i * 3]!, positionsM[i * 3 + 1]!, positionsM[i * 3 + 2]!];
      const normal: VesselVector = [normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!];
      mask[i] = evaluate(position, normal).eligible ? 1 : 0;
    }
    return mask;
  }

  setWounds(wounds: readonly LiverWound[]): void {
    if (wounds.length > 3 || new Set(wounds.map(w => w.id)).size !== wounds.length)
      throw new Error("Use at most three unique wounds");
    const proposed = wounds.map(cloneWound);
    const cut = buildLiverCutGeometry(this.anatomy, proposed);
    const collision = new LiverSurfaceCollision(this.anatomy.surface, cut, this.vesselConfig.collectionPlaneYM);
    // An incision may not silently remove the support of stored runoff or a
    // queued recontact. A future deformable attachment model may transfer
    // that blood; this model rejects the intervention before changing owners.
    for (const support of this.runoff.snapshot().attached) {
      if (support.volumeM3 <= 0) continue;
      const nearest = collision.nearest(support.anchorM);
      if (Math.hypot(...nearest.positionM.map((x, k) => x - support.anchorM[k]!)) > 1e-9
        || proposed.some(wound => dot(support.normal, wound.pick.normal) > 0
          && Math.hypot(...support.anchorM.map((x, k) => x - wound.pick.positionM[k]!))
            < support.contactRadiusM + wound.radiusM))
        throw new Error("This cut would remove an occupied runoff support. Clear the experiment before cutting this location.");
    }
    for (const event of this.pendingReturns) {
      // Return positions are on the displaced surface; use their canonical
      // capsule attachment when checking the proposed incision.
      const surface = event.surface!, point: LiverVec3 = [0, 0, 0];
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++)
        point[k] = point[k]! + surface.barycentric[j]!
          * this.anatomy.surface.positionsM[this.anatomy.surface.indices[surface.triangle * 3 + j]! * 3 + k]!;
      const nearest = collision.nearest(point);
      if (Math.hypot(...nearest.positionM.map((x, k) => x - point[k]!)) > 1e-9)
        throw new Error("This cut would remove a pending blood recontact. Advance the experiment before cutting this location.");
    }
    const holes: VesselHole[] = [], lips = new Map<string, ReturnType<LiverSurfaceCollision["nearest"]>>();
    const footprints = new Map<string, LiverAttachmentFootprint>();
    for (const wound of proposed) {
      if (!wound.vesselId || wound.apertureRadiusM === 0) continue;
      if (wound.apertureRadiusM < .00005 || wound.apertureRadiusM > .0015)
        throw new RangeError("The exposed aperture is outside the hydraulic model's 0.05–1.5 mm radius range");
      const source = this.anatomy.vessels.find(v => v.id === wound.vesselId);
      if (!source) throw new Error("The wound references no synthetic surface vessel");
      const normal = wound.pick.normal;
      // The source is inside the actual cleared footprint. Its speed remains
      // Q/(pi*r²), solved from local pressure and hydraulic losses.
      const positionM = liverWoundSourcePosition(this.anatomy, wound);
      holes.push({ id: wound.id, positionM, direction: normal, radiusM: wound.apertureRadiusM,
        wallLengthM: this.options.effectiveWallLengthM, dischargeCoefficient: .62 });
      const g = this.vesselConfig.gravityMS2, tangent = plus(g, normal, -dot(g, normal));
      let length = Math.hypot(...tangent);
      if (length < 1e-8) {
        const axis: LiverVec3 = Math.abs(normal[0]) < .8 ? [1, 0, 0] : [0, 0, 1];
        const projection = plus(axis, normal, -dot(axis, normal)); tangent.splice(0, 3, ...projection); length = Math.hypot(...tangent);
      }
      const target = plus(wound.pick.positionM, tangent, wound.radiusM * 1.03 / length);
      const lip = collision.nearest(target);
      lips.set(wound.id, lip);
      footprints.set(wound.id, buildLiverAttachmentFootprint(this.anatomy.surface, cut, [...lip.positionM],
        wound.pick.normal, wound.apertureRadiusM));
    }
    const evaluateSlope = createLiverFilmSlopeEvaluator(this.anatomy.surface, cut);
    const drainageEligibility = this.compileDrainageEligibility(collision, proposed);
    const checkpoint = this.vessel.checkpoint(), filmCheckpoint = this.film.checkpoint();
    try {
      this.vessel.setHoles(this.occluded ? [] : holes);
      this.film.setRetainedGeometry(cut);
      this.film.setDrainageEligibility(drainageEligibility);
    } catch (error) { this.vessel.restore(checkpoint); this.film.restore(filmCheckpoint); throw error; }
    this.wounds = proposed; this.holes = holes; this.lips = lips; this.collision = collision;
    this.footprints = footprints; this.evaluateSlope = evaluateSlope;
    this.maxAcceptedFilmDepthM = this.film.snapshot().maxDepthM;
  }

  /** Occlusion closes hydraulic apertures while preserving wounds and all
   * previously emitted blood. The remaining film and flight continue. */
  setOccluded(value: boolean): void {
    if (typeof value !== "boolean") throw new TypeError("Occlusion must be boolean");
    this.vessel.setHoles(value ? [] : this.holes); this.occluded = value;
  }

  private couple(checkpoint: VesselCheckpoint) {
    const before = this.circulation.snapshot(), local = this.vessel.snapshot();
    let p = before.pressuresPa;
    for (let iterations = 1; iterations <= 16; iterations++) {
      this.vessel.restore(checkpoint);
      const vessel = this.vessel.step(1, { sourcePressurePa: p.systemicArtery, distalPressurePa: p.systemicVein,
        inletVolumeLimitM3: before.availableSourceVolumeM3.systemicArtery, distalVolumeLimitM3: before.availableSourceVolumeM3.systemicVein });
      const preview = this.circulation.prepareStep({ source: "systemicArtery", returnTo: "systemicVein",
        toLocalM3: vessel.externalSuppliedVolumeM3 - local.externalSuppliedVolumeM3,
        fromLocalM3: vessel.distalCollectedVolumeM3 - local.distalCollectedVolumeM3 });
      const residualPa = Math.max(Math.abs(preview.snapshot.pressuresPa.systemicArtery - p.systemicArtery),
        Math.abs(preview.snapshot.pressuresPa.systemicVein - p.systemicVein));
      if (residualPa <= 1e-6) return { vessel, preview, iterations, residualPa };
      p = preview.snapshot.pressuresPa;
    }
    throw new Error("Liver branch/circulation coupling did not converge; step rolled back");
  }

  step(): { accepted: boolean; reason?: string } {
    const vesselBefore = this.vessel.checkpoint(), jetBefore = this.breakup.checkpoint();
    const filmBefore = this.film.checkpoint(), circuitBefore = this.circulation.checkpoint();
    const runoffBefore = this.runoff.checkpoint(), collectorBefore = this.collector.checkpoint();
    try {
      const coupled = this.couple(vesselBefore), vessel = coupled.vessel;
      if (vessel.timeSeconds <= this.clock) throw new Error("This finite trial is complete; reset for another trial");
      // Both flight owners query exactly the same previous accepted surfaces.
      // The sampler captures the immutable state, not a mutable class lookup:
      // the film may commit its candidate before runoff evaluates its flight.
      this.collision.setAcceptedFilm(this.film.acceptedDepthSampler(), this.maxAcceptedFilmDepthM);
      const collectorCollision = this.collector.collisionQuery();
      const collision: JetCollisionQuery = { contact: (...args) => {
        const organ = this.collision.contact(...args), tray = collectorCollision.contact(...args);
        // A true organ contact takes precedence at an equal time; the legacy
        // base plane must not hide the raised, accepted collector surface.
        return !organ ? tray : !tray ? organ
          : organ.timeSeconds < tray.timeSeconds || organ.surface && organ.timeSeconds === tray.timeSeconds
            ? organ : tray;
      } };
      const attached = vessel.jets.filter(j => this.options.surfaceTensionNM > 0
        && this.vesselConfig.densityKgM3 * j.velocityMS ** 2 * j.radiusM / this.options.surfaceTensionNM < 4)
        .map(j => ({ originM: j.positionM, anchor: this.lips.get(j.holeId)! }));
      this.collision.setAttachedSources(attached);
      const flight = this.breakup.step({ timeSeconds: vessel.timeSeconds, emissions: vessel.emissions, collision });
      const woundEvents = flight.landingEvents.map(event => ({ ...event, id: liverTransferId(event.id, "wound") }));
      const onOrgan = woundEvents.filter(event => event.surface);
      const offOrgan = woundEvents.filter(event => !event.surface);
      const sum = (events: readonly { volumeM3: number }[]) => events.reduce((total, event) => total + event.volumeM3, 0);
      const woundOrganDeliveredM3 = this.woundOrganDeliveredM3 + sum(onOrgan);
      const woundCollectorDeliveredM3 = this.woundCollectorDeliveredM3 + sum(offOrgan);
      const returnedToFilmM3 = this.returnedToFilmM3 + sum(this.pendingReturns);
      const film = this.film.step([...onOrgan, ...this.pendingReturns], this.footprints);
      const runoff = this.runoff.step({ timeSeconds: vessel.timeSeconds, drainageEvents: film.drainageEvents ?? [],
        collision, collectorMaximumYM: this.collector.maximumSurfaceYM });
      // Recontacts are held until the next film boundary. This explicit delay
      // is at most one fixed step and remains a distinct, conserved inventory.
      const pendingReturns = runoff.contacts.filter(event => event.surface).map(event => ({
        ...event, id: liverTransferId(event.id, "runoff"), detectedTimeSeconds: event.timeSeconds, timeSeconds: vessel.timeSeconds,
        positionM: [...event.positionM] as LiverVec3, velocityMS: [...event.velocityMS] as LiverVec3,
        surface: { triangle: event.surface!.triangle, barycentric: [...event.surface!.barycentric] as LiverVec3 },
      }));
      const deposits: DryCollectorDeposit[] = [];
      let terminalEscapeVolumeM3 = this.terminalEscapeVolumeM3;
      const c = this.collector.config;
      for (const event of [...offOrgan, ...runoff.contacts.filter(event => !event.surface)
        .map(event => ({ ...event, id: liverTransferId(event.id, "runoff") }))]) {
        const [x, , z] = event.positionM;
        if (x < c.originXM || x > c.originXM + c.widthM || z < c.originZM || z > c.originZM + c.depthM)
          terminalEscapeVolumeM3 += event.volumeM3;
        else deposits.push({ id: event.id, timeSeconds: event.timeSeconds, positionM: event.positionM,
          velocityMS: event.velocityMS, volumeM3: event.volumeM3 });
      }
      const collection = this.collector.prepareStep(deposits);
      if (!collection.accepted) throw new Error(collection.reason ?? "Collector step rejected");
      const collector = collection.snapshot;
      if (Math.abs(collector.timeSeconds - vessel.timeSeconds) > 1e-10)
        throw new Error("Collector physical clock differs from the accepted circulation step");
      const pendingReturnVolumeM3 = sum(pendingReturns);
      this.vessel.reconcileExternalFlight({ inFlightVolumeM3: flight.inFlightVolumeM3, landedVolumeM3: flight.landedVolumeM3 });
      const error = coupled.preview.snapshot.circulatingVolumeM3 + vessel.vesselVolumeM3
        + flight.inFlightVolumeM3 + film.filmVolumeM3 + runoff.attachedVolumeM3 + runoff.inFlightVolumeM3
        + pendingReturnVolumeM3 + collector.filmVolumeM3 + terminalEscapeVolumeM3 - this.initialInventoryM3;
      const tolerance = Math.max(1e-18, vessel.expelledVolumeM3 * 1e-10);
      if (!Number.isFinite(error) || Math.abs(error) > this.initialInventoryM3 * 1e-10
        || Math.abs(woundOrganDeliveredM3 + woundCollectorDeliveredM3 - flight.landedVolumeM3) > tolerance
        || Math.abs(film.inputVolumeM3 - woundOrganDeliveredM3 - returnedToFilmM3) > tolerance
        || Math.abs(film.escapedVolumeM3 - runoff.inputVolumeM3) > tolerance
        || Math.abs(runoff.organReturnedVolumeM3 - returnedToFilmM3 - pendingReturnVolumeM3) > tolerance
        || Math.abs(collector.filmVolumeM3 + terminalEscapeVolumeM3
          - woundCollectorDeliveredM3 - runoff.collectorTransferredVolumeM3) > tolerance
        || Math.abs(flight.emittedVolumeM3 - vessel.expelledVolumeM3) > tolerance
        || Math.abs(coupled.preview.snapshot.netTransferredToLocalM3
          - (vessel.externalSuppliedVolumeM3 - vessel.distalCollectedVolumeM3)) > tolerance)
        throw new Error("Coupled liver/circulation/flight/film volume ledger failed");
      collection.commit(); coupled.preview.commit();
      this.pendingReturns = pendingReturns; this.terminalEscapeVolumeM3 = terminalEscapeVolumeM3;
      this.woundOrganDeliveredM3 = woundOrganDeliveredM3; this.woundCollectorDeliveredM3 = woundCollectorDeliveredM3;
      this.returnedToFilmM3 = returnedToFilmM3; this.clock = vessel.timeSeconds;
      this.maxAcceptedFilmDepthM = film.maxDepthM;
      this.couplingIterations = coupled.iterations; this.couplingResidualPa = coupled.residualPa;
      return { accepted: true };
    } catch (error) {
      this.vessel.restore(vesselBefore); this.breakup.restore(jetBefore);
      this.film.restore(filmBefore); this.circulation.restore(circuitBefore);
      this.runoff.restore(runoffBefore); this.collector.restore(collectorBefore);
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  snapshot(): LiverFlowSnapshot {
    const vessel = this.vessel.snapshot(), cardiovascular = this.circulation.snapshot();
    const breakup = this.breakup.snapshot(), film = this.film.snapshot();
    const runoff = this.runoff.snapshot(), collector = this.collector.snapshot();
    const pendingReturnVolumeM3 = this.pendingReturns.reduce((sum, event) => sum + event.volumeM3, 0);
    return { timeSeconds: this.clock, stepIndex: vessel.stepIndex, wounds: this.wounds.map(cloneWound),
      vessel, cardiovascular, breakup, film, runoff, collector, pendingReturnVolumeM3,
      pendingReturnEvents: this.pendingReturns.map(event => ({ ...event, positionM: [...event.positionM],
        velocityMS: [...event.velocityMS], surface: { triangle: event.surface!.triangle,
          barycentric: [...event.surface!.barycentric] } })),
      terminalEscapeVolumeM3: this.terminalEscapeVolumeM3, initialInventoryM3: this.initialInventoryM3,
      coupledVolumeErrorM3: cardiovascular.circulatingVolumeM3 + vessel.vesselVolumeM3 + breakup.inFlightVolumeM3
        + film.filmVolumeM3 + runoff.attachedVolumeM3 + runoff.inFlightVolumeM3 + pendingReturnVolumeM3
        + collector.filmVolumeM3 + this.terminalEscapeVolumeM3 - this.initialInventoryM3 };
  }
  diagnostics() {
    const telemetry = this.film.diagnostics(), reasons: string[] = [];
    const slope = this.evaluateSlope(i => this.film.depthAtVertex(i), this.film.activeVertexIndices());
    if (telemetry.maximumFilmReynolds > 1) reasons.push("Film Reynolds exceeds 1; creeping-flow inertia omission is not established.");
    if (slope.maximumSurfaceSlope > .1) reasons.push("Surface-film thickness slope exceeds 0.1; the small-slope capillary approximation is questionable.");
    if (telemetry.impactKineticEnergyRemovedJ > 0) reasons.push("Impact kinetic energy is removed by the attachment/creeping-film closure; splash and momentum redistribution are unresolved.");
    return { model: "synthetic-liver-surface-branch-and-conservative-reduced-film",
      cardiovascular: { config: this.circulation.config, provenance: CARDIOVASCULAR_PROVENANCE,
        couplingIterations: this.couplingIterations, couplingResidualPa: this.couplingResidualPa },
      branch: this.options.kind === "artery" ? "systemic artery → local arterial segment → systemic vein"
        : "systemic artery → upstream microvascular resistance → local venous segment → systemic vein",
      occluded: this.occluded, initialInventoryM3: this.initialInventoryM3,
      effectiveWallLengthM: this.options.effectiveWallLengthM,
      apertureLengthProvenance: "Provisional exposed vessel-wall/bore length, not measured tissue. Punch depth only controls intersection geometry.",
      film: { config: this.film.config, telemetry, slope,
        validity: { status: telemetry.maximumFilmReynolds > 1 || slope.maximumSurfaceSlope > .1
          ? "outside-creeping-thin-film-indicators" : "uncalibrated-reduced-model",
          reasons, indicatorsAre: "Conservative engineering diagnostics, not clinical validity thresholds" },
        volumeConvention: "Integral of canonical P1 thickness over the retained cut surface, with exact dual-area inventory",
        lowWeAttachment: "Radius-based Weber <4 selects complete-dissipation attachment over the actual aperture-radius retained lip footprint and emission interval; an uncalibrated source/wetting closure",
        attachmentFootprints: [...this.footprints].map(([holeId, p]) => ({ holeId, radiusM: p.radiusM, areaM2: p.areaM2,
          sourceVertices: p.indices.length, quadrature: "64-sided inscribed tangent disk; canonical retained P1 integration" })),
        resolutionIndicator: "h/edge is grid-dependent resolution metadata, not a model-validity threshold",
        drainage: "A copied, cut-aware eligibility map transfers underside blood only into valid authored pinning outlets. Unsupported regions retain mass and signed-gravity film transport. The escaped counter is cumulative transfer, not another inventory. This is not a predicted wetting or detachment map.",
        impact: "All arriving kinetic energy is removed by the creeping-film closure; inertia and splash are unresolved" },
      runoff: { config: this.runoff.config, supportPacking: this.supportPacking,
        transfer: "Fixed physical support cells accumulate exact accepted drainage; an uncalibrated capillary-force scale sets release volume. No timestep-sized visual droplets.",
        return: "Organ recontact is held in a separately counted pending inventory and deposited at the next film boundary; delay is at most one fixed step.",
        supportGeometry: "Pinned neck and cap, then a volume-equivalent sphere at the same centre of mass with zero impulse. Surface/contact work is unresolved; this is not a solved liquid neck.",
        woundOrganDeliveredM3: this.woundOrganDeliveredM3, woundCollectorDeliveredM3: this.woundCollectorDeliveredM3,
        returnedToFilmM3: this.returnedToFilmM3, terminalEscapeVolumeM3: this.terminalEscapeVolumeM3 },
      collector: { config: this.collector.config,
        model: "Initially dry, conservative depth-averaged free-surface flow on the finite tray; no precursor blood or resolved impact splash." },
      limitations: "Synthetic surface vessels; no portal circulation, hepatic arterial buffer response, patient-specific calibration, clotting, tissue deformation, measured wetting, cavity blood, or clinical validation. Positive graph conductances clip negative cotangents; curvature and cut-edge fluxes are approximate. Film pressure does not feed back into wound hydraulics.",
    };
  }
}
