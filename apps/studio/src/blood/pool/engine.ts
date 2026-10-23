/// <reference types="@webgpu/types" />
import { Matrix4, PerspectiveCamera, Vector3 } from "three";
import { registerNativeSceneRecordingSource } from "../../sceneRecordingSource";
import {
  applyDeposit, cellChordM, createPoolState, depositAmplitude, derivePoolScheme, poolValidity, stepPool,
  type PoolConfig, type PoolScheme, type PoolValidity,
} from "./model";
import { buildPoolOpticsLut, POOL_OPTICS_ENTRIES } from "./optics";
import { CAUSTIC_WGSL, DEPOSIT_WGSL, SIM_WGSL, SOLID_WGSL, STEP_UNIFORM_STRIDE, SURFACE_RENDER_WGSL, SURFACE_WGSL } from "./shaders";

export const POOL_UPSTREAM = Object.freeze({
  repository: "https://github.com/jeantimex/webgpu-water",
  license: "MIT",
  copyright: "Copyright (c) 2026 Su",
  lineage: "WebGPU port of Evan Wallace's WebGL Water (https://madebyevan.com/webgl-water/)",
  reused: "Heightfield update form, drop raised-cosine profile, caustic area-ratio method, ray-traced Fresnel surface",
  changed: "SI parameterisation, stability cap C² ≤ 0.45, compute-shader FP32 state, volume-exact deposits and instrument, spectral blood optics, no textures/cubemap",
});

export type PoolMode = "orbit" | "drip" | "probe";
export interface PoolAppearance { bloodFraction: number; oxygenation: number; exposureEV: number }
export interface PoolReadback {
  timeSeconds: number; volumeM3: number; expectedVolumeM3: number; relativeVolumeError: number;
  maxRelativeElevation: number; finite: boolean;
}
export interface PoolParityReport {
  steps: number; maxAbsDifference: number; maxAbsReference: number; relativeDifference: number;
  gpuDepositedVolumeM3: number; expectedDepositedVolumeM3: number; volumeRelativeError: number; passed: boolean;
}
export interface PoolTelemetry {
  timeSeconds: number; steps: number; skippedSimSeconds: number; drops: number; airborne: number;
  depositedVolumeM3: number; instrument: { centreM: [number, number, number]; submerged: boolean; visible: boolean };
  readback: PoolReadback | null; validity: PoolValidity; running: boolean;
}

const MAX_STEPS_PER_FRAME = 64, MAX_DEPOSITS = 64, MAX_DROPS = 64, CAUSTIC_SIZE = 512;
const INSTRUMENT_SPEED_MS = .12, SHAFT_RADIUS = .38, SHAFT_LENGTH = 16;
type Drop = { x: number; z: number; y0: number; t0: number };

function sphere(material: number, rings = 18, segments = 32, out: number[] = []) {
  const v = (theta: number, phi: number) => { const s = Math.sin(theta); return [s * Math.cos(phi), Math.cos(theta), s * Math.sin(phi)] as const; };
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
    const t0 = Math.PI * r / rings, t1 = Math.PI * (r + 1) / rings, p0 = 2 * Math.PI * s / segments, p1 = 2 * Math.PI * (s + 1) / segments;
    for (const [t, p] of [[t0, p0], [t1, p0], [t1, p1], [t0, p0], [t1, p1], [t0, p1]] as const) { const q = v(t, p); out.push(...q, ...q, material); }
  }
  return out;
}
function quad(out: number[], a: number[], b: number[], c: number[], d: number[], n: number[], material: number) {
  for (const p of [a, b, c, a, c, d]) out.push(...p, ...n, material);
}
function trayMesh(L: number, rim: number) {
  const h = L / 2, o = h + .004, out: number[] = [];
  quad(out, [-h, 0, -h], [-h, 0, h], [h, 0, h], [h, 0, -h], [0, 1, 0], 0);                 // floor
  quad(out, [-h, 0, -h], [h, 0, -h], [h, rim, -h], [-h, rim, -h], [0, 0, 1], 0);           // inner walls
  quad(out, [h, 0, h], [-h, 0, h], [-h, rim, h], [h, rim, h], [0, 0, -1], 0);
  quad(out, [-h, 0, h], [-h, 0, -h], [-h, rim, -h], [-h, rim, h], [1, 0, 0], 0);
  quad(out, [h, 0, -h], [h, 0, h], [h, rim, h], [h, rim, -h], [-1, 0, 0], 0);
  for (const s of [1, -1]) {                                                                 // rim tops and outer walls
    quad(out, [-o, rim, s * h], [o, rim, s * h], [o, rim, s * o], [-o, rim, s * o], [0, 1, 0], 0);
    quad(out, [s * h, rim, -h], [s * h, rim, h], [s * o, rim, h], [s * o, rim, -h], [0, 1, 0], 0);
    quad(out, [-o, -.003, s * o], [o, -.003, s * o], [o, rim, s * o], [-o, rim, s * o], [0, 0, s], 0);
    quad(out, [s * o, -.003, o], [s * o, -.003, -o], [s * o, rim, -o], [s * o, rim, o], [s, 0, 0], 0);
  }
  const d = L * 4;                                                                           // surgical drape
  quad(out, [-d, -.003, -d], [-d, -.003, d], [d, -.003, d], [d, -.003, -d], [0, 1, 0], 1);
  return out;
}
function instrumentMesh() {
  const out = sphere(2), seg = 28;
  for (let s = 0; s < seg; s++) {
    const a = 2 * Math.PI * s / seg, b = 2 * Math.PI * (s + 1) / seg, r = SHAFT_RADIUS;
    const p = (t: number, y: number) => [r * Math.cos(t), y, r * Math.sin(t)], n = (t: number) => [Math.cos(t), 0, Math.sin(t)];
    for (const [t, y] of [[a, .9], [b, .9], [b, SHAFT_LENGTH], [a, .9], [b, SHAFT_LENGTH], [a, SHAFT_LENGTH]] as const) out.push(...p(t, y), ...n(t), 2);
  }
  return out;
}

async function compile(device: GPUDevice, label: string, code: string) {
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(m => m.type === "error");
  if (errors.length) throw new Error(`${label}: ${errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join("; ")}`);
  return module;
}

export class BloodPoolEngine {
  readonly scheme: PoolScheme;
  mode: PoolMode = "orbit";
  running = false;
  speed = 1;
  dripRateHz = 2;
  dripHeightM = .1;
  continuousDrip = false;
  dripSource: [number, number] = [.012, -.008];
  instrumentVisible = true;
  immersionM = .002;
  onHalt: ((reason: string) => void) | undefined;
  onError: ((message: string) => void) | undefined;
  onReadback: ((value: PoolReadback) => void) | undefined;
  onInteract: (() => void) | undefined;

  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly camera = new PerspectiveCamera(38, 1, .002, 5);
  private yaw = .75; private pitch = .62; private distance = 1.55;
  private readonly buffers: Record<string, GPUBuffer> = {};
  private readonly textures: Record<string, GPUTexture> = {};
  private depth: GPUTexture | undefined;
  private pipelines!: { step: GPUComputePipeline; deposit: GPUComputePipeline; surface: GPUComputePipeline;
    caustic: GPURenderPipeline; water: GPURenderPipeline; solid: GPURenderPipeline };
  private groups!: { step: [GPUBindGroup, GPUBindGroup]; deposit: [GPUBindGroup, GPUBindGroup]; surface: [GPUBindGroup, GPUBindGroup];
    caustic: GPUBindGroup; scene: GPUBindGroup };
  private ranges = { tray: [0, 0], instrument: [0, 0], drop: [0, 0] };
  private indexCount = 0;
  private current = 0;           // 0 → state A is current, 1 → state B
  private time = 0; private steps = 0; private skipped = 0; private accumulator = 0;
  private lastWall: number | undefined;
  private drops: Drop[] = []; private pendingDeposits: [number, number, number, number][] = [];
  private nextDripTime = 0; private dropCount = 0; private deposited = 0;
  private instrument: [number, number, number]; private instrumentTarget: [number, number, number];
  private drag: { id: number; x: number; y: number; orbit: boolean; lastDrip: number } | undefined;
  private surfaceDirty = true; private viewDirty = true; private capture = false; private disposed = false; private lost = false;
  private release: (() => void) | undefined;
  private readonly unregister: () => void;
  private readonly observer: ResizeObserver;
  private appearance: PoolAppearance;
  private readbackPending = false; private lastReadbackWall = 0; private latest: PoolReadback | null = null;
  private maxRelativeElevation = 0;
  readonly rimHeightM: number;

  static async create(canvas: HTMLCanvasElement, config: PoolConfig, appearance: PoolAppearance, signal?: AbortSignal): Promise<BloodPoolEngine> {
    if (!("gpu" in navigator) || !navigator.gpu) throw new Error("WebGPU is not available in this browser.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available.");
    const device = await adapter.requestDevice();
    if (signal?.aborted) { device.destroy(); throw new DOMException("Cancelled", "AbortError"); }
    const engine = new BloodPoolEngine(canvas, device, config, appearance, adapter.info);
    try { await engine.initialise(); }
    catch (cause) { engine.dispose(); throw cause; }
    if (signal?.aborted) { engine.dispose(); throw new DOMException("Cancelled", "AbortError"); }
    return engine;
  }

  private constructor(readonly canvas: HTMLCanvasElement, readonly device: GPUDevice, readonly config: PoolConfig,
    appearance: PoolAppearance, readonly adapterInfo: GPUAdapterInfo) {
    this.scheme = derivePoolScheme(config);
    this.appearance = { ...appearance };
    this.rimHeightM = config.depthM + Math.max(.006, config.depthM);
    const parked = this.parkedCentre(0, 0);
    this.instrument = [...parked]; this.instrumentTarget = [...parked];
    const context = canvas.getContext("webgpu"); if (!context) throw new Error("Could not create a WebGPU canvas context.");
    this.context = context; this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: "opaque" });
    void device.lost.then(info => { if (!this.disposed) { this.lost = true; this.running = false; this.onError?.(`The GPU device was lost (${info.reason}). Reset the pool to continue.`); } });
    device.addEventListener("uncapturederror", event => { if (!this.disposed) { this.running = false; this.onError?.((event as GPUUncapturedErrorEvent).error.message); } });
    this.observer = new ResizeObserver(() => { if (!this.capture) this.resize(); });
    this.observer.observe(canvas.parentElement!);
    this.unregister = registerNativeSceneRecordingSource({ kind: "scene", canvas, label: "Blood pool · heightfield model", prepare: target => this.prepare(target) });
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) canvas.addEventListener(type, this.pointer);
    canvas.addEventListener("wheel", this.wheel, { passive: false }); canvas.addEventListener("keydown", this.key);
    canvas.addEventListener("contextmenu", this.contextMenu);
  }

  private async initialise() {
    const { device } = this, n = this.scheme.n, cells = n * n;
    const buffer = (name: string, size: number, usage: number) => (this.buffers[name] = device.createBuffer({ label: `pool/${name}`, size, usage }));
    const S = GPUBufferUsage;
    buffer("stateA", cells * 8, S.STORAGE | S.COPY_SRC | S.COPY_DST); buffer("stateB", cells * 8, S.STORAGE | S.COPY_SRC | S.COPY_DST);
    buffer("surf", cells * 16, S.STORAGE); buffer("step", MAX_STEPS_PER_FRAME * STEP_UNIFORM_STRIDE, S.UNIFORM | S.COPY_DST);
    buffer("depositParams", 16, S.UNIFORM | S.COPY_DST); buffer("deposits", MAX_DEPOSITS * 16, S.STORAGE | S.COPY_DST);
    buffer("surfaceParams", 16, S.UNIFORM | S.COPY_DST); buffer("view", 256, S.UNIFORM | S.COPY_DST);
    buffer("instances", (2 + MAX_DROPS) * 16, S.VERTEX | S.COPY_DST); buffer("readback", cells * 8, S.MAP_READ | S.COPY_DST);
    device.queue.writeBuffer(this.buffers.surfaceParams!, 0, new Uint32Array([n, 0, 0, 0]));
    device.queue.writeBuffer(this.buffers.surfaceParams!, 8, new Float32Array([this.config.depthM, this.scheme.dxM]));

    // Grid indices shared by caustic and surface passes.
    const indices = new Uint32Array((n - 1) * (n - 1) * 6); let k = 0;
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1; indices.set([a, c, b, b, c, d], k); k += 6;
    }
    this.indexCount = indices.length;
    buffer("indices", indices.byteLength, S.INDEX | S.COPY_DST); device.queue.writeBuffer(this.buffers.indices!, 0, indices);
    const tray = trayMesh(this.config.lengthM, this.rimHeightM), tool = instrumentMesh(), drop = sphere(3, 10, 16);
    const vertices = new Float32Array([...tray, ...tool, ...drop]);
    this.ranges = { tray: [0, tray.length / 7], instrument: [tray.length / 7, tool.length / 7], drop: [(tray.length + tool.length) / 7, drop.length / 7] };
    buffer("vertices", vertices.byteLength, S.VERTEX | S.COPY_DST); device.queue.writeBuffer(this.buffers.vertices!, 0, vertices);

    const T = GPUTextureUsage;
    this.textures.optics = device.createTexture({ label: "pool/optics", size: [POOL_OPTICS_ENTRIES, 2], format: "rgba32float", usage: T.TEXTURE_BINDING | T.COPY_DST });
    this.textures.caustic = device.createTexture({ label: "pool/caustics", size: [CAUSTIC_SIZE, CAUSTIC_SIZE], format: "rgba16float", usage: T.TEXTURE_BINDING | T.RENDER_ATTACHMENT });
    this.writeOptics();
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });

    const C = GPUShaderStage.COMPUTE, VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, F = GPUShaderStage.FRAGMENT;
    const computeLayout = (dynamic: boolean) => device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: C, buffer: { type: "uniform", hasDynamicOffset: dynamic, minBindingSize: dynamic ? 64 : 16 } },
      { binding: 1, visibility: C, buffer: { type: "read-only-storage" } }, { binding: 2, visibility: C, buffer: { type: "storage" } }] });
    const stepLayout = computeLayout(true), plainLayout = computeLayout(false);
    const causticLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: VF, buffer: { type: "uniform" } }, { binding: 1, visibility: VF, buffer: { type: "read-only-storage" } }] });
    const sceneLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: VF, buffer: { type: "uniform" } }, { binding: 1, visibility: VF, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: F, texture: { sampleType: "unfilterable-float" } }, { binding: 3, visibility: F, texture: { sampleType: "float" } },
      { binding: 4, visibility: F, sampler: { type: "filtering" } }] });
    const [sim, deposit, surface, caustic, water, solid] = await Promise.all([
      compile(device, "pool/sim", SIM_WGSL), compile(device, "pool/deposit", DEPOSIT_WGSL), compile(device, "pool/surface", SURFACE_WGSL),
      compile(device, "pool/caustics", CAUSTIC_WGSL), compile(device, "pool/blood-surface", SURFACE_RENDER_WGSL), compile(device, "pool/solids", SOLID_WGSL)]);
    const layout = (l: GPUBindGroupLayout) => device.createPipelineLayout({ bindGroupLayouts: [l] });
    const depthStencil: GPUDepthStencilState = { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" };
    device.pushErrorScope("validation");
    this.pipelines = {
      step: device.createComputePipeline({ label: "pool/step", layout: layout(stepLayout), compute: { module: sim, entryPoint: "advance" } }),
      deposit: device.createComputePipeline({ label: "pool/deposit", layout: layout(plainLayout), compute: { module: deposit, entryPoint: "deposit" } }),
      surface: device.createComputePipeline({ label: "pool/surface", layout: layout(plainLayout), compute: { module: surface, entryPoint: "surface" } }),
      caustic: device.createRenderPipeline({ label: "pool/caustics", layout: layout(causticLayout), vertex: { module: caustic, entryPoint: "vs" },
        fragment: { module: caustic, entryPoint: "fs", targets: [{ format: "rgba16float", blend: {
          color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } } }] },
        primitive: { topology: "triangle-list" } }),
      water: device.createRenderPipeline({ label: "pool/blood-surface", layout: layout(sceneLayout), vertex: { module: water, entryPoint: "vs" },
        fragment: { module: water, entryPoint: "fs", targets: [{ format: this.format }] }, primitive: { topology: "triangle-list" }, depthStencil }),
      solid: device.createRenderPipeline({ label: "pool/solids", layout: layout(sceneLayout), vertex: { module: solid, entryPoint: "vs", buffers: [
        { arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }, { shaderLocation: 2, offset: 24, format: "float32" }] },
        { arrayStride: 16, stepMode: "instance", attributes: [{ shaderLocation: 3, offset: 0, format: "float32x4" }] }] },
        fragment: { module: solid, entryPoint: "fs", targets: [{ format: this.format }] }, primitive: { topology: "triangle-list", cullMode: "none" }, depthStencil }),
    };
    const failure = await device.popErrorScope();
    if (failure) throw new Error(`Pool pipeline validation failed: ${failure.message}`);
    const B = this.buffers, entries = (u: GPUBuffer, a: GPUBuffer, b: GPUBuffer, size?: number): GPUBindGroupEntry[] =>
      [{ binding: 0, resource: { buffer: u, ...(size ? { size } : {}) } }, { binding: 1, resource: { buffer: a } }, { binding: 2, resource: { buffer: b } }];
    this.groups = {
      step: [device.createBindGroup({ layout: stepLayout, entries: entries(B.step!, B.stateA!, B.stateB!, 64) }),
        device.createBindGroup({ layout: stepLayout, entries: entries(B.step!, B.stateB!, B.stateA!, 64) })],
      deposit: [device.createBindGroup({ layout: plainLayout, entries: entries(B.depositParams!, B.deposits!, B.stateA!) }),
        device.createBindGroup({ layout: plainLayout, entries: entries(B.depositParams!, B.deposits!, B.stateB!) })],
      surface: [device.createBindGroup({ layout: plainLayout, entries: entries(B.surfaceParams!, B.stateA!, B.surf!) }),
        device.createBindGroup({ layout: plainLayout, entries: entries(B.surfaceParams!, B.stateB!, B.surf!) })],
      caustic: device.createBindGroup({ layout: causticLayout, entries: [{ binding: 0, resource: { buffer: B.view! } }, { binding: 1, resource: { buffer: B.surf! } }] }),
      scene: device.createBindGroup({ layout: sceneLayout, entries: [{ binding: 0, resource: { buffer: B.view! } }, { binding: 1, resource: { buffer: B.surf! } },
        { binding: 2, resource: this.textures.optics.createView() }, { binding: 3, resource: this.textures.caustic.createView() }, { binding: 4, resource: sampler }] }),
    };
    this.resize();
  }

  // ───────────────────────────── appearance / state ─────────────────────────────
  setAppearance(change: Partial<PoolAppearance>) {
    const next = { ...this.appearance, ...change };
    if (!(next.bloodFraction > 0 && next.bloodFraction <= 1) || !(next.oxygenation >= 0 && next.oxygenation <= 1) || !(Math.abs(next.exposureEV) <= 3))
      throw new RangeError("Invalid pool appearance");
    const oxygen = next.oxygenation !== this.appearance.oxygenation; this.appearance = next;
    if (oxygen) this.writeOptics();
    this.viewDirty = true;
  }
  private writeOptics() {
    this.device.queue.writeTexture({ texture: this.textures.optics! }, buildPoolOpticsLut(this.appearance.oxygenation),
      { bytesPerRow: POOL_OPTICS_ENTRIES * 16, rowsPerImage: 2 }, [POOL_OPTICS_ENTRIES, 2]);
  }
  /** Clears waves, drops and readback history; the configuration is unchanged. */
  clear() {
    const zero = new Float32Array(this.scheme.n * this.scheme.n * 2);
    this.device.queue.writeBuffer(this.buffers.stateA!, 0, zero); this.device.queue.writeBuffer(this.buffers.stateB!, 0, zero);
    this.current = 0; this.time = 0; this.steps = 0; this.skipped = 0; this.accumulator = 0; this.drops = []; this.pendingDeposits = [];
    this.dropCount = 0; this.deposited = 0; this.nextDripTime = 0; this.latest = null; this.maxRelativeElevation = 0;
    const parked = this.parkedCentre(this.instrument[0], this.instrument[2]);
    this.instrumentTarget = this.instrumentVisible ? this.immersedCentre(parked[0], parked[2]) : [...parked];
    this.instrument = [...this.instrumentTarget];
    this.surfaceDirty = this.viewDirty = true;
  }
  private parkedCentre(x: number, z: number): [number, number, number] { return [x, this.config.depthM + this.config.instrumentRadiusM + .003, z]; }
  private immersedCentre(x: number, z: number): [number, number, number] {
    const r = this.config.instrumentRadiusM, y = Math.max(r, this.config.depthM + r - this.immersionM);
    const limit = this.config.lengthM / 2 - r * 1.2;
    return [Math.max(-limit, Math.min(limit, x)), y, Math.max(-limit, Math.min(limit, z))];
  }
  setInstrument(visible: boolean, immersionM = this.immersionM) {
    if (!Number.isFinite(immersionM) || immersionM < 0 || immersionM > this.config.depthM + this.config.instrumentRadiusM) throw new RangeError("Invalid immersion");
    this.instrumentVisible = visible; this.immersionM = immersionM;
    const [x, , z] = this.instrumentTarget;
    this.instrumentTarget = visible ? this.immersedCentre(x, z) : this.parkedCentre(x, z);
    if (!this.running) this.instrument = [...this.instrumentTarget];
    this.viewDirty = true;
  }
  /** Drop a Tate-volume drop from the configured fall height at (x, z). */
  addDrop(x: number, z: number) {
    const half = this.config.lengthM / 2;
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > half || Math.abs(z) > half) return false;
    if (this.drops.length >= MAX_DROPS) return false;
    this.drops.push({ x, z, y0: this.config.depthM + this.dripHeightM, t0: this.time });
    this.viewDirty = true; return true;
  }

  // ───────────────────────────── simulation ─────────────────────────────
  frame(now: number) {
    if (this.disposed || this.lost) return;
    const wall = this.lastWall === undefined ? 0 : Math.min(.1, Math.max(0, (now - this.lastWall) / 1000)); this.lastWall = now;
    let stepCount = 0;
    const s = this.scheme, encoder = this.device.createCommandEncoder({ label: "pool/frame" });
    if (this.running) {
      this.accumulator += wall * this.speed;
      stepCount = Math.floor(this.accumulator / s.dtSeconds + 1e-9);
      if (stepCount > MAX_STEPS_PER_FRAME) { this.skipped += (stepCount - MAX_STEPS_PER_FRAME) * s.dtSeconds; stepCount = MAX_STEPS_PER_FRAME; this.accumulator = 0; }
      else this.accumulator -= stepCount * s.dtSeconds;
    } else this.accumulator = 0;
    const frameEnd = this.time + stepCount * s.dtSeconds;
    if (stepCount) {
      // Continuous drip and falling drops advance in physical time.
      if (this.continuousDrip) {
        if (this.nextDripTime < this.time) this.nextDripTime = this.time;
        while (this.nextDripTime < frameEnd) { this.drops.length < MAX_DROPS && this.drops.push({ x: this.dripSource[0], z: this.dripSource[1], y0: this.config.depthM + this.dripHeightM, t0: this.nextDripTime }); this.nextDripTime += 1 / this.dripRateHz; }
      }
      const g = this.config.gravityMS2, rest = this.config.depthM;
      this.drops = this.drops.filter(drop => {
        const impact = drop.t0 + Math.sqrt(2 * (drop.y0 - rest) / g);
        if (impact > frameEnd) return true;
        const amplitude = depositAmplitude(s, rest, drop.x, drop.z, s.depositRadiusM, s.dropVolumeM3);
        this.pendingDeposits.push([drop.x, drop.z, s.depositRadiusM, amplitude]); this.dropCount++; this.deposited += s.dropVolumeM3;
        return false;
      });
    }
    if (this.pendingDeposits.length && stepCount) {
      const batch = this.pendingDeposits.splice(0, MAX_DEPOSITS);
      this.device.queue.writeBuffer(this.buffers.depositParams!, 0, new Uint32Array([s.n, batch.length]));
      this.device.queue.writeBuffer(this.buffers.depositParams!, 8, new Float32Array([s.dxM, 0]));
      this.device.queue.writeBuffer(this.buffers.deposits!, 0, new Float32Array(batch.flat()));
      const pass = encoder.beginComputePass({ label: "pool/deposit" });
      pass.setPipeline(this.pipelines.deposit); pass.setBindGroup(0, this.groups.deposit[this.current]!);
      pass.dispatchWorkgroups(Math.ceil(s.n / 8), Math.ceil(s.n / 8)); pass.end();
    }
    if (stepCount) {
      const from: [number, number, number] = [...this.instrument], to = this.moveInstrument(stepCount * s.dtSeconds);
      const moving = from.some((v, k) => v !== to[k]), data = new ArrayBuffer(stepCount * STEP_UNIFORM_STRIDE);
      for (let k = 0; k < stepCount; k++) {
        const u = new Uint32Array(data, k * STEP_UNIFORM_STRIDE, 16), f = new Float32Array(data, k * STEP_UNIFORM_STRIDE, 16);
        u[0] = s.n; u[1] = moving ? 1 : 0;
        f.set([this.config.courantSquared, s.dampPerStep, this.config.depthM, s.dxM], 4);
        const a = k / stepCount, b = (k + 1) / stepCount, r = this.config.instrumentRadiusM;
        f.set([from[0] + (to[0] - from[0]) * a, from[1] + (to[1] - from[1]) * a, from[2] + (to[2] - from[2]) * a, r], 8);
        f.set([from[0] + (to[0] - from[0]) * b, from[1] + (to[1] - from[1]) * b, from[2] + (to[2] - from[2]) * b, r], 12);
      }
      this.device.queue.writeBuffer(this.buffers.step!, 0, data);
      const pass = encoder.beginComputePass({ label: "pool/steps" }); pass.setPipeline(this.pipelines.step);
      for (let k = 0; k < stepCount; k++) {
        pass.setBindGroup(0, this.groups.step[this.current]!, [k * STEP_UNIFORM_STRIDE]);
        pass.dispatchWorkgroups(Math.ceil(s.n / 8), Math.ceil(s.n / 8)); this.current ^= 1;
      }
      pass.end();
      this.instrument = to; this.time = frameEnd; this.steps += stepCount; this.surfaceDirty = true;
    }
    if (this.surfaceDirty) {
      const pass = encoder.beginComputePass({ label: "pool/surface" }); pass.setPipeline(this.pipelines.surface);
      pass.setBindGroup(0, this.groups.surface[this.current]!); pass.dispatchWorkgroups(Math.ceil(s.n / 8), Math.ceil(s.n / 8)); pass.end();
    }
    const render = this.surfaceDirty || this.viewDirty || this.capture;
    if (render) this.encodeRender(encoder);
    let readback = false;
    if (!this.readbackPending && stepCount && now - this.lastReadbackWall > 400) {
      encoder.copyBufferToBuffer(this.current ? this.buffers.stateB! : this.buffers.stateA!, 0, this.buffers.readback!, 0, this.buffers.readback!.size);
      readback = true;
    }
    this.device.queue.submit([encoder.finish()]);
    this.surfaceDirty = false; if (render) this.viewDirty = false;
    if (readback) this.readback(now, { time: this.time, deposited: this.deposited, instrument: [...this.instrument] });
  }
  private moveInstrument(seconds: number): [number, number, number] {
    const from = this.instrument, to = this.instrumentTarget, d = to.map((v, k) => v - from[k]!), length = Math.hypot(...d);
    const max = INSTRUMENT_SPEED_MS * seconds;
    if (length <= max) return [...to];
    return from.map((v, k) => v + d[k]! * max / length) as [number, number, number];
  }
  private readback(now: number, at: { time: number; deposited: number; instrument: [number, number, number] }) {
    this.readbackPending = true; this.lastReadbackWall = now;
    const buffer = this.buffers.readback!;
    void buffer.mapAsync(GPUMapMode.READ).then(() => {
      if (this.disposed) return;
      const data = new Float32Array(buffer.getMappedRange().slice(0)); buffer.unmap(); this.readbackPending = false;
      const s = this.scheme, H = this.config.depthM, r = this.config.instrumentRadiusM;
      let sum = 0, chord = 0, peak = 0, finite = true;
      for (let j = 0; j < s.n; j++) for (let i = 0; i < s.n; i++) {
        const h = data[(j * s.n + i) * 2]!; if (!Number.isFinite(h)) finite = false;
        sum += h; peak = Math.max(peak, Math.abs(h));
        if (Math.abs(i - (at.instrument[0] / s.dxM + s.n / 2)) < r / s.dxM + 2 && Math.abs(j - (at.instrument[2] / s.dxM + s.n / 2)) < r / s.dxM + 2)
          chord += cellChordM(i, j, s, at.instrument, r, H);
      }
      const area = s.dxM * s.dxM, volume = (H * (s.n * s.n + sum) - chord) * area, expected = H * s.n * s.n * area + at.deposited;
      this.maxRelativeElevation = Math.max(this.maxRelativeElevation, peak);
      this.latest = { timeSeconds: at.time, volumeM3: volume, expectedVolumeM3: expected, relativeVolumeError: (volume - expected) / expected, maxRelativeElevation: peak, finite };
      this.onReadback?.(this.latest);
      if (!finite || peak > .9) { this.running = false; this.onHalt?.(!finite ? "Non-finite surface height detected. The run was stopped." : "Surface elevation reached 90% of the layer depth — outside the linear model. The run was stopped."); }
    }).catch(cause => { this.readbackPending = false; if (!this.disposed) this.onError?.(String(cause)); });
  }

  // ───────────────────────────── rendering ─────────────────────────────
  private updateCamera() {
    const L = this.config.lengthM, H = this.config.depthM, distance = this.distance * L;
    this.camera.position.set(Math.sin(this.yaw) * Math.cos(this.pitch) * distance, H + Math.sin(this.pitch) * distance, Math.cos(this.yaw) * Math.cos(this.pitch) * distance);
    this.camera.aspect = this.canvas.width / this.canvas.height; this.camera.near = Math.max(.002, distance * .05); this.camera.far = distance * 12;
    this.camera.lookAt(0, H * .6, 0); this.camera.updateMatrixWorld(); this.camera.updateProjectionMatrix();
  }
  private writeView() {
    this.updateCamera();
    const L = this.config.lengthM, H = this.config.depthM;
    const remap = new Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, .5, .5, 0, 0, 0, 1);
    const vp = remap.multiply(this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse);
    const light = new Vector3(.28, 1, .18).normalize(), data = new Float32Array(64);
    const visible = this.instrumentVisible || this.instrument[1] < this.parkedCentre(0, 0)[1] - 1e-6;
    data.set(vp.elements, 0); data.set([...this.camera.position.toArray(), 1], 16); data.set([light.x, light.y, light.z, 3], 20);
    data.set([L, H, this.rimHeightM, this.scheme.n], 24);
    data.set([...this.instrument, visible ? this.config.instrumentRadiusM : 0], 28);
    data.set([this.appearance.bloodFraction, 2 ** this.appearance.exposureEV, 1.35, .35], 32);
    data.set([this.scheme.dxM, .5, SHAFT_RADIUS, SHAFT_LENGTH], 36);
    this.device.queue.writeBuffer(this.buffers.view!, 0, data);
    const g = this.config.gravityMS2, instances = new Float32Array((2 + MAX_DROPS) * 4);
    instances.set([0, 0, 0, 1], 0); instances.set([...this.instrument, visible ? this.config.instrumentRadiusM : 0], 4);
    this.drops.forEach((drop, k) => {
      const t = this.time - drop.t0, y = Math.max(this.config.depthM, drop.y0 - g * t * t / 2);
      instances.set([drop.x, y + this.scheme.dropRadiusM, drop.z, this.scheme.dropRadiusM], 8 + k * 4);
    });
    this.device.queue.writeBuffer(this.buffers.instances!, 0, instances);
  }
  private encodeRender(encoder: GPUCommandEncoder, target?: GPUTextureView) {
    this.writeView();
    const caustic = encoder.beginRenderPass({ label: "pool/caustics", colorAttachments: [{ view: this.textures.caustic!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }] });
    caustic.setPipeline(this.pipelines.caustic); caustic.setBindGroup(0, this.groups.caustic); caustic.setIndexBuffer(this.buffers.indices!, "uint32");
    caustic.drawIndexed(this.indexCount); caustic.end();
    if (!this.depth || this.depth.width !== this.canvas.width || this.depth.height !== this.canvas.height) {
      this.depth?.destroy();
      this.depth = this.device.createTexture({ label: "pool/depth", size: [this.canvas.width, this.canvas.height], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    const pass = encoder.beginRenderPass({ label: "pool/scene", colorAttachments: [{ view: target ?? this.context.getCurrentTexture().createView(),
      clearValue: { r: .012, g: .016, b: .02, a: 1 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" } });
    pass.setPipeline(this.pipelines.solid); pass.setBindGroup(0, this.groups.scene);
    pass.setVertexBuffer(0, this.buffers.vertices!); pass.setVertexBuffer(1, this.buffers.instances!);
    pass.draw(this.ranges.tray[1]!, 1, this.ranges.tray[0]!, 0);
    pass.draw(this.ranges.instrument[1]!, 1, this.ranges.instrument[0]!, 1);
    if (this.drops.length) pass.draw(this.ranges.drop[1]!, this.drops.length, this.ranges.drop[0]!, 2);
    pass.setPipeline(this.pipelines.water); pass.setBindGroup(0, this.groups.scene); pass.setIndexBuffer(this.buffers.indices!, "uint32");
    pass.drawIndexed(this.indexCount); pass.end();
  }

  // ───────────────────────────── verification ─────────────────────────────
  /** Resets the pool, runs a deterministic GPU fixture and compares it with the
   *  FP32 CPU reference of the same kernel. Leaves the pool cleared. */
  async verifyParity(steps = 240): Promise<PoolParityReport> {
    this.running = false;
    const wasVisible = this.instrumentVisible, prevImmersion = this.immersionM;
    this.setInstrument(false); this.instrument = this.parkedCentre(0, 0); this.instrumentTarget = [...this.instrument];
    this.clear();
    const s = this.scheme, H = this.config.depthM, events = [[0, 0], [this.config.lengthM * .3, -this.config.lengthM * .2]] as const;
    const deposits = events.map(([x, z]) => [x, z, s.depositRadiusM, depositAmplitude(s, H, x, z, s.depositRadiusM, s.dropVolumeM3)] as const);
    const encoder = this.device.createCommandEncoder({ label: "pool/parity" });
    this.device.queue.writeBuffer(this.buffers.depositParams!, 0, new Uint32Array([s.n, deposits.length]));
    this.device.queue.writeBuffer(this.buffers.depositParams!, 8, new Float32Array([s.dxM, 0]));
    this.device.queue.writeBuffer(this.buffers.deposits!, 0, new Float32Array(deposits.flat()));
    const data = new ArrayBuffer(Math.min(steps, MAX_STEPS_PER_FRAME) * STEP_UNIFORM_STRIDE);
    for (let k = 0; k < Math.min(steps, MAX_STEPS_PER_FRAME); k++) {
      const u = new Uint32Array(data, k * STEP_UNIFORM_STRIDE, 16), f = new Float32Array(data, k * STEP_UNIFORM_STRIDE, 16);
      u[0] = s.n; u[1] = 0; f.set([this.config.courantSquared, s.dampPerStep, H, s.dxM], 4);
    }
    this.device.queue.writeBuffer(this.buffers.step!, 0, data);
    let pass = encoder.beginComputePass(); pass.setPipeline(this.pipelines.deposit); pass.setBindGroup(0, this.groups.deposit[0]!);
    pass.dispatchWorkgroups(Math.ceil(s.n / 8), Math.ceil(s.n / 8)); pass.end();
    pass = encoder.beginComputePass(); pass.setPipeline(this.pipelines.step);
    let current = 0;
    for (let k = 0; k < steps; k++) { pass.setBindGroup(0, this.groups.step[current]!, [0]); pass.dispatchWorkgroups(Math.ceil(s.n / 8), Math.ceil(s.n / 8)); current ^= 1; }
    pass.end();
    encoder.copyBufferToBuffer(current ? this.buffers.stateB! : this.buffers.stateA!, 0, this.buffers.readback!, 0, this.buffers.readback!.size);
    while (this.readbackPending) await new Promise(resolve => setTimeout(resolve, 10));
    this.readbackPending = true;
    this.device.queue.submit([encoder.finish()]);
    await this.buffers.readback!.mapAsync(GPUMapMode.READ);
    const gpu = new Float32Array(this.buffers.readback!.getMappedRange().slice(0)); this.buffers.readback!.unmap(); this.readbackPending = false;
    let cpu = createPoolState(s.n, "f32"), scratch = createPoolState(s.n, "f32");
    for (const [x, z, r, a] of deposits) applyDeposit(cpu, s, x, z, r, Math.fround(a));
    for (let k = 0; k < steps; k++) [cpu, scratch] = [stepPool(cpu, s, Math.fround(this.config.courantSquared), scratch), cpu];
    let maxDiff = 0, maxRef = 0, sum = 0;
    for (let i = 0; i < s.n * s.n; i++) { maxDiff = Math.max(maxDiff, Math.abs(gpu[i * 2]! - cpu.h[i]!)); maxRef = Math.max(maxRef, Math.abs(cpu.h[i]!)); sum += gpu[i * 2]!; }
    const gpuVolume = sum * H * s.dxM * s.dxM, expected = deposits.length * s.dropVolumeM3;
    this.setInstrument(wasVisible, prevImmersion);
    this.clear();
    const relativeDifference = maxDiff / maxRef, volumeRelativeError = (gpuVolume - expected) / expected;
    return { steps, maxAbsDifference: maxDiff, maxAbsReference: maxRef, relativeDifference, gpuDepositedVolumeM3: gpuVolume,
      expectedDepositedVolumeM3: expected, volumeRelativeError, passed: relativeDifference < 1e-3 && Math.abs(volumeRelativeError) < 1e-3 };
  }

  telemetry(): PoolTelemetry {
    return { timeSeconds: this.time, steps: this.steps, skippedSimSeconds: this.skipped, drops: this.dropCount, airborne: this.drops.length,
      depositedVolumeM3: this.deposited, readback: this.latest, running: this.running,
      validity: poolValidity(this.config, this.scheme, this.maxRelativeElevation),
      instrument: { centreM: [...this.instrument], submerged: this.instrument[1] - this.config.instrumentRadiusM < this.config.depthM, visible: this.instrumentVisible } };
  }
  get needsFrame() { return this.running || this.viewDirty || this.surfaceDirty || this.capture; }

  // ───────────────────────────── interaction ─────────────────────────────
  private pickPool(clientX: number, clientY: number): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return null;
    this.updateCamera();
    const ndc = new Vector3((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2, .5).unproject(this.camera);
    const origin = this.camera.position, dir = ndc.sub(origin).normalize();
    if (dir.y >= 0) return null;
    const t = (this.config.depthM - origin.y) / dir.y, x = origin.x + dir.x * t, z = origin.z + dir.z * t, half = this.config.lengthM / 2;
    return Math.abs(x) <= half && Math.abs(z) <= half ? [x, z] : null;
  }
  /** Projects a pool point to canvas-relative CSS pixels (used by UI overlays). */
  project(x: number, y: number, z: number) {
    this.updateCamera();
    const v = new Vector3(x, y, z).project(this.camera), rect = this.canvas.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height, visible: v.z > -1 && v.z < 1 };
  }
  private pointer = (event: PointerEvent) => {
    if (this.disposed) return;
    if (event.type === "pointerdown") {
      if (event.button !== 0 && event.button !== 2) return;
      this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(event.pointerId);
      const orbit = event.button === 2 || this.mode === "orbit" || event.shiftKey;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, orbit, lastDrip: 0 };
      if (!orbit) this.applyTool(event, true);
    } else if (event.type === "pointermove" && this.drag?.id === event.pointerId) {
      if (this.drag.orbit) {
        this.yaw -= (event.clientX - this.drag.x) * .006; this.pitch = Math.max(.12, Math.min(1.5, this.pitch + (event.clientY - this.drag.y) * .006));
        this.drag.x = event.clientX; this.drag.y = event.clientY; this.viewDirty = true;
      } else this.applyTool(event, false);
    } else if ((event.type === "pointerup" || event.type === "pointercancel") && this.drag?.id === event.pointerId) {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.drag = undefined;
    }
  };
  private applyTool(event: PointerEvent, first: boolean) {
    const hit = this.pickPool(event.clientX, event.clientY); if (!hit) return;
    if (this.mode === "drip") {
      if (first || performance.now() - this.drag!.lastDrip > 90) { this.addDrop(hit[0], hit[1]); this.dripSource = [hit[0], hit[1]]; this.drag!.lastDrip = performance.now(); this.onInteract?.(); }
    } else if (this.mode === "probe") {
      this.instrumentVisible = true; this.instrumentTarget = this.immersedCentre(hit[0], hit[1]); this.viewDirty = true; this.onInteract?.();
    }
  }
  private wheel = (event: WheelEvent) => { event.preventDefault(); this.distance = Math.max(.7, Math.min(3.5, this.distance * Math.exp(event.deltaY * .001))); this.viewDirty = true; };
  private contextMenu = (event: Event) => event.preventDefault();
  private key = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home"].includes(event.key)) return;
    event.preventDefault(); this.viewDirty = true;
    if (event.key === "Home") { this.yaw = .75; this.pitch = .62; this.distance = 1.55; }
    if (event.key === "ArrowLeft") this.yaw -= .1; if (event.key === "ArrowRight") this.yaw += .1;
    if (event.key === "ArrowUp") this.pitch = Math.min(1.5, this.pitch + .08); if (event.key === "ArrowDown") this.pitch = Math.max(.12, this.pitch - .08);
    if (event.key === "+" || event.key === "=") this.distance = Math.max(.7, this.distance / 1.1); if (event.key === "-") this.distance = Math.min(3.5, this.distance * 1.1);
  };
  resetCamera() { this.yaw = .75; this.pitch = .62; this.distance = 1.55; this.viewDirty = true; }
  topView() { this.pitch = 1.5; this.distance = 1.35; this.viewDirty = true; }

  // ───────────────────────────── canvas / recording ─────────────────────────────
  private allocate(width: number, height: number) {
    if (width === this.canvas.width && height === this.canvas.height) return;
    this.canvas.width = width; this.canvas.height = height; this.viewDirty = true;
  }
  private resize() {
    if (this.disposed) return;
    const host = this.canvas.parentElement!, ratio = Math.min(devicePixelRatio || 1, 2);
    this.allocate(Math.max(16, Math.round(host.clientWidth * ratio)), Math.max(16, Math.round(host.clientHeight * ratio)));
  }
  private prepare({ width, height, fps, signal }: { width: number; height: number; fps: number; signal: AbortSignal }) {
    if (signal.aborted) throw new DOMException("Recording cancelled", "AbortError");
    if (this.capture || this.disposed || !this.canvas.isConnected) throw new Error("The blood pool scene is not available");
    const max = this.device.limits.maxTextureDimension2D;
    if (![width, height].every(v => Number.isInteger(v) && v >= 16 && v <= Math.min(8192, max)) || width * height > 33_554_432 || !Number.isFinite(fps) || fps <= 0 || fps > 60)
      throw new Error("Unsupported recording dimensions");
    this.capture = true; this.canvas.dataset.sceneRecordingActive = "true";
    const oldStyle = this.canvas.style.cssText;
    const layout = () => {
      const host = this.canvas.parentElement!, scale = Math.min(host.clientWidth / width, host.clientHeight / height);
      Object.assign(this.canvas.style, { width: `${width * scale}px`, height: `${height * scale}px`, position: "absolute",
        left: `${(host.clientWidth - width * scale) / 2}px`, top: `${(host.clientHeight - height * scale) / 2}px` });
    };
    const observer = new ResizeObserver(layout); observer.observe(this.canvas.parentElement!);
    let restored = false;
    const restore = () => {
      if (restored) return; restored = true; this.capture = false; this.release = undefined;
      observer.disconnect(); this.canvas.style.cssText = oldStyle; delete this.canvas.dataset.sceneRecordingActive;
      signal.removeEventListener("abort", restore); if (!this.disposed) this.resize();
    };
    this.release = restore;
    try { this.allocate(width, height); layout(); signal.addEventListener("abort", restore, { once: true }); return { restore }; }
    catch (error) { restore(); throw error; }
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    try { this.release?.(); } catch { /* recording restore is best effort during teardown */ }
    this.unregister?.(); this.observer?.disconnect();
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) this.canvas.removeEventListener(type, this.pointer);
    this.canvas.removeEventListener("wheel", this.wheel); this.canvas.removeEventListener("keydown", this.key);
    this.canvas.removeEventListener("contextmenu", this.contextMenu);
    try { this.context.unconfigure(); } catch { /* context may already be lost */ }
    this.device.destroy();
  }
}
