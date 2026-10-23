/// <reference types="@webgpu/types" />

/** Optional diagnostics only: the profiler never submits work or changes solver state.
 * Pass timestamps and readback follow the standard WebGPU API:
 * https://developer.chrome.com/blog/new-in-webgpu-121#timestamp_queries_in_compute_and_render_passes
 * Timestamp resolution is implementation-dependent; zero-duration samples are valid.
 * Some backends produce overlapping or cumulative intervals. Those durations must
 * not be added or described as exclusive pass costs; inspect timingModel/gpuSpanMs.
 */
export interface BloodGpuTimingReport {
  serial: number;
  supported: boolean;
  status: "ok" | "partial" | "empty" | "cancelled" | "disposed" | "error" | "invalid";
  timingModel: "non-overlapping-pass-intervals" | "overlapping-pass-intervals" | "unavailable";
  /** Count of intervals beginning before the maximum end of a preceding interval. */
  overlappingPasses: number;
  /** Earliest measured beginning to latest measured end, including inter-pass gaps.
   * This timestamp span excludes CPU encoding, readback and queue latency.
   */
  gpuSpanMs: number | null;
  /** Sum of measured pass intervals ONLY when they do not overlap, otherwise null.
   * Excludes inter-pass gaps, copies and queue latency. Not an exclusive-cost estimate.
   */
  measuredPassMs: number | null;
  /** Interval-duration sums by label, NOT exclusive costs. Non-additive when
   * timingModel is overlapping-pass-intervals; never sum these to estimate GPU time.
   */
  phaseMs: Record<string, number>;
  /** Raw observed interval endpoints relative to the earliest measured beginning.
   * milliseconds is endOffsetMs - beginOffsetMs, not an exclusive execution cost.
   */
  passes: { label: string; milliseconds: number; beginOffsetMs: number; endOffsetMs: number }[];
  droppedPasses: number;
  error?: string;
}

export interface BloodGpuTimingFrame {
  readonly serial: number;
  /** Apply each returned descriptor to exactly one compute or render pass. */
  pass(label: string): GPUComputePassTimestampWrites | undefined;
  /** Call once after all timed passes, before finishing the command encoder. */
  resolve(encoder: GPUCommandEncoder): void;
  /** Call AFTER queue.submit; starts asynchronous readback, never submits or waits on the queue. */
  submit(): Promise<BloodGpuTimingReport>;
  /** Before submission, cancellation requires discarding the associated command encoder.
   * After submit(), the slot remains occupied until pending readback settles.
   */
  cancel(): void;
}

interface Slot {
  queries: GPUQuerySet;
  resolve: GPUBuffer;
  readback: GPUBuffer;
  lease: number;
}

export interface BloodGpuProfilerOptions {
  slots?: number;
  maxPasses?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bounded, preallocated query/readback ring. When all slots are occupied, acquire()
 * immediately skips profiling. Await ready once at initialization, never inside a frame.
 * A device must have been requested with the optional "timestamp-query" feature.
 */
export class BloodGpuProfiler {
  readonly supported: boolean;
  readonly ready: Promise<void>;
  readonly capacity: number;
  readonly maxPasses: number;
  /** GPU buffer bytes only; query-set storage is implementation-dependent. */
  readonly bufferBytes: number;
  private slots: Slot[] = [];
  private resources: (GPUBuffer | GPUQuerySet)[] = [];
  private stateValue: "unsupported" | "initializing" | "ready" | "error" | "lost" | "disposed";
  private reasonValue: string | undefined;
  private serial = 0;
  private lease = 0;
  private skipped = 0;

  constructor(device: GPUDevice, options: BloodGpuProfilerOptions = {}) {
    this.capacity = options.slots ?? 3;
    this.maxPasses = options.maxPasses ?? 64;
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 8) throw new RangeError("Profiler slots must be an integer from 1 to 8");
    if (!Number.isInteger(this.maxPasses) || this.maxPasses < 1 || this.maxPasses > 256) throw new RangeError("Profiler maxPasses must be an integer from 1 to 256");
    this.supported = device.features.has("timestamp-query");
    this.stateValue = this.supported ? "initializing" : "unsupported";
    const bytes = Math.ceil(this.maxPasses * 16 / 256) * 256;
    this.bufferBytes = this.supported ? this.capacity * bytes * 2 : 0;
    if (!this.supported) {
      this.reasonValue = "The device does not enable timestamp-query";
      this.ready = Promise.resolve();
      return;
    }

    // Pop scopes synchronously, so the caller's asynchronous initialization scopes
    // cannot become interleaved with ours. Allocation failures disable diagnostics.
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    try {
      for (let i = 0; i < this.capacity; ++i) {
        const queries = device.createQuerySet({ label: `blood/timestamps/${i}`, type: "timestamp", count: this.maxPasses * 2 });
        this.resources.push(queries);
        const resolve = device.createBuffer({ label: `blood/timestamp-resolve/${i}`, size: bytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
        this.resources.push(resolve);
        const readback = device.createBuffer({ label: `blood/timestamp-readback/${i}`, size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        this.resources.push(readback);
        this.slots.push({ queries, resolve, readback, lease: 0 });
      }
    } catch (error) {
      this.disable("error", message(error));
    }
    const validation = device.popErrorScope(), memory = device.popErrorScope();
    this.ready = Promise.all([validation, memory]).then(errors => {
      if (this.stateValue !== "initializing") return;
      const error = errors.find(Boolean);
      if (error) this.disable("error", error.message);
      else this.stateValue = "ready";
    }).catch(error => {
      if (this.stateValue === "initializing") this.disable("error", message(error));
    });
    void device.lost.then(info => {
      if (this.stateValue !== "disposed") this.disable("lost", info.message || info.reason);
    }).catch(error => {
      if (this.stateValue !== "disposed") this.disable("lost", message(error));
    });
  }

  get status() {
    return {
      supported: this.supported, state: this.stateValue, reason: this.reasonValue,
      pending: this.slots.filter(slot => slot.lease !== 0).length,
      skippedSubmissions: this.skipped, capacity: this.capacity, maxPasses: this.maxPasses,
    };
  }

  acquire(serial = this.serial + 1): BloodGpuTimingFrame | undefined {
    if (this.stateValue !== "ready") return undefined;
    if (!Number.isSafeInteger(serial) || serial < 0) throw new RangeError("Profiler serial must be a non-negative safe integer");
    this.serial = Math.max(this.serial, serial);
    const slot = this.slots.find(candidate => candidate.lease === 0);
    if (!slot) { ++this.skipped; return undefined; }
    const lease = ++this.lease;
    slot.lease = lease;
    const labels: string[] = [];
    let state: "recording" | "resolved" | "submitted" | "finished" = "recording";
    let cancelled = false, droppedPasses = 0, errorMessage: string | undefined;
    let promise: Promise<BloodGpuTimingReport> | undefined;
    const release = () => { if (slot.lease === lease) slot.lease = 0; state = "finished"; };
    const report = (status: BloodGpuTimingReport["status"], error?: string): BloodGpuTimingReport => ({
      serial, supported: this.supported, status, timingModel: "unavailable", overlappingPasses: 0,
      gpuSpanMs: null, measuredPassMs: null, phaseMs: {}, passes: [], droppedPasses,
      ...(error === undefined ? {} : { error }),
    });
    const unavailable = () => this.stateValue !== "ready";
    const read = async (): Promise<BloodGpuTimingReport> => {
      try {
        if (cancelled) return report("cancelled");
        if (unavailable()) return report(this.stateValue === "disposed" ? "disposed" : "error", this.reasonValue);
        if (errorMessage) return report("error", errorMessage);
        if (state !== "resolved") return report("error", "resolve() must precede submit()");
        state = "submitted";
        if (!labels.length) return report("empty");
        // mapAsync itself waits for the preceding copy. No queue-wide fence is needed.
        await slot.readback.mapAsync(GPUMapMode.READ, 0, labels.length * 16);
        if (cancelled) return report("cancelled");
        if (unavailable()) return report(this.stateValue === "disposed" ? "disposed" : "error", this.reasonValue);
        const times = new BigUint64Array(slot.readback.getMappedRange(0, labels.length * 16));
        const passes: BloodGpuTimingReport["passes"] = [];
        // Null prototype also makes arbitrary diagnostic labels such as "__proto__" safe.
        const phaseMs: Record<string, number> = Object.create(null);
        let minimumBegin = times[0]!, maximumEnd = times[1]!;
        const maximumDelta = BigInt(Number.MAX_SAFE_INTEGER);
        for (let i = 0; i < labels.length; ++i) {
          const begin = times[2 * i]!, end = times[2 * i + 1]!, delta = end - begin;
          if (delta < 0n || delta > maximumDelta) {
            return report("invalid", "GPU timestamps reset or produced an invalid duration; sample discarded");
          }
          if (begin < minimumBegin) minimumBegin = begin;
          if (end > maximumEnd) maximumEnd = end;
        }
        const span = maximumEnd - minimumBegin;
        if (span > maximumDelta) return report("invalid", "GPU timestamps produced an invalid span; sample discarded");
        let measuredPassMs = 0, overlappingPasses = 0, previousMaximumEnd = times[1]!;
        for (let i = 0; i < labels.length; ++i) {
          const begin = times[2 * i]!, end = times[2 * i + 1]!, delta = end - begin;
          if (i > 0 && begin < previousMaximumEnd) ++overlappingPasses;
          if (end > previousMaximumEnd) previousMaximumEnd = end;
          const milliseconds = Number(delta) / 1e6, label = labels[i]!;
          passes.push({ label, milliseconds, beginOffsetMs: Number(begin - minimumBegin) / 1e6, endOffsetMs: Number(end - minimumBegin) / 1e6 });
          phaseMs[label] = (phaseMs[label] ?? 0) + milliseconds;
          measuredPassMs += milliseconds;
        }
        return {
          serial, supported: this.supported, status: droppedPasses ? "partial" : "ok",
          timingModel: overlappingPasses ? "overlapping-pass-intervals" : "non-overlapping-pass-intervals",
          overlappingPasses, gpuSpanMs: Number(span) / 1e6, measuredPassMs: overlappingPasses ? null : measuredPassMs,
          phaseMs, passes, droppedPasses,
        };
      } catch (error) {
        if (cancelled) return report("cancelled");
        return report(this.stateValue === "disposed" ? "disposed" : "error", message(error));
      } finally {
        // unmap also aborts pending maps. Destroyed/lost devices may reject it.
        try { if (slot.lease === lease) slot.readback.unmap(); } catch { /* Optional diagnostics must not fail the solver. */ }
        release();
      }
    };
    return {
      serial,
      pass: label => {
        if (state !== "recording" || unavailable() || cancelled) return undefined;
        if (labels.length >= this.maxPasses) { ++droppedPasses; return undefined; }
        const index = labels.length * 2;
        labels.push(label);
        return { querySet: slot.queries, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 };
      },
      resolve: encoder => {
        if (state !== "recording" || cancelled) return;
        state = "resolved";
        if (unavailable() || !labels.length) return;
        try {
          const count = labels.length * 2;
          encoder.resolveQuerySet(slot.queries, 0, count, slot.resolve, 0);
          encoder.copyBufferToBuffer(slot.resolve, 0, slot.readback, 0, count * 8);
        } catch (error) { errorMessage = message(error); }
      },
      submit: () => promise ??= read(),
      cancel: () => {
        if (state === "finished") return;
        cancelled = true;
        if (state !== "submitted") release();
      },
    };
  }

  private disable(state: "error" | "lost" | "disposed", reason?: string) {
    this.stateValue = state;
    this.reasonValue = reason;
    for (const resource of this.resources.splice(0)) {
      try { resource.destroy(); } catch { /* Already lost or destroyed. */ }
    }
    for (const slot of this.slots) slot.lease = 0;
  }

  dispose() {
    if (this.stateValue !== "disposed") this.disable("disposed", "GPU profiler disposed");
  }
}
