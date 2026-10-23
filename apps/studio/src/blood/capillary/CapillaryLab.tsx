import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Download, Droplets, Pause, Play, RotateCcw } from "lucide-react";
import { DisplaySettings, SceneResizeHandle } from "../../DisplaySettings";
import { VideoRecorderButton } from "../../VideoRecorderPanel";
import { BLOOD_OPTICS_PROVENANCE } from "../optics";
import { CapillaryFilmSolver, DEFAULT_FILM_CONFIG, type FilmConfig, type FilmSnapshot, type FilmTelemetry } from "./solver";
import { CapillaryRenderer } from "./renderer";
import { BloodFluidModelControl } from "../BloodModelSelector";
import "../artery/artery.css";

interface Settings { tension: number; wetting: number; }
const DEFAULT: Settings = { tension: .05, wetting: .12 };
const STEP_SECONDS = .005;
const configuration = (settings: Settings): FilmConfig => ({ ...DEFAULT_FILM_CONFIG, surfaceTensionNm: settings.tension,
  wetting: settings.wetting ? { precursorHeightM: 8e-6, equilibriumAngleRadians: settings.wetting } : null });
const initialHeights = (config: FilmConfig) => Float64Array.from({ length: config.cells }, (_, i) =>
  8e-6 + 80e-6 * Math.exp(-((((i + .5) / config.cells * config.lengthM - .002) / .0008) ** 4)));
const serialise = (state: FilmSnapshot) => Object.fromEntries(Object.entries(state).map(([key, value]) =>
  [key, value instanceof Float64Array ? Array.from(value) : value]));

function Profile({ state }: { state: FilmSnapshot }) {
  const points = Array.from(state.heightM, (h, i) => `${42 + state.xM[i]! / .004 * 470},${160 - h / 100e-6 * 120}`).join(" ");
  return <figure className="artery-plot"><figcaption>Computed film thickness · separate axis scales</figcaption>
    <svg viewBox="0 0 560 200" role="img" aria-label={`Film profile across four millimetres; maximum thickness ${(Math.max(...state.heightM) * 1e6).toFixed(1)} micrometres.`}>
      <path d="M42 35V160H520" stroke="#bdc8d2" fill="none" />
      <polyline points={points} stroke="#932b42" fill="none" strokeWidth="2.5" />
      <text x="4" y="44">100 µm</text><text x="15" y="163">0</text>
      <text x="42" y="184">0 mm</text><text x="480" y="184">4 mm</text>
    </svg>
  </figure>;
}

export function CapillaryLab({ navigation }: { navigation: ReactNode }) {
  const host = useRef<HTMLDivElement>(null), solver = useRef<CapillaryFilmSolver | null>(null), view = useRef<CapillaryRenderer | null>(null);
  const [settings, setSettings] = useState(DEFAULT), [active, setActive] = useState(DEFAULT), [revision, setRevision] = useState(0);
  const [running, setRunning] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState("");
  const [state, setState] = useState<FilmSnapshot>(), [status, setStatus] = useState("Preparing the film…");
  const initial = useRef<FilmSnapshot | null>(null), lastSolve = useRef<FilmTelemetry | null>(null);
  const live = useRef(running); live.current = running;
  useEffect(() => {
    let renderer: CapillaryRenderer | undefined, frame = 0, disposed = false, failed = false, previous = performance.now(), accumulator = 0, lastReadout = 0;
    setReady(false); setError(""); setState(undefined); lastSolve.current = null;
    try {
      const config = configuration(active), engine = new CapillaryFilmSolver(config, initialHeights(config));
      solver.current = engine; initial.current = engine.snapshot();
      renderer = new CapillaryRenderer(host.current!, { lengthM: config.lengthM, widthM: config.widthM,
        onError: message => { if (!disposed) { failed = true; setError(message); setRunning(false); setReady(false); } } });
      view.current = renderer;
      let latest = initial.current, publishedTime = latest.timeSeconds;
      renderer.update(latest); renderer.render(); setState(latest); setReady(true); setStatus("Ready · periodic thin-film reference");
      const tick = (now: number) => {
        if (disposed || !renderer) return;
        const elapsed = Math.min(Math.max((now - previous) / 1000, 0), .1); previous = now;
        if (!document.hidden && live.current && !failed) {
          accumulator = Math.min(.1, accumulator + elapsed);
          const started = performance.now(); let advanced = false;
          for (let count = 0; accumulator >= STEP_SECONDS && count < 20; ++count) {
            if (count && performance.now() - started > 6) break;
            const result = engine.step(STEP_SECONDS); lastSolve.current = result.telemetry;
            if (!result.accepted) {
              failed = true; setRunning(false); setError(result.reason ?? "Film solve rejected"); accumulator = 0; break;
            }
            latest = result.snapshot; advanced = true; accumulator -= STEP_SECONDS;
          }
          if (advanced) renderer.update(latest);
        } else accumulator = 0;
        if (!document.hidden && renderer.needsRender) renderer.render();
        if (latest.timeSeconds !== publishedTime && (now - lastReadout > 100 || !live.current || failed)) {
          setState(latest); publishedTime = latest.timeSeconds; lastReadout = now;
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    return () => { disposed = true; cancelAnimationFrame(frame); renderer?.dispose(); view.current = null; solver.current = null; };
  }, [active, revision]);
  const reset = () => {
    if (view.current?.canvas.dataset.sceneRecordingActive === "true") { setStatus("Stop the recording before applying settings."); return; }
    setRunning(false); setActive({ ...settings }); setRevision(value => value + 1);
  };
  const exportState = () => {
    if (!solver.current || !initial.current) return;
    setRunning(false);
    const payload = { schema: "viscera.capillary-film.evidence/v1", config: solver.current.config, dtSeconds: STEP_SECONDS,
      scope: "Periodic 1D Newtonian inertialess film on a flat impermeable substrate. Width is a uniform extrusion. No 3D drop or organ-cut coupling.",
      optics: BLOOD_OPTICS_PROVENANCE, initial: serialise(initial.current), snapshot: serialise(solver.current.snapshot()), lastSolve: lastSolve.current };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "viscera-capillary-film.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const volumeError = state && initial.current ? (state.volumeM3 / initial.current.volumeM3 - 1) : 0;
  return <main className="blood-lab">
    <header className="blood-header">
      <a href="?" className="blood-back"><ArrowLeft size={16} /> Anatomy studio</a>
      <div className="blood-wordmark"><Droplets size={22} /><span>VISCERA <strong>Blood lab</strong></span><span className="blood-badge">Research preview</span></div>
      <div className="blood-actions"><DisplaySettings /><VideoRecorderButton /></div>
    </header>
    {navigation}
    <div className="blood-heading"><div><p className="blood-kicker">FLUID MECHANICS / 03</p><h1>Thin-film wetting playground.</h1>
      <p>Observe capillary leveling, wetting forces and the thickness of a shallow liquid ridge.</p></div>
      <div className="blood-model-note"><strong>One-dimensional reference model</strong><span>A periodic film on a flat substrate, shown at true height. This is a separate validation experiment.</span></div></div>
    <div className="blood-layout">
      <section className="blood-stage" aria-label="Capillary film scene">
        <div className="artery-canvas-host" ref={host} />
        <div className="blood-legend">Uniform width extrusion · geometry in millimetres · neutral substrate</div>
        {!ready && !error && <div className="blood-overlay" role="status">Preparing the capillary model…</div>}
        {error && <div className="blood-overlay blood-error" role="alert"><strong>Film paused</strong><p>{error}</p><button onClick={reset}>Reset film</button></div>}
        <SceneResizeHandle />
      </section>
      <aside className="blood-controls" aria-label="Capillary parameters">
        <BloodFluidModelControl />
        <h2>Capillary model</h2><p className="blood-muted">Settings apply on reset. These are reference parameters, not patient-specific blood measurements.</p>
        <label>Surface tension<select aria-label="Film surface tension" value={settings.tension} onChange={e => setSettings(s => ({ ...s, tension: Number(e.target.value) }))}>
          <option value={.04}>40 mN/m</option><option value={.05}>50 mN/m</option><option value={.06}>60 mN/m</option>
        </select></label>
        <label>Wetting potential<select aria-label="Film wetting" value={settings.wetting} onChange={e => setSettings(s => ({ ...s, wetting: Number(e.target.value) }))}>
          <option value={0}>Off · capillary leveling only</option><option value={.08}>Small-angle parameter · 0.08 rad</option>
          <option value={.12}>Small-angle parameter · 0.12 rad</option><option value={.16}>Small-angle parameter · 0.16 rad</option>
        </select></label>
        <dl className="blood-constants"><div><dt>Dynamic viscosity</dt><dd>10 mPa·s</dd></div>
          <div><dt>Domain / cells</dt><dd>4 × 1 mm / 96</dd></div><div><dt>Fixed timestep</dt><dd>5 ms</dd></div>
          <div><dt>Precursor height</dt><dd>8 µm</dd></div></dl>
        <div className="blood-run-buttons">
          <button className="blood-primary" disabled={!ready || !!error} onClick={() => setRunning(v => !v)}>{running ? <Pause size={16} /> : <Play size={16} />}{running ? "Pause film" : "Run film"}</button>
          <button onClick={reset}><RotateCcw size={16} /> Apply & reset</button>
        </div>
        <p role="status" className="blood-status">{running ? "Running · accepted physical time" : status}</p>
        <dl className="blood-metrics">
          <div><dt>Accepted physical time</dt><dd data-testid="film-time">{(state?.timeSeconds ?? 0).toFixed(3)} s</dd></div>
          <div><dt>Peak thickness</dt><dd data-testid="film-peak">{state ? (Math.max(...state.heightM) * 1e6).toFixed(2) : "—"} µm</dd></div>
          <div><dt>Relative volume change</dt><dd>{volumeError.toExponential(2)}</dd></div>
          <div><dt>Free energy</dt><dd>{state ? (state.energyJ * 1e9).toFixed(4) : "—"} nJ</dd></div>
          <div><dt>Last nonlinear residual</dt><dd>{lastSolve.current?.normalizedResidual.toExponential(2) ?? "—"}</dd></div>
        </dl>
        <p className="blood-muted">Playback slows on overloaded devices; physical steps remain 5 ms. Negative free energy is allowed because the wetting potential defines its reference.</p>
        <button className="blood-export" disabled={!ready} onClick={exportState}><Download size={16} />Export film state & diagnostics</button>
      </aside>
    </div>
    <div className="artery-analysis">{state && <Profile state={state} />}
      <section><h2>Geometry follows the computed film</h2><p>The renderer uses the film’s height and slope at every cell edge, with no height exaggeration or animated texture displacement. The curve uses labelled axis scales to make the shallow profile readable.</p>
        <p>The inertialess, small-slope model supports capillary leveling and a precursor-film wetting potential. It does not simulate droplets in flight, arbitrary contact angles, tissue absorption or bleeding from cuts.</p></section>
    </div>
    <div className="blood-notes">
      <section><h2>Conservation and convergence</h2><p>Shared face fluxes conserve volume. Each accepted step passes nonlinear residual, positivity, small-slope and energy-dissipation checks. Failed steps leave the previous state intact.</p>
        <a href="https://doi.org/10.1103/PhysRevLett.111.117801" target="_blank" rel="noreferrer">Read the thin-film gradient-dynamics reference ↗</a></section>
      <section><h2>Spectral material approximation</h2><p>{BLOOD_OPTICS_PROVENANCE.conditions}. A two-stream slab approximation provides thickness-dependent colour over a neutral substrate. The lighting and dielectric surface layer are illustrative; surgical camera calibration remains unvalidated.</p>
        <a href="blood-optics-attribution.json" target="_blank" rel="noreferrer">Optical data, model and attribution ↗</a></section>
    </div>
  </main>;
}
