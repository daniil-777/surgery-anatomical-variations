import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Download, Droplets, Pause, Play, RotateCcw } from "lucide-react";
import { DisplaySettings, SceneResizeHandle } from "../../DisplaySettings";
import { VideoRecorderButton } from "../../VideoRecorderPanel";
import { ArteryFlowSolver, DEFAULT_ARTERY_CONFIG, type ArteryConfig, type ArteryTelemetry } from "./solver";
import { ArteryRenderer } from "./renderer";
import { BloodFluidModelControl } from "../BloodModelSelector";
import "../blood.css";
import "./artery.css";

type Snapshot = ReturnType<ArteryFlowSolver["snapshot"]>;
interface Controls {
  radiusMM: number; lengthMM: number; radialCells: number; rheology: "carreau-yasuda" | "newtonian";
  meanGradient: number; pulseGradient: number; bpm: number; dtMS: number;
}
const DEFAULT: Controls = { radiusMM: 3, lengthMM: 60, radialCells: 64, rheology: "carreau-yasuda",
  meanGradient: 300, pulseGradient: 200, bpm: 72, dtMS: 1 };
const gradient = (s: Controls, time: number) => s.meanGradient + s.pulseGradient * Math.cos(2 * Math.PI * s.bpm / 60 * time);
const config = (s: Controls): ArteryConfig => ({ ...DEFAULT_ARTERY_CONFIG, radiusM: s.radiusMM / 1000, lengthM: s.lengthMM / 1000, radialCells: s.radialCells,
  rheology: s.rheology === "newtonian" ? { kind: "newtonian", viscosityPaS: .00345 } : { kind: "carreau-yasuda", profileId: "weddell-2015" } });

function ProfileChart({ state, radiusM }: { state: Snapshot; radiusM: number }) {
  const values = Array.from(state.axialVelocityMS), minimum = Math.min(0, ...values), maximum = Math.max(0, ...values);
  const axisMaximum = maximum - minimum < .01 ? minimum + .01 : maximum;
  const y = (v: number) => 142 - (v - minimum) / (axisMaximum - minimum) * 112;
  const points = [[32, y(values[0] ?? 0)], ...Array.from(state.radialCentresM, (r, i) => [32 + 252 * r / radiusM, y(values[i] ?? 0)]), [284, y(0)]];
  return <figure className="artery-plot"><figcaption>Computed axial velocity</figcaption>
    <svg viewBox="0 0 320 180" role="img" aria-label={`Axial velocity across the lumen ranges from ${minimum.toFixed(3)} to ${maximum.toFixed(3)} metres per second, zero at the vessel wall.`}>
      <path d={`M32 24V142H288 M32 ${y(0)}H288`} fill="none" stroke="#c5ccd6" />
      <polyline points={points.map(p => p.join(",")).join(" ")} fill="none" stroke="#a03650" strokeWidth="2.5" />
      <text x="32" y="164">Axis</text><text x="262" y="164">Wall</text><text x="32" y="18">{minimum.toFixed(3)} to {maximum.toFixed(3)} m/s</text>
    </svg>
  </figure>;
}

export function ArteryLab({ navigation }: { navigation: ReactNode }) {
  const host = useRef<HTMLDivElement>(null), solver = useRef<ArteryFlowSolver | null>(null), view = useRef<ArteryRenderer | null>(null);
  const [settings, setSettings] = useState(DEFAULT), [active, setActive] = useState(DEFAULT), [revision, setRevision] = useState(0);
  const [running, setRunning] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState("");
  const [state, setState] = useState<Snapshot>(), [speed, setSpeed] = useState(1);
  const [display, setDisplay] = useState<"blood" | "velocity">("velocity"), [cutaway, setCutaway] = useState(true);
  const [status, setStatus] = useState("Preparing the arterial flow model…");
  const lastSolve = useRef<ArteryTelemetry | undefined>(undefined);
  const historyRef = useRef<{ t: number; flowMLs: number; gradientPaM: number; wallShearPa: number }[]>([]);
  const live = useRef({ running, speed, display, cutaway }); live.current = { running, speed, display, cutaway };
  useEffect(() => {
    let renderer: ArteryRenderer | undefined, frame = 0, disposed = false, previous = performance.now(), accumulator = 0, lastReadout = 0;
    setReady(false); setError(""); setState(undefined); historyRef.current = [];
    try {
      const flow = new ArteryFlowSolver(config(active));
      const initial = flow.solveSteady({ pressureGradientPaPerM: active.meanGradient });
      lastSolve.current = initial.telemetry;
      if (initial.status !== "accepted") throw new Error(initial.reason ?? "Steady initial condition did not converge");
      solver.current = flow;
      renderer = new ArteryRenderer(host.current!, { radiusM: active.radiusMM / 1000, lengthM: active.lengthMM / 1000,
        onError: message => { if (!disposed) { setError(message); setRunning(false); setReady(false); } } });
      view.current = renderer; renderer.setDisplay(live.current.display, live.current.cutaway);
      let latest = initial.snapshot, publishedSteps = latest.acceptedSteps;
      const axialDisplacementM = new Float64Array(active.radialCells);
      renderer.update(latest); renderer.render();
      setState(latest); setReady(true); setStatus("Ready · starts from steady flow at the mean pressure gradient");
      const tick = (now: number) => {
        if (disposed || !renderer) return;
        const elapsed = Math.min(Math.max((now - previous) / 1000, 0), .1); previous = now;
        renderer.setDisplay(live.current.display, live.current.cutaway);
        if (!document.hidden && live.current.running) {
          // Fixed physical steps. Bounded catch-up slows simulated time when a
          // device is overloaded; it never increases dt or skips solver states.
          accumulator = Math.min(accumulator + elapsed * live.current.speed, .2);
          const dt = active.dtMS / 1000, workStarted = performance.now(); let advanced = 0;
          axialDisplacementM.fill(0);
          for (let steps = 0; accumulator >= dt && steps < 64; ++steps) {
            // Yield the main thread after a short work budget, even on slow
            // devices. At least one step progresses; accepted states are never skipped.
            if (steps > 0 && performance.now() - workStarted >= 6) break;
            const result = flow.step({ dtSeconds: dt, pressureGradientPaPerM: gradient(active, flow.timeSeconds + dt) });
            lastSolve.current = result.telemetry;
            if (result.status !== "accepted") {
              setError(result.reason ?? "The nonlinear flow solve did not converge"); setRunning(false); accumulator = 0; break;
            }
            latest = result.snapshot;
            // Integrate each accepted velocity, not just the final profile in
            // this frame. Pulsatile/reversing tracer transport is FPS invariant.
            for (let i = 0; i < axialDisplacementM.length; ++i) axialDisplacementM[i] = axialDisplacementM[i]! + latest.axialVelocityMS[i]! * dt;
            accumulator -= dt; advanced += dt;
          }
          if (advanced) renderer.update({ ...latest, axialDisplacementM }, advanced);
        } else accumulator = 0;
        if (!document.hidden && (renderer.needsRender || live.current.running)) renderer.render();
        if (latest.acceptedSteps !== publishedSteps && now - lastReadout >= 100) {
          const next = latest; setState(next); lastReadout = now; publishedSteps = next.acceptedSteps;
          if (live.current.running) {
            historyRef.current.push({ t: next.timeSeconds, flowMLs: next.flowRateM3S * 1e6, gradientPaM: next.pressureGradientPaPerM, wallShearPa: next.wallShearPa });
            if (historyRef.current.length > 600) historyRef.current.shift();
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    return () => { disposed = true; cancelAnimationFrame(frame); renderer?.dispose(); solver.current = null; view.current = null; };
  }, [active, revision]);
  const reset = () => {
    if (view.current?.canvas.dataset.sceneRecordingActive === "true") { setStatus("Stop the recording before applying new settings."); return; }
    setRunning(false); setActive({ ...settings }); setRevision(v => v + 1);
  };
  const exportRun = () => {
    const engine = solver.current; if (!engine) return;
    setRunning(false); const snapshot = engine.snapshot();
    const payload = { schema: "viscera.artery.evidence/v1", createdAt: new Date().toISOString(), config: config(active),
      initialization: { kind: "steady-mean-pressure-gradient", pressureGradientPaPerM: active.meanGradient,
        periodicSteadyState: false, note: "The transient starts from steady mean flow; it is not initialized on the periodic pulsatile solution." },
      pressureWaveform: { convention: "G(t) = mean + amplitude cos(2π bpm t / 60); G = −dp/dz", ...active },
      scope: "Rigid straight fully developed axisymmetric laminar continuum. Tracers are passive visualization; no cells, stenosis, branching, compliance or incision bleeding.",
      snapshot: { ...snapshot, radialCentresM: Array.from(snapshot.radialCentresM), annularAreasM2: Array.from(snapshot.annularAreasM2), axialVelocityMS: Array.from(snapshot.axialVelocityMS) },
      lastSolve: lastSolve.current, recentHistory: historyRef.current };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "viscera-artery-flow.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const slider = (label: string, key: keyof Controls, min: number, max: number, step: number, unit: string) =>
    <label>{label}<output>{settings[key]} {unit}</output><input aria-label={label} type="range" min={min} max={max} step={step}
      value={settings[key]} onChange={e => setSettings(s => ({ ...s, [key]: Number(e.target.value) }))} /></label>;
  const referenceWomersley = active.radiusMM / 1000 * Math.sqrt(1060 * 2 * Math.PI * active.bpm / 60 / .00345);
  return <main className="blood-lab artery-lab">
    <header className="blood-header">
      <a href="?" className="blood-back"><ArrowLeft size={16} /> Anatomy studio</a>
      <div className="blood-wordmark"><Droplets size={22} /><span>VISCERA <strong>Blood lab</strong></span><span className="blood-badge">Research preview</span></div>
      <div className="blood-actions"><DisplaySettings /><VideoRecorderButton /></div>
    </header>
    {navigation}
    <div className="blood-heading"><div><p className="blood-kicker">FLUID MECHANICS / 02</p><h1>Artery flow playground.</h1>
      <p>Explore pulsatile flow, shear thinning and the velocity profile inside a filled vessel.</p></div>
      <div className="blood-model-note"><strong>Rigid straight artery model</strong><span>The axial velocity profile across the lumen is solved numerically. The cutaway and tracer streaks are scientific visualization.</span></div></div>
    <div className="blood-layout">
      <section className="blood-stage artery-stage" aria-label="Artery flow scene">
        <div className="artery-canvas-host" ref={host} />
        <div className="blood-legend">{display === "velocity" ? "Signed axial velocity · blue reverse / pale zero / amber forward" : "Illustrative blood optics"}<br />Passive tracer streaks · enlarged for observation · not blood cells</div>
        {!ready && !error && <div className="blood-overlay" role="status">Preparing the artery model…</div>}
        {error && <div className="blood-overlay blood-error" role="alert"><strong>Flow paused</strong><p>{error}</p><button onClick={reset}>Reset artery</button></div>}
        <SceneResizeHandle />
      </section>
      <aside className="blood-controls" aria-label="Artery parameters">
        <BloodFluidModelControl />
        <h2>Vessel & blood</h2><p className="blood-muted">Geometry and waveform changes apply on reset. The lumen stays filled; flow enters and leaves at the same rate.</p>
        <label>Rheology<select aria-label="Blood rheology" value={settings.rheology} onChange={e => setSettings(s => ({ ...s, rheology: e.target.value as Controls["rheology"] }))}>
          <option value="carreau-yasuda">Carreau–Yasuda · shear thinning</option><option value="newtonian">Newtonian · 3.45 mPa·s</option>
        </select></label>
        {slider("Lumen radius", "radiusMM", 1, 5, .25, "mm")}
        {slider("Vessel length", "lengthMM", 30, 100, 5, "mm")}
        <h2>Pressure waveform</h2>
        {slider("Mean pressure gradient", "meanGradient", 0, 1000, 25, "Pa/m")}
        {slider("Pulse amplitude", "pulseGradient", 0, 1200, 25, "Pa/m")}
        {slider("Heart rate", "bpm", 40, 150, 1, "bpm")}
        <p className="blood-muted">A synthetic cosine pressure-gradient waveform, independent of absolute blood pressure. A larger pulse can produce flow reversal with an inertial phase lag.</p>
        <label>Radial resolution<select aria-label="Artery radial resolution" value={settings.radialCells} onChange={e => setSettings(s => ({ ...s, radialCells: Number(e.target.value) }))}>
          <option value="32">32 annular cells</option><option value="64">64 annular cells</option><option value="128">128 annular cells</option>
        </select></label>
        <label>Physical timestep<select aria-label="Artery timestep" value={settings.dtMS} onChange={e => setSettings(s => ({ ...s, dtMS: Number(e.target.value) }))}>
          <option value={2}>2 ms</option><option value={1}>1 ms</option><option value={.5}>0.5 ms</option>
        </select></label>
        <div className="blood-run-buttons"><button className="blood-primary" disabled={!ready || !!error} onClick={() => setRunning(v => !v)}>{running ? <Pause size={16} /> : <Play size={16} />}{running ? "Pause artery" : "Run artery"}</button>
          <button onClick={reset}><RotateCcw size={16} /> Apply & reset</button></div>
        <p className="blood-status" role="status">{running ? "Solving transient momentum and shear-dependent viscous stress" : status}</p>
        <h2>Observation</h2>
        <label>Artery display<select aria-label="Artery display" value={display} onChange={e => setDisplay(e.target.value as "blood" | "velocity")}>
          <option value="velocity">Velocity field & tracers</option><option value="blood">Blood material & tracers</option></select></label>
        <label className="artery-checkbox"><input aria-label="Open vessel cutaway" type="checkbox" checked={cutaway} onChange={e => setCutaway(e.target.checked)} /> Open vessel cutaway</label>
        <label>Playback speed<select aria-label="Artery playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
          <option value={.1}>0.1× · slow observation</option><option value={.25}>0.25×</option><option value={1}>1× target</option></select></label>
        <dl className="blood-metrics">
          <div><dt>Simulated physical time</dt><dd data-testid="artery-time">{(state?.timeSeconds ?? 0).toFixed(3)} s</dd></div>
          <div><dt>Volumetric flow</dt><dd data-testid="artery-flow">{((state?.flowRateM3S ?? 0) * 1e6).toFixed(3)} mL/s</dd></div>
          <div><dt>Mean axial velocity</dt><dd>{(state?.meanVelocityMS ?? 0).toFixed(3)} m/s</dd></div>
          <div><dt>Wall shear, signed</dt><dd data-testid="artery-wall-shear">{(state?.wallShearPa ?? 0).toFixed(3)} Pa</dd></div>
          <div><dt>Pressure drop over length</dt><dd>{((state?.pressureGradientPaPerM ?? 0) * active.lengthMM / 1000).toFixed(2)} Pa</dd></div>
          <div><dt>Reynolds reference</dt><dd>{(state?.reynolds ?? 0).toFixed(0)}</dd></div>
          <div><dt>Womersley reference</dt><dd>{referenceWomersley.toFixed(2)}</dd></div>
        </dl>
        <p className="blood-muted">Reference numbers use 3.45 mPa·s. Fixed vessel volume follows from the model assumption; it is not a test of a deforming vessel. Display FPS and simulated time are separate.</p>
        <details className="artery-solver-details"><summary>Numerical diagnostics</summary><dl className="blood-metrics">
          <div><dt>Nonlinear iterations</dt><dd>{lastSolve.current?.iterations ?? 0}</dd></div>
          <div><dt>Momentum residual, relative</dt><dd>{(lastSolve.current?.relativeMomentumResidual ?? 0).toExponential(2)}</dd></div>
          <div><dt>Momentum-balance error</dt><dd>{(lastSolve.current?.momentumBalanceRelativeError ?? 0).toExponential(2)}</dd></div>
        </dl><p className="blood-muted">A failed solve preserves the last accepted velocity and time. These are numerical diagnostics, not a measure of photographic realism.</p></details>
        {state && state.reynolds > 2000 && <p className="artery-warning" role="status">This setting may exceed the laminar-flow regime. Transition and turbulence are not modeled.</p>}
        <button className="blood-export" onClick={exportRun} disabled={!ready}><Download size={16} /> Export artery state & waveform</button>
      </aside>
    </div>
    <div className="artery-analysis">{state && <ProfileChart state={state} radiusM={active.radiusMM / 1000} />}
      <section><h2>What the model resolves</h2><p>Unsteady axial momentum, the physical no-slip boundary, and nonlinear Carreau–Yasuda stress are solved across concentric finite volumes. The pressure pulse drives the computed velocity; it does not prescribe a moving particle animation.</p>
        <p>Steady Poiseuille flow, independent shear-thinning stress balance, and the analytical Womersley response provide separate numerical checks.</p></section></div>
    <div className="blood-notes">
      <section><h2>Scope & visual interpretation</h2><p>A uniform, rigid, straight vessel with fully developed laminar flow. Curvature, branches, stenosis, compliant walls, turbulence, red-cell deformation, clotting and incision bleeding require additional models. The drawing is not patient-specific or photorealistically validated.</p></section>
      <section><h2>Physics references</h2><p>The constitutive preset follows Weddell et al. (2015). The pulsatile Newtonian benchmark follows Womersley (1955), with explicit pressure phase and SI units.</p>
        <a href="https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0124575" target="_blank" rel="noreferrer">Read the blood-rheology study ↗</a></section>
    </div>
  </main>;
}
