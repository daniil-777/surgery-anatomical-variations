/// <reference types="@webgpu/types" />
/** Explicit development benchmarks; never imported by the application. */
import { BloodRuntime, type BloodRuntimeOptions } from "./runtime";
import { BloodRenderer } from "./renderer";
import { BloodGpuProfiler } from "./profiler";
import { DEFAULT_SCENE, type BloodScene } from "./scene";
import { getSceneRecordingSource } from "../sceneRecordingSource";

const hash = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map(v => v.toString(16).padStart(2, "0")).join("");
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values, mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.ceil(sorted.length * .95) - 1]! };
};

export async function solverPerformanceBench(options: BloodRuntimeOptions, patch: Partial<BloodScene> = {}, steps = 80, expectedFailure = 0) {
  const r = await BloodRuntime.create({ ...DEFAULT_SCENE, fixture: "shear", ...patch }, { ...options, profiling: true });
  let ownedProfiler: BloodGpuProfiler | undefined;
  try {
    const profiler = ownedProfiler = new BloodGpuProfiler(r.device); await profiler.ready;
    // Pipeline compilation/first dispatch and eight warm-up steps are excluded.
    await r.submit(4); await r.submit(4);
    const batches: number[] = [], cpu: number[] = [], start = performance.now();
    for (let k = 0; k < steps; k += 4) {
      const t = performance.now(), completion = r.submit(Math.min(4, steps - k));
      cpu.push(performance.now() - t); await completion; batches.push(performance.now() - t);
    }
    const wallMs = performance.now() - start;
    const stateHash = await hash(await r.readBuffer(r.accepted));
    const controls = Array.from(new Uint32Array(await r.readBuffer(r.control)).slice(0, 20));
    const profiles = [];
    for (let k = 0; k < 5; ++k) {
      const frame = profiler.acquire(), encoder = r.device.createCommandEncoder();
      r.encodeAttempt(encoder, false, frame); frame?.resolve(encoder);
      r.device.queue.submit([encoder.finish()]);
      if (frame) profiles.push(await frame.submit()); else await r.device.queue.onSubmittedWorkDone();
    }
    const profiledStateHash = await hash(await r.readBuffer(r.accepted));
    const profiledControls = Array.from(new Uint32Array(await r.readBuffer(r.control)).slice(0, 20));
    const completed = expectedFailure ? controls[0] === 1 && controls[5] === expectedFailure : controls[0] === 0 && controls[1] === steps + 8;
    const profiledCompleted = expectedFailure ? profiledControls[0] === 1 && profiledControls[5] === expectedFailure
      : profiledControls[0] === 0 && profiledControls[1] === steps + 13;
    return { status: completed && profiledCompleted && !r.errors.length ? "PASS" : "FAIL", expectedFailure,
      options, config: r.scene, adapter: r.adapterInfo, wallMs, steps, batchMs: summary(batches), cpuEncodeMs: summary(cpu),
      stateHash, controls, profiledStateHash, profiledControls, profiles, profiler: profiler.status, errors: r.errors };
  } finally { ownedProfiler?.dispose(); r.dispose(); }
}

export async function renderPerformanceBench(compactStorage: boolean, width: number, height: number,
  patch: Partial<BloodScene> = {}, state?: number[], orbit = 0, frames = 24, filter: "bilateral" | "narrow-range" = "narrow-range") {
  const r = await BloodRuntime.create({ ...DEFAULT_SCENE, ...patch }, { profiling: true });
  let ownedProfiler: BloodGpuProfiler | undefined, ownedView: BloodRenderer | undefined;
  let ownedHost: HTMLDivElement | undefined, ownedTarget: GPUTexture | undefined;
  try {
    const profiler = ownedProfiler = new BloodGpuProfiler(r.device); await profiler.ready;
    const host = ownedHost = document.createElement("div"), canvas = document.createElement("canvas");
    host.style.cssText = `width:${width}px;height:${height}px;position:relative`;
    canvas.style.cssText = "width:100%;height:100%"; host.appendChild(canvas); document.body.appendChild(host);
    const view = ownedView = new BloodRenderer(canvas, r, { compactStorage });
    view.surfaceFilter = filter;
    // The command-line runner pins DPR=1. Refuse other contexts rather than
    // comparing a larger render viewport cropped into the requested target.
    if (canvas.width !== width || canvas.height !== height) {
      throw new Error(`Render benchmark requires exact physical dimensions: requested ${width}×${height}, canvas ${canvas.width}×${canvas.height} at DPR ${devicePixelRatio}. Use a DPR=1 benchmark context.`);
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    const target = ownedTarget = r.device.createTexture({ size: [width, height], format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const targetView = target.createView();
    if (state) r.device.queue.writeBuffer(r.accepted, 0, new Float32Array(state));
    for (let i = 0; i < Math.abs(orbit); ++i) canvas.dispatchEvent(new KeyboardEvent("keydown", { key: orbit > 0 ? "ArrowRight" : "ArrowLeft" }));
    const before = await hash(await r.readBuffer(r.accepted));
    const draw = async (timed: boolean) => {
      const frame = timed ? profiler.acquire() : undefined, encoder = r.device.createCommandEncoder();
      view.encode(encoder, frame, targetView); frame?.resolve(encoder);
      r.device.queue.submit([encoder.finish()]);
      if (frame) return await frame.submit();
      await r.device.queue.onSubmittedWorkDone(); return undefined;
    };
    for (let i = 0; i < 6; ++i) await draw(false);
    const times: number[] = [];
    for (let i = 0; i < frames; ++i) { const t = performance.now(); await draw(false); times.push(performance.now() - t); }
    const profiles = [];
    for (let i = 0; i < 5; ++i) profiles.push(await draw(true));
    const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
    const buffer = r.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    let pixels: Uint8Array<ArrayBuffer>;
    try {
      const encoder = r.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [width, height]);
      r.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange()); pixels = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; ++y) pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    } finally { buffer.destroy(); }
    const pixelHash = await hash(pixels.buffer), after = await hash(await r.readBuffer(r.accepted));
    if (format.startsWith("bgra")) for (let i = 0; i < pixels.length; i += 4) { const b = pixels[i]!; pixels[i] = pixels[i + 2]!; pixels[i + 2] = b; }
    const image = document.createElement("canvas"); image.width = width; image.height = height;
    image.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), width, height), 0, 0);
    return { status: before === after && !r.errors.length ? "PASS" : "FAIL", compactStorage, width, height, orbit, filter,
      adapter: r.adapterInfo, frameMs: summary(times), profiles, profiler: profiler.status, renderBytes: view.renderBytes,
      pixelHash, stateHash: after, stateUnchanged: before === after, errors: r.errors, image: image.toDataURL("image/png"),
      limitation: "Repeated full rendering of an identical accepted state, excluding encoding/capture/physics. No frame cache." };
  } finally { ownedTarget?.destroy(); ownedView?.dispose(); ownedHost?.remove(); ownedProfiler?.dispose(); r.dispose(); }
}

/** Small native-canvas lifecycle fixture. No capture encoder or physical step:
 * validates allocation, mode switches, recording leases and teardown at any DPR.
 */
export async function renderLifecycleBench(compactStorage = true) {
  const r = await BloodRuntime.create(DEFAULT_SCENE);
  let ownedView: BloodRenderer | undefined, ownedHost: HTMLDivElement | undefined;
  const checks: { name: string; passed: boolean }[] = [];
  const check = (name: string, passed: boolean) => { checks.push({ name, passed }); };
  const layoutFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  try {
    const host = ownedHost = document.createElement("div"), canvas = document.createElement("canvas");
    host.style.cssText = "width:320px;height:180px;position:relative";
    canvas.style.cssText = "width:100%;height:100%"; host.appendChild(canvas); document.body.appendChild(host);
    const view = ownedView = new BloodRenderer(canvas, r, { compactStorage });
    const source = getSceneRecordingSource(canvas);
    if (!source) throw new Error("Native blood recording source was not registered");
    const before = await hash(await r.readBuffer(r.accepted)), ratio = Math.min(devicePixelRatio, 2);
    const draw = async () => {
      const completion = r.submit(0, view.encode);
      if (!completion) throw new Error("Lifecycle render submission was unexpectedly rejected");
      await completion;
    };
    const expectedSurfaceBytes = () => canvas.width * canvas.height * (compactStorage ? 14 : 28);
    await draw();
    check("initial physical dimensions", canvas.width === Math.round(320 * ratio) && canvas.height === Math.round(180 * ratio));
    check("surface allocation", view.renderBytes === expectedSurfaceBytes());
    view.mode = "particles"; await draw(); view.mode = "surface"; await draw();
    check("particle-to-surface allocation restored", view.renderBytes === expectedSurfaceBytes());

    const initialStyle = canvas.style.cssText, abort = new AbortController();
    const lease = source.prepare({ width: 640, height: 360, fps: 30, signal: abort.signal });
    await draw();
    check("recording owns exact dimensions", canvas.width === 640 && canvas.height === 360 && canvas.dataset.sceneRecordingActive === "true");
    check("recording surface allocation", view.renderBytes === expectedSurfaceBytes());
    let duplicateRejected = false;
    try { source.prepare({ width: 640, height: 360, fps: 30, signal: new AbortController().signal }); }
    catch { duplicateRejected = true; }
    check("concurrent recording lease rejected", duplicateRejected);
    view.mode = "particles"; await draw();
    host.style.width = "480px"; host.style.height = "270px"; await layoutFrame(); await draw();
    check("host resize preserves recording buffer", canvas.width === 640 && canvas.height === 360);
    abort.abort(); lease.restore(); await layoutFrame();
    check("aborted lease restores dimensions and styles", canvas.width === Math.round(480 * ratio) && canvas.height === Math.round(270 * ratio)
      && canvas.style.cssText === initialStyle && !canvas.dataset.sceneRecordingActive);
    view.mode = "surface"; await draw();
    check("post-recording allocation follows display size", view.renderBytes === expectedSurfaceBytes());
    const after = await hash(await r.readBuffer(r.accepted));
    check("all transitions preserve accepted state", before === after);

    const finalAbort = new AbortController();
    const finalLease = source.prepare({ width: 640, height: 360, fps: 30, signal: finalAbort.signal });
    view.mode = "particles"; await draw(); view.dispose(); finalAbort.abort(); finalLease.restore();
    check("dispose unregisters and restores recording lease", !getSceneRecordingSource(canvas)
      && !canvas.dataset.sceneRecordingActive && canvas.style.cssText === initialStyle);
    check("dispose releases render allocations", view.renderBytes === 0);
    return { status: checks.every(value => value.passed) && !r.errors.length ? "PASS" : "FAIL",
      compactStorage, devicePixelRatio, checks, errors: r.errors, stateHash: after };
  } finally { ownedView?.dispose(); ownedHost?.remove(); r.dispose(); }
}
