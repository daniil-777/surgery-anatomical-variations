import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_BUDGET_BITRATE,
  RECORDING_MIME_PREFERENCE,
  RecorderBusyError,
  RecorderUnsupportedError,
  canRecordCanvas,
  chooseVideoBitrate,
  collectExperimentData,
  createCanvasRecorder,
  pickRecordingMime,
  recordingContainer,
  recordingExtension,
  recordingFilename,
  startLabRecording,
  type MediaRecorderConstructor,
  type RecorderClock,
  type RecorderState,
} from "./recorder";

class FakeTrack {
  stopped = false;
  private readonly ended: Array<() => void> = [];
  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.ended.push(listener);
  }
  stop(): void {
    this.stopped = true;
  }
  end(): void {
    for (const listener of this.ended) listener();
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
  getVideoTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeMediaRecorder {
  static supported = new Set<string>();
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.has(type);
  }
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  timeslice: number | undefined;
  /** False simulates an encoder that never reports stop. */
  reportsStop = true;
  readonly mimeType: string;
  constructor(
    readonly stream: FakeStream,
    readonly options: { mimeType?: string; videoBitsPerSecond?: number },
  ) {
    this.mimeType = options.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number): void {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  stop(): void {
    if (this.state === "inactive") throw new Error("InvalidStateError");
    this.state = "inactive";
    // the browser delivers the last chunk, then stop, as later tasks
    queueMicrotask(() => {
      this.chunk(10);
      if (this.reportsStop) this.onstop?.();
    });
  }
  chunk(bytes: number): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
  crash(withFinalChunk: boolean): void {
    this.state = "inactive";
    this.onerror?.({ error: new Error("encoder crashed") });
    queueMicrotask(() => {
      if (withFinalChunk) this.chunk(10);
      this.onstop?.();
    });
  }
}

const Recorder = FakeMediaRecorder as unknown as MediaRecorderConstructor;

function manualClock(): RecorderClock & { advance(ms: number): void } {
  let now = 1_760_000_000_000;
  let ids = 0;
  let timers: Array<{ id: number; at: number; callback: () => void }> = [];
  return {
    now: () => now,
    setTimeout(callback, ms) {
      ids += 1;
      timers.push({ id: ids, at: now + ms, callback });
      return ids;
    },
    clearTimeout(handle) {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((timer) => timer !== next);
        now = next.at;
        next.callback();
      }
      now = target;
    },
  };
}

function fakeCanvas(width = 1280, height = 720) {
  const stream = new FakeStream();
  const requested: number[] = [];
  const canvas = {
    width,
    height,
    captureStream: (fps?: number) => {
      requested.push(fps ?? -1);
      return stream;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, stream, requested };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  FakeMediaRecorder.supported = new Set(["video/webm;codecs=vp9", "video/webm"]);
  FakeMediaRecorder.instances = [];
});

describe("format choice", () => {
  it("takes the first type the browser encodes, preferring MP4/H.264", () => {
    expect(RECORDING_MIME_PREFERENCE[0]).toBe("video/mp4;codecs=avc1.640028");
    expect(pickRecordingMime((type) => type === "video/webm" || type === "video/mp4")).toBe("video/mp4");
    expect(pickRecordingMime((type) => type.startsWith("video/webm"))).toBe("video/webm;codecs=vp9");
    expect(pickRecordingMime((type) => type === "video/webm;codecs=vp8" || type === "video/x-custom", "video/x-custom")).toBe("video/x-custom");
    expect(
      pickRecordingMime((type) => {
        if (type.includes("avc1")) throw new Error("unparseable");
        return type === "video/mp4;codecs=avc3";
      }),
    ).toBe("video/mp4;codecs=avc3");
    expect(pickRecordingMime(() => false)).toBeNull();
  });

  it("names containers and extensions without codec parameters", () => {
    expect(recordingContainer("video/mp4;codecs=avc1.640028")).toBe("video/mp4");
    expect(recordingContainer("video/webm;codecs=vp9")).toBe("video/webm");
    expect(recordingExtension("video/mp4")).toBe("mp4");
    expect(recordingExtension("video/webm;codecs=vp8")).toBe("webm");
    expect(recordingFilename("viscera-scene", 1920, 1080, new Date("2026-10-21T12:34:56.789Z"), "mp4")).toBe(
      "viscera-scene-1920x1080-2026-10-21T12-34-56-789Z.mp4",
    );
  });

  it("chooses a bitrate from the frame size, lowered to fit the size budget", () => {
    const roomy = { maxBytes: 1024 ** 3, maxDurationMs: 60_000 };
    expect(chooseVideoBitrate({ width: 1920, height: 1080, fps: 30, ...roomy })).toBe(6_220_800);
    expect(chooseVideoBitrate({ width: 3840, height: 2160, fps: 60, ...roomy })).toBe(12_000_000);
    expect(chooseVideoBitrate({ width: 320, height: 240, fps: 30, ...roomy })).toBe(2_500_000);
    // the free plan's 50 MB per file over one minute: 50 MiB × 0.9 × 0.95 × 8 / 60 s
    expect(chooseVideoBitrate({ width: 1920, height: 1080, fps: 30, maxBytes: 52_428_800, maxDurationMs: 60_000 })).toBe(5_976_883);
    // ten minutes no longer fit at a watchable rate: the floor holds and the size stop ends the recording
    expect(chooseVideoBitrate({ width: 1920, height: 1080, fps: 30, maxBytes: 52_428_800, maxDurationMs: 600_000 })).toBe(MIN_BUDGET_BITRATE);
  });
});

describe("canvas recorder", () => {
  it("records with captureStream and MediaRecorder and returns a RecordingResult", async () => {
    const clock = manualClock();
    const { canvas, stream, requested } = fakeCanvas();
    const states: RecorderState[] = [];
    const recorder = createCanvasRecorder({ canvas, maxBytes: 1024 ** 3, maxDurationMs: 60_000, MediaRecorder: Recorder, clock, onState: (state) => states.push(state) });
    const instance = FakeMediaRecorder.instances[0]!;
    expect(requested).toEqual([30]);
    expect(instance.options).toEqual({ mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: chooseVideoBitrate({ width: 1280, height: 720, fps: 30, maxBytes: 1024 ** 3, maxDurationMs: 60_000 }) });
    expect(instance.timeslice).toBe(250);
    expect(states.at(-1)).toMatchObject({ phase: "recording", bytes: 0 });
    instance.chunk(1000);
    instance.chunk(0);
    instance.chunk(2000);
    expect(recorder.getState()).toMatchObject({ phase: "recording", bytes: 3000 });
    clock.advance(4_000);
    const result = await recorder.stop();
    expect(result.blob.type).toBe("video/webm");
    expect(result.blob.size).toBe(3010);
    expect(result.mimeType).toBe("video/webm;codecs=vp9");
    expect(result.extension).toBe("webm");
    expect(result.filename).toMatch(/^viscera-scene-1280x720-.+\.webm$/);
    expect(result.metrics).toMatchObject({ width: 1280, height: 720, durationMs: 4_000, bytes: 3010, stopReason: "user", requestedFps: 30 });
    expect(stream.track.stopped).toBe(true);
    expect(states.at(-1)).toMatchObject({ phase: "stopped", stopReason: "user" });
    expect(await recorder.finished).toBe(result);
  });

  it("prefers MP4 where the browser encodes it", async () => {
    FakeMediaRecorder.supported.add("video/mp4;codecs=avc1.640028");
    const recorder = createCanvasRecorder({ canvas: fakeCanvas().canvas, maxBytes: 1e8, maxDurationMs: 60_000, MediaRecorder: Recorder, clock: manualClock() });
    FakeMediaRecorder.instances[0]!.chunk(100);
    const result = await recorder.stop();
    expect(result).toMatchObject({ mimeType: "video/mp4;codecs=avc1.640028", extension: "mp4" });
    expect(result.blob.type).toBe("video/mp4");
  });

  it("stops itself at 90 % of the size budget", async () => {
    const recorder = createCanvasRecorder({ canvas: fakeCanvas().canvas, maxBytes: 10_000, maxDurationMs: 60_000, MediaRecorder: Recorder, clock: manualClock() });
    const instance = FakeMediaRecorder.instances[0]!;
    instance.chunk(4_000);
    instance.chunk(4_000);
    expect(recorder.getState().phase).toBe("recording");
    instance.chunk(1_100);
    expect(recorder.getState()).toMatchObject({ phase: "stopping", stopReason: "memory-limit" });
    const result = await recorder.finished;
    expect(result.metrics).toMatchObject({ stopReason: "memory-limit", bytes: 9_110 });
  });

  it("stops at the duration limit", async () => {
    const clock = manualClock();
    const recorder = createCanvasRecorder({ canvas: fakeCanvas().canvas, maxBytes: 1e8, maxDurationMs: 30_000, MediaRecorder: Recorder, clock });
    FakeMediaRecorder.instances[0]!.chunk(500);
    clock.advance(29_999);
    expect(recorder.getState().phase).toBe("recording");
    clock.advance(1);
    const result = await recorder.finished;
    expect(result.metrics).toMatchObject({ stopReason: "duration-limit", durationMs: 30_000 });
  });

  it("stops when the canvas stream ends", async () => {
    const { canvas, stream } = fakeCanvas();
    const recorder = createCanvasRecorder({ canvas, maxBytes: 1e8, maxDurationMs: 60_000, MediaRecorder: Recorder, clock: manualClock() });
    FakeMediaRecorder.instances[0]!.chunk(500);
    stream.track.end();
    expect((await recorder.finished).metrics.stopReason).toBe("source-ended");
  });

  it("keeps what was recorded before an encoder error", async () => {
    const recorder = createCanvasRecorder({ canvas: fakeCanvas().canvas, maxBytes: 1e8, maxDurationMs: 60_000, MediaRecorder: Recorder, clock: manualClock() });
    const instance = FakeMediaRecorder.instances[0]!;
    instance.chunk(700);
    instance.crash(true);
    const result = await recorder.finished;
    expect(result.metrics).toMatchObject({ stopReason: "error", bytes: 710 });
    expect(recorder.getState().error).toMatch(/encoder crashed/);
  });

  it("rejects when nothing usable was recorded", async () => {
    const recorder = createCanvasRecorder({ canvas: fakeCanvas().canvas, maxBytes: 1e8, maxDurationMs: 60_000, MediaRecorder: Recorder, clock: manualClock() });
    FakeMediaRecorder.instances[0]!.crash(false);
    await expect(recorder.finished).rejects.toThrow(/encoder crashed/);
    expect(recorder.getState().phase).toBe("failed");
  });

  it("discards a cancelled recording", async () => {
    const { canvas, stream } = fakeCanvas();
    const recorder = createCanvasRecorder({ canvas, maxBytes: 1e8, maxDurationMs: 60_000, MediaRecorder: Recorder, clock: manualClock() });
    FakeMediaRecorder.instances[0]!.chunk(500);
    recorder.cancel();
    await expect(recorder.finished).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.track.stopped).toBe(true);
    recorder.cancel();
  });

  it("finishes even when the encoder never reports stop", async () => {
    const clock = manualClock();
    const recorder = createCanvasRecorder({ canvas: fakeCanvas().canvas, maxBytes: 1e8, maxDurationMs: 60_000, MediaRecorder: Recorder, clock });
    const instance = FakeMediaRecorder.instances[0]!;
    instance.reportsStop = false;
    instance.chunk(300);
    const stopped = recorder.stop();
    await flush();
    expect(recorder.getState().phase).toBe("stopping");
    clock.advance(10_000);
    expect((await stopped).metrics).toMatchObject({ stopReason: "user", bytes: 310 });
  });

  it("refuses when the browser cannot record", () => {
    const { canvas } = fakeCanvas();
    expect(() => createCanvasRecorder({ canvas, maxBytes: 1e8, maxDurationMs: 60_000 })).toThrow(RecorderUnsupportedError);
    const noCapture = { width: 10, height: 10 } as unknown as HTMLCanvasElement;
    expect(() => createCanvasRecorder({ canvas: noCapture, maxBytes: 1e8, maxDurationMs: 60_000, MediaRecorder: Recorder })).toThrow(/capture a canvas/);
    expect(() => createCanvasRecorder({ canvas: fakeCanvas(0, 0).canvas, maxBytes: 1e8, maxDurationMs: 60_000, MediaRecorder: Recorder })).toThrow(/no pixels/);
    expect(() => createCanvasRecorder({ canvas, maxBytes: 0, maxDurationMs: 60_000, MediaRecorder: Recorder })).toThrow(RangeError);
    FakeMediaRecorder.supported = new Set();
    expect(() => createCanvasRecorder({ canvas, maxBytes: 1e8, maxDurationMs: 60_000, MediaRecorder: Recorder })).toThrow(/MP4 or WebM/);
    expect(canRecordCanvas(canvas, Recorder)).toBe(false);
    FakeMediaRecorder.supported = new Set(["video/webm"]);
    expect(canRecordCanvas(canvas, Recorder)).toBe(true);
    expect(canRecordCanvas(null, Recorder)).toBe(false);
    expect(canRecordCanvas(canvas)).toBe(false);
  });
});

describe("experiment data", () => {
  function documentWith(attributes: Record<string, string>, status?: unknown) {
    return {
      querySelector: (selector: string) => {
        const entry = Object.entries(attributes).find(([key]) => selector.includes(key.split("|")[0]!));
        if (!entry) return null;
        const [key, value] = entry;
        return { getAttribute: (name: string) => (name === key.split("|")[1] ? value : null) };
      },
      defaultView: status === undefined ? null : { __viscera: status },
    };
  }

  it("reads the physics diagnostics snapshot and the lab status", () => {
    const snapshot = { simulation_time_s: 1.25, node_positions_mm: [1, 2, 3], metrics: { fps: 60 } };
    const data = collectExperimentData(
      documentWith({ 'playground-diagnostics|data-snapshot': JSON.stringify(snapshot) }, { ready: true, mode: "atlas", errors: ["x", 3], api: false }),
      () => Date.parse("2026-10-21T10:00:00Z"),
    );
    expect(data).toEqual({
      capturedAt: "2026-10-21T10:00:00.000Z",
      snapshots: { physicsPlayground: snapshot },
      status: { ready: true, mode: "atlas", errors: ["x"], api: false },
      notes: [],
    });
  });

  it("notes what it could not read and never throws", () => {
    const broken = collectExperimentData(documentWith({ "data-fat-snapshot|data-fat-snapshot": "{not json" }, "not an object"));
    expect(broken.snapshots).toEqual({});
    expect(broken.status).toBeNull();
    expect(broken.notes).toEqual(["fat: the snapshot is not valid JSON."]);
    const throwing = collectExperimentData({
      querySelector: () => {
        throw new Error("detached");
      },
      defaultView: null,
    });
    expect(throwing.notes).toHaveLength(4);
    expect(collectExperimentData(null).notes).toEqual(["No lab document to read."]);
  });

  it("accepts a real Document", () => {
    // compile-time check only: a DOM Document satisfies the reader's structural type
    const read = (document: Document) => collectExperimentData(document);
    expect(typeof read).toBe("function");
  });
});

describe("recording a lab", () => {
  function fakeLab(canvas: HTMLCanvasElement | null, busy: false | string = false) {
    const holds: string[] = [];
    const lab = {
      busy: () => (holds.length > 0 ? (holds[0] as string) : busy),
      recordingCanvas: () => canvas,
      hold(reason: string) {
        holds.push(reason);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          holds.splice(holds.indexOf(reason), 1);
        };
      },
    };
    return { lab, holds };
  }

  it("holds the lab busy for the whole recording and lets go however it ends", async () => {
    const clock = manualClock();
    const { canvas } = fakeCanvas();
    const { lab, holds } = fakeLab(canvas);
    const recorder = startLabRecording(lab, { maxBytes: 1024 ** 3, maxDurationMs: 2_000, MediaRecorder: Recorder, clock });
    expect(lab.busy()).toBe("recording");
    FakeMediaRecorder.instances[0]!.chunk(500);
    clock.advance(2_000);
    const result = await recorder.finished;
    expect(result.metrics).toMatchObject({ stopReason: "duration-limit", durationMs: 2_000, bytes: 510 });
    expect(holds).toEqual([]);
    // a discarded recording lets go too
    const second = startLabRecording(lab, { maxBytes: 1024 ** 3, maxDurationMs: 60_000, MediaRecorder: Recorder, clock });
    second.cancel();
    await expect(second.finished).rejects.toMatchObject({ name: "AbortError" });
    expect(holds).toEqual([]);
  });

  it("refuses a busy lab or one with nothing to record, and lets go when the recorder cannot start", () => {
    const clock = manualClock();
    const { canvas } = fakeCanvas();
    expect(() => startLabRecording(fakeLab(canvas, "running").lab, { maxBytes: 1, maxDurationMs: 1, MediaRecorder: Recorder, clock })).toThrow(RecorderBusyError);
    expect(() => startLabRecording(fakeLab(null).lab, { maxBytes: 1, maxDurationMs: 1, MediaRecorder: Recorder, clock })).toThrow(RecorderUnsupportedError);
    FakeMediaRecorder.supported = new Set();
    const { lab, holds } = fakeLab(canvas);
    expect(() => startLabRecording(lab, { maxBytes: 1, maxDurationMs: 1, MediaRecorder: Recorder, clock })).toThrow(RecorderUnsupportedError);
    expect(holds).toEqual([]);
  });
});
