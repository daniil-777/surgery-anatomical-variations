import { describe, expect, it } from "vitest";
import { appearanceModelLabel, jointModelName, MODEL_NAMES, modelLaneDisplay, modelMessage, pbrModelLabel } from "./modelNames";

describe("model presentation contract", () => {
  it("keeps numbered families unique across joint and appearance model versions", () => {
    expect(new Set(Object.values(MODEL_NAMES)).size).toBe(12);
    expect(jointModelName(1)).toBe("Generative Model 1");
    expect(jointModelName(2)).toBe("Generative Model 2");
    expect(appearanceModelLabel({ id: "spatial-v3-laparoscopic" })).toBe("Generative Model 8");
    expect(appearanceModelLabel({ id: "directional-v2-detail" })).toBe("Generative Model 9");
    expect(appearanceModelLabel({ id: "periodic-v1-baseline" })).toBe("Generative Model 10");
  });
  it("does not turn unrecognized catalog identifiers into visible model names", () => {
    for (const id of ["PrivateProvider-FutureArchitecture", "constructor", "__proto__"]) {
      expect(appearanceModelLabel({ id })).toBe("Imported generative model");
      expect(modelLaneDisplay(id, undefined, 1).label).toBe("Additional model");
    }
    expect(pbrModelLabel({ id: "unknown-name", organ: "liver", resolution: [512, 512] }))
      .toBe("Imported generative model · liver · 512 × 512");
  });
  it("does not echo backend architecture metadata in lane descriptions", () => {
    expect(modelLaneDisplay("joint", "private_architecture", 2).label).toBe("Generative Model 2");
    expect(modelLaneDisplay("wording", "Qwen2.5_LoRA_semantic_plans", 1).label).toBe("Generative Model 6");
    expect(modelLaneDisplay("wording", "built_in_semantic_plans", 1).label).toBe("Built-in text interpreter");
    expect(JSON.stringify(modelLaneDisplay("PrivateArchitecture", "PrivateModel", 1))).not.toContain("Private");
  });
  it.each([
    "Joint Flow v2 weights unavailable: HTTP 503",
    "The joint VAE result does not match the requested organ",
    "Spatial CVAE-GAN v3 · Directional Fourier CVAE-GAN v2 · Periodic Fourier CVAE v1",
    "Qwen/Qwen2.5-0.5B-Instruct · Qwen2.5_LoRA_semantic_plans",
    "StableMaterials PBR · SD1.5 Tissue LoRA · research LoRA · conditional_vae",
  ])("removes model identities from diagnostics: %s", message => {
    const visible = modelMessage(message);
    expect(visible).not.toMatch(/\b(?:Qwen|LoRA|StableMaterials|SD1\.5|CVAE|VAE|GAN|Fourier)\b|Joint Flow/i);
    if (message.includes("503")) expect(visible).toContain("503");
  });
  it("preserves user guidance, biological terms and source-license evidence", () => {
    const text = "Blood flow · tissue diffusion · Liver · CC BY 4.0 · HTTP 503 · seed 42";
    expect(modelMessage(text)).toBe(text);
  });
});
