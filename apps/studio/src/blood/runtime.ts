/// <reference types="@webgpu/types" />
import { boundaryState, initialState, sceneHash, validateScene, type BloodScene } from "./scene";
import { solverShader } from "./shaders";

export interface BloodReport {
  configHash: string; acceptedStep: number; acceptedTimeSeconds: number; attempt: number;
  inputCursor: number; halted: boolean; failureBits: number; densityResidual: number;
  divergenceResidualS: number; densityEvaluations: number; divergenceEvaluations: number;
  submission: number; measurementStep: number; wallSeconds: number;
}
export const FAILURE_NAMES: Record<number, string> = {
  2: "Particle left the validated periodic domain", 4: "Velocity or travel limit exceeded",
  8: "Accepted-step counter limit", 16: "Density solve did not converge", 32: "Final density error exceeded 1%",
  64: "Divergence solve did not converge", 128: "Deliberate transaction test rejection",
  256: "Solid-wall crossing detected",
  512: "Fluid reached the open top of this bounded test domain",
};
export function failureMessage(bits: number): string {
  return Object.entries(FAILURE_NAMES).filter(([bit]) => (bits & Number(bit)) !== 0).map(([, text]) => text).join("; ");
}
export interface Allocation { name: string; bytes: number; }
export interface BloodRuntimeOptions {
  skipInactive?: boolean; neighborProbe?: boolean; signal?: AbortSignal;
  /** Reference paths remain available for same-input regression measurements. */
  optimizedSort?: boolean; localMerge?: boolean; compactPressure?: boolean; profiling?: boolean;
}
export class BloodRuntime {
  readonly scene: BloodScene;
  readonly device: GPUDevice;
  readonly adapterInfo: { vendor: string; architecture: string; description: string };
  readonly configHash: string;
  readonly accepted: GPUBuffer;
  readonly ids: GPUBuffer;
  readonly allocationLedger: Allocation[] = [];
  readonly count: number;
  readonly boundary: GPUBuffer;
  readonly totalSamples: number;
  readonly gridCells: number;
  readonly neighborBits: GPUBuffer;
  readonly errors: string[] = [];
  readonly candidate: GPUBuffer;
  readonly spatial: GPUBuffer;
  readonly work: GPUBuffer;
  readonly control: GPUBuffer;
  private resources: GPUBuffer[] = [];
  private pipelines = new Map<string, GPUComputePipeline>();
  private stages: { group: GPUBindGroup; local: boolean }[] = [];
  private base!: GPUBindGroup;
  private readbacks: { buffer: GPUBuffer; busy: boolean }[] = [];
  private inFlight = 0;
  private disposed = false;
  private submitted = 0;
  private started = performance.now();
  private latest: BloodReport | undefined;
  onReport: ((report: BloodReport) => void) | undefined;
  onError: ((message: string) => void) | undefined;
  private constructor(device: GPUDevice, info: GPUAdapterInfo, scene: BloodScene, hash: string, private skipInactive: boolean, probe: boolean,
    private optimizedSort = false, private compactPressure = false, private localMerge = false) {
    this.device = device; this.scene = scene; this.configHash = hash; this.count = scene.axis ** 3;
    this.adapterInfo = { vendor: info.vendor, architecture: info.architecture, description: info.description };
    const boundaries = boundaryState(scene);
    this.totalSamples = this.count + boundaries.length / 4;
    this.gridCells = scene.fixture === "dam" ? scene.axis : scene.axis / 2;
    const n = this.count, sorted = 2 ** Math.ceil(Math.log2(this.totalSamples)), groups = Math.ceil(n / 64);
    this.accepted = this.buffer("accepted position/mass + velocity", n * 32);
    this.candidate = this.buffer("candidate position/mass + velocity", n * 32);
    this.ids = this.buffer("canonical u32 IDs", n * 4);
    this.work = this.buffer("velocity ping-pong, factors, coefficients, residual reduction", Math.ceil((40 * n + 4 * groups) / 16) * 16);
    this.spatial = this.buffer("sorted index pairs and cell directory", sorted * 8 + this.gridCells ** 3 * 8);
    this.boundary = this.buffer("fixed solid-volume boundary samples", Math.max(16, boundaries.byteLength));
    this.neighborBits = this.buffer("N01 optional exact neighbor bitsets", probe ? n * Math.ceil(this.totalSamples / 32) * 4 : 16);
    this.control = this.buffer("transaction and telemetry controls", 256);
    this.readbacks = [0, 1, 2].map(index => ({ buffer: this.buffer(`telemetry staging ${index}`, 256, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST), busy: false }));
    device.queue.writeBuffer(this.accepted, 0, initialState(scene));
    device.queue.writeBuffer(this.ids, 0, Uint32Array.from({ length: n }, (_, i) => i));
    if (boundaries.byteLength) device.queue.writeBuffer(this.boundary, 0, boundaries);
    device.addEventListener("uncapturederror", event => this.fail(event.error.message));
    void device.lost.then(info => { if (!this.disposed) this.fail(`GPU device lost: ${info.message || info.reason}. Reset the lab to recover.`); });
  }
  static async create(scene: BloodScene, options: BloodRuntimeOptions = {}): Promise<BloodRuntime> {
    const valid = validateScene(scene), hash = await sceneHash(valid);
    options.signal?.throwIfAborted();
    if (!navigator.gpu) throw new Error("This lab needs WebGPU in a secure browser context. Use an up-to-date browser with WebGPU support.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    options.signal?.throwIfAborted();
    if (!adapter) throw new Error("No WebGPU adapter is available. The other VISCERA workspaces remain available.");
    const device = await adapter.requestDevice({ requiredFeatures: options.profiling && adapter.features.has("timestamp-query") ? ["timestamp-query"] : [] });
    let runtime: BloodRuntime | undefined;
    try {
      options.signal?.throwIfAborted();
      runtime = new BloodRuntime(device, adapter.info, valid, hash, options.skipInactive ?? true, options.neighborProbe ?? false,
        options.optimizedSort ?? true, options.compactPressure ?? true, options.localMerge ?? true);
      await runtime.initialize();
      options.signal?.throwIfAborted();
      return runtime;
    } catch (error) { runtime?.dispose(); device.destroy(); throw error; }
  }
  private fail(message: string) { this.errors.push(message); this.onError?.(message); }
  private buffer(name: string, bytes: number, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST): GPUBuffer {
    if (bytes > this.device.limits.maxBufferSize || ((usage & GPUBufferUsage.STORAGE) && bytes > this.device.limits.maxStorageBufferBindingSize)) throw new Error(`GPU allocation exceeds device limit: ${name}`);
    this.allocationLedger.push({ name, bytes });
    const buffer = this.device.createBuffer({ label: `blood/${name}`, size: bytes, usage });
    this.resources.push(buffer); return buffer;
  }
  private async initialize() {
    const device = this.device;
    device.pushErrorScope("validation");
    const module = device.createShaderModule({ label: "blood/DFSPH-BK17", code: solverShader(this.scene, this.skipInactive, this.optimizedSort, this.compactPressure) });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter(m => m.type === "error");
    if (errors.length) { await device.popErrorScope(); throw new Error(errors.map(e => `${e.lineNum}: ${e.message}`).join("\n")); }
    const bindings: GPUBindGroupLayoutEntry[] = [
      ...[0, 1, 2, 3, 4].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } })),
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ];
    const layout = device.createBindGroupLayout({ entries: bindings });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const names = ["begin", "seed", "keys", "sort", "clearRanges", "ranges", "geometry", "predict", "copyVelocity",
      "densityResidual", "divergenceResidual", "densityCorrect", "divergenceCorrect", "reduce", "densityGate",
      "divergenceGate", "endDensity", "advect", "finalGuard", "decide", "commit", "publish", "rejectFixture", "neighborProbe"];
    if (this.optimizedSort) names.push("sortLocal", "sortLocalMerge");
    if (this.compactPressure) names.push("densityReduceGate", "divergenceReduceGate");
    await Promise.all(names.map(async entryPoint => {
      this.pipelines.set(entryPoint, await device.createComputePipelineAsync({ label: `blood/${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint } }));
    }));
    const stages: number[][] = [[0, 0, 0, 0]], sorted = 2 ** Math.ceil(Math.log2(this.totalSamples));
    for (let k = this.optimizedSort ? 512 : 2; k <= sorted; k *= 2) {
      for (let j = k / 2; j > 0; j /= 2) {
        if (this.optimizedSort && this.localMerge && j < 256) { stages.push([j, k, 1, 0]); break; }
        stages.push([j, k, 0, 0]);
      }
    }
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    const parameters = this.buffer("immutable sort parameters", stages.length * alignment, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const bytes = new Uint32Array(stages.length * alignment / 4);
    stages.forEach((stage, i) => bytes.set(stage, i * alignment / 4)); device.queue.writeBuffer(parameters, 0, bytes);
    const stateBuffers = [this.accepted, this.candidate, this.work, this.spatial, this.control];
    const groups = stages.map((_, i) => device.createBindGroup({ layout, entries: [
      ...stateBuffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      { binding: 5, resource: { buffer: parameters, offset: i * alignment, size: 16 } },
      { binding: 6, resource: { buffer: this.ids } },
      { binding: 7, resource: { buffer: this.boundary } },
      { binding: 8, resource: { buffer: this.neighborBits } },
    ] }));
    this.base = groups[0]!; this.stages = groups.slice(1).map((group, i) => ({ group, local: stages[i + 1]![2] === 1 }));
    const error = await device.popErrorScope(); if (error) throw new Error(error.message);
  }
  private dispatch(pass: GPUComputePassEncoder, name: string, count = this.count, group = this.base) {
    pass.setPipeline(this.pipelines.get(name)!); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(count / (name === "sortLocal" || name === "sortLocalMerge" ? 256 : ["begin", "densityGate", "divergenceGate", "endDensity", "decide", "publish", "rejectFixture"].includes(name) ? 1 : 64)));
  }
  private geometry(pass: GPUComputePassEncoder) {
    this.dispatch(pass, "keys", 2 ** Math.ceil(Math.log2(this.totalSamples)));
    if (this.optimizedSort) this.dispatch(pass, "sortLocal", 2 ** Math.ceil(Math.log2(this.totalSamples)));
    for (const stage of this.stages) this.dispatch(pass, stage.local ? "sortLocalMerge" : "sort", 2 ** Math.ceil(Math.log2(this.totalSamples)), stage.group);
    this.dispatch(pass, "clearRanges", this.gridCells ** 3);
    this.dispatch(pass, "ranges", this.totalSamples); this.dispatch(pass, "geometry");
  }
  /** Isolated N01 fixture: geometry only; no accepted state or clock mutation. */
  encodeGeometryFixture(encoder: GPUCommandEncoder) {
    const pass = encoder.beginComputePass();
    this.dispatch(pass, "seed"); this.geometry(pass); this.dispatch(pass, "neighborProbe"); pass.end();
  }
  /** Bench-only: input candidate positions + workspace velocities, no commit. */
  encodeContactFixture(encoder: GPUCommandEncoder) {
    const pass = encoder.beginComputePass();
    this.dispatch(pass, "copyVelocity"); pass.end();
  }
  private residual(pass: GPUComputePassEncoder, kind: "density" | "divergence") {
    this.dispatch(pass, `${kind}Residual`);
    if (this.compactPressure) this.dispatch(pass, `${kind}ReduceGate`, 64);
    else { this.dispatch(pass, "reduce"); this.dispatch(pass, `${kind}Gate`, 1); }
  }
  encodeAttempt(encoder: GPUCommandEncoder, rejectFixture = false, profile?: { pass(label: string): GPUComputePassTimestampWrites | undefined }) {
    const begin = (name: string) => {
      const timestampWrites = profile?.pass(name);
      return encoder.beginComputePass({ label: `blood/${name}`, ...(timestampWrites ? { timestampWrites } : {}) });
    };
    let pass = begin("prepare-and-geometry");
    const phase = (name: string) => { if (profile) { pass.end(); pass = begin(name); } };
    this.dispatch(pass, "begin", 1); this.dispatch(pass, "seed"); this.geometry(pass);
    phase("density-solve");
    this.dispatch(pass, "predict"); this.dispatch(pass, "copyVelocity");
    this.residual(pass, "density");
    for (let i = 0; i < this.scene.iterations; ++i) {
      this.dispatch(pass, "densityCorrect"); if (!this.compactPressure) this.dispatch(pass, "copyVelocity"); this.residual(pass, "density");
    }
    phase("advection-and-geometry");
    this.dispatch(pass, "endDensity", 1); this.dispatch(pass, "advect"); this.geometry(pass);
    phase("divergence-solve");
    this.residual(pass, "divergence");
    for (let i = 0; i < this.scene.iterations; ++i) {
      this.dispatch(pass, "divergenceCorrect"); if (!this.compactPressure) this.dispatch(pass, "copyVelocity"); this.residual(pass, "divergence");
    }
    phase("guard-and-commit");
    this.dispatch(pass, "finalGuard");
    if (rejectFixture) this.dispatch(pass, "rejectFixture", 1);
    this.dispatch(pass, "decide", 1); this.dispatch(pass, "commit"); this.dispatch(pass, "publish", 1);
    pass.end();
  }
  get report() { return this.latest; }
  get pendingSubmissions() { return this.inFlight; }
  get isDisposed() { return this.disposed; }
  /** Both render-only and compute submissions pass through this bounded owner. */
  submit(attempts: number, render?: (encoder: GPUCommandEncoder) => void, rejectFixture = false): Promise<void> | undefined {
    if (!Number.isInteger(attempts) || attempts < 0 || attempts > 4) throw new RangeError("A batch must contain 0–4 attempts");
    if (this.disposed || this.inFlight >= 2 || this.errors.length) return undefined;
    const encoder = this.device.createCommandEncoder({ label: "blood/batch" });
    for (let i = 0; i < attempts; ++i) this.encodeAttempt(encoder, rejectFixture && i === 0);
    render?.(encoder);
    const slot = this.readbacks.find(s => !s.busy), submission = ++this.submitted;
    if (slot) { slot.busy = true; encoder.copyBufferToBuffer(this.control, 0, slot.buffer, 0, 256); }
    ++this.inFlight;
    this.device.queue.submit([encoder.finish()]);
    const completion = this.device.queue.onSubmittedWorkDone().finally(() => { --this.inFlight; });
    if (slot) {
      void completion.then(async () => {
        if (this.disposed) return;
        await slot.buffer.mapAsync(GPUMapMode.READ);
        if (this.disposed) return;
        const data = slot.buffer.getMappedRange().slice(0); slot.buffer.unmap();
        const u = new Uint32Array(data), f = new Float32Array(data);
        const report: BloodReport = { configHash: this.configHash, acceptedStep: u[1]!,
          acceptedTimeSeconds: u[1]! * this.scene.dtSeconds, attempt: u[4]!, inputCursor: u[9]!,
          halted: u[0] !== 0, failureBits: u[5]!, densityResidual: f[6]!, divergenceResidualS: f[7]!,
          densityEvaluations: u[10]!, divergenceEvaluations: u[11]!, submission,
          measurementStep: u[1]!, wallSeconds: (performance.now() - this.started) / 1000 };
        if (!this.latest || submission > this.latest.submission) { this.latest = report; this.onReport?.(report); }
      }).catch(error => { if (!this.disposed) this.fail(String(error)); }).finally(() => { slot.busy = false; });
    }
    return completion;
  }
  /** Bench-only synchronization. Never called in the interactive solver iteration path. */
  async readBuffer(buffer: GPUBuffer): Promise<ArrayBuffer> {
    if (this.disposed) throw new Error("Runtime disposed");
    await this.device.queue.onSubmittedWorkDone();
    const staging = this.device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
      this.device.queue.submit([encoder.finish()]); await staging.mapAsync(GPUMapMode.READ);
      return staging.getMappedRange().slice(0);
    } finally { staging.destroy(); }
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const buffer of this.resources) buffer.destroy();
    this.resources = []; this.device.destroy();
  }
}
