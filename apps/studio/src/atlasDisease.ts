/** Authored morphology controls. Intensity is not a clinical stage or severity score. */
export interface AtlasDiseaseSpec {
  profile_id: string;
  seed: number;
  severity: number;
  size: number;
  spread: number;
  irregularity: number;
  contrast: number;
  count: number;
  location: [number, number, number];
}
export interface AtlasDiseaseProfile {
  id: string;
  organ: string;
  label: string;
  pattern: string;
  source_ref: string;
  source_url: string;
  limits: string | string[];
  supported?: boolean;
  unavailable_reason?: string;
}
export const DISEASE_CONTROLS = [
  { key: "severity", label: "Morphology intensity", min: 0, max: 1, default: 0.55 },
  { key: "size", label: "Feature size", min: 0, max: 1, default: 0.5 },
  { key: "spread", label: "Feature spread", min: 0, max: 1, default: 0.5 },
  { key: "irregularity", label: "Irregularity", min: 0, max: 1, default: 0.5 },
  { key: "contrast", label: "Appearance contrast", min: 0, max: 1, default: 0.5 },
  { key: "count", label: "Feature count", min: 1, max: 8, default: 3 },
] as const;
export type DiseaseControlKey = typeof DISEASE_CONTROLS[number]["key"];
export interface AtlasDiseaseLibrary {
  version: string;
  profiles: AtlasDiseaseProfile[];
  defaults: Record<string, AtlasDiseaseSpec>;
  controls: { key: string; label: string; min: number; max: number; default: number }[];
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const named = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const keys = new Set(["profile_id", "seed", "location", ...DISEASE_CONTROLS.map(control => control.key)]);

export function validateAtlasDisease(value: unknown, library?: AtlasDiseaseLibrary, organ?: string): asserts value is AtlasDiseaseSpec {
  if (!object(value) || Object.keys(value).length !== keys.size || Object.keys(value).some(key => !keys.has(key)))
    throw new Error("The disease recipe is incomplete or contains unsupported controls.");
  if (!library || !named(value.profile_id) || !library.profiles.some(profile => profile.id === value.profile_id && profile.supported !== false && (!organ || profile.organ === organ)))
    throw new Error("Choose a disease profile supported by this organ and anatomy library.");
  if (!finite(value.seed) || !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 4294967295)
    throw new Error("The disease seed must be a whole number from 0 to 4,294,967,295.");
  for (const control of DISEASE_CONTROLS) {
    const amount = value[control.key];
    if (!finite(amount) || amount < control.min || amount > control.max || (control.key === "count" && !Number.isInteger(amount)))
      throw new Error(`${control.label} must be ${control.key === "count" ? "a whole number " : ""}between ${control.min} and ${control.max}.`);
  }
  if (!Array.isArray(value.location) || value.location.length !== 3 || !value.location.every(axis => finite(axis) && axis >= -1 && axis <= 1))
    throw new Error("Disease location must contain three coordinates between -1 and 1.");
}

export function validateAtlasDiseaseLibrary(value: unknown, organs: string[]): asserts value is AtlasDiseaseLibrary {
  if (!object(value) || !named(value.version) || !Array.isArray(value.profiles) || !value.profiles.length || !object(value.defaults) || !Array.isArray(value.controls))
    throw new Error("The disease library is incomplete or unsupported.");
  const profileIds = new Set<string>();
  for (const profile of value.profiles) {
    if (!object(profile) || !named(profile.id) || profileIds.has(profile.id) || !named(profile.organ) || !organs.includes(profile.organ) ||
        !named(profile.label) || !named(profile.pattern) || !named(profile.source_ref) || !named(profile.source_url) ||
        !(named(profile.limits) || (Array.isArray(profile.limits) && profile.limits.length > 0 && profile.limits.every(named))))
      throw new Error("The disease library contains an invalid profile or reference.");
    if (profile.supported !== undefined && typeof profile.supported !== "boolean") throw new Error("The disease profile support status is invalid.");
    if (profile.supported === false && !named(profile.unavailable_reason)) throw new Error("A reference-only disease profile must explain its unavailable geometry.");
    profileIds.add(profile.id);
  }
  const controlKeys = new Set<string>();
  for (const entry of value.controls) {
    if (!object(entry) || !named(entry.key) || controlKeys.has(entry.key) || !named(entry.label) || !finite(entry.min) || !finite(entry.max) || !finite(entry.default) ||
        entry.min >= entry.max || entry.default < entry.min || entry.default > entry.max)
      throw new Error("The disease library contains an invalid control.");
    controlKeys.add(entry.key);
  }
  for (const control of DISEASE_CONTROLS) {
    const entry = value.controls.find(item => object(item) && item.key === control.key);
    if (!object(entry) || entry.min !== control.min || entry.max !== control.max || (control.key === "count" && !Number.isInteger(entry.default)))
      throw new Error(`The disease control ${control.key} has unsupported bounds.`);
  }
  for (const organ of organs) validateAtlasDisease(value.defaults[organ], value as unknown as AtlasDiseaseLibrary, organ);
}

export function defaultAtlasDisease(library: AtlasDiseaseLibrary, organ: string, profileId?: string, seed?: number): AtlasDiseaseSpec {
  const defaults = library.defaults[organ];
  if (!defaults) throw new Error("No disease controls are available for this organ.");
  const result = { ...defaults, profile_id: profileId ?? defaults.profile_id, seed: seed ?? defaults.seed, location: [...defaults.location] as AtlasDiseaseSpec["location"] };
  validateAtlasDisease(result, library, organ);
  return result;
}

export function sameAtlasDisease(a?: AtlasDiseaseSpec | null, b?: AtlasDiseaseSpec | null): boolean {
  if (!a || !b) return !a && !b;
  return a.profile_id === b.profile_id && a.seed === b.seed && DISEASE_CONTROLS.every(control => a[control.key] === b[control.key]) &&
    a.location.every((axis, index) => axis === b.location[index]);
}

/** Reproducible design-space variation, not an estimated disease population. */
export function sampleAtlasDisease(library: AtlasDiseaseLibrary, recipe: AtlasDiseaseSpec, seed: number, strength = 1): AtlasDiseaseSpec {
  validateAtlasDisease({ ...recipe, seed }, library);
  if (!finite(strength) || strength < 0 || strength > 1) throw new Error("Disease variation strength must be between 0 and 1.");
  let state = (seed ^ 0x91e10da5) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const organ = library.profiles.find(profile => profile.id === recipe.profile_id)!.organ;
  const baseline = library.defaults[organ]!;
  const result: AtlasDiseaseSpec = { ...recipe, seed, location: [...baseline.location] };
  for (const control of DISEASE_CONTROLS) {
    const center = baseline[control.key];
    const low = center + (control.min - center) * strength;
    const high = center + (control.max - center) * strength;
    const amount = low + random() * (high - low);
    result[control.key] = control.key === "count" ? Math.round(amount) : Math.max(low, Math.min(high, Math.round(amount * 10000) / 10000));
  }
  result.location = baseline.location.map(axis => Math.max(-1, Math.min(1, Math.round((axis + ((random() * 2 - 1) - axis) * strength) * 10000) / 10000))) as AtlasDiseaseSpec["location"];
  validateAtlasDisease(result, library, organ);
  return result;
}
