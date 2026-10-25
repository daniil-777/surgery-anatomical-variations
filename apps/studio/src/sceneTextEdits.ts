/** The organ editor's compiler, adapted to existing scene meshes without replacing them. */
import { apiGet } from "./api";
import { defaultAtlasSpec, validateAtlasCatalog, validateAtlasSpec, type AtlasCatalog, type AtlasGeneration, type AtlasSpec } from "./atlas";
import { bundledReference } from "./atlasLocal";
import { compileTextLocally, loadTextCompilerTables } from "./atlasTextCompiler";
import { compileImportedText, type ImportedVariationRecipe, type ImportedVariationSystem } from "./imports/variations";

let catalogPromise: Promise<AtlasCatalog> | undefined;
async function catalog() {
  catalogPromise ??= apiGet("/api/atlas/catalog", undefined, "atlas/catalog.json").then(async response => {
    if (!response.ok) throw new Error("The anatomy text library could not be loaded. Try again.");
    const value: unknown = await response.json(); validateAtlasCatalog(value); return value;
  }).catch(error => { catalogPromise = undefined; throw error; });
  return catalogPromise;
}

export async function compileSceneText(system: ImportedVariationSystem, referenceId: string, text: string,
  current?: ImportedVariationRecipe, library?: AtlasCatalog,
  references: (id: string) => Promise<AtlasGeneration> = bundledReference): Promise<ImportedVariationRecipe> {
  if (!text.trim() || text.length > 2000) throw new Error("Enter 1–2,000 characters of anatomy edits.");
  // The atlas dimension solver measures its own specimens, never an uploaded scene.
  if (/%|\b(?:mm|cm|millimet(?:er|re)s?|centimet(?:er|re)s?|percent)\b/i.test(text))
    throw new Error("Scene edits use relative controls. Try “wider” or “scale_x 0.3”; measured dimensions and percentages require a calibrated mesh.");
  const reference = system.references.find(item => item.id === referenceId);
  if (!reference) throw new Error("Choose an organ reference for the target mesh first.");
  const lib = library ?? await catalog();
  const spec: AtlasSpec = current?.reference.id === referenceId
    ? { renderer_version: "disease-v2", template_id: referenceId, seed: current.provenance.seed,
      controls: { ...current.controls }, material: { ...current.material }, disease: current.disease ?? null, appearance: "tissue" }
    : defaultAtlasSpec(lib, referenceId);
  const result = await compileTextLocally(text.trim(), spec, lib, references);
  if (result.status !== "accepted") {
    // Keep the original upload editor's concise, explicit control syntax working.
    try { return compileImportedText(system, referenceId, text, current); }
    catch { throw new Error(String(result.message || "That edit is not supported. Try one of the scene hints.")); }
  }
  validateAtlasSpec(result.spec, lib);
  const next = result.spec;
  if (next.template_id !== referenceId) throw new Error("Choose the target organ before applying this instruction. Text edits cannot replace a scene mesh with another reference.");
  const diseaseProfile = next.disease ? system.profiles.find(item => item.id === next.disease!.profile_id && item.organ === reference.organ) : undefined;
  if (next.disease && !diseaseProfile) throw new Error("This disease does not have a supported shape-and-surface profile for the selected mesh.");
  if (!next.material || next.appearance !== "tissue") throw new Error("Text edits use tissue appearance. Use Restore original or White geometry to inspect source geometry and materials.");
  return { reference, controls: { ...next.controls }, material: { ...next.material }, disease: next.disease ?? null,
    diseaseProfile: diseaseProfile ?? null,
    provenance: { method: "deterministic-text-controls", modelSha256: null,
      modelScope: "Existing anatomy compiler; bounded shape and appearance transfer to the selected scene anatomy.",
      contextGain: 0, seed: next.seed, temperature: null, referenceId, trainingSamples: 0,
      text: text.trim(), meshEncoding: false, diseaseInference: false } };
}

export interface SceneTextHint { id: string; label: string; prompt: string }
/** The connected scene currently implements severity, not independently placed lesions. */
export async function validateConnectedSceneDisease(recipe: ImportedVariationRecipe, allowed: readonly string[]) {
  if (!recipe.disease) return;
  if (!allowed.includes(recipe.disease.profile_id)) throw new Error("This disease is available in the organ/import editor, but not in this connected scene. Choose a scene hint.");
  const defaults = (await loadTextCompilerTables()).disease_defaults;
  for (const key of ["size", "spread", "irregularity", "contrast", "count", "location"] as const)
    if (JSON.stringify(recipe.disease[key]) !== JSON.stringify(defaults[key]))
      throw new Error("This connected scene supports disease severity, shape controls and tissue finish. Custom lesion count, size, distribution and contrast are available in the organ/import editor.");
}
export function sceneTextHints(system: ImportedVariationSystem | null, organ: string, allowed?: readonly string[]): SceneTextHint[] {
  return [
    ...(system?.profiles.filter(profile => profile.organ === organ && (!allowed || allowed.includes(profile.id))) ?? [])
      .map(profile => ({ id: profile.id, label: profile.label, prompt: `${profile.id}, severity 0.75, wetness 0.7` })),
    { id: "wider", label: "Wider & wetter", prompt: "wider; wetter" },
    { id: "baseline", label: "Healthy baseline", prompt: "healthy, scale_x 0, scale_y 0, scale_z 0, bend 0, twist 0, taper 0, asymmetry 0" },
  ];
}
