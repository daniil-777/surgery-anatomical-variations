/** The trained material sampler (POST /api/atlas/sample-material) in the browser: services.api.atlas_material_model.
 *  sample_material_model and the ridge path of pipelines.train.viscera_train.atlas_material.sample_recipe repeated in
 *  TypeScript on the exported model (public/models/material-v1, written by scripts/export_material_web.py from the
 *  model the API serves). The selected method is ridge, so sampling reads no neural weights. Without requested field
 *  statistics a proposal is one training design of the organ/preset group, drawn by numpy's generator (numpyRandom.ts);
 *  with them it is the ridge prediction for the requested statistics (the others held at the group's training mean)
 *  plus one drawn leave-one-out residual, redrawn while out of bounds. The six normalised controls become the recipe
 *  (controls_recipe). The route then realizes the recipe — here realizeSpecLocally, handed the reference with the
 *  vertex colours the API's surface realizer paints for that recipe — and measures the recipe's field statistics at the
 *  material release's fixed anchor points: viscera_core.atlas_materials.sample_material and
 *  atlas_material_dataset.field_summary repeated in float64 with NumPy's operation order (its pairwise sums, its
 *  sequential column sums, the fused multiply-adds of its matmul). atlasMaterialSampler.test.ts replays the API's own
 *  samples and compares with the running API. */
import type { OrganMesh } from "@viscera/render";
import { publicUrl } from "./api";
import type { AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";
import type { AtlasDiseaseLibrary } from "./atlasDisease";
import { realizeSpecLocally } from "./atlasDiseaseLocal";
import { LOCAL_REALIZER_VERSION, resolveMaterial } from "./atlasLocal";
import { ATLAS_MATERIAL_VERSION, validateAtlasMaterial, type AtlasMaterialPreset, type AtlasMaterialRecipe } from "./atlasMaterial";
import { fma } from "./fusedMultiplyAdd";
import { Pcg64 } from "./numpyRandom";

export const MATERIAL_WEB_FORMAT = "viscera-material-prior-v1-web";
export const MATERIAL_METHOD = "ridge";
/** atlas_material_dataset.CONTROL_NAMES and CONDITION_NAMES: the normalised controls and the measured statistics. */
export const MATERIAL_CONTROL_NAMES = ["tint", "pigment_contrast", "mottle_scale_mm", "wetness", "fine_detail", "structure_strength"] as const;
export const MATERIAL_CONDITION_NAMES = ["mean_red_linear", "mean_green_linear", "mean_blue_linear", "luminance_std", "roughness_mean", "roughness_std", "height_rms_mm", "gradient_rms"] as const;
export type MaterialConditionName = typeof MATERIAL_CONDITION_NAMES[number];
/** The API's texts, word for word, so the public copy refuses as the API does. */
export const MATERIAL_SAMPLER_MESSAGES = {
  seed: "Material sampling seed must be uint32",
  recipeSeed: "Material seed must be uint32",
  conditions: "Material conditions must be numeric",
  unsupported: "Unsupported material organ/preset",
  unknownCondition: "Unknown material field condition",
  invalidConditions: "Invalid measured material conditions",
  bounded: "Could not sample a bounded material proposal",
  controls: "Expected six finite material controls within [-1,1]",
  normalized: "Material controls exceed normalized bounds",
  organ: "Material organ must match selected anatomy",
  anchors: "Material dataset has no matching organ field anchors",
  fields: "Material decoder produced invalid field arrays",
  fieldRange: "Linear color/roughness fields exceed [0,1]",
  points: "Rest sample coordinates must be finite N by 3 millimetres within +/-100000",
  regions: "Material regions must be aligned blend weights in [0,1], tissue to ligament",
  footprint: "Pixel footprints must be finite nonnegative rest-mm diameters",
  displayed: "Displayed reference changed; reload before sampling",
  reference: "Reference template changed; reload the reference before generating/exporting",
} as const;
export const outsideSupport = (name: string): string => `Material condition ${name} lies outside observed training support`;
/** sample_recipe's sampling notes and the route's measurement scope. */
export const MATERIAL_SAMPLING = {
  conditional: "conditional_control_proposal; requested field statistics require independent measurement",
  bootstrap: "organ/preset empirical training-control bootstrap with independent spatial field seed",
} as const;
export const MEASUREMENT_SCOPE = "fixed rest-space tissue anchors; not patient tissue measurements";
const CONTROLS = 6, CONDITIONS = 8;

// ---------------------------------------------------------------------------------------------- the model
export interface MaterialModelMeta {
  format: string; method: string; model_sha256: string; model_source: string; bundle_sha256: string | null;
  /** the packaged default (artifacts/atlas/material-run-v1), recorded beside the served one */
  default_model: { path: string; sha256: string; selected: string; dataset_release_sha256: string } | null;
  trainer_source_sha256: string; dataset_code_hashes: Record<string, string>;
  dataset: { root: string; release_sha256: string; release_id: string }; scope: string;
  control_names: string[]; condition_names: string[];
  /** "organ|preset", the model's group vocabulary (one-hot order of the ridge features) */ groups: string[];
  /** each reference's organ, as the route reads it from the cohort-v2 library */ templates: { id: string; organ: string }[];
  /** the release's anchor surfaces (surface_anchors.npz order) and their identities (dataset_card.json) */
  anchors: { id: string; organ: string; artifact_sha256: string }[]; anchor_points: number;
  training_rows: number; attempts: number;
  arrays: { name: string; dtype: string; shape: number[]; offset: number }[]; byte_length: number;
}
export interface MaterialModel {
  meta: MaterialModelMeta;
  /** condition_mean and condition_scale, 8 each */ conditionMean: Float64Array; conditionScale: Float64Array;
  /** ridge_coef, (groups + 8) × 6 */ ridgeCoef: Float64Array;
  /** train_controls (n × 6), train_conditions (n × 8), ridge_residuals (n × 6) */
  trainControls: Float64Array; trainConditions: Float64Array; ridgeResiduals: Float64Array;
  /** the group of each training row */ trainGroup: Uint8Array;
  /** anchor_points, anchors × points × 3 rest-space millimetres */ anchorPoints: Float64Array;
  /** np.flatnonzero(train_groups == group) for each group, ascending */ groupRows: number[][];
}

export function parseMaterialModel(meta: MaterialModelMeta, weights: ArrayBuffer): MaterialModel {
  if (meta.format !== MATERIAL_WEB_FORMAT || meta.method !== MATERIAL_METHOD) throw new Error("Unsupported material model export.");
  if (weights.byteLength !== meta.byte_length) throw new Error("The material model does not match its layout.");
  if (meta.control_names.join() !== MATERIAL_CONTROL_NAMES.join() || meta.condition_names.join() !== MATERIAL_CONDITION_NAMES.join()) throw new Error("Material model feature schema mismatch");
  const n = meta.training_rows, groups = meta.groups.length, anchors = meta.anchors.length, points = meta.anchor_points;
  if (!groups || groups > 255 || new Set(meta.groups).size !== groups || !anchors || !(points >= 2)) throw new Error("Invalid material preprocessing/groups");
  const view = <T extends Float64Array | Uint8Array>(name: string, dtype: string, shape: number[], make: (offset: number, length: number) => T): T => {
    const entry = meta.arrays.find((a) => a.name === name);
    if (!entry || entry.dtype !== dtype || entry.shape.join() !== shape.join()) throw new Error("Material model array schema mismatch");
    return make(entry.offset, shape.reduce((a, b) => a * b, 1));
  };
  const f8 = (name: string, shape: number[]) => view(name, "<f8", shape, (offset, length) => new Float64Array(weights, offset, length));
  const model: MaterialModel = {
    meta,
    conditionMean: f8("condition_mean", [CONDITIONS]), conditionScale: f8("condition_scale", [CONDITIONS]),
    ridgeCoef: f8("ridge_coef", [groups + CONDITIONS, CONTROLS]),
    trainControls: f8("train_controls", [n, CONTROLS]), trainConditions: f8("train_conditions", [n, CONDITIONS]), ridgeResiduals: f8("ridge_residuals", [n, CONTROLS]),
    trainGroup: view("train_group", "u1", [n], (offset, length) => new Uint8Array(weights, offset, length)),
    anchorPoints: f8("anchor_points", [anchors, points, 3]),
    groupRows: meta.groups.map(() => []),
  };
  for (const values of [model.conditionMean, model.conditionScale, model.ridgeCoef, model.trainConditions, model.ridgeResiduals, model.anchorPoints])
    for (const value of values) if (!Number.isFinite(value)) throw new Error("Nonfinite material model parameters");
  for (const value of model.trainControls) if (!(Math.abs(value) <= 1)) throw new Error("Invalid stored material controls");
  for (const value of model.conditionScale) if (!(value > 0)) throw new Error("Invalid material preprocessing/groups");
  model.trainGroup.forEach((group, row) => {
    const rows = model.groupRows[group];
    if (!rows) throw new Error("Invalid material preprocessing/groups");
    rows.push(row);
  });
  return model;
}

let cachedMeta: Promise<MaterialModelMeta> | null = null;
let cachedModel: Promise<MaterialModel> | null = null;
// One download each, shared by every caller: neither takes a caller's abort signal (a second click while the first
// download runs would abort it, and the shared promise would reject for every later caller as well).
/** The metadata alone (7 KB): whether the sampler is bundled, which organs and presets it covers, its provenance. */
export function materialModelInfo(): Promise<MaterialModelMeta> {
  cachedMeta ??= fetch(publicUrl("models/material-v1/model.json"), { cache: "default" }).then(async (response) => {
    if (!response.ok) throw new Error("The trained material sampler is not bundled with this copy.");
    const meta = await response.json() as MaterialModelMeta;
    if (meta.format !== MATERIAL_WEB_FORMAT) throw new Error("Unsupported material model export.");
    return meta;
  }).catch((error: unknown) => { cachedMeta = null; throw error; });
  return cachedMeta;
}
/** Tests and tools that hold the model already (read from disk) hand it over instead of fetching. */
export function primeMaterialModel(model: MaterialModel): void { cachedMeta = Promise.resolve(model.meta); cachedModel = Promise.resolve(model); }
/** The model (670 KB: the training rows, the ridge and the anchor points). */
export function loadMaterialModel(): Promise<MaterialModel> {
  cachedModel ??= Promise.all([materialModelInfo(), fetch(publicUrl("models/material-v1/weights.bin"), { cache: "default" }).then((response) => {
    if (!response.ok) throw new Error("The trained material sampler's rows are not bundled with this copy.");
    return response.arrayBuffer();
  })]).then(([meta, weights]) => parseMaterialModel(meta, weights)).catch((error: unknown) => { cachedModel = null; throw error; });
  return cachedModel;
}

// ---------------------------------------------------------------------------------------------- the material field
/** viscera_core.atlas_materials.sample_material's outputs, per point. */
export interface MaterialField {
  /** linear RGB, N × 3 */ rgbLinear: Float64Array;
  /** sRGB, N × 3: the vertex colours the API's surface realizer writes */ rgbSrgb: Float64Array;
  roughness: Float64Array; heightMm: Float64Array;
  /** d(height_mm)/d(rest mm), N × 3 */ gradient: Float64Array;
}
interface FieldUniforms {
  seed: number; base: number[]; ligament: number[]; pigmentContrast: number; mottleScale: number; wetness: number; fineDetail: number;
  structureStrength: number; roughnessBase: number; pigmentAmplitude: number; fineScale: number; heightAmplitude: number;
  structureScale: number; structureMode: number; stretch: number[];
}
/** resolve_material(recipe)["uniforms"], which the field reads (atlasLocal.resolveMaterial, the same arithmetic). */
function fieldUniforms(recipe: AtlasMaterialRecipe): FieldUniforms {
  const u = (resolveMaterial(recipe) as { uniforms: Record<string, number | number[]> }).uniforms;
  const scalar = (key: string) => u[key] as number, vector = (key: string) => u[key] as number[];
  return {
    seed: scalar("uAtlasSeed"), base: vector("uAtlasBaseColor"), ligament: vector("uAtlasLigamentColor"), pigmentContrast: scalar("uAtlasPigmentContrast"),
    mottleScale: scalar("uAtlasMottleScaleMm"), wetness: scalar("uAtlasWetness"), fineDetail: scalar("uAtlasFineDetail"), structureStrength: scalar("uAtlasStructureStrength"),
    roughnessBase: scalar("uAtlasRoughnessBase"), pigmentAmplitude: scalar("uAtlasPigmentAmplitude"), fineScale: scalar("uAtlasFineScaleMm"),
    heightAmplitude: scalar("uAtlasHeightAmplitudeMm"), structureScale: scalar("uAtlasStructureScaleMm"), structureMode: scalar("uAtlasStructureMode"), stretch: vector("uAtlasStructureStretch"),
  };
}

/** _lattice: the cell's 32-bit hash (the uint64 products and xors masked to 32 bits are 32-bit integer arithmetic),
 *  its top 24 bits as a fraction of 2^24 - 1. A negative cell enters as its two's complement, as astype(uint64) wraps. */
function lattice(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ seed;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 8) / 16777215;
}

/** _noise_gradient at one point: quintic-faded value noise in [-1, 1] and its analytic gradient, into out[0..3]. */
function noiseGradient(px: number, py: number, pz: number, ix: number, iy: number, iz: number, seed: number, out: Float64Array): void {
  const qx = px * ix, qy = py * iy, qz = pz * iz;
  const cx = Math.floor(qx), cy = Math.floor(qy), cz = Math.floor(qz);
  const fx = qx - cx, fy = qy - cy, fz = qz - cz;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10), sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10), sz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dx = 30 * fx * fx * (fx - 1) * (fx - 1), dy = 30 * fy * fy * (fy - 1) * (fy - 1), dz = 30 * fz * fz * (fz - 1) * (fz - 1);
  let value = 0, gx = 0, gy = 0, gz = 0;
  for (let a = 0; a < 2; a++) {
    const wx = a ? sx : 1 - sx, dwx = a ? dx : -dx;
    for (let b = 0; b < 2; b++) {
      const wy = b ? sy : 1 - sy, dwy = b ? dy : -dy;
      for (let c = 0; c < 2; c++) {
        const wz = c ? sz : 1 - sz, dwz = c ? dz : -dz;
        const l = lattice(cx + a, cy + b, cz + c, seed);
        value += l * (wx * wy * wz);
        gx += l * (dwx * wy * wz);
        gy += l * (wx * dwy * wz);
        gz += l * (wx * wy * dwz);
      }
    }
  }
  out[0] = value * 2 - 1;
  out[1] = gx * (2 * ix);
  out[2] = gy * (2 * iy);
  out[3] = gz * (2 * iz);
}

/** _attenuation: the band limit of a pattern scale for a sampling footprint (1 at a zero footprint). */
function attenuation(scale: number, footprint: number): number {
  const t = Math.min(1, Math.max(0, (footprint / scale - 0.35) / 0.9));
  return 1 - t * t * (3 - 2 * t);
}
const clip = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** linear_to_srgb for one clipped channel. */
const linearToSrgb = (value: number) => { const x = clip(value, 0, 1); return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055; };

/** sample_material(recipe, rest_points_mm, region_ids, footprint_mm): the continuous material at rest-space points
 *  (N × 3 millimetres), each a tissue (0) to ligament (1) blend, with a sampling footprint in rest mm (scalar or per
 *  point; 0 resolves every frequency, as the realizer and the measurements sample). */
export function sampleMaterialField(recipe: AtlasMaterialRecipe, restPointsMm: ArrayLike<number>, regionIds?: ArrayLike<number> | null, footprintMm: number | ArrayLike<number> = 0): MaterialField {
  const n = restPointsMm.length / 3;
  if (!Number.isInteger(n)) throw new Error(MATERIAL_SAMPLER_MESSAGES.points);
  for (let i = 0; i < restPointsMm.length; i++) { const v = restPointsMm[i]!; if (!Number.isFinite(v) || Math.abs(v) > 100000) throw new Error(MATERIAL_SAMPLER_MESSAGES.points); }
  const regions = new Float64Array(n);
  if (regionIds) {
    if (regionIds.length !== n) throw new Error(MATERIAL_SAMPLER_MESSAGES.regions);
    for (let i = 0; i < n; i++) { const r = regionIds[i]!; if (!Number.isFinite(r) || r < -1e-6 || r > 1 + 1e-6) throw new Error(MATERIAL_SAMPLER_MESSAGES.regions); regions[i] = clip(r, 0, 1); }
  }
  const footprint = typeof footprintMm === "number" ? new Float64Array(n).fill(footprintMm) : Float64Array.from(footprintMm);
  if (footprint.length !== n || footprint.some((f) => !Number.isFinite(f) || f < 0)) throw new Error(MATERIAL_SAMPLER_MESSAGES.footprint);
  const u = fieldUniforms(recipe);
  const scale = u.mottleScale, fine = u.fineScale, structureScale = u.structureScale;
  // the inverse scales, each computed once as the API's np.full(3, 1 / x) and stretch / scale are
  const coarseInv = 1 / scale, mesoInv = 1 / (scale * 0.24), grainInv = 1 / fine, microInv = 1 / (fine * 0.37);
  const [stretchX, stretchY, stretchZ] = u.stretch as [number, number, number];
  const structureX = stretchX / structureScale, structureY = stretchY / structureScale, structureZ = stretchZ / structureScale;
  const structureBand = structureScale / Math.max(stretchX, stretchY, stretchZ);
  const coarseSeed = u.seed ^ 137, mesoSeed = u.seed ^ 509, grainSeed = u.seed ^ 2017, microSeed = u.seed ^ 7919, structureSeed = u.seed ^ 3571;
  const tint = [1, 0.82, 0.7];
  const pigment = u.pigmentAmplitude * u.pigmentContrast, fineTerm = 0.09 * u.fineDetail, structureTerm = 0.05 * u.structureStrength;
  const roughnessBase = u.roughnessBase + 0.13 - 0.26 * u.wetness, roughnessGrain = 0.045 * u.fineDetail, roughnessMeso = 0.025 * u.pigmentContrast;
  const heightBase = u.heightAmplitude * u.fineDetail, heightStructure = 0.12 * u.structureStrength;
  const out: MaterialField = { rgbLinear: new Float64Array(n * 3), rgbSrgb: new Float64Array(n * 3), roughness: new Float64Array(n), heightMm: new Float64Array(n), gradient: new Float64Array(n * 3) };
  const noise = new Float64Array(4);
  for (let i = 0; i < n; i++) {
    const px = restPointsMm[i * 3]!, py = restPointsMm[i * 3 + 1]!, pz = restPointsMm[i * 3 + 2]!, region = regions[i]!, fp = footprint[i]!;
    noiseGradient(px, py, pz, coarseInv, coarseInv, coarseInv, coarseSeed, noise);
    let coarse = noise[0]!;
    noiseGradient(px, py, pz, mesoInv, mesoInv, mesoInv, mesoSeed, noise);
    let meso = noise[0]!;
    noiseGradient(px, py, pz, grainInv, grainInv, grainInv, grainSeed, noise);
    let grain = noise[0]!, dgx = noise[1]!, dgy = noise[2]!, dgz = noise[3]!;
    noiseGradient(px, py, pz, microInv, microInv, microInv, microSeed, noise);
    let micro = noise[0]!, dmx = noise[1]!, dmy = noise[2]!, dmz = noise[3]!;
    noiseGradient(px, py, pz, structureX, structureY, structureZ, structureSeed, noise);
    let structure = noise[0]!, dsx = noise[1]!, dsy = noise[2]!, dsz = noise[3]!;
    if (u.structureMode === 2) {
      const lobular = 1.5 - 1.5 * structure * structure;
      dsx *= lobular; dsy *= lobular; dsz *= lobular;
      structure *= 1.5 - 0.5 * structure * structure;
    }
    coarse *= attenuation(scale, fp);
    meso *= attenuation(scale * 0.24, fp);
    const ag = attenuation(fine, fp), am = attenuation(fine * 0.37, fp), ast = attenuation(structureBand, fp);
    grain *= ag; dgx *= ag; dgy *= ag; dgz *= ag;
    micro *= am; dmx *= am; dmy *= am; dmz *= am;
    structure *= ast; dsx *= ast; dsy *= ast; dsz *= ast;
    const regionAttenuation = 1 - 0.7 * region;
    const field = 0.56 * coarse + 0.30 * meso + fineTerm * grain + structureTerm * structure;
    const variation = pigment * regionAttenuation * field;
    for (let k = 0; k < 3; k++) {
      const base = (1 - region) * u.base[k]! + region * u.ligament[k]!;
      const color = clip(base * (1 + variation * tint[k]!), 0.001, 0.98);
      out.rgbLinear[i * 3 + k] = color;
      out.rgbSrgb[i * 3 + k] = linearToSrgb(color);
    }
    out.roughness[i] = clip(roughnessBase + 0.07 * region + roughnessGrain * grain + roughnessMeso * meso, 0.16, 0.82);
    const amp = heightBase * regionAttenuation;
    out.heightMm[i] = amp * (0.63 * grain + 0.25 * micro + heightStructure * structure);
    out.gradient[i * 3] = amp * (0.63 * dgx + 0.25 * dmx + heightStructure * dsx);
    out.gradient[i * 3 + 1] = amp * (0.63 * dgy + 0.25 * dmy + heightStructure * dsy);
    out.gradient[i * 3 + 2] = amp * (0.63 * dgz + 0.25 * dmz + heightStructure * dsz);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- NumPy's sums
/** numpy's pairwise summation of a contiguous run (pairwise_sum_DOUBLE): below 8 values a running sum from 0, up to
 *  128 eight interleaved accumulators, above that two halves split at a multiple of 8. A 1-D reduction (np.sum,
 *  np.mean, np.std of one column) adds this to the identity 0. */
function pairwiseSum(values: Float64Array, start: number, count: number): number {
  if (count < 8) {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += values[start + i]!;
    return sum;
  }
  if (count <= 128) {
    const r = values.slice(start, start + 8);
    let i = 8;
    for (; i < count - (count % 8); i += 8) for (let j = 0; j < 8; j++) r[j] = r[j]! + values[start + i + j]!;
    let sum = ((r[0]! + r[1]!) + (r[2]! + r[3]!)) + ((r[4]! + r[5]!) + (r[6]! + r[7]!));
    for (; i < count; i++) sum += values[start + i]!;
    return sum;
  }
  let half = Math.floor(count / 2);
  half -= half % 8;
  return pairwiseSum(values, start, half) + pairwiseSum(values, start + half, count - half);
}
const npMean = (values: Float64Array) => (0 + pairwiseSum(values, 0, values.length)) / values.length;
/** np.std (ddof 0): the pairwise mean, the squared deviations, their pairwise mean, its square root. */
function npStd(values: Float64Array): number {
  const mean = npMean(values), squares = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) { const d = values[i]! - mean; squares[i] = d * d; }
  return Math.sqrt(npMean(squares));
}

/** atlas_material_dataset.field_arrays' checks and field_summary's eight statistics: the mean linear colour (np.mean
 *  along axis 0 adds the rows in order), the luminance spread (the (N, 3) @ (3,) product without fused rounding),
 *  roughness mean and spread, the RMS of the centred height and of the gradient length. */
export function fieldSummary(fields: MaterialField): number[] {
  const n = fields.roughness.length;
  for (const values of [fields.rgbLinear, fields.roughness, fields.heightMm, fields.gradient]) for (const v of values) if (!Number.isFinite(v)) throw new Error(MATERIAL_SAMPLER_MESSAGES.fields);
  for (const values of [fields.rgbLinear, fields.roughness]) for (const v of values) if (v < 0 || v > 1) throw new Error(MATERIAL_SAMPLER_MESSAGES.fieldRange);
  if (n < 2) throw new Error("Invalid material field summary input");
  const colour = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) colour[k] = colour[k]! + fields.rgbLinear[i * 3 + k]!;
  const luminance = new Float64Array(n), gradient = new Float64Array(n), centred = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = fields.rgbLinear[i * 3]!, g = fields.rgbLinear[i * 3 + 1]!, b = fields.rgbLinear[i * 3 + 2]!;
    luminance[i] = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const x = fields.gradient[i * 3]!, y = fields.gradient[i * 3 + 1]!, z = fields.gradient[i * 3 + 2]!;
    gradient[i] = x * x + y * y + z * z;
  }
  const heightMean = npMean(fields.heightMm);
  for (let i = 0; i < n; i++) { const d = fields.heightMm[i]! - heightMean; centred[i] = d * d; }
  return [colour[0]! / n, colour[1]! / n, colour[2]! / n, npStd(luminance), npMean(fields.roughness), npStd(fields.roughness), Math.sqrt(npMean(centred)), Math.sqrt(npMean(gradient))];
}

// ---------------------------------------------------------------------------------------------- controls and recipes
/** atlas_material_dataset.controls_recipe: six controls in [-1, 1] → the recipe (tint as is, the pattern size
 *  logarithmic between 2 and 40 mm, the rest affine onto [0, 1]), validated as MaterialRecipe validates it. */
export function controlsRecipe(organ: string, preset: AtlasMaterialPreset, seed: number, controls: ArrayLike<number>): AtlasMaterialRecipe {
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) throw new Error(MATERIAL_SAMPLER_MESSAGES.recipeSeed);
  const c = Array.from(controls);
  if (c.length !== CONTROLS || !c.every((value) => Number.isFinite(value) && Math.abs(value) <= 1)) throw new Error(MATERIAL_SAMPLER_MESSAGES.controls);
  const recipe: AtlasMaterialRecipe = {
    version: ATLAS_MATERIAL_VERSION, organ, preset, seed,
    tint: c[0]!, pigment_contrast: (c[1]! + 1) / 2, mottle_scale_mm: 2 * 20 ** ((c[2]! + 1) / 2),
    wetness: (c[3]! + 1) / 2, fine_detail: (c[4]! + 1) / 2, structure_strength: (c[5]! + 1) / 2,
  };
  validateAtlasMaterial(recipe, organ);
  return recipe;
}
/** atlas_material_dataset.recipe_controls: a recipe's six normalised controls, clipped to [-1, 1]. */
export function recipeControls(recipe: AtlasMaterialRecipe): Float64Array {
  const values = MATERIAL_CONTROL_NAMES.map((name) => {
    const value = recipe[name];
    return name === "tint" ? value : name === "mottle_scale_mm" ? 2 * Math.log(value / 2) / Math.log(20) - 1 : 2 * value - 1;
  });
  if (!values.every((value) => Number.isFinite(value) && Math.abs(value) <= 1 + 1e-10)) throw new Error(MATERIAL_SAMPLER_MESSAGES.normalized);
  return Float64Array.from(values, (value) => clip(value, -1, 1));
}
/** atlas_material_dataset.evaluate_controls: the recipe of the controls sampled at the points, and its statistics. */
export function evaluateControls(organ: string, preset: AtlasMaterialPreset, seed: number, controls: ArrayLike<number>, points: ArrayLike<number>): { summary: number[]; fields: MaterialField } {
  const fields = sampleMaterialField(controlsRecipe(organ, preset, seed, controls), points);
  return { summary: fieldSummary(fields), fields };
}

// ---------------------------------------------------------------------------------------------- the proposal
/** sample_recipe's record, which the route spreads into summary.material_model. */
export interface MaterialProposal {
  recipe: AtlasMaterialRecipe; normalized_controls: number[]; sampling: string; requested_conditions: Record<string, number>;
  geometry_modified: false; material_prior: string; dataset_release_sha256: string; empirical_tissue_distribution: false;
}
/** numpy's draws (indices into the group's rows), the training rows they pick, and for requested statistics the
 *  target statistics and the ridge mean. */
export interface MaterialDraws { draws: number[]; rows: number[]; target: number[] | null; mean: number[] | null }

/** The group's mean training statistics (np.mean(axis=0): the rows added in order, then divided). */
function groupConditionMean(model: MaterialModel, rows: number[]): Float64Array {
  const target = new Float64Array(CONDITIONS);
  for (const row of rows) for (let j = 0; j < CONDITIONS; j++) target[j] = target[j]! + model.trainConditions[row * CONDITIONS + j]!;
  for (let j = 0; j < CONDITIONS; j++) target[j] = target[j]! / rows.length;
  return target;
}
/** predict(model, data, "ridge") for one row: the group's one-hot and the standardised statistics times ridge_coef —
 *  numpy's matmul accumulates the products in order with fused multiply-adds (an exact zero term changes nothing) —
 *  clipped to [-1, 1]. */
function ridgeMean(model: MaterialModel, group: number, target: Float64Array): Float64Array {
  const groups = model.meta.groups.length, z = new Float64Array(CONDITIONS);
  for (let j = 0; j < CONDITIONS; j++) z[j] = (target[j]! - model.conditionMean[j]!) / model.conditionScale[j]!;
  if (!z.every(Number.isFinite)) throw new Error(MATERIAL_SAMPLER_MESSAGES.invalidConditions);
  const mean = new Float64Array(CONTROLS);
  for (let c = 0; c < CONTROLS; c++) {
    let sum = fma(1, model.ridgeCoef[group * CONTROLS + c]!, 0);
    for (let j = 0; j < CONDITIONS; j++) sum = fma(z[j]!, model.ridgeCoef[(groups + j) * CONTROLS + c]!, sum);
    mean[c] = clip(sum, -1, 1);
  }
  return mean;
}

/** sample_recipe(model, organ, preset, seed, conditions): one bounded proposal and its recipe. */
export function proposeMaterialRecipe(model: MaterialModel, organ: string, preset: AtlasMaterialPreset, seed: number, conditions?: Record<string, number> | null): { proposal: MaterialProposal; draws: MaterialDraws } {
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) throw new Error(MATERIAL_SAMPLER_MESSAGES.seed);
  const group = model.meta.groups.indexOf(`${organ}|${preset}`);
  if (group < 0) throw new Error(MATERIAL_SAMPLER_MESSAGES.unsupported);
  const rows = model.groupRows[group]!;
  const rng = new Pcg64(seed);
  const requested = Object.entries(conditions ?? {});
  let controls: Float64Array | null = null, sampling: string;
  const draws: MaterialDraws = { draws: [], rows: [], target: null, mean: null };
  if (requested.length) {
    if (requested.some(([name]) => !(MATERIAL_CONDITION_NAMES as readonly string[]).includes(name))) throw new Error(MATERIAL_SAMPLER_MESSAGES.unknownCondition);
    const target = groupConditionMean(model, rows);
    for (const [name, value] of requested) {
      const j = (MATERIAL_CONDITION_NAMES as readonly string[]).indexOf(name);
      let low = Infinity, high = -Infinity;
      for (const row of rows) { const v = model.trainConditions[row * CONDITIONS + j]!; if (v < low) low = v; if (v > high) high = v; }
      if (typeof value !== "number" || !Number.isFinite(value) || !(low <= value && value <= high)) throw new Error(outsideSupport(name));
      target[j] = value;
    }
    const mean = ridgeMean(model, group, target);
    draws.target = Array.from(target);
    draws.mean = Array.from(mean);
    for (let attempt = 0; attempt < model.meta.attempts; attempt++) {
      const draw = rng.integers(0, rows.length), row = rows[draw]!;   // Generator.choice(ids) is ids[integers(0, len(ids))]
      draws.draws.push(draw);
      draws.rows.push(row);
      const candidate = mean.map((value, c) => value + model.ridgeResiduals[row * CONTROLS + c]!);
      if (candidate.every((value) => Math.abs(value) <= 1)) { controls = candidate; break; }
    }
    if (!controls) throw new Error(MATERIAL_SAMPLER_MESSAGES.bounded);
    sampling = MATERIAL_SAMPLING.conditional;
  } else {
    const draw = rng.integers(0, rows.length), row = rows[draw]!;
    draws.draws.push(draw);
    draws.rows.push(row);
    controls = model.trainControls.slice(row * CONTROLS, (row + 1) * CONTROLS);
    sampling = MATERIAL_SAMPLING.bootstrap;
  }
  const proposal: MaterialProposal = {
    recipe: controlsRecipe(organ, preset, seed, controls), normalized_controls: Array.from(controls), sampling,
    requested_conditions: { ...(conditions ?? {}) }, geometry_modified: false, material_prior: MATERIAL_METHOD,
    dataset_release_sha256: model.meta.dataset.release_sha256, empirical_tissue_distribution: false,
  };
  return { proposal, draws };
}

/** The anchor surface measured, the recipe's controls as recipe_controls reads them back, the eight statistics. */
export interface MaterialMeasurement { anchor_template: string; anchor_template_sha256: string; controls: number[]; statistics: number[] }
/** The statistics the route measures for a recipe (evaluate_controls of its recipe_controls): at the requested
 *  reference's own anchor surface when the release has one for the organ, else at the organ's first (sorted by id). */
export function measureMaterial(model: MaterialModel, templateId: string, organ: string, recipe: AtlasMaterialRecipe): MaterialMeasurement {
  const candidates = model.meta.anchors.map((anchor, index) => ({ anchor, index })).filter(({ anchor }) => anchor.organ === organ);
  if (!candidates.length) throw new Error(MATERIAL_SAMPLER_MESSAGES.anchors);
  const chosen = candidates.find(({ anchor }) => anchor.id === templateId) ?? [...candidates].sort((a, b) => (a.anchor.id < b.anchor.id ? -1 : a.anchor.id > b.anchor.id ? 1 : 0))[0]!;
  const size = model.meta.anchor_points * 3;
  const points = model.anchorPoints.subarray(chosen.index * size, (chosen.index + 1) * size);
  const controls = recipeControls(recipe);
  const { summary } = evaluateControls(organ, recipe.preset, recipe.seed, controls, points);
  return { anchor_template: chosen.anchor.id, anchor_template_sha256: chosen.anchor.artifact_sha256, controls: Array.from(controls), statistics: summary };
}

// ---------------------------------------------------------------------------------------------- the route
/** The record the route attaches as summary.material_model and scene.metadata.material_model. */
export interface MaterialModelProvenance extends MaterialProposal {
  model_sha256: string; measured_anchor_template: string; measured_anchor_template_sha256: string;
  measured_field_statistics: Record<MaterialConditionName, number>; condition_errors: Record<string, number>;
  condition_status: "measured_proposal_not_exact_constraint" | "not_requested"; measurement_scope: string;
}
export interface MaterialSample { organ: string; recipe: AtlasMaterialRecipe; provenance: MaterialModelProvenance; draws: MaterialDraws; measurement: MaterialMeasurement }

/** sample_material_model up to the realization: the recipe the route puts in spec.material and its provenance. The
 *  preset is the current surface's (the organ's default recipe without one); the organ is the reference's. */
export function sampleMaterialRecipe(model: MaterialModel, templateId: string, current: AtlasMaterialRecipe | null | undefined, seed: number, conditions?: Record<string, number> | null): MaterialSample {
  const organ = model.meta.templates.find((t) => t.id === templateId)?.organ;
  if (!organ) throw new Error(`Template ${templateId} is unavailable`);
  if (current && current.organ !== organ) throw new Error(MATERIAL_SAMPLER_MESSAGES.organ);
  const { proposal, draws } = proposeMaterialRecipe(model, organ, current?.preset ?? "balanced", seed, conditions);
  const recipe = proposal.recipe;
  const measurement = measureMaterial(model, templateId, organ, recipe);
  const statistics = Object.fromEntries(MATERIAL_CONDITION_NAMES.map((name, i) => [name, measurement.statistics[i]!])) as Record<MaterialConditionName, number>;
  const requested = Object.entries(conditions ?? {});
  const provenance: MaterialModelProvenance = {
    ...proposal, model_sha256: model.meta.model_sha256, measured_anchor_template: measurement.anchor_template,
    measured_anchor_template_sha256: measurement.anchor_template_sha256, measured_field_statistics: statistics,
    condition_errors: Object.fromEntries(requested.map(([name, value]) => [name, statistics[name as MaterialConditionName] - value])),
    condition_status: requested.length ? "measured_proposal_not_exact_constraint" : "not_requested", measurement_scope: MEASUREMENT_SCOPE,
  };
  return { organ, recipe, provenance, draws, measurement };
}

/** The public copy's trained material sampler (POST /api/atlas/sample-material with { spec, seed, conditions }): the
 *  recipe sampled here, the surface realized here — realizeSpecLocally, the disease-v2 renderer for a disease-v2 or
 *  diseased spec — with the vertex colours the API's surface realizer paints for that recipe (its field at the
 *  reference's rest vertices and regions, the disease tint on top where a disease applies), and the provenance the
 *  route attaches. `reference` is the bundled specimen of spec.template_id (its rest vertices and material regions),
 *  `seed` the material seed the studio sends (spec.material?.seed, the route's default 42 without one), `library` the
 *  catalogue's disease library; `signal` reaches the realization only — the model download is shared. */
export async function sampleMaterialLocally(reference: AtlasGeneration, template: AtlasTemplate, spec: AtlasSpec, seed: number, conditions: Record<string, number> | undefined, library: AtlasDiseaseLibrary | undefined, signal?: AbortSignal): Promise<AtlasGeneration> {
  // the route's request model: a uint32 seed, numeric statistics
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(MATERIAL_SAMPLER_MESSAGES.seed);
  if (conditions !== undefined && (typeof conditions !== "object" || conditions === null || Object.values(conditions).some((value) => typeof value !== "number" || !Number.isFinite(value))))
    throw new Error(MATERIAL_SAMPLER_MESSAGES.conditions);
  if (spec.template_id !== reference.spec.template_id) throw new Error("The bundled reference belongs to another template.");
  // the API checks a bound spec against the reference it displays (unbind_for_sampler for disease-v2, realize for a
  // legacy spec); the bundled reference is the displayed one
  const displayed = reference.spec.template_sha256;
  if (typeof spec.template_sha256 === "string" && spec.template_sha256 !== displayed)
    throw new Error(spec.renderer_version === "disease-v2" ? MATERIAL_SAMPLER_MESSAGES.displayed : MATERIAL_SAMPLER_MESSAGES.reference);
  const model = await loadMaterialModel();
  const sample = sampleMaterialRecipe(model, spec.template_id, spec.material, seed, conditions);
  const organ = reference.scene.organs[0] as (OrganMesh & { rest_positions?: number[]; material_regions?: number[] }) | undefined;
  if (!organ || organ.id !== sample.organ) throw new Error("The reference shows another organ than its template.");
  if (!organ.rest_positions || !organ.material_regions) throw new Error("The reference carries no rest surface and material regions to colour.");
  const colors = Array.from(sampleMaterialField(sample.recipe, organ.rest_positions, organ.material_regions).rgbSrgb);
  const recoloured: AtlasGeneration = { ...reference, scene: { ...reference.scene, organs: [{ ...organ, colors }, ...reference.scene.organs.slice(1)] } };
  const target: AtlasSpec = { ...spec, material: sample.recipe, appearance: "tissue" };
  delete target.realized_id;   // spec.model_copy(update={..., "realized_id": None}): the realizer binds its own
  const generation = await realizeSpecLocally(recoloured, target, template, library, signal);
  const provenance = {
    ...sample.provenance,
    sampled_by: { version: LOCAL_REALIZER_VERSION, scope: "public copy: the API's ridge proposal and anchor-surface field statistics repeated in the browser (float64), the result realized here" },
  };
  generation.summary.material_model = provenance;
  (generation.scene.metadata as Record<string, unknown>).material_model = provenance;
  return generation;
}
