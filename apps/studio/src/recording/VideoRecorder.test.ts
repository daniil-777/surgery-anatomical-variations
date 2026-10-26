import { describe, expect, it, vi } from "vitest";
import { VideoRecorder, type RecorderPlatform } from "./VideoRecorder";
import { RECORDING_PROFILES, type RecordingOptions, type RecordingResult } from "./types";
import { containRect } from "./geometry";
import { recordingExtension, RECORDING_MIME_CANDIDATES, RECORDING_AUDIO_MIME_CANDIDATES } from "./codecs";

class Track extends EventTarget {
  readyState = "live"; kind = "video"; stopCalls = 0; enabled = true; muted = false; label = ""; deviceId: string | undefined;
  constructor(readonly width: number, readonly height: number) { super(); }
  getSettings() { return { width: this.width, height: this.height, ...(this.deviceId ? { deviceId: this.deviceId } : {}) }; }
  stop() { this.stopCalls++; this.readyState = "ended"; }
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
class Stream {
  readonly tracks: Track[];
  constructor(readonly track: Track, ...others: Track[]) { this.tracks = [track, ...others]; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === "audio"); }
}
class Canvas extends EventTarget {
  width = 640; height = 480; isConnected = true;
  context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  getContext() { return this.context; }
}
class Video extends EventTarget {
  muted = false; autoplay = false; playsInline = false; readyState = 2;
  videoWidth = 640; videoHeight = 480; private stream: Stream | null = null;
  set srcObject(value: Stream | null) { this.stream = value; if (value) { this.videoWidth = value.track.width; this.videoHeight = value.track.height; } }
  get srcObject() { return this.stream; }
  play = vi.fn(async () => undefined); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
}
class Encoder {
  state = "inactive"; ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null; onerror: ((event: object) => void) | null = null;
  startFails = false; stopHangs = false; finalBytes = 32; stopCalls = 0;
  constructor(readonly mimeType: string) {}
  start() { if (this.startFails) throw new Error("resource unavailable"); this.state = "recording"; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  data(size: number, type = this.mimeType) { this.ondataavailable?.({ data: new Blob([new Uint8Array(size)], { type }) }); }
  stop() {
    this.stopCalls++; this.state = "inactive";
    if (!this.stopHangs) queueMicrotask(() => { this.data(this.finalBytes); this.onstop?.(); });
  }
}
function harness() {
  let now = 0, nextId = 0;
  const frames = new Map<number, FrameRequestCallback>(), timers = new Map<number, { at: number; callback: () => void }>();
  const canvases: Canvas[] = [], videos: Video[] = [], tracks: Track[] = [], encoders: Encoder[] = [], captures: Array<{ width: number; height: number; fps: number }> = [];
  const source = new Canvas();
  const platform: RecorderPlatform = {
    now: () => now,
    createCanvas: () => { const canvas = new Canvas(); canvases.push(canvas); return canvas as unknown as HTMLCanvasElement; },
    createVideo: () => { const video = new Video(); videos.push(video); return video as unknown as HTMLVideoElement; },
    capture: vi.fn((canvas, fps) => { captures.push({ width: canvas.width, height: canvas.height, fps }); const track = new Track(canvas.width, canvas.height); tracks.push(track); return new Stream(track) as unknown as MediaStream; }),
    getDisplayMedia: vi.fn(async () => { const track = new Track(1920, 1200); tracks.push(track); return new Stream(track) as unknown as MediaStream; }),
    getUserMedia: vi.fn(async () => { const track = new Track(0, 0); track.kind = "audio"; track.label = "Test microphone"; tracks.push(track); return new Stream(track) as unknown as MediaStream; }),
    createStream: vi.fn(tracks => new Stream(tracks[0] as unknown as Track, ...tracks.slice(1) as unknown as Track[]) as unknown as MediaStream),
    isTypeSupported: vi.fn(() => true),
    createRecorder: vi.fn((_stream, options) => { const encoder = new Encoder(options.mimeType!); encoders.push(encoder); return encoder as unknown as MediaRecorder; }),
    requestFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelFrame: id => { frames.delete(id); },
    setTimer: (callback, milliseconds) => { const id = ++nextId; timers.set(id, { at: now + milliseconds, callback }); return id; },
    clearTimer: id => { timers.delete(id); },
  };
  function advance(milliseconds: number) {
    const target = now + milliseconds;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, value]) => value.at <= target);
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = target;
  }
  function frame(milliseconds = 34) { advance(milliseconds); const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); }
  const options: RecordingOptions = { source: { kind: "scene", canvas: source as unknown as HTMLCanvasElement }, resolution: "fhd" };
  return { source, platform, canvases, videos, tracks, encoders, captures, options, advance, frame, frames, timers };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("explicit optional microphone recording", () => {
  function native(h: ReturnType<typeof harness>, restore = vi.fn()): RecordingOptions {
    return { ...h.options, microphone: {}, source: { kind: "scene", canvas: h.source as unknown as HTMLCanvasElement,
      prepare: ({ width, height }) => { h.source.width = width; h.source.height = height; return { restore }; } } };
  }
  function audio(label = "Selected microphone", deviceId?: string) {
    const track = new Track(0, 0); track.kind = "audio"; track.label = label; track.deviceId = deviceId; return track;
  }
  it("never acquires or adds audio by default", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    expect(h.platform.getUserMedia).not.toHaveBeenCalled(); await recorder.start(h.options);
    expect(h.platform.getUserMedia).not.toHaveBeenCalled(); expect(h.platform.createStream).not.toHaveBeenCalled();
    expect(vi.mocked(h.platform.createRecorder).mock.calls[0]![0].getAudioTracks()).toHaveLength(0);
    expect(vi.mocked(h.platform.createRecorder).mock.calls[0]![1]).not.toHaveProperty("audioBitsPerSecond");
    expect((await recorder.stop())?.metrics).toMatchObject({ audioEnabled: false, microphoneMuted: false, microphoneLabel: "" });
  });
  it.each([undefined, "", "default"])("requests the browser default for deviceId %s", async deviceId => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, microphone: deviceId === undefined ? {} : { deviceId } });
    expect(h.platform.getUserMedia).toHaveBeenCalledWith({ video: false, audio: true }); await recorder.stop();
  });
  it("requests the exact selected device and combines native video with AAC audio before encoding", async () => {
    const h = harness(), restore = vi.fn(), mic = audio("USB microphone", "usb-id"), recorder = new VideoRecorder({}, h.platform);
    h.platform.getUserMedia = vi.fn(async () => new Stream(mic) as unknown as MediaStream);
    await recorder.start({ ...native(h, restore), microphone: { deviceId: "usb-id" } });
    expect(h.platform.getUserMedia).toHaveBeenCalledWith({ video: false, audio: { deviceId: { exact: "usb-id" } } });
    const [stream, settings] = vi.mocked(h.platform.createRecorder).mock.calls[0]!;
    expect(stream.getVideoTracks()).toEqual([h.tracks[0]]); expect(stream.getAudioTracks()).toEqual([mic]);
    expect(settings).toMatchObject({ mimeType: "video/mp4;codecs=avc3.640033,mp4a.40.2", audioBitsPerSecond: 128_000 });
    expect(h.videos).toHaveLength(0); expect(h.canvases).toHaveLength(0);
    const result = await recorder.stop();
    expect(result?.metrics).toMatchObject({ capturePath: "native-canvas", audioEnabled: true, microphoneMuted: false, microphoneLabel: "USB microphone" });
    expect(JSON.stringify(result?.metrics)).not.toContain("usb-id"); expect(mic.stopCalls).toBe(1); expect(restore).toHaveBeenCalledOnce();
  });
  it("allows the exact communications alias to resolve to a physical device", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform), mic = audio("Communications microphone", "physical-id");
    h.platform.getUserMedia = vi.fn(async () => new Stream(mic) as unknown as MediaStream);
    await recorder.start({ ...h.options, microphone: { deviceId: "communications" } });
    expect(h.platform.getUserMedia).toHaveBeenCalledWith({ video: false, audio: { deviceId: { exact: "communications" } } });
    expect((await recorder.stop())?.metrics.microphoneLabel).toBe("Communications microphone");
  });
  it("combines microphone with the compositor output, not the unscaled source", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, microphone: {} });
    const output = vi.mocked(h.platform.createRecorder).mock.calls[0]![0];
    expect(output.getVideoTracks()).toEqual([h.tracks[2]]); expect(output.getAudioTracks()).toEqual([h.tracks[1]]);
    expect(output.getVideoTracks()[0]!.getSettings()).toMatchObject({ width: 1920, height: 1080 });
    await recorder.stop(); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it("starts the display picker synchronously before microphone permission", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); let grant!: (stream: MediaStream) => void;
    h.platform.getDisplayMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
    const started = recorder.start({ ...h.options, source: { kind: "display" }, microphone: {} });
    expect(h.platform.getDisplayMedia).toHaveBeenCalledOnce(); expect(h.platform.getUserMedia).not.toHaveBeenCalled();
    grant(new Stream(new Track(1920, 1080)) as unknown as MediaStream); await started;
    expect(h.platform.getUserMedia).toHaveBeenCalledOnce(); await recorder.stop();
  });
  it("does not ask for microphone permission after display permission is denied", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    h.platform.getDisplayMedia = vi.fn(async () => { throw new DOMException("Denied", "NotAllowedError"); });
    await expect(recorder.start({ ...h.options, source: { kind: "display" }, microphone: {} })).rejects.toThrow("Denied");
    expect(h.platform.getUserMedia).not.toHaveBeenCalled(); expect(h.encoders).toHaveLength(0);
  });
  it("fails explicitly and restores the scene after microphone denial", async () => {
    const h = harness(), restore = vi.fn(), recorder = new VideoRecorder({}, h.platform);
    h.platform.getUserMedia = vi.fn(async () => { throw new DOMException("Permission denied", "NotAllowedError"); });
    await expect(recorder.start(native(h, restore))).rejects.toThrow(/microphone.*Permission denied/);
    expect(recorder.getSnapshot().status).toBe("error"); expect(h.encoders).toHaveLength(0);
    expect(h.tracks[0]!.stopCalls).toBe(1); expect(restore).toHaveBeenCalledOnce();
  });
  it.each(["cancel", "dispose", "source-ended"] as const)("stops a microphone granted after %s without encoding", async action => {
    const h = harness(), restore = vi.fn(), complete = vi.fn(), recorder = new VideoRecorder({ onComplete: complete }, h.platform);
    let grant!: (stream: MediaStream) => void;
    h.platform.getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
    const started = recorder.start(native(h, restore)); await flush();
    expect(h.platform.getUserMedia).toHaveBeenCalledOnce();
    if (action === "dispose") recorder.dispose();
    else if (action === "source-ended") h.tracks[0]!.end();
    else await recorder.stop();
    const late = audio(); grant(new Stream(late) as unknown as MediaStream); await started;
    expect(late.stopCalls).toBe(1); expect(restore).toHaveBeenCalledOnce(); expect(h.encoders).toHaveLength(0); expect(complete).not.toHaveBeenCalled();
  });
  it("ignores a microphone rejection after cancellation without changing idle state", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); let reject!: (error: unknown) => void;
    h.platform.getUserMedia = () => new Promise((_resolve, fail) => { reject = fail; });
    const started = recorder.start({ ...h.options, microphone: {} }); await flush(); await recorder.stop();
    reject(new DOMException("Denied", "NotAllowedError")); await started; expect(recorder.getSnapshot().status).toBe("idle");
  });
  it.each(["missing", "ended", "multiple", "video", "wrong-device"] as const)("rejects %s microphone output without silently dropping sound", async invalid => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform), mic = audio("Mic", invalid === "wrong-device" ? "different-id" : "selected-id");
    if (invalid === "ended") mic.end();
    const stream = invalid === "missing" ? new Stream(new Track(0, 0)) : invalid === "multiple" ? new Stream(mic, audio()) :
      invalid === "video" ? new Stream(mic, new Track(640, 480)) : new Stream(mic);
    h.platform.getUserMedia = async () => stream as unknown as MediaStream;
    await expect(recorder.start({ ...h.options, microphone: { deviceId: "selected-id" } })).rejects.toThrow(/microphone/);
    expect(h.encoders).toHaveLength(0); expect(stream.getTracks().every(track => track.stopCalls === 1)).toBe(true);
  });
  it("mutes with track.enabled without replacing tracks or encoders, including during pause", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...native(h), microphone: { muted: true } });
    const mic = h.tracks.find(track => track.kind === "audio")!;
    expect(mic.enabled).toBe(false); expect(recorder.getSnapshot().microphoneMuted).toBe(true);
    recorder.setMicrophoneMuted(false); expect(mic.enabled).toBe(true);
    h.advance(100); recorder.pause(); h.advance(500); recorder.setMicrophoneMuted(true); expect(mic.enabled).toBe(false);
    recorder.resume(); h.advance(100); recorder.setMicrophoneMuted(false);
    const result = await recorder.stop();
    expect(result?.metrics).toMatchObject({ durationMs: 200, audioEnabled: true, microphoneMuted: false });
    expect(h.encoders).toHaveLength(1); expect(h.platform.createStream).toHaveBeenCalledOnce(); expect(mic.stopCalls).toBe(1);
    recorder.setMicrophoneMuted(true); expect(recorder.getSnapshot().microphoneMuted).toBe(false);
  });
  it("remembers mute changes while microphone permission is pending", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); let grant!: (stream: MediaStream) => void;
    h.platform.getUserMedia = () => new Promise(resolve => { grant = resolve; });
    const started = recorder.start({ ...h.options, microphone: {} }); await flush(); recorder.setMicrophoneMuted(true);
    const mic = audio(); grant(new Stream(mic) as unknown as MediaStream); await started;
    expect(mic.enabled).toBe(false); expect((await recorder.stop())?.metrics.microphoneMuted).toBe(true);
  });
  it("finalizes one usable clip when the microphone ends during pause", async () => {
    const h = harness(), completed = vi.fn(), recorder = new VideoRecorder({ onComplete: completed }, h.platform);
    await recorder.start(native(h)); h.advance(100); recorder.pause();
    h.tracks.find(track => track.kind === "audio")!.end(); await flush();
    const result = await recorder.stop();
    expect(result?.metrics).toMatchObject({ stopReason: "microphone-ended", audioEnabled: true, durationMs: 100 });
    expect(result?.blob.size).toBeGreaterThan(0); expect(completed).toHaveBeenCalledOnce(); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it("keeps independent microphone/video interruption warnings", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(native(h));
    const mic = h.tracks.find(track => track.kind === "audio")!, video = h.tracks[0]!;
    mic.dispatchEvent(new Event("mute")); video.dispatchEvent(new Event("mute"));
    expect(recorder.getSnapshot().warning).toMatch(/microphone/); video.dispatchEvent(new Event("unmute"));
    expect(recorder.getSnapshot().warning).toMatch(/microphone/); expect(recorder.getSnapshot().microphoneMuted).toBe(false);
    mic.dispatchEvent(new Event("unmute")); expect(recorder.getSnapshot().warning).toBeNull(); await recorder.stop();
  });
  it("uses actual WebM/Opus fallback without trying video-only codecs", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    h.platform.isTypeSupported = vi.fn(type => type === "video/webm;codecs=vp9,opus");
    await recorder.start(native(h)); const result = await recorder.stop();
    expect(result).toMatchObject({ mimeType: "video/webm;codecs=vp9,opus", extension: "webm" });
    expect(vi.mocked(h.platform.isTypeSupported).mock.calls.every(([type]) => /mp4a|opus/.test(type))).toBe(true);
  });
  it("fails rather than starting video-only when no paired audio codec is supported", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    h.platform.isTypeSupported = vi.fn(type => !/mp4a|opus/.test(type));
    await expect(recorder.start(native(h))).rejects.toThrow(/video and microphone/);
    expect(h.encoders).toHaveLength(0); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it.each(["encoder-error", "memory-limit"] as const)("stops owned microphone tracks on %s", async reason => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...native(h), maxBytes: 1024 });
    if (reason === "encoder-error") h.encoders[0]!.onerror?.({ error: new Error("Failed") });
    else h.encoders[0]!.data(850);
    await flush(); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true); expect(h.timers.size).toBe(0);
  });
  it("rejects unexpected system/tab audio and never includes it", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform), screen = new Track(1920, 1080), sound = audio();
    h.platform.getDisplayMedia = async () => new Stream(screen, sound) as unknown as MediaStream;
    await expect(recorder.start({ ...h.options, source: { kind: "display" }, microphone: {} })).rejects.toThrow(/unexpectedly included audio/);
    expect(h.platform.getUserMedia).not.toHaveBeenCalled(); expect(screen.stopCalls).toBe(1); expect(sound.stopCalls).toBe(1);
  });
  it.each([null, true, [], { muted: "yes" }, { deviceId: 1 }, { deviceId: "x".repeat(1025) }])("rejects invalid audio options before permission: %j", async microphone => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await expect(recorder.start({ ...h.options, microphone } as RecordingOptions)).rejects.toThrow(/microphone options/);
    expect(h.platform.getUserMedia).not.toHaveBeenCalled(); expect(h.platform.getDisplayMedia).not.toHaveBeenCalled();
  });
});


describe("exact output geometry and honest metadata", () => {
  it.each(RECORDING_PROFILES)("encodes the $label canvas dimensions", async profile => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, resolution: profile.id }); h.advance(100);
    const result = await recorder.stop();
    expect(h.captures[1]).toEqual({ width: profile.width, height: profile.height, fps: 30 });
    expect(result?.metrics).toMatchObject({ width: profile.width, height: profile.height, sourceWidth: 640, sourceHeight: 480, upscaled: true, encodedFps: null });
    expect(h.canvases[0]!.context.drawImage).toHaveBeenCalledWith(h.videos[0], profile.width / 8, 0, profile.width * 3 / 4, profile.height);
    expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it("preserves a wide or portrait source without crop or distortion", () => {
    expect(containRect(3840, 1080, 1920, 1080)).toEqual({ x: 0, y: 270, width: 1920, height: 540, upscaled: false });
    expect(containRect(1080, 1920, 1920, 1080)).toEqual({ x: 656.25, y: 0, width: 607.5, height: 1080, upscaled: false });
    expect(() => containRect(0, 10, 1920, 1080)).toThrow();
  });
  it("uses native preparation and restores only once after completion", async () => {
    const h = harness(), restore = vi.fn(() => { h.source.width = 640; h.source.height = 480; });
    const recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, source: { kind: "scene", canvas: h.source as unknown as HTMLCanvasElement,
      prepare: ({ width, height, signal }) => { expect(signal.aborted).toBe(false); h.source.width = width; h.source.height = height; return { restore }; } } });
    const result = await recorder.stop(); recorder.dispose();
    expect(result?.metrics.upscaled).toBe(false); expect(restore).toHaveBeenCalledTimes(1);
  });
  it("adapts letterboxing to changed source dimensions and remembers any upscaling", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(h.options);
    h.videos[0]!.videoWidth = 3840; h.videos[0]!.videoHeight = 2160; h.frame();
    expect(recorder.getSnapshot()).toMatchObject({ sourceWidth: 3840, sourceHeight: 2160, upscaled: true });
    expect(h.canvases[0]!.context.drawImage).toHaveBeenLastCalledWith(h.videos[0], 0, 0, 1920, 1080); await recorder.stop();
  });
});

describe("verified native canvas path", () => {
  function nativeOptions(h: ReturnType<typeof harness>, restore = vi.fn()): RecordingOptions {
    return { ...h.options, source: { kind: "scene", canvas: h.source as unknown as HTMLCanvasElement,
      prepare: ({ width, height }) => { h.source.width = width; h.source.height = height; return { restore }; } } };
  }
  it.each(RECORDING_PROFILES)("records $label without a video decoder or compositor allocation", async profile => {
    const h = harness(), restore = vi.fn(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...nativeOptions(h, restore), resolution: profile.id }); h.frame();
    expect(h.videos).toHaveLength(0); expect(h.canvases).toHaveLength(0);
    expect(h.captures).toEqual([{ width: profile.width, height: profile.height, fps: 30 }]);
    const result = await recorder.stop();
    expect(result?.metrics).toMatchObject({ capturePath: "native-canvas", width: profile.width, height: profile.height,
      sourceWidth: profile.width, sourceHeight: profile.height, upscaled: false, compositedFrames: 0, encodedFps: null });
    expect(restore).toHaveBeenCalledTimes(1); expect(h.tracks[0]!.stopCalls).toBe(1);
    // Cleanup owns no compositor, so it must never shrink the borrowed scene canvas to 1x1.
    expect(h.source.width).toBe(profile.width); expect(h.source.height).toBe(profile.height);
  });
  it("requires a native size lease even when an unleased canvas happens to match", async () => {
    const h = harness(); h.source.width = 1920; h.source.height = 1080;
    const recorder = new VideoRecorder({}, h.platform); await recorder.start(h.options);
    expect(recorder.getSnapshot().capturePath).toBe("compositor"); expect(h.captures).toHaveLength(2); await recorder.stop();
  });
  it("uses the compositor when a prepared source does not match the target", async () => {
    const h = harness(), restore = vi.fn(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, source: { kind: "scene", canvas: h.source as unknown as HTMLCanvasElement, prepare: () => ({ restore }) } });
    expect(recorder.getSnapshot()).toMatchObject({ capturePath: "compositor", upscaled: true }); await recorder.stop(); expect(restore).toHaveBeenCalledOnce();
  });
  it("rejects a lease-breaking dimension change and releases the source", async () => {
    const h = harness(), restore = vi.fn(), completed = vi.fn(), recorder = new VideoRecorder({ onComplete: completed }, h.platform);
    await recorder.start(nativeOptions(h, restore)); h.encoders[0]!.data(100); h.source.width = 640; h.frame();
    expect(recorder.getSnapshot()).toMatchObject({ status: "error" }); expect(recorder.getSnapshot().error).toMatch(/dimensions changed/);
    expect(completed).not.toHaveBeenCalled(); expect(restore).toHaveBeenCalledOnce(); expect(h.tracks[0]!.stopCalls).toBe(1);
  });
  it("holds the native dimensions through asynchronous encoder drainage and stops tracks before restoring", async () => {
    const h = harness(), events: string[] = [], restore = vi.fn(() => {
      events.push("restore"); expect(h.tracks[0]!.readyState).toBe("ended");
      h.source.width = 640; h.source.height = 480;
    });
    const recorder = new VideoRecorder({}, h.platform); await recorder.start(nativeOptions(h, restore));
    const encoder = h.encoders[0]!; encoder.stopHangs = true;
    const pending = recorder.stop(); h.advance(400);
    expect(recorder.getSnapshot().status).toBe("stopping");
    expect(h.source.width).toBe(1920); expect(h.source.height).toBe(1080);
    expect(restore).not.toHaveBeenCalled(); expect(h.tracks[0]!.stopCalls).toBe(0);
    events.push("final-data"); encoder.data(64); events.push("onstop"); encoder.onstop?.();
    expect((await pending)?.metrics).toMatchObject({ width: 1920, height: 1080, capturePath: "native-canvas" });
    expect(events).toEqual(["final-data", "onstop", "restore"]); expect(restore).toHaveBeenCalledOnce();
  });
  it.each(["before-stop", "while-stopping"] as const)("rejects native resizing %s even without another animation frame", async when => {
    const h = harness(), completed = vi.fn(), recorder = new VideoRecorder({ onComplete: completed }, h.platform);
    await recorder.start(nativeOptions(h)); const encoder = h.encoders[0]!; encoder.stopHangs = true; encoder.data(64);
    if (when === "before-stop") h.source.width = 640;
    const pending = recorder.stop();
    if (when === "while-stopping") { h.source.height = 480; encoder.data(64); encoder.onstop?.(); }
    expect(await pending).toBeNull(); expect(recorder.getSnapshot().error).toMatch(/dimensions changed/);
    expect(completed).not.toHaveBeenCalled(); expect(h.tracks[0]!.stopCalls).toBe(1);
  });
  it("finalizes direct recording on source ending during pause", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(nativeOptions(h)); h.advance(500); recorder.pause();
    h.tracks[0]!.end(); await flush(); const result = await recorder.stop();
    expect(result?.metrics).toMatchObject({ capturePath: "native-canvas", stopReason: "source-ended", durationMs: 500 });
    expect(h.tracks[0]!.stopCalls).toBe(1);
  });
  it("rejects an empty direct recording rather than inventing a successful clip", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(nativeOptions(h)); h.encoders[0]!.finalBytes = 0;
    expect(await recorder.stop()).toBeNull(); expect(recorder.getSnapshot().error).toMatch(/empty video/);
  });
});

describe("lifecycle and permissions", () => {
  it("does not request a picker on construction and invokes it before the first await on Start", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); expect(h.platform.getDisplayMedia).not.toHaveBeenCalled();
    const started = recorder.start({ ...h.options, source: { kind: "display", surfaceHint: "browser" } });
    expect(h.platform.getDisplayMedia).toHaveBeenCalledOnce();
    expect(h.platform.getDisplayMedia).toHaveBeenCalledWith({ audio: false, preferCurrentTab: true, video: { frameRate: { ideal: 30, max: 30 }, displaySurface: "browser" } });
    await started; await recorder.stop();
  });
  it.each(["window", "monitor", undefined] as const)("does not prefer the current tab for surface hint %s", async surfaceHint => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, source: { kind: "display", ...(surfaceHint ? { surfaceHint } : {}) } });
    const options = vi.mocked(h.platform.getDisplayMedia).mock.calls[0]![0];
    expect(options).not.toHaveProperty("preferCurrentTab"); expect(options.audio).toBe(false);
    await recorder.stop();
  });
  it("excludes pause from active duration, freezes elapsed after stop and completes once", async () => {
    const h = harness(), completed = vi.fn(), recorder = new VideoRecorder({ onComplete: completed }, h.platform);
    await recorder.start(h.options); h.advance(1000); recorder.pause(); h.advance(5000);
    expect(recorder.getSnapshot().elapsedMs).toBe(1000); recorder.resume(); h.advance(2000);
    const first = recorder.stop(), second = recorder.stop(); expect(second).toBe(first);
    const result = await first; h.advance(10_000);
    expect(result?.metrics).toMatchObject({ durationMs: 3000, wallDurationMs: 8000, stopReason: "user" });
    expect(recorder.getSnapshot().elapsedMs).toBe(3000); expect(completed).toHaveBeenCalledTimes(1);
    expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0);
  });
  it("stops and finalizes exactly once when sharing ends while paused", async () => {
    const h = harness(), completed = vi.fn(), recorder = new VideoRecorder({ onComplete: completed }, h.platform);
    await recorder.start(h.options); h.advance(100); recorder.pause(); h.tracks[0]!.end(); await flush();
    expect(recorder.getSnapshot()).toMatchObject({ status: "completed", stopReason: "source-ended" });
    expect(completed).toHaveBeenCalledTimes(1); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it.each(["source-detached", "context-lost"] as const)("finalizes when %s", async reason => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(h.options);
    if (reason === "source-detached") { h.source.isConnected = false; h.frame(); }
    else h.source.dispatchEvent(new Event("webglcontextlost"));
    await flush(); expect(recorder.getSnapshot()).toMatchObject({ status: "completed", stopReason: reason });
  });
  it("warns for muted sources and clears the warning on recovery", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(h.options);
    h.tracks[0]!.dispatchEvent(new Event("mute")); expect(recorder.getSnapshot().warning).toMatch(/temporarily unavailable/);
    h.tracks[0]!.dispatchEvent(new Event("unmute")); expect(recorder.getSnapshot().warning).toBeNull(); await recorder.stop();
  });
  it("releases a display stream granted after cancellation, without stale UI callbacks", async () => {
    const h = harness(); let grant!: (stream: MediaStream) => void;
    h.platform.getDisplayMedia = () => new Promise(resolve => { grant = resolve; });
    const changed = vi.fn(), completed = vi.fn(), recorder = new VideoRecorder({ onChange: changed, onComplete: completed }, h.platform);
    const pending = recorder.start({ ...h.options, source: { kind: "display" } }); recorder.dispose(); const count = changed.mock.calls.length;
    const late = new Track(1920, 1080); grant(new Stream(late) as unknown as MediaStream); await pending;
    expect(late.stopCalls).toBe(1); expect(changed).toHaveBeenCalledTimes(count); expect(completed).not.toHaveBeenCalled();
    expect(h.videos).toHaveLength(0); expect(recorder.getSnapshot().status).toBe("disposed");
  });
  it("restores an asynchronous lease arriving after cancellation", async () => {
    const h = harness(); let grant!: (lease: { restore(): void }) => void; const restore = vi.fn();
    const recorder = new VideoRecorder({}, h.platform);
    const started = recorder.start({ ...h.options, source: { kind: "scene", canvas: h.source as unknown as HTMLCanvasElement,
      prepare: () => new Promise(resolve => { grant = resolve; }) } });
    expect(await recorder.stop()).toBeNull(); grant({ restore }); await started;
    expect(restore).toHaveBeenCalledTimes(1); expect(h.captures).toHaveLength(0); expect(recorder.getSnapshot().status).toBe("idle");
  });
  it("rejects concurrent Start without disturbing the active capture", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(h.options);
    await expect(recorder.start(h.options)).rejects.toThrow(/Finish/); expect(recorder.getSnapshot().status).toBe("recording"); await recorder.stop();
  });
  it.each(["recording", "stopping"] as const)("does not schedule work after an observer disposes during %s", async status => {
    const h = harness();
    const recorder = new VideoRecorder({ onChange: state => { if (state.status === status) recorder.dispose(); } }, h.platform);
    await recorder.start(h.options);
    if (status === "stopping") await recorder.stop();
    expect(recorder.getSnapshot().status).toBe("disposed"); expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0);
    expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it("does not reschedule progress after an observer disposes during a timer tick", async () => {
    const h = harness();
    const recorder = new VideoRecorder({ onChange: state => { if (state.elapsedMs >= 250) recorder.dispose(); } }, h.platform);
    await recorder.start(h.options); h.advance(250);
    expect(recorder.getSnapshot().status).toBe("disposed"); expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0);
  });
  it("permits a fresh session after completion", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(h.options); await recorder.stop();
    await recorder.start({ ...h.options, resolution: "hd" }); expect(recorder.getSnapshot()).toMatchObject({ status: "recording", bytes: 0, width: 1280 }); await recorder.stop();
  });
});

describe("bounded encoding and failure cleanup", () => {
  it.each([false, true])("prefers supported AVC3 and retains explicit audio pairing (audio=%s)", async audio => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, ...(audio ? { microphone: {} } : {}) });
    expect(h.encoders[0]!.mimeType).toBe(audio ? RECORDING_AUDIO_MIME_CANDIDATES[0] : RECORDING_MIME_CANDIDATES[0]);
    expect((await recorder.stop())?.mimeType).toContain("avc3");
  });
  it.each([false, true])("falls back to AVC1 when AVC3 is not supported (audio=%s)", async audio => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    h.platform.isTypeSupported = vi.fn(mime => !mime.includes("avc3"));
    await recorder.start({ ...h.options, ...(audio ? { microphone: {} } : {}) });
    expect(h.encoders[0]!.mimeType).toBe(`video/mp4;codecs=avc1.640033${audio ? ",mp4a.40.2" : ""}`);
    expect((await recorder.stop())?.extension).toBe("mp4");
  });
  it.each(["construct", "start"] as const)("falls back after advertised AVC3 fails at %s without releasing the source", async failure => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    h.platform.createRecorder = vi.fn((_stream, options) => {
      if (options.mimeType!.includes("avc3") && failure === "construct") throw new DOMException("No AVC3 resource", "NotSupportedError");
      const encoder = new Encoder(options.mimeType!);
      encoder.startFails = options.mimeType!.includes("avc3"); h.encoders.push(encoder);
      return encoder as unknown as MediaRecorder;
    });
    await recorder.start(h.options);
    expect(recorder.getSnapshot().mimeType).toBe("video/mp4;codecs=avc1.640033");
    expect(h.tracks.every(track => track.stopCalls === 0)).toBe(true);
    expect((await recorder.stop())?.extension).toBe("mp4");
    expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it("falls back when a supported codec cannot start, and uses the actual container", async () => {
    const h = harness(); h.platform.createRecorder = vi.fn((_stream, options) => {
      const encoder = new Encoder(options.mimeType!.includes("mp4") ? options.mimeType! : "video/webm;codecs=vp8");
      encoder.startFails = options.mimeType!.includes("mp4"); h.encoders.push(encoder); return encoder as unknown as MediaRecorder;
    });
    const recorder = new VideoRecorder({}, h.platform); await recorder.start(h.options); const result = await recorder.stop();
    expect(h.encoders).toHaveLength(RECORDING_MIME_CANDIDATES.filter(mime => mime.startsWith("video/mp4")).length + 1);
    expect(result?.extension).toBe("webm"); expect(result?.blob.type).toBe("video/webm;codecs=vp8"); expect(result?.filename.endsWith(".webm")).toBe(true);
  });
  it("prefers actual Blob container metadata to a different advertised container", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(h.options);
    h.encoders[0]!.data(64, "video/webm"); h.encoders[0]!.finalBytes = 0;
    expect((await recorder.stop())?.extension).toBe("webm"); expect(() => recordingExtension("application/octet-stream")).toThrow();
  });
  it("rejects unsupported codecs and releases the native lease and every acquired track", async () => {
    const h = harness(), restore = vi.fn(); h.platform.isTypeSupported = () => false;
    const recorder = new VideoRecorder({}, h.platform);
    await expect(recorder.start({ ...h.options, source: { kind: "scene", canvas: h.source as unknown as HTMLCanvasElement, prepare: () => ({ restore }) } })).rejects.toThrow(/No video encoder/);
    expect(restore).toHaveBeenCalledTimes(1); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true); expect(h.timers.size).toBe(0);
  });
  it("finalizes a valid clip before the retained memory cap, with an explicit stop reason", async () => {
    const h = harness(), completed: RecordingResult[] = [], recorder = new VideoRecorder({ onComplete: value => completed.push(value) }, h.platform);
    await recorder.start({ ...h.options, maxBytes: 1024 }); h.encoders[0]!.data(850); await flush();
    expect(recorder.getSnapshot()).toMatchObject({ status: "completed", stopReason: "memory-limit", bytes: 882 });
    expect(completed[0]?.blob.size).toBeLessThanOrEqual(1024); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it("discards an unexpectedly oversized encoder chunk instead of returning truncated video", async () => {
    const h = harness(), completed = vi.fn(), recorder = new VideoRecorder({ onComplete: completed }, h.platform);
    await recorder.start({ ...h.options, maxBytes: 1024 }); h.encoders[0]!.data(2048);
    expect(recorder.getSnapshot()).toMatchObject({ status: "error", bytes: 0 }); expect(recorder.getSnapshot().error).toMatch(/memory limit/);
    expect(await recorder.stop()).toBeNull(); expect(completed).not.toHaveBeenCalled(); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it("stops on the active duration cap even if animation frames are throttled", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start({ ...h.options, maxDurationMs: 1000 });
    h.advance(500); recorder.pause(); h.advance(5000); expect(recorder.getSnapshot().status).toBe("paused");
    recorder.resume(); h.advance(500); await flush(); expect(recorder.getSnapshot()).toMatchObject({ status: "completed", stopReason: "duration-limit", elapsedMs: 1000 });
  });
  it("does not hang forever if the encoder never emits stop", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await recorder.start(h.options); h.encoders[0]!.stopHangs = true;
    const pending = recorder.stop(); h.advance(10_000); expect(await pending).toBeNull(); expect(recorder.getSnapshot().error).toMatch(/did not finish/); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it("fails cleanly for encoder errors and does not publish a partial file", async () => {
    const h = harness(), completed = vi.fn(), recorder = new VideoRecorder({ onComplete: completed }, h.platform); await recorder.start(h.options);
    h.encoders[0]!.data(100); h.encoders[0]!.onerror?.({ error: new Error("encoder overload") }); await flush();
    expect(recorder.getSnapshot()).toMatchObject({ status: "error" }); expect(completed).not.toHaveBeenCalled(); expect(await recorder.stop()).toBeNull();
  });
  it("times out a source that produces no first frame, releasing all resources", async () => {
    const h = harness(); h.platform.createVideo = () => { const video = new Video(); video.readyState = 0; h.videos.push(video); return video as unknown as HTMLVideoElement; };
    const recorder = new VideoRecorder({}, h.platform); const started = recorder.start(h.options); const rejected = expect(started).rejects.toThrow(/15 seconds/);
    await flush(); h.advance(15_000); await rejected; expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true); expect(h.timers.size).toBe(0);
  });
  it("returns permission denial without retrying the picker", async () => {
    const h = harness(); h.platform.getDisplayMedia = vi.fn(async () => { throw new DOMException("Permission denied", "NotAllowedError"); });
    const recorder = new VideoRecorder({}, h.platform);
    await expect(recorder.start({ ...h.options, source: { kind: "display" } })).rejects.toThrow(/Permission denied/);
    expect(h.platform.getDisplayMedia).toHaveBeenCalledOnce(); expect(recorder.getSnapshot().status).toBe("error"); expect(h.tracks).toHaveLength(0);
  });
  it("restores the lease if source capture throws before an encoder exists", async () => {
    const h = harness(), restore = vi.fn(); h.platform.capture = () => { throw new Error("SecurityError: not origin-clean"); };
    const recorder = new VideoRecorder({}, h.platform);
    await expect(recorder.start({ ...h.options, source: { kind: "scene", canvas: h.source as unknown as HTMLCanvasElement, prepare: () => ({ restore }) } })).rejects.toThrow(/origin-clean/);
    expect(restore).toHaveBeenCalledTimes(1); expect(recorder.getSnapshot().status).toBe("error");
  });
  it("cleans up when initial composition throws", async () => {
    const h = harness(); h.platform.createCanvas = () => { const canvas = new Canvas(); canvas.context.drawImage.mockImplementation(() => { throw new Error("draw failed"); }); return canvas as unknown as HTMLCanvasElement; };
    const recorder = new VideoRecorder({}, h.platform); await expect(recorder.start(h.options)).rejects.toThrow(/draw failed/);
    expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true);
  });
  it("disposal aborts first-frame waiting, kills streams and never emits completion", async () => {
    const h = harness(), complete = vi.fn(); h.platform.createVideo = () => { const video = new Video(); video.readyState = 0; return video as unknown as HTMLVideoElement; };
    const recorder = new VideoRecorder({ onComplete: complete }, h.platform), started = recorder.start(h.options);
    recorder.dispose(); await started; expect(complete).not.toHaveBeenCalled(); expect(h.tracks.every(track => track.stopCalls === 1)).toBe(true); expect(h.timers.size).toBe(0);
  });
  it.each([0, -1, NaN, Infinity, 600_001])("rejects invalid duration %s before capturing", async maxDurationMs => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform); await expect(recorder.start({ ...h.options, maxDurationMs })).rejects.toThrow(/Invalid/); expect(h.captures).toHaveLength(0);
  });
});


describe("persistent full-app capture", () => {
  it("encodes the display track directly without background animation frames or canvas copies", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, source: { kind: "display", native: true, surfaceHint: "browser" }, microphone: {} });
    expect(h.platform.getDisplayMedia).toHaveBeenCalledWith({ audio:false, selfBrowserSurface:"exclude", surfaceSwitching:"include", video:{ frameRate:{ideal:30,max:30}, width:{ideal:1920,max:1920}, height:{ideal:1080,max:1080}, displaySurface:"browser" } });
    expect(h.canvases).toHaveLength(0); expect(h.videos).toHaveLength(0); expect(h.frames.size).toBe(0);
    expect(vi.mocked(h.platform.createRecorder).mock.calls[0]![0].getVideoTracks()[0]).toBe(h.tracks[0]);
    expect(vi.mocked(h.platform.createRecorder).mock.calls[0]![0].getAudioTracks()).toHaveLength(1);
    h.advance(1000); recorder.pause(); h.advance(500); recorder.resume(); recorder.setMicrophoneMuted(true); h.advance(1000);
    expect((await recorder.stop())?.metrics).toMatchObject({ capturePath:"native-display", width:1920, height:1200, sourceWidth:1920, sourceHeight:1200, compositedFrames:0, durationMs:2000, audioEnabled:true, microphoneMuted:true });
    expect(h.tracks.every(t => t.readyState === "ended")).toBe(true);
  });
  it("finalizes when browser sharing ends, without waiting for an animation frame", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, source: { kind:"display", native:true } });
    h.advance(500); h.tracks[0]!.end(); await flush();
    expect((await recorder.stop())?.metrics).toMatchObject({ stopReason:"source-ended", durationMs:500, capturePath:"native-display" });
  });
  it("retains the duration guard while the controller is in the background", async () => {
    const h = harness(), recorder = new VideoRecorder({}, h.platform);
    await recorder.start({ ...h.options, source: { kind:"display", native:true }, maxDurationMs:1000 });
    h.advance(1500); await flush();
    expect((await recorder.stop())?.metrics.stopReason).toBe("duration-limit");
  });
});
