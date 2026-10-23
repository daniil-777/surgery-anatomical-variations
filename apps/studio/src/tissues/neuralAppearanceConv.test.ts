import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appearanceLatent, bakeAppearanceRows, decodeAppearance, parseAppearanceModel, sha256, validateBakeResolution } from "./neuralAppearance";
import { createSpatialSampler, decodeSpatialNative, MAX_SPATIAL_MACS, type SpatialAppearanceArtifact, type SpatialAppearanceModel } from "./neuralAppearanceConv";

// Actual native-data three-update CPU proof, not the completed cloud model or a quality fixture.
const source = readFileSync(new URL("../../../../tests/fixtures/tissue-learning-conv/real-native-three-step.tissue-model.json", import.meta.url), "utf8");
const edited = (change: (value: SpatialAppearanceArtifact) => void) => { const value = JSON.parse(source) as SpatialAppearanceArtifact; change(value); return JSON.stringify(value); };
const actual = async () => { const model = await parseAppearanceModel(source); if (model.kind !== "spatial") throw new Error("Expected spatial decoder"); return model; };

/** Independent sparse operator oracle: hidden layers copy channel0 at the center,
 * while final R/G/B sample upper-left/center/lower-right. This detects kernel flips,
 * CHW/HWC transposes, circular padding and nearest-repeat boundary errors. */
function sparseModel() {
  const artifact = JSON.parse(source) as SpatialAppearanceArtifact;
  Object.assign(artifact.architecture, { latent_shape: [2, 8, 8], latent_dim: 128, decoder_channels: [4, 4, 4, 4, 4], condition_labels: ["a", "b"], condition_regions: ["liver", "liver"], condition_species: ["synthetic", "synthetic"] });
  const layers = Array.from({ length: 10 }, (_, i) => {
    const outputs = i === 9 ? 3 : 4, weights = new Float32Array(outputs * 4 * 9), bias = new Float32Array(outputs);
    if (i === 9) for (let c = 0; c < 3; c++) weights[c * 4 * 9 + c * 4] = .1;
    else { weights[4] = 1; bias[0] = 1; }
    if (i === 0) weights[3 * 9 + 4] = 2;
    return { inputs: 4, outputs, weights, bias };
  });
  const model: SpatialAppearanceModel = { kind: "spatial", encoding: { kind: "spatial" }, artifact, layers, nativeMacs: 1, modelId: "sparse-operator-test" };
  const latent = Float32Array.from({ length: 128 }, (_, i) => i < 64 ? i / 64 : 0);
  const expected = (x: number, y: number, condition: number) => {
    let value = latent[Math.floor(((y + 128) % 128) / 16) * 8 + Math.floor(((x + 128) % 128) / 16)]!;
    for (let i = 0; i < 9; i++) { value = Math.fround(value + 1 + (i === 0 ? condition * 2 : 0)); value = Math.fround(value / (1 + Math.exp(-value))); }
    return Math.fround(1 / (1 + Math.exp(-Math.fround(value * Math.fround(.1)))));
  };
  return { model, latent, expected };
}

describe("spatial native128 appearance v3", () => {
  it("matches actual trained native Torch pixels and the512-value max-uint64 seed", async () => {
    const model = await actual(), { reference, seed_reference } = model.artifact;
    expect(model.modelId).toBe("4ee421462d413b6f5983e13440d36461e18fe6e6e40ad4a2e25abb4d0fdca64d");
    expect(model.layers).toHaveLength(10); expect(model.nativeMacs).toBeLessThan(MAX_SPATIAL_MACS);
    expect(model.artifact.provenance).toMatchObject({ training_steps: 3, training_status: "research_trained", native_decode_resolution: [128, 128] });
    expect([...await appearanceLatent(seed_reference.seed, 512)]).toEqual(seed_reference.latent);
    const native = decodeSpatialNative(model, reference.latent, reference.condition_index);
    reference.pixels_xy.forEach(([x, y], i) => reference.rgb[i]!.forEach((value, c) => expect(Math.abs(native[(y! * 128 + x!) * 3 + c]! - value)).toBeLessThan(3e-5)));
  });

  it("executes cross-correlation/OIHW with circular padding and nearest repeat rather than flipping/transposing kernels", () => {
    const { model, latent, expected } = sparseModel();
    for (const condition of [0, 1]) {
      const native = decodeSpatialNative(model, latent, condition);
      for (const [x, y] of [[0, 0], [127, 0], [0, 127], [127, 127], [15, 16], [16, 15], [65, 31]]) {
        for (let c = 0; c < 3; c++) expect(native[(y! * 128 + x!) * 3 + c]!).toBeCloseTo(expected(x! + c - 1, y! + c - 1, condition), 7);
      }
    }
  });

  it("samples exact native pixel centers and periodic bilinear borders without inventing new inferred detail", () => {
    const { model, latent } = sparseModel(), native = decodeSpatialNative(model, latent, 0), sample = createSpatialSampler(model, latent, 0);
    for (const [x, y] of [[0, 0], [127, 127], [16, 15], [33, 97]]) expect([...sample((x! + .5) / 128, (y! + .5) / 128)]).toEqual([...native.slice((y! * 128 + x!) * 3, (y! * 128 + x! + 1) * 3)]);
    const corner = [...sample(0, 0)]; expect([...sample(1, 1)]).toEqual(corner);
    for (let c = 0; c < 3; c++) {
      const average = (native[c]! + native[127 * 3 + c]! + native[(127 * 128) * 3 + c]! + native[(128 * 128 - 1) * 3 + c]!) / 4;
      expect(corner[c]!).toBeCloseTo(average, 7);
    }
    expect([...sample(-.25, .75)]).toEqual([...sample(.75, -.25)]);
    for (const uv of [[NaN, 0], [0, Infinity], [3, 0]]) expect(() => sample(uv[0]!, uv[1]!)).toThrow("input");
  });

  it("reuses one native decode across row batches and invalidates changed latents or condition", () => {
    const { model, latent } = sparseModel(), first = decodeSpatialNative(model, latent, 0), layers = model.layers;
    first[0] = 0; expect(decodeSpatialNative(model, latent, 0)[0]).not.toBe(0);
    let layerReads = 0; Object.defineProperty(model, "layers", { get: () => { layerReads++; return layers; } });
    const all = new Uint8Array(256 * 256 * 4), split = new Uint8Array(all.length);
    bakeAppearanceRows(model, latent, 0, 256, 0, 256, all);
    for (let row = 0; row < 256; row += 4) bakeAppearanceRows(model, latent, 0, 256, row, row + 4, split);
    expect(layerReads).toBe(0); expect(split).toEqual(all);
    const original = decodeSpatialNative(model, latent, 0); latent[0]! += .5;
    expect(decodeSpatialNative(model, latent, 0)).not.toEqual(original); expect(layerReads).toBeGreaterThan(0);
    expect(decodeSpatialNative(model, latent, 1)).not.toEqual(decodeSpatialNative(model, latent, 0));
    expect([...all].filter((_, i) => i % 4 === 3).every(value => value === 255)).toBe(true);
    validateBakeResolution(model, 512); expect(() => validateBakeResolution(model, 1024)).toThrow("browser bake");
  });

  it("preserves native periodic values through the generic decoder entry point", async () => {
    const model = await actual(), latent = await appearanceLatent("42", 512);
    const a = decodeAppearance(model, latent, 1, 0, .31), b = decodeAppearance(model, latent, 1, 1, .31);
    expect(a).toEqual(b); expect(decodeAppearance(model, await appearanceLatent("43", 512), 1, 0, .31)).not.toEqual(a);
  });

  it.each([
    ["padding", "zeros"], ["weight_layout", "HWIO"], ["upsample", "bilinear"], ["output_sampling", "nearest"],
    ["latent_shape", [8, 4, 4]], ["latent_dim", 64], ["native_resolution", [256, 256]], ["upsample_before_layers", [0, 2, 4, 6]],
    ["decoder_channels", [64, 48, 32, 16]], ["kernel_size", 5], ["input_order", "uv_fourier"],
  ])("rejects unsupported spatial operator %s", async (key, value) => {
    await expect(parseAppearanceModel(edited(a => { (a.architecture as unknown as Record<string, unknown>)[key as string] = value; }))).rejects.toThrow();
  });

  it("rejects an excessive native workload before attempting to decode its incompatible tensors", async () => {
    await expect(parseAppearanceModel(edited(a => { a.architecture.decoder_channels = [128, 128, 128, 128, 128]; }))).rejects.toThrow("inference budget");
  });

  it("rejects ambiguous versions, corrupted layouts, missing provenance and incorrect native references", async () => {
    for (const mutate of [
      (a: SpatialAppearanceArtifact) => { a.schema = "viscera.tissue-appearance-decoder/v2"; },
      (a: SpatialAppearanceArtifact) => { (a.architecture as unknown as Record<string, unknown>).fourier_vectors = [[1, 0]]; },
      (a: SpatialAppearanceArtifact) => { a.weights.tensors.reverse(); },
      (a: SpatialAppearanceArtifact) => { a.weights.tensors[0]!.shape = [64, 14, 9, 1]; },
      (a: SpatialAppearanceArtifact) => { a.weights.tensors[1]!.offset_bytes = 0; },
      (a: SpatialAppearanceArtifact) => { a.reference.pixels_xy[0] = [128, 0]; },
      (a: SpatialAppearanceArtifact) => { a.reference.rgb[0]![0] = .01; },
      (a: SpatialAppearanceArtifact) => { a.seed_reference.latent[511] = 0; },
      (a: SpatialAppearanceArtifact) => { a.provenance.critic_exported = true; },
      (a: SpatialAppearanceArtifact) => { a.output.native_resolution = [256, 256]; },
      (a: SpatialAppearanceArtifact) => { a.output.pbr_ground_truth = true; },
    ]) await expect(parseAppearanceModel(edited(mutate))).rejects.toThrow();
  });

  it("rejects nonfinite weights even with a matching payload hash", async () => {
    const artifact = JSON.parse(source) as SpatialAppearanceArtifact, bytes = Uint8Array.from(atob(artifact.weights.data_base64), c => c.charCodeAt(0));
    new DataView(bytes.buffer).setFloat32(0, NaN, true); artifact.weights.sha256 = await sha256(bytes);
    artifact.weights.data_base64 = Buffer.from(bytes).toString("base64");
    await expect(parseAppearanceModel(JSON.stringify(artifact))).rejects.toThrow("non-finite");
  });
});
