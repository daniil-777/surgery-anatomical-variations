import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle2, Crosshair, Download, Droplet, Droplets, Hand, Pause, Play, RotateCcw, ShieldAlert } from "lucide-react";
import { DisplaySettings, SceneResizeHandle } from "../../DisplaySettings";
import { VideoRecorderButton } from "../../VideoRecorderPanel";
import { reportReady } from "../../api";
import { BloodPoolEngine, POOL_UPSTREAM, type PoolAppearance, type PoolMode, type PoolParityReport, type PoolTelemetry } from "./engine";
import { DEFAULT_POOL_CONFIG, derivePoolScheme, POOL_GRIDS, type PoolConfig, type PoolDamping, type PoolGrid } from "./model";
import { BLOOD_APPEARANCE_PROVENANCE } from "../experiments/bloodAppearanceOptics";
import { BloodFluidModelControl } from "../BloodModelSelector";
import "../liver/liver.css";
import "./pool.css";

const PRESETS: Record<string, { label: string; bloodFraction: number; note: string }> = {
  whole: { label: "Whole blood", bloodFraction: 1, note: "Opaque within about a millimetre; the floor and caustics are hidden." },
  irrigated: { label: "Irrigated · 2% blood", bloodFraction: .02, note: "Saline-diluted field blood (~100 µm whole-blood equivalent over 5 mm); the tray floor shows through a deep red layer." },
  wash: { label: "Wash fluid · 0.5% blood", bloodFraction: .005, note: "Lightly blood-stained saline (~25 µm whole-blood equivalent over 5 mm); refracted caustics and submerged probe are visible." },
};
const mm = (m: number, digits = 2) => `${(m * 1000).toFixed(digits)} mm`;
const ul = (m3: number, digits = 1) => `${(m3 * 1e9).toFixed(digits)} µL`;

export function PoolLab({ navigation }: { navigation: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null), engine = useRef<BloodPoolEngine | null>(null);
  const [settings, setSettings] = useState<PoolConfig>({ ...DEFAULT_POOL_CONFIG }), [active, setActive] = useState<PoolConfig>({ ...DEFAULT_POOL_CONFIG });
  const [revision, setRevision] = useState(0), [ready, setReady] = useState(false), [running, setRunning] = useState(false);
  const [mode, setMode] = useState<PoolMode>("drip"), [speed, setSpeed] = useState(1);
  const [appearance, setAppearance] = useState<PoolAppearance>({ bloodFraction: 1, oxygenation: .75, exposureEV: 0 });
  const [dripRate, setDripRate] = useState(2), [dripHeightCm, setDripHeightCm] = useState(10), [continuous, setContinuous] = useState(false);
  const [instrument, setInstrument] = useState(true), [immersionMM, setImmersionMM] = useState(2);
  const [telemetry, setTelemetry] = useState<PoolTelemetry>(), [parity, setParity] = useState<PoolParityReport>(), [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const history = useRef<{ time: number; volumeError: number; maxRelativeElevation: number }[]>([]);
  const live = useRef({ running, speed, mode, dripRate, dripHeightCm, continuous }); live.current = { running, speed, mode, dripRate, dripHeightCm, continuous };
  const pending = JSON.stringify(settings) !== JSON.stringify(active);
  const preview = (() => { try { return derivePoolScheme(settings); } catch { return null; } })();

  useEffect(() => {
    const abort = new AbortController(); let cancelled = false, frame = 0, lastPublish = 0, value: BloodPoolEngine | undefined;
    setReady(false); setError(""); setTelemetry(undefined); setParity(undefined); history.current = [];
    void BloodPoolEngine.create(canvas.current!, active, appearance, abort.signal).then(created => {
      if (cancelled) { created.dispose(); return; }
      value = created; engine.current = created;
      created.onError = message => { if (!cancelled) { setError(message); setRunning(false); } };
      created.onHalt = reason => { if (!cancelled) { setRunning(false); setNotice(reason); } };
      created.onReadback = r => { history.current = [...history.current, { time: r.timeSeconds, volumeError: r.relativeVolumeError, maxRelativeElevation: r.maxRelativeElevation }].slice(-600); };
      created.onInteract = () => { if (!cancelled) { live.current.running = true; setRunning(true); } };
      created.mode = live.current.mode;
      created.setInstrument(instrument, immersionMM / 1000); created.clear();
      setReady(true); reportReady("blood-pool");
      const tick = (now: number) => {
        if (cancelled) return;
        try {
          const e = created; e.running = live.current.running; e.speed = live.current.speed; e.mode = live.current.mode;
          e.dripRateHz = live.current.dripRate; e.dripHeightM = live.current.dripHeightCm / 100; e.continuousDrip = live.current.continuous;
          if (!document.hidden) e.frame(now);
          if (now - lastPublish > 150) { setTelemetry(e.telemetry()); lastPublish = now; }
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setRunning(false); }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }).catch(cause => { if (!cancelled && !(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; abort.abort(); cancelAnimationFrame(frame); value?.dispose(); if (engine.current === value) engine.current = null; };
    // Appearance/instrument are applied live by the effects below; only the model configuration recreates the engine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, revision]);
  useEffect(() => { try { engine.current?.setAppearance(appearance); } catch (cause) { setNotice(String(cause)); } }, [appearance]);
  useEffect(() => { engine.current?.setInstrument(instrument, immersionMM / 1000); }, [instrument, immersionMM]);
  useEffect(() => { if (engine.current) engine.current.mode = mode; }, [mode]);

  const recording = () => canvas.current?.dataset.sceneRecordingActive === "true";
  const reset = () => {
    if (recording()) { setNotice("Stop the recording before resetting the pool."); return; }
    setRunning(false); setNotice("");
    if (pending) { setActive({ ...settings }); setRevision(v => v + 1); } else { engine.current?.clear(); history.current = []; setParity(undefined); }
  };
  const verify = async () => {
    const e = engine.current; if (!e || verifying) return;
    setRunning(false); setVerifying(true); setNotice("");
    try { const report = await e.verifyParity(); setParity(report); history.current = []; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setVerifying(false); }
  };
  const dripHere = () => { const e = engine.current; if (!e) return; e.addDrop(...e.dripSource); if (!running) setNotice("Drop released. Press Run to let it fall."); };
  const exportEvidence = () => {
    const e = engine.current; if (!e) return;
    setRunning(false);
    const body = { schema: "viscera.blood-pool.evidence/v1", createdAt: new Date().toISOString(), upstream: POOL_UPSTREAM,
      config: e.config, scheme: e.scheme, appearance, optics: BLOOD_APPEARANCE_PROVENANCE, telemetry: e.telemetry(), parity: parity ?? null,
      readbackHistory: history.current, adapter: { vendor: e.adapterInfo.vendor, architecture: e.adapterInfo.architecture, description: e.adapterInfo.description },
      limitations: "Linear shallow-water heightfield with uniform bottom friction. No capillary waves, finite-depth dispersion, nonlinear steepening, splash, wetting/contact lines, clotting or rheology. Drop impact deposits volume only; momentum and crater dynamics are not modelled. Optics: diffuse spectral slab over a lit substrate; not a calibrated camera model." };
    const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `blood-pool-${e.telemetry().steps}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const t = telemetry, s = engine.current?.scheme ?? preview, validity = t?.validity;
  const presetKey = Object.entries(PRESETS).find(([, p]) => p.bloodFraction === appearance.bloodFraction)?.[0] ?? "custom";
  const hint = mode === "drip" ? "Click or drag on the pool to release drops · right-drag rotates · scroll zooms"
    : mode === "probe" ? "Drag on the pool to move the blunt probe through the blood · right-drag rotates"
      : "Drag to rotate · scroll or pinch to zoom · Home resets the view";

  return <main className="blood-lab liver-lab pool-lab">
    <header className="blood-header">
      <a href="?" className="blood-back"><ArrowLeft size={16} /> Anatomy studio</a>
      <div className="blood-wordmark"><Droplets size={22} /><span>VISCERA <strong>Blood pool</strong></span><span className="blood-badge">Research preview</span></div>
      <div className="blood-actions"><DisplaySettings /><VideoRecorderButton /></div>
    </header>
    {navigation}
    <div className="blood-heading liver-heading"><div><p className="blood-kicker">FLUID MECHANICS / 06 · HEIGHTFIELD</p>
      <h1>Blood pool surface.</h1><p>Collected blood in a stainless tray: drip drops into it, move an instrument through it, and watch the surface respond.</p></div>
      <div className="liver-source-note">Linear shallow-water waves<span>Spectral blood optics · after webgpu-water (MIT)</span></div></div>
    <div className="liver-workspace">
      <div className="liver-scene-column">
        <div className="liver-toolstrip" role="group" aria-label="Pool interaction tools">
          <button aria-pressed={mode === "orbit"} onClick={() => setMode("orbit")}><Hand size={17} /> Rotate</button>
          <button aria-pressed={mode === "drip"} disabled={!ready} onClick={() => setMode("drip")}><Droplet size={17} /> Drip</button>
          <button aria-pressed={mode === "probe"} disabled={!ready} onClick={() => setMode("probe")}><Crosshair size={17} /> Probe</button>
          <button disabled={!ready} onClick={() => engine.current?.topView()}>Top view</button>
          <button disabled={!ready} onClick={() => engine.current?.resetCamera()}>Reset view</button>
          <span>{hint}</span>
        </div>
        <section className="blood-stage liver-stage pool-stage" aria-label="Blood pool scene">
          <canvas ref={canvas} tabIndex={0} aria-label="Blood pool in a stainless tray. Drip mode: click to release a drop. Probe mode: drag to move the instrument. Right-drag or arrow keys rotate, plus and minus zoom, Home resets." />
          {!ready && !error && <div className="blood-overlay" role="status">Preparing WebGPU blood pool…</div>}
          {error && <div className="blood-overlay blood-error" role="alert"><strong>Pool stopped</strong><p>{error}</p><button onClick={() => { setError(""); setRevision(v => v + 1); }}>Restart pool</button></div>}
          <div className="liver-stage-caption">{(active.lengthM * 1000).toFixed(0)} mm tray · {mm(active.depthM, 1)} blood layer · {active.grid}² cells
            <span>{PRESETS[presetKey]?.label ?? `${(appearance.bloodFraction * 100).toFixed(0)}% blood`} · SO₂ {(appearance.oxygenation * 100).toFixed(0)}% · rendering never advances physics</span></div>
          <SceneResizeHandle />
        </section>
        <div className="liver-runbar">
          <button className="blood-primary" disabled={!ready || !!error} onClick={() => setRunning(v => !v)}>{running ? <Pause size={16} /> : <Play size={16} />}{running ? "Pause pool" : "Run pool"}</button>
          <button disabled={!ready} onClick={dripHere}><Droplet size={16} /> Release one drop</button>
          <span><strong data-testid="pool-time">{(t?.timeSeconds ?? 0).toFixed(3)} s</strong> physical time</span>
          <label>Playback<select aria-label="Pool playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={1}>1×</option><option value={.25}>¼×</option><option value={.1}>⅒×</option></select></label>
        </div>
        <p className="liver-feedback" role="status">{notice || (running ? `Running · Δt = ${((s?.dtSeconds ?? 0) * 1000).toFixed(3)} ms per step` : "Choose Drip and click the pool, or enable a continuous drip, then press Run pool.")}</p>
        <div className="liver-readings" aria-label="Pool measurements">
          <div><span>Drops landed</span><strong data-testid="pool-drops">{t?.drops ?? 0}</strong></div>
          <div><span>Added blood</span><strong>{((t?.depositedVolumeM3 ?? 0) * 1e6).toFixed(3)} <small>mL</small></strong></div>
          <div><span>Peak elevation</span><strong>{(((t?.readback?.maxRelativeElevation ?? 0) * active.depthM) * 1000).toFixed(3)} <small>mm</small></strong></div>
          <div><span>Volume error</span><strong data-testid="pool-volume-error">{t?.readback ? (t.readback.relativeVolumeError * 100).toExponential(1) : "—"} <small>%</small></strong></div>
        </div>
        <div className="liver-phase-readings">
          <span>Wave speed √(gH) <strong>{((s?.waveSpeedMS ?? 0) * 1000).toFixed(0)} mm/s</strong></span>
          <span>Step <strong>{((s?.dtSeconds ?? 0) * 1000).toFixed(3)} ms</strong></span>
          <span>Courant <strong>{(s?.courant ?? 0).toFixed(3)}</strong></span>
          <span>Amplitude decay time <strong>{s ? (2 / s.frictionPerSecond).toFixed(2) : "—"} s</strong></span>
          <span>Drop (Tate) <strong>{s ? ul(s.dropVolumeM3) : "—"}</strong></span>
          <span>Airborne drops <strong>{t?.airborne ?? 0}</strong></span>
          {!!t?.skippedSimSeconds && <span>Clock slowed by <strong>{t.skippedSimSeconds.toFixed(2)} s</strong></span>}
        </div>
        <div className={`pool-validity ${validity?.status === "outside-indicators" ? "is-outside" : ""}`} data-testid="pool-validity">
          {validity?.status === "outside-indicators" ? <ShieldAlert size={18} /> : <CheckCircle2 size={18} />}
          <div><strong>{validity?.status === "outside-indicators" ? "Some drop-scale effects lie outside this reduced model" : "Within the model's indicators"}</strong>
            <ul>{validity?.notes.map(note => <li key={note}>{note}</li>)}</ul>
            <small>Engineering indicators at the drop-footprint wavelength ({s ? mm(s.referenceWavelengthM, 1) : "—"}), not clinical thresholds.</small></div>
        </div>
      </div>
      <aside className="blood-controls liver-controls" aria-label="Blood pool controls">
        <BloodFluidModelControl />
        <section><h2>Drip</h2>
          <p className="blood-muted">Each drop has the Tate's-law volume of a pendant drop released from a 0.5 mm contact — the same closure the liver runoff uses.</p>
          <label className="liver-check"><input type="checkbox" checked={continuous} onChange={e => setContinuous(e.target.checked)} />Continuous drip at the last clicked point</label>
          <label>Drip rate <output>{dripRate.toFixed(1)} drops/s</output><input aria-label="Drip rate" type="range" min=".5" max="8" step=".5" value={dripRate} onChange={e => setDripRate(Number(e.target.value))} /></label>
          <label>Fall height <output>{dripHeightCm} cm · impact {Math.sqrt(2 * 9.80665 * dripHeightCm / 100).toFixed(2)} m/s</output><input aria-label="Fall height" type="range" min="2" max="30" step="1" value={dripHeightCm} onChange={e => setDripHeightCm(Number(e.target.value))} /></label>
          <p className="blood-muted">Fall height sets arrival time only; impact momentum and splash are not modelled.</p>
        </section>
        <section><h2>Instrument</h2>
          <label className="liver-check"><input type="checkbox" checked={instrument} onChange={e => setInstrument(e.target.checked)} />Show blunt probe ({mm(active.instrumentRadiusM * 2, 0)} ball)</label>
          <label>Immersion <output>{immersionMM.toFixed(1)} mm</output><input aria-label="Probe immersion" type="range" min="0" max={(active.depthM + active.instrumentRadiusM) * 1000} step=".5" value={immersionMM} onChange={e => setImmersionMM(Number(e.target.value))} /></label>
          <p className="blood-muted">Moving the probe displaces exactly its change in submerged volume. Motion is limited to 120 mm/s.</p>
        </section>
        <section><h2>Blood appearance</h2>
          <label>Fluid<select aria-label="Pool fluid" value={presetKey} onChange={e => { const p = PRESETS[e.target.value]; if (p) setAppearance(a => ({ ...a, bloodFraction: p.bloodFraction })); }}>
            {Object.entries(PRESETS).map(([key, p]) => <option key={key} value={key}>{p.label}</option>)}{presetKey === "custom" && <option value="custom">Custom</option>}</select></label>
          <p className="blood-muted">{PRESETS[presetKey]?.note}</p>
          <label>Oxygen saturation<select aria-label="Pool oxygen saturation" value={appearance.oxygenation} onChange={e => setAppearance(a => ({ ...a, oxygenation: Number(e.target.value) }))}>
            <option value={.75}>75% · venous</option><option value={.98}>98% · arterial</option><option value={.4}>40% · deoxygenated</option></select></label>
          <label>Exposure <output>{appearance.exposureEV > 0 ? "+" : ""}{appearance.exposureEV.toFixed(1)} EV</output><input aria-label="Pool exposure" type="range" min="-2" max="2" step=".25" value={appearance.exposureEV} onChange={e => setAppearance(a => ({ ...a, exposureEV: Number(e.target.value) }))} /></label>
        </section>
        <section><h2>Model</h2>
          <label>Blood depth <output>{mm(settings.depthM, 1)}</output><input aria-label="Blood depth" type="range" min="2" max="10" step=".5" value={settings.depthM * 1000} onChange={e => setSettings(c => ({ ...c, depthM: Number(e.target.value) / 1000 }))} /></label>
          <label>Tray size<select aria-label="Tray size" value={settings.lengthM} onChange={e => setSettings(c => ({ ...c, lengthM: Number(e.target.value) }))}>
            <option value={.06}>60 mm</option><option value={.08}>80 mm</option><option value={.12}>120 mm</option></select></label>
          <label>Resolution<select aria-label="Pool resolution" value={settings.grid} onChange={e => setSettings(c => ({ ...c, grid: Number(e.target.value) as PoolGrid }))}>
            {POOL_GRIDS.map(n => <option key={n} value={n}>{n}² cells</option>)}</select></label>
          <label>Viscosity<select aria-label="Pool viscosity" value={settings.viscosityPaS} onChange={e => setSettings(c => ({ ...c, viscosityPaS: Number(e.target.value) }))}>
            <option value={.00345}>3.45 mPa·s · high-shear blood</option><option value={.01}>10 mPa·s · comparison</option><option value={.03}>30 mPa·s · comparison</option></select></label>
          <label>Bottom friction<select aria-label="Pool friction law" value={settings.damping} onChange={e => setSettings(c => ({ ...c, damping: e.target.value as PoolDamping }))}>
            <option value="stokes-drop-scale">Stokes layer at drop scale</option><option value="laminar">Laminar, low-frequency 3ν/H²</option></select></label>
          <label>Courant number² <output>{settings.courantSquared.toFixed(2)}</output><input aria-label="Courant number squared" type="range" min=".1" max=".45" step=".05" value={settings.courantSquared} onChange={e => setSettings(c => ({ ...c, courantSquared: Number(e.target.value) }))} /></label>
          {pending && <p className="liver-pending" role="status">Model changes are pending. Apply &amp; reset to use them.</p>}
          <button className="liver-reset" onClick={reset} disabled={!ready && !error}><RotateCcw size={16} />{pending ? "Apply & reset pool" : "Clear pool"}</button>
        </section>
        <section><h2>Verification</h2>
          <p className="blood-muted">Runs a deterministic two-drop fixture on the GPU and the FP32 CPU reference of the same kernel, then clears the pool.</p>
          <button className="liver-reset" disabled={!ready || verifying} onClick={() => void verify()}>{verifying ? "Verifying…" : "Run GPU/CPU parity check"}</button>
          {parity && <p className={`pool-parity ${parity.passed ? "is-pass" : "is-fail"}`} data-testid="pool-parity">{parity.passed ? "PASS" : "FAIL"} · {parity.steps} steps · max |Δh| {(parity.relativeDifference * 100).toExponential(1)}% of peak · GPU volume error {(parity.volumeRelativeError * 100).toExponential(1)}%</p>}
          <button className="blood-export" disabled={!ready} onClick={exportEvidence}><Download size={16} />Export pool evidence</button>
        </section>
      </aside>
    </div>
    <details className="liver-model-notes"><summary>Model, attribution and limitations</summary>
      <p><strong>Equations.</strong> Linearised shallow water over a flat floor: u<sub>t</sub> = −g∇η − λu and η<sub>t</sub> = −H∇·u, so η<sub>tt</sub> + λη<sub>t</sub> = gH∇²η. The upstream heightfield update is exactly this equation's symplectic-Euler discretisation; here Δt is chosen from the Courant number and the friction λ from the blood viscosity (laminar 3ν/H² or the Stokes-layer value √(νω/2)/H at the drop-footprint frequency). Tray walls are reflecting.</p>
      <p><strong>Stability correction.</strong> The upstream constant corresponds to C² = 0.5, the exact two-dimensional stability boundary. There the checkerboard mode grows linearly and was hidden by numerical damping, so this model limits C² to 0.45; a regression test records the difference.</p>
      <p><strong>Conservation.</strong> Drops add exactly their Tate volume through a discretely normalised raised-cosine footprint, and the probe displaces exactly the change in its submerged volume. Periodic GPU readbacks report the residual from FP32 rounding.</p>
      <p><strong>Optics.</strong> Reflection uses a Fresnel term at n = 1.35. Refracted light uses the shared spectral blood slab model ({BLOOD_APPEARANCE_PROVENANCE.label}), with dilution treated as an equivalent whole-blood thickness. Caustics use the upstream refracted-area method. The operating-room environment is authored, not measured.</p>
      <p><strong>Not modelled.</strong> Capillary waves, finite-depth dispersion, nonlinear steepening, impact momentum, crowns and splash, wetting and meniscus, coagulation and non-Newtonian rheology. The indicator panel quantifies the largest of these effects for the current settings.</p>
      <p>Adapted from <a href={POOL_UPSTREAM.repository} target="_blank" rel="noreferrer">jeantimex/webgpu-water</a> ({POOL_UPSTREAM.license}, {POOL_UPSTREAM.copyright}), itself after Evan Wallace's WebGL Water. See <code>pool/THIRD_PARTY_NOTICE.md</code>.</p>
    </details>
  </main>;
}
