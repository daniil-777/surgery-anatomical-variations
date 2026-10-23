/**
 * Homogeneous adipose material bench, SI internally. This is a reduced,
 * displacement-controlled unconfined test, not a 3-D organ/contact solver.
 *
 * Elastic energy: W = mu/2 (I1 - 3 - 2 log J) + lambdaL/2 (log J)^2.
 * Solve traction-free lateral stretch at each imposed axial stretch, then apply
 * a scalar QLV convolution to nominal axial stress. All modes share one reduced
 * relaxation function; this does not represent fluid transport or anisotropy.
 *
 * R(t) = 1 - sum(g_i) + sum(g_i exp(-t/tau_i)). The positive Prony branches
 * integrate exactly for piecewise-linear elastic nominal stress; the nonlinear
 * strain path is sampled and therefore still requires timestep convergence.
 */

export interface FatRelaxationBranch {
  /** Fraction of the instantaneous shear modulus; all fractions sum to < 1. */
  readonly fraction: number;
  readonly tauSec: number;
}

export interface FatMaterialParameters {
  readonly densityKgM3: number;
  /** Instantaneous shear modulus, not dynamic storage modulus or Young modulus. */
  readonly shearModulusPa: number;
  readonly poisson: number;
  readonly relaxation: readonly FatRelaxationBranch[];
}

export interface FatSpecimenDimensions {
  readonly widthMm: number;
  /** Compression acts along y. The reference loaded area is width × depth. */
  readonly heightMm: number;
  readonly depthMm: number;
}

export interface FatRampHoldReleaseProtocol {
  readonly kind: "ramp-hold-release";
  /** Positive engineering compression, 0 to 0.35 (35%). */
  readonly compression: number;
  readonly rampSec: number;
  readonly holdSec: number;
  readonly releaseSec: number;
  readonly restSec: number;
  readonly stepSec: number;
}

export interface FatCyclicProtocol {
  readonly kind: "cyclic";
  readonly compression: number;
  readonly periodSec: number;
  readonly cycles: number;
  readonly stepSec: number;
}

export type FatCompressionProtocol = FatRampHoldReleaseProtocol | FatCyclicProtocol;
export type FatCompressionPhase = "ramp" | "hold" | "release" | "rest" | "cyclic";

export interface FatCompressionFrame {
  readonly timeSec: number;
  readonly phase: FatCompressionPhase;
  readonly strain: number;
  readonly stretch: number;
  readonly lateralStretch: number;
  readonly volumeRatio: number;
  /** Compression-positive nominal stress, force/reference area, in Pa. */
  readonly stressPa: number;
  /** Compression-positive true stress, force/current area, in Pa. */
  readonly cauchyStressPa: number;
  readonly elasticStressPa: number;
  readonly equilibriumStressPa: number;
  readonly forceN: number;
  readonly currentAreaM2: number;
  readonly heightMm: number;
}

export interface FatCompressionDiagnostics {
  readonly finite: boolean;
  readonly peakStressPa: number;
  readonly peakForceN: number;
  readonly minimumStressPa: number;
  /** End-hold/start-hold stress. Null for cyclic, zero-strain or zero-hold runs. */
  readonly holdRelaxationRatio: number | null;
  readonly minimumVolumeRatio: number;
  readonly maximumVolumeRatio: number;
  readonly referenceAreaM2: number;
  readonly referenceVolumeM3: number;
  readonly massKg: number;
  readonly equilibriumShearModulusPa: number;
  readonly instantaneousYoungModulusPa: number;
  /** Trapezoidal external work / reference volume, J/m³; not dissipation. */
  readonly loadingWorkDensityJm3: number;
}

export interface FatCompressionResult {
  readonly frames: readonly FatCompressionFrame[];
  readonly diagnostics: FatCompressionDiagnostics;
  readonly material: FatMaterialParameters;
  readonly protocol: FatCompressionProtocol;
  readonly specimen: FatSpecimenDimensions;
  readonly assumptions: readonly string[];
}

export const FAT_PHYSICS_REFERENCES = Object.freeze([
  {
    id: "juliar-2020",
    title: "Viscoelastic characterization of diabetic and non-diabetic human adipose tissue",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7876417/",
    use: "Small-strain dynamic shear supports kPa-scale, rate-dependent behavior and depot variation. It does not calibrate large-strain compression.",
  },
  {
    id: "human-calf-2021",
    title: "Human calf subcutaneous adipose poroviscoelastic characterization (PMID 33887715)",
    url: "https://pubmed.ncbi.nlm.nih.gov/33887715/",
    use: "Reported inverse-model time constants 27.5–38.5 s motivate a slow 30 s branch; coefficients here are not fitted to those data.",
  },
  {
    id: "sommer-2013",
    title: "Multiaxial mechanical properties and constitutive modeling of human adipose tissue: A basis for preoperative simulations in plastic and reconstructive surgery",
    url: "https://doi.org/10.1016/j.actbio.2013.06.011",
    use: "Motivates explicit limitations: human fat is nonlinear, anisotropic and viscoelastic. This isotropic reduced model omits its fiber structure.",
  },
  {
    id: "alkhouli-2013",
    title: "The mechanical properties of human adipose tissues and their relationships to the structure and composition of the extracellular matrix",
    url: "https://pubmed.ncbi.nlm.nih.gov/24105412/",
    use: "Paired tension testing found a different depot stiffness ordering from small-strain dynamic shear, demonstrating why one scalar modulus cannot be transferred across testing modes.",
  },
]);

export const FAT_PHYSICS_ASSUMPTIONS: readonly string[] = Object.freeze([
  "Illustrative research material model; parameters are not fitted or clinically validated.",
  "Homogeneous, isotropic, isothermal, affine deformation; free lateral surfaces; compression limited to 35%.",
  "Neo-Hookean elasticity and a shared positive Prony spectrum approximate rate dependence; no poroelastic flow, fibers, damage, friction or organ contact.",
  "Displacement is prescribed. Negative release reaction requires a tensile constraint; it is not free recovery or nonadhesive platen contact.",
  "Density affects reported specimen mass only. This quasistatic bench has no inertial or gravity dynamics.",
  "Preset density 950 kg/m³, Poisson ratio 0.49, relaxation fractions and fast time constant are simulation assumptions.",
  "Depot ordering depends on test mode: paired tension data and small-strain dynamic shear do not support one universal visceral/subcutaneous stiffness ranking.",
]);

export interface FatMaterialPreset {
  readonly id: string;
  readonly label: string;
  readonly parameters: FatMaterialParameters;
  readonly provenance: string;
}

function freezeMaterial(material: FatMaterialParameters): FatMaterialParameters {
  return Object.freeze({ ...material, relaxation: Object.freeze(material.relaxation.map(branch => Object.freeze({ ...branch }))) });
}

/** Starting points of the correct order of magnitude, not estimated tissue constants.
 * Juliar Table 4 gives G'(1 rad/s) = 6.680 kPa VAT, 10.558 kPa SAT for frozen/thawed
 * bariatric samples at 37°C, 0.1% shear. Those are NOT mu0 or mu-infinity.
 * The presets deliberately expose their independently chosen mu0 and spectrum.
 */
export const FAT_MATERIAL_PRESETS: readonly FatMaterialPreset[] = Object.freeze([
  Object.freeze({
    id: "visceral-illustrative",
    label: "Visceral · illustrative",
    parameters: freezeMaterial({ densityKgM3: 950, shearModulusPa: 8000, poisson: 0.49, relaxation: [{ fraction: 0.25, tauSec: 1 }, { fraction: 0.25, tauSec: 30 }] }),
    provenance: "8 kPa instantaneous shear is an illustrative choice informed by the kPa scale of Juliar 2020 VAT dynamic shear, not a fit. 30 s is inspired by a different calf SAT inverse study; 1 s and both 0.25 fractions are assumptions.",
  }),
  Object.freeze({
    id: "subcutaneous-illustrative",
    label: "Subcutaneous · illustrative",
    parameters: freezeMaterial({ densityKgM3: 950, shearModulusPa: 12000, poisson: 0.49, relaxation: [{ fraction: 0.25, tauSec: 1 }, { fraction: 0.25, tauSec: 30 }] }),
    provenance: "12 kPa instantaneous shear is an illustrative choice reflecting the greater SAT dynamic stiffness in Juliar 2020, not a fit. No large-strain or individual-patient calibration is claimed.",
  }),
]);

export const DEFAULT_FAT_MATERIAL: FatMaterialParameters = FAT_MATERIAL_PRESETS[0]!.parameters;
export const DEFAULT_FAT_SPECIMEN: FatSpecimenDimensions = Object.freeze({ widthMm: 40, heightMm: 20, depthMm: 40 });
export const DEFAULT_FAT_PROTOCOL: FatRampHoldReleaseProtocol = Object.freeze({
  kind: "ramp-hold-release", compression: 0.25, rampSec: 1, holdSec: 12, releaseSec: 2, restSec: 3, stepSec: 0.025,
});

const MAX_FRAMES = 200_001;

function finiteInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be finite and between ${min} and ${max}.`);
}

export function validateFatMaterial(material: FatMaterialParameters): void {
  finiteInRange("densityKgM3", material.densityKgM3, 1, 5000);
  finiteInRange("shearModulusPa", material.shearModulusPa, 1, 1e9);
  finiteInRange("poisson", material.poisson, 0, 0.4999);
  if (!Array.isArray(material.relaxation) || material.relaxation.length > 32) throw new RangeError("relaxation must contain at most 32 Prony branches.");
  let fractionSum = 0;
  for (const branch of material.relaxation) {
    finiteInRange("relaxation fraction", branch.fraction, 0, 1);
    finiteInRange("tauSec", branch.tauSec, 1e-9, 1e9);
    fractionSum += branch.fraction;
  }
  if (fractionSum >= 1) throw new RangeError("Relaxation fractions must sum to less than 1, leaving a positive equilibrium modulus.");
}

function validateSpecimen(specimen: FatSpecimenDimensions): void {
  for (const [key, value] of Object.entries(specimen)) finiteInRange(key, value, 0.001, 10_000);
  finiteInRange("widthMm", specimen.widthMm, 0.001, 10_000);
  finiteInRange("heightMm", specimen.heightMm, 0.001, 10_000);
  finiteInRange("depthMm", specimen.depthMm, 0.001, 10_000);
}

function protocolDuration(protocol: FatCompressionProtocol): number {
  return protocol.kind === "cyclic" ? protocol.periodSec * protocol.cycles : protocol.rampSec + protocol.holdSec + protocol.releaseSec + protocol.restSec;
}

export function validateFatProtocol(protocol: FatCompressionProtocol): void {
  finiteInRange("compression", protocol.compression, 0, 0.35);
  finiteInRange("stepSec", protocol.stepSec, 1e-6, 3600);
  if (protocol.kind === "ramp-hold-release") {
    finiteInRange("rampSec", protocol.rampSec, 1e-6, 3600);
    finiteInRange("holdSec", protocol.holdSec, 0, 36_000);
    finiteInRange("releaseSec", protocol.releaseSec, 1e-6, 3600);
    finiteInRange("restSec", protocol.restSec, 0, 36_000);
  } else if (protocol.kind === "cyclic") {
    finiteInRange("periodSec", protocol.periodSec, 1e-6, 3600);
    finiteInRange("cycles", protocol.cycles, 1, 1000);
    if (!Number.isInteger(protocol.cycles)) throw new RangeError("cycles must be an integer.");
    if (protocol.stepSec > protocol.periodSec / 16) throw new RangeError("Cyclic stepSec must provide at least 16 samples per cycle.");
  } else {
    throw new RangeError("Unknown fat compression protocol kind.");
  }
  if (Math.ceil(protocolDuration(protocol) / protocol.stepSec) + 2_005 > MAX_FRAMES) throw new RangeError(`Protocol requests too many frames; increase stepSec (limit ${MAX_FRAMES}).`);
}

/** Positive engineering compression is the prescribed input, never inferred from stress. */
export function fatCompressionAtTime(protocol: FatCompressionProtocol, timeSec: number): { strain: number; phase: FatCompressionPhase } {
  validateFatProtocol(protocol);
  finiteInRange("timeSec", timeSec, 0, 1e9);
  if (protocol.kind === "cyclic") {
    const t = Math.min(timeSec, protocolDuration(protocol));
    return { strain: protocol.compression * 0.5 * (1 - Math.cos(2 * Math.PI * t / protocol.periodSec)), phase: "cyclic" };
  }
  if (timeSec <= protocol.rampSec) return { strain: protocol.compression * timeSec / protocol.rampSec, phase: "ramp" };
  if (timeSec <= protocol.rampSec + protocol.holdSec) return { strain: protocol.compression, phase: "hold" };
  if (timeSec <= protocol.rampSec + protocol.holdSec + protocol.releaseSec) return { strain: protocol.compression * Math.max(0, 1 - (timeSec - protocol.rampSec - protocol.holdSec) / protocol.releaseSec), phase: "release" };
  return { strain: 0, phase: "rest" };
}

/** Diagonal affine F=(b,lambda,b), with b from zero elastic lateral traction.
 * For nu→0.5 this tends to b=lambda^(-1/2) and J=1. Finite nu deliberately
 * allows a small, reported volume change instead of silently forcing J=1.
 */
export function fatAffineDeformation(strain: number, poisson: number): { x: number; y: number; z: number; volumeRatio: number } {
  finiteInRange("strain", strain, 0, 0.35);
  finiteInRange("poisson", poisson, 0, 0.4999);
  const axial = 1 - strain;
  if (strain === 0 || poisson === 0) return { x: 1, y: axial, z: 1, volumeRatio: axial };
  const lambdaOverMu = 2 * poisson / (1 - 2 * poisson);
  let lower = 1, upper = 1 / axial;
  // Monotone equation t-1 + (lambdaL/mu) log(axial*t)=0, t=b².
  for (let iteration = 0; iteration < 52; iteration++) {
    const mid = 0.5 * (lower + upper);
    if (mid - 1 + lambdaOverMu * Math.log(axial * mid) > 0) upper = mid;
    else lower = mid;
  }
  const lateralSquared = 0.5 * (lower + upper), lateral = Math.sqrt(lateralSquared);
  return { x: lateral, y: axial, z: lateral, volumeRatio: axial * lateralSquared };
}

export function fatElasticResponse(material: FatMaterialParameters, strain: number) {
  validateFatMaterial(material);
  const deformation = fatAffineDeformation(strain, material.poisson);
  const lateralSquared = deformation.x ** 2;
  const stressPa = material.shearModulusPa * (lateralSquared / deformation.y - deformation.y);
  return { stressPa, cauchyStressPa: stressPa / lateralSquared, lateralStretch: deformation.x, stretch: deformation.y, volumeRatio: deformation.volumeRatio };
}

/** Linearized small-amplitude shear spectrum. omega is rad/s, not Hz. */
export function fatDynamicShear(material: FatMaterialParameters, omegaRadSec: number): { storagePa: number; lossPa: number } {
  validateFatMaterial(material);
  finiteInRange("omegaRadSec", omegaRadSec, 0, 1e12);
  let storageFraction = 1 - material.relaxation.reduce((sum, branch) => sum + branch.fraction, 0), lossFraction = 0;
  for (const branch of material.relaxation) {
    const wt = omegaRadSec * branch.tauSec, denominator = 1 + wt * wt;
    storageFraction += branch.fraction * wt * wt / denominator;
    lossFraction += branch.fraction * wt / denominator;
  }
  return { storagePa: material.shearModulusPa * storageFraction, lossPa: material.shearModulusPa * lossFraction };
}

export interface FatPronyState {
  readonly elasticStressPa: number;
  readonly branchStressPa: readonly number[];
}

export function createFatPronyState(material: FatMaterialParameters): FatPronyState {
  validateFatMaterial(material);
  return { elasticStressPa: 0, branchStressPa: material.relaxation.map(() => 0) };
}

/** Exact update of q_i' + q_i/tau_i = g_i * d(P_elastic)/dt for a linear
 * elastic-stress segment. dt=0 represents an ideal instantaneous stress jump.
 * Returns new state; caller state and material are never mutated.
 */
export function advanceFatPronyStress(material: FatMaterialParameters, state: FatPronyState, elasticStressPa: number, dtSec: number): { stressPa: number; equilibriumStressPa: number; state: FatPronyState } {
  validateFatMaterial(material);
  finiteInRange("dtSec", dtSec, 0, 1e9);
  if (!Number.isFinite(elasticStressPa) || !Number.isFinite(state.elasticStressPa)) throw new RangeError("Elastic stresses must be finite.");
  if (state.branchStressPa.length !== material.relaxation.length || !state.branchStressPa.every(Number.isFinite)) throw new RangeError("Prony state does not match the material branches or is non-finite.");
  const delta = elasticStressPa - state.elasticStressPa;
  const branchStressPa = material.relaxation.map((branch, index) => {
    const ratio = dtSec / branch.tauSec;
    const decay = Math.exp(-ratio);
    const ramp = ratio === 0 ? 1 : -Math.expm1(-ratio) / ratio;
    return decay * state.branchStressPa[index]! + branch.fraction * ramp * delta;
  });
  const equilibriumStressPa = elasticStressPa * (1 - material.relaxation.reduce((sum, branch) => sum + branch.fraction, 0));
  const stressPa = equilibriumStressPa + branchStressPa.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(stressPa) || !branchStressPa.every(Number.isFinite)) throw new RangeError("Prony stress overflow; reduce the supplied stresses.");
  return { stressPa, equilibriumStressPa, state: { elasticStressPa, branchStressPa } };
}

function sampleTimes(protocol: FatCompressionProtocol): number[] {
  const duration = protocolDuration(protocol);
  const events = protocol.kind === "cyclic"
    ? Array.from({ length: protocol.cycles * 2 + 1 }, (_, index) => index * protocol.periodSec / 2)
    : [0, protocol.rampSec, protocol.rampSec + protocol.holdSec, protocol.rampSec + protocol.holdSec + protocol.releaseSec, duration];
  const candidates = [...events, ...Array.from({ length: Math.floor(duration / protocol.stepSec) + 1 }, (_, index) => index * protocol.stepSec)];
  candidates.sort((a, b) => a - b);
  // Prefer exact event times if a regular sample is only floating-point epsilon away.
  const tolerance = Number.EPSILON * Math.max(1, duration) * 16;
  const result: number[] = [];
  for (const time of candidates) {
    const previous = result.at(-1);
    if (previous === undefined || time - previous > tolerance) result.push(time);
    else if (events.includes(time)) result[result.length - 1] = time;
  }
  return result;
}

/** Run a prescribed homogeneous material test. Event times are always sampled so
 * ramp/hold boundaries are respected even when stepSec does not divide them.
 */
export function runFatCompression(
  material: FatMaterialParameters = DEFAULT_FAT_MATERIAL,
  protocol: FatCompressionProtocol = DEFAULT_FAT_PROTOCOL,
  specimen: FatSpecimenDimensions = DEFAULT_FAT_SPECIMEN,
): FatCompressionResult {
  validateFatMaterial(material);
  validateFatProtocol(protocol);
  validateSpecimen(specimen);
  const referenceAreaM2 = specimen.widthMm * specimen.depthMm * 1e-6;
  const referenceVolumeM3 = referenceAreaM2 * specimen.heightMm * 1e-3;
  const frames: FatCompressionFrame[] = [];
  let state = createFatPronyState(material), lastTime = 0, previousStrain = 0, previousStress = 0;
  let peakStressPa = 0, minimumStressPa = 0, minimumVolumeRatio = 1, maximumVolumeRatio = 1, loadingWorkDensityJm3 = 0;
  for (const timeSec of sampleTimes(protocol)) {
    const { strain, phase } = fatCompressionAtTime(protocol, timeSec);
    const elastic = fatElasticResponse(material, strain);
    const response = advanceFatPronyStress(material, state, elastic.stressPa, timeSec - lastTime);
    state = response.state;
    const currentAreaM2 = referenceAreaM2 * elastic.lateralStretch ** 2;
    const forceN = response.stressPa * referenceAreaM2;
    frames.push({ timeSec, phase, strain, stretch: elastic.stretch, lateralStretch: elastic.lateralStretch, volumeRatio: elastic.volumeRatio,
      stressPa: response.stressPa, cauchyStressPa: forceN / currentAreaM2, elasticStressPa: elastic.stressPa,
      equilibriumStressPa: response.equilibriumStressPa, forceN, currentAreaM2, heightMm: specimen.heightMm * elastic.stretch });
    peakStressPa = Math.max(peakStressPa, response.stressPa);
    minimumStressPa = Math.min(minimumStressPa, response.stressPa);
    minimumVolumeRatio = Math.min(minimumVolumeRatio, elastic.volumeRatio);
    maximumVolumeRatio = Math.max(maximumVolumeRatio, elastic.volumeRatio);
    loadingWorkDensityJm3 += 0.5 * (previousStress + response.stressPa) * (strain - previousStrain);
    previousStrain = strain; previousStress = response.stressPa; lastTime = timeSec;
  }
  let holdRelaxationRatio: number | null = null;
  if (protocol.kind === "ramp-hold-release" && protocol.holdSec > 0 && protocol.compression > 0) {
    const start = frames.find(frame => frame.timeSec === protocol.rampSec)!;
    const end = frames.find(frame => frame.timeSec === protocol.rampSec + protocol.holdSec)!;
    holdRelaxationRatio = end.stressPa / start.stressPa;
  }
  const diagnostics: FatCompressionDiagnostics = {
    finite: frames.every(frame => Object.values(frame).every(value => typeof value !== "number" || Number.isFinite(value))),
    peakStressPa, peakForceN: peakStressPa * referenceAreaM2, minimumStressPa, holdRelaxationRatio,
    minimumVolumeRatio, maximumVolumeRatio, referenceAreaM2, referenceVolumeM3,
    massKg: material.densityKgM3 * referenceVolumeM3,
    equilibriumShearModulusPa: material.shearModulusPa * (1 - material.relaxation.reduce((sum, branch) => sum + branch.fraction, 0)),
    instantaneousYoungModulusPa: 2 * material.shearModulusPa * (1 + material.poisson), loadingWorkDensityJm3,
  };
  return { frames, diagnostics, material: freezeMaterial(material), protocol: Object.freeze({ ...protocol }), specimen: Object.freeze({ ...specimen }), assumptions: FAT_PHYSICS_ASSUMPTIONS };
}
