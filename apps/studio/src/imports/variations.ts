/** Imported meshes retain their own identity. The learned model samples an atlas recipe;
 * a separate authored deformation/material field transfers that recipe to the upload.
 * There is no mesh encoder, tissue inference, patient prior, or learned texture image here. */
import {
  Box3, BufferAttribute, Color, DataTexture, LinearFilter, LinearMipmapLinearFilter,
  Matrix3, Matrix4, Mesh, NoColorSpace, RepeatWrapping, RGBAFormat, SRGBColorSpace,
  Texture, UnsignedByteType, Vector2, Vector3,
  type BufferGeometry, type Material, type Object3D,
} from "three";
import { CONTROL_NAMES, deformVertices, resolveMaterial } from "../atlasLocal";
import { loadJointModel, sampleJointControls, type JointModel, type JointSeverity } from "../atlasJointLocal";
import { loadTextCompilerTables, type TextCompilerTables } from "../atlasTextCompiler";
import { sampleMaterialField } from "../atlasMaterialSampler";
import { ATLAS_MATERIAL_VERSION, MATERIAL_CONTROLS, validateAtlasMaterial, type AtlasMaterialRecipe } from "../atlasMaterial";
import type { AtlasDiseaseSpec } from "../atlasDisease";
import { Pcg64 } from "../numpyRandom";

export interface ImportedReference {
  id: string; label: string; organ: string; limits: number[]; normalizationMm: number;
}
export interface ImportedDiseaseProfile {
  id: string; organ: string; label: string; pattern: string; mechanism: string;
  rMin: number; rRange: number; amp: number; steps: number; mult: number; maxSites: number;
  logScale: [number, number, number]; srgb: [number, number, number];
}
export interface ImportedVariationSystem {
  model: JointModel; references: ImportedReference[]; profiles: ImportedDiseaseProfile[]; scope: string;
}
export interface ImportedVariationRecipe {
  controls: Record<string, number>;
  material: AtlasMaterialRecipe;
  reference: ImportedReference;
  disease?: AtlasDiseaseSpec | null;
  diseaseProfile?: ImportedDiseaseProfile | null;
  provenance: {
    method: "joint-flow-recipe-transfer" | "deterministic-text-controls";
    modelSha256: string | null; modelScope: string; contextGain: number;
    seed: number; temperature: number | null; referenceId: string;
    profileId?: string | null; severity?: string;
    trainingSamples: number; text?: string;
    meshEncoding: false; diseaseInference: false;
  };
}
export interface VariationOptions {
  shapeStrength: number; textureStrength: number;
  synthesizeSeamlessTextures?: boolean;
  signal?: AbortSignal;
}
export interface VariationReport {
  vertices: number; triangles: number; minJacobian: number; maxJacobian: number;
  topologyPreserved: true; sourceResourcesRetained: true; sourceMaterialMapsRetained: boolean;
  appearanceEncoding: "original" | "linear-vertex-color-modulation" | "seamless-3d-pbr-synthesis";
  synthesizedTextures?: number;
  coordinateFrame: "shared-centered-source-bounds";
  selfIntersection: "not-tested";
  provenance: ImportedVariationRecipe["provenance"]; warnings: string[];
}
interface MeshRest {
  mesh: Mesh; geometry: BufferGeometry; material: Material | Material[];
  world: Matrix4; inverse: Matrix4; centered: Float64Array;
}
export interface ImportedVariationState {
  readonly root: Object3D;
  readonly center: Vector3;
  readonly normalization: number;
  readonly vertices: number;
  readonly meshes: readonly MeshRest[];
  /** Internal cancellation generation; reset/dispose invalidate outstanding work. */
  epoch: number; disposed: boolean;
  ownedGeometry: BufferGeometry[]; ownedMaterials: Material[]; ownedTextures?: Texture[];
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const srgbToLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (x: number) => {
  const c = clamp(x, 0, 1);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
};

const DISEASE_PROFILE_SPECS: Record<string, {
  rMin: number; rRange: number; amp: number; steps: number; mult: number; maxSites: number;
  logScale: [number, number, number]; srgb: [number, number, number];
}> = {
  "liver-cirrhosis": { rMin: 0.02, rRange: 0.02, amp: 0.17, steps: 6, mult: 6, maxSites: 48, logScale: [-0.06, -0.035, -0.04], srgb: [0.5583, 0.3263, 0.1818] },
  "liver-hcc": { rMin: 0.075, rRange: 0.08, amp: 0.21, steps: 6, mult: 1, maxSites: 3, logScale: [0.025, 0.015, 0.02], srgb: [0.63, 0.43, 0.27] },
  "liver-metastases": { rMin: 0.032, rRange: 0.04, amp: 0.19, steps: 6, mult: 3, maxSites: 48, logScale: [0.045, 0.025, 0.035], srgb: [0.6921, 0.5524, 0.3788] },
  "liver-steatotic-enlargement": { rMin: 0.18, rRange: 0.13, amp: 0.028, steps: 5, mult: 1, maxSites: 48, logScale: [0.18, 0.13, 0.15], srgb: [0.64, 0.43, 0.21] },
  "liver-capsular-cyst": { rMin: 0.05, rRange: 0.06, amp: 0.21, steps: 7, mult: 1, maxSites: 1, logScale: [0, 0, 0], srgb: [0.5, 0.36, 0.23] },
  "gallbladder-cholecystitis": { rMin: 0.16, rRange: 0.12, amp: 0.035, steps: 5, mult: 1, maxSites: 48, logScale: [0.1, 0.04, 0.1], srgb: [0.48, 0.1, 0.055] },
  "gallbladder-carcinoma": { rMin: 0.07, rRange: 0.08, amp: 0.19, steps: 6, mult: 1, maxSites: 3, logScale: [0.025, 0, 0.025], srgb: [0.6474, 0.512, 0.2806] },
  "gallbladder-distension": { rMin: 0.18, rRange: 0.12, amp: 0.0245, steps: 5, mult: 1, maxSites: 48, logScale: [0.18, 0.08, 0.18], srgb: [0.41, 0.4, 0.18] },
  "gallbladder-contraction": { rMin: 0.13, rRange: 0.1, amp: -0.0245, steps: 5, mult: 2, maxSites: 48, logScale: [-0.16, -0.1, -0.16], srgb: [0.59, 0.47, 0.29] },
  "gallbladder-focal-bulge": { rMin: 0.06, rRange: 0.07, amp: 0.19, steps: 7, mult: 1, maxSites: 1, logScale: [0, 0, 0], srgb: [0.45, 0.4, 0.25] },
  "stomach-adenocarcinoma": { rMin: 0.1, rRange: 0.11, amp: -0.072, steps: 6, mult: 2, maxSites: 48, logScale: [-0.02, -0.015, -0.025], srgb: [0.48, 0.28, 0.18] },
  "stomach-gist": { rMin: 0.065, rRange: 0.07, amp: 0.21, steps: 7, mult: 1, maxSites: 1, logScale: [0, 0, 0], srgb: [0.6533, 0.4125, 0.3015] },
  "stomach-distension": { rMin: 0.18, rRange: 0.12, amp: 0.0175, steps: 5, mult: 1, maxSites: 48, logScale: [0.17, 0.1, 0.21], srgb: [0.59, 0.39, 0.32] },
  "stomach-serosal-retraction": { rMin: 0.075, rRange: 0.09, amp: -0.096, steps: 7, mult: 1, maxSites: 48, logScale: [-0.03, -0.01, -0.025], srgb: [0.69, 0.56, 0.43] },
  "stomach-regional-narrowing": { rMin: 0.1, rRange: 0.08, amp: -0.114, steps: 7, mult: 3, maxSites: 48, logScale: [-0.03, 0, -0.04], srgb: [0.57, 0.37, 0.29] },
  "pancreas-cancer": { rMin: 0.08, rRange: 0.08, amp: 0.2, steps: 6, mult: 1, maxSites: 3, logScale: [0.03, 0, 0.02], srgb: [0.57, 0.45, 0.3] },
  "pancreas-pancreatitis": { rMin: 0.08, rRange: 0.08, amp: -0.072, steps: 6, mult: 2, maxSites: 48, logScale: [-0.12, -0.07, -0.1], srgb: [0.59, 0.49, 0.36] },
  "pancreas-pseudocyst": { rMin: 0.09, rRange: 0.08, amp: 0.21, steps: 7, mult: 1, maxSites: 1, logScale: [0.02, 0.01, 0.025], srgb: [0.48, 0.35, 0.23] },
  "pancreas-diffuse-swelling": { rMin: 0.14, rRange: 0.1, amp: 0.028, steps: 5, mult: 2, maxSites: 48, logScale: [0.06, 0.17, 0.14], srgb: [0.55, 0.21, 0.13] },
  "pancreas-multicystic-surface": { rMin: 0.04, rRange: 0.045, amp: 0.2, steps: 7, mult: 3, maxSites: 48, logScale: [0.025, 0.04, 0.03], srgb: [0.51, 0.39, 0.28] },
  "spleen-infarct": { rMin: 0.07, rRange: 0.07, amp: -0.078, steps: 6, mult: 3, maxSites: 48, logScale: [-0.015, 0, -0.01], srgb: [0.5788, 0.3911, 0.2681] },
  "spleen-cyst": { rMin: 0.055, rRange: 0.065, amp: 0.2, steps: 7, mult: 1, maxSites: 1, logScale: [0, 0, 0], srgb: [0.45, 0.32, 0.22] },
  "spleen-enlargement": { rMin: 0.2, rRange: 0.12, amp: 0.0175, steps: 5, mult: 1, maxSites: 48, logScale: [0.14, 0.2, 0.13], srgb: [0.4, 0.12, 0.11] },
  "spleen-exophytic-mass": { rMin: 0.07, rRange: 0.08, amp: 0.2, steps: 7, mult: 1, maxSites: 1, logScale: [0, 0, 0], srgb: [0.6, 0.39, 0.27] },
  "spleen-capsular-retraction": { rMin: 0.06, rRange: 0.07, amp: -0.096, steps: 6, mult: 2, maxSites: 48, logScale: [-0.06, -0.025, -0.035], srgb: [0.63, 0.53, 0.43] },
  "small-intestine-crohn": { rMin: 0.1, rRange: 0.09, amp: 0.12, steps: 6, mult: 2, maxSites: 48, logScale: [0.025, 0.015, 0.025], srgb: [0.49, 0.115, 0.095] },
  "small-intestine-net": { rMin: 0.04, rRange: 0.045, amp: 0.2, steps: 6, mult: 1, maxSites: 1, logScale: [0, 0, 0], srgb: [0.62, 0.44, 0.29] },
  "small-intestine-regional-dilation": { rMin: 0.11, rRange: 0.09, amp: 0.18, steps: 6, mult: 2, maxSites: 48, logScale: [0.015, 0.025, 0.015], srgb: [0.6, 0.32, 0.24] },
  "small-intestine-pouching": { rMin: 0.025, rRange: 0.025, amp: 0.21, steps: 7, mult: 3, maxSites: 48, logScale: [0, 0, 0], srgb: [0.55, 0.32, 0.27] },
  "small-intestine-constriction": { rMin: 0.06, rRange: 0.06, amp: -0.102, steps: 7, mult: 2, maxSites: 48, logScale: [0, 0, 0], srgb: [0.63, 0.5, 0.39] },
  "colon-cancer": { rMin: 0.05, rRange: 0.06, amp: 0.19, steps: 6, mult: 1, maxSites: 3, logScale: [0, 0, 0], srgb: [0.57, 0.34, 0.24] },
  "colon-diverticulosis": { rMin: 0.021, rRange: 0.021, amp: 0.21, steps: 7, mult: 3, maxSites: 48, logScale: [0, 0, 0], srgb: [0.5429, 0.3394, 0.2774] },
  "colon-regional-dilation": { rMin: 0.11, rRange: 0.08, amp: 0.16, steps: 6, mult: 2, maxSites: 48, logScale: [0.015, 0.025, 0.015], srgb: [0.59, 0.33, 0.27] },
  "colon-serosal-scarring": { rMin: 0.04, rRange: 0.055, amp: -0.102, steps: 6, mult: 3, maxSites: 48, logScale: [-0.02, 0, -0.015], srgb: [0.64, 0.53, 0.4] },
  "colon-diffuse-wall-swelling": { rMin: 0.17, rRange: 0.1, amp: 0.028, steps: 5, mult: 2, maxSites: 48, logScale: [0.06, 0.04, 0.06], srgb: [0.5, 0.13, 0.1] },
  "kidney-cancer": { rMin: 0.075, rRange: 0.075, amp: 0.21, steps: 6, mult: 1, maxSites: 3, logScale: [0.02, 0.01, 0.015], srgb: [0.7032, 0.4702, 0.3002] },
  "kidney-polycystic": { rMin: 0.035, rRange: 0.045, amp: 0.21, steps: 7, mult: 4, maxSites: 48, logScale: [0.1, 0.08, 0.1], srgb: [0.4644, 0.3334, 0.2608] },
  "kidney-cortical-cyst": { rMin: 0.065, rRange: 0.06, amp: 0.21, steps: 7, mult: 1, maxSites: 1, logScale: [0, 0, 0], srgb: [0.48, 0.35, 0.25] },
  "kidney-cortical-scarring": { rMin: 0.045, rRange: 0.055, amp: -0.096, steps: 6, mult: 3, maxSites: 48, logScale: [-0.04, -0.015, -0.04], srgb: [0.63, 0.51, 0.36] },
  "kidney-atrophy": { rMin: 0.12, rRange: 0.08, amp: -0.028, steps: 5, mult: 2, maxSites: 48, logScale: [-0.18, -0.13, -0.17], srgb: [0.55, 0.35, 0.25] },
  "bladder-cancer": { rMin: 0.085, rRange: 0.1, amp: 0.14, steps: 6, mult: 2, maxSites: 3, logScale: [0.02, 0.02, 0.025], srgb: [0.51, 0.33, 0.24] },
  "bladder-diverticulum": { rMin: 0.05, rRange: 0.055, amp: 0.21, steps: 7, mult: 1, maxSites: 48, logScale: [0, 0, 0], srgb: [0.53, 0.32, 0.28] },
  "bladder-distension": { rMin: 0.2, rRange: 0.13, amp: 0.0175, steps: 5, mult: 1, maxSites: 48, logScale: [0.19, 0.16, 0.2], srgb: [0.6, 0.4, 0.33] },
  "bladder-contraction": { rMin: 0.15, rRange: 0.1, amp: -0.0245, steps: 5, mult: 2, maxSites: 48, logScale: [-0.18, -0.15, -0.17], srgb: [0.64, 0.53, 0.41] },
  "bladder-diffuse-wall-swelling": { rMin: 0.14, rRange: 0.12, amp: 0.035, steps: 5, mult: 2, maxSites: 48, logScale: [0.08, 0.07, 0.09], srgb: [0.54, 0.19, 0.14] },
  "heart-infarction": { rMin: 0.075, rRange: 0.08, amp: -0.06, steps: 6, mult: 2, maxSites: 48, logScale: [-0.02, -0.025, -0.025], srgb: [0.5921, 0.4367, 0.3304] },
  "heart-ventricular-dilation": { rMin: 0.15, rRange: 0.09, amp: 0.028, steps: 6, mult: 2, maxSites: 48, logScale: [0.15, 0.1, 0.14], srgb: [0.54, 0.2, 0.17] },
  "heart-hypertrophic-envelope": { rMin: 0.1, rRange: 0.07, amp: 0.13, steps: 6, mult: 3, maxSites: 48, logScale: [0.08, 0.035, 0.11], srgb: [0.58, 0.23, 0.18] },
  "heart-focal-aneurysmal-bulge": { rMin: 0.07, rRange: 0.07, amp: 0.21, steps: 7, mult: 1, maxSites: 1, logScale: [0.015, 0.01, 0.015], srgb: [0.64, 0.43, 0.34] },
  "heart-surface-scarring": { rMin: 0.04, rRange: 0.05, amp: -0.078, steps: 7, mult: 3, maxSites: 48, logScale: [-0.015, 0, -0.015], srgb: [0.69, 0.58, 0.46] },
  "lung-cancer": { rMin: 0.05, rRange: 0.055, amp: 0.2, steps: 6, mult: 1, maxSites: 3, logScale: [0, 0, 0], srgb: [0.57, 0.44, 0.34] },
  "lung-emphysema": { rMin: 0.07, rRange: 0.08, amp: 0.16, steps: 6, mult: 2, maxSites: 48, logScale: [0.1, 0.12, 0.1], srgb: [0.548, 0.4042, 0.335] },
  "lung-pleural-retraction": { rMin: 0.06, rRange: 0.065, amp: -0.096, steps: 7, mult: 3, maxSites: 48, logScale: [-0.055, -0.045, -0.035], srgb: [0.6, 0.51, 0.41] },
  "lung-subpleural-cystic-bulge": { rMin: 0.05, rRange: 0.06, amp: 0.21, steps: 7, mult: 1, maxSites: 1, logScale: [0.01, 0.01, 0.01], srgb: [0.6, 0.44, 0.34] },
  "lung-regional-contraction": { rMin: 0.13, rRange: 0.08, amp: -0.102, steps: 6, mult: 2, maxSites: 48, logScale: [-0.0455, -0.0195, -0.0358], srgb: [0.52, 0.34, 0.28] },
  "brain-meningioma": { rMin: 0.05, rRange: 0.055, amp: 0.2, steps: 6, mult: 1, maxSites: 1, logScale: [0, 0, 0], srgb: [0.6285, 0.3974, 0.338] },
  "brain-glioblastoma": { rMin: 0.11, rRange: 0.09, amp: 0.13, steps: 6, mult: 2, maxSites: 48, logScale: [0.025, 0.015, 0.02], srgb: [0.47, 0.32, 0.25] },
  "brain-cortical-atrophy": { rMin: 0.11, rRange: 0.09, amp: -0.0175, steps: 5, mult: 2, maxSites: 48, logScale: [-0.1, -0.075, -0.1], srgb: [0.56, 0.48, 0.4] },
  "brain-diffuse-swelling": { rMin: 0.2, rRange: 0.12, amp: 0.014, steps: 5, mult: 1, maxSites: 48, logScale: [0.07, 0.08, 0.07], srgb: [0.6, 0.45, 0.38] },
  "brain-cortical-retraction": { rMin: 0.065, rRange: 0.07, amp: -0.084, steps: 6, mult: 1, maxSites: 48, logScale: [-0.015, 0, -0.015], srgb: [0.54, 0.4, 0.32] },
};

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The imported variation was cancelled.", "AbortError");
}
function unit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1.`);
}
/** Also exported for an offline caller that already holds the verified bundled model. */
export function importedVariationSystem(model: JointModel, tables: TextCompilerTables): ImportedVariationSystem {
  const references = model.meta.conditions.filter(condition => condition.profile_id === "baseline").map(condition => {
    const entry = tables.templates.find(template => template.template_id === condition.template_id);
    if (!entry || entry.organ !== condition.organ || entry.control_limits.length !== 7 ||
        !entry.control_limits.every(value => Number.isFinite(value) && value >= 0 && value <= 2) ||
        !Number.isFinite(entry.normalization_mm) || entry.normalization_mm <= 0)
      throw new Error(`Missing or invalid reference limits for ${condition.template_id}.`);
    return {
      id: condition.template_id,
      label: [condition.organ.replaceAll("-", " "), entry.sex_label, entry.laterality].filter(Boolean).join(" · "),
      organ: condition.organ, limits: [...entry.control_limits], normalizationMm: entry.normalization_mm,
    };
  });
  if (!references.length || new Set(references.map(entry => entry.id)).size !== references.length)
    throw new Error("The bundled flow has no unique baseline references.");
  const profiles: ImportedDiseaseProfile[] = tables.profiles
    .filter(profile => profile.supported && model.meta.profiles.includes(profile.id) && DISEASE_PROFILE_SPECS[profile.id])
    .map(profile => {
      const spec = DISEASE_PROFILE_SPECS[profile.id]!;
      return {
        id: profile.id,
        organ: profile.organ,
        label: profile.label,
        pattern: profile.pattern,
        mechanism: profile.mechanism ?? profile.pattern,
        ...spec,
      };
    });
  return { model, references, profiles, scope: model.meta.scope };
}
export async function loadImportedVariationSystem(signal?: AbortSignal): Promise<ImportedVariationSystem> {
  aborted(signal);
  const [model, tables] = await Promise.all([loadJointModel(signal), loadTextCompilerTables()]);
  aborted(signal);
  return importedVariationSystem(model, tables);
}
function referenceFor(system: ImportedVariationSystem, id: string): ImportedReference {
  const reference = system.references.find(entry => entry.id === id);
  if (!reference) throw new Error("Choose one of the bundled baseline reference styles.");
  return { ...reference, limits: [...reference.limits] };
}
export function sampleNeuralVariation(system: ImportedVariationSystem, options: {
  referenceId: string; seed: number; temperature: number;
  profileId?: string | null; severity?: "auto" | Exclude<JointSeverity, "baseline">;
}): ImportedVariationRecipe {
  const reference = referenceFor(system, options.referenceId);
  const activeProfileId = options.profileId && options.profileId !== "baseline" ? options.profileId : null;
  const diseaseProfile = activeProfileId
    ? system.profiles.find(entry => entry.id === activeProfileId && entry.organ === reference.organ) ?? null
    : null;
  if (activeProfileId && !diseaseProfile) {
    throw new Error("Choose a disease profile supported by the selected organ reference.");
  }
  const sample = activeProfileId
    ? sampleJointControls(system.model, reference.id, activeProfileId, options.seed, options.temperature, options.severity ?? "auto")
    : sampleJointControls(system.model, reference.id, null, options.seed, options.temperature, "baseline");
  const baseRecipe: ImportedVariationRecipe = {
    controls: { ...sample.controls }, material: { ...sample.material }, reference,
    ...(sample.disease && diseaseProfile ? { disease: sample.disease, diseaseProfile } : {}),
    provenance: {
      method: "joint-flow-recipe-transfer", modelSha256: system.model.meta.model_sha256,
      modelScope: system.model.meta.scope, contextGain: system.model.meta.config.context_gain,
      seed: options.seed, temperature: options.temperature, referenceId: reference.id,
      ...(activeProfileId ? { profileId: activeProfileId, severity: sample.severity } : {}),
      trainingSamples: system.model.meta.training_samples, meshEncoding: false, diseaseInference: false,
    },
  };
  return baseRecipe;
}

/** A deliberately bounded grammar, not an LLM or a mesh generator. Direction words change
 * normalized controls by 0.2. Percentages/units would need a solver on the upload and are refused. */
export function compileImportedText(system: ImportedVariationSystem, referenceId: string, text: string,
  current?: ImportedVariationRecipe): ImportedVariationRecipe {
  if (typeof text !== "string" || !text.trim() || text.length > 1000) throw new Error("Enter 1–1,000 characters of supported shape or appearance edits.");
  const reference = referenceFor(system, referenceId);
  if (current && current.reference.id !== referenceId) throw new Error("Reset or generate with the selected reference before editing its recipe.");
  const condition = system.model.meta.conditions.find(entry => entry.template_id === referenceId && entry.profile_id === "baseline")!;
  // Starting text edits from rest must not introduce an unrequested random shape or appearance.
  const baseline: ImportedVariationRecipe = current ?? {
    reference, controls: Object.fromEntries(CONTROL_NAMES.map(name => [name, 0])),
    material: { version: ATLAS_MATERIAL_VERSION, organ: reference.organ, preset: condition.material_preset,
      seed: 42, tint: 0, pigment_contrast: 0, mottle_scale_mm: 10, wetness: 0.5, fine_detail: 0, structure_strength: 0 },
    provenance: { method: "deterministic-text-controls", modelSha256: null, modelScope: "Bounded rule-based uploaded-mesh edits; no neural sampling.",
      contextGain: 0, seed: 42, temperature: null, referenceId, trainingSamples: 0, meshEncoding: false, diseaseInference: false },
  };
  const controls = current ? { ...current.controls } : Object.fromEntries(CONTROL_NAMES.map(name => [name, 0]));
  const material = { ...baseline.material };
  const shapeDirections: Record<string, [string, number]> = {
    wider: ["scale_x", 0.2], narrower: ["scale_x", -0.2], taller: ["scale_y", 0.2],
    shorter: ["scale_y", -0.2], deeper: ["scale_z", 0.2], flatter: ["scale_z", -0.2],
  };
  const materialDirections: Record<string, [keyof AtlasMaterialRecipe, number]> = {
    wetter: ["wetness", 0.2], drier: ["wetness", -0.2],
    "more mottled": ["pigment_contrast", 0.2], "less mottled": ["pigment_contrast", -0.2],
    "more detailed": ["fine_detail", 0.2], "less detailed": ["fine_detail", -0.2],
  };
  const clauses = text.toLowerCase().trim().replace(/[.!]$/, "").split(/\s*(?:,|;|\band\b)\s*/);
  if (!clauses.length || clauses.some(clause => !clause)) throw new Error("Each text clause must contain a supported edit.");
  for (const original of clauses) {
    const clause = original.replace(/^(?:please\s+)?(?:make\s+)?(?:it\s+|the model\s+|this model\s+)?/, "").trim();
    const shape = shapeDirections[clause];
    if (shape) { controls[shape[0]] = clamp(controls[shape[0]]! + shape[1], -1, 1); continue; }
    const appearance = materialDirections[clause];
    if (appearance) {
      const key = appearance[0] as "wetness" | "pigment_contrast" | "fine_detail";
      material[key] = clamp(material[key] + appearance[1], 0, 1); continue;
    }
    const match = /^(scale_x|scale_y|scale_z|bend|twist|taper|asymmetry|tint|pigment_contrast|mottle_scale_mm|wetness|fine_detail|structure_strength)\s*(?:to|=|:)?\s*(-?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(clause);
    if (!match) throw new Error(`Unsupported edit: “${original}”. Use wider, taller, flatter, bend 0.2, twist -0.3, wetter, or a named material control. Percentages, measured dimensions, new objects and disease changes are not supported.`);
    const key = match[1]!, value = Number(match[2]);
    if ((CONTROL_NAMES as readonly string[]).includes(key)) {
      if (!Number.isFinite(value) || value < -1 || value > 1) throw new Error(`${key} must be between -1 and 1.`);
      controls[key] = value;
    } else {
      const field = MATERIAL_CONTROLS.find(entry => entry.key === key)!;
      if (!Number.isFinite(value) || value < field.min || value > field.max) throw new Error(`${key} must be between ${field.min} and ${field.max}.`);
      (material as unknown as Record<string, unknown>)[key] = value;
    }
  }
  validateAtlasMaterial(material, reference.organ);
  return { controls, material, reference, provenance: {
    ...baseline.provenance, method: "deterministic-text-controls", text,
    // Preserve a learned starting recipe's origin, but never invent one for text-only edits.
    modelSha256: baseline.provenance.modelSha256,
  } };
}

export function createVariationState(root: Object3D): ImportedVariationState {
  root.updateWorldMatrix(true, true);
  const box = new Box3(), point = new Vector3(), meshes: MeshRest[] = [];
  let vertices = 0;
  root.traverse(node => {
    if (!(node instanceof Mesh)) return;
    if ((node as Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean }).isSkinnedMesh ||
        (node as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh ||
        Object.keys(node.geometry.morphAttributes).length)
      throw new Error("Variation requires static, non-instanced meshes without skinning or morph targets.");
    const position = node.geometry.getAttribute("position");
    if (!position || position.itemSize !== 3 || !position.count || !Number.isFinite(node.matrixWorld.determinant()) || Math.abs(node.matrixWorld.determinant()) < 1e-18)
      throw new Error("An imported mesh has missing vertices or a singular transform.");
    const centered = new Float64Array(position.count * 3);
    for (let index = 0; index < position.count; index++) {
      point.fromBufferAttribute(position, index).applyMatrix4(node.matrixWorld);
      if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error("An imported mesh contains non-finite coordinates.");
      point.toArray(centered, index * 3); box.expandByPoint(point);
    }
    vertices += position.count;
    meshes.push({ mesh: node, geometry: node.geometry, material: node.material, world: node.matrixWorld.clone(),
      inverse: node.matrixWorld.clone().invert(), centered });
  });
  if (!meshes.length || box.isEmpty()) throw new Error("Import a static triangle mesh first.");
  const center = box.getCenter(new Vector3()), extent = box.getSize(new Vector3());
  const normalization = Math.max(extent.x, extent.y, extent.z) * 0.5;
  if (!Number.isFinite(normalization) || normalization <= 0) throw new Error("The imported model has no spatial extent.");
  for (const rest of meshes) for (let index = 0; index < rest.centered.length; index += 3) {
    rest.centered[index]! -= center.x; rest.centered[index + 1]! -= center.y; rest.centered[index + 2]! -= center.z;
  }
  return { root, center, normalization, vertices, meshes, epoch: 0, disposed: false, ownedGeometry: [], ownedMaterials: [] };
}

function disposeOwned(state: ImportedVariationState): void {
  for (const geometry of state.ownedGeometry) geometry.dispose();
  for (const material of state.ownedMaterials) material.dispose();
  if (state.ownedTextures) for (const texture of state.ownedTextures) texture.dispose();
  state.ownedGeometry = []; state.ownedMaterials = []; state.ownedTextures = [];
}
export function resetVariation(state: ImportedVariationState): void {
  if (state.disposed) return;
  state.epoch++;
  for (const rest of state.meshes) { rest.mesh.geometry = rest.geometry; rest.mesh.material = rest.material; }
  disposeOwned(state);
}
export function disposeVariationState(state: ImportedVariationState): void {
  resetVariation(state); state.disposed = true;
}

interface SeamlessImportedPbrBundle {
  map: DataTexture;
  normalMap: DataTexture;
  roughnessMap: DataTexture;
  meanMapLinear: [number, number, number];
}

/** Evaluate a 2D toroidally periodic Worley/Voronoi cellular field on [0,1)^2.
 * Returns [f1 (distance to nearest cell center), edge (f2 - f1 septal border), cellHash (0..1 per cell)]. */
function buildPeriodicWorleyGrid(gridN: number, seed: number) {
  const rng = new Pcg64(seed);
  const fx = new Float64Array(gridN * gridN);
  const fy = new Float64Array(gridN * gridN);
  const fh = new Float64Array(gridN * gridN);
  for (let y = 0; y < gridN; y++) {
    for (let x = 0; x < gridN; x++) {
      const idx = y * gridN + x;
      fx[idx] = x + 0.16 + 0.68 * rng.nextDouble();
      fy[idx] = y + 0.16 + 0.68 * rng.nextDouble();
      fh[idx] = rng.nextDouble();
    }
  }
  return (u: number, v: number): [number, number, number] => {
    const gx = ((u % 1) + 1) % 1 * gridN;
    const gy = ((v % 1) + 1) % 1 * gridN;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    let d1 = Infinity, d2 = Infinity, bestHash = 0.5;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = (iy + dy + gridN) % gridN;
      const offsetY = (iy + dy) - cy;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = (ix + dx + gridN) % gridN;
        const offsetX = (ix + dx) - cx;
        const idx = cy * gridN + cx;
        const px = fx[idx]! + offsetX - gx;
        const py = fy[idx]! + offsetY - gy;
        const d = Math.hypot(px, py);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          bestHash = fh[idx]!;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    return [d1, d2 - d1, bestHash];
  };
}

/** Synthesize 3 toroidally seamless 256×256 PBR textures (BaseColor sRGB, tangent Normal, glTF Roughness)
 * using periodic Worley polygonal hepatic lobules, portal triad septa, and 3D parenchymal micro-relief. */
function bakeSeamlessImportedPbrMaps(
  materialRecipe: AtlasMaterialRecipe,
  diseaseProfile: ImportedDiseaseProfile | null | undefined,
  textureStrength: number,
): SeamlessImportedPbrBundle {
  const side = 256;
  const total = side * side;
  const lobuleDetail = new Float64Array(total);
  const septumMask = new Float64Array(total);
  const lobuleHeight = new Float64Array(total);
  const baseSeed = (materialRecipe.seed >>> 0) || 1337;
  const coarseWorley = buildPeriodicWorleyGrid(11, baseSeed + 17);
  const mediumWorley = buildPeriodicWorleyGrid(23, baseSeed + 101);
  const fineWorley = buildPeriodicWorleyGrid(47, baseSeed + 313);
  const isNodularOrFibrotic = diseaseProfile?.pattern === "nodular" || diseaseProfile?.pattern === "fibrotic";
  const macroWorley = isNodularOrFibrotic ? buildPeriodicWorleyGrid(6, baseSeed + 709) : null;

  const detailAmp = (0.48 + 0.52 * textureStrength) * (0.55 + 0.30 * materialRecipe.fine_detail + 0.25 * materialRecipe.structure_strength);
  const baseline = resolveMaterial(materialRecipe);
  const uBase = (baseline.uniforms as Record<string, unknown>).uAtlasBaseColor as number[];
  const uSepta = [uBase[0]! * 0.68, uBase[1]! * 0.62, uBase[2]! * 0.58];
  const uRoughBase = (baseline.uniforms as Record<string, unknown>).uAtlasRoughnessBase as number;

  for (let py = 0; py < side; py++) {
    const v = py / side;
    for (let px = 0; px < side; px++) {
      const u = px / side;
      const idx = py * side + px;
      const [d1, edge1, h1] = coarseWorley(u, v);
      const [d2, edge2, h2] = mediumWorley(u, v);
      const [, edge3, h3] = fineWorley(u, v);

      // Polygonal hepatic lobule domes with inter-lobular portal triad septa and central venule dimple
      const lobuleDome1 = clamp(1 - d1 * 1.15, 0, 1);
      const lobuleDome2 = clamp(1 - d2 * 1.2, 0, 1);
      const septum1 = Math.exp(-edge1 * 9.5);
      const septum2 = Math.exp(-edge2 * 11.0);
      const centralVenule = Math.exp(-d1 * d1 * 28.0);
      const microPore = Math.exp(-edge3 * 14.0);

      let macroDome = 0;
      let macroSeptum = 0;
      if (macroWorley) {
        const [md1, medge] = macroWorley(u, v);
        macroDome = Math.pow(clamp(1 - md1 * 1.08, 0, 1), 1.35);
        macroSeptum = Math.exp(-medge * 8.0);
      }

      const cellTint = (h1 - 0.5) * 0.16 + (h2 - 0.5) * 0.10 + (h3 - 0.5) * 0.06;
      const dome = 0.55 * lobuleDome1 + 0.32 * lobuleDome2 + 0.45 * macroDome;
      const septa = clamp(0.65 * septum1 + 0.35 * septum2 + 0.85 * macroSeptum, 0, 1);

      septumMask[idx] = clamp(septa + 0.45 * centralVenule, 0, 1);
      lobuleDetail[idx] = clamp(1 + detailAmp * (cellTint + 0.18 * (dome - 0.45) - 0.22 * septa - 0.18 * centralVenule), 0.62, 1.38);
      lobuleHeight[idx] = detailAmp * (0.22 * dome - 0.18 * septa - 0.10 * centralVenule - 0.04 * microPore);
    }
  }

  const baseData = new Uint8Array(total * 4);
  const normalData = new Uint8Array(total * 4);
  const roughData = new Uint8Array(total * 4);
  const diseaseLinear = diseaseProfile ? diseaseProfile.srgb.map(srgbToLinear) as [number, number, number] : null;
  let sumR = 0, sumG = 0, sumB = 0;

  for (let i = 0; i < total; i++) {
    const i4 = i * 4;
    const mod = lobuleDetail[i]!;
    const sMask = septumMask[i]!;
    for (let k = 0; k < 3; k++) {
      let lin = uBase[k]! * (1 - 0.42 * sMask) + uSepta[k]! * (0.42 * sMask);
      if (diseaseLinear && isNodularOrFibrotic) {
        lin = lin * (1 - 0.28 * sMask) + diseaseLinear[k]! * (0.28 * sMask);
      }
      // Encode rich parenchymal micro-detail around a well-conditioned sRGB carrier so map * vertexColor is exact
      const carrierSrgb = clamp((0.68 + 0.18 * linearToSrgb(clamp(lin, 0.01, 0.98))) * mod, 0.18, 0.98);
      const byte = Math.round(carrierSrgb * 255);
      baseData[i4 + k] = byte;
      const decodedLin = srgbToLinear(byte / 255);
      if (k === 0) sumR += decodedLin;
      else if (k === 1) sumG += decodedLin;
      else sumB += decodedLin;
    }
    baseData[i4 + 3] = 255;

    // Roughness map (glTF standard: Green channel = roughness, Blue channel = metalness 0)
    // Lobule domes are wetter/smoother (serous Glisson capsule); fibrotic septa are rougher
    const rVal = clamp(0.76 + (uRoughBase - 0.34) * 0.45 + 0.22 * sMask - (mod - 1) * 0.25, 0.36, 0.98);
    const rByte = Math.round(rVal * 255);
    roughData[i4] = 255;
    roughData[i4 + 1] = rByte;
    roughData[i4 + 2] = 0;
    roughData[i4 + 3] = 255;
  }

  // Tangent-space normal map from periodic central differences on the Worley lobular heightfield
  const normalSlope = (4.2 + 3.5 * materialRecipe.fine_detail + 2.8 * materialRecipe.structure_strength + (isNodularOrFibrotic ? 3.2 : 0)) * (0.55 + 0.45 * textureStrength);
  for (let py = 0; py < side; py++) {
    const pyPrev = (py + side - 1) % side, pyNext = (py + 1) % side;
    for (let px = 0; px < side; px++) {
      const pxPrev = (px + side - 1) % side, pxNext = (px + 1) % side;
      const idx = py * side + px, i4 = idx * 4;
      const hL = lobuleHeight[py * side + pxPrev]!;
      const hR = lobuleHeight[py * side + pxNext]!;
      const hD = lobuleHeight[pyPrev * side + px]!;
      const hU = lobuleHeight[pyNext * side + px]!;
      let nx = -(hR - hL) * normalSlope;
      let ny = -(hU - hD) * normalSlope;
      let nz = 1.0;
      const invLen = 1 / Math.max(1e-8, Math.hypot(nx, ny, nz));
      nx *= invLen; ny *= invLen; nz *= invLen;
      normalData[i4] = Math.round(clamp(0.5 + 0.5 * nx, 0, 1) * 255);
      normalData[i4 + 1] = Math.round(clamp(0.5 + 0.5 * ny, 0, 1) * 255);
      normalData[i4 + 2] = Math.round(clamp(0.5 + 0.5 * nz, 0.5, 1) * 255);
      normalData[i4 + 3] = 255;
    }
  }

  const configure = (tex: DataTexture, srgb: boolean): DataTexture => {
    tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };

  return {
    map: configure(new DataTexture(baseData, side, side, RGBAFormat, UnsignedByteType), true),
    normalMap: configure(new DataTexture(normalData, side, side, RGBAFormat, UnsignedByteType), false),
    roughnessMap: configure(new DataTexture(roughData, side, side, RGBAFormat, UnsignedByteType), false),
    meanMapLinear: [
      Math.max(0.08, sumR / total),
      Math.max(0.08, sumG / total),
      Math.max(0.08, sumB / total),
    ],
  };
}

interface ImportedDiseaseSite {
  cx: number; cy: number; cz: number;
  dx: number; dy: number; dz: number;
  radius: number; amplitude: number;
}
interface ImportedDiseaseField {
  sites: ImportedDiseaseSite[];
  steps: number;
  globalScale: [number, number, number];
  targetLinear: [number, number, number];
  colorStrength: number;
}

/** Deterministic 3D pathology site placement in centered rest space for Joint Flow v2 disease recipes. */
function buildImportedDiseaseField(
  state: ImportedVariationState,
  disease: AtlasDiseaseSpec,
  profile: ImportedDiseaseProfile,
  shapeStrength: number,
  textureStrength: number,
): ImportedDiseaseField {
  const firstMesh = state.meshes[0]!;
  const coords = firstMesh.centered;
  const vertexCount = coords.length / 3;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < coords.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const val = coords[i + k]!;
      if (val < lo[k]!) lo[k] = val;
      if (val > hi[k]!) hi[k] = val;
    }
  }
  const extent = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] as const;
  const diagonal = Math.max(Math.hypot(extent[0], extent[1], extent[2]), 1e-6);
  const target = [
    (lo[0] + hi[0]) * 0.5 + disease.location[0] * extent[0] * 0.5,
    (lo[1] + hi[1]) * 0.5 + disease.location[1] * extent[1] * 0.5,
    (lo[2] + hi[2]) * 0.5 + disease.location[2] * extent[2] * 0.5,
  ] as const;

  let firstIdx = 0, bestDist2 = Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const d2 = (coords[i * 3]! - target[0]) ** 2 + (coords[i * 3 + 1]! - target[1]) ** 2 + (coords[i * 3 + 2]! - target[2]) ** 2;
    if (d2 < bestDist2) { bestDist2 = d2; firstIdx = i; }
  }

  const rng = new Pcg64(disease.seed);
  const radius = Math.max(diagonal * (profile.rMin + profile.rRange * disease.size), diagonal * 0.04);
  const count = Math.min(profile.maxSites, Math.max(1, Math.round(disease.count * profile.mult)));
  const anchors = [firstIdx];
  const isDensePattern = profile.pattern === "nodular" || profile.pattern === "multifocal" || profile.pattern === "fibrotic";
  const reach = diagonal * (isDensePattern ? 0.55 + 0.45 * disease.spread : 0.25 + 0.75 * disease.spread);
  const separation = radius * (isDensePattern ? 0.46 : 0.82);
  const stride = Math.max(1, Math.floor(vertexCount / 768));
  const pool: number[] = [];
  for (let i = 0; i < vertexCount; i += stride) pool.push(i);
  const distBetween = (a: number, b: number) => Math.hypot(
    coords[a * 3]! - coords[b * 3]!,
    coords[a * 3 + 1]! - coords[b * 3 + 1]!,
    coords[a * 3 + 2]! - coords[b * 3 + 2]!,
  );
  for (const idx of rng.permutation(pool)) {
    if (anchors.length >= count) break;
    if (distBetween(idx, firstIdx) <= reach && anchors.every(a => distBetween(a, idx) > separation)) {
      anchors.push(idx);
    }
  }

  const sign = Math.sign(profile.amp) || 1;
  const steps = Math.max(1, profile.steps);
  const maxStepRatio = 0.24 / steps;
  const shapeFactor = shapeStrength > 0 ? (0.52 + 0.68 * shapeStrength) : 0;
  const severityFactor = 0.48 + 0.52 * disease.severity;
  const sites: ImportedDiseaseSite[] = anchors.map(idx => {
    const cx = coords[idx * 3]!, cy = coords[idx * 3 + 1]!, cz = coords[idx * 3 + 2]!;
    const outLen = Math.max(Math.hypot(cx, cy, cz), 1e-12);
    const dx = (cx / outLen) * sign, dy = (cy / outLen) * sign, dz = (cz / outLen) * sign;
    const siteRadius = radius * (0.78 + 0.44 * rng.nextDouble());
    const ratio = Math.min((Math.abs(profile.amp) * 1.55) / steps, maxStepRatio) * severityFactor * shapeFactor * (1 - 0.30 * disease.irregularity * rng.nextDouble());
    return { cx, cy, cz, dx, dy, dz, radius: siteRadius, amplitude: siteRadius * ratio };
  });

  const globalScale: [number, number, number] = [
    Math.exp(profile.logScale[0] * severityFactor * shapeFactor),
    Math.exp(profile.logScale[1] * severityFactor * shapeFactor),
    Math.exp(profile.logScale[2] * severityFactor * shapeFactor),
  ];

  return {
    sites,
    steps,
    globalScale,
    targetLinear: profile.srgb.map(srgbToLinear) as [number, number, number],
    colorStrength: clamp(severityFactor * (0.55 + 0.45 * disease.contrast) * (0.55 + 0.45 * textureStrength), 0, 0.94),
  };
}

/** Analytic derivative of the existing scale/taper/twist/bend/shear map, in world axes. */
function derivative(x: number, y: number, z: number, c: number[], normalization: number): Matrix3 {
  const e0 = Math.exp(c[0]!), e1 = Math.exp(c[1]!), e2 = Math.exp(c[2]!);
  const xx = x / normalization * e0, yy = y / normalization * e1;
  const t = Math.tanh(z / normalization * e2), dt = 1 - t * t;
  const grow = Math.exp(c[5]! * t), cs = Math.cos(c[4]! * t), sn = Math.sin(c[4]! * t);
  const rx = cs * xx - sn * yy, ry = sn * xx + cs * yy;
  const X = grow * rx + c[3]! * t * t;
  const a = grow * cs * e0, b = -grow * sn * e1;
  const d = grow * sn * e0, e = grow * cs * e1;
  const cc = (grow * dt * (c[5]! * rx - c[4]! * ry) + 2 * c[3]! * t * dt) * e2;
  const f = grow * dt * (c[5]! * ry + c[4]! * rx) * e2;
  const shear = c[6]! * (1 - Math.tanh(X) ** 2);
  return new Matrix3().set(a, b, cc, d, e, f, shear * a, shear * b, e2 + shear * cc);
}
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Atomic publication: cancellation, invalid output or concurrent reset leaves the current scene unchanged. */
export async function applyVariation(state: ImportedVariationState, recipe: ImportedVariationRecipe,
  options: VariationOptions): Promise<VariationReport> {
  if (state.disposed) throw new Error("This imported model has been disposed.");
  unit(options.shapeStrength, "Shape strength"); unit(options.textureStrength, "Texture strength");
  const reference = recipe.reference;
  if (reference.limits.length !== 7 || reference.limits.some(value => !Number.isFinite(value) || value < 0 || value > 2) ||
      !Number.isFinite(reference.normalizationMm) || reference.normalizationMm <= 0 ||
      Object.keys(recipe.controls).length !== 7 || CONTROL_NAMES.some(name => !Number.isFinite(recipe.controls[name]) || Math.abs(recipe.controls[name]!) > 1))
    throw new Error("Invalid bounded variation recipe.");
  validateAtlasMaterial(recipe.material, reference.organ);
  const epoch = ++state.epoch;
  const check = () => {
    aborted(options.signal);
    if (state.disposed || state.epoch !== epoch) throw new DOMException("The imported variation was superseded.", "AbortError");
  };
  check();
  state.root.updateWorldMatrix(true, true);
  for (const rest of state.meshes)
    if (rest.mesh.matrixWorld.elements.some((value, index) => Math.abs(value - rest.world.elements[index]!) > 1e-10))
      throw new Error("The imported transforms changed. Reset the model before creating another variation state.");
  const controls = Object.fromEntries(CONTROL_NAMES.map(name => [name, recipe.controls[name]! * options.shapeStrength]));
  const c = CONTROL_NAMES.map((name, index) => controls[name]! * reference.limits[index]!);
  const diseaseField = recipe.disease && recipe.diseaseProfile && (options.shapeStrength > 0 || options.textureStrength > 0)
    ? buildImportedDiseaseField(state, recipe.disease, recipe.diseaseProfile, options.shapeStrength, options.textureStrength)
    : null;
  const hasDiseaseShape = Boolean(diseaseField && options.shapeStrength > 0 && diseaseField.sites.some(s => s.amplitude !== 0));
  const shaping = c.some(value => value !== 0) || hasDiseaseShape, texturing = options.textureStrength > 0;
  const geometries: BufferGeometry[] = [], materials: Material[] = [], textures: Texture[] = [];
  const pending: { rest: MeshRest; geometry: BufferGeometry; material: Material | Material[] }[] = [];
  let minJacobian = Infinity, maxJacobian = -Infinity, triangles = 0;
  let seamlessBundle: SeamlessImportedPbrBundle | null = null;
  let anySeamlessSynthesized = false;
  let anySourceMapsReplaced = false;
  const v = new Vector3(), n = new Vector3(), tangentVector = new Vector3();
  const baseline = resolveMaterial({ ...recipe.material, tint: 0 });
  const base = (baseline.uniforms as Record<string, unknown>).uAtlasBaseColor as number[];
  const roughnessBase = (baseline.uniforms as Record<string, unknown>).uAtlasRoughnessBase as number;
  try {
    for (const rest of state.meshes) {
      check();
      const geometry = rest.geometry.clone(); geometries.push(geometry);
      const position = rest.geometry.getAttribute("position");
      const count = position.count;
      const positions = new Float32Array(count * 3);
      const sourceNormal = rest.geometry.getAttribute("normal");
      const sourceTangent = rest.geometry.getAttribute("tangent");
      const normal = sourceNormal ? new Float32Array(count * 3) : null;
      const tangent = sourceTangent ? new Float32Array(count * 4) : null;
      const sourceColor = rest.geometry.getAttribute("color");
      const sourceMaterials = Array.isArray(rest.material) ? rest.material : [rest.material];
      const colorModes = new Set(sourceMaterials.map(material => Boolean((material as Material & { vertexColors?: boolean }).vertexColors)));
      if (texturing && sourceColor && colorModes.size > 1)
        throw new Error("This mesh mixes materials with different vertex-color settings. Use shape-only variation to preserve those source materials.");
      const useSourceColor = Boolean(sourceColor && colorModes.has(true));
      const sourceHasTextureMap = sourceMaterials.some(material => {
        const m = material as Material & { map?: Texture | null; normalMap?: Texture | null; roughnessMap?: Texture | null };
        return Boolean(m.map || m.normalMap || m.roughnessMap);
      });
      // Untextured meshes (or explicit seamless synthesis requests) receive full 3D tissue color + 3 seamless PBR maps
      const synthesizeSeamless = texturing && (
        options.synthesizeSeamlessTextures === true ||
        (options.synthesizeSeamlessTextures !== false && !sourceHasTextureMap && !useSourceColor)
      );
      if (synthesizeSeamless) {
        anySeamlessSynthesized = true;
        if (sourceHasTextureMap) anySourceMapsReplaced = true;
        if (!seamlessBundle) {
          seamlessBundle = bakeSeamlessImportedPbrMaps(recipe.material, recipe.diseaseProfile, options.textureStrength);
          textures.push(seamlessBundle.map, seamlessBundle.normalMap, seamlessBundle.roughnessMap);
        }
      }
      const uvs = synthesizeSeamless ? new Float32Array(count * 2) : null;
      const colorSize = sourceColor?.itemSize === 4 ? 4 : 3;
      const colors = texturing ? new Float32Array(count * colorSize) : null;
      const worldLinear = new Matrix3().setFromMatrix4(rest.world);
      const localLinear = worldLinear.clone().invert(), worldNormal = worldLinear.clone().invert().transpose();
      const localNormal = worldLinear.clone().transpose();
      let roughnessSum = 0;
      for (let start = 0; start < count; start += 4096) {
        check();
        const end = Math.min(count, start + 4096), points = rest.centered.subarray(start * 3, end * 3);
        let stagePoints: Float64Array = points;
        if (hasDiseaseShape && diseaseField) {
          stagePoints = Float64Array.from(points);
          const [gx, gy, gz] = diseaseField.globalScale;
          for (let i = 0; i < stagePoints.length; i += 3) {
            let px = stagePoints[i]!, py = stagePoints[i + 1]!, pz = stagePoints[i + 2]!;
            for (const site of diseaseField.sites) {
              const r2 = site.radius * site.radius;
              for (let step = 0; step < diseaseField.steps; step++) {
                const dx = px - site.cx, dy = py - site.cy, dz = pz - site.cz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 >= r2) break;
                const w = 1 - d2 / r2, w3 = w * w * w;
                px += w3 * site.amplitude * site.dx;
                py += w3 * site.amplitude * site.dy;
                pz += w3 * site.amplitude * site.dz;
              }
            }
            stagePoints[i] = px * gx;
            stagePoints[i + 1] = py * gy;
            stagePoints[i + 2] = pz * gz;
          }
        }
        const deformed = shaping ? deformVertices(stagePoints, controls, reference.limits, state.normalization) : points;
        const fieldPoints = texturing ? Float64Array.from(points, value => value / state.normalization * reference.normalizationMm) : null;
        const field = fieldPoints ? sampleMaterialField(recipe.material, fieldPoints) : null;
        for (let index = start; index < end; index++) {
          const local = (index - start) * 3, offset = index * 3;
          const rx = rest.centered[offset]!, ry = rest.centered[offset + 1]!, rz = rest.centered[offset + 2]!;
          v.fromArray(deformed, local).add(state.center).applyMatrix4(rest.inverse);
          if (![v.x, v.y, v.z].every(Number.isFinite)) throw new Error("Variation produced non-finite coordinates.");
          v.toArray(positions, offset);
          if (uvs) {
            // Smooth C^infinity branch-cut-free 3D rest-space + normal UV coordinates (isotropic across all 3D orientations)
            const nxRest = rx / state.normalization, nyRest = ry / state.normalization, nzRest = rz / state.normalization;
            const snx = sourceNormal ? sourceNormal.getX(index) : 0;
            const sny = sourceNormal ? sourceNormal.getY(index) : 0;
            const snz = sourceNormal ? sourceNormal.getZ(index) : 0;
            uvs[index * 2] = 1.35 * nxRest + 0.15 * nyRest - 0.65 * nzRest + 0.42 * snx - 0.24 * snz;
            uvs[index * 2 + 1] = -0.25 * nxRest + 1.35 * nyRest + 0.55 * nzRest + 0.42 * sny + 0.24 * snz;
          }
          if (shaping) {
            const jacobian = derivative(rx, ry, rz, c, state.normalization);
            const determinant = jacobian.determinant();
            if (!(determinant > 0) || !Number.isFinite(determinant)) throw new Error("Variation produced an invalid local deformation.");
            minJacobian = Math.min(minJacobian, determinant); maxJacobian = Math.max(maxJacobian, determinant);
            if (normal && sourceNormal) {
              n.fromBufferAttribute(sourceNormal, index).applyMatrix3(worldNormal)
                .applyMatrix3(jacobian.clone().invert().transpose()).applyMatrix3(localNormal).normalize();
              n.toArray(normal, offset);
            }
            if (tangent && sourceTangent) {
              tangentVector.fromBufferAttribute(sourceTangent, index).applyMatrix3(worldLinear).applyMatrix3(jacobian).applyMatrix3(localLinear);
              if (normal) tangentVector.addScaledVector(n, -tangentVector.dot(n));
              tangentVector.normalize().toArray(tangent, index * 4); tangent[index * 4 + 3] = sourceTangent.getW(index);
            }
          }
          if (colors && field) {
            let diseaseMask = 0;
            let rimMask = 0;
            if (diseaseField && diseaseField.colorStrength > 0) {
              for (const site of diseaseField.sites) {
                const dx = rx - site.cx, dy = ry - site.cy, dz = rz - site.cz;
                const rNorm2 = (dx * dx + dy * dy + dz * dz) / (site.radius * site.radius);
                if (rNorm2 < 1) {
                  const support = 1 - rNorm2;
                  const dome = support * support;
                  diseaseMask = Math.max(diseaseMask, dome);
                  rimMask = Math.max(rimMask, 4 * rNorm2 * support);
                }
              }
              diseaseMask *= diseaseField.colorStrength;
              rimMask *= diseaseField.colorStrength;
            }
            if (synthesizeSeamless && seamlessBundle) {
              const contrastMix = 0.55 + 0.45 * options.textureStrength;
              const isNodular = recipe.diseaseProfile?.pattern === "nodular" || recipe.diseaseProfile?.pattern === "fibrotic";
              for (let channel = 0; channel < 3; channel++) {
                const baseLin = base[channel]!;
                const sampleLin = field.rgbLinear[local + channel]!;
                // Deep hemoglobin optical absorption curve so high-key studio lighting renders rich surgical visceral color
                const rawLin = clamp(baseLin + contrastMix * (sampleLin - baseLin), 0.002, 0.98);
                let targetLin = Math.pow(rawLin, channel === 0 ? 1.18 : 1.42) * (channel === 0 ? 0.54 : 0.36);
                if (diseaseMask > 0 && diseaseField) {
                  const dLin = Math.pow(clamp(diseaseField.targetLinear[channel]!, 0.005, 0.98), 1.12) * 0.62;
                  targetLin = targetLin * (1 - diseaseMask) + dLin * diseaseMask;
                  if (isNodular && rimMask > 0) {
                    // Darker fibrotic inter-nodular septa trench ring around regenerative nodules
                    targetLin *= (1 - 0.32 * rimMask);
                  }
                }
                // Compensate against seamlessBundle.meanMapLinear so map * vertexColor == targetLin in Three.js / glTF
                colors[index * colorSize + channel] = clamp(targetLin / seamlessBundle.meanMapLinear[channel]!, 0.015, 1);
              }
            } else {
              for (let channel = 0; channel < 3; channel++) {
                const original = useSourceColor ? sourceColor!.getComponent(index, channel) : 1;
                let sampleLin = field.rgbLinear[local + channel]!;
                if (diseaseMask > 0 && diseaseField) {
                  sampleLin = sampleLin * (1 - diseaseMask) + diseaseField.targetLinear[channel]! * diseaseMask;
                }
                const modulation = clamp(sampleLin / Math.max(0.01, base[channel]!), 0.35, 1.65);
                colors[index * colorSize + channel] = clamp(original * (1 + options.textureStrength * (modulation - 1)), 0, 1);
              }
            }
            if (colorSize === 4) colors[index * 4 + 3] = useSourceColor ? sourceColor!.getW(index) : 1;
            roughnessSum += field.roughness[index - start]!;
          }
        }
        await yieldTask();
      }
      if (shaping) {
        geometry.setAttribute("position", new BufferAttribute(positions, 3));
        if (normal && !hasDiseaseShape) geometry.setAttribute("normal", new BufferAttribute(normal, 3));
        else geometry.computeVertexNormals();
        if (tangent && !hasDiseaseShape) geometry.setAttribute("tangent", new BufferAttribute(tangent, 4));
      }
      if (uvs) {
        geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
        if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
        const normAttr = geometry.getAttribute("normal");
        if (normAttr && (!tangent || hasDiseaseShape)) {
          const synthTangents = new Float32Array(count * 4);
          for (let vi = 0; vi < count; vi++) {
            const nx = normAttr.getX(vi), ny = normAttr.getY(vi), nz = normAttr.getZ(vi);
            // Smooth orthonormal tangent basis perpendicular to vertex normal (prevents dFdx(vUv) screen-space streaks)
            let rxAxis = 0.8, ryAxis = 0.6, rzAxis = 0.0;
            if (Math.abs(nx * rxAxis + ny * ryAxis) > 0.9) { rxAxis = 0.0; ryAxis = 0.8; rzAxis = 0.6; }
            const dot = nx * rxAxis + ny * ryAxis + nz * rzAxis;
            let tx = rxAxis - dot * nx, ty = ryAxis - dot * ny, tz = rzAxis - dot * nz;
            const inv = 1 / Math.max(1e-8, Math.hypot(tx, ty, tz));
            synthTangents[vi * 4] = tx * inv;
            synthTangents[vi * 4 + 1] = ty * inv;
            synthTangents[vi * 4 + 2] = tz * inv;
            synthTangents[vi * 4 + 3] = 1;
          }
          geometry.setAttribute("tangent", new BufferAttribute(synthTangents, 4));
        }
      }
      if (colors) geometry.setAttribute("color", new BufferAttribute(colors, colorSize));
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const indices = geometry.index;
      triangles += Math.floor((indices?.count ?? count) / 3);
      // Positive continuous Jacobians do not alone guarantee a valid coarse triangle approximation.
      if (shaping) {
        const oldPosition = rest.geometry.getAttribute("position"), next = geometry.getAttribute("position");
        const a = new Vector3(), b = new Vector3(), cc = new Vector3();
        const area = (attribute: typeof oldPosition, at: number) => {
          a.fromBufferAttribute(attribute, indices ? indices.getX(at) : at);
          b.fromBufferAttribute(attribute, indices ? indices.getX(at + 1) : at + 1);
          cc.fromBufferAttribute(attribute, indices ? indices.getX(at + 2) : at + 2);
          return b.sub(a).cross(cc.sub(a)).lengthSq();
        };
        for (let face = 0; face + 2 < (indices?.count ?? count); face += 3) {
          const before = area(oldPosition, face), after = area(next, face);
          if (!Number.isFinite(after) || (before > 0 && after <= before * 1e-12)) throw new Error("Variation collapsed a source triangle.");
          if (face % 12288 === 0) { await yieldTask(); check(); }
        }
      }
      const cloneMaterial = (source: Material): Material => {
        const material = source.clone(); materials.push(material);
        if (texturing) {
          (material as Material & { vertexColors: boolean }).vertexColors = true;
          const std = material as Material & {
            color?: Color; roughness?: number; metalness?: number;
            map?: Texture | null; normalMap?: Texture | null; roughnessMap?: Texture | null;
            normalScale?: Vector2; envMapIntensity?: number;
          };
          if (synthesizeSeamless && seamlessBundle) {
            if (std.color instanceof Color) std.color.setRGB(1, 1, 1);
            std.map = seamlessBundle.map;
            std.normalMap = seamlessBundle.normalMap;
            std.roughnessMap = seamlessBundle.roughnessMap;
            if (std.normalScale instanceof Vector2) {
              const nScale = 0.65 + 0.65 * options.textureStrength;
              std.normalScale.set(nScale, nScale);
            }
            if (typeof std.metalness === "number") std.metalness = 0;
            if (typeof std.roughness === "number") {
              std.roughness = clamp(0.28 + 0.42 * (roughnessSum / count), 0.24, 0.72);
            }
            if (typeof std.envMapIntensity === "number") {
              std.envMapIntensity = clamp(0.38 + 0.34 * recipe.material.wetness, 0.25, 0.78);
            }
          } else if (typeof std.roughness === "number") {
            std.roughness = clamp(std.roughness + options.textureStrength * (roughnessSum / count - roughnessBase), 0, 1);
          }
          material.needsUpdate = true;
        }
        return material;
      };
      const material = Array.isArray(rest.material) ? rest.material.map(cloneMaterial) : cloneMaterial(rest.material);
      pending.push({ rest, geometry, material });
    }
    check();
    for (const item of pending) { item.rest.mesh.geometry = item.geometry; item.rest.mesh.material = item.material; }
    disposeOwned(state);
    state.ownedGeometry = geometries; state.ownedMaterials = materials; state.ownedTextures = textures;
    return {
      vertices: state.vertices, triangles, minJacobian: shaping ? minJacobian : 1, maxJacobian: shaping ? maxJacobian : 1,
      topologyPreserved: true, sourceResourcesRetained: true,
      sourceMaterialMapsRetained: !anySourceMapsReplaced,
      appearanceEncoding: !texturing
        ? "original"
        : anySeamlessSynthesized
          ? "seamless-3d-pbr-synthesis"
          : "linear-vertex-color-modulation",
      ...(anySeamlessSynthesized ? { synthesizedTextures: textures.length } : {}),
      coordinateFrame: "shared-centered-source-bounds", selfIntersection: "not-tested", provenance: { ...recipe.provenance },
      warnings: [
        recipe.provenance.modelSha256
          ? "The starting recipe was learned from synthetic atlas controls; the uploaded mesh was not encoded or anatomically validated."
          : "Text edits use bounded deterministic rules; the uploaded mesh was not encoded or anatomically validated.",
        ...(texturing
          ? anySeamlessSynthesized
            ? ["Seamless 3D rest-space PBR textures (BaseColor, Normal, Roughness) and continuous 3D vertex colors were synthesized for this surface."]
            : ["Appearance modulation is stored in vertex colors; detail is limited by source mesh density. Original texture maps remain attached."]
          : []),
        "Normalized reference coordinates are design coordinates, not calibrated physical dimensions of the upload.",
      ],
    };
  } catch (error) {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    throw error;
  }
}
