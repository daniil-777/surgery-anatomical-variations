import {
  advanceFatPronyStress, createFatPronyState, DEFAULT_FAT_MATERIAL, DEFAULT_FAT_PROTOCOL, DEFAULT_FAT_SPECIMEN,
  FAT_PHYSICS_ASSUMPTIONS, fatElasticResponse, runFatCompression, validateFatMaterial,
  type FatCompressionDiagnostics, type FatCompressionFrame, type FatCompressionPhase, type FatCompressionResult,
  type FatMaterialParameters, type FatPronyState, type FatRampHoldReleaseProtocol, type FatSpecimenDimensions,
} from "./physics";

/** Load control for the same reduced QLV material used by the compression bench.
 * Stress is compression-positive nominal traction (force/reference area), Pa.
 * This is a homogeneous, quasistatic material coupon, not a contact/FEM solve.
 *
 * For a step dt, the existing exact linear-elastic-stress Prony recurrence gives
 * P_new = A * P_elastic(strain_new) + H, with A > 0. A bracketed monotone solve
 * inverts the existing traction-free neo-Hookean law. The constitutive history
 * determines creep/recovery; no visual easing or prescribed shape is inserted.
 *
 * Exact branch integration does not make an arbitrary load history exact:
 * P_elastic is piecewise linear in time, so loading histories still require a
 * timestep convergence check. All returned dimensions are mm; mechanics use SI.
 */

export interface FatCreepProtocol {
  readonly kind: "creep-recovery";
  readonly targetStressPa: number;
  readonly rampSec: number;
  readonly holdSec: number;
  readonly releaseSec: number;
  readonly recoverySec: number;
  readonly stepSec: number;
}

export interface FatStressCyclicProtocol {
  readonly kind: "stress-cyclic";
  /** Peak of a nonnegative raised-cosine nominal-stress cycle. */
  readonly targetStressPa: number;
  readonly periodSec: number;
  readonly cycles: number;
  readonly stepSec: number;
}

export type FatStressProtocol = FatCreepProtocol | FatStressCyclicProtocol;

export interface FatCreepFrame extends FatCompressionFrame {
  readonly targetStressPa: number;
  readonly stressResidualPa: number;
  readonly solverIterations: number;
}

export interface FatCreepDiagnostics extends FatCompressionDiagnostics {
  readonly controlMode: "nominal-stress";
  readonly peakStrain: number;
  readonly residualStrain: number;
  /** End-hold/start-hold compression. Null for cyclic or zero loading/hold. */
  readonly holdCreepRatio: number | null;
  /** Fraction of peak compression recovered by the final frame. */
  readonly recoveryFraction: number | null;
  readonly maximumStressResidualPa: number;
  readonly maximumSolverIterations: number;
  readonly totalSolverIterations: number;
  readonly maximumSupportedStrain: number;
}

/** Frames and base diagnostics are compatible with the existing compression
 * charts. The protocol is intentionally distinct: load is controlled, not strain. */
export interface FatCreepResult {
  readonly frames: readonly FatCreepFrame[];
  readonly diagnostics: FatCreepDiagnostics;
  readonly material: FatMaterialParameters;
  readonly protocol: FatStressProtocol;
  readonly specimen: FatSpecimenDimensions;
  readonly assumptions: readonly string[];
}

export const FAT_CREEP_MAX_STRAIN = 0.35;
export const DEFAULT_FAT_CREEP_PROTOCOL: FatCreepProtocol = Object.freeze({
  kind: "creep-recovery", targetStressPa: 1500, rampSec: 1, holdSec: 30, releaseSec: 1, recoverySec: 60, stepSec: 0.05,
});

export const FAT_CREEP_ASSUMPTIONS: readonly string[] = Object.freeze([
  ...FAT_PHYSICS_ASSUMPTIONS.filter(note => !note.startsWith("Displacement is prescribed.")),
  "Compression-positive nominal stress is prescribed; strain and lateral expansion follow the QLV material history. True stress uses the changing current area.",
  "Recovery is computed at zero nominal load; it is not a simulation of platen separation, friction, gravity or local organ contact.",
  "The solver rejects loads that leave the supported 0–35% compression domain. It never silently clips a prescribed load or reports a clipped state as equilibrium.",
  "External work is reported per reference volume. It is not labeled dissipated energy; no general finite-strain passivity claim is made for this reduced QLV model.",
]);

function finiteRange(name: string, value: number, lower: number, upper: number): void {
  if (!Number.isFinite(value) || value < lower || value > upper) throw new RangeError(`${name} must be finite and between ${lower} and ${upper}.`);
}

function equilibriumFraction(material: FatMaterialParameters): number {
  return 1 - material.relaxation.reduce((sum, branch) => sum + branch.fraction, 0);
}

function snapshotMaterial(material: FatMaterialParameters): FatMaterialParameters {
  return Object.freeze({ ...material, relaxation: Object.freeze(material.relaxation.map(branch => Object.freeze({ ...branch }))) });
}

/** Largest sustained nominal stress whose relaxed state remains at/below 35%.
 * This is a model-domain bound, not a permissible biological load or safety limit. */
export function fatCreepStressCapacityPa(material: FatMaterialParameters): number {
  validateFatMaterial(material);
  return equilibriumFraction(material) * fatElasticResponse(material, FAT_CREEP_MAX_STRAIN).stressPa;
}

export class FatCreepDomainError extends RangeError {
  readonly requestedStressPa: number;
  readonly minimumStressPa: number;
  readonly maximumStressPa: number;
  readonly maximumStrain = FAT_CREEP_MAX_STRAIN;
  readonly timeSec: number | null;

  constructor(requestedStressPa: number, minimumStressPa: number, maximumStressPa: number, timeSec: number | null = null) {
    super(`Nominal load ${requestedStressPa.toPrecision(6)} Pa${timeSec === null ? "" : ` at ${timeSec.toPrecision(6)} s`} is outside the current 0–35% compression domain (${minimumStressPa.toPrecision(6)} to ${maximumStressPa.toPrecision(6)} Pa). Reduce the load or change the material; strain was not clipped.`);
    this.name = "FatCreepDomainError";
    this.requestedStressPa = requestedStressPa;
    this.minimumStressPa = minimumStressPa;
    this.maximumStressPa = maximumStressPa;
    this.timeSec = timeSec;
  }
}

export interface FatCreepStep {
  readonly strain: number;
  readonly stressPa: number;
  readonly equilibriumStressPa: number;
  readonly elasticStressPa: number;
  readonly stretch: number;
  readonly lateralStretch: number;
  readonly volumeRatio: number;
  readonly stressResidualPa: number;
  readonly iterations: number;
  readonly state: FatPronyState;
}

/** One stress-controlled constitutive step. dt=0 permits an ideal load jump for
 * analytical tests; production protocols use finite ramps. State is immutable. */
export function advanceFatCreepState(
  material: FatMaterialParameters,
  state: FatPronyState,
  targetStressPa: number,
  dtSec: number,
): FatCreepStep {
  validateFatMaterial(material);
  finiteRange("targetStressPa", targetStressPa, 0, 1e12);
  finiteRange("dtSec", dtSec, 0, 1e9);
  // Reuse the production recurrence to validate history and obtain H exactly.
  const history = advanceFatPronyStress(material, state, 0, dtSec).stressPa;
  let coefficient = equilibriumFraction(material);
  for (const branch of material.relaxation) {
    const ratio = dtSec / branch.tauSec;
    coefficient += branch.fraction * (ratio === 0 ? 1 : -Math.expm1(-ratio) / ratio);
  }
  if (!(coefficient > 0) || !Number.isFinite(history)) throw new RangeError("Invalid stress-control constitutive tangent.");
  const maximumElasticStress = fatElasticResponse(material, FAT_CREEP_MAX_STRAIN).stressPa;
  const maximumStress = coefficient * maximumElasticStress + history;
  // At extreme but accepted moduli, elastic stress and branch history can be
  // large while the target is zero. Include their floating-point scale instead
  // of requiring an absolute sub-ulp residual during unloaded recovery.
  const residualTolerance = Math.max(1e-10, Math.abs(targetStressPa) * 1e-11,
    64 * Number.EPSILON * Math.max(1, maximumElasticStress, Math.abs(history)));
  if (targetStressPa < history - residualTolerance || targetStressPa > maximumStress + residualTolerance) {
    throw new FatCreepDomainError(targetStressPa, history, maximumStress);
  }
  let lower = 0, upper = FAT_CREEP_MAX_STRAIN, strain = 0, iterations = 0;
  let elastic = fatElasticResponse(material, 0);
  if (Math.abs(targetStressPa - history) > residualTolerance) {
    for (let iteration = 0; iteration < 52; iteration++) {
      strain = (lower + upper) * 0.5;
      elastic = fatElasticResponse(material, strain);
      const residual = coefficient * elastic.stressPa + history - targetStressPa;
      iterations = iteration + 1;
      if (Math.abs(residual) <= residualTolerance) break;
      if (residual < 0) lower = strain;
      else upper = strain;
    }
  }
  const response = advanceFatPronyStress(material, state, elastic.stressPa, dtSec);
  const stressResidualPa = response.stressPa - targetStressPa;
  if (!Number.isFinite(stressResidualPa) || Math.abs(stressResidualPa) > Math.max(1e-7, targetStressPa * 1e-9, 4 * residualTolerance)) {
    throw new Error("Stress-control root did not meet the nominal-stress residual tolerance.");
  }
  return { strain, stressPa: response.stressPa, equilibriumStressPa: response.equilibriumStressPa, elasticStressPa: elastic.stressPa,
    stretch: elastic.stretch, lateralStretch: elastic.lateralStretch, volumeRatio: elastic.volumeRatio,
    stressResidualPa, iterations, state: response.state };
}

export function validateFatStressProtocol(protocol: FatStressProtocol): void {
  finiteRange("targetStressPa", protocol.targetStressPa, 0, 1e12);
  finiteRange("stepSec", protocol.stepSec, 1e-6, 3600);
  let duration: number;
  if (protocol.kind === "creep-recovery") {
    finiteRange("rampSec", protocol.rampSec, 1e-6, 3600);
    finiteRange("holdSec", protocol.holdSec, 0, 36_000);
    finiteRange("releaseSec", protocol.releaseSec, 1e-6, 3600);
    finiteRange("recoverySec", protocol.recoverySec, 0, 36_000);
    duration = protocol.rampSec + protocol.holdSec + protocol.releaseSec + protocol.recoverySec;
  } else if (protocol.kind === "stress-cyclic") {
    finiteRange("periodSec", protocol.periodSec, 1e-6, 3600);
    finiteRange("cycles", protocol.cycles, 1, 1000);
    if (!Number.isInteger(protocol.cycles)) throw new RangeError("cycles must be an integer.");
    if (protocol.stepSec > protocol.periodSec / 32) throw new RangeError("Stress cycles need at least 32 samples per cycle.");
    duration = protocol.periodSec * protocol.cycles;
  } else throw new RangeError("Unknown stress-control protocol.");
  if (Math.ceil(duration / protocol.stepSec) + 2005 > 200_001) throw new RangeError("Stress-control protocol requests too many frames; increase stepSec.");
}

function stressCommand(protocol: FatStressProtocol, timeSec: number): { stressPa: number; phase: FatCompressionPhase } {
  if (protocol.kind === "stress-cyclic") {
    const time = Math.min(timeSec, protocol.periodSec * protocol.cycles);
    return { stressPa: protocol.targetStressPa * 0.5 * (1 - Math.cos(2 * Math.PI * time / protocol.periodSec)), phase: "cyclic" };
  }
  if (timeSec <= protocol.rampSec) return { stressPa: protocol.targetStressPa * timeSec / protocol.rampSec, phase: "ramp" };
  if (timeSec <= protocol.rampSec + protocol.holdSec) return { stressPa: protocol.targetStressPa, phase: "hold" };
  if (timeSec <= protocol.rampSec + protocol.holdSec + protocol.releaseSec) return {
    stressPa: protocol.targetStressPa * Math.max(0, 1 - (timeSec - protocol.rampSec - protocol.holdSec) / protocol.releaseSec), phase: "release",
  };
  return { stressPa: 0, phase: "rest" };
}

export function fatStressAtTime(protocol: FatStressProtocol, timeSec: number): { stressPa: number; phase: FatCompressionPhase } {
  validateFatStressProtocol(protocol);
  finiteRange("timeSec", timeSec, 0, 1e9);
  return stressCommand(protocol, timeSec);
}

function protocolSampleTimes(protocol: FatStressProtocol): number[] {
  const duration = protocol.kind === "stress-cyclic" ? protocol.periodSec * protocol.cycles
    : protocol.rampSec + protocol.holdSec + protocol.releaseSec + protocol.recoverySec;
  const events = protocol.kind === "stress-cyclic"
    ? Array.from({ length: 2 * protocol.cycles + 1 }, (_, i) => i * protocol.periodSec / 2)
    : [0, protocol.rampSec, protocol.rampSec + protocol.holdSec, protocol.rampSec + protocol.holdSec + protocol.releaseSec, duration];
  const candidates = [...events, ...Array.from({ length: Math.floor(duration / protocol.stepSec) + 1 }, (_, i) => i * protocol.stepSec)].sort((a, b) => a - b);
  const tolerance = Number.EPSILON * Math.max(1, duration) * 16, times: number[] = [];
  for (const time of candidates) {
    if (!times.length || time - times.at(-1)! > tolerance) times.push(time);
    else if (events.includes(time)) times[times.length - 1] = time;
  }
  return times;
}

export function runFatCreep(
  material: FatMaterialParameters = DEFAULT_FAT_MATERIAL,
  protocol: FatStressProtocol = DEFAULT_FAT_CREEP_PROTOCOL,
  specimen: FatSpecimenDimensions = DEFAULT_FAT_SPECIMEN,
): FatCreepResult {
  validateFatMaterial(material); validateFatStressProtocol(protocol);
  finiteRange("widthMm", specimen.widthMm, 0.001, 10_000);
  finiteRange("heightMm", specimen.heightMm, 0.001, 10_000);
  finiteRange("depthMm", specimen.depthMm, 0.001, 10_000);
  const referenceAreaM2 = specimen.widthMm * specimen.depthMm * 1e-6;
  const referenceVolumeM3 = referenceAreaM2 * specimen.heightMm * 1e-3;
  const frames: FatCreepFrame[] = [];
  let state = createFatPronyState(material), lastTime = 0, previousStrain = 0, previousStress = 0;
  let peakStressPa = 0, minimumStressPa = 0, peakStrain = 0, maximumResidual = 0, maximumIterations = 0, totalIterations = 0;
  let minimumVolumeRatio = 1, maximumVolumeRatio = 1, loadingWorkDensityJm3 = 0;
  for (const timeSec of protocolSampleTimes(protocol)) {
    const command = stressCommand(protocol, timeSec);
    let response: FatCreepStep;
    try { response = advanceFatCreepState(material, state, command.stressPa, timeSec - lastTime); }
    catch (error) {
      if (error instanceof FatCreepDomainError) throw new FatCreepDomainError(error.requestedStressPa, error.minimumStressPa, error.maximumStressPa, timeSec);
      throw error;
    }
    state = response.state;
    const forceN = response.stressPa * referenceAreaM2;
    const currentAreaM2 = referenceAreaM2 * response.lateralStretch ** 2;
    frames.push({ timeSec, phase: command.phase, strain: response.strain, stretch: response.stretch, lateralStretch: response.lateralStretch,
      volumeRatio: response.volumeRatio, stressPa: response.stressPa, cauchyStressPa: forceN / currentAreaM2, elasticStressPa: response.elasticStressPa,
      equilibriumStressPa: response.equilibriumStressPa, forceN, currentAreaM2, heightMm: specimen.heightMm * response.stretch,
      targetStressPa: command.stressPa, stressResidualPa: response.stressResidualPa, solverIterations: response.iterations });
    peakStressPa = Math.max(peakStressPa, response.stressPa); minimumStressPa = Math.min(minimumStressPa, response.stressPa);
    peakStrain = Math.max(peakStrain, response.strain);
    maximumResidual = Math.max(maximumResidual, Math.abs(response.stressResidualPa));
    maximumIterations = Math.max(maximumIterations, response.iterations); totalIterations += response.iterations;
    minimumVolumeRatio = Math.min(minimumVolumeRatio, response.volumeRatio); maximumVolumeRatio = Math.max(maximumVolumeRatio, response.volumeRatio);
    loadingWorkDensityJm3 += 0.5 * (previousStress + response.stressPa) * (response.strain - previousStrain);
    previousStress = response.stressPa; previousStrain = response.strain; lastTime = timeSec;
  }
  let holdCreepRatio: number | null = null;
  if (protocol.kind === "creep-recovery" && protocol.targetStressPa > 0 && protocol.holdSec > 0) {
    const first = frames.find(frame => frame.timeSec === protocol.rampSec)!;
    const last = frames.find(frame => frame.timeSec === protocol.rampSec + protocol.holdSec)!;
    holdCreepRatio = last.strain / first.strain;
  }
  const residualStrain = frames.at(-1)!.strain;
  const diagnostics: FatCreepDiagnostics = {
    controlMode: "nominal-stress", finite: frames.every(frame => Object.values(frame).every(value => typeof value !== "number" || Number.isFinite(value))),
    peakStressPa, peakForceN: peakStressPa * referenceAreaM2, minimumStressPa, holdRelaxationRatio: null, minimumVolumeRatio, maximumVolumeRatio,
    referenceAreaM2, referenceVolumeM3, massKg: material.densityKgM3 * referenceVolumeM3,
    equilibriumShearModulusPa: material.shearModulusPa * equilibriumFraction(material),
    instantaneousYoungModulusPa: 2 * material.shearModulusPa * (1 + material.poisson), loadingWorkDensityJm3,
    peakStrain, residualStrain, holdCreepRatio, recoveryFraction: peakStrain > 0 ? 1 - residualStrain / peakStrain : null,
    maximumStressResidualPa: maximumResidual, maximumSolverIterations: maximumIterations, totalSolverIterations: totalIterations,
    maximumSupportedStrain: FAT_CREEP_MAX_STRAIN,
  };
  return { frames, diagnostics, material: snapshotMaterial(material), protocol: Object.freeze({ ...protocol }), specimen: Object.freeze({ ...specimen }), assumptions: FAT_CREEP_ASSUMPTIONS };
}

export interface FatComparisonMaterial { readonly id: string; readonly label: string; readonly parameters: FatMaterialParameters }
export interface FatMechanicsComparisonOptions {
  readonly creepProtocol?: FatCreepProtocol;
  readonly compressionProtocol?: FatRampHoldReleaseProtocol;
  readonly rampTimesSec?: readonly number[];
  readonly specimen?: FatSpecimenDimensions;
}
export interface FatMechanicsComparison {
  readonly id: string;
  readonly label: string;
  readonly creep: FatCreepResult;
  readonly relaxation: FatCompressionResult;
  readonly compressionRates: readonly { readonly rampSec: number; readonly result: FatCompressionResult }[];
}

/** Compare complete, common loading protocols rather than silently normalizing
 * each material to a different load. Unsupported loads are explicit errors. */
export function compareFatMaterialExperiments(
  materials: readonly FatComparisonMaterial[],
  options: FatMechanicsComparisonOptions = {},
): readonly FatMechanicsComparison[] {
  if (!materials.length || materials.length > 16 || new Set(materials.map(material => material.id)).size !== materials.length) throw new RangeError("Provide 1–16 uniquely identified comparison materials.");
  const creepProtocol = options.creepProtocol ?? DEFAULT_FAT_CREEP_PROTOCOL;
  const compressionProtocol = options.compressionProtocol ?? DEFAULT_FAT_PROTOCOL;
  const specimen = options.specimen ?? DEFAULT_FAT_SPECIMEN;
  const rates = options.rampTimesSec ?? [0.1, 1, 10];
  if (!rates.length || rates.length > 16 || new Set(rates).size !== rates.length) throw new RangeError("Provide 1–16 distinct ramp durations.");
  for (const rate of rates) finiteRange("ramp duration", rate, 1e-6, 3600);
  return materials.map(material => ({ id: material.id, label: material.label,
    creep: runFatCreep(material.parameters, creepProtocol, specimen),
    relaxation: runFatCompression(material.parameters, compressionProtocol, specimen),
    compressionRates: rates.map(rampSec => ({ rampSec, result: runFatCompression(material.parameters,
      { ...compressionProtocol, rampSec, stepSec: Math.min(compressionProtocol.stepSec, rampSec / 20) }, specimen) })),
  }));
}
