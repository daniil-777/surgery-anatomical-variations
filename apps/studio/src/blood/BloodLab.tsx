import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Download, Droplets, Pause, Play, RotateCcw } from "lucide-react";
import { DisplaySettings, SceneResizeHandle } from "../DisplaySettings";
import { VideoRecorderButton } from "../VideoRecorderPanel";
import { BloodRuntime, failureMessage, type BloodReport } from "./runtime";
import { BloodRenderer } from "./renderer";
import { BLOOD_CAPABILITIES, DEFAULT_SCENE, type BloodScene, type FlowFixture } from "./scene";
import { BLOOD_PROFILES, viscosity } from "./material";
import { ArteryLab } from "./artery/ArteryLab";
import { CapillaryLab } from "./capillary/CapillaryLab";
import { ExperimentLab } from "./experiments/ExperimentLab";
import { LiverLab } from "./liver/LiverLab";
import { PoolLab } from "./pool/PoolLab";
import { BloodFluidModelControl, BloodModelContext, BloodModelSelector } from "./BloodModelSelector";
import { parseBloodWorkspace, type BloodWorkspace } from "./models";
import { BLOOD_OPTICS_PROVENANCE } from "./optics";
import "./blood.css";

export default function BloodLab() {
  const [workspace, setWorkspace] = useState<BloodWorkspace>(() => parseBloodWorkspace(new URLSearchParams(location.search).get("flow")));
  const [notice, setNotice] = useState("");
  const choose = (next: BloodWorkspace) => {
    if (document.querySelector('canvas[data-scene-recording-active="true"]')) {
      setNotice("Stop the recording before changing workspaces."); return;
    }
    setNotice(""); setWorkspace(next);
    const url = new URL(location.href);
    if (next !== "surface") url.searchParams.set("flow", next); else url.searchParams.delete("flow");
    history.replaceState(null, "", url);
  };
  const navigation = <BloodModelSelector workspace={workspace} choose={choose} notice={notice} />;
  return <BloodModelContext.Provider value={{ workspace, choose }}>
    {workspace === "liver" ? <LiverLab navigation={navigation} /> : workspace === "pool" ? <PoolLab navigation={navigation} /> : workspace === "artery" ? <ArteryLab navigation={navigation} /> : workspace === "film" ? <CapillaryLab navigation={navigation} /> : workspace === "experiments" ? <ExperimentLab navigation={navigation} /> : <ParticleBloodLab navigation={navigation} />}
  </BloodModelContext.Provider>;
}

function ParticleBloodLab({ navigation }: { navigation: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null), runtime = useRef<BloodRuntime | null>(null), renderer = useRef<BloodRenderer | null>(null);
  const [settings, setSettings] = useState({ ...DEFAULT_SCENE }), [scene, setScene] = useState({ ...DEFAULT_SCENE });
  const [revision, setRevision] = useState(0), [running, setRunning] = useState(false), [ready, setReady] = useState(false);
  const [report, setReport] = useState<BloodReport>(), [error, setError] = useState(""), [colour, setColour] = useState<"red" | "speed">("red");
  const [viewMode, setViewMode] = useState<"surface" | "particles">("surface");
  const [status, setStatus] = useState("Preparing WebGPU…"), [exporting, setExporting] = useState(false);
  const live = useRef({ running, colour, viewMode }); live.current = { running, colour, viewMode };
  useEffect(() => {
    let cancelled = false, frame = 0, engine: BloodRuntime | undefined, view: BloodRenderer | undefined, lastReport = 0;
    const abort = new AbortController();
    setReady(false); setReport(undefined); setError(""); setStatus("Preparing WebGPU…");
    void BloodRuntime.create(scene, { signal: abort.signal }).then(value => {
      engine = value;
      if (cancelled) { value.dispose(); return; }
      try {
        view = new BloodRenderer(canvas.current!, value); runtime.current = value; renderer.current = view;
        value.onReport = next => {
          if (cancelled) return;
          if (next.halted || performance.now() - lastReport > 200) { setReport(next); lastReport = performance.now(); }
          if (next.halted) { setRunning(false); setStatus("Stopped at the last accepted state"); }
        };
        value.onError = message => { if (!cancelled) { setError(message); setRunning(false); setReady(false); } };
        setReady(true); setStatus("Ready · experimental Newtonian fixture");
        const tick = () => {
          if (cancelled) return;
          if (!document.hidden && view && !value.errors.length) {
            view.colour = live.current.colour;
            view.mode = live.current.viewMode;
            const simulate = live.current.running && !value.report?.halted;
            // Amortize queue/presentation overhead without increasing physical dt.
            // Runtime still bounds ownership to two in-flight submissions.
            const completion = simulate || view.needsRender ? value.submit(simulate ? 4 : 0, view.encode) : undefined;
            void completion?.catch(cause => { if (!cancelled) { setError(String(cause)); setRunning(false); } });
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      } catch (cause) { value.dispose(); if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      cancelled = true; abort.abort(); cancelAnimationFrame(frame); view?.dispose(); engine?.dispose();
      if (runtime.current === engine) runtime.current = null; if (renderer.current === view) renderer.current = null;
    };
  }, [scene, revision]);
  const reset = () => {
    if (canvas.current?.dataset.sceneRecordingActive === "true") { setStatus("Stop the recording before resetting the simulation."); return; }
    setRunning(false); setScene({ ...settings }); setRevision(v => v + 1);
  };
  const exportRun = async () => {
    const value = runtime.current; if (!value || exporting) return;
    setRunning(false); setExporting(true);
    try {
      // Rendering continues; the next animation frame observes running=false before the snapshot.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await value.device.queue.onSubmittedWorkDone();
      const control = await value.readBuffer(value.control), u = new Uint32Array(control), f = new Float32Array(control);
      const payload = { schema: "viscera.blood.evidence/v1", createdAt: new Date().toISOString(), scene: value.scene,
        configHash: value.configHash, capabilities: BLOOD_CAPABILITIES, adapter: value.adapterInfo, optics: BLOOD_OPTICS_PROVENANCE,
        allocationLedger: value.allocationLedger, acceptedStep: u[1], acceptedTimeSeconds: u[1]! * value.scene.dtSeconds,
        attempts: u[4], failureBits: u[5], lastAttemptResiduals: { densityRelative: f[6], divergencePerSecond: f[7] },
        acceptedStateLayout: "N vec4(position metres, mass kg), then N vec4(velocity m/s, padding)",
        acceptedState: Array.from(new Float32Array(await value.readBuffer(value.accepted))),
        limits: "Experimental Newtonian fluid. No validated capillarity, wetting, arterial wall, CY stress, or surgical realism.",
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `blood-run-${value.configHash.slice(0, 12)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (cause) { setError(String(cause)); } finally { setExporting(false); }
  };
  return <main className="blood-lab">
    <header className="blood-header">
      <a href="?" className="blood-back"><ArrowLeft size={16} /> Anatomy studio</a>
      <div className="blood-wordmark"><Droplets size={22} /><span>VISCERA <strong>Blood lab</strong></span><span className="blood-badge">Research preview</span></div>
      <div className="blood-actions"><DisplaySettings /><VideoRecorderButton /></div>
    </header>
    {navigation}
    <div className="blood-heading"><div><p className="blood-kicker">FLUID MECHANICS / 01</p><h1>Blood flow laboratory.</h1><p>Experimental fluid simulation and validation for future surgical scenes.</p></div>
      <div className="blood-model-note"><strong>Experimental fluid</strong><span>A reconstructed liquid surface with approximate spectral blood optics. Physical and surgical validation remain incomplete.</span></div></div>
    <div className="blood-layout">
      <section className="blood-stage" aria-label="Blood flow scene">
        <canvas ref={canvas} aria-label="3D fluid diagnostic. Drag or use arrow keys to orbit, plus and minus to zoom, Home to reset camera." tabIndex={0} />
        <div className="blood-stage-label"><span className="blood-dot" /> {scene.axis ** 3} samples · {(scene.lengthM * 1000).toFixed(0)} mm {scene.fixture === "dam" ? "open tray · side-wall cutaway" : "periodic cube"}</div>
        <div className="blood-legend">{viewMode === "surface" ? scene.fixture === "dam" ? "Surface preview · 1 mm floor grid · no wetting or surface tension" : "Periodic volume cutaway · not a physical blood–air interface" : colour === "speed" ? "Speed · blue 0 → orange 25 mm/s" : "Diagnostic samples · not blood cells"}</div>
        {!ready && !error && <div className="blood-overlay" role="status">{status}</div>}
        {error && <div className="blood-overlay blood-error" role="alert"><strong>Simulation unavailable</strong><p>{error}</p><button onClick={reset}>Retry initialization</button></div>}
        <SceneResizeHandle />
      </section>
      <aside className="blood-controls" aria-label="Fluid parameters">
        <BloodFluidModelControl />
        <h2>Simulation</h2>
        <p className="blood-muted">Settings apply on reset. Camera and colour never change the physics.</p>
        <label>Verification fixture<select aria-label="Verification fixture" value={settings.fixture} onChange={e => setSettings(s => ({ ...s, fixture: e.target.value as FlowFixture, dtSeconds: e.target.value === "dam" ? .0001 : .0005 }))}>
          <option value="dam">Gravity-driven liquid in an open tray</option><option value="vortex">Periodic vortex</option><option value="shear">Viscous shear decay</option><option value="translation">Uniform translation</option>
        </select></label>
        <label>Spatial resolution<select aria-label="Spatial resolution" value={settings.axis} onChange={e => setSettings(s => ({ ...s, axis: Number(e.target.value) as BloodScene["axis"] }))}>
          <option value="8">8³ · 512 samples</option><option value="12">12³ · 1,728 samples</option><option value="16">16³ · 4,096 samples</option>
        </select></label>
        <label>Initial speed <output>{settings.fixture === "dam" ? "Released from rest" : `${(settings.speedMS * 1000).toFixed(0)} mm/s`}</output><input aria-label="Initial speed" type="range" disabled={settings.fixture === "dam"} min="0" max="50" step="1" value={settings.speedMS * 1000} onChange={e => setSettings(s => ({ ...s, speedMS: Number(e.target.value) / 1000 }))} /></label>
        <dl className="blood-constants"><div><dt>Density</dt><dd>1,060 kg/m³</dd></div><div><dt>Dynamic viscosity</dt><dd>3.45 mPa·s</dd></div><div><dt>Fixed timestep on reset</dt><dd>{(settings.dtSeconds * 1000).toFixed(1)} ms</dd></div></dl>
        {settings.fixture === "dam" && <p className="blood-muted">Boundary validation is incomplete. This fixture can halt at a contact or density guard; it is not a bleeding model.</p>}
        <div className="blood-run-buttons">
          <button className="blood-primary" disabled={!ready || report?.halted || exporting} onClick={() => setRunning(v => !v)}>{running ? <Pause size={16} /> : <Play size={16} />}{running ? "Pause" : "Run fluid"}</button>
          <button onClick={reset} disabled={exporting || canvas.current?.dataset.sceneRecordingActive === "true"}><RotateCcw size={16} /> Reset</button>
        </div>
        <p className="blood-status" role="status">{report?.halted ? failureMessage(report.failureBits) : running ? "Running · accepted physical time shown below" : status}</p>
        <h2>Observation</h2>
        <label>Rendering<select aria-label="Rendering" value={viewMode} onChange={e => setViewMode(e.target.value as "surface" | "particles")}><option value="surface">Continuous liquid surface · preview</option><option value="particles">Diagnostic particles</option></select></label>
        {viewMode === "particles" && <label>Particle colour<select aria-label="Particle colour" value={colour} onChange={e => setColour(e.target.value as "red" | "speed")}><option value="red">Illustrative red</option><option value="speed">Speed field</option></select></label>}
        <dl className="blood-metrics">
          <div><dt>Accepted physical time</dt><dd data-testid="blood-time">{(report?.acceptedTimeSeconds ?? 0).toFixed(4)} s</dd></div>
          <div><dt>Accepted steps</dt><dd data-testid="blood-steps">{report?.acceptedStep ?? 0}</dd></div>
          <div><dt>Last density residual</dt><dd>{((report?.densityResidual ?? 0) * 100).toFixed(3)}%</dd></div>
          <div><dt>Last divergence residual</dt><dd>{(report?.divergenceResidualS ?? 0).toFixed(3)} s⁻¹</dd></div>
        </dl>
        <p className="blood-muted">Readouts are delayed GPU snapshots. Display frame rate is not physical simulation speed. Hidden tabs pause new work.</p>
        <button className="blood-export" disabled={!ready || exporting} onClick={() => void exportRun()}><Download size={16} />{exporting ? "Exporting…" : "Export accepted state + report"}</button>
      </aside>
    </div>
    <div className="blood-notes">
      <section><h2>What this release establishes</h2><p>A WebGPU DFSPH research solver, periodic or fixed tray boundaries, constant viscosity, and a GPU commit gate. The continuous surface uses depth reconstruction and volume thickness. Rejected attempts halt at the previous accepted state.</p><p><strong>Realistic surgical blood is not validated.</strong> This particle solver has no surface tension, wetting, coagulation or organ-cut bleeding. The separate thin-film workspace tests capillary leveling and small-angle wetting; the artery workspace models a filled, rigid straight vessel.</p></section>
      <section><h2>Blood material reference</h2><p>The sourced Carreau–Yasuda profile varies from {(viscosity(0) * 1000).toFixed(1)} to {(viscosity(1000) * 1000).toFixed(2)} mPa·s between 0 and 1,000 s⁻¹. It is tested separately; this flow solver currently uses constant viscosity.</p><a href={BLOOD_PROFILES[0]!.source} target="_blank" rel="noreferrer">Read the constitutive source ↗</a><p>Optical reference: {BLOOD_OPTICS_PROVENANCE.conditions}. Thickness-dependent transport remains an approximation, without surgical camera calibration.</p><a href={BLOOD_OPTICS_PROVENANCE.attributionPath} target="_blank" rel="noreferrer">Optical data, model and attribution ↗</a></section>
    </div>
  </main>;
}
