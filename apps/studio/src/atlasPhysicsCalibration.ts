/** Calibrating the learned liver material from a force–displacement measurement, in the browser: what POST
 *  /api/physics/infer and POST /api/physics/playground (parameter_source "learned" with an observation) compute,
 *  repeated in TypeScript for the public copy, which has no API.
 *
 *  The API routes an observation to viscera_core.physics_learning_v2.infer_observation (the model the manifest of
 *  artifacts/physics/liver-network-v2 names; the optional research application policy is off by default and its
 *  shipped candidate failed evaluation, so it is not served): the request model's checks (pydantic, strict, finite),
 *  calibrated strain = displacement / reference length and stress = force / reference area; validate_history; 81-point
 *  features (strain and stress resampled on normalised time by np.interp, divided by their peaks, plus three log
 *  scales); three ReLU MLP members (165-160-96-3, sigmoid outputs) decoded to (E, g, tau) and averaged; scipy's
 *  bounded least squares (method trf, soft_l1 loss with f_scale 0.02, at most 70 evaluations) of the exact
 *  piecewise-linear SLS convolution against the measured stress, warm-started from that mean in the encoded [0, 1]^3
 *  box; a central-difference sensitivity matrix (its SVD and pseudo-inverse give the condition number and the
 *  split-conformal 90 % intervals); and the excitation/fit diagnostics that set accepted_for_application. The
 *  playground route then refuses an estimate that is not accepted ("Physics calibration needs review: …"), merges it
 *  into the default material and binds it to the unchanged cage.
 *
 *  Weights come from public/models/physics-v2 (scripts/export_physics_web.py): float32-exact values, promoted to the
 *  float64 numpy computes in. Arithmetic is float64 in numpy's operation order wherever numpy fixes one — np.sum's
 *  pairwise summation, mean/std over the members, np.median, linspace, and np.interp with the fused multiply-add
 *  the API's arm64 numpy compiles it to. What cannot be repeated to the bit is the BLAS/LAPACK arithmetic (Accelerate's
 *  dot-product order in the MLP and the convolution, gesdd's SVD) and libm's exp/expm1/log, which differ from V8's
 *  in the last bit for a few percent of arguments. Results therefore agree to rounding — where a fit stops on its
 *  tolerance with sizeable residuals (noise, model mismatch), to the 1e-9…1e-8 by which the API's own answer moves
 *  under such last-bit changes — and the solver takes scipy's decisions unless one of its tests falls within rounding
 *  of its threshold (it did for all 36 calibrations of atlasPhysicsCalibration.test.ts, which replays the API's
 *  responses to 66 observations and compares with the running API). */
import { publicUrl } from "./api";
import type { PhysicsObservation, PhysicsParameters } from "./atlasPhysics";
import { fma } from "./fusedMultiplyAdd";
import { leastSquaresTrf, pairwiseSum, type TrfResult } from "./trustRegionReflective";

export const PHYSICS_WEB_FORMAT = "viscera-physics-inverse-v2-web";
export const PHYSICS_MODEL_VERSION = "liver-inverse-sls-2.0.0";
export const PHYSICS_PREPROCESSING_VERSION = "calibrated-strain-stress-time-81-v1";
export const PHYSICS_PLAYGROUND_SCHEMA = "liver-physics-playground-1.0.0";
export const CALIBRATION_PARAMETERS = ["young_pa", "relaxation_fraction", "relaxation_time_s"] as const;
export type CalibrationParameter = typeof CALIBRATION_PARAMETERS[number];
type ParameterRecord<T> = Record<CalibrationParameter, T>;

// physics_learning_v2's literals (refine_parameters, diagnostics, validate_history) and the route's gate
const REFINEMENT = { lower: 0, upper: 1, loss: "soft_l1", fScale: 0.02, maxNfev: 70, ftol: 1e-8, xtol: 1e-8, gtol: 1e-8 } as const;
const INITIAL_CLIP = 1e-6, SENSITIVITY_STEP = 1e-4, NOISE_FLOOR = 0.002, MAD_SCALE = 0.67448975, PINV_RCOND = 1e-12;
const SIGMA_FLOOR = [0.006, 0.006, 0.008];
const FIT_GATE = 0.05, CONDITION_LIMIT = 2500, SENSITIVITY_LIMIT = 0.015, VARIATION_LIMIT = 1.3, RATE_LIMIT = 0.4, BOUND_MARGIN = 0.002;
const EPS = 2.220446049250313e-16;

// ---------------------------------------------------------------------------------------------- the model
interface ArrayEntry { shape: number[]; offset: number }
export interface PhysicsModelMeta {
  format: string; version: string; preprocessing_version: string; model_sha256: string; model_source: string;
  parameter_names: string[]; bounds: number[][];
  /** encode/decode_parameters' constants as numpy computed them: log-scaled E and tau, np.diff spans */
  encoding: { low: number[]; high: number[]; span: number[]; log_scaled: boolean[] };
  feature_points: number; calibration: { quantiles_90: number[]; [key: string]: unknown };
  members: { weight: ArrayEntry; bias: ArrayEntry }[][]; dtype: string; byte_length: number; weights_sha256: string;
  calibration_contract: Record<string, unknown>; scope: string;
  /** the constant text of a v2 result, taken from the API's function by the exporter */
  result_text: { version: string; scope: string; estimator: string; uncertainty_scope: string; stress_nrmse_definition: string; fixed_or_unidentified: string[]; ood_scope: string };
  defaults: PhysicsParameters;
  parameter_fields: Record<string, { ge?: number; le?: number; gt?: number; lt?: number }>;
  application_policy: null; evaluation: Record<string, unknown>; port_sources: Record<string, string>;
  exported_with: { numpy: string; scipy: string; system: string; machine: string };
}
interface Layer { rows: number; cols: number; weight: Float64Array; bias: Float64Array }
export interface PhysicsModel { meta: PhysicsModelMeta; members: Layer[][] }

export function parsePhysicsModel(meta: PhysicsModelMeta, weights: ArrayBuffer): PhysicsModel {
  if (meta.format !== PHYSICS_WEB_FORMAT || meta.version !== PHYSICS_MODEL_VERSION || meta.preprocessing_version !== PHYSICS_PREPROCESSING_VERSION ||
      meta.parameter_names.join() !== CALIBRATION_PARAMETERS.join() || meta.dtype !== "<f4") throw new Error("Unsupported physics model export.");
  // the API serves the optional research policy only when it passes its evaluation; this port covers v2 without it
  if (meta.application_policy !== null) throw new Error("The bundled physics model requires an application policy this copy does not implement.");
  if (weights.byteLength !== meta.byte_length) throw new Error("The physics model weights do not match their layout.");
  const quantiles = meta.calibration?.quantiles_90;
  if (!Array.isArray(quantiles) || quantiles.length !== 3 || !quantiles.every((q) => Number.isFinite(q) && q > 0)) throw new Error("Missing v2 uncertainty calibration");
  if (meta.members.length < 2 || meta.members.length > 8) throw new Error("Invalid v2 ensemble");
  const read = ({ shape, offset }: ArrayEntry): Float64Array => {
    const count = shape.reduce((a, b) => a * b, 1);
    if (offset % 4 !== 0 || offset + count * 4 > weights.byteLength) throw new Error("Invalid physics network weights");
    const values = Float64Array.from(new Float32Array(weights, offset, count));   // float32-exact: promotion is exact
    if (!values.every(Number.isFinite)) throw new Error("Invalid physics network weights");
    return values;
  };
  const members = meta.members.map((member) => {
    let previous = meta.feature_points * 2 + 3;
    const layers = member.map(({ weight, bias }) => {
      if (weight.shape.length !== 2 || weight.shape[1] !== previous || bias.shape.length !== 1 || bias.shape[0] !== weight.shape[0]) throw new Error("Invalid physics network weights");
      previous = weight.shape[0]!;
      return { rows: weight.shape[0]!, cols: weight.shape[1]!, weight: read(weight), bias: read(bias) };
    });
    if (previous !== 3) throw new Error("Invalid physics output size");
    return layers;
  });
  return { meta, members };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;   // an insecure context has no digest: the byte length and finiteness checks remain
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

let cachedModel: Promise<PhysicsModel> | null = null;
/** The bundled physics network (5 KB of layout and 508 KB of weights), fetched once and shared; the download takes no
 *  caller's AbortSignal, so one closed dialog cannot cancel it for the next. */
export function loadPhysicsModel(): Promise<PhysicsModel> {
  cachedModel ??= Promise.all([
    fetch(publicUrl("models/physics-v2/model.json"), { cache: "default" }).then(async (response) => {
      if (!response.ok) throw new Error("The physics calibration network is not bundled with this copy.");
      return await response.json() as PhysicsModelMeta;
    }),
    fetch(publicUrl("models/physics-v2/weights.bin"), { cache: "default" }).then(async (response) => {
      if (!response.ok) throw new Error("The physics calibration weights are not bundled with this copy.");
      return await response.arrayBuffer();
    }),
  ]).then(async ([meta, weights]) => {
    const model = parsePhysicsModel(meta, weights);
    const digest = await sha256Hex(weights);
    if (digest !== null && digest !== meta.weights_sha256) throw new Error("Physics v2 network checksum mismatch");
    return model;
  }).catch((error) => { cachedModel = null; throw error; });
  return cachedModel;
}
/** Tests and tools that hold the model already (read from disk) hand it over instead of fetching. */
export function primePhysicsModel(model: PhysicsModel): void { cachedModel = Promise.resolve(model); }

// ---------------------------------------------------------------------------------------------- errors
export interface PhysicsValidationIssue { type: string; loc: (string | number)[]; msg: string; input: unknown; ctx?: Record<string, unknown> }
/** What the API answers instead of a result: `status` is its HTTP status, `detail` its JSON detail (a message, or
 *  pydantic's list of issues), and the message is what the studio shows for that answer (atlasError: the detail,
 *  or the issues' messages joined by "; "). */
export class PhysicsCalibrationError extends Error {
  readonly status: number;
  readonly detail: string | PhysicsValidationIssue[];
  constructor(status: number, detail: string | PhysicsValidationIssue[]) {
    super(status === 500 ? "Request failed (500)." : typeof detail === "string" ? detail : detail.map((issue) => issue.msg).join("; "));
    this.name = "PhysicsCalibrationError";
    this.status = status;
    this.detail = detail;
  }
}
const refuse = (message: string) => new PhysicsCalibrationError(422, message);

// ---------------------------------------------------------------------------------------------- the request model
const LIST_FIELDS = ["times_s", "force_n", "displacement_mm"] as const;
const FIELDS: readonly string[] = [...LIST_FIELDS, "reference_length_mm", "reference_area_mm2", "provenance"];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A JSON number (strict float accepts int and float, never bool or str); a non-finite one cannot be sent as JSON. */
const isJsonFloat = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const codePoints = (text: string): number => { let count = 0; for (const _ of text) count++; return count; };
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The value as the API receives it from the studio's JSON.stringify: NaN and ±Infinity become null, undefined
 *  members vanish, −0 becomes 0. */
const asSent = (value: unknown): unknown => (value === undefined ? null : JSON.parse(JSON.stringify(value)) as unknown);

/** services.api.physics.ObservationRequest (extra forbidden, strict, finite) on a request as the API receives it:
 *  pydantic's issues as FastAPI reports them (type, loc, msg, input, ctx), in pydantic's order — each field in
 *  declaration order (a list longer than 257 fails on length alone; otherwise its items, then its minimum length),
 *  then every extra key. `loc` is where the route nests the observation. */
export function observationRequestIssues(value: unknown, loc: (string | number)[] = ["body"]): PhysicsValidationIssue[] {
  if (value === null || value === undefined) return [{ type: "missing", loc, msg: "Field required", input: null }];
  if (!isObject(value)) return [{ type: "model_attributes_type", loc, msg: "Input should be a valid dictionary or object to extract fields from", input: value }];
  const issues: PhysicsValidationIssue[] = [];
  const present = (key: string) => Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
  const missing = (key: string): PhysicsValidationIssue => ({ type: "missing", loc: [...loc, key], msg: "Field required", input: value });
  for (const key of LIST_FIELDS) {
    const at = [...loc, key];
    if (!present(key)) { issues.push(missing(key)); continue; }
    const list = value[key];
    if (!Array.isArray(list)) { issues.push({ type: "list_type", loc: at, msg: "Input should be a valid list", input: list }); continue; }
    if (list.length > 257) { issues.push({ type: "too_long", loc: at, msg: `List should have at most 257 items after validation, not ${list.length}`, input: list, ctx: { field_type: "List", max_length: 257, actual_length: list.length } }); continue; }
    const items: PhysicsValidationIssue[] = [];
    for (let i = 0; i < list.length; i++) if (!isJsonFloat(list[i])) items.push({ type: "float_type", loc: [...at, i], msg: "Input should be a valid number", input: list[i] ?? null });
    if (items.length) issues.push(...items);
    else if (list.length < 16) issues.push({ type: "too_short", loc: at, msg: `List should have at least 16 items after validation, not ${list.length}`, input: list, ctx: { field_type: "List", min_length: 16, actual_length: list.length } });
  }
  for (const [key, limit] of [["reference_length_mm", 1000], ["reference_area_mm2", 1e6]] as const) {
    const at = [...loc, key], number = value[key];
    if (!present(key)) issues.push(missing(key));
    else if (!isJsonFloat(number)) issues.push({ type: "float_type", loc: at, msg: "Input should be a valid number", input: number });
    else if (!(number > 0)) issues.push({ type: "greater_than", loc: at, msg: "Input should be greater than 0", input: number, ctx: { gt: 0 } });
    else if (!(number <= limit)) issues.push({ type: "less_than_equal", loc: at, msg: `Input should be less than or equal to ${limit}`, input: number, ctx: { le: limit } });
  }
  const provenance = value.provenance, at = [...loc, "provenance"];
  if (!present("provenance")) issues.push(missing("provenance"));
  else if (typeof provenance !== "string") issues.push({ type: "string_type", loc: at, msg: "Input should be a valid string", input: provenance });
  else if (LONE_SURROGATE.test(provenance)) issues.push({ type: "string_unicode", loc: at, msg: "Input should be a valid string, unable to parse raw data as a unicode string", input: provenance });
  else if (codePoints(provenance) < 8) issues.push({ type: "string_too_short", loc: at, msg: "String should have at least 8 characters", input: provenance, ctx: { min_length: 8 } });
  else if (codePoints(provenance) > 2000) issues.push({ type: "string_too_long", loc: at, msg: "String should have at most 2000 characters", input: provenance, ctx: { max_length: 2000 } });
  for (const key of Object.keys(value)) if (!FIELDS.includes(key) && value[key] !== undefined) {
    if (LONE_SURROGATE.test(key)) issues.push({ type: "string_unicode", loc, msg: "Input should be a valid string, unable to parse raw data as a unicode string", input: key });
    else issues.push({ type: "extra_forbidden", loc: [...loc, key], msg: "Extra inputs are not permitted", input: value[key] });
  }
  return issues;
}

/** The request as the route hands it on: malformed observations produce 422 with pydantic's issues,
 * including invalid Unicode. The API escapes rejected input in its JSON response. */
function checkedRequest(value: unknown, loc: (string | number)[]): PhysicsObservation {
  const sent = asSent(value);
  const issues = observationRequestIssues(sent, loc);
  if (issues.length) throw new PhysicsCalibrationError(422, issues);
  return sent as PhysicsObservation;
}

/** Python's str.strip(): the characters str.isspace() accepts (all in the BMP). */
const PYTHON_WHITESPACE = new Set([0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
export function pythonStrip(text: string): string {
  let start = 0, end = text.length;
  while (start < end && PYTHON_WHITESPACE.has(text.charCodeAt(start))) start++;
  while (end > start && PYTHON_WHITESPACE.has(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

// ---------------------------------------------------------------------------------------------- numpy arithmetic
const clip = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);
const maxAbs = (a: ArrayLike<number>): number => { let worst = -Infinity; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]!)); return worst; };
const maxOf = (a: ArrayLike<number>): number => { let worst = -Infinity; for (let i = 0; i < a.length; i++) worst = Math.max(worst, a[i]!); return worst; };
const minOf = (a: ArrayLike<number>): number => { let best = Infinity; for (let i = 0; i < a.length; i++) best = Math.min(best, a[i]!); return best; };
const diff = (a: ArrayLike<number>): Float64Array => { const out = new Float64Array(Math.max(a.length - 1, 0)); for (let i = 0; i < out.length; i++) out[i] = a[i + 1]! - a[i]!; return out; };

/** np.linspace(0, stop, num): i · (stop / (num − 1)) + 0, the last sample exactly stop. */
function linspaceFromZero(stop: number, num: number): Float64Array {
  const out = new Float64Array(num), step = stop / (num - 1);
  for (let i = 0; i < num; i++) out[i] = i * step + 0;
  out[num - 1] = stop;
  return out;
}

/** np.interp(x, xp, fp) for strictly increasing xp: the last xp[j] ≤ x, fp at an exact or final sample, else
 *  slope·(x − xp[j]) + fp[j] with the slope (fp[j+1] − fp[j]) / (xp[j+1] − xp[j]) — one fused multiply-add, as the
 *  API's arm64 numpy compiles it (verified bitwise; an x86-64 build without FMA rounds twice, within one ulp). */
function interp(x: Float64Array, xp: Float64Array, fp: Float64Array): Float64Array {
  const n = xp.length, out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const value = x[i]!;
    if (Number.isNaN(value)) { out[i] = value; continue; }
    if (value > xp[n - 1]!) { out[i] = fp[n - 1]!; continue; }
    if (value < xp[0]!) { out[i] = fp[0]!; continue; }
    let low = 0, high = n;   // bisection for the last index with xp[j] <= value
    while (low < high) { const mid = low + ((high - low) >> 1); if (value >= xp[mid]!) low = mid + 1; else high = mid; }
    const j = low - 1;
    if (j === n - 1 || xp[j] === value) { out[i] = fp[j]!; continue; }
    const slope = (fp[j + 1]! - fp[j]!) / (xp[j + 1]! - xp[j]!);
    let result = fma(slope, value - xp[j]!, fp[j]!);
    if (Number.isNaN(result)) {
      result = fma(slope, value - xp[j + 1]!, fp[j + 1]!);
      if (Number.isNaN(result) && fp[j] === fp[j + 1]) result = fp[j]!;
    }
    out[i] = result;
  }
  return out;
}

/** np.median: the middle sample, or the mean of the middle two ((a + b) / 2). */
function median(values: ArrayLike<number>): number {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length, half = n >> 1;
  return n % 2 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
}

/** Singular values (descending) of a row-major rows × cols matrix, by one-sided Jacobi rotations; numpy's gesdd is
 *  accurate to ~eps·‖A‖ absolutely, these to the same or better, so ill-conditioned matrices differ there. */
function singularValues(data: Float64Array, rows: number, cols: number): number[] {
  const w = Float64Array.from(data);
  for (let sweep = 0; sweep < 60; sweep++) {
    let rotated = false;
    for (let i = 0; i < cols - 1; i++) for (let j = i + 1; j < cols; j++) {
      let alpha = 0, beta = 0, gamma = 0;
      for (let k = 0; k < rows; k++) { const wi = w[k * cols + i]!, wj = w[k * cols + j]!; alpha += wi * wi; beta += wj * wj; gamma += wi * wj; }
      if (gamma === 0 || Math.abs(gamma) <= EPS * Math.sqrt(alpha * beta)) continue;
      rotated = true;
      const zeta = (beta - alpha) / (2 * gamma);
      const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
      const c = 1 / Math.sqrt(1 + t * t), s = c * t;
      for (let k = 0; k < rows; k++) { const wi = w[k * cols + i]!, wj = w[k * cols + j]!; w[k * cols + i] = c * wi - s * wj; w[k * cols + j] = s * wi + c * wj; }
    }
    if (!rotated) break;
  }
  const lengths: number[] = [];
  for (let j = 0; j < cols; j++) { let sum = 0; for (let k = 0; k < rows; k++) sum += w[k * cols + j]! ** 2; lengths.push(Math.sqrt(sum)); }
  return lengths.sort((a, b) => b - a);
}

/** diag(np.linalg.pinv(A, rcond)) for a symmetric 3 × 3 A (here JᵀJ): its SVD is its eigen-decomposition with
 *  |λ| as singular values, so Σ_k V[i,k]² / λ_k over |λ_k| > rcond · max|λ| (cyclic Jacobi rotations). */
function pinvDiagonalSymmetric(input: number[][], rcond: number): number[] {
  const n = input.length;
  const a = input.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0, scale = 0;
    for (let p = 0; p < n; p++) for (let q = 0; q < n; q++) { if (p !== q) off += a[p]![q]! ** 2; scale += a[p]![q]! ** 2; }
    if (off === 0 || off <= EPS * EPS * scale * 1e-4) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p]![q]!;
      if (apq === 0) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k]![p]!, akq = a[k]![q]!; a[k]![p] = c * akp - s * akq; a[k]![q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p]![k]!, aqk = a[q]![k]!; a[p]![k] = c * apk - s * aqk; a[q]![k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = v[k]![p]!, vkq = v[k]![q]!; v[k]![p] = c * vkp - s * vkq; v[k]![q] = s * vkp + c * vkq; }
    }
  }
  const values = a.map((row, k) => row[k]!);
  const cutoff = rcond * Math.max(...values.map(Math.abs));
  return Array.from({ length: n }, (_, i) => {
    let sum = 0;
    for (let k = 0; k < n; k++) if (Math.abs(values[k]!) > cutoff) sum += v[i]![k]! ** 2 / values[k]!;
    return sum;
  });
}

// ---------------------------------------------------------------------------------------------- physics_learning_v2
/** decode_parameters: clip to [0, 1], scale onto the (log-)bounds, exp for E and tau, clip to the bounds. */
export function decodeParameters(meta: PhysicsModelMeta, encoded: ArrayLike<number>): Float64Array {
  const { low, span, log_scaled: logScaled } = meta.encoding;
  return Float64Array.from({ length: 3 }, (_, k) => {
    let value = clip(encoded[k]!, 0, 1) * span[k]! + low[k]!;
    if (logScaled[k]) value = Math.exp(value);
    return clip(value, meta.bounds[k]![0]!, meta.bounds[k]![1]!);
  });
}
/** encode_parameters: (log E, g, log tau) onto [0, 1] by the training bounds. */
export function encodeParameters(meta: PhysicsModelMeta, parameters: ArrayLike<number>): Float64Array {
  const { low, span, log_scaled: logScaled } = meta.encoding;
  return Float64Array.from({ length: 3 }, (_, k) => ((logScaled[k] ? Math.log(parameters[k]!) : parameters[k]!) - low[k]!) / span[k]!);
}

/** stress_response: the exact piecewise-linear-strain SLS convolution from a zero state, in Pa. The kernel row of
 *  sample i is exp(−max(t_i − t_{j+1}, 0) / tau) where t_i − t_{j+1} ≥ −1e-12 and zero after it; numpy's
 *  matrix–vector product adds the zeros, here they are skipped (t increases strictly). */
export function stressResponse(t: ArrayLike<number>, e: ArrayLike<number>, young: number, g: number, tau: number): Float64Array {
  const n = t.length, rate = new Float64Array(n - 1);
  for (let j = 0; j < n - 1; j++) { const dt = t[j + 1]! - t[j]!; rate[j] = tau * -Math.expm1(-dt / tau) * (e[j + 1]! - e[j]!) / dt; }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let h = 0;
    for (let j = 0; j < n - 1; j++) {
      const lag = t[i]! - t[j + 1]!;
      if (!(lag >= -1e-12)) break;
      h += Math.exp(-Math.max(lag, 0) / tau) * rate[j]!;
    }
    out[i] = young * ((1 - g) * e[i]! + g * h);
  }
  return out;
}

/** validate_history's checks, in its order and with its messages. */
export function validateHistory(t: ArrayLike<number>, e: ArrayLike<number>, s: ArrayLike<number>): void {
  const n = t.length;
  if (n < 16 || n > 257 || e.length !== n || s.length !== n) throw refuse("V2 requires 16–257 matching time, displacement and force observations");
  const finite = (a: ArrayLike<number>) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return false; return true; };
  const steps = diff(t);
  if (!finite(t) || !finite(e) || !finite(s) || Math.abs(t[0]!) > 1e-9 || steps.some((dt) => dt <= 0)) throw refuse("Finite observations must begin at time zero and increase strictly");
  if (!(1 <= t[n - 1]! && t[n - 1]! <= 12)) throw refuse("V2 calibrated duration is 1–12 seconds");
  const amplitude = maxAbs(e);
  if (!(0.005 <= amplitude && amplitude <= 0.050001) || Math.abs(e[0]!) > 2e-5) throw refuse("V2 requires zero initial strain and peak calibrated strain of 0.5–5%");
  if (minOf(e) < -0.001 || maxOf(e) <= 0 || maxOf(s) <= 0) throw refuse("Use the positive calibrated uniaxial loading convention");
  if (Math.abs(s[0]!) > Math.max(0.1, 0.05 * maxAbs(s))) throw refuse("Force must be tared before loading");
  if (maxOf(steps) > 0.2 * t[n - 1]!) throw refuse("Observation time gaps are too large for calibrated inference");
}

/** observation_features: strain and stress on 81 normalised-time samples over their peaks, then log(peak strain /
 *  2.5 %), log(peak stress / peak strain / 5000 Pa) and log(duration / 6 s). */
export function observationFeatures(meta: PhysicsModelMeta, t: Float64Array, e: Float64Array, s: Float64Array): Float64Array {
  validateHistory(t, e, s);
  const points = meta.feature_points, grid = linspaceFromZero(t[t.length - 1]!, points);
  const amplitude = Math.max(maxAbs(e), 1e-8), scale = Math.max(maxAbs(s), 1e-6);
  const strain = interp(grid, t, e), stress = interp(grid, t, s);
  const features = new Float64Array(points * 2 + 3);
  for (let i = 0; i < points; i++) { features[i] = strain[i]! / amplitude; features[points + i] = stress[i]! / scale; }
  features[points * 2] = Math.log(amplitude / 0.025);
  features[points * 2 + 1] = Math.log(scale / amplitude / 5000);
  features[points * 2 + 2] = Math.log(t[t.length - 1]! / 6);
  return features;
}

/** Each member's forward pass (h @ Wᵀ + b, ReLU between layers, a clipped sigmoid at the end): encoded proposals. */
export function memberOutputs(model: PhysicsModel, features: Float64Array): Float64Array[] {
  return model.members.map((member) => {
    let h = features;
    member.forEach((layer, index) => {
      const out = new Float64Array(layer.rows);
      for (let o = 0; o < layer.rows; o++) {
        let sum = 0;
        for (let k = 0; k < layer.cols; k++) sum += h[k]! * layer.weight[o * layer.cols + k]!;
        const value = sum + layer.bias[o]!;
        out[o] = index < member.length - 1 ? Math.max(value, 0) : 1 / (1 + Math.exp(-clip(value, -60, 60)));
      }
      h = out;
    });
    return h;
  });
}

interface Refinement {
  parameters: Float64Array; encoded: Float64Array; sigmaEncoded: Float64Array; stressNrmse: number; fitted: Float64Array;
  conditionNumber: number; minimumSensitivity: number; noise: number; evaluations: number; converged: boolean;
  initial: Float64Array; leastSquares: TrfResult; residualCalls: number;
}
/** refine_parameters: scipy's bounded soft-L1 least squares from the clipped encoded proposal, then the central-
 *  difference sensitivity, its singular values, the MAD noise estimate and the sensitivity-plus-floor sigma. */
function refineParameters(meta: PhysicsModelMeta, t: Float64Array, e: Float64Array, s: Float64Array, proposal: Float64Array): Refinement {
  const scale = Math.max(maxAbs(s), 1e-6);
  const initial = encodeParameters(meta, proposal).map((value) => clip(value, INITIAL_CLIP, 1 - INITIAL_CLIP));
  let residualCalls = 0;
  const residual = (encoded: Float64Array): Float64Array => {
    residualCalls++;
    const [young, g, tau] = decodeParameters(meta, encoded) as unknown as [number, number, number];
    const model = stressResponse(t, e, young, g, tau);
    for (let i = 0; i < model.length; i++) model[i] = (model[i]! - s[i]!) / scale;
    return model;
  };
  const leastSquares = leastSquaresTrf(residual, initial, REFINEMENT);
  const calls = residualCalls;
  const x = leastSquares.x;
  const parameters = decodeParameters(meta, x);
  const fitted = stressResponse(t, e, parameters[0]!, parameters[1]!, parameters[2]!);
  const r = fitted.map((value, i) => (value - s[i]!) / scale);
  const m = t.length, jac = new Float64Array(m * 3);
  for (let k = 0; k < 3; k++) {
    const lo = Float64Array.from(x), hi = Float64Array.from(x);
    lo[k] = Math.max(0, lo[k]! - SENSITIVITY_STEP); hi[k] = Math.min(1, hi[k]! + SENSITIVITY_STEP);
    const up = residual(hi), down = residual(lo), step = hi[k]! - lo[k]!;
    for (let i = 0; i < m; i++) jac[i * 3 + k] = (up[i]! - down[i]!) / step;
  }
  const singular = singularValues(jac, m, 3);
  const centre = median(r);
  const noise = Math.max(NOISE_FLOOR, median(r.map((value) => Math.abs(value - centre))) / MAD_SCALE);
  const normal = Array.from({ length: 3 }, (_, a) => Array.from({ length: 3 }, (_, b) => { let sum = 0; for (let i = 0; i < m; i++) sum += jac[i * 3 + a]! * jac[i * 3 + b]!; return sum; }));
  const pinv = pinvDiagonalSymmetric(normal, PINV_RCOND), noise2 = noise * noise;
  const sigmaEncoded = Float64Array.from({ length: 3 }, (_, k) => Math.sqrt(Math.max(pinv[k]! * noise2, 0) + SIGMA_FLOOR[k]! * SIGMA_FLOOR[k]!));
  return {
    parameters, encoded: x, sigmaEncoded, stressNrmse: Math.sqrt(pairwiseSum(r.map((value) => value * value)) / m), fitted,
    conditionNumber: singular[0]! / Math.max(singular[2]!, 1e-15), minimumSensitivity: singular[2]!, noise,
    evaluations: leastSquares.nfev, converged: leastSquares.success, initial, leastSquares, residualCalls: calls,
  };
}

export interface PhysicsDiagnostics {
  status: "supported" | "review_required"; reasons: string[]; condition_number: number; minimum_sensitivity: number; noise_fraction_estimate: number;
  excitation: { peak_strain: number; duration_s: number; total_variation_over_amplitude: number; peak_strain_rate_s_inv: number };
  ood_scope: string;
}
/** diagnostics: the fit, identifiability, convergence, excitation and bound checks behind accepted_for_application. */
function diagnostics(meta: PhysicsModelMeta, t: Float64Array, e: Float64Array, fit: Refinement): PhysicsDiagnostics {
  const amplitude = maxOf(e), de = diff(e), dt = diff(t);
  const rate = de.map((value, i) => value / dt[i]!);
  const variation = pairwiseSum(de.map(Math.abs)) / amplitude;
  const peakRate = maxAbs(rate);
  const reasons: string[] = [];
  if (fit.stressNrmse > FIT_GATE) reasons.push("observed_response_not_reproduced");
  if (fit.conditionNumber > CONDITION_LIMIT || fit.minimumSensitivity < SENSITIVITY_LIMIT) reasons.push("insufficient_parameter_identifiability");
  if (!fit.converged) reasons.push("physical_refinement_not_converged");
  if (variation < VARIATION_LIMIT) reasons.push("insufficient_loading_and_unloading");
  if (peakRate > RATE_LIMIT) reasons.push("strain_rate_outside_training_support");
  if (minOf(fit.encoded) < BOUND_MARGIN || maxOf(fit.encoded) > 1 - BOUND_MARGIN) reasons.push("parameter_at_training_bound");
  return {
    status: reasons.length ? "review_required" : "supported", reasons, condition_number: fit.conditionNumber, minimum_sensitivity: fit.minimumSensitivity,
    noise_fraction_estimate: fit.noise,
    excitation: { peak_strain: amplitude, duration_s: t[t.length - 1]!, total_variation_over_amplitude: variation, peak_strain_rate_s_inv: peakRate },
    ood_scope: meta.result_text.ood_scope,
  };
}

/** The response of POST /api/physics/infer (key order included). */
export interface PhysicsInference {
  parameters: ParameterRecord<number>; neural_parameters: ParameterRecord<number>; ensemble_std: ParameterRecord<number>;
  parameter_intervals_90: ParameterRecord<{ lower: number; upper: number }>;
  version: string; scope: string; estimator: string; uncertainty_scope: string; stress_nrmse: number; stress_nrmse_definition: string;
  fitted_stress_pa: number[]; within_synthetic_fit_gate: boolean; accepted_for_application: boolean; rejection_reasons: string[];
  diagnostics: PhysicsDiagnostics; refinement_evaluations: number; human_liver_validated: false; fixed_or_unidentified: string[];
  model_id: string; observation_provenance: string;
}
/** The intermediate values of one calibration, for tests and inspection. */
export interface PhysicsCalibrationTrace {
  features: Float64Array; memberOutputs: Float64Array[]; proposals: Float64Array[]; initial: Float64Array;
  leastSquares: TrfResult; residualCalls: number; sigmaEncoded: Float64Array; result: PhysicsInference;
}
const record = <T>(values: ArrayLike<T>): ParameterRecord<T> => ({ young_pa: values[0]!, relaxation_fraction: values[1]!, relaxation_time_s: values[2]! });

/** predict_history + infer_observation for a request the model accepted. */
function calibrate(model: PhysicsModel, observation: PhysicsObservation): PhysicsCalibrationTrace {
  const { meta } = model;
  const length = observation.reference_length_mm, area = observation.reference_area_mm2;
  if (!Number.isFinite(length) || !Number.isFinite(area) || !(0 < length && length <= 1000) || !(0 < area && area <= 1e6))
    throw refuse("Positive calibrated reference length (≤1000 mm) and area (≤1000000 mm²) required");
  const provenance = pythonStrip(observation.provenance);
  const provenanceLength = codePoints(provenance);
  if (!(8 <= provenanceLength && provenanceLength <= 2000)) throw refuse("Calibration provenance must contain 8–2000 characters");
  const t = Float64Array.from(observation.times_s), e = Float64Array.from(observation.displacement_mm, (d) => d / length);
  const areaM2 = area * 1e-6, s = Float64Array.from(observation.force_n, (f) => f / areaM2);
  const features = observationFeatures(meta, t, e, s);
  const outputs = memberOutputs(model, features);
  const proposals = outputs.map((h) => decodeParameters(meta, h));
  const count = proposals.length;
  const mean = new Float64Array(3), std = new Float64Array(3);
  for (let k = 0; k < 3; k++) {   // proposals.mean(axis=0) and .std(axis=0): sequential sums over the members
    let sum = 0;
    for (const p of proposals) sum += p[k]!;
    mean[k] = sum / count;
    let squares = 0;
    for (const p of proposals) { const d = p[k]! - mean[k]!; squares += d * d; }
    std[k] = Math.sqrt(squares / count);
  }
  const fit = refineParameters(meta, t, e, s, mean);
  const diag = diagnostics(meta, t, e, fit);
  const q = meta.calibration.quantiles_90;
  const lower = decodeParameters(meta, fit.encoded.map((x, k) => clip(x - q[k]! * fit.sigmaEncoded[k]!, 0, 1)));
  const upper = decodeParameters(meta, fit.encoded.map((x, k) => clip(x + q[k]! * fit.sigmaEncoded[k]!, 0, 1)));
  const text = meta.result_text;
  const result: PhysicsInference = {
    parameters: record(fit.parameters), neural_parameters: record(mean), ensemble_std: record(std),
    parameter_intervals_90: record(CALIBRATION_PARAMETERS.map((_, k) => ({ lower: lower[k]!, upper: upper[k]! }))),
    version: text.version, scope: text.scope, estimator: text.estimator, uncertainty_scope: text.uncertainty_scope,
    stress_nrmse: fit.stressNrmse, stress_nrmse_definition: text.stress_nrmse_definition, fitted_stress_pa: Array.from(fit.fitted),
    within_synthetic_fit_gate: fit.stressNrmse <= FIT_GATE, accepted_for_application: !diag.reasons.length, rejection_reasons: [...diag.reasons],
    diagnostics: diag, refinement_evaluations: fit.evaluations, human_liver_validated: false, fixed_or_unidentified: [...text.fixed_or_unidentified],
    model_id: meta.model_sha256, observation_provenance: provenance,
  };
  return { features, memberOutputs: outputs, proposals, initial: fit.initial, leastSquares: fit.leastSquares, residualCalls: fit.residualCalls, sigmaEncoded: fit.sigmaEncoded, result };
}

/** The whole calibration of one /infer request body with its intermediate values (throws what the route refuses). */
export function traceCalibration(model: PhysicsModel, observation: unknown): PhysicsCalibrationTrace {
  return calibrate(model, checkedRequest(observation, ["body"]));
}
/** POST /api/physics/infer on a loaded model, synchronously. */
export function inferObservation(model: PhysicsModel, observation: unknown): PhysicsInference {
  return traceCalibration(model, observation).result;
}
/** The bundled model, or the API's 503 for a model it cannot serve (the request is validated before, as FastAPI does). */
const servedModel = (): Promise<PhysicsModel> => loadPhysicsModel().catch((error: unknown) => {
  throw new PhysicsCalibrationError(503, error instanceof Error ? error.message : "The physics calibration network is not bundled with this copy.");
});
/** The public copy's POST /api/physics/infer: the same response for the same observation, or the same refusal
 *  (PhysicsCalibrationError, whose message is what the studio shows for the API's answer). */
export async function inferObservationLocally(observation: PhysicsObservation): Promise<PhysicsInference> {
  const request = checkedRequest(observation, ["body"]);
  return calibrate(await servedModel(), request).result;
}

// ---------------------------------------------------------------------------------------------- the playground route
/** learned_parameters' application of a fit: refuse what the diagnostics or the fit gate do not accept, then the
 *  defaults with the three inferred values, validated as PhysicsParameters validates them. */
function learnedParameters(meta: PhysicsModelMeta, fit: PhysicsInference): PhysicsParameters {
  if (fit.accepted_for_application === false) {
    const reasons = fit.rejection_reasons.join("; ") || "insufficient calibration evidence";
    throw refuse(`Physics calibration needs review: ${reasons}.`);   // no application policy: no recommended next steps
  }
  if (!fit.within_synthetic_fit_gate) throw refuse("Physics model did not reproduce the supplied observation within 5% peak-normalized stress RMSE");
  const merged = { ...meta.defaults, ...fit.parameters } as PhysicsParameters;
  for (const [name, bound] of Object.entries(meta.parameter_fields)) {
    const value = merged[name as keyof PhysicsParameters];
    if (!(Number.isFinite(value) && (bound.ge === undefined || value >= bound.ge) && (bound.le === undefined || value <= bound.le) && (bound.gt === undefined || value > bound.gt) && (bound.lt === undefined || value < bound.lt)))
      throw refuse(`1 validation error for PhysicsParameters\n${name}\n  Input outside its bounds [type=bounds, input_value=${value}]`);
  }
  return merged;
}

type Snapshot = Record<string, unknown> & { parameters: PhysicsParameters; learning: Record<string, unknown>; mesh: Record<string, unknown> };
/** POST /api/physics/playground (parameter_source "learned", that observation) from the API's learned preparation
 *  of the same liver (the public copy bundles it: static/api/physics/playground/<template>.learned.json.gz). The cage
 *  depends on the geometry alone and is kept as it is (shared, not copied); `parameters` and `learning` are the
 *  route's for this observation; the mass is the cage volume times the density, which calibration never infers, so
 *  it stays the snapshot's. Without an observation the route uses the demonstration and returns the snapshot. */
export function calibratePlayground(model: PhysicsModel, snapshot: unknown, observation: PhysicsObservation | null | undefined): Record<string, unknown> {
  const prepared = learnedSnapshot(snapshot);
  if (observation === null || observation === undefined) return { ...prepared };
  return calibrateSnapshot(model, prepared, checkedRequest(observation, ["body", "observation"]));
}
function learnedSnapshot(snapshot: unknown): Snapshot {
  if (!isObject(snapshot) || snapshot.schema_version !== PHYSICS_PLAYGROUND_SCHEMA || !isObject(snapshot.parameters) || !isObject(snapshot.learning) ||
      snapshot.learning.source !== "learned" || !isObject(snapshot.mesh)) throw new Error("The hands-on liver to calibrate is not the API's learned preparation.");
  return snapshot as Snapshot;
}
function calibrateSnapshot(model: PhysicsModel, prepared: Snapshot, request: PhysicsObservation): Record<string, unknown> {
  const fit = calibrate(model, request).result;
  const parameters = learnedParameters(model.meta, fit);
  const learning = {
    ...fit, source: "learned", predicted_parameters: { ...fit.parameters },
    observation: {   // ObservationRequest.model_dump(): the validated fields in declaration order, provenance unstripped
      times_s: [...request.times_s], force_n: [...request.force_n], displacement_mm: [...request.displacement_mm],
      reference_length_mm: request.reference_length_mm, reference_area_mm2: request.reference_area_mm2, provenance: request.provenance,
    },
    observation_origin: "user_supplied_calibration_unverified", human_liver_validated: false,
  };
  const mesh = { ...prepared.mesh };
  const volume = mesh.cage_volume_ml;
  if (parameters.density_kg_m3 !== prepared.parameters.density_kg_m3) {
    if (typeof volume !== "number") throw new Error("The hands-on liver has no cage volume.");
    mesh.mass_kg = volume / 1e6 * parameters.density_kg_m3;
  }
  return { ...prepared, parameters, learning, mesh };
}
/** The public copy's hands-on liver calibrated from the user's own measurement: exactly what POST
 *  /api/physics/playground returns for parameter_source "learned" with that observation, built from the bundled
 *  learned snapshot of the displayed liver — or the route's refusal (PhysicsCalibrationError). */
export async function calibratedPlayground(snapshot: unknown, observation: PhysicsObservation): Promise<unknown> {
  const prepared = learnedSnapshot(snapshot);
  if (observation === null || observation === undefined) return { ...prepared };
  const request = checkedRequest(observation, ["body", "observation"]);
  return calibrateSnapshot(await servedModel(), prepared, request);
}
