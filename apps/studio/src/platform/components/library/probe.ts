// What the browser can tell about a file before it is uploaded, and the thumbnail the grid shows for it: images are
// decoded and scaled to a 512 px WebP; videos are opened off screen for their size and true duration and give a poster
// frame; GLB models are measured and rendered by media/modelProbe (three.js, loaded only when a model is uploaded).
import { PlatformError } from "../../core/types";
import type { ProbeFn, ProbeResult } from "./upload";

export const THUMBNAIL_EDGE = 512;

function cancelled(): PlatformError {
  return new PlatformError("aborted", "Cancelled.");
}

function scaledSize(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  // WebP where the browser encodes it; Safari before 17 hands back PNG for an unknown type, which is fine too
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/webp", 0.85));
}

function drawScaled(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement | null {
  const size = scaledSize(width, height, THUMBNAIL_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
}

export async function probeImage(file: Blob): Promise<ProbeResult> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = drawScaled(bitmap, bitmap.width, bitmap.height);
    return { thumbnail: canvas ? await encode(canvas) : null, media: { width: bitmap.width, height: bitmap.height } };
  } finally {
    bitmap.close();
  }
}

function once(target: EventTarget, events: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      for (const name of events) target.removeEventListener(name, onEvent);
    };
    const onEvent = (event: Event) => {
      cleanup();
      if (event.type === "error") reject(new Error("The video could not be decoded."));
      else resolve(event.type);
    };
    const onAbort = () => {
      cleanup();
      reject(cancelled());
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("The video took too long to open."));
    }, timeoutMs);
    signal.addEventListener("abort", onAbort);
    for (const name of events) target.addEventListener(name, onEvent);
  });
}

export async function probeVideo(file: Blob, signal: AbortSignal): Promise<ProbeResult> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const loaded = once(video, ["loadedmetadata", "error"], signal, 15_000);
    video.src = url;
    await loaded;
    // MediaRecorder WebM files declare no duration: seeking far past the end makes the browser find it
    if (video.duration === Number.POSITIVE_INFINITY || Number.isNaN(video.duration)) {
      const found = once(video, ["durationchange", "seeked", "error"], signal, 15_000);
      video.currentTime = 1e101;
      await found;
    }
    const durationMs = Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : undefined;
    const width = video.videoWidth;
    const height = video.videoHeight;
    let thumbnail: Blob | null = null;
    if (width > 0 && height > 0) {
      // a frame a little way in: the first frame of a recording is often black
      const at = durationMs === undefined ? 0 : Math.min(1, (durationMs / 1000) * 0.1);
      const seeked = once(video, ["seeked", "error"], signal, 15_000);
      video.currentTime = at;
      await seeked;
      if (video.readyState < 2) await once(video, ["loadeddata", "canplay", "error"], signal, 15_000);
      const canvas = drawScaled(video, width, height);
      thumbnail = canvas ? await encode(canvas) : null;
    }
    return { thumbnail, media: { width, height, durationMs } };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function probeModelFile(file: Blob, signal: AbortSignal): Promise<ProbeResult> {
  const { probeModel } = await import("../media/modelProbe");
  if (signal.aborted) throw cancelled();
  const result = await probeModel(file, signal);
  return {
    thumbnail: result.thumbnail,
    media: { vertices: result.vertices, triangles: result.triangles, meshes: result.meshes, generator: result.generator ?? undefined },
  };
}

/** The probe the Library uses for uploads (see upload.ts). */
export const probeUpload: ProbeFn = async (file, plan, signal) => {
  if (signal.aborted) throw cancelled();
  switch (plan.kind) {
    case "image":
      return probeImage(file);
    case "recording":
      return probeVideo(file, signal);
    case "model":
      return probeModelFile(file, signal);
  }
};
