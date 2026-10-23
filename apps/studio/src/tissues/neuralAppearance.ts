import { validateModelArrayLayout, type ModelArraySpec } from "../modelArrayLayout";
import { createSpatialSampler, parseSpatialAppearanceModel, SPATIAL_APPEARANCE_SCHEMA, type SpatialAppearanceModel } from "./neuralAppearanceConv";
export { SPATIAL_APPEARANCE_SCHEMA } from "./neuralAppearanceConv";

/** This decoder predicts observed RGB appearance. It has no intrinsic PBR output. */
export const APPEARANCE_SCHEMA = "viscera.tissue-appearance-decoder/v1";
export const AXIAL_FOURIER_ORDER = "frequency-major:sin(2pi*f*u),cos(2pi*f*u),sin(2pi*f*v),cos(2pi*f*v)";
export const DIRECTIONAL_APPEARANCE_SCHEMA = "viscera.tissue-appearance-decoder/v2";
export const DIRECTIONAL_FOURIER_ORDER = "vector-major:sin(2pi*(kx*u+ky*v)),cos(2pi*(kx*u+ky*v))";
export const MAX_MODEL_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_BAKE_RESOLUTION = 512;
export interface AppearanceArchitecture {
  latent_dim: number;
  hidden_width: number;
  hidden_layers: number;
  frequencies?: number[];
  fourier_vectors?: [number, number][];
  fourier_order?: string;
  condition_labels: string[];
  condition_regions: string[];
  condition_species: string[];
  input_order: string;
  activation: string;
  output_activation: string;
}
interface PackedTensor { name: string; shape: number[]; offset_bytes: number; length_bytes: number }
export interface AppearanceArtifact {
  schema: string;
  model_type: string;
  architecture: AppearanceArchitecture;
  weights: { encoding: string; sha256: string; byte_length: number; data_base64: string; tensors: PackedTensor[] };
  output: { kind: string; color_space: string; channels: string[]; binding: string; pbr_ground_truth: boolean; clinically_validated?: boolean };
  provenance: Record<string, unknown>;
  seed_algorithm: string;
  reference: { latent: number[]; condition_index: number; uv: number[][]; rgb: number[][] };
  seed_reference: { seed: string; latent: number[] };
}
interface DenseLayer { weights: Float32Array; bias: Float32Array; inputs: number; outputs: number }
type FourierEncoding = { kind: "axial"; frequencies: number[] } | { kind: "directional"; vectors: [number, number][] };
export interface FourierAppearanceModel { kind: "fourier"; artifact: AppearanceArtifact; layers: DenseLayer[]; modelId: string; encoding: FourierEncoding }
export type AppearanceModel = FourierAppearanceModel | SpatialAppearanceModel;
const f32 = Math.fround;
const fail = (message: string): never => { throw new Error(`Tissue model: ${message}`); };
const integer = (n: unknown, lo: number, hi: number): n is number => Number.isSafeInteger(n) && (n as number) >= lo && (n as number) <= hi;
const vector = (v: unknown, length: number, bound = 1e5): v is number[] => Array.isArray(v) && v.length === length && v.every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= bound);
const strings = (v: unknown, length: number) => Array.isArray(v) && v.length === length && v.every(s => typeof s === "string" && s.length > 0 && s.length <= 256);

function validateFourierEncoding(artifact: AppearanceArtifact): FourierEncoding {
  const a = artifact.architecture;
  if (!a || artifact.seed_algorithm !== "sha256-box-muller-f32-v1") fail("unsupported model type");
  if (artifact.schema === APPEARANCE_SCHEMA && artifact.model_type === "masked-rgb-periodic-cvae-v1") {
    const frequencies = a.frequencies;
    if (!Array.isArray(frequencies) || !integer(frequencies.length, 1, 12)
      || !frequencies.every((n, i) => integer(n, 1, 128) && (i === 0 || n > frequencies[i - 1]!))
      || a.fourier_vectors !== undefined || (a.fourier_order !== undefined && a.fourier_order !== AXIAL_FOURIER_ORDER)) return fail("unsupported axial Fourier architecture");
    return { kind: "axial", frequencies };
  }
  if (artifact.schema === DIRECTIONAL_APPEARANCE_SCHEMA && artifact.model_type === "masked-rgb-directional-cvae-gan-v1") {
    const vectors = a.fourier_vectors;
    if (!Array.isArray(vectors) || !integer(vectors.length, 1, 32)
      || !vectors.every(v => Array.isArray(v) && v.length === 2 && v.every(n => integer(n, -32, 32))
        && !(v[0] === 0 && v[1] === 0) && v[1]! >= 0 && !(v[1] === 0 && v[0]! < 0))
      || new Set(vectors.map(v => `${v[0]},${v[1]}`)).size !== vectors.length
      || a.frequencies !== undefined || a.fourier_order !== DIRECTIONAL_FOURIER_ORDER) return fail("unsupported directional Fourier architecture");
    return { kind: "directional", vectors };
  }
  return fail("unsupported model type");
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length); copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy))].map(n => n.toString(16).padStart(2, "0")).join("");
}

export function canonicalAppearanceSeed(seed: string): string {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(seed) || BigInt(seed) > 18446744073709551615n) fail("seed must be an unsigned 64-bit decimal integer");
  return seed;
}

/** SHA-256 + Box–Muller v1: independent of Python/JS platform RNG implementations. */
export async function appearanceLatent(seed: string, dimensions: number): Promise<Float32Array> {
  canonicalAppearanceSeed(seed);
  if (!integer(dimensions, 2, 1024)) fail("invalid latent dimensions");
  const z = new Float32Array(dimensions);
  for (let pair = 0; pair < Math.ceil(dimensions / 2); pair++) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`viscera-tissue-latent-v1:${seed}:${pair}`));
    const view = new DataView(digest);
    const a = (view.getUint32(0, false) + .5) / 4294967296, b = (view.getUint32(4, false) + .5) / 4294967296;
    const radius = Math.sqrt(-2 * Math.log(a)), angle = 2 * Math.PI * b;
    z[pair * 2] = radius * Math.cos(angle);
    if (pair * 2 + 1 < dimensions) z[pair * 2 + 1] = radius * Math.sin(angle);
  }
  return z;
}

/** Closed operator inventory; imported models cannot supply executable code or fetch URLs. */
export async function parseAppearanceModel(source: string): Promise<AppearanceModel> {
  if (source.length > MAX_MODEL_FILE_BYTES || !source.length) fail("file is empty or too large");
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { return fail("invalid JSON file"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("expected an object");
  if ((raw as { schema?: unknown }).schema === SPATIAL_APPEARANCE_SCHEMA) return parseSpatialAppearanceModel(raw, source, { sha256, appearanceLatent });
  const artifact = raw as AppearanceArtifact, a = artifact.architecture, w = artifact.weights;
  const encoding = validateFourierEncoding(artifact), directional = encoding.kind === "directional";
  if (!a || !integer(a.latent_dim, 2, 128) || !integer(a.hidden_width, 8, 256) || a.hidden_layers !== 3
    || !Array.isArray(a.condition_labels) || !integer(a.condition_labels.length, 1, directional ? 64 : 128)
    || !strings(a.condition_labels, a.condition_labels.length) || new Set(a.condition_labels).size !== a.condition_labels.length
    || !strings(a.condition_regions, a.condition_labels.length) || !strings(a.condition_species, a.condition_labels.length)
    || a.input_order !== "latent,condition_one_hot,uv_fourier" || a.activation !== "silu" || a.output_activation !== "sigmoid") fail("unsupported architecture");
  if (!artifact.output || artifact.output.kind !== "observed_rgb_appearance" || artifact.output.color_space !== "srgb"
    || JSON.stringify(artifact.output.channels) !== '["r","g","b"]' || artifact.output.binding !== "fixed-rest-uv"
    || artifact.output.pbr_ground_truth !== false || (directional && artifact.output.clinically_validated !== false)) fail("unsupported appearance semantics");
  const p = artifact.provenance;
  if (!p || p.qualification !== "engineering_unqualified" || !integer(p.training_steps, 1, 1e9)
    || !["fixture_trained", "research_trained"].includes(String(p.training_status)) || !integer(p.training_native_patch_size, 16, 1024)
    || ![p.dataset_manifest_sha256, p.split_manifest_sha256, p.config_sha256].every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))) fail("missing experimental model provenance");
  if (directional && (p.training_native_patch_size !== 128 || p.training_source_crop_size !== 128 || p.critic_exported !== false)) fail("unsupported directional training provenance");
  if (!w || w.encoding !== "base64-f32le" || !/^[a-f0-9]{64}$/.test(w.sha256) || !integer(w.byte_length, 1, directional ? 16_000_000 : MAX_MODEL_FILE_BYTES / 2)
    || typeof w.data_base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(w.data_base64)
    || w.data_base64.length !== Math.ceil(w.byte_length / 3) * 4 || !Array.isArray(w.tensors)) fail("invalid weight payload");
  const expected: Record<string, ModelArraySpec> = {};
  let inputs = a.latent_dim + a.condition_labels.length + (encoding.kind === "axial" ? 4 * encoding.frequencies.length : 2 * encoding.vectors.length);
  for (let i = 0; i <= a.hidden_layers; i++) {
    const outputs = i === a.hidden_layers ? 3 : a.hidden_width;
    expected[`layers.${i}.weight`] = { dtype: "<f4", shape: [outputs, inputs] };
    expected[`layers.${i}.bias`] = { dtype: "<f4", shape: [outputs] };
    inputs = outputs;
  }
  for (const t of w.tensors) {
    if (!t || !Array.isArray(t.shape) || !integer(t.length_bytes, 4, w.byte_length)
      || t.length_bytes !== t.shape.reduce((x, n) => x * n, 4)) fail("invalid tensor size");
  }
  validateModelArrayLayout(w.tensors.map(t => ({ name: t.name, shape: t.shape, offset: t.offset_bytes, dtype: "<f4" })), w.byte_length, w.byte_length, expected);
  let binary: string;
  try { binary = atob(w.data_base64); } catch { return fail("invalid base64 weights"); }
  if (binary.length !== w.byte_length) fail("weight length mismatch");
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (await sha256(bytes) !== w.sha256) fail("weight checksum mismatch");
  const view = new DataView(bytes.buffer), tensors = new Map<string, Float32Array>();
  for (const t of w.tensors) {
    const values = new Float32Array(t.length_bytes / 4);
    for (let i = 0; i < values.length; i++) {
      const value = view.getFloat32(t.offset_bytes + i * 4, true);
      if (!Number.isFinite(value) || Math.abs(value) > 1e5) fail("non-finite or excessive weights");
      values[i] = value;
    }
    tensors.set(t.name, values);
  }
  const layers: DenseLayer[] = [];
  for (let i = 0; i <= a.hidden_layers; i++) {
    const spec = expected[`layers.${i}.weight`]!;
    layers.push({ weights: tensors.get(`layers.${i}.weight`)!, bias: tensors.get(`layers.${i}.bias`)!, outputs: spec.shape[0]!, inputs: spec.shape[1]! });
  }
  // Identity includes architecture, vocabulary and provenance, not only tensor bytes.
  const model: FourierAppearanceModel = { kind: "fourier", artifact, layers, encoding, modelId: await sha256(new TextEncoder().encode(source)) };
  const r = artifact.reference, sr = artifact.seed_reference;
  if (!r || !vector(r.latent, a.latent_dim) || !integer(r.condition_index, 0, a.condition_labels.length - 1)
    || !Array.isArray(r.uv) || !integer(r.uv.length, 2, 32) || !Array.isArray(r.rgb) || r.rgb.length !== r.uv.length) fail("missing decoder parity reference");
  for (let i = 0; i < r.uv.length; i++) {
    if (!vector(r.uv[i], 2, 2) || !vector(r.rgb[i], 3, 1) || r.rgb[i]!.some(v => v < 0)) fail("invalid decoder reference");
    const actual = decodeAppearance(model, r.latent, r.condition_index, r.uv[i]![0]!, r.uv[i]![1]!);
    if (actual.some((v, j) => Math.abs(v - r.rgb[i]![j]!) > 3e-5)) fail("decoder parity check failed");
  }
  if (!sr || typeof sr.seed !== "string" || !vector(sr.latent, a.latent_dim)) fail("missing portable seed reference");
  const expectedLatent = await appearanceLatent(sr.seed, a.latent_dim);
  if (expectedLatent.some((v, i) => Math.abs(v - sr.latent[i]!) > 1e-6)) fail("portable seed check failed");
  return model;
}

function activate(value: number, final: boolean) {
  if (!Number.isFinite(value)) fail("non-finite decoder activation");
  const sigmoid = value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
  return f32(final ? sigmoid : value * sigmoid);
}

/** The pure decoder is independently compared with exported PyTorch/NumPy vectors. */
export function decodeAppearance(model: AppearanceModel, latent: ArrayLike<number>, condition: number, u: number, v: number): Float32Array {
  return createAppearanceSampler(model, latent, condition)(u, v).slice();
}

/** Reuse scratch buffers and the invariant latent/condition projection across a bake. */
function createAppearanceSampler(model: AppearanceModel, latent: ArrayLike<number>, condition: number) {
  if (model.kind === "spatial") return createSpatialSampler(model, latent, condition);
  const a = model.artifact.architecture;
  if (latent.length !== a.latent_dim || !Array.from(latent).every(Number.isFinite) || !integer(condition, 0, a.condition_labels.length - 1)) fail("invalid decoder input");
  const first = model.layers[0]!, featureOffset = a.latent_dim + a.condition_labels.length;
  const constants = new Float64Array(first.outputs), z = Float32Array.from(latent);
  for (let row = 0; row < first.outputs; row++) {
    let sum = 0;
    for (let col = 0; col < a.latent_dim; col++) sum += first.weights[row * first.inputs + col]! * z[col]!;
    constants[row] = sum + first.weights[row * first.inputs + a.latent_dim + condition]!;
  }
  const encoding = model.encoding;
  const features = new Float32Array(encoding.kind === "axial" ? 4 * encoding.frequencies.length : 2 * encoding.vectors.length);
  const scratch = model.layers.map(layer => new Float32Array(layer.outputs));
  const scales = encoding.kind === "axial" ? encoding.frequencies.map(frequency => f32(2 * Math.PI * frequency)) : [];
  const tau = f32(2 * Math.PI);
  return (u: number, v: number) => {
    if (!Number.isFinite(u) || !Number.isFinite(v) || Math.abs(u) > 2 || Math.abs(v) > 2) fail("invalid decoder input");
    let offset = 0;
    if (encoding.kind === "axial") {
      // Keep the v1 float32 operation order unchanged for existing exports.
      for (const scale of scales) {
        const au = f32(scale * f32(u)), av = f32(scale * f32(v));
        features[offset++] = Math.sin(au); features[offset++] = Math.cos(au); features[offset++] = Math.sin(av); features[offset++] = Math.cos(av);
      }
    } else {
      // Match the exported Torch/NumPy vector-major float32 dot, then angle.
      const u32 = f32(u), v32 = f32(v);
      for (const [kx, ky] of encoding.vectors) {
        const angle = f32(f32(f32(kx * u32) + f32(ky * v32)) * tau);
        features[offset++] = Math.sin(angle); features[offset++] = Math.cos(angle);
      }
    }
    for (let row = 0; row < first.outputs; row++) {
      let sum = constants[row]!;
      for (let col = 0; col < features.length; col++) sum += first.weights[row * first.inputs + featureOffset + col]! * features[col]!;
      scratch[0]![row] = activate(f32(sum + first.bias[row]!), false);
    }
    for (let index = 1; index < model.layers.length; index++) {
      const layer = model.layers[index]!, x = scratch[index - 1]!, y = scratch[index]!;
      for (let row = 0; row < layer.outputs; row++) {
        let sum = 0;
        for (let col = 0; col < layer.inputs; col++) sum += layer.weights[row * layer.inputs + col]! * x[col]!;
        y[row] = activate(f32(sum + layer.bias[row]!), index === model.layers.length - 1);
      }
    }
    return scratch[scratch.length - 1]!;
  };
}

export function validateBakeResolution(model: AppearanceModel, resolution: number): void {
  if (!integer(resolution, 16, MAX_BAKE_RESOLUTION) || (resolution & (resolution - 1)) !== 0) fail("browser bake resolution must be a power of two from 16 to 512");
  // Spatial work is bounded once at import; larger bakes only resample native128.
  if (model.kind === "spatial") return;
  const operations = model.layers.reduce((total, layer) => total + layer.inputs * layer.outputs, 0) * resolution * resolution;
  if (operations > 9e9) fail("this decoder is too large for the selected browser bake; choose a smaller resolution or export maps from Colab");
}

export function bakeAppearanceRows(model: AppearanceModel, latent: ArrayLike<number>, condition: number, resolution: number, startRow: number, endRow: number, rgba: Uint8Array): void {
  validateBakeResolution(model, resolution);
  if (!integer(startRow, 0, resolution) || !integer(endRow, startRow, resolution) || rgba.length !== resolution * resolution * 4) fail("invalid bake row range");
  const sample = createAppearanceSampler(model, latent, condition);
  for (let y = startRow; y < endRow; y++) for (let x = 0; x < resolution; x++) {
    const rgb = sample((x + .5) / resolution, (y + .5) / resolution), index = (y * resolution + x) * 4;
    rgba[index] = Math.round(rgb[0]! * 255); rgba[index + 1] = Math.round(rgb[1]! * 255); rgba[index + 2] = Math.round(rgb[2]! * 255); rgba[index + 3] = 255;
  }
}
