import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { appearanceLatent, bakeAppearanceRows, canonicalAppearanceSeed, decodeAppearance, parseAppearanceModel, sha256, validateBakeResolution, type AppearanceArtifact } from "./neuralAppearance";
import { bakeAppearanceInWorker } from "./neuralAppearanceClient";

const source = readFileSync(new URL("../../../../tests/fixtures/tissue-learning/fixture-trained.tissue-model.json", import.meta.url), "utf8");
const edited = (change: (artifact: AppearanceArtifact) => void) => { const artifact = JSON.parse(source) as AppearanceArtifact; change(artifact); return JSON.stringify(artifact); };

describe("portable learned RGB decoder", () => {
  it("matches actual PyTorch-trained fixture values and the max-uint64 latent", async () => {
    const model = await parseAppearanceModel(source);
    if (model.kind !== "fourier") throw new Error("Expected the v1 fixture decoder");
    const { reference, seed_reference } = model.artifact;
    expect(model.artifact.provenance.training_status).toBe("fixture_trained");
    const z = await appearanceLatent(seed_reference.seed, model.artifact.architecture.latent_dim);
    expect([...z]).toEqual(seed_reference.latent);
    for (let i = 0; i < reference.uv.length; i++) {
      const actual = decodeAppearance(model, reference.latent, reference.condition_index, reference.uv[i]![0]!, reference.uv[i]![1]!);
      actual.forEach((value, channel) => expect(value).toBeCloseTo(reference.rgb[i]![channel]!, 5));
    }
    expect(model.modelId).toBe(await sha256(new TextEncoder().encode(source)));
  });

  it("keeps both tile seams and seam derivatives continuous at nontrivial latents", async () => {
    const model = await parseAppearanceModel(source), z = await appearanceLatent("920481", 4);
    const rgb = (u: number, v: number) => decodeAppearance(model, z, 0, u, v);
    for (const axis of [0, 1]) for (const t of [.071, .39, .817]) {
      const sample = (s: number) => axis ? rgb(t, s) : rgb(s, t), epsilon = .0005;
      const first = sample(0), last = sample(1), low = sample(-epsilon), high = sample(epsilon), low1 = sample(1 - epsilon), high1 = sample(1 + epsilon);
      first.forEach((value, c) => {
        expect(Math.abs(value - last[c]!)).toBeLessThan(2e-6);
        expect(Math.abs((high[c]! - low[c]!) / (2 * epsilon) - (high1[c]! - low1[c]!) / (2 * epsilon))).toBeLessThan(.0002);
      });
    }
  });

  it("bakes reproducible row batches at pixel centers without changing the model", async () => {
    const model = await parseAppearanceModel(source), latent = await appearanceLatent("42", 4), before = model.layers.map(layer => [...layer.weights]);
    const all = new Uint8Array(16 * 16 * 4), split = new Uint8Array(all.length);
    validateBakeResolution(model, 16);
    bakeAppearanceRows(model, latent, 1, 16, 0, 16, all);
    bakeAppearanceRows(model, latent, 1, 16, 0, 7, split); bakeAppearanceRows(model, latent, 1, 16, 7, 16, split);
    expect(split).toEqual(all);
    expect([...all.slice(0, 3)]).toEqual([...decodeAppearance(model, latent, 1, .5 / 16, .5 / 16)].map(n => Math.round(n * 255)));
    expect([...all].filter((_, i) => i % 4 === 3).every(n => n === 255)).toBe(true);
    expect(model.layers.map(layer => [...layer.weights])).toEqual(before);
    expect(() => validateBakeResolution(model, 4096)).toThrow("browser bake");
    expect(() => bakeAppearanceRows(model, latent, 1, 16, 10, 2, all)).toThrow("row range");
  });

  it.each(["-1", "01", "1.5", "18446744073709551616", "1e3", "", " 42"])("rejects a noncanonical/out-of-range seed %j", seed => {
    expect(() => canonicalAppearanceSeed(seed)).toThrow("64-bit");
  });

  it("rejects altered weights before evaluating any reference", async () => {
    await expect(parseAppearanceModel(edited(model => { model.weights.data_base64 = (model.weights.data_base64[0] === "A" ? "B" : "A") + model.weights.data_base64.slice(1); }))).rejects.toThrow("checksum");
  });

  it("rejects aliasing tensors, unsupported operators, absent provenance and false PBR semantics", async () => {
    for (const mutate of [
      (a: AppearanceArtifact) => { a.weights.tensors[1]!.offset_bytes = 0; },
      (a: AppearanceArtifact) => { a.architecture.activation = "remote_custom_code"; },
      (a: AppearanceArtifact) => { a.provenance.training_steps = 0; },
      (a: AppearanceArtifact) => { a.output.pbr_ground_truth = true; },
      (a: AppearanceArtifact) => { a.architecture.condition_regions = []; },
      (a: AppearanceArtifact) => { a.seed_algorithm = "random"; },
    ]) await expect(parseAppearanceModel(edited(mutate))).rejects.toThrow();
  });

  it("rejects NaN tensors even when their payload digest is recomputed", async () => {
    const artifact = JSON.parse(source) as AppearanceArtifact, bytes = Uint8Array.from(atob(artifact.weights.data_base64), c => c.charCodeAt(0));
    new DataView(bytes.buffer).setFloat32(0, NaN, true);
    artifact.weights.sha256 = await sha256(bytes); artifact.weights.data_base64 = btoa(String.fromCharCode(...bytes));
    await expect(parseAppearanceModel(JSON.stringify(artifact))).rejects.toThrow("non-finite");
  });

  it("rejects a decoder/seed reference mismatch and distinguishes vocabulary identity", async () => {
    await expect(parseAppearanceModel(edited(a => { a.reference.rgb[1]![0] = .1; }))).rejects.toThrow("parity");
    await expect(parseAppearanceModel(edited(a => { a.seed_reference.latent[0] = 0; }))).rejects.toThrow("seed check");
    const initial = await parseAppearanceModel(source), relabelled = await parseAppearanceModel(edited(a => { a.architecture.condition_labels[0] = "synthetic:renamed"; }));
    expect(initial.modelId).not.toBe(relabelled.modelId);
  });
});

function mockWorker() {
  return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null, onmessageerror: null as (() => void) | null };
}
describe("appearance worker ownership", () => {
  it("terminates after successful output and reports bounded progress", async () => {
    const worker = mockWorker(), progress = vi.fn(), controller = new AbortController();
    const promise = bakeAppearanceInWorker("fixture", 0, "42", 16, controller.signal, progress, () => worker as unknown as Worker);
    worker.onmessage!({ data: { type: "progress", fraction: .5 } } as MessageEvent);
    worker.onmessage!({ data: { type: "complete", rgba: new ArrayBuffer(16 * 16 * 4), resolution: 16, durationMs: 30, modelId: "a".repeat(64) } } as MessageEvent);
    expect((await promise).rgba.length).toBe(1024); expect(progress).toHaveBeenCalledWith(.5); expect(worker.terminate).toHaveBeenCalledTimes(1);
    controller.abort(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("aborts pending work and ignores late success", async () => {
    const worker = mockWorker(), controller = new AbortController();
    const promise = bakeAppearanceInWorker("fixture", 0, "42", 16, controller.signal, vi.fn(), () => worker as unknown as Worker);
    controller.abort(); await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    worker.onmessage!({ data: { type: "complete" } } as MessageEvent); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("does not start work after cancellation or on invalid seeds", async () => {
    const controller = new AbortController(), factory = vi.fn(); controller.abort();
    await expect(bakeAppearanceInWorker("fixture", 0, "42", 16, controller.signal, vi.fn(), factory)).rejects.toMatchObject({ name: "AbortError" });
    await expect(bakeAppearanceInWorker("fixture", 0, "18446744073709551616", 16, new AbortController().signal, vi.fn(), factory)).rejects.toThrow("64-bit");
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(["error", "corrupt", "crash", "clone"])("releases worker on %s", async kind => {
    const worker = mockWorker();
    const promise = bakeAppearanceInWorker("fixture", 0, "42", 16, new AbortController().signal, vi.fn(), () => worker as unknown as Worker);
    if (kind === "error") worker.onmessage!({ data: { type: "error", message: "bad model" } } as MessageEvent);
    else if (kind === "crash") worker.onerror!({ message: "worker crashed" } as ErrorEvent);
    else if (kind === "clone") worker.onmessageerror!();
    else worker.onmessage!({ data: { type: "complete", rgba: new ArrayBuffer(1) } } as MessageEvent);
    await expect(promise).rejects.toThrow(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
