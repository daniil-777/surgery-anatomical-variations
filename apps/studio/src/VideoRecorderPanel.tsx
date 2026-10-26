import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, ArrowDownToLine, Check, Circle, Film, Mic, MicOff, Monitor, Pause, Play, Square, Video, X } from "lucide-react";
import { VideoRecorder, RECORDING_PROFILES, type RecorderState, type RecordingResolution, type RecordingResult } from "./recording";
import { getSceneRecordingSource } from "./sceneRecordingSource";
import "./videoRecorder.css";

const busy = (state: RecorderState | null) => Boolean(state && ["acquiring", "recording", "paused", "stopping"].includes(state.status));
const clock = (ms: number) => `${Math.floor(ms / 60_000).toString().padStart(2, "0")}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}`;
const size = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
const RecorderContext = createContext<{
  state: RecorderState | null;
  open: (trigger: HTMLButtonElement) => void;
  pause: () => void;
  stop: () => void;
  mute: () => void;
}>({ state: null, open: () => {}, pause: () => {}, stop: () => {}, mute: () => {} });

function sceneCanvas(scope: HTMLElement | null) {
  const candidates = [...(scope ?? document).querySelectorAll<HTMLCanvasElement>("canvas")];
  return candidates.filter(canvas => {
    const rect = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
    return rect.width > 20 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none" && getSceneRecordingSource(canvas);
  }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? null;
}

function keepDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const elements = [...event.currentTarget.querySelectorAll<HTMLElement>("button,a[href],input,select,textarea,video[controls],[tabindex]")]
    .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
  const stops = elements.filter(element => !(element instanceof HTMLInputElement && element.type === "radio" && !element.checked &&
    elements.some(other => other instanceof HTMLInputElement && other.type === "radio" && other.name === element.name && other.checked)));
  const first = stops[0], last = stops.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

export const useVideoRecorder = () => useContext(RecorderContext);

export function VideoRecorderProvider({ children, appWindow = false }: { children: ReactNode; appWindow?: boolean }) {
  const engine = useRef<VideoRecorder | null>(null), dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null), scope = useRef<HTMLElement | null>(null);
  const mounted = useRef(false), deviceScan = useRef(0), microphoneAccess = useRef(false);
  const discoveryStream = useRef<MediaStream | null>(null), discoveryEpoch = useRef(0);
  const [state, setState] = useState<RecorderState | null>(null);
  const [opened, setOpened] = useState(appWindow), [source, setSource] = useState<"scene" | "display">(appWindow ? "display" : "scene");
  const [resolution, setResolution] = useState<RecordingResolution>("fhd"), [fps, setFps] = useState<24 | 30 | 60>(30);
  const [result, setResult] = useState<RecordingResult | null>(null), [resultUrl, setResultUrl] = useState("");
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null), [localError, setLocalError] = useState("");
  const [microphoneEnabled, setMicrophoneEnabled] = useState(appWindow), [microphoneId, setMicrophoneId] = useState("default");
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]), [microphonePermission, setMicrophonePermission] = useState(false);
  const [requestingMicrophone, setRequestingMicrophone] = useState(false), [microphoneError, setMicrophoneError] = useState("");
  const heading = useId(), active = busy(state);
  const mediaSupported = typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";
  const displaySupported = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const microphoneSupported = Boolean(navigator.mediaDevices?.getUserMedia);
  const missingMicrophone = microphoneEnabled && microphoneId !== "default" && !microphones.some(device => device.deviceId === microphoneId);
  const profile = RECORDING_PROFILES.find(item => item.id === resolution)!;
  const cancelMicrophoneDiscovery = useCallback(() => {
    discoveryEpoch.current++; deviceScan.current++;
    discoveryStream.current?.getTracks().forEach(track => track.stop());
    discoveryStream.current = null; microphoneAccess.current = false;
    if (mounted.current) setRequestingMicrophone(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    const recorder = new VideoRecorder({
      onChange: next => { if (alive) { setState(next); if (next.status === "error") setOpened(true); } },
      onComplete: completed => { if (alive) { setResult(completed); setOpened(true); } },
    });
    engine.current = recorder; setState(recorder.getSnapshot());
    return () => { alive = false; mounted.current = false; cancelMicrophoneDiscovery(); recorder.dispose(); engine.current = null; };
  }, [cancelMicrophoneDiscovery]);
  const refreshMicrophones = useCallback(async () => {
    const scan = ++deviceScan.current;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput");
    if (mounted.current && scan === deviceScan.current) {
      setMicrophones(devices);
      if (devices.some(device => device.label)) setMicrophonePermission(true);
    }
  }, []);
  useEffect(() => {
    if (!opened || !microphoneEnabled || !microphoneSupported) return;
    const refresh = () => { void refreshMicrophones().catch(() => {
      if (mounted.current) setMicrophoneError("Microphones could not be listed. Allow microphone access and try again.");
    }); };
    refresh(); navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [opened, microphoneEnabled, microphoneSupported, refreshMicrophones]);
  useEffect(() => {
    if (!result) { setResultUrl(""); return; }
    const url = URL.createObjectURL(result.blob); setResultUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);
  useEffect(() => {
    if (opened && !dialog.current?.open) dialog.current?.showModal();
    else if (!opened) { if (dialog.current?.open) dialog.current.close(); cancelMicrophoneDiscovery(); }
  }, [opened, cancelMicrophoneDiscovery]);
  useEffect(() => {
    if (!opened || active || appWindow) return;
    const refresh = () => setCanvas(sceneCanvas(scope.current?.isConnected ? scope.current : null));
    refresh(); const interval = window.setInterval(refresh, 500);
    return () => clearInterval(interval);
  }, [opened, active, appWindow]);
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const open = (button: HTMLButtonElement) => {
    trigger.current = button;
    scope.current = button.closest<HTMLElement>("dialog");
    setCanvas(sceneCanvas(scope.current)); setLocalError(""); setOpened(true);
  };
  const stop = () => {
    const recorder = engine.current;
    void recorder?.stop().catch(error => { if (engine.current === recorder) { setLocalError(String(error)); setOpened(true); } });
  };
  const pause = () => {
    try { if (state?.status === "paused") engine.current?.resume(); else engine.current?.pause(); }
    catch (error) { setLocalError(String(error)); setOpened(true); }
  };
  const mute = () => {
    try { engine.current?.setMicrophoneMuted(!state?.microphoneMuted); }
    catch (error) { setLocalError(String(error)); setOpened(true); }
  };
  const allowMicrophone = async () => {
    if (microphoneAccess.current || !microphoneSupported) return;
    const epoch = ++discoveryEpoch.current;
    microphoneAccess.current = true; setRequestingMicrophone(true); setMicrophoneError("");
    let permissionStream: MediaStream | undefined;
    try {
      // Device names are exposed only after permission. This temporary stream is never recorded.
      permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!mounted.current || epoch !== discoveryEpoch.current) return;
      discoveryStream.current = permissionStream;
      await refreshMicrophones();
      if (mounted.current && epoch === discoveryEpoch.current) setMicrophonePermission(true);
    } catch (error) {
      if (mounted.current && epoch === discoveryEpoch.current) setMicrophoneError(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone access was denied. Allow it in your browser, or turn microphone audio off."
        : error instanceof DOMException && error.name === "NotFoundError"
          ? "No microphone is available. Connect one and refresh the list."
          : "Microphone access could not start. Check the device and browser permissions, then try again.");
    } finally {
      permissionStream?.getTracks().forEach(track => track.stop());
      if (discoveryStream.current === permissionStream) discoveryStream.current = null;
      if (epoch === discoveryEpoch.current) {
        microphoneAccess.current = false;
        if (mounted.current) setRequestingMicrophone(false);
      }
    }
  };
  const start = () => {
    setLocalError("");
    const selected = source === "scene" ? canvas && getSceneRecordingSource(canvas) : { kind: "display" as const, surfaceHint: "browser" as const, ...(appWindow ? { native: true } : {}) };
    if (!selected || !engine.current) { setLocalError("The scene is still loading. Wait until it is visible, then try again."); return; }
    // Keep this call in the click handler: screen capture needs a fresh user gesture.
    const recorder = engine.current;
    const starting = recorder.start({ source: selected, resolution, fps, maxDurationMs: 600_000, maxBytes: 256 * 1024 * 1024,
      ...(microphoneEnabled ? { microphone: { deviceId: microphoneId } } : {}) });
    setOpened(appWindow);
    void starting.catch(error => { if (engine.current === recorder) { setLocalError(error instanceof Error ? error.message : String(error)); setOpened(true); } });
  };
  const details = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schema: "viscera-recording/v1", filename: result.filename, mimeType: result.mimeType, ...result.metrics }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = result.filename.replace(/\.[^.]+$/, ".json"); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  return <RecorderContext.Provider value={{ state, open, pause, stop, mute }}>
    {children}
    <dialog ref={dialog} className={`video-recorder-dialog${appWindow ? " app-recorder-dialog" : ""}`} aria-labelledby={heading} onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!appWindow) setOpened(false); }}
      onClose={event => {
        event.stopPropagation();
        // `opened` owns this dialog. A queued close event from Start must not
        // overwrite a later engine error/completion that has reopened it.
        if (!opened && !event.currentTarget.open && trigger.current?.isConnected) trigger.current.focus();
      }}>
      <header className="recorder-heading"><div className="recorder-heading-icon"><Film size={22} /></div><div><span className="recorder-eyebrow">{appWindow ? "GENERATION LAB / CAPTURE" : "VISCERA / CAPTURE STUDIO"}</span><h2 id={heading}>Video recorder</h2></div>{!appWindow && <button type="button" className="recorder-close" aria-label="Close video recorder" onClick={() => setOpened(false)}><X size={20} /></button>}</header>
      {result && !active ? <section className="recorder-result" aria-label="Finished recording">
        <div className="recorder-ready"><Check size={16} /><strong>Your recording is ready</strong><span>{result.extension.toUpperCase()}</span></div>
        <video src={resultUrl || undefined} controls playsInline preload="metadata" aria-label="Recording preview" />
        <dl className="recorder-result-stats"><div><dt>Resolution</dt><dd>{result.metrics.width} × {result.metrics.height}</dd></div><div><dt>Recording time</dt><dd>{clock(result.metrics.durationMs)}</dd></div><div><dt>File size</dt><dd>{size(result.metrics.bytes)}</dd></div></dl>
        <p className="recorder-note">{result.metrics.upscaled ? `Some source frames were enlarged to the selected output size. Last source: ${result.metrics.sourceWidth} × ${result.metrics.sourceHeight}.` : `Captured source: ${result.metrics.sourceWidth} × ${result.metrics.sourceHeight}.`} Target {result.metrics.requestedFps} FPS; actual encoding depends on the device.</p>
        <p className="recorder-note">{result.metrics.audioEnabled ? `Microphone track: ${result.metrics.microphoneLabel || "Selected microphone"}.${result.metrics.microphoneMuted ? " Muted at the end of the recording." : ""}` : "Video only · no audio track."}</p>
        {result.metrics.stopReason !== "user" && <p className="recorder-message" role="status">{({
          "source-ended": "Sharing ended. The captured portion has been saved here.",
          "source-detached": "The scene closed. The captured portion has been saved here.",
          "context-lost": "Graphics became unavailable. The captured portion has been saved here.",
          "microphone-ended": "The microphone disconnected. The captured portion has been saved here.",
          "memory-limit": "The recording reached its memory limit and stopped safely.",
          "duration-limit": "The recording reached its 10-minute limit and stopped safely.",
        })[result.metrics.stopReason]}</p>}
        <div className="recorder-downloads"><a className="recorder-primary" href={resultUrl || undefined} download={result.filename}><ArrowDownToLine size={17} />Download {result.extension.toUpperCase()}</a><button type="button" onClick={details}>Capture details</button></div>
        <footer><p>Download before starting another recording.</p><button type="button" onClick={() => { setResult(null); setLocalError(""); }}>Record another</button></footer>
      </section> : <>
        <p className="recorder-intro">{appWindow ? "Record your whole workflow, with your voice. Choose the lab tab to follow page navigation, or a browser window / screen to include other tabs. Keep this recording window open." : "Capture a clean scene or demonstrate the entire app. Preview and download your video when you finish."}</p>
        {!appWindow && <fieldset disabled={active} className="recorder-source"><legend>What to record</legend><div className="recorder-source-options">
          <button type="button" aria-pressed={source === "scene"} onClick={() => setSource("scene")}><Video size={19} /><span><strong>Scene only</strong><small>Clean render, without controls</small></span></button>
          <button type="button" aria-pressed={source === "display"} disabled={!displaySupported} onClick={() => setSource("display")}><Monitor size={19} /><span><strong>App / browser tab</strong><small>Include interface and interactions</small></span></button>
        </div><p className="recorder-note">{source === "scene" ? "The current scene renders at the selected resolution. Move the camera or play an animation while recording." : "Choose this app’s tab or a window in your browser’s sharing picker. Source proportions are preserved; smaller sources are scaled."}</p>
          {source === "scene" && <p className="recorder-note"><strong>Current source:</strong> {active ? state?.sourceLabel : canvas ? getSceneRecordingSource(canvas)?.label ?? "Scene" : "Waiting for the scene to load…"}</p>}
          {!displaySupported && <p className="recorder-note">App/tab sharing is unavailable in this browser. Use Scene only.</p>}
        </fieldset>}
        {appWindow && !displaySupported && <p className="recorder-message" role="alert">Screen sharing is unavailable here. Open this page in a desktop browser on HTTPS or localhost.</p>}
        <fieldset disabled={active} className="recorder-quality"><legend>{appWindow ? "Maximum recording size" : "Recording quality"}</legend><div role="radiogroup" aria-label="Recording quality">{RECORDING_PROFILES.map(item => <label key={item.id} className={resolution === item.id ? "selected" : ""}>
          <input type="radio" name={`${heading}-quality`} value={item.id} checked={resolution === item.id} onChange={() => setResolution(item.id)} aria-label={item.label} />
          <strong>{({ hd: "HD", fhd: "Full HD", qhd: "2K / QHD", uhd: "4K" })[item.id]}</strong><span>{item.width} × {item.height}</span><small>{({ hd: "Compact", fhd: "Everyday", qhd: "Detailed", uhd: "Maximum" })[item.id]}</small>
        </label>)}</div></fieldset>
        {appWindow && <p className="recorder-note">The browser preserves the shared surface’s proportions. Your download uses its actual size, up to the selected maximum; small sources are not enlarged.</p>}
        <div className="recorder-options"><label>Frame rate<select aria-label="Recording frame rate" disabled={active} value={fps} onChange={event => setFps(Number(event.target.value) as 24 | 30 | 60)}><option value={24}>24 FPS</option><option value={30}>30 FPS</option><option value={60}>60 FPS</option></select></label><div><span>Format</span><strong>MP4 / WebM</strong><small>Best supported encoder</small></div></div>
        <fieldset disabled={active || requestingMicrophone} className="recorder-audio">
          <legend>Audio</legend>
          <label className="recorder-microphone-toggle"><input type="checkbox" aria-label="Record microphone audio" checked={microphoneEnabled} disabled={!microphoneSupported} onChange={event => { setMicrophoneEnabled(event.target.checked); setMicrophoneError(""); }} /><Mic size={18} /><span>Record microphone audio</span></label>
          {microphoneEnabled && <div className="recorder-microphone-settings">
            <label>Microphone<select aria-label="Microphone" value={microphoneId} onChange={event => { setMicrophoneId(event.target.value); setMicrophoneError(""); }}>
              <option value="default">System default microphone</option>
              {missingMicrophone && <option value={microphoneId} disabled>Previously selected microphone · unavailable</option>}
              {microphones.filter(device => device.deviceId && device.deviceId !== "default").map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
            </select></label>
            <button type="button" onClick={() => { void allowMicrophone(); }}>{requestingMicrophone ? "Requesting microphone access…" : microphonePermission ? "Refresh microphones" : "Allow microphone access"}</button>
            <p className="recorder-note">{active && state?.microphoneLabel ? `Recording from: ${state.microphoneLabel}` : "Choose any microphone exposed by your browser, including connected headsets and USB devices. Allow access to see device names. Audio is saved only when you record."}</p>
          </div>}
          {!microphoneSupported && <p className="recorder-note">Microphone recording requires a supported browser on HTTPS or localhost.</p>}
        </fieldset>
        {requestingMicrophone && <p className="recorder-note" role="status">Waiting for microphone permission. Use your browser’s permission prompt.</p>}
        {microphoneEnabled && (microphoneError || missingMicrophone) && <p className="recorder-message" role="alert">{microphoneError || "The selected microphone is unavailable. Choose another input or refresh the list."}</p>}
        <p className="recorder-note">Stays on your device · up to 10 minutes or 256 MB. Higher resolution and frame rate need more graphics power.</p>
        {active && <div className="recorder-progress" role="status"><i className={state?.status === "paused" ? "paused" : ""} /><strong>{state?.status === "acquiring" ? "Preparing capture…" : state?.status === "stopping" ? "Finishing video…" : state?.status === "paused" ? "Paused" : "Recording"}</strong><span>{clock(state?.elapsedMs ?? 0)}</span><small>{size(state?.bytes ?? 0)}</small></div>}
        {state?.warning && active && <p className="recorder-message" role="status">{state.warning}</p>}
        {!mediaSupported && <p className="recorder-message" role="alert">Video recording is unavailable in this browser. Try an up-to-date browser with canvas video recording support.</p>}
        {(localError || state?.status === "error") && <p className="recorder-message" role="alert">{localError || state?.error || "Recording could not start. Please try again."}</p>}
        <footer className="recorder-actions">{active ? <>{appWindow ? <span>Switch back to the lab to demonstrate.</span> : <button type="button" onClick={() => setOpened(false)}>Back to the app</button>}<div>{(state?.status === "recording" || state?.status === "paused") && <>
          {state.audioEnabled && <button type="button" aria-label={state.microphoneMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={state.microphoneMuted} onClick={mute}>{state.microphoneMuted ? <MicOff size={16} /> : <Mic size={16} />}{state.microphoneMuted ? "Unmute" : "Mute"}</button>}
          <button type="button" onClick={pause}>{state.status === "paused" ? <Play size={16} /> : <Pause size={16} />}{state.status === "paused" ? "Resume" : "Pause"}</button>
        </>}<button type="button" className="recorder-primary" disabled={state?.status === "stopping"} onClick={stop}><Square size={14} />{state?.status === "acquiring" ? "Cancel" : "Stop & preview"}</button></div></> : <><span>{appWindow ? "Up to " : ""}{profile.width} × {profile.height} · {fps} FPS target</span><button type="button" className="recorder-primary" disabled={!mediaSupported || requestingMicrophone || missingMicrophone || (microphoneEnabled && !microphoneSupported) || (source === "scene" && !canvas) || (source === "display" && !displaySupported)} onClick={start}><Circle size={14} fill="currentColor" />Start recording</button></>}</footer>
      </>}
    </dialog>
  </RecorderContext.Provider>;
}

export function VideoRecorderButton() {
  const { state, open, pause, stop, mute } = useContext(RecorderContext);
  const active = busy(state);
  const appCapture = document.documentElement.hasAttribute("data-lab-recorder-owner");
  return <div className={`recorder-toolbar${active ? " is-active" : ""}`} role="group" aria-label="Video recording">
    <span data-lab-recorder-slot />
    <button type="button" className="recorder-trigger" aria-label="Video recorder" aria-description={active && state?.warning ? state.warning : undefined} title={active && state?.warning ? state.warning : appCapture ? "Record scene only" : "Record the scene or app in HD, Full HD, 2K or 4K"} onClick={event => open(event.currentTarget)}>
      {active && state?.warning ? <AlertTriangle className="recorder-warning-icon" size={16} aria-label="Recording input warning" /> : <span className={`recorder-dot${state?.status === "paused" ? " paused" : ""}`} />}<span>{active ? clock(state?.elapsedMs ?? 0) : appCapture ? "Scene video" : "Record video"}</span>
    </button>
    {(state?.status === "recording" || state?.status === "paused") && <button type="button" className="recorder-inline-control" aria-label={state.status === "paused" ? "Resume video recording" : "Pause video recording"} onClick={pause}>{state.status === "paused" ? <Play size={16} /> : <Pause size={16} />}</button>}
    {(state?.status === "recording" || state?.status === "paused") && state.audioEnabled && <button type="button" className="recorder-inline-control" aria-label={state.microphoneMuted ? "Unmute microphone" : "Mute microphone"} title={state.microphoneMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={state.microphoneMuted} onClick={mute}>{state.microphoneMuted ? <MicOff size={16} /> : <Mic size={16} />}</button>}
    {active && <button type="button" className="recorder-inline-control recorder-stop" aria-label="Stop video recording" disabled={state?.status === "stopping"} onClick={stop}><Square size={14} fill="currentColor" /></button>}
  </div>;
}
