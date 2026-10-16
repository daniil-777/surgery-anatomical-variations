/** The joint shape + colour flow (generation 2) in the browser: viscera_core.atlas_joint_v2.sample_joint repeated in
 *  TypeScript on the exported weights (public/models/joint-v2, written by scripts/export_joint_web.py). numpy's
 *  generator gives the renderer seeds and the 22 uniforms (numpyRandom.ts); the inverse rational-quadratic spline flow
 *  runs in float32 as the API's NumPy does; six of the controls become the material recipe. The healthy baseline only:
 *  a disease condition needs the API's disease renderer. atlasJointLocal.test.ts replays the API's own samples. */
import { publicUrl } from "./api";
import type { AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";
import { ATLAS_MATERIAL_VERSION, type AtlasMaterialPreset, type AtlasMaterialRecipe } from "./atlasMaterial";
import { CONTROL_NAMES, LOCAL_REALIZER_VERSION, NEEDS_API, realizeLocally } from "./atlasLocal";
import { Pcg64 } from "./numpyRandom";

export const JOINT_WEB_FORMAT = "viscera-joint-flow-v2-web";
export const JOINT_METHOD = "conditional_spline_flow";

export interface JointCondition { template_id: string; profile_id: string; organ: string; material_preset: AtlasMaterialPreset }
export interface JointModelMeta {
  format: string; method: string; model_sha256: string; bundle_sha256: string;
  config: { layers: number; bins: number; blocks: number; hidden: number; embedding: number; context_gain: number };
  templates: string[]; profiles: string[]; organs: string[]; conditions: JointCondition[]; masks: number[][];
  training_samples: number; scope: string; severity_names: string[];
  arrays: { name: string; shape: number[]; offset: number }[]; float32_values: number;
}
interface Tensor { data: Float32Array; shape: number[] }
export interface JointModel { meta: JointModelMeta; arrays: Map<string, Tensor> }

export function parseJointModel(meta: JointModelMeta, weights: ArrayBuffer): JointModel {
  if (meta.format !== JOINT_WEB_FORMAT || meta.method !== JOINT_METHOD) throw new Error("Unsupported joint model export.");
  if (weights.byteLength !== meta.float32_values * 4) throw new Error("The joint weights do not match their layout.");
  const all = new Float32Array(weights);
  const arrays = new Map<string, Tensor>();
  for (const entry of meta.arrays) {
    const size = entry.shape.reduce((a, b) => a * b, 1);
    const data = all.subarray(entry.offset, entry.offset + size);
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) throw new Error(`Joint weights are not finite: ${entry.name}`);
    arrays.set(entry.name, { data, shape: entry.shape });
  }
  if (meta.masks.length !== meta.config.layers || meta.masks.some((row) => row.length !== 22 || row.reduce((a, b) => a + b, 0) !== 11)) throw new Error("Joint coupling masks are malformed.");
  return { meta, arrays };
}

let cachedMeta: Promise<JointModelMeta> | null = null;
let cachedModel: Promise<JointModel> | null = null;
/** The slim metadata alone (26 KB): enough to know the model is bundled and which templates it covers. */
export function jointModelInfo(signal?: AbortSignal): Promise<JointModelMeta> {
  cachedMeta ??= fetch(publicUrl("models/joint-v2/model.json"), { signal: signal ?? null }).then(async (response) => {
    if (!response.ok) throw new Error("The joint flow is not bundled with this copy.");
    const meta = await response.json() as JointModelMeta;
    if (meta.format !== JOINT_WEB_FORMAT) throw new Error("Unsupported joint model export.");
    return meta;
  }).catch((error) => { cachedMeta = null; throw error; });
  return cachedMeta;
}
/** Tests and tools that hold the model already (read from disk) hand it over instead of fetching. */
export function primeJointModel(model: JointModel): void { cachedMeta = Promise.resolve(model.meta); cachedModel = Promise.resolve(model); }
export function loadJointModel(signal?: AbortSignal): Promise<JointModel> {
  cachedModel ??= Promise.all([jointModelInfo(signal), fetch(publicUrl("models/joint-v2/weights.bin"), { signal: signal ?? null }).then((response) => {
    if (!response.ok) throw new Error("The joint flow weights are not bundled with this copy.");
    return response.arrayBuffer();
  })]).then(([meta, weights]) => parseJointModel(meta, weights)).catch((error) => { cachedModel = null; throw error; });
  return cachedModel;
}

// ---------------------------------------------------------------------------------------------- NumPy arithmetic
const f32 = Math.fround;
const tensor = (model: JointModel, name: string): Tensor => { const t = model.arrays.get(name); if (!t) throw new Error(`Joint model lacks ${name}`); return t; };
/** x @ W.T + b, float32 result (NumPy accumulates in float32 BLAS; the order differs by an ulp or so). */
function linear(model: JointModel, x: ArrayLike<number>, prefix: string): Float32Array {
  const w = tensor(model, prefix + ".weight"), b = tensor(model, prefix + ".bias");
  const [out, inp] = w.shape as [number, number];
  if (x.length !== inp) throw new Error(`${prefix}: expected ${inp} inputs, got ${x.length}`);
  const y = new Float32Array(out);
  for (let o = 0; o < out; o++) { let acc = 0; const row = o * inp; for (let i = 0; i < inp; i++) acc += x[i]! * w.data[row + i]!; y[o] = f32(acc + b.data[o]!); }
  return y;
}
const silu1 = (v: number) => f32(v / (1 + Math.exp(-Math.min(60, Math.max(-60, v)))));
const silu = (x: ArrayLike<number>) => Float32Array.from(x, silu1);
function softmax(values: number[]): number[] { const m = Math.max(...values); const e = values.map((v) => Math.exp(v - m)); const s = e.reduce((a, b) => a + b, 0); return e.map((v) => v / s); }
const logaddexp0 = (v: number) => Math.max(0, v) + Math.log1p(Math.exp(-Math.abs(v)));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The inverse of one monotone rational-quadratic spline on [-1, 1] (Durkan et al. 2019), as the API's NumPy writes it. */
export function splineInverse(value: number, p: ArrayLike<number>, bins: number): number {
  const params = Array.from(p, Number);
  if (params.length !== 3 * bins - 1 || !Number.isFinite(value) || Math.abs(value) > 1 + 1e-5) throw new Error("Invalid bounded spline inputs");
  const widths = softmax(params.slice(0, bins)).map((v) => 2 * (1e-3 + (1 - bins * 1e-3) * v));
  const heights = softmax(params.slice(bins, 2 * bins)).map((v) => 2 * (1e-3 + (1 - bins * 1e-3) * v));
  const derivatives = [1, ...params.slice(2 * bins).map((v) => logaddexp0(v + Math.log(Math.expm1(1 - 1e-3))) + 1e-3), 1];
  const knotsX = [-1], knotsY = [-1];
  for (let i = 0, cx = 0, cy = 0; i < bins; i++) { cx += widths[i]!; cy += heights[i]!; knotsX.push(-1 + cx); knotsY.push(-1 + cy); }
  knotsX[bins] = 1; knotsY[bins] = 1;
  const x = clamp(value, -1, 1);
  let index = 0;
  for (let i = 1; i <= bins; i++) if (x >= knotsY[i]!) index++;
  index = clamp(index, 0, bins - 1);
  const w = widths[index]!, h = heights[index]!, x0 = knotsX[index]!, y0 = knotsY[index]!, d0 = derivatives[index]!, d1 = derivatives[index + 1]!;
  const delta = h / w;
  const dy = x - y0;
  const a = dy * (d0 + d1 - 2 * delta) + h * (delta - d0);
  const b = h * d0 - dy * (d0 + d1 - 2 * delta);
  const c = -delta * dy;
  const denominator = -b - Math.sqrt(Math.max(b * b - 4 * a * c, 0));
  const theta = clamp(Math.abs(denominator) > 1e-20 ? 2 * c / denominator : 0, 0, 1);
  return f32(clamp(x0 + theta * w, -1, 1));
}

function contextFeatures(model: JointModel, condition: JointCondition, severityId: number): Float32Array {
  const { meta } = model, gain = meta.config.context_gain;
  const row = (name: string, index: number) => { const t = tensor(model, name); const width = t.shape[1]!; return Array.from(t.data.subarray(index * width, (index + 1) * width)); };
  const scaled = (values: number[]) => values.map((v) => f32(v * gain));
  const x = [
    ...scaled(row("template_embedding.weight", meta.templates.indexOf(condition.template_id))),
    ...scaled(row("profile_embedding.weight", meta.profiles.indexOf(condition.profile_id))),
    ...scaled(row("organ_embedding.weight", meta.organs.indexOf(condition.organ))),
    ...row("type_embedding.weight", severityId > 0 ? 1 : 0),
  ];
  return linear(model, silu(linear(model, x, "context.0")), "context.2");
}

/** flow_transform(..., inverse=True) for one row: base draws → controls in [-1, 1], float32. */
export function flowInverse(model: JointModel, z: ArrayLike<number>, condition: JointCondition, severityId: number): Float32Array {
  const { config, masks } = model.meta;
  const x = Float32Array.from(z);
  if (x.length !== 22) throw new Error("The joint flow has 22 controls.");
  const context = contextFeatures(model, condition, severityId);
  for (let layer = config.layers - 1; layer >= 0; layer--) {
    const mask = masks[layer]!;
    const kept: number[] = [], changed: number[] = [];
    mask.forEach((bit, i) => (bit ? kept : changed).push(i));
    const prefix = `couplings.${layer}`;
    let h = silu(linear(model, [...kept.map((i) => x[i]!), ...context], prefix + ".input"));
    const film = linear(model, context, prefix + ".film");
    const width = h.length;
    for (let i = 0; i < width; i++) h[i] = f32(f32(h[i]! * f32(1 + f32(0.1 * f32(Math.tanh(film[i]!))))) + film[width + i]!);
    for (let block = 0; block < config.blocks; block++) {
      const residual = linear(model, silu(linear(model, silu(h), `${prefix}.blocks.${block}.0`)), `${prefix}.blocks.${block}.2`);
      const next = new Float32Array(width);
      for (let i = 0; i < width; i++) next[i] = f32(h[i]! + residual[i]!);
      h = next;
    }
    const params = linear(model, silu(h), prefix + ".output");
    const per = 3 * config.bins - 1;
    changed.forEach((target, k) => { x[target] = splineInverse(x[target]!, params.subarray(k * per, (k + 1) * per), config.bins); });
  }
  return x;
}

export interface JointSample {
  controls: Record<string, number>; material: AtlasMaterialRecipe; rendererSeeds: [number, number]; severity: "baseline";
  z: number[]; warped: number[]; flowValues: number[]; condition: number;
}

/** sample_joint(model, template_id, None, seed, temperature, severity) for the healthy baseline. */
export function sampleJointControls(model: JointModel, templateId: string, seed: number, temperature: number, severity: "auto" | "baseline" | "mild" | "moderate" | "severe" = "auto"): JointSample {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("The joint seed must be a whole number below 2^32.");
  if (!Number.isFinite(temperature) || temperature < 0.1 || temperature > 1.5) throw new Error("The joint temperature must lie between 0.1 and 1.5.");
  if (severity !== "auto" && severity !== "baseline") throw new Error("Healthy baseline does not have a disease severity band");
  const index = model.meta.conditions.findIndex((c) => c.template_id === templateId && c.profile_id === "baseline");
  if (index < 0) throw new Error("This reference is absent from the joint flow's training; choose another reference.");
  const condition = model.meta.conditions[index]!;
  const rng = new Pcg64(seed);
  const [seedA, seedB] = rng.uint32s(2) as [number, number];
  const z = rng.uniform(-1 + 1e-6, 1 - 1e-6, 22).map(f32);
  const warped = z.map((v) => f32(Math.tanh(f32(f32(Math.atanh(v)) * temperature))));
  const values = flowInverse(model, warped, condition, 0);
  // from_flow_controls (baseline: the disease columns are zero) then decode_controls
  const x = Array.from(values, (v) => clamp(v, -1, 1));
  for (let i = 13; i < 22; i++) x[i] = 0;
  const controls = Object.fromEntries(CONTROL_NAMES.map((name, i) => [name, x[i]!]));
  const m = x.slice(7, 13) as [number, number, number, number, number, number];
  const material: AtlasMaterialRecipe = {
    version: ATLAS_MATERIAL_VERSION, organ: condition.organ, preset: condition.material_preset, seed: seedA,
    tint: m[0], pigment_contrast: (m[1] + 1) / 2, mottle_scale_mm: 2 * 20 ** ((m[2] + 1) / 2), wetness: (m[3] + 1) / 2, fine_detail: (m[4] + 1) / 2, structure_strength: (m[5] + 1) / 2,
  };
  return { controls, material, rendererSeeds: [seedA, seedB], severity: "baseline", z, warped, flowValues: Array.from(values), condition: index };
}

/** The public copy's joint variation: sample here, realize here, and carry the provenance the API's route attaches. */
export async function sampleJointLocally(reference: AtlasGeneration, template: AtlasTemplate, spec: AtlasSpec, temperature: number, severity: "auto" | "mild" | "moderate" | "severe", signal?: AbortSignal): Promise<AtlasGeneration> {
  if (spec.disease) throw new Error(NEEDS_API.jointDisease);
  const model = await loadJointModel(signal);
  const sample = sampleJointControls(model, spec.template_id, spec.seed, temperature, severity);
  const target: AtlasSpec = { renderer_version: "disease-v2", template_id: spec.template_id, seed: spec.seed, controls: sample.controls, appearance: "tissue", material: sample.material };
  const generation = await realizeLocally(reference, target, template, signal);
  const provenance = {
    method: JOINT_METHOD, model_sha256: model.meta.model_sha256, template_id: spec.template_id, profile_id: null, request_seed: spec.seed, temperature, severity: "baseline",
    renderer_seeds: sample.rendererSeeds, scope: model.meta.scope, training_samples: model.meta.training_samples,
    disease_severity_is_clinical_stage: false, patient_distribution_learned: false, physics_learned: false,
    bundle_sha256: model.meta.bundle_sha256, model_generation: 2, request_severity_band: severity, material_seed: sample.material.seed, spatial_seed: null,
    sampled_by: { version: LOCAL_REALIZER_VERSION, scope: "public copy: the API's NumPy spline flow repeated in the browser (float32), the result realized here", colour_noise_seed: reference.spec.seed },
  };
  generation.summary.joint_model = provenance;
  (generation.scene.metadata as Record<string, unknown>).joint_model = provenance;
  return generation;
}
