import { OFFLINE_MESSAGE, apiOnline } from "./api";
import type { SceneData } from "@viscera/render";
import { validateScene } from "./project";
import { sameAtlasMaterial, validateAtlasMaterial, validateAtlasMaterialLibrary, type AtlasMaterialRecipe, type AtlasMaterialLibrary } from "./atlasMaterial";
import { sameAtlasDisease, sampleAtlasDisease, validateAtlasDisease, validateAtlasDiseaseLibrary, type AtlasDiseaseSpec, type AtlasDiseaseLibrary } from "./atlasDisease";
import { readAtlasDiseaseField, readAtlasMaterial } from "./atlasMaterialShader";

export type AtlasAppearance = "source" | "tissue" | "clay";
export interface AtlasTemplate {
  id: string;
  label: string;
  source: string;
  license: string;
  source_url?: string;
  [key: string]: unknown;
}
export interface AtlasOrgan {
  id: string;
  label: string;
  templates: AtlasTemplate[];
  [key: string]: unknown;
}
export interface AtlasControl {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  description?: string;
}
export interface AtlasCatalog {
  renderer_version?: "disease-v2";
  organs: AtlasOrgan[];
  controls: AtlasControl[];
  release?: unknown;
  materials?: AtlasMaterialLibrary;
  diseases?: AtlasDiseaseLibrary;
}
export interface AtlasSpec {
  renderer_version?: "disease-v2";
  template_id: string;
  seed: number;
  controls: Record<string, number>;
  appearance: AtlasAppearance;
  material?: AtlasMaterialRecipe | null;
  disease?: AtlasDiseaseSpec | null;
  [key: string]: unknown;
}
export interface AtlasGeneration {
  scene: SceneData;
  spec: AtlasSpec;
  summary: Record<string, unknown>;
}
export interface AtlasCompilation {
  status: "accepted" | "unsupported";
  message: string;
  spec?: AtlasSpec;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const named = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

export function validateAtlasCatalog(value: unknown): asserts value is AtlasCatalog {
  if (!object(value) || !Array.isArray(value.organs) || !value.organs.length ||
      !Array.isArray(value.controls) || !value.controls.length)
    throw new Error("The anatomy library is empty or unavailable.");
  const organIds = new Set<string>();
  const templateIds = new Set<string>();
  for (const organ of value.organs) {
    if (!object(organ) || !named(organ.id) || !named(organ.label) ||
        organIds.has(organ.id) || !Array.isArray(organ.templates) || !organ.templates.length)
      throw new Error("The anatomy library contains an invalid organ entry.");
    organIds.add(organ.id);
    for (const template of organ.templates) {
      if (!object(template) || !named(template.id) || !named(template.label) ||
          !named(template.source) || !named(template.license) || templateIds.has(template.id))
        throw new Error("The anatomy library contains an invalid reference entry.");
      templateIds.add(template.id);
    }
  }
  const keys = new Set<string>();
  for (const control of value.controls) {
    if (!object(control) || !named(control.key) || unsafeKeys.has(control.key) ||
        keys.has(control.key) || !named(control.label) || !finite(control.min) ||
        !finite(control.max) || !finite(control.default) || control.min >= control.max ||
        control.default < control.min || control.default > control.max)
      throw new Error("The anatomy library contains an invalid shape control.");
    keys.add(control.key);
  }
  if (value.materials !== undefined) validateAtlasMaterialLibrary(value.materials, [...organIds]);
  if (value.diseases !== undefined) validateAtlasDiseaseLibrary(value.diseases, [...organIds]);
}

export function defaultAtlasSpec(catalog: AtlasCatalog, templateId: string): AtlasSpec {
  const organ = catalog.organs.find((entry) => entry.templates.some((template) => template.id === templateId));
  const spec: AtlasSpec = {
    ...(catalog.renderer_version ? { renderer_version: catalog.renderer_version } : {}),
    template_id: templateId,
    seed: 42,
    controls: Object.fromEntries(catalog.controls.map((c) => [c.key, c.default])),
    appearance: "tissue",
    ...(organ && catalog.materials ? { material: { ...catalog.materials.defaults[organ.id]! } } : {}),
  };
  validateAtlasSpec(spec, catalog);
  return spec;
}

/** A deterministic design sampler, not a learned population distribution.
 * Each realized control is stored in the spec; the seed alone never stands in
 * for geometry. Strength scales the existing bounded interval about its default;
 * it never expands the reference's supported deformation envelope. */
export function sampleAtlasRecipe(catalog: AtlasCatalog, spec: AtlasSpec, strength = 1): AtlasSpec {
  validateAtlasSpec(spec, catalog);
  if (!finite(strength) || strength < 0 || strength > 1)
    throw new Error("Variation strength must be a finite number between 0 and 1.");
  let state = spec.seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    ...spec,
    ...(spec.disease && catalog.diseases ? { disease: sampleAtlasDisease(catalog.diseases, spec.disease, spec.seed, strength) } : {}),
    controls: Object.fromEntries(catalog.controls.map((control) => {
      const low = control.default + (control.min - control.default) * strength;
      const high = control.default + (control.max - control.default) * strength;
      const value = Math.round((low + random() * (high - low)) * 10000) / 10000;
      return [control.key, strength === 0 ? control.default : Math.max(low, Math.min(high, value))];
    })),
  };
}

/** Reject unsupported controls rather than silently producing a different organ. */
export function validateAtlasSpec(value: unknown, catalog: AtlasCatalog): asserts value is AtlasSpec {
  if (!object(value) || typeof value.template_id !== "string" ||
      !catalog.organs.some((o) => o.templates.some((t) => t.id === value.template_id)))
    throw new Error("Choose a reference from the anatomy library.");
  if (value.renderer_version !== undefined && value.renderer_version !== "disease-v2") throw new Error("Unsupported anatomy renderer version.");
  if (!finite(value.seed) || !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 4294967295)
    throw new Error("The seed must be a whole number from 0 to 4,294,967,295.");
  if (!["source", "tissue", "clay"].includes(String(value.appearance)))
    throw new Error("The requested appearance is not supported.");
  if (value.material !== undefined && value.material !== null) {
    if (value.appearance !== "tissue") throw new Error("Editable tissue materials require Tissue appearance.");
    const organ = catalog.organs.find((entry) => entry.templates.some((template) => template.id === value.template_id));
    validateAtlasMaterial(value.material, organ?.id);
  }
  if (value.disease !== undefined && value.disease !== null) {
    const organ = catalog.organs.find(entry => entry.templates.some(template => template.id === value.template_id));
    validateAtlasDisease(value.disease, catalog.diseases, organ?.id);
  }
  const controls = value.controls;
  if (!object(controls) || Object.keys(controls).length !== catalog.controls.length)
    throw new Error("The shape recipe does not match this anatomy library.");
  for (const control of catalog.controls) {
    const amount = controls[control.key];
    if (!finite(amount) || amount < control.min || amount > control.max)
      throw new Error(`${control.label} must be between ${control.min} and ${control.max}.`);
  }
}

export function validateAtlasGeneration(value: unknown, catalog: AtlasCatalog): asserts value is AtlasGeneration {
  if (!object(value)) throw new Error("The server returned an invalid anatomy preview.");
  validateScene(value.scene);
  validateAtlasSpec(value.spec, catalog);
  if (!object(value.summary)) throw new Error("The anatomy preview has no generation summary.");
  let hasDiseaseField = false;
  for (const organ of [...value.scene.organs, ...(value.scene.vessels ?? [])]) {
    const field = value.spec.material
      ? readAtlasMaterial(organ, value.scene, value.spec.material)?.diseaseField
      : readAtlasDiseaseField(organ);
    hasDiseaseField ||= Boolean(field);
  }
  if (Boolean(value.spec.disease) !== hasDiseaseField)
    throw new Error("The preview disease field does not match the requested recipe. The previous preview was preserved.");
}

/** A learned sampler may derive a new spatial seed, but must bind it to the requested seed. */
export function validateAtlasDiseaseSampling(request: AtlasSpec, result: AtlasGeneration): void {
  const provenance = result.summary.disease_model;
  if (!request.disease || !result.spec.disease || !sameAtlasRecipe({ ...request, disease: null }, { ...result.spec, disease: null }) ||
      result.spec.disease.profile_id !== request.disease.profile_id || !object(provenance) ||
      provenance.request_seed !== request.disease.seed || provenance.spatial_seed !== result.spec.disease.seed ||
      provenance.profile_id !== request.disease.profile_id || !named(provenance.model_sha256))
    throw new Error("The disease variation did not preserve the requested shape, surface and profile, or its model provenance does not bind the request and spatial seeds.");
}

/** Joint sampling may change all three controls, but never the organ/profile. */
export function validateAtlasJointSampling(request: AtlasSpec, result: AtlasGeneration, temperature: number, severity = "auto"): void {
  const provenance = result.summary.joint_model;
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (result.spec.template_id !== request.template_id || result.spec.seed !== request.seed ||
      result.spec.appearance !== "tissue" || !result.spec.material ||
      (result.spec.disease?.profile_id ?? null) !== (request.disease?.profile_id ?? null) ||
      !object(provenance) || provenance.request_seed !== request.seed ||
      provenance.temperature !== temperature || provenance.template_id !== request.template_id ||
      provenance.profile_id !== (request.disease?.profile_id ?? null) ||
      provenance.material_seed !== result.spec.material.seed ||
      provenance.spatial_seed !== (result.spec.disease?.seed ?? null) ||
      !hash(provenance.model_sha256) || !hash(provenance.bundle_sha256))
    throw new Error("The joint VAE result does not match the requested organ, disease, seed or model provenance. The previous preview was preserved.");
  if (provenance.model_generation === 2 && (result.spec.renderer_version !== "disease-v2" || provenance.request_severity_band !== severity)) throw new Error("The expanded model returned the wrong renderer or severity request.");
  if (severity !== "auto" && result.spec.disease) {
    const range = ({ mild: [0.1, 0.35], moderate: [0.35, 0.7], severe: [0.7, 1] } as Record<string, number[]>)[severity];
    if (!range || provenance.model_generation !== 2 || result.spec.disease.severity < range[0]! - 1e-6 || result.spec.disease.severity > range[1]! + 1e-6) throw new Error("The generated disease intensity is outside the requested design range.");
  }
}

/** Only geometry/style inputs define unsent edits; server provenance is retained on export. */
export function sameAtlasRecipe(a: AtlasSpec | null, b: AtlasSpec | null): boolean {
  if (!a || !b) return a === b;
  return a.template_id === b.template_id && a.renderer_version === b.renderer_version && a.seed === b.seed && a.appearance === b.appearance &&
    sameAtlasMaterial(a.material, b.material) && sameAtlasDisease(a.disease, b.disease) &&
    Object.keys(a.controls).length === Object.keys(b.controls).length &&
    Object.entries(a.controls).every(([key, value]) => b.controls[key] === value);
}

/** Inputs capable of changing geometry, excluding appearance-only edits. */
export function sameAtlasGeometry(a: AtlasSpec, b: AtlasSpec): boolean {
  return a.template_id === b.template_id && a.renderer_version === b.renderer_version && sameAtlasDisease(a.disease, b.disease) &&
    Object.keys(a.controls).length === Object.keys(b.controls).length &&
    Object.entries(a.controls).every(([key, value]) => b.controls[key] === value);
}

export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch { return; }
}

export async function atlasError(response: Response): Promise<Error> {
  if (!(await apiOnline())) return new Error(OFFLINE_MESSAGE);
  let explanation = `Request failed (${response.status}).`;
  try {
    const value: unknown = await response.json();
    if (object(value)) {
      const detail = value.detail ?? value.message;
      if (typeof detail === "string") explanation = detail;
      else if (Array.isArray(detail)) explanation = detail.flatMap((entry) =>
        object(entry) && typeof entry.msg === "string" ? [entry.msg] : [],
      ).join("; ") || explanation;
    }
  } catch { /* HTTP status remains useful when an upstream proxy returns HTML. */ }
  return new Error(explanation);
}
