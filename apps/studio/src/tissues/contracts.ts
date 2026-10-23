import type { TissueMaterialVariation } from "./materialVariation";
export interface TissueEntry { id: string; label: string; manifest: string | null; preview: string; luminal: boolean; available_resolutions?: number[]; family?: string; group?: string; thumbnail?: string }
export interface TissueChannel { file: string; color_space: string; sha256?: string; packing?: string[]; decode_scale_mm?: number[]; decode_offset_mm?: number[] }
export interface TissueManifest {
  schema: string;
  resolution: [number, number];
  recipe: { organ: string; seed: string | number; tile_size_mm: number; wetness: number; vessel_opacity: number; fascia_opacity: number; adipose_opacity: number; [key: string]: unknown };
  channels: Record<string, TissueChannel>;
  layers: { id: string; file: string; opacity: number; role?: string }[];
  [key: string]: unknown;
}
export type TissueStudy = "lit" | "albedo" | "normal" | "roughness";
export type TissueView = "surface" | "walkthrough" | "organ";
export interface TissueControls { vessels: number; fascia: number; adipose: number; wetness: number; study: TissueStudy; view: TissueView; playing: boolean; time: number; seed: number; lighting: "camera" | "grazing"; cameraYawDeg?: number; cameraPitchDeg?: number; materialVariation?: TissueMaterialVariation }
export interface LearnedAppearanceRecipe { modelId: string; condition: string; region: string; seed: string; resolution: number; evidence: string }

/** Straight-alpha over, in linear-light RGB. Opacity is coverage, not optical transmission. */
export function compositeLinear(base: readonly number[], overlay: readonly number[], coverage: number, opacity: number): number[] {
  if (![coverage, opacity, ...base, ...overlay].every(Number.isFinite) || coverage < 0 || coverage > 1 || opacity < 0 || opacity > 1) throw new Error("Invalid layer coverage");
  return base.map((value, index) => value * (1 - coverage * opacity) + overlay[index]! * coverage * opacity);
}
export function validateEntry(value: unknown): TissueEntry {
  const item = value as Partial<TissueEntry> | null;
  const pathIsValid = (path: unknown) => typeof path === "string" && /^[a-z0-9_][a-z0-9_/-]*\.json$/.test(path) && !path.includes("..");
  if (!item || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.luminal !== "boolean" || !pathIsValid(item.preview) || (item.manifest !== null && !pathIsValid(item.manifest))) throw new Error("Invalid tissue catalog entry");
  if (item.available_resolutions !== undefined && (!Array.isArray(item.available_resolutions) || !item.available_resolutions.includes(512) || new Set(item.available_resolutions).size !== item.available_resolutions.length || !item.available_resolutions.every(value => value === 512 || value === 4096))) throw new Error("Invalid tissue resolution availability");
  if (item.manifest === null && (!item.available_resolutions || item.available_resolutions.includes(4096))) throw new Error("Missing native tissue manifest must be explicitly declared unavailable");
  // Optional learned-library metadata: a family key, a display group and a small preview image.
  if (item.family !== undefined && (typeof item.family !== "string" || !/^[a-z][a-z0-9_]{1,40}$/.test(item.family))) throw new Error("Invalid tissue family key");
  if (item.group !== undefined && (typeof item.group !== "string" || !item.group.trim() || item.group.length > 80)) throw new Error("Invalid tissue catalog group");
  if (item.thumbnail !== undefined && (typeof item.thumbnail !== "string" || !/^[a-z0-9_][a-z0-9_/-]*\.png$/.test(item.thumbnail) || item.thumbnail.includes(".."))) throw new Error("Invalid tissue thumbnail path");
  return item as TissueEntry;
}
export function nativeTissueAvailable(entry?: TissueEntry): boolean {
  return Boolean(entry?.manifest && (!entry.available_resolutions || entry.available_resolutions.includes(4096)));
}

/** Preserve uint64 JSON number tokens; parsing/stringifying the manifest rounds values above 2^53. */
export function serializeDisplayRecipe(manifestSource: string, controls: TissueControls, note: string, appearance?: LearnedAppearanceRecipe): string {
  const parsed: unknown = JSON.parse(manifestSource);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a material manifest object");
  // Pick only replay metadata; a caller may also own a GPU texture or a worker.
  const learned = appearance ? { modelId: appearance.modelId, condition: appearance.condition, region: appearance.region,
    seed: appearance.seed, resolution: appearance.resolution, evidence: appearance.evidence,
    output: "observed_rgb_appearance", pbrGroundTruth: false, weightsRequired: "Import the exact .tissue-model.json identified by modelId." } : null;
  return `{\n  "material": ${manifestSource.trim()},\n  "display": ${JSON.stringify(controls, null, 2)},\n  "learnedAppearance": ${JSON.stringify(learned, null, 2)},\n  "note": ${JSON.stringify(note)}\n}\n`;
}
