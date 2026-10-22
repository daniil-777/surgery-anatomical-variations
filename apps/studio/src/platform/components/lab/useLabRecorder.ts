// Records the lab's canvas for the Library (core/recorder.ts): the lab is held busy while it runs (autosave and
// thumbnails wait, DESIGN.md §8), the plan's per-file limit caps the size, and the experiment data the lab publishes
// (the physics playground's diagnostics, the lab status) is collected when the recording stops.

import { useCallback, useEffect, useRef, useState } from "react";
import { collectExperimentData, createCanvasRecorder, type CanvasRecorder, type ExperimentData, type RecordingResult } from "../../core/recorder";
import type { LabHandle } from "./LabFrame";
import { useToast } from "../../ui";

/** The free plan's per-file limit, used until the account's own limit is known. */
const FALLBACK_MAX_BYTES = 50 * 1024 * 1024;
const MAX_DURATION_MS = 10 * 60_000;

export interface RecordingTake {
  result: RecordingResult;
  /** An object URL for the preview player (revoked on discard or unmount). */
  url: string;
  experiment: ExperimentData;
  thumbnail: Blob | null;
}

export interface LabRecorderState {
  phase: "idle" | "recording" | "stopping" | "review";
  elapsedMs: number;
  bytes: number;
  maxBytes: number;
  take: RecordingTake | null;
  /** The review sheet is showing (it can be put aside and reopened from the bar). */
  reviewVisible: boolean;
}

export interface LabRecorder extends LabRecorderState {
  /** Throws a friendly Error when nothing can be recorded. */
  start(): void;
  stop(): Promise<void>;
  /** Throws the take away. */
  discard(): void;
  /** The take was saved: forget it without a prompt. */
  finish(): void;
  /** Puts the review sheet aside / brings it back (the take is kept). */
  setReviewVisible(visible: boolean): void;
}

const IDLE: LabRecorderState = { phase: "idle", elapsedMs: 0, bytes: 0, maxBytes: FALLBACK_MAX_BYTES, take: null, reviewVisible: false };

export function useLabRecorder(handle: LabHandle | null, labId: string, maxFileBytes: number | null): LabRecorder {
  const toast = useToast();
  const [state, setState] = useState<LabRecorderState>(IDLE);
  const recorder = useRef<CanvasRecorder | null>(null);
  const release = useRef<(() => void) | null>(null);
  const takeUrl = useRef<string | null>(null);
  const alive = useRef(true);

  const letGo = useCallback(() => {
    release.current?.();
    release.current = null;
  }, []);

  const forgetTake = useCallback(() => {
    if (takeUrl.current) URL.revokeObjectURL(takeUrl.current);
    takeUrl.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      recorder.current?.cancel();
      recorder.current = null;
      letGo();
      forgetTake();
    };
  }, [letGo, forgetTake]);

  const finished = useCallback(
    async (recorded: RecordingResult) => {
      recorder.current = null;
      letGo();
      if (!alive.current || !handle) return;
      // the encoder ran in the lab's realm: copy the bytes into this page so a lab reload cannot strand them
      const result: RecordingResult = {
        ...recorded,
        blob: new Blob([await recorded.blob.arrayBuffer()], { type: recorded.blob.type || recorded.mimeType }),
      };
      let experiment: ExperimentData;
      try {
        experiment = collectExperimentData(handle.frame.contentDocument);
      } catch {
        experiment = collectExperimentData(null);
      }
      // the hold is released: the still is the view the recording ended on
      const thumbnail = await handle.connection.thumbnail(640, 400).catch(() => null);
      if (!alive.current) return;
      forgetTake();
      const url = URL.createObjectURL(result.blob);
      takeUrl.current = url;
      setState((previous) => ({ ...previous, phase: "review", take: { result, url, experiment, thumbnail }, reviewVisible: true }));
    },
    [handle, letGo, forgetTake],
  );

  const start = useCallback(() => {
    if (!handle) throw new Error("The lab isn't ready yet.");
    if (recorder.current) return;
    const busy = handle.connection.busy();
    if (busy) throw new Error(`The lab is busy (${busy}). Try again when it has finished.`);
    const canvas = handle.connection.recordingCanvas();
    if (!canvas) throw new Error("There's nothing to record yet: the lab shows no picture.");
    const maxBytes = Math.max(1024 * 1024, maxFileBytes ?? FALLBACK_MAX_BYTES);
    const hold = handle.connection.hold("recording");
    let created: CanvasRecorder;
    try {
      created = createCanvasRecorder({
        canvas,
        maxBytes,
        maxDurationMs: MAX_DURATION_MS,
        fps: 30,
        filenamePrefix: `viscera-${labId}`,
        onState: (live) => {
          if (!alive.current) return;
          setState((previous) =>
            previous.phase === "recording" || previous.phase === "stopping"
              ? { ...previous, elapsedMs: live.elapsedMs, bytes: live.bytes, phase: live.phase === "stopping" ? "stopping" : previous.phase }
              : previous,
          );
        },
      });
    } catch (error) {
      hold();
      throw error;
    }
    recorder.current = created;
    release.current = hold;
    setState({ phase: "recording", elapsedMs: 0, bytes: 0, maxBytes, take: null, reviewVisible: false });
    created.finished.then(
      (result) => void finished(result),
      (error: unknown) => {
        // cancelled (AbortError, silent), or nothing usable was encoded (say so: a take must never vanish unexplained)
        recorder.current = null;
        letGo();
        if (!alive.current) return;
        setState((previous) => ({ ...previous, phase: "idle", elapsedMs: 0, bytes: 0 }));
        const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
        if (name !== "AbortError") {
          const message = error instanceof Error && error.message ? error.message : "The recording failed.";
          toast.show({ tone: "error", message: `Nothing was recorded. ${message}` });
        }
      },
    );
  }, [handle, labId, maxFileBytes, finished, letGo, toast]);

  const stop = useCallback(async () => {
    const current = recorder.current;
    if (!current) return;
    setState((previous) => ({ ...previous, phase: "stopping" }));
    try {
      await current.stop();
    } catch {
      // finished's rejection handler resets the state
    }
  }, []);

  const discard = useCallback(() => {
    recorder.current?.cancel();
    recorder.current = null;
    letGo();
    forgetTake();
    setState((previous) => ({ ...IDLE, maxBytes: previous.maxBytes }));
  }, [letGo, forgetTake]);

  const setReviewVisible = useCallback((visible: boolean) => {
    setState((previous) => (previous.reviewVisible === visible ? previous : { ...previous, reviewVisible: visible }));
  }, []);

  return { ...state, start, stop, discard, finish: discard, setReviewVisible };
}
