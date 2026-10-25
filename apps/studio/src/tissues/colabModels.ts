import { MODEL_NAMES } from "../modelNames";
import { publicUrl } from "../api";

export interface ColabAppearanceModelEntry {
  id: string;
  label: string;
  path: string;
  schema: string;
  model_type: string;
  training_status: string;
  training_steps: number;
  patch_size: number;
  regions: string[];
  conditions: string[];
  rank: number;
  recommended?: boolean;
  sha256?: string;
  bytes?: number;
}

export interface ColabPbrBundleEntry {
  id: string;
  label: string;
  path: string;
  organ: string;
  resolution: [number, number];
  rank: number;
  sha256?: string;
  bytes?: number;
}

export interface TissueColabCatalog {
  schema: "viscera.tissue-colab-catalog/v1";
  best_appearance_model_id: string;
  appearance_models: ColabAppearanceModelEntry[];
  pbr_bundles: ColabPbrBundleEntry[];
}

export const DEFAULT_COLAB_APPEARANCE_MODELS: readonly ColabAppearanceModelEntry[] = [
  ...["liver", "spleen", "stomach", "small_bowel", "large_bowel", "pancreas"].map(region => ({
    id: `exemplar-${region}`, label: MODEL_NAMES.exemplar, path: `tissue-models/exemplar-${region}.tissue-model.json`,
    schema: "viscera.tissue-exemplar/v1", model_type: "pca-histogram-preserving-exemplar", training_status: "exemplar_fitted",
    training_steps: 0, patch_size: 512, regions: [region], conditions: [`human:laparoscopic_exterior:${region}`], rank: 0, recommended: true,
  })),
  {
    id: "spatial-v3-laparoscopic",
    label: MODEL_NAMES.appearance3,
    path: "tissue-models/spatial-v3-laparoscopic.tissue-model.json",
    schema: "viscera.tissue-appearance-decoder/v3",
    model_type: "masked-rgb-spatial-cvae-gan-v1",
    training_status: "research_trained",
    training_steps: 3,
    patch_size: 128,
    regions: ["large_bowel", "liver", "pancreas", "small_bowel", "spleen", "stomach"],
    conditions: [
      "human:laparoscopic_exterior:colon",
      "human:laparoscopic_exterior:liver",
      "human:laparoscopic_exterior:pancreas",
      "human:laparoscopic_exterior:small_intestine",
      "human:laparoscopic_exterior:spleen",
      "human:laparoscopic_exterior:stomach",
    ],
    rank: 1,
    recommended: false,
  },
  {
    id: "directional-v2-detail",
    label: MODEL_NAMES.appearance2,
    path: "tissue-models/directional-v2-detail.tissue-model.json",
    schema: "viscera.tissue-appearance-decoder/v2",
    model_type: "masked-rgb-directional-cvae-gan-v1",
    training_status: "fixture_trained",
    training_steps: 3,
    patch_size: 128,
    regions: ["colonic_mucosa", "liver"],
    conditions: ["synthetic:colonic_mucosa", "synthetic:liver"],
    rank: 2,
    recommended: false,
  },
  {
    id: "periodic-v1-baseline",
    label: MODEL_NAMES.appearance1,
    path: "tissue-models/periodic-v1-baseline.tissue-model.json",
    schema: "viscera.tissue-appearance-decoder/v1",
    model_type: "masked-rgb-periodic-cvae-v1",
    training_status: "fixture_trained",
    training_steps: 4,
    patch_size: 16,
    regions: ["colonic_mucosa", "liver"],
    conditions: ["synthetic:colonic_mucosa", "synthetic:liver"],
    rank: 3,
    recommended: false,
  },
];

export const DEFAULT_COLAB_PBR_BUNDLES: readonly ColabPbrBundleEntry[] = [
  {
    id: "stablematerials-liver43-refined",
    label: `${MODEL_NAMES.pbr} · Liver · 512 × 512`,
    path: "tissue-models/liver-seed43-refined.tissue-pbr.json",
    organ: "liver",
    resolution: [512, 512],
    rank: 1,
  },

];

export async function discoverColabCatalog(signal?: AbortSignal): Promise<TissueColabCatalog> {
  try {
    const response = await fetch(publicUrl("tissue-models/catalog.json"), {
      ...(signal ? { signal } : {}),
      cache: "no-store",
    });
    if (response.ok) {
      const data = (await response.json()) as Partial<TissueColabCatalog>;
      if (data && data.schema === "viscera.tissue-colab-catalog/v1" && Array.isArray(data.appearance_models) && data.appearance_models.length > 0) {
        return {
          schema: "viscera.tissue-colab-catalog/v1",
          best_appearance_model_id: data.best_appearance_model_id ?? data.appearance_models[0]!.id,
          appearance_models: [...data.appearance_models].sort((a, b) => a.rank - b.rank),
          pbr_bundles: Array.isArray(data.pbr_bundles) ? [...data.pbr_bundles].sort((a, b) => a.rank - b.rank) : [...DEFAULT_COLAB_PBR_BUNDLES],
        };
      }
    }
  } catch {
    // Fall back to built-in catalog metadata
  }
  return {
    schema: "viscera.tissue-colab-catalog/v1",
    best_appearance_model_id: DEFAULT_COLAB_APPEARANCE_MODELS[0]!.id,
    appearance_models: [...DEFAULT_COLAB_APPEARANCE_MODELS],
    pbr_bundles: [...DEFAULT_COLAB_PBR_BUNDLES],
  };
}

export function selectBestColabAppearanceModel(
  models: readonly ColabAppearanceModelEntry[],
  region: string,
  preferredId?: string,
): ColabAppearanceModelEntry | undefined {
  if (!models.length) return undefined;
  if (preferredId) {
    const explicit = models.find(m => m.id === preferredId);
    if (explicit) return explicit;
  }
  const sorted = [...models].sort((a, b) => a.rank - b.rank);
  return sorted.find(m => m.recommended === true && m.regions.includes(region));
}

export function selectBestColabPbrBundle(
  bundles: readonly ColabPbrBundleEntry[],
  organ: string,
): ColabPbrBundleEntry | undefined {
  if (!bundles.length) return undefined;
  const sorted = [...bundles].sort((a, b) => a.rank - b.rank);
  return sorted.find(b => b.organ === organ);
}
