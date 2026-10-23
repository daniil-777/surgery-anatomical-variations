import { canonicalAppearanceSeed, MAX_BAKE_RESOLUTION } from "./neuralAppearance";

export interface AppearanceBake { rgba: Uint8Array; resolution: number; durationMs: number; modelId: string }
/** Each job owns one worker. Abort, success and errors all terminate it. */
export async function bakeAppearanceInWorker(source: string, condition: number, seed: string, resolution: number, signal: AbortSignal, progress: (fraction: number) => void, createWorker = () => new Worker(new URL("./neuralAppearance.worker.ts", import.meta.url), { type: "module" })): Promise<AppearanceBake> {
  canonicalAppearanceSeed(seed);
  if (!Number.isInteger(resolution) || resolution < 16 || resolution > MAX_BAKE_RESOLUTION || !Number.isInteger(condition) || condition < 0) return Promise.reject(new Error("Invalid appearance bake request"));
  if (signal.aborted) return Promise.reject(new DOMException("Appearance bake cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let done = false;
    const finish = (result?: AppearanceBake, error?: unknown) => {
      if (done) return;
      done = true; signal.removeEventListener("abort", abort); worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(undefined, new DOMException("Appearance bake cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = event => finish(undefined, new Error(event.message || "Appearance worker failed"));
    worker.onmessageerror = () => finish(undefined, new Error("Appearance worker message failed"));
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (done) return;
      if (message?.type === "progress" && Number.isFinite(message.fraction) && message.fraction >= 0 && message.fraction <= 1) progress(message.fraction);
      else if (message?.type === "error") finish(undefined, new Error(String(message.message)));
      else if (message?.type === "complete") {
        if (!(message.rgba instanceof ArrayBuffer) || message.rgba.byteLength !== resolution * resolution * 4 || message.resolution !== resolution
          || !Number.isFinite(message.durationMs) || message.durationMs < 0 || !/^[a-f0-9]{64}$/.test(message.modelId)) {
          finish(undefined, new Error("Invalid appearance worker result")); return;
        }
        finish({ rgba: new Uint8Array(message.rgba), resolution, durationMs: message.durationMs, modelId: message.modelId });
      } else finish(undefined, new Error("Unknown appearance worker message"));
    };
    try { worker.postMessage({ source, condition, seed, resolution }); } catch (error) { finish(undefined, error); }
  });
}
