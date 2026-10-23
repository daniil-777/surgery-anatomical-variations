/** Isolated synthetic coupon calibration. No existing elasticity weights or
 * routes are changed. Known interface area and calibrated opening are required. */
import { publicUrl } from "../api";
import { COHESIVE_ONSET_RATIO, cohesiveResponse, type CohesiveParameters } from "./cohesive";

export interface CuttingObservation { schema: "viscera.cutting-observation/v1"; opening_mm: number[]; force_n: number[]; area_mm2: number; provenance: string }
type Layer = { weight: number[][]; bias: number[] };
export interface CuttingModel { schema: "viscera.cutting-model/v1"; alpha: number; bounds: number[][]; featurePoints: number; members: Layer[][]; modelId: string; scope: string; evidence: "synthetic_only"; humanLiverValidated: false }
export interface CuttingFractureDiagnostics {
  criticalOpeningMm: number;
  onsetOpeningMm: number;
  specificWorkJm2: number;
  cohesiveLengthScaleMm: number;
}
export interface CuttingCalibration {
  accepted: boolean;
  parameters: CohesiveParameters;
  neuralParameters: CohesiveParameters;
  neuralUncertainty: CohesiveParameters;
  parameterIntervals90: { fractureEnergyJm2: [number, number]; peakTractionPa: [number, number] };
  diagnostics: CuttingFractureDiagnostics;
  residualNrmse: number;
  reasons: string[];
  conditionNumber: number;
  source: "synthetic-trained-coupon-calibration";
  humanLiverValidated: false;
  modelId: string;
  observationProvenance: string;
  scope: string;
}
const BOUNDS = [[2, 80], [4000, 80000]] as const;
const SCHEMA = "viscera.cutting-observation/v1";
const SCOPE = "Synthetic Mode-I coupon inverse model; supplied observations remain unverified; not validated liver cutting.";
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const record = (p: readonly number[]): CohesiveParameters => ({ fractureEnergyJm2: p[0]!, peakTractionPa: p[1]! });
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const maximum = (v: readonly number[]) => v.reduce((a, b) => Math.max(a, b), -Infinity);
export function parseCuttingObservation(value: unknown): CuttingObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a cutting observation JSON object.");
  const o = value as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== ["schema", "opening_mm", "force_n", "area_mm2", "provenance"].sort().join() || o.schema !== SCHEMA) throw new Error("Expected cutting-observation/v1 with opening_mm, force_n, area_mm2 and provenance.");
  const x = o.opening_mm, force = o.force_n;
  if (!Array.isArray(x) || !Array.isArray(force) || x.length < 32 || x.length > 1024 || x.length !== force.length || !x.every(finite) || !force.every(finite)) throw new Error("32–1024 matching finite opening and force samples required.");
  if (!finite(o.area_mm2) || o.area_mm2 <= 0 || o.area_mm2 > 10000) throw new Error("Known positive fracture interface area up to 10000 mm² required.");
  if (typeof o.provenance !== "string" || o.provenance.trim().length < 8 || o.provenance.trim().length > 2000) throw new Error("Describe specimen, force/geometry calibration and fixture in provenance.");
  const xm = maximum(x), scale = maximum(force.map(Math.abs));
  if (x.some(v => v < 0) || xm > 80 || x[0]! > 1e-8 || xm < .02) throw new Error("Opening must start at zero, remain nonnegative and span 0.02–80 mm.");
  if (maximum(force) <= 0 || Math.abs(force[0]!) > Math.max(1e-7, .03 * scale) || force.some(v => v < -.1 * scale)) throw new Error("Tared tensile force in the positive opening convention required.");
  let history = 0;
  for (const v of x) { if (v - history > .08 * xm) throw new Error("Opening samples are too sparse to resolve fracture."); history = Math.max(history, v); }
  return { schema: SCHEMA, opening_mm: [...x], force_n: [...force], area_mm2: o.area_mm2, provenance: o.provenance.trim() };
}

export function parseCuttingModel(value: unknown, modelId: string): CuttingModel {
  if (!value || typeof value !== "object") throw new Error("Invalid cutting model.");
  const m = value as CuttingModel;
  if (m.schema !== "viscera.cutting-model/v1" || m.alpha !== COHESIVE_ONSET_RATIO || JSON.stringify(m.bounds) !== JSON.stringify(BOUNDS) || m.featurePoints !== 65 || m.evidence !== "synthetic_only" || m.humanLiverValidated !== false || typeof m.scope !== "string" || !/^[a-f0-9]{64}$/.test(modelId)) throw new Error("Unsupported cutting model contract.");
  if (!Array.isArray(m.members) || m.members.length < 2 || m.members.length > 4) throw new Error("Invalid cutting ensemble.");
  for (const member of m.members) {
    if (!Array.isArray(member) || member.length !== 3) throw new Error("Invalid cutting architecture.");
    let previous = 132;
    member.forEach((layer, index) => {
      const rows = [96, 48, 2][index]!;
      if (!Array.isArray(layer.weight) || layer.weight.length !== rows || !layer.weight.every(row => Array.isArray(row) && row.length === previous && row.every(finite)) || !Array.isArray(layer.bias) || layer.bias.length !== rows || !layer.bias.every(finite)) throw new Error("Invalid cutting weights.");
      previous = rows;
    });
  }
  return { ...m, modelId };
}
let modelPromise: Promise<CuttingModel> | undefined;
export function loadCuttingModel(): Promise<CuttingModel> {
  modelPromise ??= (async () => {
    const response = await fetch(publicUrl("models/cutting-v1/model.json"));
    if (!response.ok) throw new Error("The cutting calibration model is unavailable. Manual parameters remain available.");
    const raw = await response.text();
    if (raw.length > 5_000_000) throw new Error("Cutting model exceeds its size limit.");
    const envelope = JSON.parse(raw) as { sha256: string; payload: string };
    if (typeof envelope.payload !== "string" || typeof envelope.sha256 !== "string") throw new Error("Invalid cutting model envelope.");
    if (!globalThis.crypto?.subtle) throw new Error("Model integrity verification requires HTTPS or localhost.");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(envelope.payload));
    const hash = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, "0")).join("");
    if (hash !== envelope.sha256) throw new Error("Cutting model checksum mismatch.");
    return parseCuttingModel(JSON.parse(envelope.payload), hash);
  })().catch(error => { modelPromise = undefined; throw error; });
  return modelPromise;
}

function decode(z: readonly number[]): number[] { return BOUNDS.map(([a, b], i) => clamp(a * Math.exp(clamp(z[i]!, 0, 1) * Math.log(b / a)), a, b)); }
function encode(p: readonly number[]): number[] { return BOUNDS.map(([a, b], i) => Math.log(p[i]! / a) / Math.log(b / a)); }
function response(x: readonly number[], p: readonly number[]): number[] {
  const df = 2 * p[0]! / p[1]!, d0 = COHESIVE_ONSET_RATIO * df;
  let history = 0;
  return x.map(v => { history = Math.max(history, v); const damage = history <= d0 ? 0 : Math.min(1, df * (history - d0) / (history * (df - d0))); return p[1]! / d0 * v * (1 - damage); });
}
function proposal(model: CuttingModel, x: readonly number[], stress: readonly number[]): { mean: number[]; std: number[] } {
  const xm = maximum(x), sm = Math.max(maximum(stress.map(Math.abs)), 1e-9);
  const interpolate = (values: readonly number[], scale: number) => Array.from({ length: 65 }, (_, i) => { const at = i / 64 * (values.length - 1), k = Math.floor(at), t = at - k; return (values[k]! * (1 - t) + values[Math.min(k + 1, values.length - 1)]! * t) / scale; });
  const feature = [...interpolate(x, xm), ...interpolate(stress, sm), Math.log(xm / .005), Math.log(sm / 16000)];
  const mean = [0, 0], members: number[][] = [];
  for (const member of model.members) {
    let h = feature;
    member.forEach((layer, i) => { h = layer.weight.map((row, j) => { const v = row.reduce((sum, w, k) => sum + w * h[k]!, layer.bias[j]!); return i < member.length - 1 ? Math.max(0, v) : 1 / (1 + Math.exp(-clamp(v, -60, 60))); }); });
    const p = decode(h); members.push(p); mean[0]! += p[0]! / model.members.length; mean[1]! += p[1]! / model.members.length;
  }
  const std = [0, 1].map(k => Math.sqrt(members.reduce((sum, p) => sum + (p[k]! - mean[k]!) ** 2, 0) / members.length));
  return { mean, std };
}
function refine(x: readonly number[], stress: readonly number[], initial: readonly number[]) {
  const low = Math.log(2 * BOUNDS[0][0] / BOUNDS[1][1]), high = Math.log(2 * BOUNDS[0][1] / BOUNDS[1][0]), scale = Math.max(maximum(stress.map(Math.abs)), 1e-9);
  const objective = (z: number) => {
    const df = Math.exp(z), q = response(x, [df / 2, 1]);
    let numerator = 0, denominator = 0;
    q.forEach((v, i) => { numerator += v * stress[i]!; denominator += v * v; });
    const peak = clamp(numerator / Math.max(denominator, 1e-30), Math.max(BOUNDS[1][0], 2 * BOUNDS[0][0] / df), Math.min(BOUNDS[1][1], 2 * BOUNDS[0][1] / df));
    const error = q.reduce((sum, v, i) => sum + ((peak * v - stress[i]!) / scale) ** 2, 0) / q.length;
    return { error, p: [peak * df / 2, peak] };
  };
  const grid = [...new Set([...Array.from({ length: 129 }, (_, i) => low + (high - low) * i / 128), clamp(Math.log(2 * initial[0]! / initial[1]!), low, high)])].sort((a, b) => a - b);
  const values = grid.map(objective); let best = values.reduce((a, b) => a.error < b.error ? a : b);
  const golden = (Math.sqrt(5) - 1) / 2;
  for (let i = 1; i < grid.length - 1; i++) {
    if (values[i]!.error > values[i - 1]!.error || values[i]!.error > values[i + 1]!.error) continue;
    let a = grid[i - 1]!, b = grid[i + 1]!, c = b - golden * (b - a), d = a + golden * (b - a), fc = objective(c), fd = objective(d);
    for (let j = 0; j < 45; j++) {
      if (fc.error < fd.error) { b = d; d = c; fd = fc; c = b - golden * (b - a); fc = objective(c); }
      else { a = c; c = d; fc = fd; d = a + golden * (b - a); fd = objective(d); }
    }
    if (fc.error < best.error) best = fc; if (fd.error < best.error) best = fd;
  }
  return { p: best.p.map((v, i) => clamp(v, BOUNDS[i]![0], BOUNDS[i]![1])), residual: Math.sqrt(best.error) };
}

export function inferCuttingObservation(model: CuttingModel, supplied: CuttingObservation): CuttingCalibration {
  const o = parseCuttingObservation(supplied), x = o.opening_mm.map(v => v * .001), stress = o.force_n.map(v => v / (o.area_mm2 * 1e-6));
  const { mean: initial, std: uncertainty } = proposal(model, x, stress), fit = refine(x, stress, initial), p = fit.p, df = 2 * p[0]! / p[1]!, d0 = COHESIVE_ONSET_RATIO * df;
  const reasons: string[] = [], scale = Math.max(maximum(stress.map(Math.abs)), 1e-9), z = encode(p);
  if (fit.residual > .05) reasons.push("force_response_not_reproduced");
  if (maximum(x) < 1.05 * df || x.filter(v => v >= df).length < 3) reasons.push("complete_fracture_not_observed");
  let history = 0, before = 0, after = 0;
  x.forEach(v => { history = Math.max(history, v); if (v >= history - 1e-12) { if (v > .1 * d0 && v < d0) before++; if (v > d0 && v < .95 * df) after++; } });
  if (before < 3 || after < 6) reasons.push("traction_peak_or_softening_insufficiently_sampled");
  if (z.some(v => v < .005 || v > .995)) reasons.push("parameter_at_training_bound");
  const jac = z.map((_, i) => { const lo = [...z], hi = [...z]; lo[i]! -= 1e-4; hi[i]! += 1e-4; const a = response(x, decode(lo)), b = response(x, decode(hi)); return a.map((v, j) => (b[j]! - v) / (.0002 * scale)); });
  let aa = 0, bb = 0, ab = 0; jac[0]!.forEach((v, i) => { aa += v * v; bb += jac[1]![i]! ** 2; ab += v * jac[1]![i]!; });
  const discriminant = Math.hypot(aa - bb, 2 * ab), eigenMax = Math.max(0, (aa + bb + discriminant) / 2), eigenMin = Math.max(0, (aa + bb - discriminant) / 2), smallest = Math.sqrt(eigenMin), conditionNumber = Math.sqrt(eigenMax) / Math.max(smallest, 1e-15);
  if (conditionNumber > 100 || smallest < .1) reasons.push("parameters_not_identifiable");
  const tail = stress.filter((_, i) => x[i]! >= df * 1.05);
  if (tail.length && Math.sqrt(tail.reduce((sum, v) => sum + v * v, 0) / tail.length) / scale > .05) reasons.push("post_fracture_force_not_zero");
  const dof = Math.max(1, x.length - 2), sigma2 = Math.max(fit.residual ** 2, 2.5e-5) * x.length / dof;
  const f00 = aa + 1e-12, f11 = bb + 1e-12, det = Math.max(f00 * f11 - ab * ab, 1e-30);
  const halfZ0 = 1.6448536269514722 * Math.sqrt(Math.max(0, sigma2 * f11 / det));
  const halfZ1 = 1.6448536269514722 * Math.sqrt(Math.max(0, sigma2 * f00 / det));
  const lowP = decode([z[0]! - halfZ0, z[1]! - halfZ1]), highP = decode([z[0]! + halfZ0, z[1]! + halfZ1]);
  let specificWorkJm2 = 0;
  for (let i = 0; i + 1 < x.length; i++) specificWorkJm2 += .5 * (stress[i + 1]! + stress[i]!) * (x[i + 1]! - x[i]!);
  return {
    accepted: !reasons.length, reasons, parameters: record(p), neuralParameters: record(initial), neuralUncertainty: record(uncertainty),
    parameterIntervals90: { fractureEnergyJm2: [lowP[0]!, highP[0]!], peakTractionPa: [lowP[1]!, highP[1]!] },
    diagnostics: { criticalOpeningMm: df * 1000, onsetOpeningMm: d0 * 1000, specificWorkJm2, cohesiveLengthScaleMm: 6000 * p[0]! / (p[1]! ** 2) * 1000 },
    residualNrmse: fit.residual, conditionNumber, source: "synthetic-trained-coupon-calibration", humanLiverValidated: false, modelId: model.modelId, observationProvenance: o.provenance, scope: SCOPE,
  };
}
export function createSyntheticCuttingObservation(): CuttingObservation {
  const p = { fractureEnergyJm2: 20, peakTractionPa: 16000 }, df = 2 * p.fractureEnergyJm2 / p.peakTractionPa;
  const x = Array.from({ length: 161 }, (_, i) => 1.3 * df * i / 160);
  return { schema: SCHEMA, opening_mm: x.map(v => v * 1000), force_n: x.map(v => cohesiveResponse(v, 0, p).tractionPa * 25e-6), area_mm2: 25, provenance: "Synthetic complete Mode-I coupon; known area; no liver measurement" };
}
