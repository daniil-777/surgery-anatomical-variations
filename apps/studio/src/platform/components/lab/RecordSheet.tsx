// Recording in the editor (DESIGN.md G3 "recorded physics experiments"): the bar's Record button starts and stops a
// canvas recording while the lab stays usable; the sheet then shows the take for review and saves it to the Library as
// a "recording" item — the video, the experiment data the lab published (experiment.json) and a still.

import { useEffect, useRef, useState } from "react";
import { Circle, Square } from "lucide-react";
import { recordingContainer } from "../../core/recorder";
import { Button, Icon, ProgressBar, Sheet, TextField, cx, formatBytes, formatDuration } from "../../ui";
import { friendlyError } from "./friendlyError";
import type { LabRecorder } from "./useLabRecorder";
import { libraryFilename, libraryItemMetadata, libraryTitle, uploadToLibrary } from "./libraryUpload";
import { useLibraryJob, type LibrarySource } from "./AddToLibraryMenu";
import { useBackend } from "../../app/context";

export interface RecordButtonProps {
  recorder: LabRecorder;
  /** The lab's busy reason when the recorder is idle (Record waits for false). */
  busy: false | string;
  disabled?: boolean | undefined;
  onError: (message: string) => void;
}

/** "● Record" → "■ 0:12 · 4.2 MB" while recording (the red dot pulses; static under reduced motion). */
export function RecordButton({ recorder, busy, disabled = false, onError }: RecordButtonProps) {
  const recording = recorder.phase === "recording" || recorder.phase === "stopping";
  if (recording) {
    const near = recorder.maxBytes > 0 && recorder.bytes / recorder.maxBytes > 0.75;
    return (
      <Button
        size="large"
        className="px-pbar__button px-record-button px-record-button--live"
        onClick={() => void recorder.stop()}
        loading={recorder.phase === "stopping"}
        loadingLabel="Stopping…"
        aria-label={`Stop recording, ${formatDuration(recorder.elapsedMs / 1000)} recorded`}
      >
        <span className="px-record-dot" aria-hidden="true" />
        <span className="px-num">{formatDuration(recorder.elapsedMs / 1000)}</span>
        <span className="px-record-sep" aria-hidden="true">
          {" · "}
        </span>
        <span className={cx("px-record-size px-num", near && "px-record-size--near")}>{formatBytes(recorder.bytes)}</span>
        <Icon icon={Square} size={11} className="px-record-stop" />
      </Button>
    );
  }
  if (recorder.phase === "review") {
    return (
      <Button size="large" className="px-pbar__button px-record-button" onClick={() => recorder.setReviewVisible(true)}>
        <Icon icon={Circle} size={12} className="px-record-glyph" fill="currentColor" />
        Review Recording…
      </Button>
    );
  }
  const unavailable = disabled || busy !== false;
  return (
    <Button
      size="large"
      className="px-pbar__button px-record-button"
      aria-disabled={unavailable || undefined}
      title={busy ? `Recording waits until ${busy} has finished` : undefined}
      onClick={() => {
        try {
          recorder.start();
        } catch (error) {
          onError(error instanceof Error && error.name === "Error" ? error.message : friendlyError(error, "Recording couldn't start."));
        }
      }}
    >
      <Icon icon={Circle} size={12} className="px-record-glyph" fill="currentColor" />
      Record
    </Button>
  );
}

export interface RecordSheetProps {
  recorder: LabRecorder;
  source: LibrarySource;
  baseTitle: string;
}

/** Review the take: play it, name it, save it to the Library (or discard it). */
export function RecordSheet({ recorder, source, baseTitle }: RecordSheetProps) {
  const backend = useBackend();
  const runJob = useLibraryJob();
  const take = recorder.take;
  const open = recorder.phase === "review" && take !== null && recorder.reviewVisible;
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTitle(libraryTitle(`${baseTitle} Recording`));
      setProgress(null);
    }
  }, [open, baseTitle]);

  if (!take) return null;
  const metrics = take.result.metrics;
  const experimentSources = Object.keys(take.experiment.snapshots);
  const container = recordingContainer(take.result.mimeType) === "video/mp4" ? "MP4" : "WebM";

  const save = async () => {
    if (saving) return;
    const name = libraryTitle(title, `${baseTitle} Recording`);
    setSaving(true);
    setProgress(0);
    const experimentJson = new Blob([JSON.stringify(take.experiment, null, 2)], { type: "application/json" });
    const files = [
      { filename: libraryFilename(take.result.filename, `recording.${take.result.extension}`), role: "video" as const, blob: take.result.blob },
      { filename: "experiment.json", role: "data" as const, blob: experimentJson },
    ];
    const item = await runJob((onProgress) =>
      uploadToLibrary(
        backend,
        {
          kind: "recording",
          title: name,
          labId: source.labId,
          sourceProjectId: source.projectId,
          sourceVersionId: source.versionId,
          files,
          thumbnail: take.thumbnail,
          metadata: libraryItemMetadata({
            claims: {
              evidence: `A screen recording of the ${source.labTitle} canvas, made in the browser.`,
              limitations: [
                "Frames are timed by the wall clock: when the lab slows down under load, the video plays slower than the simulation ran.",
              ],
            },
            provenance: { via: "recording", labId: source.labId, labTitle: source.labTitle, projectId: source.projectId, versionId: source.versionId, unsavedChanges: source.unsavedChanges },
            extra: {
              recording: {
                width: metrics.width,
                height: metrics.height,
                durationMs: Math.round(metrics.durationMs),
                bytes: metrics.bytes,
                mimeType: take.result.mimeType,
                requestedFps: metrics.requestedFps,
                videoBitsPerSecond: metrics.videoBitsPerSecond,
                stopReason: metrics.stopReason,
                startedAt: metrics.startedAt,
              },
              experiment: { sources: experimentSources, notes: take.experiment.notes },
            },
          }),
        },
        {
          onProgress: ({ loaded, total }) => {
            const fraction = total > 0 ? loaded / total : 1;
            setProgress(fraction);
            onProgress(fraction);
          },
        },
      ),
    );
    setSaving(false);
    setProgress(null);
    if (item) recorder.finish();
  };

  const stopNote =
    metrics.stopReason === "memory-limit"
      ? `The recording stopped at your plan's limit of ${formatBytes(recorder.maxBytes)} per file.`
      : metrics.stopReason === "duration-limit"
        ? "The recording stopped at the 10-minute limit."
        : metrics.stopReason === "source-ended"
          ? "The recording stopped because the lab's picture went away."
          : null;

  return (
    <Sheet
      open={open}
      onClose={() => {
        // put aside, not thrown away: the bar offers "Review Recording…" until it is saved or discarded
        if (!saving) recorder.setReviewVisible(false);
      }}
      title="Save Recording"
      description={`${formatDuration(metrics.durationMs / 1000)} · ${formatBytes(metrics.bytes)} · ${metrics.width} × ${metrics.height} · ${container}`}
      size="medium"
      initialFocus={field}
      leadingActions={
        <Button size="large" variant="destructive" onClick={() => recorder.discard()} aria-disabled={saving || undefined}>
          Discard
        </Button>
      }
      actions={
        <Button size="large" variant="borderedProminent" onClick={() => void save()} loading={saving} loadingLabel="Saving…">
          Save to Library
        </Button>
      }
    >
      <div className="px-record-review">
        <video className="px-record-review__video" src={take.url} controls muted playsInline preload="metadata" aria-label="Recording preview" />
        <form
          className="px-record-review__form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextField
            ref={field}
            label="Title"
            value={title}
            maxLength={120}
            size="large"
            autoComplete="off"
            disabled={saving}
            onChange={(event) => setTitle(event.target.value)}
          />
        </form>
        <ul className="px-record-review__notes">
          <li>
            {experimentSources.includes("physicsPlayground")
              ? "Includes the physics playground's diagnostics at the end of the recording (experiment.json)."
              : experimentSources.length > 0
                ? `Includes the lab's published data: ${experimentSources.join(", ")} (experiment.json).`
                : "Includes the lab's status at the end of the recording (experiment.json)."}
          </li>
          {stopNote ? <li>{stopNote}</li> : null}
        </ul>
        {progress !== null ? <ProgressBar value={progress} label="Uploading" showValue size="regular" /> : null}
      </div>
    </Sheet>
  );
}
