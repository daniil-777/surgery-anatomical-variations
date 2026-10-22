// Canvas video recording for the library: canvas.captureStream(fps) into MediaRecorder, MP4/H.264 where the browser
// encodes it, else WebM. The size budget is the plan's per-file limit: the bitrate is chosen so the longest allowed
// recording fits when that is still watchable, and the recorder stops itself at 90 % of the budget whatever happens.
// The result has the shape of the studio's WIP recorder (RecordingResult) so either can feed the library.
// MediaRecorder stamps frames by wall clock and captureStream(fps) only caps the rate: when a lab drops simulation
// time under load the video shows it slower than real time; experiment data is collected separately and kept with it.

import type { IsoDate, JsonValue } from "./types";

export type RecordingStopReason = "user" | "memory-limit" | "duration-limit" | "source-ended" | "error";

export interface RecordingMetrics {
  /** Source canvas pixels when the recording started. */
  width: number;
  height: number;
  durationMs: number;
  bytes: number;
  stopReason: RecordingStopReason;
  /** The capture rate asked of captureStream; the encoded rate is not measured. */
  requestedFps: number;
  videoBitsPerSecond: number;
  startedAt: IsoDate;
}

export interface RecordingResult {
  /** Typed with the container only ("video/mp4" | "video/webm"), as the storage allow-list expects. */
  blob: Blob;
  /** What the encoder reported, codecs included. */
  mimeType: string;
  extension: "mp4" | "webm";
  filename: string;
  metrics: RecordingMetrics;
}

export type RecorderPhase = "recording" | "stopping" | "stopped" | "failed";

export interface RecorderState {
  phase: RecorderPhase;
  mimeType: string;
  startedAt: number;
  elapsedMs: number;
  bytes: number;
  maxBytes: number;
  maxDurationMs: number;
  stopReason: RecordingStopReason | null;
  error: string | null;
}

/** In order of preference; the first the browser can encode wins. */
export const RECORDING_MIME_PREFERENCE: readonly string[] = [
  "video/mp4;codecs=avc1.640028",
  "video/mp4;codecs=avc3",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export const RECORDING_TIMESLICE_MS = 250;
/** Stop at this share of maxBytes: the chunk still in the encoder must fit in the rest. */
export const SOFT_STOP_RATIO = 0.9;
export const MIN_QUALITY_BITRATE = 2_500_000;
export const MAX_QUALITY_BITRATE = 12_000_000;
/** Below this the budget does not lower the bitrate any further (the size stop ends the recording instead). */
export const MIN_BUDGET_BITRATE = 1_000_000;
const CONTAINER_OVERHEAD = 0.95;
const STOP_TIMEOUT_MS = 10_000;

export function pickRecordingMime(isTypeSupported: (type: string) => boolean, preferred?: string | null): string | null {
  const candidates = preferred ? [preferred, ...RECORDING_MIME_PREFERENCE] : RECORDING_MIME_PREFERENCE;
  for (const type of candidates) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // some browsers throw on types they cannot parse
    }
  }
  return null;
}

export function recordingContainer(mimeType: string): "video/mp4" | "video/webm" {
  return mimeType.trim().toLowerCase().startsWith("video/mp4") ? "video/mp4" : "video/webm";
}

export function recordingExtension(mimeType: string): "mp4" | "webm" {
  return recordingContainer(mimeType) === "video/mp4" ? "mp4" : "webm";
}

export interface BitrateInput {
  width: number;
  height: number;
  fps: number;
  maxBytes: number;
  maxDurationMs: number;
}

/**
 * clamp(w·h·fps·0.1, 2.5–12 Mbit/s), lowered so maxDurationMs fits under the soft stop of maxBytes (container overhead
 * included) — but never below 1 Mbit/s: past that point the size stop is the better trade than an unwatchable video.
 */
export function chooseVideoBitrate(input: BitrateInput): number {
  const quality = Math.min(MAX_QUALITY_BITRATE, Math.max(MIN_QUALITY_BITRATE, input.width * input.height * input.fps * 0.1));
  const seconds = input.maxDurationMs / 1000;
  if (!(seconds > 0 && input.maxBytes > 0)) return Math.round(quality);
  const budget = (input.maxBytes * SOFT_STOP_RATIO * CONTAINER_OVERHEAD * 8) / seconds;
  // quality is at least MIN_QUALITY_BITRATE > MIN_BUDGET_BITRATE, so the floor never raises it
  return Math.round(Math.min(quality, Math.max(MIN_BUDGET_BITRATE, budget)));
}

export function recordingFilename(prefix: string, width: number, height: number, startedAt: Date, extension: string): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${width}x${height}-${stamp}.${extension}`;
}

export type MediaRecorderConstructor = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported(type: string): boolean;
};

export interface RecorderClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: RecorderClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export interface CanvasRecorderOptions {
  canvas: HTMLCanvasElement;
  /** The size budget, normally the plan's per-file limit. */
  maxBytes: number;
  maxDurationMs: number;
  /** captureStream rate (1–60, default 30). */
  fps?: number | undefined;
  /** Tried before the built-in preference list. */
  preferredMime?: string | undefined;
  onState?: ((state: RecorderState) => void) | undefined;
  /** Filename prefix (default "viscera-scene", as the studio recorder names scene recordings). */
  filenamePrefix?: string | undefined;
  MediaRecorder?: MediaRecorderConstructor | undefined;
  clock?: RecorderClock | undefined;
  /** Record through a canvas this page paints at the capture rate (default true when there is a DOM). */
  composite?: boolean | undefined;
}

/** The longest side of a recorded video (library recordings stay at most 1080p-class). */
export const MAX_RECORDING_EDGE = 1920;

/** H.264 needs even dimensions. */
function evenSize(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export interface CanvasRecorder {
  readonly mimeType: string;
  readonly videoBitsPerSecond: number;
  getState(): RecorderState;
  /** Stops (reason "user") and resolves like finished. */
  stop(): Promise<RecordingResult>;
  /** Stops and throws the recording away (finished rejects with an AbortError). */
  cancel(): void;
  /** Settles once the recording ends for any reason; rejects when nothing usable was recorded. */
  readonly finished: Promise<RecordingResult>;
}

export class RecorderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecorderUnsupportedError";
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function describeRecorderError(event: unknown): string {
  const error = (event as { error?: unknown } | null)?.error;
  if (error instanceof Error && error.message) return `The browser could not encode the recording: ${error.message}`;
  return "The browser could not encode the recording.";
}

export function canRecordCanvas(canvas: HTMLCanvasElement | null | undefined, Recorder?: MediaRecorderConstructor): boolean {
  const constructor = Recorder ?? (globalThis as { MediaRecorder?: MediaRecorderConstructor }).MediaRecorder;
  if (!canvas || !constructor || typeof canvas.captureStream !== "function") return false;
  return pickRecordingMime((type) => constructor.isTypeSupported(type)) !== null;
}

/**
 * Starts recording the canvas immediately. Throws RecorderUnsupportedError when the browser cannot (no MediaRecorder,
 * no canvas capture or no encodable format). The caller should hold the lab busy for the duration (one GPU job).
 */
export function createCanvasRecorder(options: CanvasRecorderOptions): CanvasRecorder {
  const Recorder = options.MediaRecorder ?? (globalThis as { MediaRecorder?: MediaRecorderConstructor }).MediaRecorder;
  if (!Recorder) throw new RecorderUnsupportedError("This browser cannot record video.");
  const canvas = options.canvas;
  if (typeof canvas.captureStream !== "function") throw new RecorderUnsupportedError("This browser cannot capture a canvas.");
  if (!(options.maxBytes > 0) || !(options.maxDurationMs > 0)) throw new RangeError("maxBytes and maxDurationMs must be positive.");
  if (!(canvas.width > 0 && canvas.height > 0)) throw new RecorderUnsupportedError("The canvas has no pixels to record.");
  // With a DOM, record a canvas this page owns and paints at a steady rate: Chrome emits captureStream frames only when a
  // canvas repaints, so a still or on-demand lab would otherwise record nothing (measured: 0 bytes), and the lab canvas
  // lives in another document (the lab iframe). Compositing also caps the encoded size at MAX_RECORDING_EDGE.
  const doc = typeof document === "undefined" ? null : document;
  const composite = (options.composite ?? true) && doc !== null;
  const scale = composite ? Math.min(1, MAX_RECORDING_EDGE / Math.max(canvas.width, canvas.height)) : 1;
  const width = composite ? evenSize(canvas.width * scale) : canvas.width;
  const height = composite ? evenSize(canvas.height * scale) : canvas.height;
  const requested = pickRecordingMime((type) => Recorder.isTypeSupported(type), options.preferredMime);
  if (!requested) throw new RecorderUnsupportedError("This browser cannot encode MP4 or WebM video.");
  const fps = Math.min(60, Math.max(1, Math.round(options.fps ?? 30)));
  const clock = options.clock ?? systemClock;
  const { maxBytes, maxDurationMs } = options;
  const videoBitsPerSecond = chooseVideoBitrate({ width, height, fps, maxBytes, maxDurationMs });

  let painter: unknown = null;
  let target: HTMLCanvasElement = canvas;
  if (composite && doc) {
    const output = doc.createElement("canvas");
    output.width = width;
    output.height = height;
    const context = output.getContext("2d", { alpha: false });
    if (!context) throw new RecorderUnsupportedError("This browser cannot prepare the recording.");
    const paint = (): void => {
      context.fillStyle = "#000";
      context.fillRect(0, 0, width, height);
      const fit = Math.min(width / canvas.width, height / canvas.height);
      const drawWidth = canvas.width * fit;
      const drawHeight = canvas.height * fit;
      try {
        context.drawImage(canvas, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
      } catch {
        // the lab canvas went away; the stop path follows
      }
    };
    paint();
    const tick = (): void => {
      paint();
      painter = clock.setTimeout(tick, 1000 / fps);
    };
    painter = clock.setTimeout(tick, 1000 / fps);
    target = output;
  }
  const stream = target.captureStream(fps);
  const stopTracks = (): void => {
    if (painter !== null) {
      clock.clearTimeout(painter);
      painter = null;
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // already ended
      }
    }
  };
  let recorder: MediaRecorder;
  try {
    recorder = new Recorder(stream, { mimeType: requested, videoBitsPerSecond });
  } catch (error) {
    stopTracks();
    throw error;
  }

  const startedAt = clock.now();
  const chunks: Blob[] = [];
  let bytes = 0;
  let phase: RecorderPhase = "recording";
  let stopReason: RecordingStopReason | null = null;
  let failure: string | null = null;
  let stoppedAt: number | null = null;
  let cancelled = false;
  let settled = false;
  let durationTimer: unknown = null;
  let stopTimer: unknown = null;
  const mimeType = (): string => recorder.mimeType || requested;

  const snapshot = (): RecorderState => ({
    phase,
    mimeType: mimeType(),
    startedAt,
    elapsedMs: (stoppedAt ?? clock.now()) - startedAt,
    bytes,
    maxBytes,
    maxDurationMs,
    stopReason,
    error: failure,
  });
  const emit = (): void => {
    try {
      options.onState?.(snapshot());
    } catch {
      // a failing UI listener must not end the recording
    }
  };

  let resolveFinished!: (result: RecordingResult) => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<RecordingResult>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // nobody may be listening (cancel); an unhandled rejection would reach the console
  finished.catch(() => undefined);

  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (durationTimer !== null) clock.clearTimeout(durationTimer);
    if (stopTimer !== null) clock.clearTimeout(stopTimer);
    stopTracks();
    stoppedAt ??= clock.now();
    if (cancelled) {
      phase = "failed";
      failure = "The recording was discarded.";
      emit();
      rejectFinished(abortError("The recording was discarded."));
      return;
    }
    if (chunks.length === 0 || bytes === 0) {
      phase = "failed";
      failure ??= "The browser produced an empty recording.";
      emit();
      rejectFinished(new Error(failure));
      return;
    }
    const type = mimeType();
    const extension = recordingExtension(type);
    const reason = stopReason ?? "user";
    const result: RecordingResult = {
      blob: new Blob(chunks, { type: recordingContainer(type) }),
      mimeType: type,
      extension,
      filename: recordingFilename(options.filenamePrefix ?? "viscera-scene", width, height, new Date(startedAt), extension),
      metrics: {
        width,
        height,
        durationMs: Math.max(0, stoppedAt - startedAt),
        bytes,
        stopReason: reason,
        requestedFps: fps,
        videoBitsPerSecond,
        startedAt: new Date(startedAt).toISOString(),
      },
    };
    phase = "stopped";
    emit();
    resolveFinished(result);
  };

  const requestStop = (reason: RecordingStopReason): void => {
    if (phase !== "recording") return;
    phase = "stopping";
    stopReason = reason;
    stoppedAt = clock.now();
    if (durationTimer !== null) clock.clearTimeout(durationTimer);
    durationTimer = null;
    emit();
    // the stop event follows the last dataavailable; never wait for it forever
    stopTimer = clock.setTimeout(finish, STOP_TIMEOUT_MS);
    // after an encoder error the recorder is already inactive and still delivers its last chunk, then stop
    if (recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      finish();
    }
  };

  recorder.ondataavailable = (event: BlobEvent): void => {
    const data = event.data;
    if (!data || data.size === 0) return;
    chunks.push(data);
    bytes += data.size;
    emit();
    if (bytes >= maxBytes * SOFT_STOP_RATIO) requestStop("memory-limit");
  };
  recorder.onerror = (event: Event): void => {
    failure = describeRecorderError(event);
    if (phase === "recording") requestStop("error");
    else stopReason = "error";
  };
  recorder.onstop = (): void => finish();
  for (const track of stream.getVideoTracks()) {
    track.addEventListener("ended", () => requestStop("source-ended"));
  }

  try {
    recorder.start(RECORDING_TIMESLICE_MS);
  } catch (error) {
    settled = true;
    stopTracks();
    throw error;
  }
  durationTimer = clock.setTimeout(() => requestStop("duration-limit"), maxDurationMs);
  emit();
  // the live timer: MP4 chunks arrive irregularly, so report the elapsed time on a steady beat while recording
  const tickState = (): void => {
    if (phase !== "recording") return;
    emit();
    clock.setTimeout(tickState, 250);
  };
  clock.setTimeout(tickState, 250);

  return {
    get mimeType() {
      return mimeType();
    },
    videoBitsPerSecond,
    getState: snapshot,
    stop() {
      requestStop("user");
      return finished;
    },
    cancel() {
      if (settled) return;
      cancelled = true;
      // a recorder already stopping finishes as discarded when its stop event arrives
      requestStop("user");
    },
    finished,
  };
}

// Recording a lab ----------------------------------------------------------------------------------------------------

/** What startLabRecording needs of a connected lab (labs/host.ts LabConnection satisfies it). */
export interface RecordableLab {
  busy(): false | string;
  recordingCanvas(): HTMLCanvasElement | null;
  /** Marks the lab busy for a platform job; returns the release. */
  hold(reason: string): () => void;
}

/** The lab is busy with other work (a run, an export, a restore): recording waits for it. */
export class RecorderBusyError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`The lab is busy (${reason}). Record when it finishes.`);
    this.name = "RecorderBusyError";
    this.reason = reason;
  }
}

/**
 * Records the lab's canvas while holding the lab busy ("recording"): autosave, thumbnails, restores and other jobs
 * wait until the recording ends, however it ends (DESIGN.md §15.6). Throws RecorderBusyError while the lab is busy and
 * RecorderUnsupportedError when there is nothing to record or the browser cannot.
 */
export function startLabRecording(lab: RecordableLab, options: Omit<CanvasRecorderOptions, "canvas">): CanvasRecorder {
  const busy = lab.busy();
  if (busy) throw new RecorderBusyError(busy);
  const canvas = lab.recordingCanvas();
  if (!canvas) throw new RecorderUnsupportedError("The lab shows nothing to record yet.");
  const release = lab.hold("recording");
  let recorder: CanvasRecorder;
  try {
    recorder = createCanvasRecorder({ ...options, canvas });
  } catch (error) {
    release();
    throw error;
  }
  recorder.finished.then(release, release);
  return recorder;
}

// Experiment data ----------------------------------------------------------------------------------------------------

export interface ExperimentStatus {
  ready: boolean;
  mode: string;
  errors: string[];
  api: boolean | null;
}

export interface ExperimentData {
  capturedAt: IsoDate;
  /** Parsed DOM snapshots by source (physicsPlayground, tissue, fat, scissors), copied verbatim. */
  snapshots: Record<string, JsonValue>;
  /** window.__viscera of the lab document, when present. */
  status: ExperimentStatus | null;
  /** What could not be read, in plain words. */
  notes: string[];
}

/** DOM snapshot attributes labs already publish (their e2e suites read them); read-only, no lab code imported. */
const SNAPSHOT_SOURCES: ReadonlyArray<{ key: string; selector: string; attribute: string }> = [
  { key: "physicsPlayground", selector: '[data-testid="playground-diagnostics"]', attribute: "data-snapshot" },
  { key: "tissue", selector: ".tissue-viewport[data-tissue-snapshot]", attribute: "data-tissue-snapshot" },
  { key: "fat", selector: "[data-fat-snapshot]", attribute: "data-fat-snapshot" },
  { key: "scissors", selector: "[data-scissors-diagnostics]", attribute: "data-scissors-diagnostics" },
];
const MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024;

interface SnapshotDocument {
  querySelector(selectors: string): { getAttribute(name: string): string | null } | null;
  readonly defaultView?: unknown;
}

function readStatus(view: unknown): ExperimentStatus | null {
  const status = (view as { __viscera?: unknown } | null | undefined)?.__viscera;
  if (typeof status !== "object" || status === null) return null;
  const value = status as { ready?: unknown; mode?: unknown; errors?: unknown; api?: unknown };
  return {
    ready: value.ready === true,
    mode: typeof value.mode === "string" ? value.mode : "",
    errors: Array.isArray(value.errors)
      ? (value.errors as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 50)
      : [],
    api: typeof value.api === "boolean" ? value.api : null,
  };
}

/**
 * Best-effort data that belongs with a recorded experiment: the physics playground's diagnostics snapshot (and the
 * WIP labs' equivalents once they land) plus the lab's status object. Never throws.
 */
export function collectExperimentData(document: SnapshotDocument | null | undefined, now: () => number = Date.now): ExperimentData {
  const data: ExperimentData = { capturedAt: new Date(now()).toISOString(), snapshots: {}, status: null, notes: [] };
  if (!document) {
    data.notes.push("No lab document to read.");
    return data;
  }
  for (const source of SNAPSHOT_SOURCES) {
    let raw: string | null = null;
    try {
      raw = document.querySelector(source.selector)?.getAttribute(source.attribute) ?? null;
    } catch {
      data.notes.push(`${source.key}: the snapshot element could not be read.`);
      continue;
    }
    if (raw === null || raw.trim() === "") continue;
    if (raw.length > MAX_SNAPSHOT_CHARS) {
      data.notes.push(`${source.key}: the snapshot is larger than ${MAX_SNAPSHOT_CHARS} characters and was left out.`);
      continue;
    }
    try {
      data.snapshots[source.key] = JSON.parse(raw) as JsonValue;
    } catch {
      data.notes.push(`${source.key}: the snapshot is not valid JSON.`);
    }
  }
  try {
    data.status = readStatus(document.defaultView);
  } catch {
    data.notes.push("The lab status could not be read.");
  }
  return data;
}
