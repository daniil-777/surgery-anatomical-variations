/** The learned disease variation in the browser: the proposal step of the API's /api/atlas/sample-disease
 *  (services.api.atlas_disease_model.sample_recipe_model → pipelines.train.viscera_train.atlas_disease.sample_recipes)
 *  repeated in TypeScript on the exported decoder (public/models/disease-recipes-v2, written by scripts/export_disease_web.py;
 *  public/models/disease-v2 is the morphology renderer's support data).
 *  numpy's generator gives the eight normal draws and the spatial seed (numpyRandom.ts); the conditional VAE decoder
 *  runs in float32 as the API's NumPy does; the count column snaps to sevenths and the row is clipped to the profile's
 *  training support before decode_recipe widens it to doubles. The result is the DiseaseSpec the route puts in
 *  spec.disease and the provenance record it attaches as summary.disease_model; the morphology is the disease
 *  renderer's work (atlasDiseaseLocal.ts), which sampleDiseaseLocally hands the proposal to, as the route does.
 *  atlasDiseaseSampler.test.ts replays the API's own proposals. */
import { publicUrl } from "./api";
import type { AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";
import type { AtlasDiseaseLibrary, AtlasDiseaseSpec } from "./atlasDisease";
import { realizeDiseaseLocally } from "./atlasDiseaseLocal";
import { Pcg64 } from "./numpyRandom";

export const DISEASE_WEB_FORMAT = "viscera-disease-recipe-model-v1-web";
export const DISEASE_METHOD = "conditional_vae";
/** The route's 422 texts, word for word, so the public copy refuses as the API does. */
export const DISEASE_SAMPLER_MESSAGES = {
  noProfile: "Choose a disease profile before sampling",
  unsupported: "Disease profile is not supported by this trained model",
  seed: "Seed must be uint32",
} as const;

export interface DiseaseModelMeta {
  format: string; method: string; model_sha256: string; bundle_sha256: string | null; recipe_release_sha256: string;
  source_sha256: string; catalog_sha256: string; profile_sha256: string; dataset_hashes: Record<string, string>;
  config: { latent: number; hidden: number; embedding: number };
  feature_names: string[]; profiles: string[]; profile_organs: Record<string, string>;
  scope: string; patient_count: number; training_recipe_count: number; requires_geometry_validation: boolean;
  environment: Record<string, string>;
  arrays: { name: string; shape: number[]; offset: number }[]; float32_values: number;
}
interface Tensor { data: Float32Array; shape: number[] }
export interface DiseaseModel { meta: DiseaseModelMeta; arrays: Map<string, Tensor> }

/** The record the route attaches as summary.disease_model and scene.metadata.disease_model. */
export interface DiseaseModelProvenance {
  method: string; model_sha256: string; recipe_release_sha256: string; profile_id: string; request_seed: number; spatial_seed: number;
  scope: string; patient_count: number; training_recipe_count: number; requires_geometry_validation: boolean;
}
export interface DiseaseSample {
  disease: AtlasDiseaseSpec; model: DiseaseModelProvenance;
  /** the stages, for tests: numpy's normals (float64), the decoder's float32 output, the final float32 row */
  latent: number[]; decoded: number[]; values: number[];
}

const FEATURES = 9;

export function parseDiseaseModel(meta: DiseaseModelMeta, weights: ArrayBuffer): DiseaseModel {
  if (meta.format !== DISEASE_WEB_FORMAT || meta.method !== DISEASE_METHOD) throw new Error("Unsupported disease model export.");
  if (weights.byteLength !== meta.float32_values * 4) throw new Error("The disease weights do not match their layout.");
  const all = new Float32Array(weights);
  const arrays = new Map<string, Tensor>();
  for (const entry of meta.arrays) {
    const size = entry.shape.reduce((a, b) => a * b, 1);
    const data = all.subarray(entry.offset, entry.offset + size);
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) throw new Error(`Disease weights are not finite: ${entry.name}`);
    arrays.set(entry.name, { data, shape: entry.shape });
  }
  // load_recipe_model's checks: a vocabulary without repeats, the decoder's shapes, the support inside [0, 1]
  const profiles = meta.profiles.length, { latent, hidden, embedding } = meta.config;
  if (!profiles || new Set(meta.profiles).size !== profiles || meta.feature_names.length !== FEATURES) throw new Error("Invalid disease recipe model vocabulary");
  const expected: [string, number[]][] = [
    ["embedding.weight", [profiles, embedding]], ["decoder.0.weight", [hidden, latent + embedding]], ["decoder.0.bias", [hidden]],
    ["decoder.2.weight", [hidden, hidden]], ["decoder.2.bias", [hidden]], ["decoder.4.weight", [FEATURES, hidden]], ["decoder.4.bias", [FEATURES]],
    ["support.min", [profiles, FEATURES]], ["support.max", [profiles, FEATURES]],
  ];
  for (const [name, shape] of expected) {
    const t = arrays.get(name);
    if (!t || t.shape.length !== shape.length || t.shape.some((n, i) => n !== shape[i])) throw new Error(`Malformed disease decoder parameter: ${name}`);
  }
  const low = arrays.get("support.min")!.data, high = arrays.get("support.max")!.data;
  for (let i = 0; i < low.length; i++) if (low[i]! < 0 || high[i]! > 1 || low[i]! > high[i]!) throw new Error("Malformed disease recipe model training support");
  return { meta, arrays };
}

let cachedMeta: Promise<DiseaseModelMeta> | null = null;
let cachedModel: Promise<DiseaseModel> | null = null;
/** The slim metadata alone (3 KB): enough to know the model is bundled and which profiles it can propose. */
export function diseaseModelInfo(signal?: AbortSignal): Promise<DiseaseModelMeta> {
  cachedMeta ??= fetch(publicUrl("models/disease-recipes-v2/model.json"), { cache: "default" }).then(async (response) => {
    if (!response.ok) throw new Error("The disease recipe model is not bundled with this copy.");
    const meta = await response.json() as DiseaseModelMeta;
    if (meta.format !== DISEASE_WEB_FORMAT) throw new Error("Unsupported disease model export.");
    return meta;
  }).catch((error) => { cachedMeta = null; throw error; });
  return cachedMeta;
}
/** Tests and tools that hold the model already (read from disk) hand it over instead of fetching. */
export function primeDiseaseModel(model: DiseaseModel): void { cachedMeta = Promise.resolve(model.meta); cachedModel = Promise.resolve(model); }
export function loadDiseaseModel(signal?: AbortSignal): Promise<DiseaseModel> {
  cachedModel ??= Promise.all([diseaseModelInfo(signal), fetch(publicUrl("models/disease-recipes-v2/weights.bin"), { cache: "default" }).then((response) => {
    if (!response.ok) throw new Error("The disease recipe weights are not bundled with this copy.");
    return response.arrayBuffer();
  })]).then(([meta, weights]) => parseDiseaseModel(meta, weights)).catch((error) => { cachedModel = null; throw error; });
  return cachedModel;
}

/** Whether the trained model proposes this profile (25 of the renderer's 60); the panel marks the others. */
export const diseaseProfileServable = (meta: DiseaseModelMeta, profileId: string): boolean => meta.profiles.includes(profileId);

// ---------------------------------------------------------------------------------------------- NumPy arithmetic
// Every float32 store below rounds as NumPy's float32 ufuncs do: a float64 product, sum or quotient of two float32
// values rounded once to float32 is the IEEE float32 operation itself.
const f32 = Math.fround;
const tensor = (model: DiseaseModel, name: string): Tensor => { const t = model.arrays.get(name); if (!t) throw new Error(`Disease model lacks ${name}`); return t; };
/** x @ W.T + b in float32: NumPy rounds the matmul (BLAS accumulates in float32 in its own order; the exact sum rounded
 *  once lands within a few ulps of it — four at most after all three layers in the fixtures), then rounds the bias add. */
function linear(model: DiseaseModel, x: ArrayLike<number>, prefix: string): Float32Array {
  const w = tensor(model, prefix + ".weight"), b = tensor(model, prefix + ".bias");
  const [out, inp] = w.shape as [number, number];
  if (x.length !== inp) throw new Error(`${prefix}: expected ${inp} inputs, got ${x.length}`);
  const y = new Float32Array(out);
  for (let o = 0; o < out; o++) { let acc = 0; const row = o * inp; for (let i = 0; i < inp; i++) acc += x[i]! * w.data[row + i]!; y[o] = f32(f32(acc) + b.data[o]!); }
  return y;
}
/** _sigmoid, each ufunc rounding to float32: 1 / (1 + exp(-clip(x, -60, 60))). */
const sigmoid1 = (v: number) => f32(1 / f32(1 + f32(Math.exp(-Math.min(60, Math.max(-60, v))))));
const silu1 = (v: number) => f32(v * sigmoid1(v));
/** np.rint: to the nearest integer, halves to the even one (Math.round takes them upward). */
const roundHalfEven = (v: number): number => { const r = Math.round(v); return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r; };

/** decode_latents for one row: z as float32 ‖ the profile's embedding → three linear layers, SiLU after the first two,
 *  sigmoid after the last. */
export function decodeLatent(model: DiseaseModel, profileIndex: number, z: ArrayLike<number>): Float32Array {
  const e = tensor(model, "embedding.weight"), width = e.shape[1]!;
  const x = Float32Array.from([...Array.from(z, f32), ...e.data.subarray(profileIndex * width, (profileIndex + 1) * width)]);
  const hidden = linear(model, linear(model, x, "decoder.0").map(silu1), "decoder.2").map(silu1);
  return linear(model, hidden, "decoder.4").map(sigmoid1);
}
/** _snap_count: the count column to sevenths, every step float32. */
function snapCount(row: Float32Array): Float32Array {
  const out = Float32Array.from(row);
  out[5] = roundHalfEven(f32(out[5]! * 7)) / 7;
  return out;
}
/** np.clip(values, x.min(0), x.max(0)) with x the profile's training recipes: proposals stay inside the training support. */
function clipToSupport(model: DiseaseModel, profileIndex: number, row: Float32Array): Float32Array {
  const low = tensor(model, "support.min").data, high = tensor(model, "support.max").data, base = profileIndex * FEATURES;
  return row.map((v, i) => Math.min(high[base + i]!, Math.max(low[base + i]!, v)));
}
/** viscera_core.atlas_disease_recipe_dataset.decode_recipe: a normalized row widened to doubles — the five controls as
 *  they are, the count back from sevenths, the location from [0, 1] to [-1, 1]; the keys in the API's order. The
 *  joint flow decodes its disease columns through it too (atlasJointLocal.ts). */
export function decodeRecipe(profileId: string, values: ArrayLike<number>, seed: number): AtlasDiseaseSpec {
  const x = Array.from(values);
  if (x.length !== FEATURES || x.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error("Expected nine finite normalized recipe controls");
  return {
    profile_id: profileId, seed, severity: x[0]!, size: x[1]!, spread: x[2]!, irregularity: x[3]!, contrast: x[4]!,
    count: roundHalfEven(x[5]! * 7) + 1, location: [x[6]! * 2 - 1, x[7]! * 2 - 1, x[8]! * 2 - 1],
  };
}

/** sample_recipes(model, profile_id, seed, count=1) and the route's provenance record. The request seed draws the
 *  normals and then the spatial seed from one generator, as the API does. */
export function sampleDiseaseRecipe(model: DiseaseModel, profileId: string, seed: number): DiseaseSample {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(DISEASE_SAMPLER_MESSAGES.seed);
  const { meta } = model;
  const index = meta.profiles.indexOf(profileId);
  if (index < 0) throw new Error(DISEASE_SAMPLER_MESSAGES.unsupported);
  const rng = new Pcg64(seed);
  const latent = rng.normal(0, 1, meta.config.latent);
  const decoded = decodeLatent(model, index, latent);
  const values = snapCount(clipToSupport(model, index, snapCount(decoded)));
  const spatialSeed = rng.integers(0, 2 ** 32); // integers(0, 2**32, size=1, dtype=uint64): one raw next_uint32
  const provenance: DiseaseModelProvenance = {
    method: meta.method, model_sha256: meta.model_sha256, recipe_release_sha256: meta.recipe_release_sha256, profile_id: profileId,
    request_seed: seed, spatial_seed: spatialSeed, scope: meta.scope, patient_count: meta.patient_count,
    training_recipe_count: meta.training_recipe_count, requires_geometry_validation: meta.requires_geometry_validation,
  };
  return { disease: decodeRecipe(profileId, values, spatialSeed), model: provenance, latent, decoded: Array.from(decoded), values: Array.from(values) };
}

/** The route's proposal for a request spec: sampled with the request seed (the studio sends spec.disease.seed), the
 *  spec the renderer then realizes — the request with its disease replaced and the realized id cleared — and the
 *  provenance to attach to the result. */
export function proposeDiseaseSpec(model: DiseaseModel, spec: AtlasSpec, requestSeed?: number): { spec: AtlasSpec; provenance: DiseaseModelProvenance } {
  if (!spec.disease) throw new Error(DISEASE_SAMPLER_MESSAGES.noProfile);
  const sample = sampleDiseaseRecipe(model, spec.disease.profile_id, requestSeed ?? spec.disease.seed);
  const target: AtlasSpec = { ...spec, disease: sample.disease };
  delete target.realized_id; // parse_spec({..., realized_id: None}): the realizer of the proposal assigns its own
  return { spec: target, provenance: sample.model };
}

/** summary.disease_model and scene.metadata.disease_model, as the route decorates the realized generation. */
export function attachDiseaseProvenance(generation: AtlasGeneration, provenance: DiseaseModelProvenance): AtlasGeneration {
  generation.summary.disease_model = provenance;
  (generation.scene.metadata as Record<string, unknown>).disease_model = provenance;
  return generation;
}

/** The public copy's learned disease variation, the route end to end: the proposal for the request's disease seed,
 *  realized by the disease-v2 renderer from the bundled reference, with the model's provenance attached. The route
 *  refuses a spec without a profile before it touches the model, so the refusal comes before the download here too. */
export async function sampleDiseaseLocally(reference: AtlasGeneration, template: AtlasTemplate, spec: AtlasSpec, library: AtlasDiseaseLibrary | undefined, signal?: AbortSignal): Promise<AtlasGeneration> {
  if (!spec.disease) throw new Error(DISEASE_SAMPLER_MESSAGES.noProfile);
  const model = await loadDiseaseModel(signal);
  const { spec: target, provenance } = proposeDiseaseSpec(model, spec);
  return attachDiseaseProvenance(await realizeDiseaseLocally(reference, target, template, library, signal), provenance);
}
