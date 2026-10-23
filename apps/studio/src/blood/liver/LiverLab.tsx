import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Download, Droplets, Hand, Pause, Play, RotateCcw, Scissors, Undo2 } from "lucide-react";
import { DisplaySettings, SceneResizeHandle } from "../../DisplaySettings";
import { VideoRecorderButton } from "../../VideoRecorderPanel";
import { reportReady } from "../../api";
import { loadLiverAnatomy } from "./anatomy";
import { prepareLiverCut } from "./wounds";
import { LIVER_CUT_LIMITS, previewLiverCut, type LiverCutPreview } from "./cutPreview";
import { LiverFlowExperiment } from "./liverFlow";
import { LiverRenderer } from "./renderer";
import type { LiverAnatomy, LiverAppearance, LiverFlowSnapshot, LiverSurfacePick, LiverWound } from "./types";
import { BloodFluidModelControl, useBloodModel } from "../BloodModelSelector";
import "./liver.css";

const MMHG = 133.322387415;
const INITIAL = { kind: "vein" as "vein" | "artery", viscosityPaS: .00345, heartRateBpm: 72, mobilityScale: 3 };
type ModelSettings = typeof INITIAL;
type Observation = { time: number; pressure: number; flow: number; bloodLoss: number; film: number;
  attached: number; airborne: number; collected: number; error: number };
type Engine = { anatomy: LiverAnatomy; model: LiverFlowExperiment; view: LiverRenderer; snapshot: LiverFlowSnapshot };
const observe = (s: LiverFlowSnapshot): Observation => ({ time: s.timeSeconds,
  pressure: s.vessel.pressurePa / MMHG, flow: s.vessel.jets.reduce((sum, jet) => sum + jet.flowM3S, 0) * 1e6,
  bloodLoss: s.vessel.expelledVolumeM3 * 1e6, film: s.film.filmVolumeM3 * 1e6,
  attached: s.runoff.attachedVolumeM3 * 1e6,
  airborne: (s.runoff.inFlightVolumeM3 + s.breakup.inFlightVolumeM3) * 1e6,
  collected: s.collector.filmVolumeM3 * 1e6, error: s.coupledVolumeErrorM3 });

export function LiverLab({ navigation }: { navigation: ReactNode }) {
  const host = useRef<HTMLDivElement>(null), engine = useRef<Engine | null>(null);
  const [settings, setSettings] = useState<ModelSettings>(INITIAL), [active, setActive] = useState<ModelSettings>(INITIAL);
  const [revision, setRevision] = useState(0), [ready, setReady] = useState(false), [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"orbit" | "cut">("orbit"), [radiusMM, setRadiusMM] = useState(1.25), [depthMM, setDepthMM] = useState(1);
  const [autoRun, setAutoRun] = useState(true), [speed, setSpeed] = useState(1), [target, setTarget] = useState("");
  const [anatomy, setAnatomy] = useState<LiverAnatomy>(), [wounds, setWounds] = useState<LiverWound[]>([]);
  const [reading, setReading] = useState<Observation>(), [history, setHistory] = useState<Observation[]>([]);
  const [filmDiagnostic, setFilmDiagnostic] = useState<ReturnType<LiverFlowExperiment["diagnostics"]>["film"]>();
  const [notice, setNotice] = useState(""), [error, setError] = useState(""), [hover, setHover] = useState("");
  const [preview, setPreview] = useState<LiverCutPreview | null>(null), hoverPick = useRef<LiverSurfacePick | null>(null);
  const [appearance, setAppearance] = useState<LiverAppearance>({
    illumination: "camera", exposureEV: 0, vesselGuide: true, oxygenationFraction: .75,
  });
  const state = useRef({ running, speed, mode, radiusMM, depthMM, autoRun, appearance });
  state.current = { running, speed, mode, radiusMM, depthMM, autoRun, appearance };
  const interventions = useRef<unknown[]>([]);
  const pending = JSON.stringify(settings) !== JSON.stringify(active);
  const fail = (cause: unknown) => {
    state.current.running = false; readyRef.current = false; setRunning(false); setReady(false);
    setError(cause instanceof Error ? cause.message : String(cause));
    const current = engine.current;
    if (current) {
      current.snapshot = current.model.snapshot();
      setReading(observe(current.snapshot)); setWounds(current.snapshot.wounds);
      setFilmDiagnostic(current.model.diagnostics().film);
    }
  };
  const publish = (current: Engine, append = false) => {
    const row = observe(current.snapshot); setReading(row);
    setFilmDiagnostic(current.model.diagnostics().film);
    if (append) setHistory(previous => [...previous.filter(p => p.time < row.time), row].slice(-300));
  };
  const cut = (pick: LiverSurfacePick) => {
    const current = engine.current;
    if (!current || !readyRef.current) return;
    let committed = false;
    try {
      const previous = current.snapshot.wounds;
      const result = prepareLiverCut(current.anatomy, previous, { pick,
        radiusM: state.current.radiusMM / 1000, depthM: state.current.depthMM / 1000,
        timeSeconds: current.snapshot.timeSeconds });
      if (!result.accepted || !result.wound) { setNotice(result.reason ?? "This location cannot be cut."); return; }
      const next = [...previous, result.wound];
      // Prepare graphics first; a failed model intervention restores its geometry.
      try { current.view.setWounds(next); }
      catch (cause) {
        // A renderer intervention can fail after changing GPU resources.
        // Stop before any physical commit; its last accepted state remains
        // exportable even when the displayed geometry cannot be trusted.
        fail(cause); return;
      }
      try { current.model.setWounds(next); }
      catch (cause) {
        try { current.view.setWounds(previous); current.view.update(current.snapshot); current.view.render(); }
        catch (restoreError) { fail(restoreError); }
        throw cause;
      }
      committed = true; current.snapshot = current.model.snapshot();
      hoverPick.current = null; setPreview(null); setHover("");
      setWounds(current.snapshot.wounds); interventions.current.push({ action: "cut", outcome: result.outcome, wound: result.wound });
      publish(current, true);
      current.view.update(current.snapshot); current.view.render();
      if (result.outcome === "vessel-hit") {
        setNotice(state.current.autoRun ? "Vessel opened. Bleeding is running." : "Vessel opened. Press Run to observe bleeding.");
        if (state.current.autoRun) { state.current.running = true; setRunning(true); }
      } else setNotice("Surface incision created. No vessel was reached at this depth; tissue oozing is not modeled.");
    } catch (cause) {
      if (committed) fail(cause);
      else setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const cutRef = useRef(cut); cutRef.current = cut;
  const readyRef = useRef(ready); readyRef.current = ready;
  /** Hover-time prediction only; the committed cut still runs the full geometric checks. */
  const updatePreview = (pick: LiverSurfacePick | null) => {
    hoverPick.current = pick;
    const current = engine.current;
    if (!current || !pick || state.current.mode !== "cut" || !readyRef.current) { setPreview(null); current?.view.setCutPreview(null); return; }
    try {
      const next = previewLiverCut(current.anatomy, current.snapshot.wounds, pick, state.current.radiusMM / 1000, state.current.depthMM / 1000);
      setPreview(next); current.view.setCutPreview(next);
    } catch { setPreview(null); current.view.setCutPreview(null); }
  };
  const previewRef = useRef(updatePreview); previewRef.current = updatePreview;
  /** Removing a wound is only exact before any physical time has run on it. */
  const lastWound = wounds.at(-1);
  const canUndo = ready && !!lastWound && Math.abs((reading?.time ?? 0) - lastWound.timeSeconds) < 1e-12;
  const undo = () => {
    const current = engine.current; if (!current || !readyRef.current) return;
    const previous = current.snapshot.wounds, last = previous.at(-1);
    if (!last) return;
    if (current.snapshot.timeSeconds !== last.timeSeconds) { setNotice("Undo is only possible before bleeding time has run after the cut. Use Clear cuts & reset."); return; }
    state.current.running = false; setRunning(false);
    const next = previous.slice(0, -1);
    try { current.view.setWounds(next); } catch (cause) { fail(cause); return; }
    try { current.model.setWounds(next); }
    catch (cause) {
      try { current.view.setWounds(previous); current.view.update(current.snapshot); current.view.render(); } catch (restoreError) { fail(restoreError); return; }
      setNotice(cause instanceof Error ? cause.message : String(cause)); return;
    }
    current.snapshot = current.model.snapshot(); setWounds(current.snapshot.wounds);
    interventions.current.push({ action: "undo-cut", wound: last.id });
    publish(current, true); current.view.update(current.snapshot); current.view.render();
    setNotice("Last incision undone.");
  };
  const undoRef = useRef(undo); undoRef.current = undo;
  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false, raf = 0, current: Engine | null = null, last = performance.now(), accumulator = 0, lastPublish = 0;
    setReady(false); readyRef.current = false; setError(""); setNotice(""); setHover(""); setPreview(null); hoverPick.current = null;
    setWounds([]); setHistory([]); setReading(undefined); setFilmDiagnostic(undefined); interventions.current = [];
    void loadLiverAnatomy(abort.signal).then(data => {
      if (cancelled) return;
      // Drainage stays on the shipped default (alignment 0): retaining film on
      // overhangs lets it pool without bound until the solver rejects steps.
      const model = new LiverFlowExperiment(data, { ...active, maxFilmSubsteps: 256 });
      const view = new LiverRenderer(host.current!, { anatomy: data,
        onSurfacePick: pick => { if (!cancelled) cutRef.current(pick); },
        onHover: pick => {
          if (cancelled || state.current.mode !== "cut") return;
          // The vessel reach is predicted on hover (cheap capsule tests);
          // exact geometry clipping still occurs once, on commit.
          setHover(pick ? "Surface selected · click or tap to cut at the chosen depth" : "Point at the liver surface.");
          previewRef.current(pick);
        },
        onError: message => { if (!cancelled) fail(message); },
      });
      current = { anatomy: data, model, view, snapshot: model.snapshot() }; engine.current = current;
      view.setAppearance(state.current.appearance); view.setMode(state.current.mode);
      view.setCutSettings({ radiusM: state.current.radiusMM / 1000, depthM: state.current.depthMM / 1000 });
      view.update(current.snapshot); view.render(); setAnatomy(data); setTarget(data.targets[0]?.id ?? "");
      publish(current, true); setReady(true); readyRef.current = true; reportReady("blood-liver");
      const tick = (now: number) => {
        if (cancelled || !current) return;
        try {
          const elapsed = Math.min(.1, Math.max(0, (now - last) / 1000)); last = now;
          let advanced = false;
          if (!document.hidden && state.current.running && readyRef.current) {
            accumulator = Math.min(.25, accumulator + elapsed * state.current.speed);
            const started = performance.now(), dt = current.model.vesselConfig.fixedDtSeconds;
            for (let i = 0; accumulator + 1e-12 >= dt && i < 120; i++) {
              if (i && performance.now() - started > 14) break;
              const result = current.model.step();
              if (!result.accepted) { fail(result.reason ?? "Step rejected. The last accepted state is preserved."); accumulator = 0; break; }
              accumulator -= dt; advanced = true;
            }
          } else accumulator = 0;
          if (advanced) { current.snapshot = current.model.snapshot(); current.view.update(current.snapshot); }
          if (!document.hidden && current.view.needsRender) current.view.render();
          if (advanced && now - lastPublish > 100) { publish(current, true); lastPublish = now; }
          raf = requestAnimationFrame(tick);
        } catch (cause) { fail(cause); }
      };
      raf = requestAnimationFrame(tick);
    }).catch(cause => { if (!cancelled) fail(cause); });
    return () => {
      cancelled = true; abort.abort(); cancelAnimationFrame(raf); readyRef.current = false;
      current?.view.dispose(); if (engine.current === current) engine.current = null;
    };
  }, [active, revision]);
  useEffect(() => {
    engine.current?.view.setMode(mode); setHover("");
    previewRef.current(mode === "cut" ? engine.current?.view.selectedTarget ?? null : null);
  }, [mode]);
  useEffect(() => { engine.current?.view.setAppearance(appearance); }, [appearance]);
  useEffect(() => {
    engine.current?.view.setCutSettings({ radiusM: radiusMM / 1000, depthM: depthMM / 1000 });
    previewRef.current(hoverPick.current);
  }, [radiusMM, depthMM]);
  const stepMM = LIVER_CUT_LIMITS.stepM * 1000;
  const clampMM = (value: number, min: number, max: number) => Math.round(Math.min(max * 1000, Math.max(min * 1000, value)) / stepMM) * stepMM;
  const applySuggestedDepth = () => { if (preview?.suggestedDepthM) setDepthMM(clampMM(preview.suggestedDepthM * 1000, LIVER_CUT_LIMITS.minDepthM, LIVER_CUT_LIMITS.maxDepthM)); };
  const shortcuts = useRef({ applySuggestedDepth, pause: () => {}, ready });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !shortcuts.current.ready) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [contenteditable=true]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); undoRef.current(); return; }
      if (event.metaKey || event.ctrlKey) return;
      const depth = (delta: number) => setDepthMM(v => clampMM(v + delta, LIVER_CUT_LIMITS.minDepthM, LIVER_CUT_LIMITS.maxDepthM));
      const radius = (delta: number) => setRadiusMM(v => clampMM(v + delta, LIVER_CUT_LIMITS.minRadiusM, LIVER_CUT_LIMITS.maxRadiusM));
      switch (event.key) {
        case "c": case "C": setMode("cut"); break;
        case "v": case "V": setMode("orbit"); break;
        case "]": depth(stepMM); break;
        case "[": depth(-stepMM); break;
        case "}": radius(stepMM); break;
        case "{": radius(-stepMM); break;
        case "d": case "D": shortcuts.current.applySuggestedDepth(); break;
        case "f": case "F": engine.current?.view.fitLiver(); break;
        case " ":
          if (target?.closest("button, a, summary")) return;
          shortcuts.current.pause(); break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // clampMM/stepMM are constants of the component; handlers read live state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reset = () => {
    if (engine.current?.view.canvas.dataset.sceneRecordingActive === "true") {
      setNotice("Stop the recording before resetting the liver."); return;
    }
    state.current.running = false; setRunning(false); setActive({ ...settings }); setRevision(x => x + 1);
    setAppearance(previous => ({ ...previous, oxygenationFraction: settings.kind === "vein" ? .75 : .98 }));
  };
  const pause = () => {
    const value = !state.current.running; state.current.running = value; setRunning(value);
    if (!value && engine.current) publish(engine.current, true);
  };
  shortcuts.current = { applySuggestedDepth, pause, ready };
  const advance = () => {
    const current = engine.current; if (!current || !ready || state.current.running) return;
    try {
      const count = Math.round(.01 / current.model.vesselConfig.fixedDtSeconds);
      for (let i = 0; i < count; i++) {
        const result = current.model.step(); if (!result.accepted) throw new Error(result.reason);
      }
      current.snapshot = current.model.snapshot(); current.view.update(current.snapshot); current.view.render(); publish(current, true);
    } catch (cause) { fail(cause); }
  };
  const exportEvidence = () => {
    const current = engine.current; if (!current) return;
    state.current.running = false; setRunning(false);
    current.snapshot = current.model.snapshot(); publish(current, true);
    let executionError = error || null;
    try { current.view.update(current.snapshot); current.view.render(); }
    catch (cause) { executionError = cause instanceof Error ? cause.message : String(cause); fail(cause); }
    const body = { schema: "viscera.liver-bleeding.evidence/v1", createdAt: new Date().toISOString(),
      anatomy: current.anatomy.provenance, settings: active, cutSettings: { radiusMM, depthMM },
      appearance, execution: { phase: executionError ? "halted" : "paused", error: executionError, acceptedTimeSeconds: current.snapshot.timeSeconds },
      config: current.model.vesselConfig, snapshot: current.snapshot, diagnostics: current.model.diagnostics(),
      renderer: current.view.visualState, interventions: interventions.current,
      targets: current.anatomy.targets, observationHistory: [...history.filter(p => p.time < current.snapshot.timeSeconds), observe(current.snapshot)],
      limitations: "Procedural vessels on a reference liver; reduced cardiovascular and surface-film model. No patient vasculature, tissue tearing, coagulation, clinical validation or resolved wound-cavity fluid dynamics." };
    const encoded = JSON.stringify(body, (_key, value) => ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value, 2);
    const url = URL.createObjectURL(new Blob([encoded], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `liver-bleeding-${current.snapshot.stepIndex}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const selectTarget = (id: string) => { setTarget(id); engine.current?.view.focusTarget(id); };
  const cutSelected = () => {
    const pick = anatomy?.targets.find(item => item.id === target)?.pick;
    if (pick) cut(pick);
  };
  const loss = reading?.bloodLoss ?? 0;
  const hud = cutHud(preview, depthMM, radiusMM, wounds.length);
  const modelCtx = useBloodModel();
  return <main className="blood-lab liver-lab">
    <header className="blood-header">
      <a href="?" className="blood-back"><ArrowLeft size={16} /> Anatomy studio</a>
      <div className="blood-wordmark"><Droplets size={22} /><span>VISCERA <strong>Liver bleeding</strong></span><span className="blood-badge">Research preview</span></div>
      <div className="blood-actions"><DisplaySettings /><VideoRecorderButton /></div>
    </header>
    {navigation}
    <div className="blood-heading liver-heading"><div><p className="blood-kicker">INTERACTIVE ORGAN EXPERIMENT</p>
      <h1>Liver bleeding experiment.</h1><p>Explore a reference liver, open a surface vessel, and follow blood across its curved surface.</p></div>
      <div className="liver-source-note">Human reference geometry<span>Procedural vessels · experimental physiology</span></div></div>
    <div className="liver-workspace">
      <div className="liver-scene-column">
        <div className="liver-toolstrip" role="group" aria-label="Liver interaction tools">
          <button aria-pressed={mode === "orbit"} onClick={() => setMode("orbit")}><Hand size={17} /> Rotate</button>
          <button aria-pressed={mode === "cut"} disabled={!ready} onClick={() => setMode("cut")}><Scissors size={17} /> Cut</button>
          <button disabled={!ready} onClick={() => engine.current?.view.fitLiver()}>Fit liver</button>
          <button disabled={!canUndo} onClick={undo} title={canUndo ? "Undo the last incision (Ctrl/⌘ Z)" : "Available before bleeding time runs after a cut"}><Undo2 size={16} /> Undo cut</button>
          <span>{mode === "cut" ? "Click or tap once to cut · dragging never cuts · right-drag rotates · scroll zooms" : "Drag to rotate · pinch or scroll to zoom · press C to cut"}</span>
        </div>
        <section className="blood-stage liver-stage" aria-label="Liver bleeding scene">
          <div ref={host} className="liver-canvas-host" />
          {mode === "cut" && ready && !error && <div className={`liver-cut-hud is-${preview?.status ?? "idle"}`} data-testid="liver-cut-preview" data-status={preview?.status ?? "idle"} aria-live="polite">
            <span className="liver-cut-hud-dot" aria-hidden="true" />
            <div><strong>{hud.title}</strong><span>{hud.detail}</span>
              {preview?.status === "deeper" && preview.suggestedDepthM && <button type="button" onClick={applySuggestedDepth}>Set depth to {(preview.suggestedDepthM * 1000).toFixed(2)} mm <kbd>D</kbd></button>}
              {hud.predicted && <small>Predicted from vessel geometry · surface checks run when you cut</small>}</div>
          </div>}
          {!ready && !error && <div className="blood-overlay" role="status">Preparing liver and circulation…</div>}
          {error && <div className="blood-overlay blood-error" role="alert"><strong>Experiment paused</strong><p>{error}</p><button onClick={reset}>Reset liver</button></div>}
          <div className="liver-stage-caption">{mode === "cut" ? hover || "Point at a vessel, then click or tap." : "Reference liver · real dimensions"}
            {appearance.vesselGuide && <span>Procedural vessel guide</span>}</div>
          <SceneResizeHandle />
        </section>
        <div className="liver-runbar">
          <button className="blood-primary" disabled={!ready} onClick={pause}>{running ? <Pause size={16} /> : <Play size={16} />}{running ? "Pause bleeding" : "Run bleeding"}</button>
          <button disabled={!ready || running} onClick={advance}>Advance 10 ms</button>
          <span><strong data-testid="liver-time">{(reading?.time ?? 0).toFixed(3)} s</strong> physical time</span>
          <label>Playback<select aria-label="Liver playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={4}>4×</option><option value={2}>2×</option><option value={1}>1×</option><option value={.25}>¼×</option></select></label>
        </div>
        <p className="liver-feedback" role="status">{notice || (mode === "cut" ? "Cut depth determines whether a vessel is reached. Up to three separate incisions." : "Choose Cut to open a vessel, or select a target using the controls.")}</p>
        <div className="liver-readings" aria-label="Bleeding measurements">
          <div><span>Blood loss</span><strong data-testid="liver-loss">{loss.toFixed(3)} <small>mL</small></strong></div>
          <div><span>Surface blood</span><strong>{(reading?.film ?? 0).toFixed(3)} <small>mL</small></strong></div>
          <div><span>Wound outflow</span><strong>{(reading?.flow ?? 0).toFixed(3)} <small>mL/s</small></strong></div>
          <div><span>Local pressure</span><strong>{(reading?.pressure ?? 0).toFixed(1)} <small>mmHg</small></strong></div>
        </div>
        <div className="liver-phase-readings" aria-label="Runoff measurements">
          <span>Attached drops <strong>{(reading?.attached ?? 0).toFixed(3)} mL</strong></span>
          <span>Falling blood <strong>{(reading?.airborne ?? 0).toFixed(3)} mL</strong></span>
          <span>Collected blood <strong data-testid="liver-collected">{(reading?.collected ?? 0).toFixed(3)} mL</strong></span>
          {modelCtx && <button type="button" className="liver-pool-jump" onClick={() => modelCtx.choose("pool")}>Open collected tray in Blood pool (webgpu-water) →</button>}
        </div>
        <p className="liver-model-status" data-testid="liver-model-status">
          {filmDiagnostic?.validity.status === "outside-creeping-thin-film-indicators"
            ? "Flow exceeds the reduced model’s low-inertia or small-slope indicators."
            : "Surface flow uses an uncalibrated viscous-film approximation."}
          {filmDiagnostic && <span>Peak estimated Reynolds number {filmDiagnostic.telemetry.maximumFilmReynolds.toFixed(2)} · maximum film slope {filmDiagnostic.slope.maximumSurfaceSlope.toFixed(3)}. Engineering diagnostics, not clinical thresholds.</span>}
        </p>
        <PressureTrace history={history} />
      </div>
      <aside className="blood-controls liver-controls" aria-label="Liver experiment controls">
        <BloodFluidModelControl />
        <section><h2>Make an incision</h2>
          <p className="blood-muted">Cut through the capsule into a vessel. A shallow or misplaced cut will not produce vessel bleeding.</p>
          <label>Cut radius <output>{radiusMM.toFixed(2)} mm</output><input aria-label="Cut radius" type="range" min=".75" max="2" step=".25" value={radiusMM} onChange={e => setRadiusMM(Number(e.target.value))} /></label>
          <label>Cut depth <output>{depthMM.toFixed(2)} mm</output><input aria-label="Cut depth" type="range" min=".25" max="2" step=".25" value={depthMM} onChange={e => setDepthMM(Number(e.target.value))} /></label>
          <label className="liver-check"><input type="checkbox" checked={autoRun} onChange={e => setAutoRun(e.target.checked)} />Run automatically after a vessel cut</label>
          <label>Vessel target<select aria-label="Vessel target" disabled={!ready} value={target} onChange={e => selectTarget(e.target.value)}>
            {anatomy?.targets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
          <div className="liver-target-actions"><button disabled={!ready || !target} onClick={() => selectTarget(target)}>Show target</button>
            <button disabled={!ready || !target || wounds.length >= 3} onClick={cutSelected}><Scissors size={15} />Cut selected vessel</button></div>
          <p className="blood-muted" data-testid="liver-wounds">{wounds.length} / 3 incisions · {wounds.filter(w => w.vesselId).length} vessel hits</p>
          <ul className="liver-cut-legend" aria-label="Cut marker colours">
            <li className="is-vessel">Reaches a vessel</li><li className="is-deeper">Vessel below · cut deeper</li>
            <li className="is-tissue">Tissue only</li><li className="is-blocked">Overlap or limit</li>
          </ul>
          <details className="liver-shortcuts"><summary>Keyboard shortcuts</summary>
            <dl><div><dt><kbd>C</kbd> / <kbd>V</kbd></dt><dd>Cut / rotate tool</dd></div><div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Cut depth −/+ 0.25 mm</dd></div>
              <div><dt><kbd>{"{"}</kbd> <kbd>{"}"}</kbd></dt><dd>Cut radius −/+ 0.25 mm</dd></div><div><dt><kbd>D</kbd></dt><dd>Use the suggested depth</dd></div>
              <div><dt><kbd>Space</kbd></dt><dd>Run / pause bleeding</dd></div><div><dt><kbd>F</kbd></dt><dd>Fit liver</dd></div>
              <div><dt><kbd>Ctrl/⌘ Z</kbd></dt><dd>Undo cut before time runs</dd></div><div><dt>Right-drag · scroll</dt><dd>Rotate · zoom while cutting</dd></div>
              <div><dt>Arrows · + − · Home</dt><dd>Orbit · zoom · reset (scene focused)</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Cancel a press</dd></div></dl>
          </details>
        </section>
        <section><h2>Circulation</h2>
          <label>Vessel model<select aria-label="Liver vessel model" value={settings.kind} onChange={e => setSettings(s => ({ ...s, kind: e.target.value as ModelSettings["kind"] }))}>
            <option value="vein">Venous branch · low pressure</option><option value="artery">Arterial branch · pulsatile comparison</option></select></label>
          <label>Heart rate <output>{settings.heartRateBpm} beats/min</output><input aria-label="Liver heart rate" type="range" min="45" max="140" step="1" value={settings.heartRateBpm} onChange={e => setSettings(s => ({ ...s, heartRateBpm: Number(e.target.value) }))} /></label>
          <label>Dynamic viscosity<select aria-label="Liver blood viscosity" value={settings.viscosityPaS} onChange={e => setSettings(s => ({ ...s, viscosityPaS: Number(e.target.value) }))}>
            <option value={.00345}>3.45 mPa·s · reference</option><option value={.01}>10 mPa·s · comparison</option><option value={.03}>30 mPa·s · comparison</option></select></label>
          <label>Surface flow mobility<select aria-label="Surface flow mobility" value={settings.mobilityScale} onChange={e => setSettings(s => ({ ...s, mobilityScale: Number(e.target.value) }))}>
            <option value={3}>3× · brisk rivulet (default)</option><option value={1}>1× · uncompensated mesh</option></select></label>
          {pending && <p className="liver-pending" role="status">Circulation changes are pending. Apply & reset to use them.</p>}
          <button className="liver-reset" onClick={reset}><RotateCcw size={16} />{pending ? "Apply & reset liver" : "Clear cuts & reset"}</button>
          <p className="blood-muted">Reset clears all cuts and spilled blood. The venous branch is a circulation surrogate, not a patient-specific portal system.</p>
        </section>
        <section><h2>View</h2>
          <label className="liver-check"><input type="checkbox" checked={appearance.vesselGuide} onChange={e => setAppearance(a => ({ ...a, vesselGuide: e.target.checked }))} />Show vessel guide</label>
          <label>Lighting<select aria-label="Liver lighting" value={appearance.illumination} onChange={e => setAppearance(a => ({ ...a, illumination: e.target.value as LiverAppearance["illumination"] }))}><option value="camera">Camera light</option><option value="operating">Operating light</option><option value="studio">Studio light</option></select></label>
          {appearance.illumination === "operating" && <p className="blood-muted">A broad light stays above the selected site while you rotate the camera. Show another target to aim it there.</p>}
          <label>Exposure <output>{appearance.exposureEV > 0 ? "+" : ""}{appearance.exposureEV.toFixed(1)} EV</output><input aria-label="Liver exposure" type="range" min="-2" max="2" step=".25" value={appearance.exposureEV} onChange={e => setAppearance(a => ({ ...a, exposureEV: Number(e.target.value) }))} /></label>
          <button className="blood-export" disabled={!reading} onClick={exportEvidence}><Download size={16} />Export experiment evidence</button>
        </section>
      </aside>
    </div>
    <details className="liver-model-notes"><summary>Model, anatomy and limitations</summary>
      <p>The liver uses existing HRA reference geometry. The overlaid vessel network is generated by the library; it is not measured patient vasculature. Cut radius and depth define a circular capsule incision, not a full surgical resection.</p>
      <p>Pressure comes from the coupled cardiovascular model. Surface blood follows a conservative reduced film model on the curved mesh. Wound-cavity flow, parenchymal oozing, wall deformation, coagulation and surgical realism are not validated.</p>
      <p>The surface model assumes viscous flow: impact energy is dissipated rather than producing a resolved splash. Low-speed outflow attaches at the downhill wound edge. Underside blood transfers into fixed supports, falls under gravity, and collects in an initially dry tray. Falling drops can merge; contact with an attached drop returns the incoming blood to the surface. Other regions retain blood on the surface. These attachment and release rules are approximations, not measured liver wetting behaviour.</p>
      <p>Rendering does not advance the physics. Fixed simulation steps can run slower than wall time on a busy device. Video resolution and encoded frame rate are separate from physical simulation time.</p>
      <p>The operating light is an authored 40 × 30 cm panel. Its reflections respond to the wet surface, but occlusion shadows from this panel and secondary tissue reflections are not resolved.</p>
      {anatomy && <p>{anatomy.provenance.label} · {anatomy.provenance.license} · <a href={anatomy.provenance.source} target="_blank" rel="noreferrer">Anatomy source</a></p>}
      {anatomy?.provenance.attribution && <p>{anatomy.provenance.attribution}</p>}
    </details>
  </main>;
}

function PressureTrace({ history }: { history: Observation[] }) {
  const end = Math.max(1, history.at(-1)?.time ?? 0), high = Math.max(1, ...history.map(p => p.pressure)) * 1.1;
  const points = history.map(p => `${44 + p.time / end * 650},${112 - Math.max(0, p.pressure) / high * 85}`).join(" ");
  return <figure className="liver-trace"><figcaption>Local vessel pressure <span>mmHg · accepted simulation time</span></figcaption>
    <svg viewBox="0 0 720 145" role="img" aria-label={`Vessel pressure history. Latest ${(history.at(-1)?.pressure ?? 0).toFixed(1)} millimetres of mercury.`}>
      <path d="M44 18V112H695" stroke="#cbd3df" fill="none" /><polyline points={points} stroke="#9e344d" strokeWidth="2" fill="none" />
      <text x="2" y="28">{high.toFixed(0)}</text><text x="18" y="116">0</text><text x="44" y="136">0 s</text><text x="648" y="136">{end.toFixed(1)} s</text>
    </svg></figure>;
}

/** Wording for the in-scene cut preview card. */
function cutHud(preview: LiverCutPreview | null, depthMM: number, radiusMM: number, count: number): { title: string; detail: string; predicted: boolean } {
  const settings = `Depth ${depthMM.toFixed(2)} mm · radius ${radiusMM.toFixed(2)} mm`;
  if (count >= 3) return { title: "Three incisions made", detail: "Clear cuts & reset to start again.", predicted: false };
  if (!preview) return { title: "Point at the liver surface", detail: `${settings} · the ring shows the cut size`, predicted: false };
  switch (preview.status) {
    case "vessel": return { title: "Vessel reached · click to cut", detail: `${settings} · opening ≈ ${(preview.apertureRadiusM * 2000).toFixed(2)} mm wide`, predicted: true };
    case "deeper": return { title: "Vessel below · cut is too shallow", detail: `Reaches it from ${((preview.minimumDepthM ?? 0) * 1000).toFixed(2)} mm. Current depth ${depthMM.toFixed(2)} mm.`, predicted: true };
    case "tissue": return { title: "Tissue only · no vessel in reach", detail: preview.nearestVesselOffsetM !== null ? `Nearest vessel ${(preview.nearestVesselOffsetM * 1000).toFixed(1)} mm to the side. Tissue oozing is not modelled.` : "No surface vessel faces this side.", predicted: true };
    case "blocked": return { title: "Cannot cut here", detail: preview.reason ?? "", predicted: false };
  }
}
