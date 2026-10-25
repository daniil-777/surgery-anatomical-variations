/** Public presentation names. Keep runtime IDs, weights and provenance unchanged. */
export const MODEL_NAMES = {
  joint1: "Generative Model 1",
  joint2: "Generative Model 2",
  shape: "Generative Model 3",
  material: "Generative Model 4",
  disease: "Generative Model 5",
  wording: "Generative Model 6",
  language: "Generative Model 7",
  appearance3: "Generative Model 8",
  appearance2: "Generative Model 9",
  appearance1: "Generative Model 10",
  pbr: "Generative Model 11",
  tiles: "Generative Model 12",
} as const;

export const jointModelName = (generation: 1 | 2) => generation === 2 ? MODEL_NAMES.joint2 : MODEL_NAMES.joint1;

const appearanceNames: Readonly<Record<string, string>> = {
  "spatial-v3-laparoscopic": MODEL_NAMES.appearance3,
  "directional-v2-detail": MODEL_NAMES.appearance2,
  "periodic-v1-baseline": MODEL_NAMES.appearance1,
};

/** Never echo a catalog's arbitrary model label, including catalogs from older deployments. */
export function appearanceModelLabel(entry: { id: string }): string {
  return Object.hasOwn(appearanceNames, entry.id) ? appearanceNames[entry.id]! : "Imported generative model";
}

export function pbrModelLabel(entry: { id: string; organ: string; resolution: readonly number[] }): string {
  const name = entry.id.startsWith("stablematerials-") ? MODEL_NAMES.pbr
    : entry.id.startsWith("lora-") ? MODEL_NAMES.tiles : "Imported generative model";
  return `${name} · ${modelMessage(entry.organ.replaceAll("_", " "))} · ${entry.resolution.join(" × ")}`;
}

/** Curated capability text avoids exposing backend method names and implementation descriptions. */
export function modelLaneDisplay(name: string, method: string | undefined, generation: 1 | 2) {
  const lanes: Record<string, { label: string; scope: string }> = {
    joint: { label: jointModelName(generation), scope: "Shape, tissue colour and disease variations · authored designs, not clinical staging." },
    shape: { label: MODEL_NAMES.shape, scope: "Shape controls · synthetic design distribution." },
    material: { label: MODEL_NAMES.material, scope: "Surface appearance controls · procedural training data." },
    disease: { label: MODEL_NAMES.disease, scope: "Disease surface variations · synthetic training data." },
    wording: { label: method === "built_in_semantic_plans" ? "Built-in text interpreter" : MODEL_NAMES.wording, scope: "Text instructions for shape, appearance and disease · validated before application." },
    language: { label: MODEL_NAMES.language, scope: "Optional text instructions for shape · validated before application." },
    clinical: { label: "Clinical case library", scope: "Observed training cases only; not an editor generator." },
    physics: { label: "Material mechanics", scope: "Synthetic force and strain experiments; not calibrated human tissue mechanics." },
  };
  return Object.hasOwn(lanes, name) ? lanes[name]! : { label: "Additional model", scope: "Imported model capability." };
}

/** Sanitize human-readable diagnostics at presentation boundaries, never exported evidence. */
export function modelMessage(text: string): string {
  return text
    .replace(/(?:joint[_ -])?(?:conditional[_ -])?spline[_ -]flow(?:[_ -]v2)?|joint(?: shape \+ colou?r)?[_ -]flow(?:[_ -]v2)?|\bflow v2\b/gi, MODEL_NAMES.joint2)
    .replace(/joint(?: shape \+ colou?r)?[_ -](?:conditional[_ -])?vae(?:[_ -]v1)?|\bvae v1\b/gi, MODEL_NAMES.joint1)
    .replace(/(?:masked-rgb-)?spatial[- ]cvae-gan(?:[- ]v\d)?/gi, MODEL_NAMES.appearance3)
    .replace(/(?:masked-rgb-)?directional(?: Fourier)?[- ]cvae-gan(?:[- ]v\d)?/gi, MODEL_NAMES.appearance2)
    .replace(/(?:masked-rgb-)?periodic(?: Fourier)?[- ]cvae(?:[- ]v\d)?/gi, MODEL_NAMES.appearance1)
    .replace(/(?:Qwen\/)?Qwen[\w.\/-]*(?:[_ -]LoRA[\w-]*)?/gi, "text model")
    .replace(/StableMaterials(?: PBR)?/gi, MODEL_NAMES.pbr)
    .replace(/(?:Stable[ -]?Diffusion(?:[ -]1\.5)?|SD\s?1\.5|sd15)(?: Tissue)?(?: LoRA)?/gi, MODEL_NAMES.tiles)
    .replace(/\b(?:research )?LoRA\b/gi, MODEL_NAMES.tiles)
    .replace(/\bconditional[_ -]vae\b/gi, MODEL_NAMES.disease)
    .replace(/\b(?:CVAE(?:-GAN)?|VAE|GAN|MLP|CNN|Fourier)\b/gi, "model")
    .replace(/\bColab\b/gi, "training");
}
