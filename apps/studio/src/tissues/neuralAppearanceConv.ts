import { validateModelArrayLayout, type ModelArraySpec } from "../modelArrayLayout";
import type { AppearanceArchitecture, AppearanceArtifact } from "./neuralAppearance";

export const SPATIAL_APPEARANCE_SCHEMA = "viscera.tissue-appearance-decoder/v3";
export const MAX_SPATIAL_MACS = 300_000_000;
const NATIVE = 128, f32 = Math.fround;
const fail = (message: string): never => { throw new Error(`Tissue model: ${message}`); };
const integer = (value: unknown, low: number, high: number): value is number => Number.isSafeInteger(value) && (value as number) >= low && (value as number) <= high;
const exact = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const vector = (value: unknown, length: number, bound = 1e5): value is number[] => Array.isArray(value) && value.length === length && value.every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= bound);
const strings = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every(s => typeof s === "string" && s.length > 0 && s.length <= 256);

export interface SpatialAppearanceArchitecture extends Omit<AppearanceArchitecture, "hidden_width" | "hidden_layers" | "frequencies" | "fourier_vectors" | "fourier_order"> {
  latent_shape: [number, number, number];
  decoder_channels: number[];
  native_resolution: [number, number];
  padding: string;
  upsample: string;
  upsample_before_layers: number[];
  weight_layout: string;
  kernel_size: number;
  output_sampling: string;
}
export interface SpatialAppearanceArtifact extends Omit<AppearanceArtifact, "architecture" | "reference" | "output"> {
  architecture: SpatialAppearanceArchitecture;
  reference: { latent: number[]; condition_index: number; pixels_xy: number[][]; rgb: number[][] };
  output: AppearanceArtifact["output"] & { native_resolution: [number, number] };
}
export interface ConvLayer { weights: Float32Array; bias: Float32Array; inputs: number; outputs: number }
export interface SpatialAppearanceModel {
  kind: "spatial";
  artifact: SpatialAppearanceArtifact;
  layers: ConvLayer[];
  encoding: { kind: "spatial" };
  modelId: string;
  nativeMacs: number;
}
interface IdentityHelpers {
  sha256: (bytes: Uint8Array) => Promise<string>;
  appearanceLatent: (seed: string, dimensions: number) => Promise<Float32Array>;
}

/** Closed native128 operator inventory. No graph, code or URL is imported. */
export async function parseSpatialAppearanceModel(raw: unknown, source: string, helpers: IdentityHelpers): Promise<SpatialAppearanceModel> {
  const artifact = raw as SpatialAppearanceArtifact, a = artifact.architecture, w = artifact.weights;
  if (artifact.schema !== SPATIAL_APPEARANCE_SCHEMA || artifact.model_type !== "masked-rgb-spatial-cvae-gan-v1" || artifact.seed_algorithm !== "sha256-box-muller-f32-v1") fail("unsupported spatial model type");
  if (!a || !Array.isArray(a.latent_shape) || a.latent_shape.length !== 3 || !integer(a.latent_shape[0], 2, 16)
    || a.latent_shape[1] !== 8 || a.latent_shape[2] !== 8 || a.latent_dim !== a.latent_shape[0] * 64
    || !Array.isArray(a.decoder_channels) || a.decoder_channels.length !== 5 || !a.decoder_channels.every(v => integer(v, 4, 128))
    || !Array.isArray(a.condition_labels) || !integer(a.condition_labels.length, 1, 64)
    || !strings(a.condition_labels, a.condition_labels.length) || new Set(a.condition_labels).size !== a.condition_labels.length
    || !strings(a.condition_regions, a.condition_labels.length) || !strings(a.condition_species, a.condition_labels.length)) fail("unsupported spatial architecture");
  for (const [key, expected] of Object.entries({ native_resolution: [128, 128], input_order: "latent_chw,condition_one_hot_broadcast", padding: "circular", upsample: "nearest-repeat-2", upsample_before_layers: [1, 3, 5, 7], activation: "silu", output_activation: "sigmoid", weight_layout: "OIHW", kernel_size: 3, output_sampling: "periodic-bilinear-pixel-centers" })) {
    if (!exact((a as unknown as Record<string, unknown>)[key], expected)) fail("unsupported spatial decoder operations");
  }
  if (["frequencies", "fourier_vectors", "fourier_order", "hidden_width", "hidden_layers"].some(key => key in a)) fail("ambiguous spatial architecture");
  if (!artifact.output || artifact.output.kind !== "observed_rgb_appearance" || artifact.output.color_space !== "srgb"
    || !exact(artifact.output.channels, ["r", "g", "b"]) || artifact.output.binding !== "fixed-rest-uv"
    || !exact(artifact.output.native_resolution, [128, 128]) || artifact.output.pbr_ground_truth !== false || artifact.output.clinically_validated !== false) fail("unsupported appearance semantics");
  const p = artifact.provenance;
  if (!p || p.qualification !== "engineering_unqualified" || !integer(p.training_steps, 1, 1e9)
    || !["fixture_trained", "research_trained"].includes(String(p.training_status)) || p.training_native_patch_size !== 128
    || p.training_source_crop_size !== 128 || !exact(p.native_decode_resolution, [128, 128]) || p.critic_exported !== false
    || ![p.dataset_manifest_sha256, p.split_manifest_sha256, p.config_sha256].every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))) fail("missing spatial training provenance");
  const widths = [a.latent_shape[0] + a.condition_labels.length, a.decoder_channels[0]!, ...a.decoder_channels.slice(1).flatMap(v => [v, v]), 3];
  let size = 8, nativeMacs = 0, byteOffset = 0;
  const expected: Record<string, ModelArraySpec> = {}, expectedTensors: { name: string; shape: number[]; offset_bytes: number; length_bytes: number }[] = [];
  for (let index = 0; index < 10; index++) {
    if ([1, 3, 5, 7].includes(index)) size *= 2;
    nativeMacs += size * size * widths[index]! * widths[index + 1]! * 9;
    for (const [suffix, shape] of [["weight", [widths[index + 1]!, widths[index]!, 3, 3]], ["bias", [widths[index + 1]!]]] as const) {
      const name = `layers.${index}.${suffix}`, length = shape.reduce((n, v) => n * v, 4);
      expected[name] = { dtype: "<f4", shape: [...shape] };
      expectedTensors.push({ name, shape: [...shape], offset_bytes: byteOffset, length_bytes: length }); byteOffset += length;
    }
  }
  // Bound inference before hashing, allocating tensors or executing parity references.
  if (nativeMacs > MAX_SPATIAL_MACS) fail("spatial decoder exceeds the browser native inference budget");
  if (!w || w.encoding !== "base64-f32le" || !/^[a-f0-9]{64}$/.test(w.sha256) || !integer(w.byte_length, 1, 16_000_000)
    || w.byte_length !== byteOffset || typeof w.data_base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(w.data_base64)
    || w.data_base64.length !== Math.ceil(w.byte_length / 3) * 4 || !Array.isArray(w.tensors) || w.tensors.length !== 20) fail("invalid spatial weight payload");
  for (let i = 0; i < 20; i++) {
    const actual = w.tensors[i]!, spec = expectedTensors[i]!;
    if (!actual || !exact(Object.keys(actual).sort(), ["length_bytes", "name", "offset_bytes", "shape"])
      || actual.name !== spec.name || !exact(actual.shape, spec.shape) || actual.offset_bytes !== spec.offset_bytes || actual.length_bytes !== spec.length_bytes) fail("spatial tensor order/shape/offset mismatch");
  }
  validateModelArrayLayout(w.tensors.map(t => ({ name: t.name, shape: t.shape, offset: t.offset_bytes, dtype: "<f4" })), w.byte_length, w.byte_length, expected);
  let binary: string;
  try { binary = atob(w.data_base64); } catch { return fail("invalid base64 weights"); }
  if (binary.length !== w.byte_length) fail("weight length mismatch");
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (await helpers.sha256(bytes) !== w.sha256) fail("weight checksum mismatch");
  const view = new DataView(bytes.buffer), arrays: Float32Array[] = [];
  for (const t of w.tensors) {
    const values = new Float32Array(t.length_bytes / 4);
    for (let i = 0; i < values.length; i++) {
      const value = view.getFloat32(t.offset_bytes + i * 4, true);
      if (!Number.isFinite(value) || Math.abs(value) > 1e5) fail("non-finite or excessive weights");
      values[i] = value;
    }
    arrays.push(values);
  }
  const layers = Array.from({ length: 10 }, (_, i) => ({ weights: arrays[i * 2]!, bias: arrays[i * 2 + 1]!, inputs: widths[i]!, outputs: widths[i + 1]! }));
  const model: SpatialAppearanceModel = { kind: "spatial", artifact, layers, encoding: { kind: "spatial" }, nativeMacs, modelId: await helpers.sha256(new TextEncoder().encode(source)) };
  const r = artifact.reference, sr = artifact.seed_reference;
  if (!r || !vector(r.latent, a.latent_dim) || !integer(r.condition_index, 0, a.condition_labels.length - 1)
    || !Array.isArray(r.pixels_xy) || !integer(r.pixels_xy.length, 2, 32) || !Array.isArray(r.rgb) || r.rgb.length !== r.pixels_xy.length) fail("missing spatial decoder parity reference");
  for (let i = 0; i < r.pixels_xy.length; i++) if (!Array.isArray(r.pixels_xy[i]) || r.pixels_xy[i]!.length !== 2
    || !r.pixels_xy[i]!.every(n => integer(n, 0, 127)) || !vector(r.rgb[i], 3, 1) || r.rgb[i]!.some(n => n < 0)) fail("invalid spatial decoder reference");
  if (!sr || typeof sr.seed !== "string" || !vector(sr.latent, a.latent_dim)) fail("missing portable seed reference");
  const expectedLatent = await helpers.appearanceLatent(sr.seed, a.latent_dim);
  if (expectedLatent.some((v, i) => Math.abs(v - sr.latent[i]!) > 1e-6)) fail("portable seed check failed");
  const native = decodeSpatialNative(model, r.latent, r.condition_index);
  for (let i = 0; i < r.pixels_xy.length; i++) {
    const [x, y] = r.pixels_xy[i]!;
    if (r.rgb[i]!.some((value, c) => Math.abs(native[(y! * NATIVE + x!) * 3 + c]! - value) > 3e-5)) fail("spatial decoder parity check failed");
  }
  return model;
}

function activate(value: number, final: boolean) {
  if (!Number.isFinite(value)) fail("non-finite decoder activation");
  const sigmoid = value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
  return f32(final ? sigmoid : value * sigmoid);
}

// One native image per model; repeated row batches cannot repeat the expensive decode.
const cache = new WeakMap<SpatialAppearanceModel, { latent: Float32Array; condition: number; rgb: Float32Array }>();
export function decodeSpatialNative(model: SpatialAppearanceModel, latent: ArrayLike<number>, condition: number): Float32Array {
  return cachedNative(model, latent, condition).slice();
}
function cachedNative(model: SpatialAppearanceModel, latent: ArrayLike<number>, condition: number): Float32Array {
  const a = model.artifact.architecture;
  if (latent.length !== a.latent_dim || !Array.from(latent).every(v => Number.isFinite(v) && Math.abs(v) <= 1e5) || !integer(condition, 0, a.condition_labels.length - 1)) fail("invalid decoder input");
  const previous = cache.get(model);
  if (previous && previous.condition === condition && previous.latent.every((v, i) => v === f32(latent[i]!))) return previous.rgb;
  const z = Float32Array.from(latent);
  let size = 8, value = new Float32Array((a.latent_shape[0] + a.condition_labels.length) * 64);
  value.set(z); value.fill(1, z.length + condition * 64, z.length + (condition + 1) * 64);
  for (let index = 0; index < model.layers.length; index++) {
    const layer = model.layers[index]!;
    if ([1, 3, 5, 7].includes(index)) {
      const nextSize = size * 2, up = new Float32Array(layer.inputs * nextSize * nextSize);
      for (let c = 0; c < layer.inputs; c++) for (let y = 0; y < nextSize; y++) for (let x = 0; x < nextSize; x++) up[(c * nextSize + y) * nextSize + x] = value[(c * size + (y >> 1)) * size + (x >> 1)]!;
      value = up; size = nextSize;
    }
    const plane = size * size, next = new Float32Array(layer.outputs * plane);
    const before = new Int32Array(size), after = new Int32Array(size);
    for (let i = 0; i < size; i++) { before[i] = (i + size - 1) % size; after[i] = (i + 1) % size; }
    for (let o = 0; o < layer.outputs; o++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let c = 0; c < layer.inputs; c++) {
        const row0 = c * plane + before[y]! * size, row1 = c * plane + y * size, row2 = c * plane + after[y]! * size;
        const w = (o * layer.inputs + c) * 9, x0 = before[x]!, x2 = after[x]!;
        sum += value[row0 + x0]! * layer.weights[w]!;
        sum += value[row0 + x]! * layer.weights[w + 1]!;
        sum += value[row0 + x2]! * layer.weights[w + 2]!;
        sum += value[row1 + x0]! * layer.weights[w + 3]!;
        sum += value[row1 + x]! * layer.weights[w + 4]!;
        sum += value[row1 + x2]! * layer.weights[w + 5]!;
        sum += value[row2 + x0]! * layer.weights[w + 6]!;
        sum += value[row2 + x]! * layer.weights[w + 7]!;
        sum += value[row2 + x2]! * layer.weights[w + 8]!;
      }
      next[(o * size + y) * size + x] = activate(f32(sum + layer.bias[o]!), index === 9);
    }
    value = next;
  }
  const rgb = new Float32Array(NATIVE * NATIVE * 3);
  for (let i = 0; i < NATIVE * NATIVE; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = value[c * NATIVE * NATIVE + i]!;
  cache.set(model, { latent: z, condition, rgb });
  return rgb;
}

/** Explicit sampling of learned native128 pixels, never newly inferred high-resolution detail. */
export function createSpatialSampler(model: SpatialAppearanceModel, latent: ArrayLike<number>, condition: number) {
  const native = cachedNative(model, latent, condition), rgb = new Float32Array(3);
  return (u: number, v: number) => {
    if (![u, v].every(n => Number.isFinite(n) && Math.abs(n) <= 2)) fail("invalid decoder input");
    const u32 = f32(u), v32 = f32(v), x = f32(f32(f32(u32 - Math.floor(u32)) * NATIVE) - .5), y = f32(f32(f32(v32 - Math.floor(v32)) * NATIVE) - .5);
    const lowX = Math.floor(x), lowY = Math.floor(y), dx = f32(x - lowX), dy = f32(y - lowY);
    const x0 = (lowX + NATIVE) % NATIVE, y0 = (lowY + NATIVE) % NATIVE, x1 = (x0 + 1) % NATIVE, y1 = (y0 + 1) % NATIVE;
    for (let c = 0; c < 3; c++) {
      const top = f32(f32(native[(y0 * NATIVE + x0) * 3 + c]! * f32(1 - dx)) + f32(native[(y0 * NATIVE + x1) * 3 + c]! * dx));
      const bottom = f32(f32(native[(y1 * NATIVE + x0) * 3 + c]! * f32(1 - dx)) + f32(native[(y1 * NATIVE + x1) * 3 + c]! * dx));
      rgb[c] = f32(f32(top * f32(1 - dy)) + f32(bottom * dy));
    }
    return rgb;
  };
}
