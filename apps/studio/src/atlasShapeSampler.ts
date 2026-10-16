/** The learned shape sampler (POST /api/atlas/sample) in the browser: services.api.atlas_model.sample_model and the
 *  ridge path of pipelines.train.viscera_train.atlas_shape (sample_controls, _ridge, refine_controls) repeated in
 *  TypeScript on the exported training rows (public/models/shape-v2, written by scripts/export_shape_web.py). This
 *  path reads no neural weights: a proposal is the ridge-predicted mean for the requested bounding box plus one
 *  bootstrapped leave-one-out residual of the template's training designs (numpy's generator, numpyRandom.ts),
 *  refined against the exact deformation decoder by scipy's bounded trust-region least squares
 *  (trustRegionReflective.ts) until the box matches within 0.1 %; without "keep dimensions" it is one training
 *  design drawn at random. Float64 throughout, with the one float32 rounding numpy applies to the encoded
 *  conditions. The sampler sees the geometry alone, as the route's geometry_spec() does; the surface recipe and a
 *  disease profile ride along into the realizer (realizeSpecLocally), as the route's decoration does.
 *  atlasShapeSampler.test.ts replays the API's own samples and compares with the running API. */
import { publicUrl } from "./api";
import type { AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";
import type { AtlasDiseaseLibrary } from "./atlasDisease";
import { realizeSpecLocally } from "./atlasDiseaseLocal";
import { CONTROL_NAMES, LOCAL_REALIZER_VERSION, deformVertices } from "./atlasLocal";
import { Pcg64 } from "./numpyRandom";
import { leastSquaresTrf } from "./trustRegionReflective";

export const SHAPE_WEB_FORMAT = "viscera-atlas-control-model-v1-web";
export const SHAPE_METHOD = "ridge";

export interface ShapeTemplateEntry {
  id: string; organ_id: number; condition_mean: number[]; condition_scale: number[]; condition_available: boolean[];
  control_limits: number[]; normalization_mm: number; artifact_sha256: string; display_artifact_sha256: string;
  /** vertices where the displayed (templates-v3) reference differs from the trained (cohort-v2) template */
  rest_vertex_patches: { index: number; display: number[]; trained: number[] }[];
}
export interface ShapeModelMeta {
  format: string; method: string; model_sha256: string; model_source: string; default_model: string; ridge_alpha: number;
  condition_names: string[]; control_names: string[]; templates: ShapeTemplateEntry[];
  training_rows: { count: number; template_index: number[] };
  arrays: { name: string; dtype: string; shape: number[]; offset: number }[]; byte_length: number;
  dataset: { root: string; release_sha256: string; source_sha256: string }; scope: string; sampling_scope: string;
  refinement: { relative_tolerance: number; prior_weight: number; max_nfev: number; ftol: number; xtol: number; gtol: number };
  attempts: number; attempt_seed_stride: number;
}
export interface ShapeModel {
  meta: ShapeModelMeta;
  /** training_rows.controls, N × 7 */ controls: Float64Array;
  /** training_rows.conditions, N × 6 */ conditions: Float64Array;
  /** training_rows.condition_mask, N × 6 */ mask: Uint8Array;
  /** the rows of each template, in training order */ rows: Map<string, number[]>;
}
const CONDITIONS = 6, CONTROLS = 7;

export function parseShapeModel(meta: ShapeModelMeta, weights: ArrayBuffer): ShapeModel {
  if (meta.format !== SHAPE_WEB_FORMAT || meta.method !== SHAPE_METHOD) throw new Error("Unsupported shape model export.");
  if (weights.byteLength !== meta.byte_length) throw new Error("The shape model rows do not match their layout.");
  const n = meta.training_rows.count;
  const array = (name: string, dtype: string, shape: number[]) => {
    const entry = meta.arrays.find((a) => a.name === name);
    if (!entry || entry.dtype !== dtype || entry.shape.join() !== shape.join()) throw new Error(`The shape model lacks ${name}.`);
    return entry.offset;
  };
  const controls = new Float64Array(weights, array("controls", "<f8", [n, CONTROLS]), n * CONTROLS);
  const conditions = new Float64Array(weights, array("conditions", "<f8", [n, CONDITIONS]), n * CONDITIONS);
  const mask = new Uint8Array(weights, array("condition_mask", "u1", [n, CONDITIONS]), n * CONDITIONS);
  for (const value of controls) if (!(Math.abs(value) <= 1)) throw new Error("Shape model controls are not bounded.");
  // an unobserved condition is NaN behind a cleared mask bit; every observed one must be a number
  mask.forEach((observed, i) => {
    if (observed > 1) throw new Error("Shape model mask is malformed.");
    if (observed === 1 && !Number.isFinite(conditions[i]!)) throw new Error("Shape model conditions are not finite.");
  });
  if (meta.training_rows.template_index.length !== n || meta.templates.length === 0) throw new Error("Shape model rows are malformed.");
  const rows = new Map<string, number[]>(meta.templates.map((t) => [t.id, []]));
  meta.training_rows.template_index.forEach((templateIndex, row) => {
    const id = meta.templates[templateIndex]?.id;
    if (id === undefined) throw new Error("Shape model rows name an unknown template.");
    rows.get(id)!.push(row);
  });
  return { meta, controls, conditions, mask, rows };
}

let cachedMeta: Promise<ShapeModelMeta> | null = null;
let cachedModel: Promise<ShapeModel> | null = null;
/** The metadata alone (19 KB): whether the model is bundled, which templates it covers, the provenance it carries. */
export function shapeModelInfo(signal?: AbortSignal): Promise<ShapeModelMeta> {
  cachedMeta ??= fetch(publicUrl("models/shape-v2/model.json"), { cache: "default" }).then(async (response) => {
    if (!response.ok) throw new Error("The learned shape model is not bundled with this copy.");
    const meta = await response.json() as ShapeModelMeta;
    if (meta.format !== SHAPE_WEB_FORMAT) throw new Error("Unsupported shape model export.");
    return meta;
  }).catch((error) => { cachedMeta = null; throw error; });
  return cachedMeta;
}
/** Tests and tools that hold the model already (read from disk) hand it over instead of fetching. */
export function primeShapeModel(model: ShapeModel): void { cachedMeta = Promise.resolve(model.meta); cachedModel = Promise.resolve(model); }
export function loadShapeModel(signal?: AbortSignal): Promise<ShapeModel> {
  cachedModel ??= Promise.all([shapeModelInfo(signal), fetch(publicUrl("models/shape-v2/weights.bin"), { cache: "default" }).then((response) => {
    if (!response.ok) throw new Error("The learned shape model rows are not bundled with this copy.");
    return response.arrayBuffer();
  })]).then(([meta, weights]) => parseShapeModel(meta, weights)).catch((error) => { cachedModel = null; throw error; });
  return cachedModel;
}

// ---------------------------------------------------------------------------------------------- the decoder
/** The three extents the API measures (np.ptp of the deformed vertices), NaN for the unmeasured conditions. */
export type ExtentDecoder = (controls: ArrayLike<number>) => [number, number, number];
const controlRecord = (controls: ArrayLike<number>): Record<string, number> => Object.fromEntries(CONTROL_NAMES.map((name, i) => [name, controls[i]!]));

/** services.api.atlas_model.sample_model's decoder on the displayed reference's rest vertices: where the displayed
 *  template was repaired (templates-v3), the trained vertex is restored first, so the measurement is the API's. */
export function extentDecoder(entry: ShapeTemplateEntry, restPositions: ArrayLike<number>): ExtentDecoder {
  if (restPositions.length % 3 !== 0 || restPositions.length === 0) throw new Error("The reference surface has no vertices.");
  const rest = Float64Array.from(restPositions);
  for (const patch of entry.rest_vertex_patches) {
    const at = patch.index * 3;
    const matches = (values: number[]) => values.every((value, k) => Math.abs(rest[at + k]! - value) <= 1e-6);
    if (matches(patch.display)) patch.trained.forEach((value, k) => { rest[at + k] = value; });
    else if (!matches(patch.trained)) throw new Error("Selected reference does not match the model training template");
  }
  return (controls) => {
    const positions = deformVertices(rest, controlRecord(controls), entry.control_limits, entry.normalization_mm);
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { const value = positions[i + k]!; if (value < low[k]!) low[k] = value; if (value > high[k]!) high[k] = value; }
    return [high[0]! - low[0]!, high[1]! - low[1]!, high[2]! - low[2]!];
  };
}

// ---------------------------------------------------------------------------------------------- NumPy arithmetic
const f32 = Math.fround;
const EXTENT_CONDITIONS = 3;   // the decoder observes extent_x/y/z_mm, never the three other conditions

/** encode_conditions for one row: (where(mask, value, mean) − mean) / scale, rounded to float32 as numpy stores it. */
function encodeRow(entry: ShapeTemplateEntry, values: ArrayLike<number>, observed: (j: number) => boolean): Float64Array {
  const z = new Float64Array(CONDITIONS);
  for (let j = 0; j < CONDITIONS; j++) z[j] = observed(j) ? f32((values[j]! - entry.condition_mean[j]!) / entry.condition_scale[j]!) : 0;
  return z;
}

/** np.linalg.solve for a small square system with several right-hand sides (LU with partial pivoting). */
function solve(a: Float64Array, k: number, b: Float64Array, columns: number): Float64Array {
  const lu = Float64Array.from(a), x = Float64Array.from(b);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let row = col + 1; row < k; row++) if (Math.abs(lu[row * k + col]!) > Math.abs(lu[pivot * k + col]!)) pivot = row;
    if (lu[pivot * k + col] === 0) throw new Error("Singular matrix");
    if (pivot !== col) {
      for (let j = 0; j < k; j++) { const t = lu[col * k + j]!; lu[col * k + j] = lu[pivot * k + j]!; lu[pivot * k + j] = t; }
      for (let j = 0; j < columns; j++) { const t = x[col * columns + j]!; x[col * columns + j] = x[pivot * columns + j]!; x[pivot * columns + j] = t; }
    }
    const reciprocal = 1 / lu[col * k + col]!;
    for (let row = col + 1; row < k; row++) {
      const factor = (lu[row * k + col] = lu[row * k + col]! * reciprocal);
      for (let j = col + 1; j < k; j++) lu[row * k + j] = lu[row * k + j]! - factor * lu[col * k + j]!;
      for (let j = 0; j < columns; j++) x[row * columns + j] = x[row * columns + j]! - factor * x[col * columns + j]!;
    }
  }
  for (let row = k - 1; row >= 0; row--) for (let j = 0; j < columns; j++) {
    let value = x[row * columns + j]!;
    for (let col = row + 1; col < k; col++) value -= lu[row * k + col]! * x[col * columns + j]!;
    x[row * columns + j] = value / lu[row * k + row]!;
  }
  return x;
}

interface Ridge { mean: Float64Array; residual: Float64Array[] }
/** _ridge for one template: the penalised fit of controls on the observed conditions (intercept unpenalised), its
 *  clipped prediction for the query, and the leave-one-out residuals of the training rows, centred as
 *  sample_controls centres them. */
function ridge(model: ShapeModel, entry: ShapeTemplateEntry, rows: number[], z: Float64Array, used: number[]): Ridge {
  const complete = rows.filter((row) => used.every((j) => model.mask[row * CONDITIONS + j] === 1));
  if (complete.length < 3) throw new Error("Fewer than three training rows jointly observe requested conditions");
  const k = 1 + used.length, count = complete.length;
  const f = new Float64Array(count * k), x = new Float64Array(count * CONTROLS);
  complete.forEach((row, r) => {
    const tz = encodeRow(entry, model.conditions.subarray(row * CONDITIONS, (row + 1) * CONDITIONS), (j) => model.mask[row * CONDITIONS + j] === 1);
    f[r * k] = 1;
    used.forEach((j, u) => { f[r * k + 1 + u] = tz[j]!; });
    for (let c = 0; c < CONTROLS; c++) x[r * CONTROLS + c] = model.controls[row * CONTROLS + c]!;
  });
  const q = new Float64Array(k);
  q[0] = 1;
  used.forEach((j, u) => { q[1 + u] = z[j]!; });
  const normal = new Float64Array(k * k), ftx = new Float64Array(k * CONTROLS), ft = new Float64Array(k * count);
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) { let sum = 0; for (let r = 0; r < count; r++) sum += f[r * k + a]! * f[r * k + b]!; normal[a * k + b] = sum + (a === b && a > 0 ? model.meta.ridge_alpha : 0); }
    for (let c = 0; c < CONTROLS; c++) { let sum = 0; for (let r = 0; r < count; r++) sum += f[r * k + a]! * x[r * CONTROLS + c]!; ftx[a * CONTROLS + c] = sum; }
    for (let r = 0; r < count; r++) ft[a * count + r] = f[r * k + a]!;
  }
  const weights = solve(normal, k, ftx, CONTROLS);
  const mean = new Float64Array(CONTROLS);
  for (let c = 0; c < CONTROLS; c++) { let sum = 0; for (let a = 0; a < k; a++) sum += q[a]! * weights[a * CONTROLS + c]!; mean[c] = Math.min(1, Math.max(-1, sum)); }
  const influence = solve(normal, k, ft, count);   // normal⁻¹ fᵀ; the hat matrix diagonal is f · that
  const residual: Float64Array[] = [];
  const centre = new Float64Array(CONTROLS);
  complete.forEach((_, r) => {
    let hat = 0;
    for (let a = 0; a < k; a++) hat += f[r * k + a]! * influence[a * count + r]!;
    const row = new Float64Array(CONTROLS);
    for (let c = 0; c < CONTROLS; c++) {
      let fitted = 0;
      for (let a = 0; a < k; a++) fitted += f[r * k + a]! * weights[a * CONTROLS + c]!;
      row[c] = (x[r * CONTROLS + c]! - fitted) / Math.max(1 - hat, 0.05);
      centre[c] = centre[c]! + row[c]!;
    }
    residual.push(row);
  });
  for (const row of residual) for (let c = 0; c < CONTROLS; c++) row[c] = row[c]! - centre[c]! / count;
  return { mean, residual };
}

/** sample_controls' support check: each requested value within the template's observed range (±1e-5 of its span). */
function checkSupport(model: ShapeModel, templateId: string, rows: number[], targets: Record<string, number>): void {
  for (const [name, value] of Object.entries(targets)) {
    const j = model.meta.condition_names.indexOf(name);
    let low = Infinity, high = -Infinity;
    for (const row of rows) if (model.mask[row * CONDITIONS + j] === 1) { const v = model.conditions[row * CONDITIONS + j]!; low = Math.min(low, v); high = Math.max(high, v); }
    const tolerance = Math.max((high - low) * 1e-5, 1e-8);
    if (!(low - tolerance <= value && value <= high + tolerance)) throw new Error(`Requested ${name} exceeds training support for ${templateId}`);
  }
}

export interface ShapeProposal { seed: number; draws: number[]; z: number[] | null; mean: number[] | null; residualRow: number[] | null; proposal: Float64Array }
/** sample_controls(artifact, template_id, targets, count=1, seed): one bounded proposal — a training design when
 *  no dimensions are requested, else the ridge mean plus a drawn centred residual, redrawn while out of bounds. */
export function proposeControls(model: ShapeModel, templateId: string, targets: Record<string, number>, seed: number): ShapeProposal {
  const entry = model.meta.templates.find((t) => t.id === templateId);
  const rows = model.rows.get(templateId);
  if (!entry || !rows?.length) throw new Error(`Unsupported template: ${templateId}`);
  const names = model.meta.condition_names;
  const requested = (j: number) => names[j]! in targets;
  for (let j = 0; j < CONDITIONS; j++) if (requested(j) && !entry.condition_available[j]) throw new Error("Requested condition has no observed training targets for this template");
  const z = encodeRow(entry, names.map((name) => targets[name] ?? NaN), requested);
  const rng = new Pcg64(seed);
  if (Object.keys(targets).length === 0) {
    const draws = rng.integers(0, rows.length, 1);
    const row = rows[draws[0]!]!;
    return { seed, draws, z: null, mean: null, residualRow: null, proposal: Float64Array.from(model.controls.subarray(row * CONTROLS, (row + 1) * CONTROLS)) };
  }
  checkSupport(model, templateId, rows, targets);
  const used = names.map((_, j) => j).filter(requested);
  const { mean, residual } = ridge(model, entry, rows, z, used);
  const draws: number[] = [];
  for (let attempt = 0; attempt < 256; attempt++) {
    const draw = rng.integers(0, residual.length);
    draws.push(draw);
    const proposal = mean.map((value, c) => value + residual[draw]![c]!);
    if (proposal.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)) return { seed, draws, z: Array.from(z), mean: Array.from(mean), residualRow: Array.from(residual[draw]!), proposal };
  }
  throw new Error("Bounded proposal rejection exhausted; relax constraints or use nearest");
}

export interface ShapeMeasurement { target: number; measured: number; absolute_error: number; before_absolute_error: number; tolerance_original_units: number }
export interface ShapeRefinement {
  status: "matched" | "unmet_constraints"; template_id: string; controls: number[]; measurements: Record<string, ShapeMeasurement>;
  decoder_calls: number; optimizer_converged: boolean; optimizer_message: string; relative_tolerance: number; requires_geometry_validation: true;
}
/** refine_controls: bounded least squares of the normalised extent errors plus a weak prior on the proposal,
 *  against the exact decoder; "matched" when every extent lands within relative_tolerance of its target. */
export function refineControls(model: ShapeModel, entry: ShapeTemplateEntry, initialControls: ArrayLike<number>, targets: Record<string, number>, decoder: ExtentDecoder): ShapeRefinement {
  const { relative_tolerance: relativeTolerance, prior_weight: priorWeight, max_nfev: maxNfev, ftol, xtol, gtol } = model.meta.refinement;
  const initial = Float64Array.from(initialControls);
  if (initial.length !== CONTROLS || !initial.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)) throw new Error("Refinement requires seven finite bounded initial controls");
  const names = model.meta.condition_names;
  const requested = names.map((name, j) => (name in targets ? j : -1)).filter((j) => j >= 0);
  if (!requested.length || requested.some((j) => j >= EXTENT_CONDITIONS)) throw new Error("Refinement decoder does not observe requested measurements");
  const target = requested.map((j) => targets[names[j]!]!);
  const scale = requested.map((j) => entry.condition_scale[j]!);
  const unitTolerance = target.map((value, i) => Math.max(Math.abs(value) * relativeTolerance, scale[i]! * relativeTolerance));
  let calls = 0;
  const measure = (controls: ArrayLike<number>): number[] => {
    const values = decoder(controls);
    calls += 1;
    const measured = requested.map((j) => values[j]!);
    if (!measured.every(Number.isFinite)) throw new Error("Refinement decoder does not observe requested measurements");
    return measured;
  };
  const residuals = (controls: Float64Array): Float64Array => {
    const measured = measure(controls);
    return Float64Array.from([...measured.map((value, i) => (value - target[i]!) / scale[i]!), ...Array.from(controls, (value, i) => priorWeight * (value - initial[i]!))]);
  };
  const error = (measured: number[]) => Math.sqrt(measured.reduce((sum, value, i) => sum + ((value - target[i]!) / scale[i]!) ** 2, 0));
  const before = measure(initial);
  const result = leastSquaresTrf(residuals, initial, { lower: -1, upper: 1, ftol, xtol, gtol, maxNfev });
  let best = Float64Array.from(result.x), measured = measure(best);
  if (error(measured) > error(before)) { best = Float64Array.from(initial); measured = before; }
  const measurements: Record<string, ShapeMeasurement> = {};
  requested.forEach((j, i) => {
    measurements[names[j]!] = { target: target[i]!, measured: measured[i]!, absolute_error: Math.abs(measured[i]! - target[i]!), before_absolute_error: Math.abs(before[i]! - target[i]!), tolerance_original_units: unitTolerance[i]! };
  });
  const matched = measured.every((value, i) => Math.abs(value - target[i]!) <= unitTolerance[i]!);
  return { status: matched ? "matched" : "unmet_constraints", template_id: entry.id, controls: Array.from(best), measurements, decoder_calls: calls, optimizer_converged: result.success, optimizer_message: result.message, relative_tolerance: relativeTolerance, requires_geometry_validation: true };
}

// ---------------------------------------------------------------------------------------------- the route
export interface ShapeDesign { controls: Record<string, number>; restPositions: ArrayLike<number> }
export interface ShapeAttempt extends ShapeProposal { refinement: ShapeRefinement | null }
export interface ShapeProvenance {
  method: typeof SHAPE_METHOD; model_sha256: string; scope: string; sampling: "conditional_residual_proposal" | "empirical_training_bootstrap";
  match_dimensions: boolean; requested_dimensions_mm: Record<string, number>; refinement_status: string;
  refinement: Omit<ShapeRefinement, "controls"> | { status: "not_requested" }; attempt: number;
}
export interface ShapeSample { controls: Record<string, number>; provenance: ShapeProvenance; targets: Record<string, number>; currentExtentsMm: [number, number, number]; attempts: ShapeAttempt[] }

/** sample_model(template_root, model, dataset, spec, match_dimensions) up to the realization: the controls the API
 *  returns in result.spec.controls and the provenance it attaches as summary.model / scene.metadata.model. The
 *  design is the displayed one (its controls set the bounding box to keep; its rest vertices feed the decoder). */
export function sampleShapeControls(model: ShapeModel, templateId: string, seed: number, matchDimensions: boolean, design: ShapeDesign): ShapeSample {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("The shape seed must be a whole number below 2^32.");
  const entry = model.meta.templates.find((t) => t.id === templateId);
  if (!entry) throw new Error(`Unsupported template: ${templateId}`);
  const decoder = extentDecoder(entry, design.restPositions);
  const current = decoder(CONTROL_NAMES.map((name) => design.controls[name] ?? 0));
  const targets: Record<string, number> = matchDimensions ? Object.fromEntries(model.meta.condition_names.slice(0, EXTENT_CONDITIONS).map((name, i) => [name, current[i]!])) : {};
  const attempts: ShapeAttempt[] = [];
  let refinement: ShapeProvenance["refinement"] = { status: "not_requested" };
  let controls: ArrayLike<number> | null = null;
  for (let attempt = 0; attempt < model.meta.attempts && !controls; attempt++) {
    const proposal = proposeControls(model, templateId, targets, (seed + attempt * model.meta.attempt_seed_stride) % 2 ** 32);
    if (!matchDimensions) { attempts.push({ ...proposal, refinement: null }); controls = proposal.proposal; break; }
    const refined = refineControls(model, entry, proposal.proposal, targets, decoder);
    attempts.push({ ...proposal, refinement: refined });
    const { controls: refinedControls, ...record } = refined;
    refinement = record;
    if (refined.status === "matched") controls = refinedControls;
  }
  if (!controls) throw new Error("No sampled variation could match the requested dimensions within the bounded range");
  const provenance: ShapeProvenance = {
    method: SHAPE_METHOD, model_sha256: model.meta.model_sha256, scope: model.meta.sampling_scope,
    sampling: matchDimensions ? "conditional_residual_proposal" : "empirical_training_bootstrap", match_dimensions: matchDimensions,
    requested_dimensions_mm: targets, refinement_status: refinement.status, refinement, attempt: attempts.length,
  };
  return { controls: controlRecord(controls), provenance, targets, currentExtentsMm: current, attempts };
}

/** The public copy's learned variation (POST /api/atlas/sample): sample here, realize here — the disease-v2 renderer
 *  when the spec carries a disease, realizeLocally otherwise — and carry the provenance the API's route attaches.
 *  `library` is the catalogue's disease library, which the disease renderer reads. */
export async function sampleShapeLocally(reference: AtlasGeneration, template: AtlasTemplate, spec: AtlasSpec, matchDimensions: boolean, library?: AtlasDiseaseLibrary, signal?: AbortSignal): Promise<AtlasGeneration> {
  const model = await loadShapeModel(signal);
  const entry = model.meta.templates.find((t) => t.id === spec.template_id);
  if (!entry) throw new Error(`Unsupported template: ${spec.template_id}`);
  // the API checks the displayed reference against the model's training template by artifact hash and refuses a
  // spec whose template hash is stale; here the bundled reference is the displayed one
  const displayed = reference.spec.template_sha256;
  if (typeof displayed === "string" && displayed !== entry.artifact_sha256 && displayed !== entry.display_artifact_sha256) throw new Error("Selected reference does not match the model training template");
  // the API's /api/atlas/sample binds the frozen cohort-v2 reference and refuses the two repaired references
  // (templates-v3: male heart, male bladder) whose displayed hash differs from it; the public copy refuses the same
  // way instead of offering a variation the local studio would not
  if (typeof displayed === "string" && displayed !== entry.artifact_sha256) throw new Error("The trained shape sampler binds this organ's frozen reference, not its repaired one, so the local studio refuses it too; use the joint flow variation, which samples the repaired reference.");
  if (typeof spec.template_sha256 === "string" && spec.template_sha256 !== displayed) throw new Error("Displayed reference changed; reload before sampling");
  const limits = template.control_limits, normalization = template.normalization_mm;
  if ((Array.isArray(limits) && !(limits.length === CONTROLS && limits.every((value, i) => value === entry.control_limits[i]))) || (typeof normalization === "number" && normalization !== entry.normalization_mm)) throw new Error("Selected reference does not match the model training template");
  const organ = reference.scene.organs[0] as (AtlasGeneration["scene"]["organs"][number] & { rest_positions?: number[] }) | undefined;
  if (!organ) throw new Error("The reference has no organ.");
  const sample = sampleShapeControls(model, spec.template_id, spec.seed, matchDimensions, { controls: spec.controls, restPositions: organ.rest_positions ?? organ.positions });
  const target: AtlasSpec = { ...spec, controls: sample.controls };
  const generation = await realizeSpecLocally(reference, target, { ...template, control_limits: entry.control_limits, normalization_mm: entry.normalization_mm }, library, signal);
  const provenance = {
    ...sample.provenance,
    sampled_by: { version: LOCAL_REALIZER_VERSION, scope: "public copy: the API's ridge proposal and trust-region dimension refinement repeated in the browser (float64), the result realized here" },
  };
  generation.summary.model = provenance;
  (generation.scene.metadata as Record<string, unknown>).model = provenance;
  return generation;
}
