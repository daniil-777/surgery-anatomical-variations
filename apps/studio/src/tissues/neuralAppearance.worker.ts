/// <reference lib="webworker" />
import { appearanceLatent, bakeAppearanceRows, parseAppearanceModel, validateBakeResolution } from "./neuralAppearance";

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async (event: MessageEvent<{ source: string; condition: number; seed: string; resolution: number }>) => {
  try {
    const { source, condition, seed, resolution } = event.data;
    const started = performance.now(), model = await parseAppearanceModel(source);
    validateBakeResolution(model, resolution);
    const latent = await appearanceLatent(seed, model.artifact.architecture.latent_dim), rgba = new Uint8Array(resolution * resolution * 4);
    for (let row = 0; row < resolution; row += 4) {
      bakeAppearanceRows(model, latent, condition, resolution, row, Math.min(row + 4, resolution), rgba);
      worker.postMessage({ type: "progress", fraction: Math.min(row + 4, resolution) / resolution });
    }
    worker.postMessage({ type: "complete", rgba: rgba.buffer, resolution, durationMs: performance.now() - started, modelId: model.modelId }, [rgba.buffer]);
  } catch (error) { worker.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
};
