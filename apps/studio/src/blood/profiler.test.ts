import { afterEach, describe, expect, it, vi } from "vitest";
import { BloodGpuProfiler } from "./profiler";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** API-level fake: copies happen when the caller submits, maps wait for permission.
 * Tests exercise the bounded resource protocol, not GPU timing accuracy.
 */
function gpu(options: { supported?: boolean; allocationError?: string; mapError?: string; delayMap?: boolean } = {}) {
  vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 512 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
  const loss = deferred<GPUDeviceLostInfo>();
  const scopeErrors: (GPUError | null)[] = [];
  const allocations: { descriptor: GPUBufferDescriptor; data: ArrayBuffer; buffer: GPUBuffer; gate: ReturnType<typeof deferred<void>> }[] = [];
  const queries: GPUQuerySet[] = [];
  const device = {
    features: new Set(options.supported === false ? [] : ["timestamp-query"]),
    lost: loss.promise,
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => scopeErrors.shift() ?? null),
    createQuerySet: vi.fn((descriptor: GPUQuerySetDescriptor) => {
      const query = { ...descriptor, destroy: vi.fn() } as unknown as GPUQuerySet;
      queries.push(query); return query;
    }),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      if (options.allocationError) throw new Error(options.allocationError);
      const data = new ArrayBuffer(Number(descriptor.size)), gate = deferred<void>();
      const buffer = {
        mapAsync: vi.fn(async () => {
          if (options.mapError) throw new Error(options.mapError);
          if (options.delayMap) await gate.promise;
        }),
        getMappedRange: vi.fn((offset = 0, size = data.byteLength) => data.slice(offset, offset + size)),
        unmap: vi.fn(), destroy: vi.fn(),
      } as unknown as GPUBuffer;
      allocations.push({ descriptor, data, buffer, gate }); return buffer;
    }),
    queue: { submit: vi.fn(), onSubmittedWorkDone: vi.fn() },
  } as unknown as GPUDevice;
  const timestamps: bigint[] = [];
  const operations: (() => void)[] = [];
  const encoder = {
    resolveQuerySet: vi.fn((_query: GPUQuerySet, _first: number, count: number, target: GPUBuffer) => {
      operations.push(() => {
        const record = allocations.find(value => value.buffer === target)!;
        new BigUint64Array(record.data).set(timestamps.slice(0, count));
      });
    }),
    copyBufferToBuffer: vi.fn((source: GPUBuffer, sourceOffset: number, target: GPUBuffer, targetOffset: number, size: number) => {
      operations.push(() => {
        const from = allocations.find(value => value.buffer === source)!;
        const to = allocations.find(value => value.buffer === target)!;
        new Uint8Array(to.data, targetOffset, size).set(new Uint8Array(from.data, sourceOffset, size));
      });
    }),
  } as unknown as GPUCommandEncoder;
  return {
    device, encoder, queries, allocations, loss, scopeErrors, timestamps,
    submit() { for (const operation of operations.splice(0)) operation(); },
    readbacks() { return allocations.filter(value => (Number(value.descriptor.usage) & 1) !== 0); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("optional blood GPU timestamp profiler", () => {
  it("does not allocate or encode anything on devices without the feature", async () => {
    const fake = gpu({ supported: false }), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    expect(profiler.supported).toBe(false);
    expect(profiler.status.state).toBe("unsupported");
    expect(profiler.acquire()).toBeUndefined();
    expect(profiler.bufferBytes).toBe(0);
    expect(fake.device.createBuffer).not.toHaveBeenCalled();
    expect(fake.device.createQuerySet).not.toHaveBeenCalled();
    profiler.dispose(); profiler.dispose();
  });

  it("preallocates independent slots with valid query resolve and readback usages", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device, { slots: 2, maxPasses: 5 });
    expect(profiler.acquire()).toBeUndefined();
    await profiler.ready;
    expect(profiler.status.state).toBe("ready");
    expect(profiler.bufferBytes).toBe(1024);
    expect(fake.queries).toHaveLength(2);
    expect(fake.allocations.map(value => [value.descriptor.size, value.descriptor.usage])).toEqual([[256, 516], [256, 9], [256, 516], [256, 9]]);
    const first = profiler.acquire(1)!, second = profiler.acquire(2)!;
    expect(first.pass("solve")!.querySet).not.toBe(second.pass("solve")!.querySet);
    const count = fake.allocations.length;
    first.cancel(); second.cancel();
    for (let i = 0; i < 10; ++i) profiler.acquire()?.cancel();
    expect(fake.allocations).toHaveLength(count);
    profiler.dispose();
    for (const resource of [...fake.queries, ...fake.allocations.map(value => value.buffer)]) expect(resource.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([{ slots: 0 }, { slots: 9 }, { slots: 1.5 }, { maxPasses: 0 }, { maxPasses: 257 }, { maxPasses: NaN }])("rejects unbounded options %j", options => {
    expect(() => new BloodGpuProfiler(gpu().device, options)).toThrow(RangeError);
  });

  it("skips busy slots immediately without allocations, queue fences, or lost serials", async () => {
    const fake = gpu({ delayMap: true }), profiler = new BloodGpuProfiler(fake.device, { slots: 1 });
    await profiler.ready;
    const frame = profiler.acquire(41)!;
    frame.pass("solver"); frame.resolve(fake.encoder); fake.timestamps.push(100n, 200n); fake.submit();
    const pending = frame.submit();
    expect(profiler.acquire(42)).toBeUndefined();
    expect(profiler.status).toMatchObject({ pending: 1, skippedSubmissions: 1 });
    expect(fake.device.queue.submit).not.toHaveBeenCalled();
    expect(fake.device.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
    fake.readbacks()[0]!.gate.resolve();
    expect((await pending).serial).toBe(41);
    const next = profiler.acquire()!;
    expect(next.serial).toBe(43);
    next.cancel(); profiler.dispose();
  });

  it("subtracts 64-bit timestamps before conversion and sums repeated phase labels", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const frame = profiler.acquire(7)!;
    expect(frame.pass("density")).toMatchObject({ beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    frame.pass("render"); frame.pass("density"); frame.pass("__proto__");
    const base = 2n ** 63n;
    fake.timestamps.push(base, base + 250001n, base + 1000000n, base + 3000000n, base + 4000000n, base + 4500000n, base + 5000000n, base + 6000000n);
    frame.resolve(fake.encoder); fake.submit();
    const result = await frame.submit();
    expect(result).toMatchObject({
      serial: 7, supported: true, status: "ok", droppedPasses: 0, measuredPassMs: 3.750001,
      timingModel: "non-overlapping-pass-intervals", overlappingPasses: 0, gpuSpanMs: 6,
    });
    expect(result.phaseMs.density).toBeCloseTo(.750001, 9);
    expect(result.phaseMs.render).toBe(2);
    expect(result.phaseMs.__proto__).toBe(1);
    expect(result.passes).toHaveLength(4);
    expect(result.passes[2]).toEqual({ label: "density", milliseconds: .5, beginOffsetMs: 4, endOffsetMs: 4.5 });
    expect(profiler.status.pending).toBe(0);
    profiler.dispose();
  });

  it("reports cumulative Metal-style intervals without adding them into GPU time", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const frame = profiler.acquire(8)!, base = 2n ** 63n;
    const durationsMs = [.9, 1.3, 11, 20, 29, 39, 39, 40];
    for (const duration of durationsMs) {
      frame.pass("render");
      fake.timestamps.push(base, base + BigInt(Math.round(duration * 1e6)));
    }
    frame.resolve(fake.encoder); fake.submit();
    const result = await frame.submit();
    expect(result).toMatchObject({
      status: "ok", timingModel: "overlapping-pass-intervals", overlappingPasses: 7,
      gpuSpanMs: 40, measuredPassMs: null,
    });
    expect(result.phaseMs.render).toBeCloseTo(180.2, 9);
    expect(result.passes.map(pass => [pass.beginOffsetMs, pass.endOffsetMs])).toEqual(durationsMs.map(duration => [0, duration]));
    profiler.dispose();
  });

  it("detects overlap against all preceding intervals, even after a nested interval ends", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const frame = profiler.acquire()!;
    for (const label of ["outer", "inner", "still-inside", "touching"]) frame.pass(label);
    fake.timestamps.push(0n, 10000000n, 1000000n, 2000000n, 3000000n, 4000000n, 10000000n, 11000000n);
    frame.resolve(fake.encoder); fake.submit();
    expect(await frame.submit()).toMatchObject({
      timingModel: "overlapping-pass-intervals", overlappingPasses: 2, gpuSpanMs: 11, measuredPassMs: null,
    });
    profiler.dispose();
  });

  it("does not flag touching quantized interval endpoints as overlap", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const frame = profiler.acquire()!;
    for (const label of ["first", "second", "zero"]) frame.pass(label);
    fake.timestamps.push(1000000n, 2000000n, 2000000n, 3000000n, 3000000n, 3000000n);
    frame.resolve(fake.encoder); fake.submit();
    expect(await frame.submit()).toMatchObject({
      timingModel: "non-overlapping-pass-intervals", overlappingPasses: 0, gpuSpanMs: 2, measuredPassMs: 2,
    });
    profiler.dispose();
  });

  it("rejects an unrepresentable overall timestamp span despite individually valid intervals", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const frame = profiler.acquire()!; frame.pass("first"); frame.pass("after-reset");
    const base = BigInt(Number.MAX_SAFE_INTEGER);
    fake.timestamps.push(0n, 10n, base, base + 10n);
    frame.resolve(fake.encoder); fake.submit();
    expect(await frame.submit()).toMatchObject({
      status: "invalid", timingModel: "unavailable", gpuSpanMs: null, measuredPassMs: null, passes: [],
    });
    profiler.dispose();
  });

  it("marks capacity-limited measurements partial instead of presenting them as complete timings", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device, { maxPasses: 1 });
    await profiler.ready;
    const frame = profiler.acquire()!;
    frame.pass("first"); expect(frame.pass("unmeasured")).toBeUndefined();
    fake.timestamps.push(0n, 1000000n); frame.resolve(fake.encoder); fake.submit();
    expect(await frame.submit()).toMatchObject({ status: "partial", droppedPasses: 1, measuredPassMs: 1 });
    profiler.dispose();
  });

  it.each([[10n, 9n], [0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]])("rejects unusable duration %s to %s", async (begin, end) => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const frame = profiler.acquire()!; frame.pass("solver");
    fake.timestamps.push(begin, end); frame.resolve(fake.encoder); fake.submit();
    const result = await frame.submit();
    expect(result.status).toBe("invalid");
    expect(result.measuredPassMs).toBeNull();
    expect(result.passes).toEqual([]);
    expect(profiler.status.pending).toBe(0);
    profiler.dispose();
  });

  it("keeps valid quantized zero durations and distinguishes empty measurements", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const zero = profiler.acquire()!; zero.pass("short"); zero.resolve(fake.encoder);
    fake.timestamps.push(100n, 100n); fake.submit();
    expect(await zero.submit()).toMatchObject({ status: "ok", measuredPassMs: 0, phaseMs: { short: 0 } });
    const empty = profiler.acquire()!; empty.resolve(fake.encoder);
    expect(await empty.submit()).toMatchObject({ status: "empty", measuredPassMs: null });
    expect(fake.encoder.resolveQuerySet).toHaveBeenCalledTimes(1);
    profiler.dispose();
  });

  it("resolves and maps at most once per frame, with no timestamps added after resolve", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const frame = profiler.acquire()!; frame.pass("solver");
    fake.timestamps.push(100n, 200n);
    frame.resolve(fake.encoder); frame.resolve(fake.encoder);
    expect(frame.pass("late")).toBeUndefined();
    fake.submit();
    const first = frame.submit(), second = frame.submit();
    expect(first).toBe(second); await first;
    expect(fake.encoder.resolveQuerySet).toHaveBeenCalledTimes(1);
    expect(fake.encoder.copyBufferToBuffer).toHaveBeenCalledTimes(1);
    expect(fake.readbacks()[0]!.buffer.mapAsync).toHaveBeenCalledTimes(1);
    profiler.dispose();
  });

  it("does not let a cancelled old frame unmap or release a reused slot", async () => {
    const fake = gpu({ delayMap: true }), profiler = new BloodGpuProfiler(fake.device, { slots: 1 });
    await profiler.ready;
    const old = profiler.acquire()!; old.pass("discarded"); old.cancel();
    const current = profiler.acquire()!; current.pass("active"); current.resolve(fake.encoder);
    fake.timestamps.push(10n, 20n); fake.submit();
    const pending = current.submit();
    expect((await old.submit()).status).toBe("cancelled");
    old.cancel();
    expect(fake.readbacks()[0]!.buffer.unmap).not.toHaveBeenCalled();
    expect(profiler.acquire()).toBeUndefined();
    fake.readbacks()[0]!.gate.resolve();
    expect((await pending).status).toBe("ok");
    expect(fake.readbacks()[0]!.buffer.unmap).toHaveBeenCalledTimes(1);
    profiler.dispose();
  });

  it("holds a cancelled submitted slot until readback finishes", async () => {
    const fake = gpu({ delayMap: true }), profiler = new BloodGpuProfiler(fake.device, { slots: 1 });
    await profiler.ready;
    const frame = profiler.acquire()!; frame.pass("solver"); frame.resolve(fake.encoder); fake.submit();
    const pending = frame.submit(); frame.cancel();
    expect(profiler.acquire()).toBeUndefined();
    fake.readbacks()[0]!.gate.resolve();
    expect((await pending).status).toBe("cancelled");
    profiler.acquire()!.cancel(); profiler.dispose();
  });

  it("contains map failures and releases the slot without unhandled rejection", async () => {
    const fake = gpu({ mapError: "mapping failed" }), profiler = new BloodGpuProfiler(fake.device, { slots: 1 });
    await profiler.ready;
    const frame = profiler.acquire()!; frame.pass("solver"); frame.resolve(fake.encoder); fake.submit();
    expect(await frame.submit()).toMatchObject({ status: "error", error: "mapping failed" });
    expect(profiler.status.pending).toBe(0);
    profiler.acquire()!.cancel(); profiler.dispose();
  });

  it("contains allocation failure and destroys resources already allocated", async () => {
    const fake = gpu({ allocationError: "out of memory" }), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    expect(profiler.status).toMatchObject({ state: "error", reason: "out of memory" });
    expect(profiler.acquire()).toBeUndefined();
    expect(fake.queries[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(fake.device.popErrorScope).toHaveBeenCalledTimes(2);
    profiler.dispose();
    expect(fake.queries[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it("contains asynchronous allocation validation errors before acquisition", async () => {
    const fake = gpu(); fake.scopeErrors.push({ message: "allocation validation" } as GPUError);
    const profiler = new BloodGpuProfiler(fake.device); await profiler.ready;
    expect(profiler.status.state).toBe("error");
    expect(profiler.acquire()).toBeUndefined();
    expect(fake.allocations.every(value => vi.mocked(value.buffer.destroy).mock.calls.length === 1)).toBe(true);
    profiler.dispose();
  });

  it("disposes during pending readback without publishing or reusing destroyed resources", async () => {
    const fake = gpu({ delayMap: true }), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const frame = profiler.acquire()!; frame.pass("solver"); frame.resolve(fake.encoder); fake.submit();
    const pending = frame.submit(); profiler.dispose(); profiler.dispose();
    fake.readbacks()[0]!.gate.resolve();
    expect((await pending).status).toBe("disposed");
    expect(profiler.acquire()).toBeUndefined();
    expect(profiler.status.pending).toBe(0);
    for (const resource of [...fake.queries, ...fake.allocations.map(value => value.buffer)]) expect(resource.destroy).toHaveBeenCalledTimes(1);
  });

  it("disables safely on device loss and reports the reason", async () => {
    const fake = gpu(), profiler = new BloodGpuProfiler(fake.device);
    await profiler.ready;
    const frame = profiler.acquire()!; frame.pass("solver"); frame.resolve(fake.encoder);
    fake.loss.resolve({ reason: "unknown", message: "device disconnected" } as GPUDeviceLostInfo);
    await Promise.resolve();
    expect(profiler.status).toMatchObject({ state: "lost", reason: "device disconnected", pending: 0 });
    expect((await frame.submit()).status).toBe("error");
    expect(profiler.acquire()).toBeUndefined();
    profiler.dispose();
  });
});
