import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Maximize2, X } from "lucide-react";
import { DEFAULT_DISPLAY, DISPLAY_STORAGE_KEY, parseDisplayPreferences, readDisplayPreferences, type DisplayPreferences } from "./displayPreferences";
import { AccountControl, AccountProvider } from "./account/AccountDialog";
import "./displaySettings.css";

export interface FpsTelemetry {
  fps: number;
  frameMs: number;
  tier: "optimal" | "steady" | "heavy";
  history: number[];
}

const INITIAL_FPS: FpsTelemetry = {
  fps: 60,
  frameMs: 16.7,
  tier: "optimal",
  history: Array.from({ length: 18 }, () => 60),
};

const DisplayContext = createContext({
  preferences: DEFAULT_DISPLAY,
  update: (_patch: Partial<DisplayPreferences>) => {},
  telemetry: INITIAL_FPS,
});

function sparklinePoints(history: readonly number[]): string {
  if (!history.length) return "0,5 36,5";
  return history
    .map((val, idx) => {
      const x = (idx / Math.max(1, history.length - 1)) * 36;
      const norm = Math.max(0, Math.min(1, (val - 15) / 55));
      const y = 9 - norm * 8;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function DisplayProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(() => {
    try { return readDisplayPreferences(window.localStorage); } catch { return { ...DEFAULT_DISPLAY }; }
  });
  const [telemetry, setTelemetry] = useState<FpsTelemetry>(INITIAL_FPS);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let windowStart = performance.now();
    let smoothedFps = 60;
    let smoothedMs = 16.7;
    const history = Array.from({ length: 18 }, () => 60);
    const publishGlobal = (next: FpsTelemetry) => {
      try {
        (window as unknown as { __visceraFps?: FpsTelemetry }).__visceraFps = next;
      } catch { /* ignore */ }
    };
    publishGlobal(INITIAL_FPS);
    const tick = (now: number) => {
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= 260) {
        const instantFps = Math.max(1, Math.min(240, (frames * 1000) / elapsed));
        const instantMs = Math.max(1, Math.min(250, elapsed / frames));
        smoothedFps = smoothedFps * 0.62 + instantFps * 0.38;
        smoothedMs = smoothedMs * 0.62 + instantMs * 0.38;
        const fps = Math.max(1, Math.round(smoothedFps));
        const frameMs = Math.round(smoothedMs * 10) / 10;
        const tier: FpsTelemetry["tier"] = fps >= 50 ? "optimal" : fps >= 30 ? "steady" : "heavy";
        history.shift();
        history.push(fps);
        const next: FpsTelemetry = { fps, frameMs, tier, history: [...history] };
        setTelemetry(next);
        publishGlobal(next);
        frames = 0;
        windowStart = now;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--ui-text-scale", String(preferences.textPercent / 100));
    root.style.setProperty("--ui-controls-width", `${preferences.controlsWidth}px`);
    if (preferences.sceneHeight === null) root.style.removeProperty("--ui-scene-height");
    else root.style.setProperty("--ui-scene-height", `${preferences.sceneHeight}px`);
    root.dataset.sceneHeight = preferences.sceneHeight === null ? "auto" : "custom";
    root.dataset.largeType = String(preferences.textPercent > 120);
    try { window.localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Session controls remain usable when storage is blocked. */ }
  }, [preferences]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === DISPLAY_STORAGE_KEY || event.key === null) {
        try { setPreferences(parseDisplayPreferences(JSON.parse(event.newValue ?? "null"))); } catch { setPreferences({ ...DEFAULT_DISPLAY }); }
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return <DisplayContext.Provider value={{ preferences, update: patch => setPreferences(previous => parseDisplayPreferences({ ...previous, ...patch })), telemetry }}><AccountProvider>{children}</AccountProvider></DisplayContext.Provider>;
}

export function DisplaySettings({ includeAccount = true }: { includeAccount?: boolean } = {}) {
  const { preferences, update, telemetry } = useContext(DisplayContext);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), heading = useId();
  return <>
    <div className="display-fps-badge" data-testid="header-fps-badge" data-tier={telemetry.tier} role="status" aria-live="off"
      aria-label={`Live frame rate ${telemetry.fps} frames per second, ${telemetry.frameMs.toFixed(1)} milliseconds per frame`}
      title={`Live render telemetry · ${telemetry.fps} FPS (${telemetry.frameMs.toFixed(1)} ms/frame)`}>
      <span className="display-fps-dot" aria-hidden="true" />
      <strong className="display-fps-value">{telemetry.fps}</strong>
      <span className="display-fps-unit">FPS</span>
      <span className="display-fps-sep" aria-hidden="true">·</span>
      <span className="display-fps-ms">{telemetry.frameMs.toFixed(1)} ms</span>
    </div>
    <button ref={trigger} type="button" className="display-trigger" aria-label="Display settings"
      aria-description={`Text size ${preferences.textPercent} percent. Adjust text size and scene layout.`}
      title={`Text size: ${preferences.textPercent}% · Display and scene layout`} onClick={() => dialog.current?.showModal()}>
      <span className="display-trigger-icon" aria-hidden="true">Aa</span>
      <span className="display-trigger-label">Text size</span>
      <span className="display-trigger-value">{preferences.textPercent}%</span>
    </button>
    {includeAccount && <AccountControl />}
    <dialog ref={dialog} className="display-dialog" aria-labelledby={heading} onCancel={event => event.stopPropagation()} onClose={event => {
      event.stopPropagation();
      // The native close event is queued. Do not steal focus if the user has
      // already moved to a scene control before that event is delivered.
      const focused = document.activeElement;
      if (!focused || focused === document.body || dialog.current?.contains(focused)) trigger.current?.focus();
    }}>
      <header><h2 id={heading}>Make this workspace yours</h2><button type="button" aria-label="Close display settings" onClick={() => dialog.current?.close()}><X size={20} /></button></header>
      <p>Adjust labels, parameter descriptions and model information. Your preferences stay on this device.</p>
      <label>Text size <output>{preferences.textPercent}%</output><input aria-label="Interface text size" type="range" min="80" max="200" step="5" value={preferences.textPercent} onChange={event => update({ textPercent: Number(event.target.value) })} /></label>
      <div className="display-presets" role="group" aria-label="Text size presets">{[100, 125, 150, 200].map(size => <button key={size} type="button" aria-pressed={preferences.textPercent === size} onClick={() => update({ textPercent: size })}>{size}%</button>)}</div>
      <label>Controls width <output>{preferences.controlsWidth} px</output><input aria-label="Controls panel width" type="range" min="240" max="600" step="10" value={preferences.controlsWidth} onChange={event => update({ controlsWidth: Number(event.target.value) })} /></label>
      <p className="display-help">Narrower controls give the scene more room. You can also drag its right edge. On small screens the controls stack below or open in a panel.</p>
      <label className="display-check"><input type="checkbox" checked={preferences.sceneHeight === null} onChange={event => update({ sceneHeight: event.target.checked ? null : 640 })} />Fit scene height to window</label>
      <label>Scene height <output>{preferences.sceneHeight === null ? "Automatic" : `${preferences.sceneHeight} px`}</output><input aria-label="Scene height" type="range" min="320" max="1400" step="20" disabled={preferences.sceneHeight === null} value={preferences.sceneHeight ?? 640} onChange={event => update({ sceneHeight: Number(event.target.value) })} /></label>
      <p className="display-help">Drag the bottom edge to set a height. Full screen expands a scene without changing your material or camera.</p>
      <footer><button type="button" onClick={() => update({ ...DEFAULT_DISPLAY })}>Reset display preferences</button><button type="button" onClick={() => dialog.current?.close()}>Done</button></footer>
    </dialog>
  </>;
}

/** A pointer- and keyboard-accessible edge handle. ResizeObserver owns canvas resizing. */
export function SceneResizeHandle({ panel = true }: { panel?: boolean }) {
  const { preferences, update, telemetry } = useContext(DisplayContext);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ axis: "width" | "height"; start: number; value: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === host.current?.parentElement);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const separator = (axis: "width" | "height") => <div className={`scene-resize-${axis}`} role="separator" tabIndex={0}
    aria-label={axis === "width" ? "Resize scene width" : "Resize scene height"} aria-orientation={axis === "width" ? "vertical" : "horizontal"}
    aria-valuemin={axis === "width" ? 240 : 320} aria-valuemax={axis === "width" ? 600 : 1400}
    aria-valuenow={axis === "width" ? preferences.controlsWidth : preferences.sceneHeight ?? Math.round(host.current?.parentElement?.clientHeight ?? 640)}
    aria-valuetext={axis === "width" ? `${preferences.controlsWidth} pixel controls panel; left arrow enlarges controls` : preferences.sceneHeight === null ? "Automatic scene height" : `${preferences.sceneHeight} pixel scene height`}
    title={axis === "width" ? "Drag to resize the scene · arrow keys adjust controls width" : "Drag to resize scene height · arrow keys adjust · double-click to fit window"}
    onDoubleClick={() => update(axis === "width" ? { controlsWidth: DEFAULT_DISPLAY.controlsWidth } : { sceneHeight: null })}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { axis, start: axis === "width" ? event.clientX : event.clientY, value: axis === "width" ? preferences.controlsWidth : host.current?.parentElement?.clientHeight ?? 640 }; }}
    onPointerMove={event => { const current = drag.current; if (!current || current.axis !== axis) return; const delta = (axis === "width" ? event.clientX : event.clientY) - current.start; update(axis === "width" ? { controlsWidth: current.value - delta } : { sceneHeight: current.value + delta }); }}
    onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      const keys = axis === "width" ? ["ArrowLeft", "ArrowRight"] : ["ArrowDown", "ArrowUp"];
      if (!keys.includes(event.key) && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault(); event.stopPropagation();
      const current = axis === "width" ? preferences.controlsWidth : preferences.sceneHeight ?? host.current?.parentElement?.clientHeight ?? 640;
      const value = event.key === "Home" ? (axis === "width" ? 240 : 320) : event.key === "End" ? (axis === "width" ? 600 : 1400) : current + (event.key === keys[0] ? 1 : -1) * (event.shiftKey ? 50 : 10);
      update(axis === "width" ? { controlsWidth: value } : { sceneHeight: value });
    }}><span /></div>;
  return <div ref={host} className="scene-layout-tools">
    {panel && !fullscreen && separator("width")}{!fullscreen && separator("height")}
    <div className="scene-fps-hud" data-testid="scene-fps-hud" data-tier={telemetry.tier} role="status" aria-live="off"
      aria-label={`Viewport frame rate ${telemetry.fps} FPS (${telemetry.frameMs.toFixed(1)} ms)`}
      title={`Live 3D viewport telemetry · ${telemetry.fps} FPS (${telemetry.frameMs.toFixed(1)} ms/frame)`}>
      <div className="scene-fps-top">
        <span className="scene-fps-dot" aria-hidden="true" />
        <strong className="scene-fps-value">{telemetry.fps}</strong>
        <span className="scene-fps-unit">FPS</span>
      </div>
      <div className="scene-fps-bottom">
        <span className="scene-fps-ms">{telemetry.frameMs.toFixed(1)} ms</span>
        <svg className="scene-fps-spark" viewBox="0 0 36 10" aria-hidden="true">
          <polyline fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" points={sparklinePoints(telemetry.history)} />
        </svg>
      </div>
    </div>
    <button className="scene-fullscreen" type="button" aria-label={fullscreen ? "Exit scene full screen" : "Scene full screen"} title={fullscreen ? "Exit full screen" : "Expand scene to full screen"} onClick={async () => {
      setError("");
      try { if (fullscreen) await document.exitFullscreen(); else if (host.current?.parentElement?.requestFullscreen) await host.current.parentElement.requestFullscreen(); else setError("Full screen is unavailable in this browser. Open Text size for scene layout settings."); }
      catch { setError("Full screen could not open. Open Text size for scene layout settings."); }
    }}><Maximize2 size={15} /></button>
    {error && <p className="scene-layout-error" role="status">{error}<button type="button" onClick={() => setError("")} aria-label="Dismiss full screen message">×</button></p>}
  </div>;
}
