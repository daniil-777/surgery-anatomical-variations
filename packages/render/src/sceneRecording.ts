import { Vector2, type PerspectiveCamera, type WebGLRenderer } from "three";

/** Structural media contract; the render package does not depend on Studio UI. */
export interface NativeSceneRecordingSource {
  kind: "scene";
  canvas: HTMLCanvasElement;
  label?: string;
  prepare(target: { width: number; height: number; fps: number; signal: AbortSignal }): { restore(): void };
}
interface Options {
  renderer: WebGLRenderer;
  camera: PerspectiveCamera;
  host: HTMLElement;
  label: string;
  draw(): void;
  /** Reject incompatible legacy recorders or incompletely loaded scenes. */
  available?: () => boolean;
}
const sources = new WeakMap<HTMLCanvasElement, NativeSceneRecordingSource>();
export const getSceneRecordingSource = (canvas: HTMLCanvasElement): NativeSceneRecordingSource | undefined => sources.get(canvas);

/** Register a renderer-owned native canvas lease (for example, a shared-device WebGPU scene). */
export function registerNativeSceneRecordingSource(source: NativeSceneRecordingSource): () => void {
  const { canvas } = source;
  if (sources.has(canvas)) throw new Error("The scene already has a recording source");
  sources.set(canvas, source);
  canvas.dataset.sceneRecordingSource = "native";
  canvas.dataset.sceneRecordingLabel = source.label ?? "Scene";
  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    if (sources.get(canvas) !== source) return;
    sources.delete(canvas);
    delete canvas.dataset.sceneRecordingSource; delete canvas.dataset.sceneRecordingLabel; delete canvas.dataset.sceneRecordingActive;
  };
}

/** Native draw-buffer lease. Camera pose is preserved; canvas bounds match its recording aspect. */
export function registerSceneRecordingSource({ renderer, camera, host, label, draw, available }: Options) {
  const canvas = renderer.domElement;
  if (sources.has(canvas)) throw new Error("The scene already has a recording source");
  let active = false, disposed = false;
  let releaseCurrent: (() => void) | undefined;
  const source: NativeSceneRecordingSource = {
    kind: "scene", canvas, label,
    prepare({ width, height, fps, signal }) {
      if (signal.aborted) throw new DOMException("Recording cancelled", "AbortError");
      if (active || disposed || !canvas.isConnected || available?.() === false) throw new Error("The scene is not ready or another capture is active");
      if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 8192) || width * height > 33_554_432 || !Number.isFinite(fps) || fps <= 0 || fps > 60) throw new Error("Invalid native recording dimensions or frame rate");
      const gl = renderer.getContext(), maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
      if (gl.isContextLost() || width > renderer.capabilities.maxTextureSize || height > renderer.capabilities.maxTextureSize ||
        width > gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || height > gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) ||
        width > maxViewport[0]! || height > maxViewport[1]!) throw new Error("The GPU cannot render the requested recording dimensions");
      const oldSize = renderer.getSize(new Vector2()), oldRatio = renderer.getPixelRatio();
      const oldStyle = { position: canvas.style.position, left: canvas.style.left, top: canvas.style.top };
      let restored = false;
      let layoutObserver: ResizeObserver | undefined;
      active = true; canvas.dataset.sceneRecordingActive = "true";
      const restore = () => {
        if (restored) return;
        restored = true; active = false; delete canvas.dataset.sceneRecordingActive;
        releaseCurrent = undefined; layoutObserver?.disconnect();
        Object.assign(canvas.style, oldStyle);
        if (disposed) return;
        const w = Math.max(1, host.clientWidth || oldSize.x), h = Math.max(1, host.clientHeight || oldSize.y);
        // setPixelRatio itself reallocates: shrink first, so a high-DPR display
        // never briefly allocates a DPR-scaled UHD buffer during release.
        renderer.setSize(w, h); renderer.setPixelRatio(oldRatio);
        camera.aspect = w / h; camera.updateProjectionMatrix(); draw();
      };
      releaseCurrent = restore;
      try {
        // Contain the actual canvas rectangle, not only its painted pixels: ray picking
        // uses getBoundingClientRect(), and must agree with the recording projection.
        const layout = () => {
          const w = Math.max(1, host.clientWidth || oldSize.x), h = Math.max(1, host.clientHeight || oldSize.y);
          const scale = Math.min(w / width, h / height), cssWidth = width * scale, cssHeight = height * scale;
          Object.assign(canvas.style, { position: "absolute", left: `${(w - cssWidth) / 2}px`, top: `${(h - cssHeight) / 2}px`, width: `${cssWidth}px`, height: `${cssHeight}px` });
        };
        layout();
        if (typeof ResizeObserver !== "undefined") { layoutObserver = new ResizeObserver(layout); layoutObserver.observe(host); }
        renderer.setPixelRatio(1); renderer.setSize(width, height, false);
        camera.aspect = width / height; camera.updateProjectionMatrix(); draw();
        if (canvas.width !== width || canvas.height !== height) throw new Error("The native recording buffer does not match the requested dimensions");
        return { restore };
      } catch (error) { try { restore(); } catch { /* Preserve the acquisition failure after releasing the lock. */ } throw error; }
    },
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; active = false;
    releaseCurrent?.();
    sources.delete(canvas); delete canvas.dataset.sceneRecordingSource; delete canvas.dataset.sceneRecordingLabel; delete canvas.dataset.sceneRecordingActive;
    canvas.removeEventListener("webglcontextlost", dispose);
  };
  canvas.addEventListener("webglcontextlost", dispose);
  canvas.dataset.sceneRecordingSource = "native"; canvas.dataset.sceneRecordingLabel = label;
  sources.set(canvas, source);
  return { source, get active() { return active; }, dispose };
}
