/**
 * Prefer AVC with in-band parameter sets. Chromium can update the H.264 codec
 * description even while canvas dimensions stay fixed; avc1 cannot carry those
 * updates in MP4 samples. avc3 is a container capability, not permission to
 * resize the native recording canvas (the recorder independently enforces it).
 * https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediarecorder/media_recorder_handler.cc
 *
 * Availability is only a hint: construction/start can still fail due to encoder
 * resources. Keep AVC1 and WebM for browsers without usable AVC3 encoding.
 */
export const RECORDING_MIME_CANDIDATES = [
  "video/mp4;codecs=avc3.640033", "video/mp4;codecs=avc3",
  "video/mp4;codecs=avc1.640033", "video/mp4;codecs=avc1", "video/mp4",
  "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm",
] as const;
/** Audio recording never falls back to a video-only codec declaration. */
export const RECORDING_AUDIO_MIME_CANDIDATES = [
  "video/mp4;codecs=avc3.640033,mp4a.40.2", "video/mp4;codecs=avc3,mp4a.40.2",
  "video/mp4;codecs=avc1.640033,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus",
] as const;
export function recordingExtension(mimeType: string): "mp4" | "webm" {
  const container = (mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (container === "video/mp4") return "mp4";
  if (container === "video/webm") return "webm";
  throw new Error("The encoder returned an unsupported video container.");
}
export function recordingBitrate(width: number, height: number, fps: number) {
  return Math.round(Math.min(48_000_000, Math.max(5_000_000, width * height * fps * 0.16)));
}
