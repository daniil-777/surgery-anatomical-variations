import { RECORDING_AUDIO_MIME_CANDIDATES, RECORDING_MIME_CANDIDATES, recordingBitrate, recordingExtension } from "./codecs";
import { containRect } from "./geometry";
import { RECORDING_PROFILES, type RecorderCallbacks, type RecorderState, type RecordingOptions, type RecordingResult, type RecordingStopReason, type SceneRecordingLease } from "./types";

/** Injectable browser boundary; production defaults never request permission until start(). */
export interface RecorderPlatform {
  now(): number;
  createCanvas(): HTMLCanvasElement;
  createVideo(): HTMLVideoElement;
  capture(canvas: HTMLCanvasElement, fps: number): MediaStream;
  getDisplayMedia(options: DisplayMediaStreamOptions): Promise<MediaStream>;
  getUserMedia(options: MediaStreamConstraints): Promise<MediaStream>;
  createStream(tracks: MediaStreamTrack[]): MediaStream;
  isTypeSupported(type: string): boolean;
  createRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, milliseconds: number): number;
  clearTimer(id: number): void;
}
const browserPlatform = (): RecorderPlatform => ({
  now: () => performance.now(),
  createCanvas: () => document.createElement("canvas"),
  createVideo: () => document.createElement("video"),
  capture: (canvas, fps) => {
    if (typeof canvas.captureStream !== "function") throw new Error("This browser cannot capture a scene canvas.");
    return canvas.captureStream(fps);
  },
  getDisplayMedia: options => {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Tab and window recording requires a supported browser on HTTPS or localhost.");
    return navigator.mediaDevices.getDisplayMedia(options);
  },
  getUserMedia: options => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone recording requires a supported browser on HTTPS or localhost.");
    return navigator.mediaDevices.getUserMedia(options);
  },
  createStream: tracks => new MediaStream(tracks),
  isTypeSupported: type => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
  createRecorder: (stream, options) => new MediaRecorder(stream, options),
  requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
  setTimer: (callback, ms) => window.setTimeout(callback, ms), clearTimer: id => window.clearTimeout(id),
});
const initialState = (): RecorderState => ({ status: "idle", elapsedMs: 0, bytes: 0, width: 0, height: 0,
  sourceWidth: 0, sourceHeight: 0, upscaled: false, requestedFps: 30, compositedFrames: 0,
  capturePath: null, mimeType: "", sourceKind: null, sourceLabel: "", audioEnabled: false, microphoneMuted: false,
  microphoneLabel: "", stopReason: null, warning: null, error: null });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const abortError = () => new DOMException("Recording was cancelled.", "AbortError");

interface Session {
  options: RecordingOptions; abort: AbortController; tracks: Set<MediaStreamTrack>; cleanup: Array<() => void>;
  lease?: SceneRecordingLease; video?: HTMLVideoElement; canvas?: HTMLCanvasElement; recorder?: MediaRecorder;
  microphoneTrack?: MediaStreamTrack; videoUnavailable: boolean; microphoneUnavailable: boolean;
  chunks: Blob[]; chunkMime: string; bytes: number; maxBytes: number; maxDurationMs: number;
  startedAt: number | null; activeSince: number | null; elapsedMs: number; lastFrame: number;
  frameId?: number; timerId?: number; stopTimer?: number; done: Promise<RecordingResult | null>;
  resolve: (result: RecordingResult | null) => void; settled: boolean;
}

/** One recorder owner; can be reused after completion/error. dispose() permanently cancels it. */
export class VideoRecorder {
  private readonly platform: RecorderPlatform;
  private state = initialState();
  private session: Session | null = null;
  private disposed = false;
  private lastResult: RecordingResult | null = null;
  constructor(private readonly callbacks: RecorderCallbacks = {}, platform?: RecorderPlatform) {
    this.platform = platform ?? browserPlatform();
  }
  getSnapshot(): RecorderState {
    return { ...this.state, elapsedMs: this.session ? this.elapsed(this.session) : this.state.elapsedMs };
  }
  private elapsed(session: Session) {
    return session.elapsedMs + (session.activeSince === null ? 0 : Math.max(0, this.platform.now() - session.activeSince));
  }
  private emit() {
    if (this.disposed) return;
    try { this.callbacks.onChange?.(this.getSnapshot()); } catch { /* UI observers cannot leak capture resources. */ }
  }
  private current(session: Session) { return !this.disposed && this.session === session && !session.settled && !session.abort.signal.aborted; }
  private ownStream(session: Session, stream: MediaStream) {
    if (!this.current(session)) { stream.getTracks().forEach(track => track.stop()); return false; }
    for (const track of stream.getTracks()) session.tracks.add(track);
    return true;
  }
  private listen(session: Session, target: EventTarget, event: string, callback: EventListener) {
    target.addEventListener(event, callback);
    session.cleanup.push(() => target.removeEventListener(event, callback));
  }
  private updateWarning(session: Session) {
    this.state.warning = [
      session.videoUnavailable ? "The source is temporarily unavailable; recorded frames may freeze." : "",
      session.microphoneUnavailable ? "The microphone is temporarily unavailable; audio may be silent." : "",
    ].filter(Boolean).join(" ") || null;
    this.emit();
  }
  private waitForVideo(session: Session, video: HTMLVideoElement) {
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const clean = () => {
        this.platform.clearTimer(timer);
        video.removeEventListener("loadeddata", ready); video.removeEventListener("canplay", ready);
        video.removeEventListener("error", failed); session.abort.signal.removeEventListener("abort", cancelled);
      };
      const finish = (error?: Error) => { if (finished) return; finished = true; clean(); error ? reject(error) : resolve(); };
      const ready = () => { if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish(); };
      const failed = () => finish(new Error("The selected recording source could not produce video frames."));
      const cancelled = () => finish(abortError());
      const timer = this.platform.setTimer(() => finish(new Error("The selected source did not produce a video frame within 15 seconds.")), 15_000);
      video.addEventListener("loadeddata", ready); video.addEventListener("canplay", ready); video.addEventListener("error", failed);
      session.abort.signal.addEventListener("abort", cancelled, { once: true });
      if (session.abort.signal.aborted) { cancelled(); return; }
      try { Promise.resolve(video.play()).then(ready, error => finish(new Error(`The recording preview could not start: ${message(error)}`))); ready(); }
      catch (error) { finish(new Error(`The recording preview could not start: ${message(error)}`)); }
    });
  }
  async start(options: RecordingOptions): Promise<void> {
    if (this.disposed) throw new Error("This recorder has been disposed.");
    if (this.session && !this.session.settled) throw new Error("Finish the current recording before starting another.");
    const profile = RECORDING_PROFILES.find(item => item.id === options.resolution);
    const fps = options.fps ?? 30, maxBytes = options.maxBytes ?? 256 * 1024 * 1024, maxDurationMs = options.maxDurationMs ?? 600_000;
    if (!profile || ![24, 30, 60].includes(fps) || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 512 * 1024 * 1024 || !Number.isFinite(maxDurationMs) || maxDurationMs < 100 || maxDurationMs > 600_000) throw new Error("Invalid recording resolution, frame rate or safety limits.");
    if (!options.source || !["scene", "display"].includes(options.source.kind)) throw new Error("Choose a recording source.");
    const microphone = options.microphone;
    if (microphone !== undefined && (!microphone || typeof microphone !== "object" || Array.isArray(microphone) ||
      (microphone.deviceId !== undefined && (typeof microphone.deviceId !== "string" || microphone.deviceId.length > 1024)) ||
      (microphone.muted !== undefined && typeof microphone.muted !== "boolean"))) throw new Error("Invalid microphone options.");
    let resolve!: Session["resolve"];
    const done = new Promise<RecordingResult | null>(finish => { resolve = finish; });
    const session: Session = { options, abort: new AbortController(), tracks: new Set(), cleanup: [], chunks: [], chunkMime: "", bytes: 0,
      videoUnavailable: false, microphoneUnavailable: false,
      maxBytes, maxDurationMs, startedAt: null, activeSince: null, elapsedMs: 0, lastFrame: -Infinity, done, resolve, settled: false };
    this.session = session; this.lastResult = null;
    this.state = { ...initialState(), status: "acquiring", width: profile.width, height: profile.height, requestedFps: fps,
      sourceKind: options.source.kind, sourceLabel: options.source.label ?? (options.source.kind === "scene" ? "Scene" : "Shared tab or window"),
      audioEnabled: microphone !== undefined, microphoneMuted: microphone?.muted ?? false };
    this.emit();
    if (!this.current(session)) return;
    try {
      // This call is deliberately before the first await, preserving the Start click's activation.
      const displayRequest = options.source.kind === "display" ? this.platform.getDisplayMedia({ audio: false,
        // A picker preference only; production still requires the user's explicit selection.
        ...(options.source.surfaceHint === "browser" ? { preferCurrentTab: true } : {}),
        video: { frameRate: { ideal: fps, max: fps }, ...(options.source.surfaceHint ? { displaySurface: options.source.surfaceHint } : {}) } }) : null;
      let input: MediaStream;
      if (options.source.kind === "scene") {
        const source = options.source;
        if (!source.canvas.isConnected) throw new Error("The selected scene is no longer visible. Choose its current canvas.");
        if (source.prepare) {
          const lease = await source.prepare({ width: profile.width, height: profile.height, fps, signal: session.abort.signal });
          if (!lease || typeof lease.restore !== "function") throw new Error("The scene did not return a recording restoration lease.");
          if (!this.current(session)) { lease.restore(); return; }
          session.lease = lease;
        }
        if (!this.current(session)) return;
        input = this.platform.capture(source.canvas, fps);
        this.listen(session, source.canvas, "webglcontextlost", () => { if (this.current(session)) void this.stopWithReason("context-lost"); });
      } else {
        input = await displayRequest!;
      }
      if (!this.ownStream(session, input)) return;
      const sourceTracks = input.getVideoTracks();
      if (sourceTracks.length !== 1 || sourceTracks[0]!.readyState === "ended") throw new Error("The selected source has no live video track.");
      if (input.getAudioTracks().length !== 0) throw new Error("The video source unexpectedly included audio. Start again with tab/system audio disabled.");
      for (const track of sourceTracks) {
        this.listen(session, track, "ended", () => { if (this.current(session)) void this.stopWithReason("source-ended"); });
        this.listen(session, track, "mute", () => { if (this.current(session)) { session.videoUnavailable = true; this.updateWarning(session); } });
        this.listen(session, track, "unmute", () => { if (this.current(session)) { session.videoUnavailable = false; this.updateWarning(session); } });
      }
      if (microphone !== undefined) {
        const deviceId = microphone.deviceId;
        const exactDevice = deviceId && deviceId !== "default" ? deviceId : undefined;
        let microphoneStream: MediaStream;
        try {
          // Display capture above retains Start's transient activation; microphone permission may wait.
          microphoneStream = await this.platform.getUserMedia({
            video: false, audio: exactDevice ? { deviceId: { exact: exactDevice } } : true,
          });
        } catch (error) { throw new Error(`The microphone could not start: ${message(error)}`); }
        if (!this.ownStream(session, microphoneStream)) return;
        const audioTracks = microphoneStream.getAudioTracks();
        if (audioTracks.length !== 1 || audioTracks[0]!.readyState === "ended" || microphoneStream.getVideoTracks().length !== 0) {
          throw new Error("The selected microphone did not provide one live audio track.");
        }
        const track = audioTracks[0]!, actualDeviceId = track.getSettings().deviceId;
        // The Windows communications alias may resolve to a physical device ID in settings.
        if (exactDevice && exactDevice !== "communications" && actualDeviceId && actualDeviceId !== exactDevice) {
          throw new Error("The browser did not use the selected microphone. Choose it again.");
        }
        session.microphoneTrack = track; track.enabled = !this.state.microphoneMuted;
        this.state.microphoneLabel = track.label || "Microphone";
        session.microphoneUnavailable = track.muted;
        this.listen(session, track, "ended", () => {
          if (!this.current(session)) return;
          if (this.state.status === "acquiring") this.fail(session, new Error("The microphone disconnected before recording could start."));
          else void this.stopWithReason("microphone-ended");
        });
        this.listen(session, track, "mute", () => { if (this.current(session)) { session.microphoneUnavailable = true; this.updateWarning(session); } });
        this.listen(session, track, "unmute", () => { if (this.current(session)) { session.microphoneUnavailable = false; this.updateWarning(session); } });
        this.updateWarning(session);
        if (!this.current(session)) return;
      }
      const sourceSettings = sourceTracks[0]!.getSettings();
      const nativeCanvas = options.source.kind === "scene" && session.lease &&
        options.source.canvas.width === profile.width && options.source.canvas.height === profile.height &&
        sourceSettings.width === profile.width && sourceSettings.height === profile.height;
      let output = input;
      let context: CanvasRenderingContext2D | null = null;
      if (nativeCanvas) {
        // A native renderer lease owns the exact buffer size. Avoid video decoding and a full 2D copy.
        this.state.capturePath = "native-canvas";
        this.state.sourceWidth = profile.width; this.state.sourceHeight = profile.height;
      } else {
        this.state.capturePath = "compositor";
        // Stream/video capture is safe for WebGL canvases with preserveDrawingBuffer=false.
        const video = this.platform.createVideo(); session.video = video;
        video.muted = true; video.autoplay = true; video.playsInline = true; video.srcObject = input;
        await this.waitForVideo(session, video);
        if (!this.current(session)) return;
        const canvas = this.platform.createCanvas(); session.canvas = canvas; canvas.width = profile.width; canvas.height = profile.height;
        context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("This browser could not allocate the recording canvas.");
        output = this.platform.capture(canvas, fps);
        if (!this.ownStream(session, output)) return;
        const outputTracks = output.getVideoTracks();
        if (outputTracks.length !== 1) throw new Error("The recording canvas did not create one video track.");
        const settings = outputTracks[0]!.getSettings();
        if ((settings.width && settings.width !== profile.width) || (settings.height && settings.height !== profile.height)) throw new Error("The browser did not preserve the selected recording resolution.");
        this.listen(session, outputTracks[0]!, "ended", () => { if (this.current(session) && this.state.status !== "stopping") this.fail(session, new Error("The video encoder lost its capture track.")); });
      }
      if (!this.checkSource(session)) return;
      if (input.getVideoTracks()[0]?.readyState !== "live") throw new Error("The video source ended before recording could start.");
      if (session.microphoneTrack) {
        if (session.microphoneTrack.readyState === "ended") throw new Error("The microphone disconnected before recording could start.");
        // Fixed membership before start; enabled=false mutes without changing the stream's track set.
        output = this.platform.createStream([...output.getVideoTracks(), session.microphoneTrack]);
      }
      this.startEncoder(session, output, recordingBitrate(profile.width, profile.height, fps));
      if (!this.current(session)) return;
      session.startedAt = this.platform.now(); session.activeSince = session.startedAt;
      this.state.status = "recording";
      if (context) this.draw(session, context);
      this.emit();
      if (!this.current(session)) return;
      const frame = () => {
        if (!this.current(session) || this.state.status === "stopping") return;
        if (!this.checkSource(session)) return;
        if (context && this.state.status === "recording" && this.platform.now() - session.lastFrame >= 1000 / fps - 0.5) {
          try { this.draw(session, context); } catch (error) { this.fail(session, error); return; }
        }
        session.frameId = this.platform.requestFrame(frame);
      };
      session.frameId = this.platform.requestFrame(frame);
      const tick = () => {
        if (!this.current(session) || this.state.status === "stopping") return;
        if (!this.checkSource(session)) return;
        if (this.elapsed(session) >= maxDurationMs) { void this.stopWithReason("duration-limit"); return; }
        this.emit();
        if (this.current(session)) session.timerId = this.platform.setTimer(tick, 250);
      };
      session.timerId = this.platform.setTimer(tick, 250);
    } catch (error) {
      if (!this.current(session)) return;
      this.fail(session, error); throw error;
    }
  }
  private checkSource(session: Session) {
    if (session.options.source.kind === "scene" && !session.options.source.canvas.isConnected) { void this.stopWithReason("source-detached"); return false; }
    return this.checkNativeDimensions(session);
  }
  private checkNativeDimensions(session: Session) {
    if (this.state.capturePath === "native-canvas" && session.options.source.kind === "scene" &&
      (session.options.source.canvas.width !== this.state.width || session.options.source.canvas.height !== this.state.height)) {
      this.fail(session, new Error("The native scene dimensions changed during recording. The incomplete video was discarded.")); return false;
    }
    return true;
  }
  private draw(session: Session, context: CanvasRenderingContext2D) {
    const video = session.video!, canvas = session.canvas!;
    if (video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) return;
    const rect = containRect(video.videoWidth, video.videoHeight, canvas.width, canvas.height);
    context.fillStyle = "#000000"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(video, rect.x, rect.y, rect.width, rect.height);
    this.state.sourceWidth = video.videoWidth; this.state.sourceHeight = video.videoHeight;
    this.state.upscaled ||= rect.upscaled; this.state.compositedFrames++;
    session.lastFrame = this.platform.now();
  }
  private startEncoder(session: Session, stream: MediaStream, bitrate: number) {
    const errors: string[] = [];
    for (const mimeType of this.state.audioEnabled ? RECORDING_AUDIO_MIME_CANDIDATES : RECORDING_MIME_CANDIDATES) {
      if (!this.platform.isTypeSupported(mimeType)) continue;
      let recorder: MediaRecorder | undefined;
      try {
        recorder = this.platform.createRecorder(stream, { mimeType, videoBitsPerSecond: bitrate,
          ...(this.state.audioEnabled ? { audioBitsPerSecond: 128_000 } : {}) });
        const encoder = recorder;
        session.recorder = encoder;
        encoder.ondataavailable = event => {
          if (!this.current(session) || !event.data.size) return;
          if (event.data.size > session.maxBytes - session.bytes) { this.fail(session, new Error("The encoder exceeded the recording memory limit. This incomplete video was discarded; choose a shorter recording or lower resolution.")); return; }
          if (event.data.type) {
            try { recordingExtension(event.data.type); } catch (error) { this.fail(session, error); return; }
            if (session.chunkMime && recordingExtension(session.chunkMime) !== recordingExtension(event.data.type)) { this.fail(session, new Error("The encoder changed video container during recording.")); return; }
            session.chunkMime = event.data.type;
          }
          session.chunks.push(event.data); session.bytes += event.data.size; this.state.bytes = session.bytes;
          // Reserve up to 20% / 16 MiB for the final chunk. A pathological oversized chunk fails closed.
          const reserve = Math.min(session.maxBytes * 0.2, 16 * 1024 * 1024);
          if (session.bytes >= session.maxBytes - reserve && this.state.status !== "stopping") void this.stopWithReason("memory-limit");
          this.emit();
        };
        encoder.onerror = event => this.fail(session, new Error(`Video encoder failed${"error" in event ? `: ${message(event.error)}` : "."}`));
        encoder.onstop = () => this.finish(session);
        encoder.start(250);
        this.state.mimeType = encoder.mimeType || mimeType;
        recordingExtension(this.state.mimeType);
        return;
      } catch (error) {
        errors.push(message(error));
        if (recorder) { recorder.ondataavailable = null; recorder.onerror = null; recorder.onstop = null; try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* failed encoder */ } }
        delete session.recorder;
      }
    }
    throw new Error(`No ${this.state.audioEnabled ? "video and microphone" : "video"} encoder could start at this resolution.${errors.length ? ` ${errors[errors.length - 1]}` : " This browser does not support the required MP4 or WebM codecs."}`);
  }
  setMicrophoneMuted(muted: boolean) {
    if (typeof muted !== "boolean") throw new Error("Microphone mute must be true or false.");
    const session = this.session;
    if (!session || !this.current(session) || !this.state.audioEnabled || !["acquiring", "recording", "paused"].includes(this.state.status)) return;
    if (session.microphoneTrack) session.microphoneTrack.enabled = !muted;
    this.state.microphoneMuted = muted; this.emit();
  }
  pause() {
    const session = this.session;
    if (!session || this.state.status !== "recording") return;
    try {
      session.recorder!.pause(); session.elapsedMs = this.elapsed(session); session.activeSince = null;
      this.state.status = "paused"; this.emit();
    } catch (error) { this.fail(session, error); }
  }
  resume() {
    const session = this.session;
    if (!session || this.state.status !== "paused") return;
    try { session.recorder!.resume(); session.activeSince = this.platform.now(); this.state.status = "recording"; this.emit(); }
    catch (error) { this.fail(session, error); }
  }
  stop(): Promise<RecordingResult | null> { return this.stopWithReason("user"); }
  private stopWithReason(reason: RecordingStopReason): Promise<RecordingResult | null> {
    const session = this.session;
    if (!session || session.settled) return Promise.resolve(this.lastResult);
    if (this.state.status === "stopping") return session.done;
    if (this.state.status === "acquiring") {
      this.cleanup(session); session.settled = true; session.resolve(null);
      this.state.status = "idle"; this.state.stopReason = reason; this.emit(); return session.done;
    }
    // Stop can be clicked before the next RAF notices a broken native lease.
    if (!this.checkNativeDimensions(session)) return session.done;
    session.elapsedMs = this.elapsed(session); session.activeSince = null;
    this.state.elapsedMs = session.elapsedMs; this.state.status = "stopping"; this.state.stopReason = reason;
    if (session.frameId !== undefined) this.platform.cancelFrame(session.frameId);
    if (session.timerId !== undefined) this.platform.clearTimer(session.timerId);
    this.emit();
    if (!this.current(session)) return session.done;
    session.stopTimer = this.platform.setTimer(() => this.fail(session, new Error("The video encoder did not finish within 10 seconds; incomplete video was discarded.")), 10_000);
    try { if (session.recorder?.state !== "inactive") session.recorder?.stop(); else this.finish(session); }
    catch (error) { this.fail(session, error); }
    return session.done;
  }
  private finish(session: Session) {
    if (!this.current(session)) return;
    // Encoding finishes asynchronously. AVC3 tolerates parameter-set changes,
    // but a resized native source must never be published as exact-resolution.
    if (!this.checkNativeDimensions(session)) return;
    try {
      const mimeType = session.chunkMime || session.recorder?.mimeType || this.state.mimeType;
      const extension = recordingExtension(mimeType), blob = new Blob(session.chunks, { type: mimeType });
      if (!blob.size) throw new Error("The encoder produced an empty video. Wait for a visible frame before stopping.");
      const durationMs = this.elapsed(session), wallDurationMs = session.startedAt === null ? 0 : this.platform.now() - session.startedAt;
      const result: RecordingResult = { blob, mimeType, extension,
        filename: `viscera-${this.state.sourceKind}-${this.state.width}x${this.state.height}-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
        metrics: { width: this.state.width, height: this.state.height, sourceWidth: this.state.sourceWidth, sourceHeight: this.state.sourceHeight,
          upscaled: this.state.upscaled, requestedFps: this.state.requestedFps, compositedFrames: this.state.compositedFrames, capturePath: this.state.capturePath!,
          durationMs, wallDurationMs, bytes: blob.size, stopReason: this.state.stopReason ?? "source-ended", sourceKind: this.state.sourceKind!,
          audioEnabled: this.state.audioEnabled, microphoneMuted: this.state.microphoneMuted, microphoneLabel: this.state.microphoneLabel, encodedFps: null } };
      this.cleanup(session); session.settled = true; session.resolve(result); this.lastResult = result;
      this.state = { ...this.state, status: "completed", elapsedMs: durationMs, bytes: blob.size, mimeType, stopReason: result.metrics.stopReason };
      this.emit();
      try { if (!this.disposed && this.session === session) this.callbacks.onComplete?.(result); } catch { /* UI observer is separate from encoder completion. */ }
    } catch (error) { this.fail(session, error); }
  }
  private fail(session: Session, error: unknown) {
    if (!this.current(session)) return;
    const elapsedMs = this.elapsed(session);
    this.cleanup(session); session.settled = true; session.resolve(null); this.lastResult = null;
    this.state = { ...this.state, status: "error", elapsedMs, error: message(error) }; this.emit();
  }
  private cleanup(session: Session) {
    session.elapsedMs = this.elapsed(session); session.activeSince = null;
    if (session.frameId !== undefined) this.platform.cancelFrame(session.frameId);
    if (session.timerId !== undefined) this.platform.clearTimer(session.timerId);
    if (session.stopTimer !== undefined) this.platform.clearTimer(session.stopTimer);
    session.cleanup.splice(0).forEach(clean => { try { clean(); } catch { /* continue releasing resources */ } });
    if (session.recorder) {
      session.recorder.ondataavailable = null; session.recorder.onerror = null; session.recorder.onstop = null;
      try { if (session.recorder.state !== "inactive") session.recorder.stop(); } catch { /* release tracks even after encoder failure */ }
    }
    // Keep this order: on normal completion the final data and stop events have
    // arrived; stop capture tracks before abort listeners/lease restoration can
    // resize the source. Restoring at stop() call time could encode a wrong-size
    // final frame while the asynchronous encoder is still draining.
    for (const track of session.tracks) { try { track.stop(); } catch { /* continue releasing independent tracks */ } }
    session.tracks.clear(); session.abort.abort();
    if (session.video) { try { session.video.pause(); session.video.srcObject = null; session.video.removeAttribute("src"); session.video.load(); } catch { /* detached player */ } }
    if (session.lease) { const lease = session.lease; delete session.lease; try { lease.restore(); } catch { /* lease owner must remain safe after viewport unmount */ } }
    session.chunks.length = 0;
    if (session.canvas) { session.canvas.width = 1; session.canvas.height = 1; }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.session && !this.session.settled) { this.cleanup(this.session); this.session.settled = true; this.session.resolve(null); }
    this.lastResult = null; this.state = { ...this.state, status: "disposed" };
  }
}
