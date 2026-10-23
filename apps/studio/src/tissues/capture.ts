import * as THREE from "three";

export interface TissueVideoResult { blob: Blob; metrics: { width: number; height: number; durationSeconds: number; renderedFrames: number; medianFrameMs: number; p95FrameMs: number; mimeType: string; requestedFps: number; materialSnapshot?: Record<string, unknown> } }
export interface TissueViewportHandle { capture: (width?: number, height?: number, time?: number) => string; record: (seconds?: number, preferredMimeType?: string) => Promise<TissueVideoResult> }

export function validateCapture(width: number, height: number, time: number) {
  if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 8192) || width * height > 33_554_432 || !Number.isFinite(time)) throw new Error("Invalid capture dimensions or time");
}

/** Draw-buffer transactions always restore the interactive viewport, including encoder failures. */
export function createCapture(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, draw: (time: number) => void, time: () => number, canRecord: () => boolean) {
  let recording = false, disposed = false, recorder: MediaRecorder | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const timings: number[] = [];
  function resize(width: number, height: number) {
    const size = renderer.getSize(new THREE.Vector2()), ratio = renderer.getPixelRatio(), aspect = camera.aspect;
    const restore = () => {
      if (disposed) return;
      renderer.setPixelRatio(ratio); renderer.setSize(size.x, size.y, false);
      camera.aspect = aspect; camera.updateProjectionMatrix(); draw(time());
    };
    try { renderer.setPixelRatio(1); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); }
    catch (error) { restore(); throw error; }
    return restore;
  }
  const capture: TissueViewportHandle["capture"] = (width = 3840, height = 2160, at = time()) => {
    validateCapture(width, height, at);
    if (recording || disposed) throw new Error("Capture unavailable during recording or after disposal");
    const restore = resize(width, height);
    try { draw(at); return renderer.domElement.toDataURL("image/png"); } finally { restore(); }
  };
  const record: TissueViewportHandle["record"] = async (seconds = 5, preferredMimeType) => {
    if (recording || disposed || !Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw new Error("Recording must be 1–30 seconds and cannot overlap");
    if (!canRecord()) throw new Error("Choose a mucosa walkthrough or atlas exterior before recording");
    const mimeType = (preferredMimeType ? [preferredMimeType] : ["video/mp4;codecs=avc1.640033", "video/webm;codecs=vp9", "video/webm"]).find(type => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This browser does not support the requested video codec");
    const restore = resize(3840, 2160), start = performance.now();
    let stream: MediaStream | undefined;
    recording = true; timings.length = 0;
    try {
      draw(time()); stream = renderer.domElement.captureStream(30);
      const chunks: Blob[] = [];
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 32_000_000 });
      const done = new Promise<void>((resolve, reject) => {
        cancel = () => reject(new Error("Recording cancelled"));
        recorder!.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder!.onstop = () => disposed ? reject(new Error("Recording cancelled")) : resolve();
        recorder!.onerror = () => reject(new Error("Video encoder failed"));
      });
      recorder.start(250);
      timer = setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, seconds * 1000);
      await done;
      const sorted = [...timings].sort((a, b) => a - b);
      return { blob: new Blob(chunks, { type: mimeType }), metrics: { width: 3840, height: 2160, durationSeconds: (performance.now() - start) / 1000, renderedFrames: sorted.length, medianFrameMs: sorted[Math.floor(sorted.length / 2)] ?? 0, p95FrameMs: sorted[Math.floor(sorted.length * .95)] ?? 0, mimeType, requestedFps: 30 } };
    } finally {
      clearTimeout(timer); cancel = undefined;
      if (recorder?.state === "recording") recorder.stop();
      stream?.getTracks().forEach(track => track.stop()); recorder = null; recording = false; restore();
    }
  };
  return { capture, record, get recording() { return recording; }, sampleFrame: (ms: number) => { if (recording) timings.push(ms); }, dispose: () => { disposed = true; clearTimeout(timer); cancel?.(); if (recorder?.state === "recording") recorder.stop(); } };
}
