import { CollectorFilm, type CollectorConfig, type CollectorSnapshot, type CollectorTelemetry } from "./collector";
import { CardiovascularCircuit, CARDIOVASCULAR_PROVENANCE, type CardiovascularConfig, type CardiovascularSnapshot } from "./cardiovascular";
import { JetBreakupExperiment, type JetBreakupSnapshot } from "./jetBreakup";
import { VesselExperiment, createVesselPreset, type VesselCheckpoint, type VesselConfig, type VesselHole, type VesselSnapshot } from "./vesselSolver";

/** Both local segments sit between systemic arterial and venous compartments.
 * A venous segment follows a lumped upstream microvascular resistance; it must
 * not create an unvalved bypass from systemic veins to the right ventricle.
 * These branch resistances are explicit, uncalibrated experiment parameters. */
export function createCardiovascularVesselPreset(kind: "artery" | "vein", overrides: Partial<VesselConfig> = {}) {
  return createVesselPreset(kind, {
    ...(kind === "vein" ? { inletResistancePaSM3: 2e10, outletResistancePaSM3: 8e8 } : {}),
    ...overrides,
  });
}

export interface VesselFlowOptions {
  surfaceTensionNM?: number;
  initialRelativeAmplitude?: number;
  collector?: Partial<CollectorConfig>;
  /** Omit for the finite laboratory reservoir. Total inventory includes the
   * local vessel; the collector's explicitly prewetted film is separate. */
  cardiovascular?: Omit<Partial<CardiovascularConfig>, "initialBloodVolumeM3" | "fixedDtSeconds"> & { totalBloodVolumeM3?: number };
}
export interface VesselFlowSnapshot extends VesselSnapshot {
  breakup: JetBreakupSnapshot;
  collector: CollectorSnapshot;
  cardiovascular: CardiovascularSnapshot | null;
  /** Includes the collector's initial blood film and all escaped impacts. */
  coupledVolumeErrorM3: number;
}
export interface VesselFlowStep {
  accepted: boolean;
  reason?: string;
}

/** Three physical clocks, one accepted transaction. An impact is transferred
 * from the authoritative flight model into the spatial collector exactly once.
 * Rendering never calls any of these integrators.
 */
export class VesselFlowExperiment {
  readonly vesselConfig: Readonly<VesselConfig>;
  readonly collectorConfig: Readonly<CollectorConfig>;
  readonly surfaceTensionNM: number;
  readonly initialRelativeAmplitude: number;
  readonly cardiovascularConfig: Readonly<CardiovascularConfig> | null;
  readonly initialInventoryM3: number;
  private readonly vessel: VesselExperiment;
  private readonly breakup: JetBreakupExperiment;
  private readonly collector: CollectorFilm;
  private readonly circulation: CardiovascularCircuit | null;
  /** Detached accepted heights kept private for next-step collision queries.
   * Evidence snapshots never expose this buffer. */
  private acceptedFilmHeight: Float64Array;
  private filmTelemetry: CollectorTelemetry | null = null;
  private couplingIterations = 0;
  private couplingResidualPa = 0;
  private clock = 0;

  constructor(config: VesselConfig, options: VesselFlowOptions = {}) {
    this.surfaceTensionNM = options.surfaceTensionNM ?? .055;
    this.initialRelativeAmplitude = options.initialRelativeAmplitude ?? .01;
    const { totalBloodVolumeM3 = .005, ...circulationOptions } = options.cardiovascular ?? {};
    this.circulation = options.cardiovascular ? new CardiovascularCircuit({
      ...circulationOptions,
      initialBloodVolumeM3: totalBloodVolumeM3 - config.initialVesselVolumeM3,
      fixedDtSeconds: config.fixedDtSeconds,
    }) : null;
    this.cardiovascularConfig = this.circulation?.config ?? null;
    if (this.circulation) {
      const p = this.circulation.snapshot().pressuresPa;
      const source = p.systemicArtery, distal = p.systemicVein;
      // An intact local branch begins at its instantaneous resistive balance.
      // The circuit's warmup is disclosed; this is not a periodic coupled
      // equilibration and does not silently discard any escaped blood.
      config = { ...config, sourcePressureMeanPa: source, sourcePulsePressurePa: 0,
        distalPressurePa: distal, heartRateBpm: this.circulation.config.heartRateBpm,
        initialSupplyVolumeM3: 0,
        initialPressurePa: (source * config.outletResistancePaSM3 + distal * config.inletResistancePaSM3)
          / (config.inletResistancePaSM3 + config.outletResistancePaSM3) };
    }
    this.vessel = new VesselExperiment(config, { externalFlight: true, externalPerfusion: !!this.circulation });
    this.vesselConfig = this.vessel.config;
    this.initialInventoryM3 = config.initialVesselVolumeM3
      + (this.cardiovascularConfig?.initialBloodVolumeM3 ?? config.initialSupplyVolumeM3);
    this.breakup = new JetBreakupExperiment({
      densityKgM3: config.densityKgM3, viscosityPaS: config.viscosityPaS,
      surfaceTensionNM: this.surfaceTensionNM, initialRelativeAmplitude: this.initialRelativeAmplitude,
      minimumWeber: 4, fixedDtSeconds: config.fixedDtSeconds,
      gravityMS2: config.gravityMS2, collectionPlaneYM: config.collectionPlaneYM, maxElements: 8192,
    });
    this.collector = new CollectorFilm({
      ...options.collector, dtSeconds: config.fixedDtSeconds, densityKgM3: config.densityKgM3,
      viscosityPaS: config.viscosityPaS, surfaceTensionNm: this.surfaceTensionNM,
      gravityMS2: -config.gravityMS2[1],
    });
    this.collectorConfig = this.collector.config;
    this.acceptedFilmHeight = this.collector.snapshot().heightM;
  }

  setHoles(holes: readonly VesselHole[]): void { this.vessel.setHoles([...holes]); }

  step(): VesselFlowStep {
    const vesselBefore = this.vessel.checkpoint(), breakupBefore = this.breakup.checkpoint();
    const circulationBefore = this.circulation?.checkpoint();
    try {
      const coupled = this.circulation ? this.coupleCirculation(vesselBefore) : null;
      const candidate = coupled?.vessel ?? this.vessel.step();
      if (candidate.timeSeconds <= this.clock)
        throw new Error("The finite experiment duration is complete. Reset to start another trial.");
      const flight = this.breakup.step({ timeSeconds: candidate.timeSeconds, emissions: candidate.emissions,
        collectorSurface: { ...this.collectorConfig, timeSeconds: this.clock, heightM: this.acceptedFilmHeight } });
      const film = this.collector.prepareStep(flight.landingEvents);
      if (!film.accepted) throw new Error(film.reason ?? "Collector step rejected");
      this.vessel.reconcileExternalFlight({
        inFlightVolumeM3: flight.inFlightVolumeM3, landedVolumeM3: flight.landedVolumeM3,
      });
      this.validate(this.vessel.snapshot(), flight, film.snapshot, coupled?.preview.snapshot ?? null);
      // No asynchronous work or observer callbacks between prepare and commit.
      // All upstream solvers can still be restored until this final operation.
      coupled?.preview.commit();
      film.commit();
      this.acceptedFilmHeight = film.snapshot.heightM;
      this.filmTelemetry = film.telemetry; this.clock = candidate.timeSeconds;
      this.couplingIterations = coupled?.iterations ?? 0; this.couplingResidualPa = coupled?.residualPa ?? 0;
      return { accepted: true };
    } catch (cause) {
      this.vessel.restore(vesselBefore); this.breakup.restore(breakupBefore);
      if (circulationBefore) this.circulation!.restore(circulationBefore);
      return { accepted: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  private coupleCirculation(checkpoint: VesselCheckpoint) {
    const circuit = this.circulation!, before = circuit.snapshot(), localBefore = this.vessel.snapshot();
    const source = "systemicArtery", returnTo = "systemicVein";
    let pressures = before.pressuresPa;
    // Implicit terminal-pressure fixed point. Every preview starts from the
    // SAME accepted state; intermediate exchanges cannot debit blood twice.
    for (let iterations = 1; iterations <= 16; iterations++) {
      this.vessel.restore(checkpoint);
      const vessel = this.vessel.step(1, {
        sourcePressurePa: pressures[source], distalPressurePa: pressures[returnTo],
        inletVolumeLimitM3: before.availableSourceVolumeM3[source],
        distalVolumeLimitM3: before.availableSourceVolumeM3[returnTo],
      });
      const preview = circuit.prepareStep({
        source, returnTo,
        toLocalM3: vessel.externalSuppliedVolumeM3 - localBefore.externalSuppliedVolumeM3,
        fromLocalM3: vessel.distalCollectedVolumeM3 - localBefore.distalCollectedVolumeM3,
      });
      const residualPa = Math.max(Math.abs(preview.snapshot.pressuresPa[source] - pressures[source]),
        Math.abs(preview.snapshot.pressuresPa[returnTo] - pressures[returnTo]));
      if (residualPa <= 1e-6) return { vessel, preview, iterations, residualPa };
      pressures = preview.snapshot.pressuresPa;
    }
    throw new Error("Cardiovascular/local-vessel pressure coupling did not converge; transaction rolled back");
  }

  private validate(vessel: VesselSnapshot, flight: JetBreakupSnapshot, film: CollectorSnapshot,
    cardiovascular: CardiovascularSnapshot | null) {
    const tolerance = Math.max(1e-18,
      (this.vesselConfig.initialVesselVolumeM3 + vessel.expelledVolumeM3 + film.initialFilmVolumeM3) * 1e-10);
    const clockTolerance = Math.max(1e-12, vessel.timeSeconds * 1e-12);
    if (Math.abs(vessel.timeSeconds - flight.timeSeconds) > clockTolerance
      || Math.abs(vessel.timeSeconds - film.timeSeconds) > clockTolerance
      || cardiovascular && Math.abs(vessel.timeSeconds - cardiovascular.timeSeconds) > clockTolerance)
      throw new Error("Coupled flow clocks disagree; transaction rolled back");
    if (Math.abs(film.inputVolumeM3 - flight.landedVolumeM3) > tolerance
      || Math.abs(flight.emittedVolumeM3 - vessel.expelledVolumeM3) > tolerance
      || Math.abs(flight.volumeErrorM3) > tolerance || Math.abs(film.volumeErrorM3) > tolerance)
      throw new Error("Coupled flight/impact inventory disagrees; transaction rolled back");
    if (Math.abs(vessel.volumeErrorM3) > tolerance)
      throw new Error("Local vessel volume ledger failed; transaction rolled back");
    const external = flight.inFlightVolumeM3 + film.filmVolumeM3 - film.initialFilmVolumeM3 + film.escapedVolumeM3;
    const error = cardiovascular
      ? cardiovascular.circulatingVolumeM3 + vessel.vesselVolumeM3 + external - this.initialInventoryM3
      : vessel.supplyVolumeM3 + vessel.vesselVolumeM3 + vessel.distalCollectedVolumeM3 + external - this.initialInventoryM3;
    if (cardiovascular && (Math.abs(cardiovascular.volumeErrorM3) > this.initialInventoryM3 * 1e-10
      || Math.abs(cardiovascular.netTransferredToLocalM3
        - (vessel.externalSuppliedVolumeM3 - vessel.distalCollectedVolumeM3)) > tolerance))
      throw new Error("Cardiovascular exchange ledger failed; transaction rolled back");
    if (!Number.isFinite(error) || Math.abs(error) > this.initialInventoryM3 * 1e-10)
      throw new Error("Coupled global volume ledger failed; transaction rolled back");
    return error;
  }

  snapshot(): VesselFlowSnapshot {
    const vessel = this.vessel.snapshot(), flight = this.breakup.snapshot(), film = this.collector.snapshot();
    const cardiovascular = this.circulation?.snapshot() ?? null;
    return { ...vessel, breakup: flight, collector: film, cardiovascular,
      coupledVolumeErrorM3: this.validate(vessel, flight, film, cardiovascular) };
  }

  diagnostics() {
    return {
      flightModel: "Convected viscous capillary breakup closure with conservative cohort pinch events",
      collectorModel: "Spatial prewetted depth-averaged flow with local impact mass and horizontal momentum",
      surfaceTensionNM: this.surfaceTensionNM, initialRelativeAmplitude: this.initialRelativeAmplitude,
      minimumBreakupWeber: 4, collector: this.collectorConfig, collectorTelemetry: this.filmTelemetry,
      flightContact: "Continuous contact with the rendered height reconstruction at the previous accepted time; base plane outside the tray. Surface motion within a fixed step is unresolved.",
      cardiovascular: this.cardiovascularConfig ? { config: this.cardiovascularConfig, provenance: CARDIOVASCULAR_PROVENANCE,
        connection: this.vesselConfig.kind === "artery"
          ? "systemic artery → local arterial segment → downstream resistance → systemic vein"
          : "systemic artery → upstream microvascular resistance → local venous segment → systemic vein",
        initialization: "Isolated circuit equilibrated for the configured warmup cycles; intact local pressure initialized at instantaneous resistance balance.",
        initialCombinedInventoryM3: this.initialInventoryM3,
        couplingIterations: this.couplingIterations, couplingResidualPa: this.couplingResidualPa } : null,
      limitations: "Reduced breakup topology and depth-averaged post-impact flow; no resolved impact splash, satellite drops, air drag or tissue wetting.",
    };
  }
}
