// A recording with the browser's own controls (keyboard, captions, full screen and picture-in-picture come free and
// stay accessible). Reports the real duration and frame size, working around MediaRecorder WebM files that declare no
// duration until the end of the stream has been seen.
import { useEffect, useRef, useState } from "react";
import { VideoOff } from "lucide-react";
import { cx, Icon, useLatest } from "../../ui";
import "./viewers.css";

export interface VideoInfo {
  /** Null when the browser cannot tell (a stream without a duration). */
  durationMs: number | null;
  width: number;
  height: number;
}

export interface VideoPlayerProps {
  /** A signed URL or an object URL; null shows an empty frame. */
  src: string | null;
  poster?: string | null | undefined;
  /** The accessible name ("Recording “Probe contact run”"). */
  label: string;
  className?: string | undefined;
  onInfo?: ((info: VideoInfo) => void) | undefined;
  onError?: (() => void) | undefined;
}

/** Seeking this far makes Chromium and Firefox parse to the end of a WebM and publish its duration. */
const FAR_AWAY = 1e101;

export function VideoPlayer({ src, poster, label, className, onInfo, onError }: VideoPlayerProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  const probing = useRef(false);
  const [failed, setFailed] = useState(false);
  const latest = useLatest({ onInfo, onError });

  useEffect(() => {
    setFailed(false);
    probing.current = false;
  }, [src]);

  const report = (element: HTMLVideoElement) => {
    const seconds = element.duration;
    latest.current.onInfo?.({
      durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
      width: element.videoWidth,
      height: element.videoHeight,
    });
  };

  const settleDuration = (element: HTMLVideoElement) => {
    if (!probing.current || !Number.isFinite(element.duration)) return;
    probing.current = false;
    element.currentTime = 0;
    report(element);
  };

  return (
    <div className={cx("px-video-player", className)}>
      {src && !failed ? (
        <video
          ref={video}
          key={src}
          className="px-video-player__video"
          src={src}
          poster={poster ?? undefined}
          aria-label={label}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            if (element.duration === Number.POSITIVE_INFINITY) {
              probing.current = true;
              element.currentTime = FAR_AWAY;
            } else {
              report(element);
            }
          }}
          onDurationChange={(event) => settleDuration(event.currentTarget)}
          onTimeUpdate={(event) => settleDuration(event.currentTarget)}
          onError={() => {
            setFailed(true);
            latest.current.onError?.();
          }}
        />
      ) : null}
      {failed ? (
        <div className="px-video-player__message" role="status">
          <Icon icon={VideoOff} size={24} />
          <span>This video can’t be played in this browser. Download it to watch it in another app.</span>
        </div>
      ) : null}
    </div>
  );
}
