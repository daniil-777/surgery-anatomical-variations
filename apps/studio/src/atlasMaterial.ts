/** Versioned, author-controlled tissue appearance. These are display designs,
 * not measured optical properties, population traits or diagnostic states. */
export const ATLAS_MATERIAL_VERSION = "atlas-material-2.0.0" as const;
export const ATLAS_MATERIAL_PRESETS = ["balanced", "soft", "rich", "moist"] as const;
export type AtlasMaterialPreset = typeof ATLAS_MATERIAL_PRESETS[number];
/** Observed display colour from a reviewed reference region, not measured albedo. */
export interface ReferenceColor {
  version: "reference-color-1";
  source_sha256: string;
  mask_sha256: string;
  organ: string;
  observed_srgb: [number, number, number];
  strength: number;
  mode: "chroma" | "color";
}
export interface AtlasMaterialRecipe {
  version: typeof ATLAS_MATERIAL_VERSION;
  organ: string;
  preset: AtlasMaterialPreset;
  seed: number;
  tint: number;
  pigment_contrast: number;
  mottle_scale_mm: number;
  wetness: number;
  fine_detail: number;
  structure_strength: number;
  reference_color?: ReferenceColor | null;
}
export interface AtlasMaterialLibrary {
  version: typeof ATLAS_MATERIAL_VERSION;
  presets: { id: AtlasMaterialPreset; label: string; description: string }[];
  defaults: Record<string, AtlasMaterialRecipe>;
  controls: { key: string; label: string; min: number; max: number; step: number }[];
  organ_presets: Record<string, Record<AtlasMaterialPreset, { recipe: AtlasMaterialRecipe; swatches: string[] }>>;
}
export const MATERIAL_CONTROLS = [
  { key: "tint", label: "Pigment tone", min: -1, max: 1, step: 0.02, description: "Shift within this organ’s authored palette." },
  { key: "pigment_contrast", label: "Pigment variation", min: 0, max: 1, step: 0.01, description: "Contrast of the designed pigment field." },
  { key: "mottle_scale_mm", label: "Pattern size", min: 2, max: 40, step: 0.5, unit: "mm", description: "Physical wavelength of broad pigment variation in reference millimetres." },
  { key: "wetness", label: "Surface wetness", min: 0, max: 1, step: 0.01, description: "Designed roughness and clearcoat response." },
  { key: "fine_detail", label: "Fine surface detail", min: 0, max: 1, step: 0.01, description: "Shading detail without changing the organ’s geometry or silhouette." },
  { key: "structure_strength", label: "Pattern structure", min: 0, max: 1, step: 0.01, description: "Organ-specific authored texture, not reconstructed tissue architecture." },
] as const;
const materialKeys = new Set(["version", "organ", "preset", "seed", ...MATERIAL_CONTROLS.map((control) => control.key)]);
const referenceKeys = ["version", "source_sha256", "mask_sha256", "organ", "observed_srgb", "strength", "mode"] as const;
export function validateReferenceColor(value: unknown, organ: string): asserts value is ReferenceColor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The reference colour is invalid.");
  const reference = value as Record<string, unknown>;
  if (Object.keys(reference).length !== referenceKeys.length || Object.keys(reference).some(key => !(referenceKeys as readonly string[]).includes(key)) ||
      reference.version !== "reference-color-1" || reference.organ !== organ ||
      typeof reference.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.source_sha256) ||
      typeof reference.mask_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.mask_sha256) ||
      !Array.isArray(reference.observed_srgb) || reference.observed_srgb.length !== 3 ||
      !reference.observed_srgb.every(channel => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1) ||
      typeof reference.strength !== "number" || !Number.isFinite(reference.strength) || reference.strength < 0 || reference.strength > 1 ||
      (reference.mode !== "chroma" && reference.mode !== "color"))
    throw new Error("The reference colour does not match this organ or contains invalid colour data.");
}
export function validateAtlasMaterial(value: unknown, organ?: string): asserts value is AtlasMaterialRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The surface recipe is invalid.");
  const recipe = value as Record<string, unknown>;
  if (![...materialKeys].every(key => Object.hasOwn(recipe, key)) || Object.keys(recipe).some((key) => !materialKeys.has(key) && key !== "reference_color") ||
      recipe.version !== ATLAS_MATERIAL_VERSION || typeof recipe.organ !== "string" || !recipe.organ.trim() ||
      (organ !== undefined && recipe.organ !== organ) || !ATLAS_MATERIAL_PRESETS.includes(recipe.preset as AtlasMaterialPreset))
    throw new Error("The surface recipe does not match this organ or material version.");
  if (typeof recipe.seed !== "number" || !Number.isInteger(recipe.seed) || recipe.seed < 0 || recipe.seed > 4294967295)
    throw new Error("The appearance seed must be a whole number from 0 to 4,294,967,295.");
  for (const control of MATERIAL_CONTROLS) {
    const value = recipe[control.key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < control.min || value > control.max)
      throw new Error(`${control.label} must be between ${control.min} and ${control.max}.`);
  }
  if (recipe.reference_color !== undefined && recipe.reference_color !== null) validateReferenceColor(recipe.reference_color, recipe.organ as string);
}

/** Compare declared appearance inputs and reference evidence by value. */
export function sameAtlasMaterial(a: AtlasMaterialRecipe | null | undefined, b: AtlasMaterialRecipe | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (![...materialKeys].every((key) => a[key as keyof AtlasMaterialRecipe] === b[key as keyof AtlasMaterialRecipe])) return false;
  const left = a.reference_color, right = b.reference_color;
  if (!left || !right) return !left && !right;
  return referenceKeys.every(key => key === "observed_srgb"
    ? left.observed_srgb.every((channel, index) => channel === right.observed_srgb[index])
    : left[key] === right[key]);
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function validateAtlasMaterialLibrary(value: unknown, organs: string[]): asserts value is AtlasMaterialLibrary {
  if (!object(value) || value.version !== ATLAS_MATERIAL_VERSION || !object(value.defaults) || !object(value.organ_presets) ||
      !Array.isArray(value.presets) || value.presets.length !== ATLAS_MATERIAL_PRESETS.length || !Array.isArray(value.controls))
    throw new Error("The surface library has an unsupported or incomplete material definition.");
  const presets = new Set<string>();
  for (const entry of value.presets) {
    if (!object(entry) || !ATLAS_MATERIAL_PRESETS.includes(entry.id as AtlasMaterialPreset) || presets.has(String(entry.id)) ||
        typeof entry.label !== "string" || !entry.label.trim() || typeof entry.description !== "string")
      throw new Error("The surface library contains an invalid preset.");
    presets.add(String(entry.id));
  }
  for (const organ of organs) {
    validateAtlasMaterial(value.defaults[organ], organ);
    const options = value.organ_presets[organ];
    if (!object(options)) throw new Error(`The surface library has no palettes for ${organ}.`);
    for (const preset of ATLAS_MATERIAL_PRESETS) {
      const entry = options[preset];
      if (!object(entry) || !Array.isArray(entry.swatches) || !entry.swatches.length ||
          !entry.swatches.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)))
        throw new Error(`The ${organ} surface palette is invalid.`);
      validateAtlasMaterial(entry.recipe, organ);
      if (entry.recipe.preset !== preset) throw new Error("The surface palette does not match its preset.");
    }
  }
  for (const control of MATERIAL_CONTROLS) {
    const entry = value.controls.find((item) => object(item) && item.key === control.key);
    if (!object(entry) || entry.min !== control.min || entry.max !== control.max || typeof entry.label !== "string" ||
        typeof entry.step !== "number" || !Number.isFinite(entry.step) || entry.step <= 0)
      throw new Error(`The surface control ${control.key} has unsupported bounds.`);
  }
}
