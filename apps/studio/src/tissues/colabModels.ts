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
  {
    id: "spatial-v3-laparoscopic",
    label: "Spatial CVAE-GAN v3 · 6 Laparoscopic Organs (Real Data · Best)",
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
    recommended: true,
  },
  {
    id: "directional-v2-detail",
    label: "Directional Fourier CVAE-GAN v2 · Mucosa & Liver (128² Detail)",
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
    label: "Periodic Fourier CVAE v1 · Mucosa & Liver (Baseline)",
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
    label: "StableMaterials PBR · Liver Seed 43 (Refined 512²)",
    path: "tissue-models/liver-seed43-refined.tissue-pbr.json",
    organ: "liver",
    resolution: [512, 512],
    rank: 1,
  },
  {
    id: "lora-guided-liver-s1",
    label: "SD1.5 Tissue LoRA · Guided Liver Seed 1 (512²)",
    path: "tissue-materials/learned-guided-liver-s1/preview/liver-seed1.tissue-pbr.json",
    organ: "liver",
    resolution: [512, 512],
    rank: 2,
  },
  {
    id: "lora-guided-stomach-s1",
    label: "SD1.5 Tissue LoRA · Guided Stomach Seed 1 (512²)",
    path: "tissue-materials/learned-guided-stomach-s1/preview/stomach-seed1.tissue-pbr.json",
    organ: "stomach",
    resolution: [512, 512],
    rank: 1,
  },
  {
    id: "lora-guided-pancreas-s1",
    label: "SD1.5 Tissue LoRA · Guided Pancreas Seed 1 (512²)",
    path: "tissue-materials/learned-guided-pancreas-s1/preview/pancreas-seed1.tissue-pbr.json",
    organ: "pancreas",
    resolution: [512, 512],
    rank: 1,
  },
  {
    id: "lora-guided-small_bowel-s1",
    label: "SD1.5 Tissue LoRA · Guided Small Bowel Seed 1 (512²)",
    path: "tissue-materials/learned-guided-small_bowel-s1/preview/small_bowel-seed1.tissue-pbr.json",
    organ: "small_bowel",
    resolution: [512, 512],
    rank: 1,
  },
  {
    id: "lora-guided-large_bowel-s1",
    label: "SD1.5 Tissue LoRA · Guided Large Bowel Seed 1 (512²)",
    path: "tissue-materials/learned-guided-large_bowel-s1/preview/large_bowel-seed1.tissue-pbr.json",
    organ: "large_bowel",
    resolution: [512, 512],
    rank: 1,
  },
  {
    id: "lora-guided-spleen-s1",
    label: "SD1.5 Tissue LoRA · Guided Spleen Seed 1 (512²)",
    path: "tissue-materials/learned-guided-spleen-s1/preview/spleen-seed1.tissue-pbr.json",
    organ: "spleen",
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
  const matchingRegion = sorted.find(m => m.regions.includes(region));
  return matchingRegion ?? sorted[0];
}

export function selectBestColabPbrBundle(
  bundles: readonly ColabPbrBundleEntry[],
  organ: string,
): ColabPbrBundleEntry | undefined {
  if (!bundles.length) return undefined;
  const sorted = [...bundles].sort((a, b) => a.rank - b.rank);
  return sorted.find(b => b.organ === organ) ?? sorted[0];
}
