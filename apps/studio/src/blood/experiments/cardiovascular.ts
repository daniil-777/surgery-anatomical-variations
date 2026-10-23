/** Independently implemented six-compartment circulation. SI throughout.
 * Equations/nominal parameter provenance and limitations: CARDIOVASCULAR.md.
 * This is an educational reduced model, not a patient-calibrated circulation.
 */
export const CV_COMPARTMENTS = ["lv", "systemicArtery", "systemicVein", "rv", "pulmonaryArtery", "pulmonaryVein"] as const;
export type CardiovascularCompartment = typeof CV_COMPARTMENTS[number];
type CompartmentValues = Record<CardiovascularCompartment, number>;
export interface CardiovascularConfig {
  heartRateBpm: number;
  fixedDtSeconds: number;
  /** Circuit inventory only; a separately initialized local vessel must be
   * deducted by the coordinator when representing a fixed combined inventory. */
  initialBloodVolumeM3: number;
  systemicResistanceScale: number;
  contractilityScale: number;
  /** Explicit closed-loop equilibration, then phase/time reset to cycle start. */
  warmupCycles: number;
}
export interface CardiovascularExchange {
  /** Signed source→local volume; negative values refund the source. */
  toLocalM3: number;
  /** Signed local→return volume; negative values withdraw from the return. */
  fromLocalM3: number;
  source: "systemicArtery" | "systemicVein";
  returnTo: "systemicVein" | "rv";
}
export interface CardiovascularSnapshot {
  timeSeconds: number;
  stepIndex: number;
  compartmentVolumesM3: CompartmentValues;
  pressuresPa: CompartmentValues;
  /** Remaining stressed inventory before the linear chamber reaches zero
   * transmural pressure; collapse beyond that is outside this model. */
  availableSourceVolumeM3: { systemicArtery: number; systemicVein: number; rv: number };
  valveFlowsM3S: { aortic: number; tricuspid: number; pulmonary: number; mitral: number };
  systemicFlowM3S: number;
  pulmonaryFlowM3S: number;
  circulatingVolumeM3: number;
  netTransferredToLocalM3: number;
  volumeErrorM3: number;
}
declare const cvCheckpointBrand: unique symbol;
export interface CardiovascularCheckpoint { readonly [cvCheckpointBrand]: true }
interface CVState { time: number; steps: number; volumes: number[]; flows: number[]; mask: number; transferred: number }
export const CARDIOVASCULAR_PROVENANCE = Object.freeze({
  model: "six-compartment time-varying elastance, four ideal diode valves, conservative backward Euler",
  parameters: "CVSim-6 nominal adult reference, De Florio et al. 2024 Appendix A; SI-converted factual values",
  source: "https://arxiv.org/html/2408.07201v1#A1",
  originalModel: "https://physionet.org/content/cvsim/1.0.0/",
  implementation: "Independent equations and solver; no third-party source code or learned weights copied",
  limits: "No atria, baroreflex, autoregulation, respiration coupling, septal interaction, inertance, or patient calibration",
});
const MMHG_PA = 133.322;
// Barye = 0.1 Pa; mL = 1e-6 m³. Thus mL/Barye ×1e-5,
// Barye·s/mL ×1e5. Compartment order is CV_COMPARTMENTS above.
const V0 = [15, 715, 2500, 15, 90, 490].map(v => v * 1e-6);
const CDIA = [.0075, .0012, .075, .015, .00323, .0063].map(v => v * 1e-5);
const CSYS_LV = .0003 * 1e-5, CSYS_RV = .0009 * 1e-5;
const EXTERNAL_PA = [-4, -4 / 3, 0, -4, -4, -4].map(v => v * MMHG_PA);
// Each edge is an outgoing flow; only four cardiac valves are rectifiers.
const EDGES = [
  { from: 0, to: 1, resistance: 8 * 1e5, bit: 0 },
  { from: 1, to: 2, resistance: 1333.22 * 1e5, bit: -1 },
  { from: 2, to: 3, resistance: 66.66 * 1e5, bit: 1 },
  { from: 3, to: 4, resistance: 4 * 1e5, bit: 2 },
  { from: 4, to: 5, resistance: 106.66 * 1e5, bit: -1 },
  { from: 5, to: 0, resistance: 13.33 * 1e5, bit: 3 },
] as const;
const clone = (s: CVState): CVState => ({ ...s, volumes: [...s.volumes], flows: [...s.flows] });
const values = (v: readonly number[]): CompartmentValues => Object.fromEntries(CV_COMPARTMENTS.map((key, i) => [key, v[i]!])) as CompartmentValues;
const sum = (v: readonly number[]) => v.reduce((a, b) => a + b, 0);

/** Smooth contraction and slower relaxation; the 0.33 cycle systolic ratio is
 * nominal. This waveform prescribes elastance, never arterial pressure. */
export function cardiovascularElastance(timeSeconds: number, config: CardiovascularConfig) {
  const period = 60 / config.heartRateBpm, systole = .33 * period, phase = ((timeSeconds % period) + period) % period;
  let activation = 0;
  if (phase < systole) activation = .5 * (1 - Math.cos(Math.PI * phase / systole));
  else if (phase < 1.5 * systole) activation = .5 * (1 + Math.cos(2 * Math.PI * (phase - systole) / systole));
  const e = CDIA.map(c => 1 / c);
  e[0] = 1 / CDIA[0]! + activation * config.contractilityScale * (1 / CSYS_LV - 1 / CDIA[0]!);
  e[3] = 1 / CDIA[3]! + activation * config.contractilityScale * (1 / CSYS_RV - 1 / CDIA[3]!);
  return e;
}
function pressures(volumes: readonly number[], e: readonly number[]) {
  return volumes.map((v, i) => EXTERNAL_PA[i]! + e[i]! * (v - V0[i]!));
}
function solve(matrix: number[][], rhs: number[]) {
  // Six unknowns only. Partial pivoting is explicit and independently tested.
  for (let i = 0; i < 6; i++) {
    let pivot = i;
    for (let j = i + 1; j < 6; j++) if (Math.abs(matrix[j]![i]!) > Math.abs(matrix[pivot]![i]!)) pivot = j;
    if (Math.abs(matrix[pivot]![i]!) < 1e-14) throw new Error("Singular cardiovascular system");
    [matrix[i], matrix[pivot]] = [matrix[pivot]!, matrix[i]!]; [rhs[i], rhs[pivot]] = [rhs[pivot]!, rhs[i]!];
    for (let row = i + 1; row < 6; row++) {
      const factor = matrix[row]![i]! / matrix[i]![i]!;
      for (let col = i; col < 6; col++) matrix[row]![col] = matrix[row]![col]! - factor * matrix[i]![col]!;
      rhs[row] = rhs[row]! - factor * rhs[i]!;
    }
  }
  const result = new Array<number>(6);
  for (let i = 5; i >= 0; i--) {
    let value = rhs[i]!;
    for (let j = i + 1; j < 6; j++) value -= matrix[i]![j]! * result[j]!;
    result[i] = value / matrix[i]![i]!;
  }
  return result;
}
export class CardiovascularCircuit {
  readonly config: Readonly<CardiovascularConfig>;
  private state: CVState;
  private revision = 0;
  private readonly checkpoints = new WeakMap<CardiovascularCheckpoint, CVState>();
  constructor(options: Partial<CardiovascularConfig> = {}) {
    const config: CardiovascularConfig = { heartRateBpm: 72, fixedDtSeconds: .002, initialBloodVolumeM3: .005,
      systemicResistanceScale: 1, contractilityScale: 1, warmupCycles: 24, ...options };
    if (!Number.isFinite(config.heartRateBpm) || config.heartRateBpm < 30 || config.heartRateBpm > 200 ||
      !Number.isFinite(config.fixedDtSeconds) || config.fixedDtSeconds < 1e-5 || config.fixedDtSeconds > .01 ||
      !Number.isFinite(config.initialBloodVolumeM3) || config.initialBloodVolumeM3 < .004 || config.initialBloodVolumeM3 > .007 ||
      !Number.isFinite(config.systemicResistanceScale) || config.systemicResistanceScale < .1 || config.systemicResistanceScale > 10 ||
      !Number.isFinite(config.contractilityScale) || config.contractilityScale < 0 || config.contractilityScale > 4 ||
      !Number.isInteger(config.warmupCycles) || config.warmupCycles < 0 || config.warmupCycles > 120)
      throw new RangeError("Cardiovascular parameters are outside the supported numerical envelope");
    this.config = Object.freeze(config);
    const initialPressure = [7, 90, 5, 4, 15, 8].map(p => p * MMHG_PA);
    const seedStressed = V0.map((_, i) => (initialPressure[i]! - EXTERNAL_PA[i]!) * CDIA[i]!);
    const seedScale = (config.initialBloodVolumeM3 - sum(V0)) / sum(seedStressed);
    const volumes = V0.map((v, i) => v + seedScale * seedStressed[i]!);
    volumes[2] = volumes[2]! + config.initialBloodVolumeM3 - sum(volumes);
    this.state = { time: 0, steps: 0, volumes, flows: new Array<number>(6).fill(0), mask: 0, transferred: 0 };
    const end = config.warmupCycles * 60 / config.heartRateBpm;
    while (this.state.time < end - 1e-12) this.state = this.advance(this.state, Math.min(config.fixedDtSeconds, end - this.state.time));
    this.state = { ...this.state, time: 0, steps: 0 };
  }
  private advance(old: CVState, dt: number, exchange?: CardiovascularExchange): CVState {
    const rhsVolumes = [...old.volumes];
    let transferred = old.transferred;
    if (exchange) {
      if (!["systemicArtery", "systemicVein"].includes(exchange.source) || !["systemicVein", "rv"].includes(exchange.returnTo) ||
        ![exchange.toLocalM3, exchange.fromLocalM3].every(Number.isFinite))
        throw new RangeError("Invalid conservative cardiovascular exchange");
      const source = CV_COMPARTMENTS.indexOf(exchange.source), destination = CV_COMPARTMENTS.indexOf(exchange.returnTo);
      rhsVolumes[source] = rhsVolumes[source]! - exchange.toLocalM3;
      rhsVolumes[destination] = rhsVolumes[destination]! + exchange.fromLocalM3;
      // Aggregate both ports before checking donor inventory: source and
      // destination can coincide. Reverse flow withdraws from the return
      // compartment; source refunds and distal returns add to their recipient.
      if (rhsVolumes.some((v, i) => !Number.isFinite(v) || v < V0[i]! - 1e-15))
        throw new RangeError("Signed local transfer exceeds the positive-transmural-pressure donor inventory");
      transferred += exchange.toLocalM3 - exchange.fromLocalM3;
    }
    const time = old.time + dt, e = cardiovascularElastance(time, this.config), b = e.map((v, i) => EXTERNAL_PA[i]! - v * V0[i]!);
    // Most steps retain the previous valve set. Trying the remaining 15 sets
    // guarantees a complementarity solution without a potentially cycling
    // heuristic valve iteration; no pressure clipping or volume correction.
    for (let attempt = 0; attempt < 16; attempt++) {
      const mask = attempt === 0 ? old.mask : (old.mask + attempt) % 16;
      const matrix = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => Number(i === j)));
      const rhs = [...rhsVolumes];
      for (let k = 0; k < EDGES.length; k++) {
        const edge = EDGES[k]!;
        if (edge.bit >= 0 && !(mask & (1 << edge.bit))) continue;
        const scale = k === 1 ? this.config.systemicResistanceScale : 1, factor = dt / (edge.resistance * scale);
        const i = edge.from, j = edge.to, offset = factor * (b[i]! - b[j]!);
        matrix[i]![i] = matrix[i]![i]! + factor * e[i]!; matrix[i]![j] = matrix[i]![j]! - factor * e[j]!;
        matrix[j]![i] = matrix[j]![i]! - factor * e[i]!; matrix[j]![j] = matrix[j]![j]! + factor * e[j]!;
        rhs[i] = rhs[i]! - offset; rhs[j] = rhs[j]! + offset;
      }
      const volumes = solve(matrix, rhs), p = pressures(volumes, e);
      if (!volumes.every((v, i) => Number.isFinite(v) && v >= V0[i]! - 1e-12)) continue;
      const valid = EDGES.every(edge => edge.bit < 0 ||
        (mask & (1 << edge.bit) ? p[edge.from]! - p[edge.to]! >= -1e-7 : p[edge.from]! - p[edge.to]! <= 1e-7));
      if (!valid) continue;
      const flows = EDGES.map((edge, i) => {
        const pressureDrop = p[edge.from]! - p[edge.to]!;
        return (edge.bit < 0 ? pressureDrop : Math.max(0, pressureDrop)) /
          (edge.resistance * (i === 1 ? this.config.systemicResistanceScale : 1));
      });
      const expected = sum(rhsVolumes), residual = sum(volumes) - expected;
      if (Math.abs(residual) > 1e-13 || !p.every(Number.isFinite)) throw new Error("Cardiovascular conservation residual exceeded tolerance");
      return { time, steps: old.steps + 1, volumes, flows, mask, transferred };
    }
    throw new Error("Cardiovascular step has no positive-volume diode-consistent solution");
  }
  private describe(s: CVState): CardiovascularSnapshot {
    const total = sum(s.volumes);
    return { timeSeconds: s.time, stepIndex: s.steps, compartmentVolumesM3: values(s.volumes),
      pressuresPa: values(pressures(s.volumes, cardiovascularElastance(s.time, this.config))),
      availableSourceVolumeM3: { systemicArtery: Math.max(0, s.volumes[1]! - V0[1]!),
        systemicVein: Math.max(0, s.volumes[2]! - V0[2]!), rv: Math.max(0, s.volumes[3]! - V0[3]!) },
      valveFlowsM3S: { aortic: s.flows[0]!, tricuspid: s.flows[2]!, pulmonary: s.flows[3]!, mitral: s.flows[5]! },
      systemicFlowM3S: s.flows[1]!, pulmonaryFlowM3S: s.flows[4]!, circulatingVolumeM3: total,
      netTransferredToLocalM3: s.transferred, volumeErrorM3: total + s.transferred - this.config.initialBloodVolumeM3 };
  }
  snapshot() { return this.describe(this.state); }
  prepareStep(exchange?: CardiovascularExchange) {
    const next = this.advance(this.state, this.config.fixedDtSeconds, exchange), revision = this.revision;
    let consumed = false;
    return { snapshot: this.describe(next), commit: () => {
      if (consumed || revision !== this.revision) throw new Error("Cardiovascular preview is stale or already committed");
      consumed = true; this.state = next; this.revision++;
    } };
  }
  step(count = 1) {
    if (!Number.isInteger(count) || count < 1 || count > 100_000) throw new RangeError("Invalid cardiovascular batch count");
    let next = this.state;
    for (let i = 0; i < count; i++) next = this.advance(next, this.config.fixedDtSeconds);
    this.state = next; this.revision++; return this.snapshot();
  }
  checkpoint(): CardiovascularCheckpoint {
    const token = {} as CardiovascularCheckpoint; this.checkpoints.set(token, clone(this.state)); return token;
  }
  restore(token: CardiovascularCheckpoint) {
    const saved = this.checkpoints.get(token);
    if (!saved) throw new Error("Cardiovascular checkpoint belongs to a different circuit");
    this.state = clone(saved); this.revision++;
  }
}
