/** Shared scene/display recording contract. No source permission is requested on construction. */
export const RECORDING_PROFILES = [
  { id: "hd", label: "HD · 1280 × 720", width: 1280, height: 720 },
  { id: "fhd", label: "Full HD · 1920 × 1080", width: 1920, height: 1080 },
  { id: "qhd", label: "2K / QHD · 2560 × 1440", width: 2560, height: 1440 },
  { id: "uhd", label: "4K · 3840 × 2160", width: 3840, height: 2160 },
] as const;
export type RecordingResolution = typeof RECORDING_PROFILES[number]["id"];
export type RecordingCapturePath = "native-canvas" | "native-display" | "compositor";
export type RecordingPhase = "idle" | "acquiring" | "recording" | "paused" | "stopping" | "completed" | "error" | "disposed";
export type RecordingStopReason = "user" | "source-ended" | "microphone-ended" | "source-detached" | "context-lost" | "memory-limit" | "duration-limit";
export interface SceneRecordingLease { restore(): void }
export interface SceneRecordingSource {
  kind: "scene";
  canvas: HTMLCanvasElement;
  label?: string;
  /** Optional native renderer-size transaction. It must undo its changes on cancellation too. */
  prepare?: (target: { width: number; height: number; fps: number; signal: AbortSignal }) => SceneRecordingLease | Promise<SceneRecordingLease>;
}
export interface DisplayRecordingSource {
  kind: "display";
  /** Encode the browser track directly, including while a separate controller is in the background. */
  native?: boolean;
  /** A browser preference, never a restriction on the user's native source picker. */
  surfaceHint?: "browser" | "window" | "monitor";
  label?: string;
}
export type RecordingSource = SceneRecordingSource | DisplayRecordingSource;
export interface RecordingMicrophoneOptions {
  /** Omitted, empty, or "default" requests the browser/OS default. Every other ID is exact. */
  deviceId?: string;
  /** Initial user mute state; a disabled audio track records silence. */
  muted?: boolean;
}
export interface RecordingOptions {
  source: RecordingSource;
  resolution: RecordingResolution;
  fps?: 24 | 30 | 60;
  /** Omitted means video only. Permission is requested only during explicit start(). */
  microphone?: RecordingMicrophoneOptions;
  /** Hard retained encoded-data cap. Stops below this to reserve room for the final chunk. */
  maxBytes?: number;
  /** Active recording time, excluding pause. Default 600 seconds. */
  maxDurationMs?: number;
}
export interface RecorderState {
  status: RecordingPhase;
  elapsedMs: number;
  bytes: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** True if any recorded source frame needed enlargement. */
  upscaled: boolean;
  requestedFps: number;
  /** Zero on the direct native path; this is never an encoded-frame counter. */
  compositedFrames: number;
  capturePath: RecordingCapturePath | null;
  mimeType: string;
  sourceKind: "scene" | "display" | null;
  sourceLabel: string;
  audioEnabled: boolean;
  /** Current user mute state, distinct from a temporarily unavailable audio source. */
  microphoneMuted: boolean;
  /** Actual browser track label. Raw device IDs are never exported in capture receipts. */
  microphoneLabel: string;
  stopReason: RecordingStopReason | null;
  warning: string | null;
  error: string | null;
}
export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  extension: "mp4" | "webm";
  filename: string;
  metrics: {
    width: number; height: number; sourceWidth: number; sourceHeight: number;
    upscaled: boolean; requestedFps: number; compositedFrames: number; capturePath: RecordingCapturePath;
    durationMs: number; wallDurationMs: number; bytes: number;
    stopReason: RecordingStopReason; sourceKind: "scene" | "display";
    audioEnabled: boolean;
    /** User mute state at completion, not a claim that the entire file is silent. */
    microphoneMuted: boolean;
    microphoneLabel: string;
    /** Capture submissions do not establish the encoded frame rate. */
    encodedFps: null;
  };
}
export interface RecorderCallbacks {
  onChange?: (state: RecorderState) => void;
  onComplete?: (result: RecordingResult) => void;
}
