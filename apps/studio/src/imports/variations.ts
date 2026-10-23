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
import { computeAngleWeightedNormals } from "./laparoscopicScene";

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

interface PeriodicWorleyTable {
  d1: Float32Array;
  edge: Float32Array;
  hash: Float32Array;
}

interface PeriodicVascularTable {
  arteryMask: Float32Array;
  veinMask: Float32Array;
  vesselHeight: Float32Array;
  adiposeHalo: Float32Array;
  fasciaWave: Float32Array;
}

const WORLEY_TABLE_SIDE = 256;
let cachedWorleyTables: {
  grid6: PeriodicWorleyTable;
  grid11: PeriodicWorleyTable;
  grid23: PeriodicWorleyTable;
  grid47: PeriodicWorleyTable;
} | null = null;
let cachedVascularTable: PeriodicVascularTable | null = null;

/** Evaluate a 2D toroidally periodic Worley/Voronoi cellular field on [0,1)^2 once per grid frequency
 * and store the 256×256 periodic lattice for O(1) toroidal phase-shifted lookups. */
function buildPeriodicWorleyTable(gridN: number, seed: number): PeriodicWorleyTable {
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
  const side = WORLEY_TABLE_SIDE;
  const total = side * side;
  const d1Arr = new Float32Array(total);
  const edgeArr = new Float32Array(total);
  const hashArr = new Float32Array(total);
  for (let py = 0; py < side; py++) {
    const gy = (py / side) * gridN;
    const iy = Math.floor(gy);
    for (let px = 0; px < side; px++) {
      const gx = (px / side) * gridN;
      const ix = Math.floor(gx);
      let d1 = Infinity, d2 = Infinity, bestHash = 0.5;
      for (let dy = -1; dy <= 1; dy++) {
        const cy = (iy + dy + gridN) % gridN;
        const offsetY = (iy + dy) - cy;
        for (let dx = -1; dx <= 1; dx++) {
          const cx = (ix + dx + gridN) % gridN;
          const offsetX = (ix + dx) - cx;
          const idx = cy * gridN + cx;
          const vx = fx[idx]! + offsetX - gx;
          const vy = fy[idx]! + offsetY - gy;
          const d = Math.hypot(vx, vy);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            bestHash = fh[idx]!;
          } else if (d < d2) {
            d2 = d;
          }
        }
      }
      const pIdx = py * side + px;
      d1Arr[pIdx] = d1;
      edgeArr[pIdx] = d2 - d1;
      hashArr[pIdx] = bestHash;
    }
  }
  return { d1: d1Arr, edge: edgeArr, hash: hashArr };
}

function getPeriodicWorleyTables() {
  if (!cachedWorleyTables) {
    cachedWorleyTables = {
      grid6: buildPeriodicWorleyTable(6, 4709),
      grid11: buildPeriodicWorleyTable(11, 1017),
      grid23: buildPeriodicWorleyTable(23, 2101),
      grid47: buildPeriodicWorleyTable(47, 3313),
    };
  }
  return cachedWorleyTables;
}

/** Synthesize a toroidally periodic 256×256 4-generation Murray's-Law bifurcating vascular tree
 * (paired oxygenated arterial trunks + companion deoxygenated venae comitantes + perivascular fat cuff
 * + cylindrical 3D vessel elevation + anisotropic collagenous fascia waves) via fast bounding-box splatting. */
function buildPeriodicVascularTable(): PeriodicVascularTable {
  const side = WORLEY_TABLE_SIDE;
  const mask = side - 1;
  const total = side * side;
  const arteryMask = new Float32Array(total);
  const veinMask = new Float32Array(total);
  const vesselHeight = new Float32Array(total);
  const adiposeHalo = new Float32Array(total);
  const fasciaWave = new Float32Array(total);

  const rng = new Pcg64(7919);

  const pointToSegmentDist2 = (
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
  ): number => {
    const abx = bx - ax, aby = by - ay;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-12) return (px - ax) ** 2 + (py - ay) ** 2;
    const t = clamp(((px - ax) * abx + (py - ay) * aby) / len2, 0, 1);
    const qx = ax + t * abx, qy = ay + t * aby;
    return (px - qx) ** 2 + (py - qy) ** 2;
  };

  const splatSegment = (
    axPx: number, ayPx: number,
    bxPx: number, byPx: number,
    rArtPx: number, rVeinPx: number,
    vOffX: number, vOffY: number,
    gen: number, weight: number,
  ) => {
    const vax = axPx + vOffX, vay = ayPx + vOffY;
    const vbx = bxPx + vOffX * 0.92, vby = byPx + vOffY * 0.92;
    const rFatPx = gen === 0 ? rArtPx * 5.6 : gen === 1 ? rArtPx * 4.4 : rArtPx * 3.0;
    const pad = Math.ceil(Math.max(rFatPx, rVeinPx + Math.hypot(vOffX, vOffY)) + 1.5);
    const minX = Math.floor(Math.min(axPx, bxPx, vax, vbx) - pad);
    const maxX = Math.ceil(Math.max(axPx, bxPx, vax, vbx) + pad);
    const minY = Math.floor(Math.min(ayPx, byPx, vay, vby) - pad);
    const maxY = Math.ceil(Math.max(ayPx, byPx, vay, vby) + pad);
    const rArt2 = rArtPx * rArtPx;
    const rVein2 = rVeinPx * rVeinPx;
    const rFat2 = rFatPx * rFatPx;

    for (let iy = minY; iy <= maxY; iy++) {
      const wy = (iy & mask) << 8;
      const py = iy + 0.5;
      for (let ix = minX; ix <= maxX; ix++) {
        const idx = wy | (ix & mask);
        const px = ix + 0.5;
        const d2Art = pointToSegmentDist2(px, py, axPx, ayPx, bxPx, byPx);
        if (d2Art < rArt2) {
          const u2 = d2Art / rArt2;
          const m = (1 - u2) * (1 - u2) * weight;
          const h = Math.sqrt(Math.max(0, 1 - u2)) * weight;
          if (m > arteryMask[idx]!) arteryMask[idx] = m;
          if (h > vesselHeight[idx]!) vesselHeight[idx] = h;
        }
        if (gen <= 2 && d2Art < rFat2) {
          const uf2 = d2Art / rFat2;
          const fatEnv = (1 - uf2) * (gen === 0 ? 1.0 : gen === 1 ? 0.85 : 0.55);
          if (fatEnv > adiposeHalo[idx]!) adiposeHalo[idx] = fatEnv;
        }
        const d2Vein = pointToSegmentDist2(px, py, vax, vay, vbx, vby);
        if (d2Vein < rVein2) {
          const uv2 = d2Vein / rVein2;
          const mv = (1 - uv2) * (1 - uv2) * weight * 0.94;
          const hv = Math.sqrt(Math.max(0, 1 - uv2)) * weight * 0.84;
          if (mv > veinMask[idx]!) veinMask[idx] = mv;
          if (hv > vesselHeight[idx]!) vesselHeight[idx] = hv;
        }
      }
    }
  };

  const spawnBranch = (
    x0: number, y0: number,
    theta: number, length: number,
    rArtPx: number, gen: number,
  ) => {
    const steps = 8;
    const stepLen = (length * side) / steps;
    const tortFreq = (1.4 + 0.6 * gen) * Math.PI;
    const tortPhase = rng.nextDouble() * Math.PI * 2;
    const tortAmp = 0.20 + 0.05 * gen;
    const weight = gen === 0 ? 1.0 : gen === 1 ? 0.88 : gen === 2 ? 0.74 : 0.58;
    const rVeinPx = rArtPx * 1.24;
    const sideSign = rng.nextDouble() < 0.5 ? 1 : -1;

    let cx = x0 * side;
    let cy = y0 * side;
    let endTheta = theta;

    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const tMid = 0.5 * (t0 + t1);
      const localTheta = theta + tortAmp * Math.sin(tortFreq * tMid + tortPhase);
      endTheta = localTheta;
      const nx = cx + Math.cos(localTheta) * stepLen;
      const ny = cy + Math.sin(localTheta) * stepLen;
      const tap0 = 1 - 0.16 * tMid;
      const perpX = -Math.sin(localTheta) * sideSign;
      const perpY = Math.cos(localTheta) * sideSign;
      const companionDist = (rArtPx + rVeinPx) * 0.92 * (0.84 + 0.28 * Math.cos(tortFreq * 0.7 * tMid));
      splatSegment(
        cx, cy, nx, ny,
        rArtPx * tap0, rVeinPx * tap0,
        perpX * companionDist, perpY * companionDist,
        gen, weight,
      );
      cx = nx;
      cy = ny;
    }

    if (gen < 3) {
      const nextX = (cx / side) % 1;
      const nextY = (cy / side) % 1;
      // Murray's Law asymmetric physiological bifurcation (r0^3 = r1^3 + r2^3)
      const split1 = (0.32 + 0.20 * rng.nextDouble()) * sideSign;
      const split2 = -(0.46 + 0.24 * rng.nextDouble()) * sideSign;
      spawnBranch(nextX, nextY, endTheta + split1, length * (0.76 + 0.08 * rng.nextDouble()), rArtPx * 0.83, gen + 1);
      spawnBranch(nextX, nextY, endTheta + split2, length * (0.66 + 0.10 * rng.nextDouble()), rArtPx * 0.74, gen + 1);
    }
  };

  // Seed 8 well-distributed root vascular pedicles across the periodic unit torus
  const rootAnchors: [number, number, number][] = [
    [0.12, 0.18, 0.42],
    [0.62, 0.14, 1.18],
    [0.24, 0.64, -0.55],
    [0.78, 0.58, 2.35],
    [0.44, 0.38, -1.42],
    [0.88, 0.86, -2.45],
    [0.16, 0.88, 0.85],
    [0.52, 0.82, -0.95],
  ];
  for (const [rx, ry, rTheta] of rootAnchors) {
    const jx = (rx + 0.06 * (rng.nextDouble() - 0.5) + 1) % 1;
    const jy = (ry + 0.06 * (rng.nextDouble() - 0.5) + 1) % 1;
    const jTheta = rTheta + 0.25 * (rng.nextDouble() - 0.5);
    spawnBranch(jx, jy, jTheta, 0.28 + 0.04 * rng.nextDouble(), 2.85, 0);
  }

  // Synthesize periodic anisotropic collagenous fascia / serosal fiber wave
  const tau = Math.PI * 2;
  for (let py = 0; py < side; py++) {
    const v = (py / side) * tau;
    const row = py << 8;
    for (let px = 0; px < side; px++) {
      const u = (px / side) * tau;
      const w1 = Math.sin(3 * u + 2 * v + 0.7 * Math.sin(2 * u - v));
      const w2 = Math.cos(5 * u - 4 * v + 0.6 * Math.cos(u + 3 * v));
      fasciaWave[row | px] = Math.pow(clamp(0.5 + 0.32 * w1 + 0.18 * w2, 0, 1), 3.0);
    }
  }

  return { arteryMask, veinMask, vesselHeight, adiposeHalo, fasciaWave };
}

function getPeriodicVascularTable(): PeriodicVascularTable {
  if (!cachedVascularTable) {
    cachedVascularTable = buildPeriodicVascularTable();
  }
  return cachedVascularTable;
}

/** Organ-specific optical absorption & serosal chromaticity curve so each abdominal organ
 * in a laparoscopic multi-organ scene renders with its authentic surgical color. */
function computeOrganTargetLinear(organ: string, rawLin: number, channel: number): number {
  const c = clamp(rawLin, 0.002, 0.98);
  switch (organ) {
    case "gallbladder":
      // Olive / bile-green translucent serosa with warm subserosal capillary undertone
      if (channel === 0) return Math.pow(c, 1.24) * 0.38;
      if (channel === 1) return Math.pow(c, 1.05) * 0.58;
      return Math.pow(c, 1.18) * 0.36;
    case "stomach":
      // Well-perfused coral / rose-salmon gastric serosa
      if (channel === 0) return Math.pow(c, 1.03) * 0.78;
      if (channel === 1) return Math.pow(c, 1.18) * 0.44;
      return Math.pow(c, 1.22) * 0.39;
    case "small-intestine":
      // Warm oxygenated rosy-salmon jejunoileal & duodenal serosa
      if (channel === 0) return Math.pow(c, 1.02) * 0.80;
      if (channel === 1) return Math.pow(c, 1.16) * 0.47;
      return Math.pow(c, 1.20) * 0.41;
    case "large-intestine":
      // Pinkish-taupe colonic wall & haustra (distinct from small bowel)
      if (channel === 0) return Math.pow(c, 1.05) * 0.72;
      if (channel === 1) return Math.pow(c, 1.12) * 0.52;
      return Math.pow(c, 1.15) * 0.48;
    case "pancreas":
      // Creamy golden-buff lobulated acinar gland
      if (channel === 0) return Math.pow(c, 1.01) * 0.85;
      if (channel === 1) return Math.pow(c, 1.06) * 0.68;
      return Math.pow(c, 1.22) * 0.43;
    case "spleen":
      // Deep violaceous plum-burgundy splenic capsule
      if (channel === 0) return Math.pow(c, 1.18) * 0.42;
      if (channel === 1) return Math.pow(c, 1.48) * 0.21;
      return Math.pow(c, 1.20) * 0.39;
    case "kidney":
      // Warm reddish-chestnut renal cortex capsule
      if (channel === 0) return Math.pow(c, 1.12) * 0.62;
      if (channel === 1) return Math.pow(c, 1.34) * 0.34;
      return Math.pow(c, 1.36) * 0.32;
    case "heart":
      // Oxygenated myocardial crimson
      if (channel === 0) return Math.pow(c, 1.10) * 0.66;
      if (channel === 1) return Math.pow(c, 1.38) * 0.32;
      return Math.pow(c, 1.38) * 0.32;
    case "lung":
      // Aerated rose-pink pleural surface
      if (channel === 0) return Math.pow(c, 1.04) * 0.76;
      if (channel === 1) return Math.pow(c, 1.12) * 0.56;
      return Math.pow(c, 1.10) * 0.58;
    case "urinary-bladder":
    case "brain":
      if (channel === 0) return Math.pow(c, 1.05) * 0.76;
      if (channel === 1) return Math.pow(c, 1.10) * 0.60;
      return Math.pow(c, 1.12) * 0.54;
    case "liver":
    default:
      // Deep hepatic crimson-mahogany parenchymal absorption
      return Math.pow(c, channel === 0 ? 1.15 : 1.44) * (channel === 0 ? 0.55 : channel === 1 ? 0.25 : 0.23);
  }
}

/** Continuous 3D rest-space anatomical micro-structure, sub-serosal vascular arcades & perivascular adipose [modR, modG, modB].
 * Zero-allocation trig evaluation in normalized organ coordinates (nx, ny, nz in [-1, 1]) that adds
 * organ-authentic macroscopic surgical landmarks (cystic arterial arborization, vasa recta arcades,
 * mesenteric/gastroepiploic golden-yellow fat pads, colonic teniae & haustral clefts, pancreatic acinar lobulation,
 * renal stellate venules, and hepatic portal-venous perfusion). */
function evaluateOrganMicroStructure3D(
  organ: string,
  nx: number,
  ny: number,
  nz: number,
  phase: number,
): [number, number, number] {
  // Warped 3D coordinates for tortuous macroscopic vascular trunks & secondary bifurcating arcades
  const wx = nx + 0.18 * Math.sin(ny * 4.5 + nz * 3.8 + phase);
  const wy = ny + 0.18 * Math.cos(nx * 4.2 - nz * 4.6 - phase * 0.6);
  const wz = nz + 0.16 * Math.sin(nx * 3.9 + ny * 4.8 + phase * 0.4);

  const s1 = Math.sin(wx * 8.5 + wy * 6.8 - wz * 5.6 + phase);
  const s2 = Math.cos(wx * 16.4 - wy * 13.8 + wz * 11.2 - phase * 0.7);
  const s3 = Math.sin(wx * 27.0 + wy * 22.5 + wz * 18.0 + phase * 1.3);

  // Multi-generation 3D arterial filaments (oxygenated crimson) & companion venous threads (ruby-violet)
  const macroArtery = Math.exp(-Math.abs(s1) * 16.0) * (0.65 + 0.35 * Math.cos(wx * 5.0 - wy * 4.0));
  const branchArtery = Math.exp(-Math.abs(s1 * 0.55 + s2 * 0.45) * 18.0);
  const fineArteriole = Math.exp(-Math.abs(s2 * 0.60 + s3 * 0.40) * 20.0) * 0.65;
  const artSignal = clamp(Math.max(macroArtery, branchArtery * 0.85, fineArteriole), 0, 1);

  const vWave = Math.sin(wx * 9.2 - wy * 7.6 + wz * 6.1 + phase + 0.42);
  const veinSignal = clamp(Math.exp(-Math.abs(vWave * 0.68 + s2 * 0.32) * 17.0) * (1 - 0.75 * artSignal), 0, 1);

  // Perivascular & mesenteric adipose lobule zones (clustered near major vascular trunks)
  const fatPocket = Math.exp(-Math.abs(s1) * 4.8) * Math.pow(clamp(0.5 + 0.5 * Math.sin(wx * 12.0 + phase) * Math.cos(wy * 12.0 - phase), 0, 1), 2.2) * (1 - 0.85 * Math.max(artSignal, veinSignal));

  switch (organ) {
    case "gallbladder": {
      // Sub-serosal cystic artery arborization (vivid crimson over translucent olive-green serosa),
      // deep cystic veins, and Calot's infundibular golden adipose cuff near the neck
      const fundusDepth = 0.92 + 0.12 * clamp(ny * 0.5 + 0.5, 0, 1);
      const neckFat = clamp((-ny - 0.25) * 1.8, 0, 1) * fatPocket * 0.55;
      return [
        fundusDepth * (1 + 0.72 * artSignal - 0.14 * veinSignal + 0.85 * neckFat),
        fundusDepth * (1 - 0.36 * artSignal - 0.30 * veinSignal + 0.42 * neckFat),
        fundusDepth * (1 - 0.38 * artSignal + 0.12 * veinSignal - 0.28 * neckFat),
      ];
    }
    case "stomach": {
      // Gastric lesser & greater curvature gastroepiploic vascular arcades + omental golden fat border
      const curvatureZone = clamp(Math.abs(nx) * 0.75 + 0.20, 0, 1);
      const omentalFat = clamp((Math.abs(nx) - 0.42) * 2.2, 0, 1) * fatPocket * 0.68;
      return [
        1 + 0.12 * curvatureZone + 0.36 * artSignal - 0.18 * veinSignal + 0.28 * omentalFat,
        1 - 0.06 * curvatureZone - 0.32 * artSignal - 0.34 * veinSignal + 0.46 * omentalFat,
        1 - 0.08 * curvatureZone - 0.34 * artSignal + 0.08 * veinSignal - 0.35 * omentalFat,
      ];
    }
    case "small-intestine": {
      // Mesenteric vasa recta arterial & venous arcades, peristaltic circular rings, and mesenteric yellow fat border
      const ring = 0.94 + 0.09 * Math.sin(wx * 14.0 + wy * 12.0 + wz * 10.0 + phase);
      const mesentericFat = clamp((0.45 - Math.abs(nz)) * 1.9, 0, 1) * fatPocket * 0.65;
      return [
        ring * (1 + 0.38 * artSignal - 0.18 * veinSignal + 0.26 * mesentericFat),
        ring * (1 - 0.34 * artSignal - 0.35 * veinSignal + 0.44 * mesentericFat),
        ring * (1 - 0.36 * artSignal + 0.10 * veinSignal - 0.34 * mesentericFat),
      ];
    }
    case "large-intestine": {
      // Colonic haustral clefts, longitudinal pearly teniae coli band, appendices epiploicae yellow fat tags, & vasa longa
      const haustra = 0.91 + 0.13 * Math.cos(wx * 11.0 + wy * 9.5 + phase * 0.5);
      const teniaBand = Math.exp(-((nz - 0.22) * (nz - 0.22)) * 11.0) * 0.16;
      const epiploicFat = Math.exp(-((nz - 0.18) * (nz - 0.18)) * 5.5) * fatPocket * 0.78;
      return [
        haustra + teniaBand + 0.34 * artSignal - 0.16 * veinSignal + 0.32 * epiploicFat,
        haustra + teniaBand * 0.96 - 0.30 * artSignal - 0.32 * veinSignal + 0.48 * epiploicFat,
        haustra + teniaBand * 0.90 - 0.32 * artSignal + 0.08 * veinSignal - 0.36 * epiploicFat,
      ];
    }
    case "pancreas": {
      // Macroscopic pancreatic acinar lobulation with interlobular septa & pancreaticoduodenal arcade vessels
      const lobule = Math.sin(wx * 15.5 + phase) * Math.sin(wy * 15.5 - phase) * Math.cos(wz * 15.5);
      const cleft = Math.exp(-Math.abs(lobule) * 8.5);
      return [
        1 + 0.10 * (1 - cleft) - 0.12 * cleft + 0.26 * artSignal - 0.16 * veinSignal,
        1 + 0.08 * (1 - cleft) - 0.20 * cleft - 0.32 * artSignal - 0.30 * veinSignal,
        1 + 0.04 * (1 - cleft) - 0.24 * cleft - 0.34 * artSignal + 0.06 * veinSignal,
      ];
    }
    case "spleen": {
      // Fibroelastic splenic capsule with trabecular arteries, hilar venous congestion & capsular sheen
      const hilar = 0.91 + 0.12 * clamp(nx * 0.5 + 0.5, 0, 1);
      return [
        hilar * (1 + 0.28 * artSignal - 0.12 * veinSignal),
        hilar * 0.95 * (1 - 0.28 * artSignal - 0.24 * veinSignal),
        hilar * 1.04 * (1 - 0.24 * artSignal + 0.18 * veinSignal),
      ];
    }
    case "kidney": {
      // Renal cortical stellate venules (venae stellatae), subcapsular arterioles & perirenal hilar fat
      const cortex = 0.92 + 0.12 * clamp(Math.abs(nx), 0, 1);
      const hilarFat = clamp((0.38 - Math.abs(nx)) * 2.4, 0, 1) * fatPocket * 0.62;
      return [
        cortex * (1 + 0.32 * artSignal - 0.14 * veinSignal + 0.35 * hilarFat),
        cortex * (1 - 0.28 * artSignal - 0.28 * veinSignal + 0.52 * hilarFat),
        cortex * (1 - 0.30 * artSignal + 0.14 * veinSignal - 0.25 * hilarFat),
      ];
    }
    case "liver":
    default: {
      // Glissonian capsule portal-venous perfusion gradient, subcapsular venules/arterioles & lobular mottling
      const visceralWarmth = 0.94 + 0.09 * clamp(ny * 0.4 + nz * 0.4 + 0.3, 0, 1);
      const lobuleMottle = 0.96 + 0.06 * (s1 * s2);
      return [
        visceralWarmth * lobuleMottle * (1 + 0.30 * artSignal - 0.14 * veinSignal),
        visceralWarmth * lobuleMottle * (1 - 0.26 * artSignal - 0.26 * veinSignal),
        visceralWarmth * lobuleMottle * (1 - 0.28 * artSignal + 0.16 * veinSignal),
      ];
    }
  }
}

/** Smooth, bounded 3D physiological surface relief (in normalized organ units) along the outward normal.
 * Adds organ-authentic 3D surgical contours (colonic haustra & epiploic bosses, intestinal peristaltic waves,
 * pancreatic acinar cobbling, subserosal vascular arcade ridges) on free peritoneal surfaces. */
function evaluateOrganPhysiologicalRelief(
  organ: string,
  nx: number,
  ny: number,
  nz: number,
  phase: number,
): number {
  const s1 = Math.sin(nx * 8.5 + ny * 6.8 - nz * 5.6 + phase);
  const vesselRidge = Math.exp(-Math.abs(s1) * 14.0) * 0.0045;
  switch (organ) {
    case "large-intestine": {
      // Colonic haustral sacculations + semilunar clefts + epiploic fat bosses
      const haustralWave = Math.cos(nx * 10.5 + ny * 9.0 + phase * 0.5);
      const haustra = (haustralWave > 0 ? Math.pow(haustralWave, 0.75) : -0.65 * Math.pow(-haustralWave, 1.4)) * 0.018;
      return haustra + vesselRidge;
    }
    case "small-intestine": {
      // Gentle circular peristaltic contraction rings + mesenteric vasa recta ridges
      const peristalsis = Math.sin(nx * 13.5 + ny * 11.5 + nz * 9.5 + phase) * 0.011;
      return peristalsis + vesselRidge * 1.2;
    }
    case "pancreas": {
      // Macroscopic acinar lobular cobbling
      const acinar = Math.abs(Math.sin(nx * 14.0 + phase) * Math.cos(ny * 14.0 - phase) * Math.sin(nz * 14.0)) * 0.016;
      return (acinar - 0.005) + vesselRidge;
    }
    case "stomach": {
      // Antral peristaltic wave + gastroepiploic vascular arcade relief
      const antral = Math.sin(nx * 6.5 + ny * 5.5 + phase) * 0.008;
      return antral + vesselRidge * 1.3;
    }
    case "gallbladder": {
      // Tortuous cystic artery subserosal relief
      return vesselRidge * 1.5;
    }
    default:
      return vesselRidge * 0.75;
  }
}

/** Synthesize 3 toroidally seamless 256×256 PBR textures (BaseColor sRGB, tangent Normal, glTF Roughness)
 * combining a 4-generation Murray's-Law bifurcating vascular tree (paired oxygenated crimson arteries +
 * deoxygenated ruby-violet veins), perivascular golden-yellow adipose lobules, collagenous fascia, and
 * periodic Worley parenchymal lobules. */
function bakeSeamlessImportedPbrMaps(
  materialRecipe: AtlasMaterialRecipe,
  diseaseProfile: ImportedDiseaseProfile | null | undefined,
  textureStrength: number,
): SeamlessImportedPbrBundle {
  const side = WORLEY_TABLE_SIDE;
  const mask = side - 1;
  const total = side * side;
  const lobuleDetail = new Float64Array(total);
  const septumMask = new Float64Array(total);
  const lobuleHeight = new Float64Array(total);
  const pixelArtery = new Float32Array(total);
  const pixelVein = new Float32Array(total);
  const pixelFat = new Float32Array(total);
  const pixelFascia = new Float32Array(total);

  let organHash = 2166136261;
  const keyStr = `${materialRecipe.organ}:${materialRecipe.preset}:${diseaseProfile?.id ?? ""}`;
  for (let i = 0; i < keyStr.length; i++) organHash = Math.imul(organHash ^ keyStr.charCodeAt(i), 16777619);
  const baseSeed = ((materialRecipe.seed >>> 0) ^ (organHash >>> 0)) >>> 0 || 1337;
  const shiftRng = new Pcg64(baseSeed);
  const ox1 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const oy1 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const ox2 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const oy2 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const ox3 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const oy3 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const oxM = Math.floor(shiftRng.nextDouble() * side) & mask;
  const oyM = Math.floor(shiftRng.nextDouble() * side) & mask;
  const oxV1 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const oyV1 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const oxV2 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const oyV2 = Math.floor(shiftRng.nextDouble() * side) & mask;
  const flipVasc = (baseSeed & 1) === 1;

  const tables = getPeriodicWorleyTables();
  const { grid6, grid11, grid23, grid47 } = tables;
  const vasc = getPeriodicVascularTable();
  const isNodularOrFibrotic = diseaseProfile?.pattern === "nodular" || diseaseProfile?.pattern === "fibrotic";
  const isSteatotic = Boolean(diseaseProfile?.id?.includes("steatotic"));
  const isLobularOrgan = materialRecipe.organ === "pancreas" || materialRecipe.organ === "lung";
  const isHollowSerosa = materialRecipe.organ === "gallbladder" || materialRecipe.organ === "stomach" ||
    materialRecipe.organ === "small-intestine" || materialRecipe.organ === "large-intestine";

  // Organ-specific histological prominence weights for arteries, companion veins, perivascular fat & fascia
  const arteryWeight = isHollowSerosa ? 0.96
    : (materialRecipe.organ === "heart" || materialRecipe.organ === "kidney" || materialRecipe.organ === "brain") ? 0.90
    : materialRecipe.organ === "pancreas" ? 0.82
    : 0.78;
  const veinWeight = (materialRecipe.organ === "kidney" || materialRecipe.organ === "spleen" || materialRecipe.organ === "liver") ? 0.92
    : isHollowSerosa ? 0.88
    : 0.80;
  const adiposeWeight = isSteatotic ? 0.85
    : materialRecipe.organ === "large-intestine" ? 0.88
    : (materialRecipe.organ === "small-intestine" || materialRecipe.organ === "stomach") ? 0.80
    : (materialRecipe.organ === "pancreas" || materialRecipe.organ === "heart") ? 0.72
    : (materialRecipe.organ === "gallbladder" || materialRecipe.organ === "kidney") ? 0.58
    : 0.16;

  const detailAmp = (0.52 + 0.48 * textureStrength) * (0.58 + 0.28 * materialRecipe.fine_detail + 0.24 * materialRecipe.structure_strength);
  const vascAmp = 0.62 + 0.38 * textureStrength;
  const baseline = resolveMaterial(materialRecipe);
  const uBase = (baseline.uniforms as Record<string, unknown>).uAtlasBaseColor as number[];
  const uSepta = isHollowSerosa
    ? [uBase[0]! * 0.86, uBase[1]! * 0.54, uBase[2]! * 0.52]
    : isLobularOrgan
      ? [uBase[0]! * 0.76, uBase[1]! * 0.72, uBase[2]! * 0.66]
      : [uBase[0]! * 0.66, uBase[1]! * 0.60, uBase[2]! * 0.56];
  const uRoughBase = (baseline.uniforms as Record<string, unknown>).uAtlasRoughnessBase as number;

  for (let py = 0; py < side; py++) {
    const r1 = ((py + oy1) & mask) << 8;
    const r2 = ((py + oy2) & mask) << 8;
    const r3 = ((py + oy3) & mask) << 8;
    const rM = ((py + oyM) & mask) << 8;
    const vy1 = (py + oyV1) & mask;
    const vy2 = ((py * 2) + oyV2) & mask;
    const rowOffset = py << 8;
    for (let px = 0; px < side; px++) {
      const idx = rowOffset | px;
      const i1 = r1 | ((px + ox1) & mask);
      const i2 = r2 | ((px + ox2) & mask);
      const i3 = r3 | ((px + ox3) & mask);

      const d1 = grid11.d1[i1]!, edge1 = grid11.edge[i1]!, h1 = grid11.hash[i1]!;
      const d2 = grid23.d1[i2]!, edge2 = grid23.edge[i2]!, h2 = grid23.hash[i2]!;
      const edge3 = grid47.edge[i3]!, h3 = grid47.hash[i3]!;

      // Domain-warp vascular lookup coordinates slightly using cellular phase for organic serpiginous variation
      const warpPx = Math.round((h1 - 0.5) * 3.0);
      const vx1 = (px + oxV1 + warpPx) & mask;
      const vx2 = ((px * 2) + oxV2 - warpPx) & mask;
      const iV1 = flipVasc ? ((vx1 << 8) | vy1) : ((vy1 << 8) | vx1);
      const iV2 = flipVasc ? ((vy2 << 8) | vx2) : ((vx2 << 8) | vy2);

      // Combine macro arcade (1x) + fine arborizing subserosal plexus (2x)
      const artRaw = Math.max(vasc.arteryMask[iV1]!, vasc.arteryMask[iV2]! * 0.72);
      const veinRaw = Math.max(vasc.veinMask[iV1]!, vasc.veinMask[iV2]! * 0.70) * (1 - 0.78 * artRaw);
      const vHeight = Math.max(vasc.vesselHeight[iV1]!, vasc.vesselHeight[iV2]! * 0.62);
      const fatHalo = vasc.adiposeHalo[iV1]!;
      const fasciaVal = vasc.fasciaWave[iV1]!;

      const lobuleDome1 = clamp(1 - d1 * 1.15, 0, 1);
      const lobuleDome2 = clamp(1 - d2 * 1.2, 0, 1);
      const septum1 = Math.exp(-edge1 * (isHollowSerosa ? 13.5 : 9.5));
      const septum2 = Math.exp(-edge2 * (isHollowSerosa ? 15.0 : 11.0));
      const centralVenule = isHollowSerosa ? 0 : Math.exp(-d1 * d1 * 28.0);
      const microPore = Math.exp(-edge3 * 14.0);

      let macroDome = 0;
      let macroSeptum = 0;
      if (isNodularOrFibrotic || isLobularOrgan) {
        const iM = rM | ((px + oxM) & mask);
        const md1 = grid6.d1[iM]!, medge = grid6.edge[iM]!;
        const macroWeight = isNodularOrFibrotic ? 1.0 : 0.68;
        macroDome = macroWeight * Math.pow(clamp(1 - md1 * 1.08, 0, 1), 1.35);
        macroSeptum = macroWeight * Math.exp(-medge * 8.0);
      }

      const artMask = clamp(artRaw * arteryWeight * vascAmp, 0, 0.96);
      const vnMask = clamp((veinRaw * veinWeight + 0.38 * centralVenule) * vascAmp * (1 - 0.80 * artMask), 0, 0.92);
      // Rounded Worley adipose globules clustered inside the perivascular fat halo (outside the vessel lumens)
      const vesselExclusion = clamp(1 - 1.65 * Math.max(artMask, vnMask), 0, 1);
      const fatCluster = fatHalo * Math.pow(lobuleDome1, 0.82) * (0.74 + 0.26 * lobuleDome2) * vesselExclusion;
      const fatMask = clamp((fatCluster - 0.07) * 3.1 * adiposeWeight * vascAmp, 0, 0.92) * vesselExclusion;
      const fMask = clamp(fasciaVal * (1 - Math.max(artMask, vnMask, fatMask)) * 0.24 * detailAmp, 0, 0.38);

      pixelArtery[idx] = artMask;
      pixelVein[idx] = vnMask;
      pixelFat[idx] = fatMask;
      pixelFascia[idx] = fMask;

      const cellTint = (h1 - 0.5) * 0.16 + (h2 - 0.5) * 0.10 + (h3 - 0.5) * 0.06;
      const dome = (isHollowSerosa ? 0.30 : 0.55) * lobuleDome1 + 0.32 * lobuleDome2 + 0.45 * macroDome;
      const septa = clamp(0.65 * septum1 + 0.35 * septum2 + 0.85 * macroSeptum, 0, 1);

      septumMask[idx] = clamp(septa + 0.40 * centralVenule, 0, 1);
      lobuleDetail[idx] = clamp(1 + detailAmp * (cellTint + 0.18 * (dome - 0.45) - 0.22 * septa - 0.16 * centralVenule), 0.62, 1.38);
      // Combine parenchymal lobule domes, septal trenches, 3D cylindrical vessel elevation & convex fat globules
      // Subcapsular organs (healthy liver, spleen, kidney) show vessels through a smooth translucent capsule
      const subcapsularSmooth = (materialRecipe.organ === "liver" || materialRecipe.organ === "spleen" || materialRecipe.organ === "kidney") && !isNodularOrFibrotic;
      const vReliefScale = subcapsularSmooth ? 0.14 : 1.0;
      lobuleHeight[idx] = detailAmp * ((isHollowSerosa ? 0.10 : subcapsularSmooth ? 0.08 : 0.20) * dome - (subcapsularSmooth ? 0.06 : 0.18) * septa - 0.06 * centralVenule - 0.02 * microPore)
        + vascAmp * vReliefScale * (0.34 * vHeight + 0.22 * fatMask + 0.06 * fMask);
    }
  }

  const baseData = new Uint8Array(total * 4);
  const normalData = new Uint8Array(total * 4);
  const roughData = new Uint8Array(total * 4);
  const diseaseLinear = diseaseProfile ? diseaseProfile.srgb.map(srgbToLinear) as [number, number, number] : null;
  let sumR = 0, sumG = 0, sumB = 0, sumWeight = 0;

  // Multi-spectral physiological chrominance targets in linear texture carrier space:
  // Because Three.js multiplies mapLinear * vertexColor, setting R >> G,B on arteries and R,G >> B on fat
  // produces vivid crimson arteries, ruby-violet veins, and golden-yellow fat lobules on every organ!
  const artCarrierLin: [number, number, number] = [0.98, 0.038, 0.032];
  const veinCarrierLin: [number, number, number] = [0.16, 0.034, 0.44];
  const fatCarrierLin: [number, number, number] = [0.96, 0.84, 0.11];
  const fasciaCarrierLin: [number, number, number] = [0.82, 0.80, 0.76];

  for (let i = 0; i < total; i++) {
    const i4 = i * 4;
    const mod = lobuleDetail[i]!;
    const sMask = septumMask[i]!;
    const art = pixelArtery[i]!;
    const vn = pixelVein[i]!;
    const fat = pixelFat[i]!;
    const fas = pixelFascia[i]!;
    const subWeight = Math.max(0.05, 1 - 0.85 * Math.max(art, vn, fat));
    sumWeight += subWeight;

    for (let k = 0; k < 3; k++) {
      let lin = uBase[k]! * (1 - 0.42 * sMask) + uSepta[k]! * (0.42 * sMask);
      if (diseaseLinear && isNodularOrFibrotic) {
        lin = lin * (1 - 0.28 * sMask) + diseaseLinear[k]! * (0.28 * sMask);
      }
      // Substrate carrier in linear space (~0.45..0.62)
      let carrierLin = clamp(srgbToLinear(clamp((0.68 + 0.18 * linearToSrgb(clamp(lin, 0.01, 0.98))) * mod, 0.18, 0.96)), 0.02, 0.96);

      // Layer perivascular adipose lobules, collagenous fascia, companion veins, and arterial trees
      if (fas > 0) carrierLin = carrierLin * (1 - fas) + fasciaCarrierLin[k]! * fas;
      if (fat > 0) carrierLin = carrierLin * (1 - fat) + fatCarrierLin[k]! * fat;
      if (vn > 0) carrierLin = carrierLin * (1 - vn) + veinCarrierLin[k]! * vn;
      if (art > 0) carrierLin = carrierLin * (1 - art) + artCarrierLin[k]! * art;

      const carrierSrgb = clamp(linearToSrgb(clamp(carrierLin, 0.008, 0.99)), 0.06, 0.99);
      const byte = Math.round(carrierSrgb * 255);
      baseData[i4 + k] = byte;
      const decodedLin = srgbToLinear(byte / 255);
      if (k === 0) sumR += decodedLin * subWeight;
      else if (k === 1) sumG += decodedLin * subWeight;
      else sumB += decodedLin * subWeight;
    }
    baseData[i4 + 3] = 255;

    // Glistening wet endothelium over vessels & moist adipose lobules (lower roughness = sharper specular glints)
    const vWet = Math.max(art, vn);
    const rVal = clamp(0.74 + (uRoughBase - 0.34) * 0.45 + 0.20 * sMask - 0.28 * vWet - 0.12 * fat - (mod - 1) * 0.22, 0.22, 0.98);
    const rByte = Math.round(rVal * 255);
    roughData[i4] = 255;
    roughData[i4 + 1] = rByte;
    roughData[i4 + 2] = 0;
    roughData[i4 + 3] = 255;
  }

  const normalSlope = (5.4 + 3.8 * materialRecipe.fine_detail + 3.2 * materialRecipe.structure_strength + (isNodularOrFibrotic ? 3.2 : 0)) * (0.58 + 0.42 * textureStrength);
  for (let py = 0; py < side; py++) {
    const pyPrev = (py + side - 1) & mask, pyNext = (py + 1) & mask;
    for (let px = 0; px < side; px++) {
      const pxPrev = (px + side - 1) & mask, pxNext = (px + 1) & mask;
      const idx = (py << 8) | px, i4 = idx * 4;
      const hL = lobuleHeight[(py << 8) | pxPrev]!;
      const hR = lobuleHeight[(py << 8) | pxNext]!;
      const hD = lobuleHeight[(pyPrev << 8) | px]!;
      const hU = lobuleHeight[(pyNext << 8) | px]!;
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
      Math.max(0.12, sumR / Math.max(1, sumWeight)),
      Math.max(0.12, sumG / Math.max(1, sumWeight)),
      Math.max(0.12, sumB / Math.max(1, sumWeight)),
    ],
  };
}

interface ImportedDiseaseSite {
  cx: number; cy: number; cz: number;
  dx: number; dy: number; dz: number;
  radius: number; amplitude: number;
  phase: number;
}
interface ImportedDiseaseField {
  sites: ImportedDiseaseSite[];
  steps: number;
  globalScale: [number, number, number];
  targetLinear: [number, number, number];
  colorStrength: number;
}

/** Deterministic 3D pathology site placement in centered rest space for Joint Flow v2 disease recipes.
 * Uses smooth outward surface normals and broad organic multi-octave envelopes (never circular craters). */
function buildImportedDiseaseField(
  state: ImportedVariationState,
  disease: AtlasDiseaseSpec,
  profile: ImportedDiseaseProfile,
  shapeStrength: number,
  textureStrength: number,
): ImportedDiseaseField {
  const firstMesh = state.meshes[0]!;
  const coords = firstMesh.centered;
  const sourceNormal = firstMesh.geometry?.getAttribute?.("normal") ?? null;
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
  // Broad anatomical support radius prevents small circular pockmarks/craters on smooth organ capsules
  const minAnatomicalRadius = diagonal * (profile.amp < 0 ? 0.16 : 0.11);
  const radius = Math.max(diagonal * (profile.rMin + profile.rRange * disease.size), minAnatomicalRadius);
  const count = Math.min(profile.maxSites, Math.max(1, Math.round(disease.count * profile.mult)));
  const anchors = [firstIdx];
  const isDensePattern = profile.pattern === "nodular" || profile.pattern === "multifocal" || profile.pattern === "fibrotic";
  const reach = diagonal * (isDensePattern ? 0.55 + 0.45 * disease.spread : 0.25 + 0.75 * disease.spread);
  const separation = radius * (isDensePattern ? 0.48 : 0.82);
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
  // Cap inward negative displacement gently so fibrotic/retracted profiles produce broad capsular flattening, never holes
  const maxStepRatio = (sign < 0 ? 0.065 : 0.18) / steps;
  const shapeFactor = shapeStrength > 0 ? (0.52 + 0.68 * shapeStrength) : 0;
  const severityFactor = 0.48 + 0.52 * disease.severity;
  const sites: ImportedDiseaseSite[] = anchors.map((idx, sIdx) => {
    const cx = coords[idx * 3]!, cy = coords[idx * 3 + 1]!, cz = coords[idx * 3 + 2]!;
    const outLen = Math.max(Math.hypot(cx, cy, cz), 1e-12);
    let nx = cx / outLen, ny = cy / outLen, nz = cz / outLen;
    if (sourceNormal && idx < sourceNormal.count) {
      const snx = sourceNormal.getX(idx), sny = sourceNormal.getY(idx), snz = sourceNormal.getZ(idx);
      const sLen = Math.hypot(snx, sny, snz);
      if (sLen > 1e-6) {
        // Blend smooth surface normal with outward radial vector for stable normal-directed contour
        const dotSign = (snx * nx + sny * ny + snz * nz) >= 0 ? 1 : -1;
        nx = 0.65 * (snx / sLen) * dotSign + 0.35 * nx;
        ny = 0.65 * (sny / sLen) * dotSign + 0.35 * ny;
        nz = 0.65 * (snz / sLen) * dotSign + 0.35 * nz;
        const nLen = Math.max(Math.hypot(nx, ny, nz), 1e-12);
        nx /= nLen; ny /= nLen; nz /= nLen;
      }
    }
    const dx = nx * sign, dy = ny * sign, dz = nz * sign;
    const siteRadius = radius * (0.82 + 0.38 * rng.nextDouble());
    const rawAmp = Math.abs(profile.amp) * (sign < 0 ? 0.55 : 1.25);
    const ratio = Math.min(rawAmp / steps, maxStepRatio) * severityFactor * shapeFactor * (1 - 0.25 * disease.irregularity * rng.nextDouble());
    return {
      cx, cy, cz, dx, dy, dz,
      radius: siteRadius,
      amplitude: siteRadius * ratio,
      phase: sIdx * 1.73 + rng.nextDouble() * Math.PI * 2,
    };
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
              const invR = 1 / Math.max(site.radius, 1e-6);
              for (let step = 0; step < diseaseField.steps; step++) {
                const dx = px - site.cx, dy = py - site.cy, dz = pz - site.cz;
                const aniso = 1 + 0.24 * Math.sin(dx * invR * 4.2 + site.phase) * Math.cos(dy * invR * 3.8 - dz * invR * 3.5 - site.phase);
                const d2 = (dx * dx + dy * dy + dz * dz) * aniso;
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
            // Smooth C^infinity branch-cut-free 3D rest-space + gentle normal UV coordinates (isotropic across all 3D orientations)
            const nxRest = rx / state.normalization, nyRest = ry / state.normalization, nzRest = rz / state.normalization;
            const snx = sourceNormal ? sourceNormal.getX(index) : 0;
            const sny = sourceNormal ? sourceNormal.getY(index) : 0;
            const snz = sourceNormal ? sourceNormal.getZ(index) : 0;
            const uvFreq = (reference.organ === "liver" || reference.organ === "pancreas" || reference.organ === "spleen" || reference.organ === "kidney") ? 2.1 : 1.55;
            uvs[index * 2] = uvFreq * (1.28 * nxRest + 0.16 * nyRest - 0.62 * nzRest) + 0.05 * snx - 0.03 * snz;
            uvs[index * 2 + 1] = uvFreq * (-0.22 * nxRest + 1.28 * nyRest + 0.54 * nzRest) + 0.05 * sny + 0.03 * snz;
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
              const nxRest = rx / state.normalization, nyRest = ry / state.normalization, nzRest = rz / state.normalization;
              const organPhase = ((recipe.material.seed & 0xffff) / 65535) * Math.PI * 2;
              const microMod = evaluateOrganMicroStructure3D(reference.organ, nxRest, nyRest, nzRest, organPhase);
              for (let channel = 0; channel < 3; channel++) {
                const baseLin = base[channel]!;
                const sampleLin = field.rgbLinear[local + channel]!;
                // Deep hemoglobin optical absorption curve so high-key studio lighting renders rich surgical visceral color
                const rawLin = clamp(baseLin + contrastMix * (sampleLin - baseLin), 0.002, 0.98);
                let targetLin = computeOrganTargetLinear(reference.organ, rawLin, channel) * microMod[channel]!;
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
              const isNodularOrFibrotic = recipe.diseaseProfile?.pattern === "nodular" || recipe.diseaseProfile?.pattern === "fibrotic";
              const isHollowOrLobular = reference.organ === "pancreas" || reference.organ === "large-intestine" ||
                reference.organ === "stomach" || reference.organ === "small-intestine" || reference.organ === "gallbladder";
              const nScale = isNodularOrFibrotic
                ? 0.68 + 0.58 * options.textureStrength
                : reference.organ === "liver"
                  ? 0.04 + 0.04 * options.textureStrength
                  : isHollowOrLobular
                    ? 0.44 + 0.36 * options.textureStrength
                    : 0.18 + 0.14 * options.textureStrength;
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

export interface SceneOrganAssignment {
  slotId: string;
  name: string;
  label: string;
  meshIndices: number[];
  vertices: number;
  triangles: number;
  centroid: [number, number, number];
  boundsSize: [number, number, number];
  referenceId: string;
  organ: string;
  profileId: string | null;
  detectionMethod: "name-match" | "spatial-morphology-prior";
}

export interface MultiOrganSceneVariationOptions extends VariationOptions {
  seed: number;
  temperature: number;
  assignments?: readonly SceneOrganAssignment[];
  severity?: "auto" | Exclude<JointSeverity, "baseline">;
  randomPathology?: boolean;
  includePathology?: boolean;
}

export interface MultiOrganSceneVariationReport extends VariationReport {
  organsVaried: number;
  organRecipes: Record<string, ImportedVariationRecipe>;
  report: MultiOrganSceneVariationReport;
  organReports: {
    slotId: string;
    name: string;
    label: string;
    organ: string;
    referenceId: string;
    profileId: string | null;
    seed: number;
    vertices: number;
    triangles: number;
    minJacobian: number;
    maxJacobian: number;
    recipe: ImportedVariationRecipe;
  }[];
}

const ORGAN_LABELS: Record<string, string> = {
  "liver": "Liver (Hepatic parenchyma & Glisson capsule)",
  "gallbladder": "Gallbladder (Fundus, body & Hartmann’s pouch)",
  "hepatic-duct": "Extrahepatic biliary tree (Cystic & common bile duct)",
  "cystic-duct": "Cystic duct (Calot’s hepatocystic triangle)",
  "portal-vein": "Portal venous & hepatoduodenal pedicle",
  "hepatic-artery": "Proper hepatic artery",
  "stomach": "Stomach (Cardia, fundus, body, antrum & pylorus)",
  "duodenum": "Duodenum (C-loop embracing pancreatic head)",
  "pancreas": "Pancreas (Head, neck, body & splenic-hilum tail)",
  "spleen": "Spleen (Left upper quadrant capsule)",
  "colon": "Large intestine (Ascending, hepatic flexure, transverse & descending colon)",
  "large-intestine": "Large intestine (Colon)",
  "small-intestine": "Small intestine (Jejunum & ileum coils)",
  "right-kidney": "Right kidney (Hepatorenal Morrison’s pouch)",
  "left-kidney": "Left kidney (Splenorenal retroperitoneal fossa)",
};

function matchReferenceByName(system: ImportedVariationSystem, rawName: string): ImportedReference | null {
  const lower = rawName.toLowerCase();
  const findRef = (id: string, organFallback: string): ImportedReference | null =>
    system.references.find(ref => ref.id === id) ??
    system.references.find(ref => ref.organ === organFallback) ??
    null;

  if (lower.includes("liver") || lower.includes("hep") && !lower.includes("duct") && !lower.includes("art")) {
    return findRef("hra-liver-female", "liver");
  }
  if (lower.includes("gallbladder") || lower.includes("cholecyst") || lower.includes("cystic") || lower.includes("hepatic-duct") || lower.includes("bile")) {
    return findRef("bp3d-gallbladder-male", "gallbladder");
  }
  if (lower.includes("stomach") || lower.includes("gastr")) {
    return findRef("bp3d-stomach-male", "stomach");
  }
  if (lower.includes("duodenum")) {
    return findRef("hra-small-intestine-male", "small-intestine");
  }
  if (lower.includes("pancreas") || lower.includes("pancreat")) {
    return findRef("hra-pancreas-female", "pancreas");
  }
  if (lower.includes("spleen") || lower.includes("splen") || lower.includes("portal") || lower.includes("vein") || lower.includes("vena")) {
    return findRef("hra-spleen-female", "spleen");
  }
  if (lower.includes("colon") || lower.includes("large-intestine") || lower.includes("cecum") || lower.includes("sigmoid")) {
    return findRef("hra-large-intestine-female", "large-intestine");
  }
  if (lower.includes("small-intestine") || lower.includes("jejun") || lower.includes("ileum") || lower.includes("bowel") || lower.includes("mesenter")) {
    return findRef("hra-small-intestine-female", "small-intestine");
  }
  if (lower.includes("right-kidney") || (lower.includes("kidney") && lower.includes("right"))) {
    return findRef("hra-kidney-female-right", "kidney");
  }
  if (lower.includes("left-kidney") || (lower.includes("kidney") && lower.includes("left"))) {
    return findRef("hra-kidney-female-left", "kidney");
  }
  if (lower.includes("kidney") || lower.includes("renal")) {
    return findRef("hra-kidney-female-right", "kidney");
  }
  if (lower.includes("bladder") || lower.includes("ureter")) {
    return findRef("hra-urinary-bladder-female", "urinary-bladder");
  }
  if (lower.includes("heart") || lower.includes("card") || lower.includes("aorta") || lower.includes("artery") || lower.includes("celiac")) {
    return findRef("hra-heart-female", "heart");
  }
  if (lower.includes("lung") || lower.includes("pulm") || lower.includes("bronch") || lower.includes("trachea")) {
    return findRef("hra-lung-female", "lung");
  }
  if (lower.includes("brain") || lower.includes("cort")) {
    return findRef("hra-brain-female", "brain");
  }
  return null;
}

const SPATIAL_PRIOR_CANONICAL: { id: string; organ: string; relPos: [number, number, number]; relSize: number }[] = [
  { id: "hra-liver-female", organ: "liver", relPos: [-0.25, 0.55, 0.25], relSize: 1.0 },
  { id: "bp3d-gallbladder-male", organ: "gallbladder", relPos: [-0.42, 0.12, 0.55], relSize: 0.18 },
  { id: "bp3d-stomach-male", organ: "stomach", relPos: [0.38, 0.42, 0.35], relSize: 0.48 },
  { id: "hra-pancreas-female", organ: "pancreas", relPos: [0.12, -0.05, 0.05], relSize: 0.32 },
  { id: "hra-spleen-female", organ: "spleen", relPos: [0.78, 0.32, -0.25], relSize: 0.28 },
  { id: "hra-large-intestine-female", organ: "large-intestine", relPos: [0.0, -0.58, 0.22], relSize: 0.95 },
  { id: "hra-small-intestine-female", organ: "small-intestine", relPos: [0.08, -0.62, 0.45], relSize: 0.65 },
  { id: "hra-kidney-female-right", organ: "kidney", relPos: [-0.55, -0.18, -0.35], relSize: 0.26 },
  { id: "hra-kidney-female-left", organ: "kidney", relPos: [0.58, -0.08, -0.38], relSize: 0.26 },
];

/** Automatically discover all 3D organ meshes in an imported scene and assign each organ
 * its matching VISCERA anatomical reference via name or 3D laparoscopic spatial-morphological prior. */
export function discoverSceneOrgans(
  state: ImportedVariationState,
  system: ImportedVariationSystem,
): SceneOrganAssignment[] {
  const groups = new Map<string, {
    name: string;
    meshIndices: number[];
    vertices: number;
    triangles: number;
    lo: [number, number, number];
    hi: [number, number, number];
  }>();

  state.meshes.forEach((rest, meshIndex) => {
    const rawMeshName = rest.mesh.name?.trim() || rest.mesh.parent?.name?.trim() || `organ_${meshIndex + 1}`;
    const key = state.meshes.length > 1 ? `${rawMeshName}#${meshIndex}` : rawMeshName;
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < rest.centered.length; i += 3) {
      const x = rest.centered[i]!, y = rest.centered[i + 1]!, z = rest.centered[i + 2]!;
      if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
      if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
      if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
    }
    const posAttr = rest.geometry.getAttribute("position");
    const idxAttr = rest.geometry.getIndex();
    const vCount = posAttr.count;
    const tCount = Math.floor((idxAttr ? idxAttr.count : vCount) / 3);
    groups.set(key, {
      name: rawMeshName,
      meshIndices: [meshIndex],
      vertices: vCount,
      triangles: tCount,
      lo,
      hi,
    });
  });

  const entries = Array.from(groups.entries());
  const maxDiag = Math.max(
    1e-6,
    ...entries.map(([, g]) => Math.hypot(g.hi[0] - g.lo[0], g.hi[1] - g.lo[1], g.hi[2] - g.lo[2])),
  );
  const usedPriors = new Set<string>();

  return entries.map(([slotId, g], idx) => {
    const cx = 0.5 * (g.lo[0] + g.hi[0]);
    const cy = 0.5 * (g.lo[1] + g.hi[1]);
    const cz = 0.5 * (g.lo[2] + g.hi[2]);
    const sx = g.hi[0] - g.lo[0];
    const sy = g.hi[1] - g.lo[1];
    const sz = g.hi[2] - g.lo[2];
    const diag = Math.hypot(sx, sy, sz);

    const matchedByName = matchReferenceByName(system, g.name);
    if (matchedByName) {
      usedPriors.add(matchedByName.id);
      const cleanKey = g.name.toLowerCase();
      const friendly = ORGAN_LABELS[cleanKey] ?? g.name.replace(/[-_]/g, " ");
      return {
        slotId,
        name: g.name,
        label: friendly,
        meshIndices: g.meshIndices,
        vertices: g.vertices,
        triangles: g.triangles,
        centroid: [cx, cy, cz],
        boundsSize: [sx, sy, sz],
        referenceId: matchedByName.id,
        organ: matchedByName.organ,
        profileId: null,
        detectionMethod: "name-match",
      };
    }

    // Unnamed mesh: infer organ identity from 3D laparoscopic spatial centroid & relative size
    const rx = clamp(cx / state.normalization, -1, 1);
    const ry = clamp(cy / state.normalization, -1, 1);
    const rz = clamp(cz / state.normalization, -1, 1);
    const relSize = diag / maxDiag;
    let bestPrior = SPATIAL_PRIOR_CANONICAL[idx % SPATIAL_PRIOR_CANONICAL.length]!;
    let bestScore = Infinity;
    for (const candidate of SPATIAL_PRIOR_CANONICAL) {
      const distPos = Math.hypot(rx - candidate.relPos[0], ry - candidate.relPos[1], rz - candidate.relPos[2]);
      const distSize = Math.abs(relSize - candidate.relSize);
      const penalty = usedPriors.has(candidate.id) ? 0.65 : 0;
      const score = distPos + 0.85 * distSize + penalty;
      if (score < bestScore) {
        bestScore = score;
        bestPrior = candidate;
      }
    }
    usedPriors.add(bestPrior.id);
    const ref = system.references.find(r => r.id === bestPrior.id) ?? system.references[0]!;
    return {
      slotId,
      name: g.name,
      label: `${g.name} (${ref.organ.replaceAll("-", " ")})`,
      meshIndices: g.meshIndices,
      vertices: g.vertices,
      triangles: g.triangles,
      centroid: [cx, cy, cz],
      boundsSize: [sx, sy, sz],
      referenceId: ref.id,
      organ: ref.organ,
      profileId: null,
      detectionMethod: "spatial-morphology-prior",
    };
  });
}

const sceneClearanceCache = new WeakMap<ImportedVariationState, Float32Array[]>();

/** Compute per-vertex inter-organ clearance weight w_clear in [0, 1] using a fast 3D spatial hash.
 * Vertices in intimate anatomical contact (d <= 3.5 mm) with an adjacent organ get w_clear = 0
 * so both organs move 100% locked together under the shared scene diffeomorphism (zero collision or gap opening).
 * Free peritoneal surfaces (d >= 18 mm) get w_clear = 1 for full local morphological and pathology expression. */
function getInterOrganClearanceWeights(state: ImportedVariationState): Float32Array[] {
  const cached = sceneClearanceCache.get(state);
  if (cached) return cached;
  const meshCount = state.meshes.length;
  if (meshCount <= 1) {
    const single = state.meshes.map(m => new Float32Array(m.centered.length / 3).fill(1));
    sceneClearanceCache.set(state, single);
    return single;
  }

  const cellSize = Math.max(state.normalization * 0.055, 1e-4);
  const invCell = 1 / cellSize;
  const contactThreshold = cellSize * 0.35;
  const freeThreshold = cellSize * 1.85;
  const grid = new Map<string, { meshIdx: number; x: number; y: number; z: number }[]>();

  // Subsample surface points into the spatial hash grid for fast O(N) neighborhood queries
  state.meshes.forEach((rest, meshIdx) => {
    const vCount = rest.centered.length / 3;
    const stride = Math.max(1, Math.floor(vCount / 1800));
    for (let i = 0; i < vCount; i += stride) {
      const x = rest.centered[3 * i]!, y = rest.centered[3 * i + 1]!, z = rest.centered[3 * i + 2]!;
      const gx = Math.floor(x * invCell), gy = Math.floor(y * invCell), gz = Math.floor(z * invCell);
      const key = `${gx},${gy},${gz}`;
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push({ meshIdx, x, y, z });
    }
  });

  const weights = state.meshes.map((rest, meshIdx) => {
    const vCount = rest.centered.length / 3;
    const w = new Float32Array(vCount);
    for (let i = 0; i < vCount; i++) {
      const x = rest.centered[3 * i]!, y = rest.centered[3 * i + 1]!, z = rest.centered[3 * i + 2]!;
      const gx = Math.floor(x * invCell), gy = Math.floor(y * invCell), gz = Math.floor(z * invCell);
      let minD2 = freeThreshold * freeThreshold;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const item = bucket[b]!;
              if (item.meshIdx === meshIdx) continue;
              const d2 = (x - item.x) ** 2 + (y - item.y) ** 2 + (z - item.z) ** 2;
              if (d2 < minD2) minD2 = d2;
            }
          }
        }
      }
      const d = Math.sqrt(minD2);
      const t = clamp((d - contactThreshold) / Math.max(1e-6, freeThreshold - contactThreshold), 0, 1);
      w[i] = t * t * (3 - 2 * t);
    }
    return w;
  });

  sceneClearanceCache.set(state, weights);
  return weights;
}

function buildOrganLocalDiseaseField(
  centeredCoords: Float64Array,
  geometry: BufferGeometry,
  disease: AtlasDiseaseSpec,
  profile: ImportedDiseaseProfile,
  shapeStrength: number,
  textureStrength: number,
): ImportedDiseaseField {
  const fakeMeshRest = { centered: centeredCoords, geometry } as MeshRest;
  const fakeState = { meshes: [fakeMeshRest] } as unknown as ImportedVariationState;
  const field = buildImportedDiseaseField(fakeState, disease, profile, shapeStrength * 0.52, textureStrength);
  return field;
}

/** Apply coupled multi-organ 22-DOF Joint Variational Flow v2 shape, seamless 3D PBR textures,
 * and optional pathology across an entire multi-organ laparoscopic 3D scene while preserving
 * co-registered anatomical apposition at all inter-organ contact interfaces. */
export async function applySceneVariation(
  state: ImportedVariationState,
  system: ImportedVariationSystem,
  options: MultiOrganSceneVariationOptions,
): Promise<MultiOrganSceneVariationReport> {
  if (state.disposed) throw new Error("This imported model has been disposed.");
  unit(options.shapeStrength, "Shape strength");
  unit(options.textureStrength, "Texture strength");
  const activeAssignments = options.assignments ?? discoverSceneOrgans(state, system);
  if (!activeAssignments.length) throw new Error("No scene organs were found to vary.");

  const epoch = ++state.epoch;
  const check = () => {
    aborted(options.signal);
    if (state.disposed || state.epoch !== epoch) throw new DOMException("The imported scene variation was superseded.", "AbortError");
  };
  check();
  state.root.updateWorldMatrix(true, true);
  for (const rest of state.meshes) {
    if (rest.mesh.matrixWorld.elements.some((value, index) => Math.abs(value - rest.world.elements[index]!) > 1e-10)) {
      throw new Error("The imported transforms changed. Reset the model before creating another variation state.");
    }
  }

  const clearanceWeights = getInterOrganClearanceWeights(state);
  const pathRng = new Pcg64((options.seed ^ 0x5bd1e995) >>> 0);
  const sampleRandomPathology = Boolean(options.randomPathology ?? options.includePathology);

  // 1. Sample a 22-DOF Joint Variational Flow v2 recipe for each organ slot in the scene
  const slotData = activeAssignments.map((slot, slotIdx) => {
    const organSeed = ((options.seed >>> 0) + Math.imul(slotIdx + 1, 997)) >>> 0;
    let activeProfileId = slot.profileId;
    if (!activeProfileId && sampleRandomPathology) {
      const candidates = system.profiles.filter(p => p.organ === slot.organ);
      if (candidates.length && pathRng.nextDouble() < 0.45) {
        activeProfileId = candidates[Math.floor(pathRng.nextDouble() * candidates.length)]!.id;
      }
    }
    const recipe = sampleNeuralVariation(system, {
      referenceId: slot.referenceId,
      seed: organSeed,
      temperature: options.temperature,
      ...(activeProfileId ? { profileId: activeProfileId, severity: options.severity ?? "auto" } : {}),
    });
    return { slot, organSeed, activeProfileId: activeProfileId ?? null, recipe };
  });

  // 2. Compute the shared co-registered scene diffeomorphism controls (vertex-weighted across all organs)
  const sharedControls: Record<string, number> = Object.fromEntries(CONTROL_NAMES.map(name => [name, 0]));
  const sharedLimits = [0, 0, 0, 0, 0, 0, 0];
  let totalWeight = 0;
  for (const item of slotData) {
    const w = Math.max(1, item.slot.vertices);
    totalWeight += w;
    CONTROL_NAMES.forEach((name, idx) => {
      sharedControls[name] = sharedControls[name]! + item.recipe.controls[name]! * options.shapeStrength * w;
      sharedLimits[idx] = sharedLimits[idx]! + item.recipe.reference.limits[idx]! * w;
    });
  }
  CONTROL_NAMES.forEach((name, idx) => {
    sharedControls[name] = sharedControls[name]! / Math.max(1, totalWeight);
    sharedLimits[idx] = sharedLimits[idx]! / Math.max(1, totalWeight);
  });
  const sharedC = CONTROL_NAMES.map((name, idx) => sharedControls[name]! * sharedLimits[idx]!);

  const geometries: BufferGeometry[] = [], materials: Material[] = [], textures: Texture[] = [];
  const pending: { rest: MeshRest; geometry: BufferGeometry; material: Material | Material[] }[] = [];
  const organReports: MultiOrganSceneVariationReport["organReports"] = [];
  let sceneMinJacobian = Infinity, sceneMaxJacobian = -Infinity, totalTriangles = 0;
  let anySeamlessSynthesized = false, anySourceMapsReplaced = false;
  const texturing = options.textureStrength > 0;
  const v = new Vector3(), n = new Vector3(), tangentVector = new Vector3();

  try {
    for (const item of slotData) {
      check();
      const { slot, organSeed, activeProfileId, recipe } = item;
      const reference = recipe.reference;
      const localControls = Object.fromEntries(
        CONTROL_NAMES.map(name => [name, (recipe.controls[name]! * options.shapeStrength - sharedControls[name]!) * 0.28]),
      );
      const hasLocalShape = CONTROL_NAMES.some(name => Math.abs(localControls[name]!) > 1e-6);

      const baseline = resolveMaterial({ ...recipe.material, tint: 0 });
      const base = (baseline.uniforms as Record<string, unknown>).uAtlasBaseColor as number[];
      const roughnessBase = (baseline.uniforms as Record<string, unknown>).uAtlasRoughnessBase as number;
      let seamlessBundle: SeamlessImportedPbrBundle | null = null;
      let slotMinJacobian = Infinity, slotMaxJacobian = -Infinity, slotTriangles = 0;

      for (const meshIdx of slot.meshIndices) {
        check();
        const rest = state.meshes[meshIdx]!;
        const clearance = clearanceWeights[meshIdx]!;
        const geometry = rest.geometry.clone();
        geometries.push(geometry);
        const position = rest.geometry.getAttribute("position");
        const count = position.count;
        const positions = new Float32Array(count * 3);
        const sourceNormal = rest.geometry.getAttribute("normal");
        const sourceTangent = rest.geometry.getAttribute("tangent");
        const normal = sourceNormal ? new Float32Array(count * 3) : null;
        const tangent = sourceTangent ? new Float32Array(count * 4) : null;
        const sourceColor = rest.geometry.getAttribute("color");
        const sourceMaterials = Array.isArray(rest.material) ? rest.material : [rest.material];
        const colorModes = new Set(sourceMaterials.map(mat => Boolean((mat as Material & { vertexColors?: boolean }).vertexColors)));
        const useSourceColor = Boolean(sourceColor && colorModes.has(true));
        const sourceHasTextureMap = sourceMaterials.some(mat => {
          const m = mat as Material & { map?: Texture | null; normalMap?: Texture | null; roughnessMap?: Texture | null };
          return Boolean(m.map || m.normalMap || m.roughnessMap);
        });
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

        // Compute organ-local centered rest coordinates for organ-specific 3D material sampling and disease sites
        const localCentered = new Float64Array(count * 3);
        const [cx, cy, cz] = slot.centroid;
        const localNorm = Math.max(slot.boundsSize[0], slot.boundsSize[1], slot.boundsSize[2], 1e-4) * 0.5;
        for (let i = 0; i < count; i++) {
          localCentered[3 * i] = rest.centered[3 * i]! - cx;
          localCentered[3 * i + 1] = rest.centered[3 * i + 1]! - cy;
          localCentered[3 * i + 2] = rest.centered[3 * i + 2]! - cz;
        }

        const diseaseField = recipe.disease && recipe.diseaseProfile && (options.shapeStrength > 0 || options.textureStrength > 0)
          ? buildOrganLocalDiseaseField(localCentered, rest.geometry, recipe.disease, recipe.diseaseProfile, options.shapeStrength, options.textureStrength)
          : null;
        const hasDiseaseShape = Boolean(diseaseField && options.shapeStrength > 0 && diseaseField.sites.some(s => s.amplitude !== 0));
        const shaping = sharedC.some(val => val !== 0) || hasLocalShape || hasDiseaseShape;
        const organPhase = ((organSeed & 0xffff) / 65535) * Math.PI * 2;

        const uvs = synthesizeSeamless ? new Float32Array(count * 2) : null;
        const colorSize = sourceColor?.itemSize === 4 ? 4 : 3;
        const colors = texturing ? new Float32Array(count * colorSize) : null;
        const worldLinear = new Matrix3().setFromMatrix4(rest.world);
        const localLinear = worldLinear.clone().invert(), worldNormal = worldLinear.clone().invert().transpose();
        const localNormal = worldLinear.clone().transpose();
        let roughnessSum = 0;

        for (let start = 0; start < count; start += 4096) {
          check();
          const end = Math.min(count, start + 4096);
          const sharedSlice = rest.centered.subarray(start * 3, end * 3);
          const localSlice = localCentered.subarray(start * 3, end * 3);

          // Evaluate shared co-registered scene diffeomorphism
          const sharedDeformed = shaping
            ? deformVertices(sharedSlice, sharedControls, sharedLimits, state.normalization)
            : sharedSlice;

          // Evaluate organ-local morphological + pathology residual (damped at contact interfaces by clearance[index])
          let localDeformed: Float64Array | null = null;
          if (shaping && (hasLocalShape || hasDiseaseShape)) {
            const stageLocal = Float64Array.from(localSlice);
            if (hasDiseaseShape && diseaseField) {
              const [gx, gy, gz] = diseaseField.globalScale;
              for (let i = 0; i < stageLocal.length; i += 3) {
                let px = stageLocal[i]!, py = stageLocal[i + 1]!, pz = stageLocal[i + 2]!;
                for (const site of diseaseField.sites) {
                  const r2 = site.radius * site.radius;
                  const invR = 1 / Math.max(site.radius, 1e-6);
                  for (let step = 0; step < diseaseField.steps; step++) {
                    const dx = px - site.cx, dy = py - site.cy, dz = pz - site.cz;
                    const aniso = 1 + 0.24 * Math.sin(dx * invR * 4.2 + site.phase) * Math.cos(dy * invR * 3.8 - dz * invR * 3.5 - site.phase);
                    const d2 = (dx * dx + dy * dy + dz * dz) * aniso;
                    if (d2 >= r2) break;
                    const w = 1 - d2 / r2, w3 = w * w * w;
                    px += w3 * site.amplitude * site.dx;
                    py += w3 * site.amplitude * site.dy;
                    pz += w3 * site.amplitude * site.dz;
                  }
                }
                stageLocal[i] = px * gx;
                stageLocal[i + 1] = py * gy;
                stageLocal[i + 2] = pz * gz;
              }
            }
            localDeformed = hasLocalShape
              ? deformVertices(stageLocal, localControls, reference.limits, localNorm)
              : stageLocal;
          }

          const fieldPoints = texturing
            ? Float64Array.from(localSlice, value => value / localNorm * reference.normalizationMm)
            : null;
          const field = fieldPoints ? sampleMaterialField(recipe.material, fieldPoints) : null;

          for (let index = start; index < end; index++) {
            const local = (index - start) * 3, offset = index * 3;
            const rx = rest.centered[offset]!, ry = rest.centered[offset + 1]!, rz = rest.centered[offset + 2]!;
            const lrx = localCentered[offset]!, lry = localCentered[offset + 1]!, lrz = localCentered[offset + 2]!;
            const nxRest = lrx / localNorm, nyRest = lry / localNorm, nzRest = lrz / localNorm;

            let wx = sharedDeformed[local]!;
            let wy = sharedDeformed[local + 1]!;
            let wz = sharedDeformed[local + 2]!;
            const wClear = clearance[index]!;
            if (localDeformed && wClear > 0) {
              wx += wClear * (localDeformed[local]! - lrx);
              wy += wClear * (localDeformed[local + 1]! - lry);
              wz += wClear * (localDeformed[local + 2]! - lrz);
            }
            if (shaping && wClear > 0 && sourceNormal) {
              const physRelief = evaluateOrganPhysiologicalRelief(reference.organ, nxRest, nyRest, nzRest, organPhase)
                * localNorm * options.shapeStrength * 0.45 * wClear;
              if (Math.abs(physRelief) > 1e-7) {
                wx += sourceNormal.getX(index) * physRelief;
                wy += sourceNormal.getY(index) * physRelief;
                wz += sourceNormal.getZ(index) * physRelief;
              }
            }
            v.set(wx, wy, wz).add(state.center).applyMatrix4(rest.inverse);
            if (![v.x, v.y, v.z].every(Number.isFinite)) throw new Error("Scene variation produced non-finite coordinates.");
            v.toArray(positions, offset);

            if (uvs) {
              const snx = sourceNormal ? sourceNormal.getX(index) : 0;
              const sny = sourceNormal ? sourceNormal.getY(index) : 0;
              const snz = sourceNormal ? sourceNormal.getZ(index) : 0;
              const uvFreq = (reference.organ === "liver" || reference.organ === "pancreas" || reference.organ === "spleen" || reference.organ === "kidney") ? 2.1 : 1.55;
              uvs[index * 2] = uvFreq * (1.28 * nxRest + 0.16 * nyRest - 0.62 * nzRest) + 0.05 * snx - 0.03 * snz;
              uvs[index * 2 + 1] = uvFreq * (-0.22 * nxRest + 1.28 * nyRest + 0.54 * nzRest) + 0.05 * sny + 0.03 * snz;
            }
            if (shaping) {
              const jacobian = derivative(rx, ry, rz, sharedC, state.normalization);
              const determinant = jacobian.determinant();
              if (!(determinant > 0) || !Number.isFinite(determinant)) throw new Error("Scene variation produced an invalid local deformation.");
              slotMinJacobian = Math.min(slotMinJacobian, determinant);
              slotMaxJacobian = Math.max(slotMaxJacobian, determinant);
              if (normal && sourceNormal) {
                n.fromBufferAttribute(sourceNormal, index).applyMatrix3(worldNormal)
                  .applyMatrix3(jacobian.clone().invert().transpose()).applyMatrix3(localNormal).normalize();
                n.toArray(normal, offset);
              }
              if (tangent && sourceTangent) {
                tangentVector.fromBufferAttribute(sourceTangent, index).applyMatrix3(worldLinear).applyMatrix3(jacobian).applyMatrix3(localLinear);
                if (normal) tangentVector.addScaledVector(n, -tangentVector.dot(n));
                tangentVector.normalize().toArray(tangent, index * 4);
                tangent[index * 4 + 3] = sourceTangent.getW(index);
              }
            }
            if (colors && field) {
              let diseaseMask = 0;
              let rimMask = 0;
              if (diseaseField && diseaseField.colorStrength > 0) {
                for (const site of diseaseField.sites) {
                  const dx = lrx - site.cx, dy = lry - site.cy, dz = lrz - site.cz;
                  const rNorm2 = (dx * dx + dy * dy + dz * dz) / (site.radius * site.radius);
                  if (rNorm2 < 1) {
                    const support = 1 - rNorm2;
                    diseaseMask = Math.max(diseaseMask, support * support);
                    rimMask = Math.max(rimMask, 4 * rNorm2 * support);
                  }
                }
                diseaseMask *= diseaseField.colorStrength;
                rimMask *= diseaseField.colorStrength;
              }
              if (synthesizeSeamless && seamlessBundle) {
                const contrastMix = 0.55 + 0.45 * options.textureStrength;
                const isNodular = recipe.diseaseProfile?.pattern === "nodular" || recipe.diseaseProfile?.pattern === "fibrotic";
                const microMod = evaluateOrganMicroStructure3D(reference.organ, nxRest, nyRest, nzRest, organPhase);
                // Peritoneal sulcus ambient occlusion where adjacent co-registered organs meet in apposition
                const sulcusOcclusion = 0.80 + 0.20 * (0.30 + 0.70 * wClear);
                for (let channel = 0; channel < 3; channel++) {
                  const baseLin = base[channel]!;
                  const sampleLin = field.rgbLinear[local + channel]!;
                  const rawLin = clamp(baseLin + contrastMix * (sampleLin - baseLin), 0.002, 0.98);
                  let targetLin = computeOrganTargetLinear(reference.organ, rawLin, channel) * microMod[channel]! * sulcusOcclusion;
                  if (diseaseMask > 0 && diseaseField) {
                    const dLin = Math.pow(clamp(diseaseField.targetLinear[channel]!, 0.005, 0.98), 1.12) * 0.62;
                    targetLin = targetLin * (1 - diseaseMask) + dLin * diseaseMask;
                    if (isNodular && rimMask > 0) {
                      targetLin *= (1 - 0.32 * rimMask);
                    }
                  }
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
        }

        if (shaping) {
          geometry.setAttribute("position", new BufferAttribute(positions, 3));
          if (normal && !hasDiseaseShape && !hasLocalShape) geometry.setAttribute("normal", new BufferAttribute(normal, 3));
          else computeAngleWeightedNormals(geometry);
          if (tangent && !hasDiseaseShape && !hasLocalShape) geometry.setAttribute("tangent", new BufferAttribute(tangent, 4));
        }
        if (uvs) {
          geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
          if (!geometry.getAttribute("normal")) computeAngleWeightedNormals(geometry);
          const normAttr = geometry.getAttribute("normal");
          if (normAttr && (!tangent || hasDiseaseShape || hasLocalShape)) {
            const synthTangents = new Float32Array(count * 4);
            for (let vi = 0; vi < count; vi++) {
              const nx = normAttr.getX(vi), ny = normAttr.getY(vi), nz = normAttr.getZ(vi);
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
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const indices = geometry.index;
        slotTriangles += Math.floor((indices?.count ?? count) / 3);

        const cloneMaterial = (source: Material): Material => {
          const material = source.clone();
          materials.push(material);
          if (texturing) {
            (material as Material & { vertexColors: boolean }).vertexColors = true;
            const std = material as Material & {
              color?: Color; roughness?: number; metalness?: number;
              map?: Texture | null; normalMap?: Texture | null; roughnessMap?: Texture | null;
              normalScale?: Vector2; envMapIntensity?: number;
              clearcoat?: number; clearcoatRoughness?: number;
            };
            if (synthesizeSeamless && seamlessBundle) {
              if (std.color instanceof Color) std.color.setRGB(1, 1, 1);
              std.map = seamlessBundle.map;
              std.normalMap = seamlessBundle.normalMap;
              std.roughnessMap = seamlessBundle.roughnessMap;
              if (std.normalScale instanceof Vector2) {
                const isNodularOrFibrotic = recipe.diseaseProfile?.pattern === "nodular" || recipe.diseaseProfile?.pattern === "fibrotic";
                const isHollowOrLobular = reference.organ === "pancreas" || reference.organ === "large-intestine" ||
                  reference.organ === "stomach" || reference.organ === "small-intestine" || reference.organ === "gallbladder";
                const nScale = isNodularOrFibrotic
                  ? 0.58 + 0.52 * options.textureStrength
                  : reference.organ === "liver"
                    ? 0.04 + 0.04 * options.textureStrength
                    : isHollowOrLobular
                      ? 0.38 + 0.28 * options.textureStrength
                      : 0.16 + 0.14 * options.textureStrength;
                std.normalScale.set(nScale, nScale);
              }
              if (typeof std.metalness === "number") std.metalness = 0;
              if (typeof std.roughness === "number") {
                const isSmoothGlisson = reference.organ === "liver" && !(recipe.diseaseProfile?.pattern === "nodular" || recipe.diseaseProfile?.pattern === "fibrotic");
                std.roughness = isSmoothGlisson
                  ? clamp(0.24 + 0.26 * (roughnessSum / count), 0.22, 0.44)
                  : clamp(0.32 + 0.34 * (roughnessSum / count), 0.28, 0.68);
              }
              if (typeof std.envMapIntensity === "number") {
                std.envMapIntensity = clamp(0.30 + 0.24 * recipe.material.wetness, 0.22, 0.58);
              }
              if (typeof std.clearcoat === "number") {
                const isSmoothGlisson = reference.organ === "liver" && !(recipe.diseaseProfile?.pattern === "nodular" || recipe.diseaseProfile?.pattern === "fibrotic");
                std.clearcoat = isSmoothGlisson
                  ? clamp(0.36 + 0.20 * recipe.material.wetness, 0.32, 0.54)
                  : clamp(0.22 + 0.26 * recipe.material.wetness, 0.16, 0.52);
              }
              if (typeof std.clearcoatRoughness === "number") {
                const isSmoothGlisson = reference.organ === "liver" && !(recipe.diseaseProfile?.pattern === "nodular" || recipe.diseaseProfile?.pattern === "fibrotic");
                std.clearcoatRoughness = isSmoothGlisson
                  ? clamp(0.18 - 0.06 * recipe.material.wetness, 0.12, 0.20)
                  : clamp(0.26 - 0.10 * recipe.material.wetness, 0.16, 0.30);
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

      await yieldTask();
      const sMinJ = Number.isFinite(slotMinJacobian) ? slotMinJacobian : 1;
      const sMaxJ = Number.isFinite(slotMaxJacobian) ? slotMaxJacobian : 1;
      sceneMinJacobian = Math.min(sceneMinJacobian, sMinJ);
      sceneMaxJacobian = Math.max(sceneMaxJacobian, sMaxJ);
      totalTriangles += slotTriangles;
      organReports.push({
        slotId: slot.slotId,
        name: slot.name,
        label: slot.label,
        organ: slot.organ,
        referenceId: slot.referenceId,
        profileId: activeProfileId,
        seed: organSeed,
        vertices: slot.vertices,
        triangles: slotTriangles,
        minJacobian: sMinJ,
        maxJacobian: sMaxJ,
        recipe,
      });
    }

    check();
    for (const item of pending) {
      item.rest.mesh.geometry = item.geometry;
      item.rest.mesh.material = item.material;
    }
    disposeOwned(state);
    state.ownedGeometry = geometries;
    state.ownedMaterials = materials;
    state.ownedTextures = textures;

    const firstRecipe = organReports[0]!.recipe;
    const organRecipes = Object.fromEntries(organReports.map(r => [r.slotId, r.recipe]));
    const resultObj: MultiOrganSceneVariationReport = {
      vertices: state.vertices,
      triangles: totalTriangles,
      minJacobian: Number.isFinite(sceneMinJacobian) ? sceneMinJacobian : 1,
      maxJacobian: Number.isFinite(sceneMaxJacobian) ? sceneMaxJacobian : 1,
      topologyPreserved: true,
      sourceResourcesRetained: true,
      sourceMaterialMapsRetained: !anySourceMapsReplaced,
      appearanceEncoding: !texturing
        ? "original"
        : anySeamlessSynthesized
          ? "seamless-3d-pbr-synthesis"
          : "linear-vertex-color-modulation",
      ...(anySeamlessSynthesized ? { synthesizedTextures: textures.length } : {}),
      coordinateFrame: "shared-centered-source-bounds",
      selfIntersection: "not-tested",
      provenance: { ...firstRecipe.provenance, seed: options.seed },
      organsVaried: organReports.length,
      organRecipes,
      report: null as unknown as MultiOrganSceneVariationReport,
      organReports,
      warnings: [
        `Multi-organ coupled variation applied across ${organReports.length} co-registered organs (shared diffeomorphism + contact-guarded organ morphology & 3D PBR tissue synthesis).`,
        "Adjacent organ contact clearances are locked to the shared spatial warp so hepatobiliary, gastroduodenal, pancreatic and colonic interfaces stay in natural apposition.",
      ],
    };
    resultObj.report = resultObj;
    return resultObj;
  } catch (error) {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    throw error;
  }
}
