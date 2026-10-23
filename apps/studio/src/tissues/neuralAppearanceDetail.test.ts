import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appearanceLatent, bakeAppearanceRows, decodeAppearance, DIRECTIONAL_APPEARANCE_SCHEMA,
  parseAppearanceModel, validateBakeResolution, type AppearanceArtifact } from "./neuralAppearance";

// Three actual CPU updates on synthetic inputs. This fixture proves the export
// contract, never the quality of a trained real-data appearance model.
const source = readFileSync(new URL("../../../../tests/fixtures/tissue-learning-detail/fixture-trained.tissue-model.json", import.meta.url), "utf8");
const edited = (change: (artifact: AppearanceArtifact) => void) => {
  const artifact = JSON.parse(source) as AppearanceArtifact; change(artifact); return JSON.stringify(artifact);
};

describe("directional appearance v2 import", () => {
  it("matches actual trained Torch references and the portable max-uint64 latent", async () => {
    const model = await parseAppearanceModel(source);
    if (model.kind !== "fourier") throw new Error("Expected the v2 fixture decoder");
    const { reference, seed_reference } = model.artifact;
    expect(model.modelId).toBe("64ab4393549e8a8741bcf6277b6905622b712db08fa2aaf4227ed8a99bc68b6a");
    expect(model.artifact.schema).toBe(DIRECTIONAL_APPEARANCE_SCHEMA);
    expect(model.artifact.provenance).toMatchObject({ training_steps: 3, training_status: "fixture_trained", critic_exported: false });
    expect(model.encoding.kind).toBe("directional");
    expect(model.layers).toHaveLength(4);
    expect([...await appearanceLatent(seed_reference.seed, 64)]).toEqual(seed_reference.latent);
    for (const [i, uv] of reference.uv.entries()) {
      const result = decodeAppearance(model, reference.latent, reference.condition_index, uv[0]!, uv[1]!);
      result.forEach((value, c) => expect(Math.abs(value - reference.rgb[i]![c]!)).toBeLessThan(2e-5));
    }
  });

  it("retains integer-periodic values and derivatives across both tile seams", async () => {
    const model = await parseAppearanceModel(source), latent = await appearanceLatent("43", 64);
    for (const condition of [0, 1]) for (const axis of [0, 1]) for (const t of [.071, .39, .817]) {
      const sample = (s: number) => decodeAppearance(model, latent, condition, axis ? t : s, axis ? s : t);
      const epsilon = .0005, first = sample(0), last = sample(1);
      const a = sample(-epsilon), b = sample(epsilon), c = sample(1 - epsilon), d = sample(1 + epsilon);
      first.forEach((value, channel) => {
        expect(Math.abs(value - last[channel]!)).toBeLessThan(2e-6);
        expect(Math.abs((b[channel]! - a[channel]!) - (d[channel]! - c[channel]!)) / (2 * epsilon)).toBeLessThan(.002);
      });
    }
  });

  it("bakes both regions deterministically in arbitrary row batches with distinct seeds", async () => {
    const model = await parseAppearanceModel(source);
    validateBakeResolution(model, 256);
    expect(() => validateBakeResolution(model, 512)).toThrow("too large");
    for (const condition of [0, 1]) {
      const z = await appearanceLatent("42", 64), other = await appearanceLatent("43", 64);
      const first = new Uint8Array(16 * 16 * 4), split = new Uint8Array(first.length), changed = new Uint8Array(first.length);
      bakeAppearanceRows(model, z, condition, 16, 0, 16, first);
      bakeAppearanceRows(model, z, condition, 16, 0, 5, split);
      bakeAppearanceRows(model, z, condition, 16, 5, 16, split);
      bakeAppearanceRows(model, other, condition, 16, 0, 16, changed);
      expect(split).toEqual(first); expect(changed).not.toEqual(first);
      expect([...first].filter((_, index) => index % 4 === 3).every(value => value === 255)).toBe(true);
    }
  });

  it.each([
    [], [[0, 0]], [[1.5, 2]], [[33, 0]], [[1, -1]], [[-1, 0]], [[2, 1], [2, 1]],
    [[2]], [[2, 1, 0]], [[null, 1]], Array.from({ length: 33 }, (_, index) => [index - 16, 1]),
  ].map(vectors => ({ vectors })))("rejects noncanonical or excessive directional vectors $vectors", async ({ vectors }) => {
    await expect(parseAppearanceModel(edited(a => { a.architecture.fourier_vectors = vectors as [number, number][]; }))).rejects.toThrow("Fourier");
  });

  it("rejects ambiguous versions, incorrect packing, unsupported semantics and exported critics", async () => {
    for (const change of [
      (a: AppearanceArtifact) => { a.schema = "viscera.tissue-appearance-decoder/v1"; },
      (a: AppearanceArtifact) => { a.model_type = "masked-rgb-periodic-cvae-v1"; },
      (a: AppearanceArtifact) => { a.architecture.frequencies = [1, 2, 4]; },
      (a: AppearanceArtifact) => { a.architecture.fourier_order = "cos,sin"; },
      (a: AppearanceArtifact) => { a.output.clinically_validated = true; },
      (a: AppearanceArtifact) => { a.provenance.critic_exported = true; },
      (a: AppearanceArtifact) => { a.provenance.training_source_crop_size = 512; },
      (a: AppearanceArtifact) => { a.weights.tensors[0]!.shape[1]! -= 1; },
      (a: AppearanceArtifact) => { a.reference.rgb[0]![0] = .01; },
    ]) await expect(parseAppearanceModel(edited(change))).rejects.toThrow();
  });
});
