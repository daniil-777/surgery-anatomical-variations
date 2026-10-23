import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Download, Droplets, Pause, Play, RotateCcw, CirclePlus } from "lucide-react";
import { DisplaySettings, SceneResizeHandle } from "../../DisplaySettings";
import { VideoRecorderButton } from "../../VideoRecorderPanel";
import { BLOOD_APPEARANCE_PROVENANCE } from "./bloodAppearanceOptics";
import { EXPERIMENTS, evidenceJSON, experimentById, type ExperimentId } from "./catalogue";
import { TankSolver, type TankSnapshot, type TankTelemetry } from "./tankSolver";
import { createVesselPreset, type VesselSnapshot } from "./vesselSolver";
import { VesselFlowExperiment, createCardiovascularVesselPreset, type VesselFlowSnapshot } from "./vesselFlow";
import { TankRenderer, VesselRenderer } from "./renderer";
import { vesselApertures, vesselFrame, type ApertureSpec, type VesselGeometryConfig } from "./geometry";
import { BloodFluidModelControl } from "../BloodModelSelector";
import "../artery/artery.css";
import "./experiments.css";

const MMHG = 133.322387415;
interface Settings {
  viscosity: number; shape: "sphere" | "cube"; dropHeightMM: number; bodyDensity: number;
  holeRadiusMM: number; pressureMMHg: number; playback: number;
  surfaceTensionNM: number; initialRelativeAmplitude: number;
  perfusion: "cardiovascular" | "laboratory";
  heartRateBpm: number; systemicResistanceScale: number; contractilityScale: number; totalBloodL: number;
}
interface Appearance {
  illumination: "studio" | "camera"; exposureEV: number; referencePatch: boolean; wallDetail: boolean; oxygenationFraction: number;
}
const defaultAppearance = (id: ExperimentId): Appearance => ({
  illumination: "camera", exposureEV: 0, referencePatch: false, wallDetail: true,
  oxygenationFraction: id === "vein-puncture" ? .75 : .98,
});
const defaults = (id: ExperimentId): Settings => ({
  viscosity: .00345, shape: "sphere", dropHeightMM: .5, bodyDensity: 750,
  holeRadiusMM: .4, pressureMMHg: id === "vein-puncture" ? 10 : 100, playback: 1,
  surfaceTensionNM: .055, initialRelativeAmplitude: .01,
  perfusion: "cardiovascular", heartRateBpm: 72, systemicResistanceScale: 1, contractilityScale: 1, totalBloodL: 5,
});
interface Reading {
  time: number; volumeError: number; volumeML: number; signal: number;
  secondary: number; metricLabel: string; metricUnit: string; secondaryLabel: string; secondaryUnit: string;
  drops?: number; filmPeakMM?: number; depositedML?: number; escapedML?: number; unresolvedDrippingML?: number;
  arterialPressureMMHg?: number; venousPressureMMHg?: number; circulatingML?: number; bloodLossML?: number;
  steepFrontWarning?: boolean;
}
interface Adapter {
  kind: "tank" | "vessel"; dt: number; config: unknown;
  view: TankRenderer | VesselRenderer;
  step(): { accepted: boolean; reason?: string };
  snapshot(): TankSnapshot | VesselSnapshot;
  reading(): Reading;
  update(): void;
  drop(): void;
  holes(ids: number[]): void;
  diagnostics(): unknown;
}
interface Trial extends Reading {
  name: string; experiment: ExperimentId; viscosity: number; pressureMMHg: number; holeRadiusMM: number; openHoles: number;
  shape: Settings["shape"]; dropHeightMM: number; bodyDensity: number;
  appearance: Appearance;
  openHoleIndices: number[]; bodyReleased: boolean; interventions: Intervention[];
  surfaceTensionNM: number; initialRelativeAmplitude: number;
  perfusion: Settings["perfusion"]; heartRateBpm: number; systemicResistanceScale: number; contractilityScale: number; totalBloodL: number;
}
type Intervention = { timeSeconds: number; action: "release-body" }
  | { timeSeconds: number; action: "set-punctures"; openHoleIndices: number[] };

function vesselGeometry(radiusM: number, holes: readonly ApertureSpec[] = []): VesselGeometryConfig {
  return { innerRadiusM: radiusM, wallThicknessM: .00065, holes, centrelineM: [
    [-.03, .025, 0], [-.015, .028, .002], [0, .026, .003], [.015, .023, .001], [.03, .025, 0],
  ] };
}
function apertureAt(index: number, radiusM: number, geometry: VesselGeometryConfig): ApertureSpec {
  const arcFraction = [.32, .5, .68][index]!, frame = vesselFrame(geometry);
  const n = frame.point(arcFraction, 0, 0).radial, b = frame.point(arcFraction, Math.PI / 2, 0).radial;
  // Side-facing punctures point slightly downward into the nearby catch tray.
  // This keeps the true ballistic trajectory in view without rescaling it.
  const angleRad = Math.atan2(-.3 * b.y + .95 * b.z, -.3 * n.y + .95 * n.z);
  return { id: `puncture-${index + 1}`, arcFraction, angleRad, radiusM };
}

function makeAdapter(id: ExperimentId, settings: Settings, host: HTMLElement, onError: (message: string) => void): Adapter {
  if (id.startsWith("tank-")) {
    const solver = new TankSolver({ viscosityPaS: settings.viscosity,
      initialWaveAmplitudeM: id === "tank-wave" ? .0005 : 0 });
    const view = new TankRenderer(host, { ...solver.config, onError });
    let latest = solver.snapshot(), diagnostic: TankTelemetry | null = null;
    const initialVolume = latest.fluidVolumeM3;
    return {
      kind: "tank", dt: solver.config.dtSeconds, config: solver.config, view,
      step() { const result = solver.step(); latest = result.snapshot; diagnostic = result.telemetry; return result; },
      snapshot: () => solver.snapshot(),
      reading: () => ({ time: latest.timeSeconds, volumeError: latest.fluidVolumeM3 / initialVolume - 1,
        volumeML: latest.fluidVolumeM3 * 1e6,
        signal: (Math.max(...latest.heightM) - Math.min(...latest.heightM)) * 1000,
        secondary: latest.totalEnergyJ * 1000, metricLabel: "Surface peak-to-trough", metricUnit: "mm",
        secondaryLabel: "Mechanical energy", secondaryUnit: "mJ" }),
      update() { latest = solver.snapshot(); view.update(latest); },
      drop() {
        const result = solver.drop({ shape: settings.shape,
          ...(settings.shape === "sphere" ? { radiusM: .004 } : { sizeM: .008 }),
          xM: .075, zM: .075, dropHeightM: settings.dropHeightMM / 1000, densityKgM3: settings.bodyDensity });
        if (!result.accepted) throw new Error(result.reason ?? "Object could not be released");
        latest = solver.snapshot(); view.update(latest);
      },
      holes() { throw new Error("Select a vessel experiment to create punctures"); },
      diagnostics: () => diagnostic,
    };
  }
  const geometry = vesselGeometry(.003), geometryFrame = vesselFrame(geometry);
  const preset = settings.perfusion === "cardiovascular" ? createCardiovascularVesselPreset : createVesselPreset;
  const config = preset(id === "vein-puncture" ? "vein" : "artery", {
    viscosityPaS: settings.viscosity, sourcePressureMeanPa: settings.pressureMMHg * MMHG,
    innerRadiusM: geometry.innerRadiusM, lengthM: geometryFrame.lengthM,
    pressureReferencePositionM: geometryFrame.curve.getPointAt(.5).toArray() as [number, number, number],
  });
  const solver = new VesselFlowExperiment(config, {
    surfaceTensionNM: settings.surfaceTensionNM, initialRelativeAmplitude: settings.initialRelativeAmplitude,
    ...(settings.perfusion === "cardiovascular" ? { cardiovascular: {
      heartRateBpm: settings.heartRateBpm, systemicResistanceScale: settings.systemicResistanceScale,
      contractilityScale: settings.contractilityScale, totalBloodVolumeM3: settings.totalBloodL * .001,
    } } : {}),
  });
  const view = new VesselRenderer(host, { ...geometry, collectionPlaneYM: config.collectionPlaneYM,
    collectionWidthM: solver.collectorConfig.widthM, collectionDepthM: solver.collectorConfig.depthM,
    collectionOriginXM: solver.collectorConfig.originXM, collectionOriginZM: solver.collectorConfig.originZM,
    viewExtentM: .11, onError });
  let latest = solver.snapshot();
  const initialInventory = solver.initialInventoryM3;
  const update = () => {
    latest = solver.snapshot();
    view.update({ ...latest, emissionStepSeconds: config.fixedDtSeconds,
      collector: { ...solver.collectorConfig, heightM: latest.collector.heightM } });
  };
  return {
    kind: "vessel", dt: config.fixedDtSeconds,
    config: { ...solver.vesselConfig, surfaceTensionNM: settings.surfaceTensionNM,
      initialRelativeAmplitude: settings.initialRelativeAmplitude, collector: solver.collectorConfig,
      cardiovascular: solver.cardiovascularConfig, initialCombinedInventoryM3: solver.initialInventoryM3 }, view,
    step() {
      try { return solver.step(); }
      catch (cause) { return { accepted: false, reason: cause instanceof Error ? cause.message : String(cause) }; }
    },
    snapshot: () => solver.snapshot(),
    reading: () => vesselReading(latest, initialInventory),
    update,
    drop() { throw new Error("Select the object impact experiment to drop an object"); },
    holes(ids) {
      const holes = ids.map(index => apertureAt(index, settings.holeRadiusMM / 1000, geometry));
      const apertures = vesselApertures({ ...geometry, holes });
      // Construct the display geometry before accepting the solver intervention,
      // so a graphics allocation failure cannot silently change physical holes.
      view.setHoles(holes); solver.setHoles(apertures);
      update();
    },
    diagnostics: () => solver.diagnostics(),
  };
}

function vesselReading(state: VesselFlowSnapshot, initialInventory: number): Reading {
  return { time: state.timeSeconds, volumeError: state.coupledVolumeErrorM3 / initialInventory,
    volumeML: state.vesselVolumeM3 * 1e6, signal: state.jets.reduce((sum, jet) => sum + jet.flowM3S, 0) * 1e6,
    secondary: state.pressurePa / MMHG, metricLabel: "Total puncture outflow", metricUnit: "mL/s",
      secondaryLabel: "Vessel pressure", secondaryUnit: "mmHg",
    drops: state.breakup.droplets.length, filmPeakMM: Math.max(...state.collector.heightM) * 1000,
    depositedML: state.collector.depositedVolumeM3 * 1e6, escapedML: state.collector.escapedVolumeM3 * 1e6,
    unresolvedDrippingML: state.breakup.lowWeberVolumeM3 * 1e6,
    steepFrontWarning: state.collector.steepFrontWarning,
    ...(state.cardiovascular ? {
      arterialPressureMMHg: state.cardiovascular.pressuresPa.systemicArtery / MMHG,
      venousPressureMMHg: state.cardiovascular.pressuresPa.systemicVein / MMHG,
      circulatingML: (state.cardiovascular.circulatingVolumeM3 + state.vesselVolumeM3) * 1e6,
      bloodLossML: state.expelledVolumeM3 * 1e6,
    } : {}) };
}

function Trace({ history, label, unit, field = "signal" }: { history: Reading[]; label: string; unit: string; field?: "signal" | "arterialPressureMMHg" }) {
  const end = Math.max(1, history.at(-1)?.time ?? 0), maximum = Math.max(.001, ...history.map(row => row[field] ?? 0)) * 1.1;
  const points = history.map(row => `${48 + row.time / end * 470},${160 - (row[field] ?? 0) / maximum * 120}`).join(" ");
  return <figure className="artery-plot">
    <figcaption>{label} · {unit}</figcaption>
    <svg viewBox="0 0 560 200" role="img" aria-label={`${label} over accepted physical time. Latest ${history.at(-1)?.[field]?.toFixed(3) ?? "0"} ${unit}.`}>
      <path d="M48 30V160H520" stroke="#bdc8d2" fill="none" />
      <polyline points={points} stroke="#922c46" fill="none" strokeWidth="2.5" />
      <text x="4" y="35">{maximum.toPrecision(3)}</text><text x="20" y="164">0</text>
      <text x="48" y="186">0 s</text><text x="460" y="186">{end.toFixed(2)} s</text>
    </svg>
  </figure>;
}

export function ExperimentLab({ navigation }: { navigation: ReactNode }) {
  const [experiment, setExperiment] = useState<ExperimentId>(() => experimentById(new URLSearchParams(location.search).get("experiment")).id);
  const [settings, setSettings] = useState(() => defaults(experiment)), [active, setActive] = useState(settings);
  const [appearance, setAppearance] = useState(() => defaultAppearance(experiment));
  const [revision, setRevision] = useState(0), [running, setRunning] = useState(false), [ready, setReady] = useState(false);
  const [reading, setReading] = useState<Reading>(), [history, setHistory] = useState<Reading[]>([]);
  const [trials, setTrials] = useState<Trial[]>([]), [openHoles, setOpenHoles] = useState<number[]>([]);
  const [dropped, setDropped] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const host = useRef<HTMLDivElement>(null), engine = useRef<Adapter | null>(null);
  const interventions = useRef<Intervention[]>([]);
  const live = useRef({ running, playback: settings.playback }); live.current = { running, playback: settings.playback };
  const appearanceRef = useRef(appearance); appearanceRef.current = appearance;
  const current = experimentById(experiment), isTank = current.family === "tank";
  const publish = (adapter: Adapter, append = false) => {
    const row = adapter.reading(); setReading(row);
    if (append) setHistory(previous => [...previous.filter(item => item.time < row.time), row].slice(-300));
  };
  useEffect(() => {
    let adapter: Adapter | undefined, frame = 0, disposed = false, failed = false;
    let previous = performance.now(), accumulator = 0, lastPublish = 0, lastPublishedTime = -1;
    setReady(false); setError(""); setNotice(""); setOpenHoles([]); setDropped(false); setHistory([]);
    interventions.current = [];
    try {
      adapter = makeAdapter(experiment, active, host.current!, message => {
        if (!disposed) { failed = true; live.current.running = false; setRunning(false); setError(message); setReady(false); }
      });
      engine.current = adapter; adapter.view.setAppearance(appearanceRef.current);
      adapter.update(); adapter.view.render(); publish(adapter, true); setReady(true);
      const tick = (now: number) => {
        if (disposed || !adapter) return;
        try {
        const elapsed = Math.max(0, Math.min(.1, (now - previous) / 1000)); previous = now;
        if (!document.hidden && live.current.running && !failed) {
          accumulator = Math.min(.1, accumulator + elapsed * live.current.playback);
          const started = performance.now(); let advanced = false;
          for (let count = 0; accumulator + 1e-12 >= adapter.dt && count < 100; count++) {
            if (count && performance.now() - started > 6) break;
            const result = adapter.step();
            if (!result.accepted) {
              failed = true; live.current.running = false; setRunning(false);
              setError(result.reason ?? "The numerical step was rejected; the last accepted state is preserved.");
              accumulator = 0; break;
            }
            accumulator -= adapter.dt; advanced = true;
          }
          if (advanced) adapter.update();
        } else accumulator = 0;
        if (!document.hidden && adapter.view.needsRender) adapter.view.render();
        const time = adapter.reading().time;
        if (time !== lastPublishedTime && (now - lastPublish > 100 || !live.current.running || failed)) {
          publish(adapter, true); lastPublish = now; lastPublishedTime = time;
        }
        frame = requestAnimationFrame(tick);
        } catch (cause) {
          failed = true; live.current.running = false; setRunning(false);
          publish(adapter, true);
          setError(cause instanceof Error ? cause.message : String(cause));
          // Do not repeatedly schedule a renderer that has failed. Reset owns
          // disposal and recovery; the accepted solver state stays exportable.
        }
      };
      frame = requestAnimationFrame(tick);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    return () => {
      disposed = true; cancelAnimationFrame(frame); adapter?.view.dispose();
      if (engine.current === adapter) engine.current = null;
    };
  }, [experiment, active, revision]);
  useEffect(() => {
    if (!ready || !engine.current) return;
    try { engine.current.view.setAppearance(appearance); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
  }, [appearance, ready]);
  const recording = () => engine.current?.view.canvas.dataset.sceneRecordingActive === "true";
  const pause = () => { live.current.running = false; setRunning(false); if (engine.current) publish(engine.current, true); };
  const choose = (id: ExperimentId) => {
    if (recording()) { setNotice("Stop the recording before changing experiments."); return; }
    pause(); const next = defaults(id); setSettings(next); setActive(next); setExperiment(id);
    setAppearance(defaultAppearance(id));
    const url = new URL(location.href); url.searchParams.set("experiment", id); historyReplace(url);
    setRevision(value => value + 1);
  };
  const reset = () => {
    if (recording()) { setNotice("Stop the recording before applying settings."); return; }
    pause(); setActive({ ...settings }); setRevision(value => value + 1);
  };
  const mutate = (action: (adapter: Adapter) => void) => {
    const adapter = engine.current; if (!adapter || !ready || error) return;
    try { action(adapter); adapter.update(); publish(adapter, true); setNotice(""); }
    catch (cause) {
      live.current.running = false; setRunning(false);
      setError(cause instanceof Error ? cause.message : String(cause));
      // A multi-step command can fail after several accepted steps. Always
      // display those accepted steps, even when its final attempt is rejected.
      try { adapter.update(); publish(adapter, true); }
      catch (renderCause) {
        live.current.running = false; setRunning(false);
        setError(renderCause instanceof Error ? renderCause.message : String(renderCause));
      }
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const exportEvidence = () => {
    const adapter = engine.current; if (!adapter) return; pause();
    const latest = adapter.reading();
    const payload = { schema: "viscera.blood-experiments.evidence/v1", createdAt: new Date().toISOString(),
      experiment, settings: { ...active, playback: settings.playback }, appearance, renderer: adapter.view.visualState,
      config: adapter.config, fixedDtSeconds: adapter.dt, openHoles, bodyReleased: dropped,
      interventions: interventions.current,
      execution: { phase: error ? "halted" : ready ? "paused" : "initializing", error: error || null,
        acceptedTimeSeconds: latest.time, renderedTimeSeconds: adapter.view.visualState.timeSeconds },
      snapshot: adapter.snapshot(), diagnostics: adapter.diagnostics(), reading: latest,
      observationHistory: [...history.filter(row => row.time < latest.time), latest].slice(-300),
      comparisonTrials: trials, optics: BLOOD_APPEARANCE_PROVENANCE,
      scope: isTank ? "Hydrostatic long-wave tank with a regularized, vertically guided body. No 3D splash or breaking waves."
        : "Compliant reservoir, reduced capillary breakup and ballistic flight, with local impacts in a depth-averaged collector. No resolved 3D impact splash, tissue tearing, internal 3D circulation or clotting." };
    const url = URL.createObjectURL(new Blob([evidenceJSON(payload)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `viscera-${experiment}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const pending = JSON.stringify({ ...settings, playback: 1 }) !== JSON.stringify({ ...active, playback: 1 });
  return <main className="blood-lab">
    <header className="blood-header">
      <a href="?" className="blood-back"><ArrowLeft size={16} /> Anatomy studio</a>
      <div className="blood-wordmark"><Droplets size={22} /><span>VISCERA <strong>Blood lab</strong></span><span className="blood-badge">Research preview</span></div>
      <div className="blood-actions"><DisplaySettings /><VideoRecorderButton /></div>
    </header>
    {navigation}
    <div className="blood-heading"><div><p className="blood-kicker">FLUID MECHANICS / EXPERIMENTS</p>
      <h1>Observe. Measure. Compare.</h1><p>Repeatable tank and vessel experiments with physical parameters and exportable evidence.</p></div>
      <div className="blood-model-note"><strong>Realism is a test, not a setting</strong><span>These reduced models expose measurable behaviour. Full 3D splashing, tissue damage and surgical realism remain unvalidated.</span></div></div>
    <nav className="blood-experiment-list" aria-label="Blood experiments">{EXPERIMENTS.map(item =>
      <button key={item.id} aria-label={item.title} aria-pressed={experiment === item.id} onClick={() => choose(item.id)}>
        <span>EXPERIMENT {item.number}</span><strong>{item.title}</strong><small>{item.description}</small>
      </button>)}</nav>
    <p className="blood-experiment-protocol"><strong>{current.title} protocol. </strong>{current.protocol}</p>
    <div className="blood-layout">
      <section className="blood-stage" aria-label="Blood experiment scene">
        <div className="artery-canvas-host" ref={host} />
        <div className="blood-legend">{isTank ? "150 mm cubic enclosure · 12 mm shallow fill · true height"
          : active.perfusion === "cardiovascular" ? "Closed-loop cardiovascular reference · curved vessel · local blood loss"
          : "Curved vessel · actual wall apertures · prescribed laboratory perfusion"}</div>
        {!ready && !error && <div className="blood-overlay" role="status">Preparing experiment…</div>}
        {error && <div className="blood-overlay blood-error" role="alert"><strong>Experiment paused</strong><p>{error}</p><button onClick={reset}>Reset experiment</button></div>}
        <SceneResizeHandle />
      </section>
      <aside className="blood-controls" aria-label="Experiment parameters">
        <BloodFluidModelControl />
        <h2>{current.title}</h2>
        <p className="blood-muted">{pending ? "Parameter changes are pending. Apply & reset to use them." : "Physical parameters apply on reset. Playback and camera can change during a run."}</p>
        <label>Dynamic viscosity<select aria-label="Experiment viscosity" value={settings.viscosity} onChange={e => setSettings(s => ({ ...s, viscosity: Number(e.target.value) }))}>
          <option value={.00345}>3.45 mPa·s · low viscosity</option><option value={.01}>10 mPa·s</option><option value={.03}>30 mPa·s · high viscosity</option>
        </select></label>
        {experiment === "tank-impact" && <>
          <label>Drop object<select aria-label="Drop object" value={settings.shape} onChange={e => setSettings(s => ({ ...s, shape: e.target.value as Settings["shape"] }))}>
            <option value="sphere">Sphere · 8 mm diameter</option><option value="cube">Cube · 8 mm edge</option>
          </select></label>
          <label>Release height<select aria-label="Release height" value={settings.dropHeightMM} onChange={e => setSettings(s => ({ ...s, dropHeightMM: Number(e.target.value) }))}>
            <option value={.25}>0.25 mm above surface</option><option value={.5}>0.5 mm above surface</option><option value={1}>1 mm above surface</option>
          </select></label>
          <label>Object density<select aria-label="Object density" value={settings.bodyDensity} onChange={e => setSettings(s => ({ ...s, bodyDensity: Number(e.target.value) }))}>
            <option value={500}>500 kg/m³ · buoyant</option><option value={750}>750 kg/m³ · buoyant</option><option value={1000}>1,000 kg/m³ · near blood density</option>
          </select></label>
          <button className="blood-export" disabled={!ready || dropped || !!error || pending} onClick={() => mutate(adapter => {
            adapter.drop(); setDropped(true);
            interventions.current.push({ action: "release-body", timeSeconds: adapter.reading().time });
          })}>
            <CirclePlus size={16} />{dropped ? "Object released · reset for another" : "Drop object"}
          </button>
        </>}
        {!isTank && <>
          <label>Circulation driver<select aria-label="Circulation driver" value={settings.perfusion}
            onChange={e => setSettings(s => ({ ...s, perfusion: e.target.value as Settings["perfusion"] }))}>
            <option value="cardiovascular">Cardiovascular circulation · reference</option>
            <option value="laboratory">Laboratory supply · prescribed pressure</option>
          </select></label>
          {settings.perfusion === "cardiovascular" ? <>
            <label>Heart rate<output>{settings.heartRateBpm} beats/min</output>
              <input aria-label="Heart rate" type="range" min={45} max={140} step={1} value={settings.heartRateBpm}
                onChange={e => setSettings(s => ({ ...s, heartRateBpm: Number(e.target.value) }))} /></label>
            <label>Systemic vascular resistance<select aria-label="Systemic vascular resistance" value={settings.systemicResistanceScale}
              onChange={e => setSettings(s => ({ ...s, systemicResistanceScale: Number(e.target.value) }))}>
              <option value={.75}>0.75× reference</option><option value={1}>1× reference</option><option value={1.25}>1.25× reference</option>
            </select></label>
            <label>Ventricular contractility<select aria-label="Ventricular contractility" value={settings.contractilityScale}
              onChange={e => setSettings(s => ({ ...s, contractilityScale: Number(e.target.value) }))}>
              <option value={.75}>0.75× reference</option><option value={1}>1× reference</option><option value={1.25}>1.25× reference</option>
            </select></label>
            <label>Initial circulating blood<select aria-label="Initial circulating blood" value={settings.totalBloodL}
              onChange={e => setSettings(s => ({ ...s, totalBloodL: Number(e.target.value) }))}>
              <option value={4.5}>4.5 L</option><option value={5}>5 L</option><option value={5.5}>5.5 L</option>
            </select></label>
            <p className="blood-muted">Heart contraction and valves generate the pulse. Blood lost from the local vessel leaves this circulation. This reference model has no reflex compensation or patient calibration.</p>
          </> : <label>Mean supply pressure<output>{settings.pressureMMHg} mmHg</output>
            <input aria-label="Mean supply pressure" type="range" min={experiment === "vein-puncture" ? 5 : 60} max={experiment === "vein-puncture" ? 20 : 140} step={5}
              value={settings.pressureMMHg} onChange={e => setSettings(s => ({ ...s, pressureMMHg: Number(e.target.value) }))} />
          </label>}
          <label>Puncture radius<select aria-label="Puncture radius" value={settings.holeRadiusMM} onChange={e => setSettings(s => ({ ...s, holeRadiusMM: Number(e.target.value) }))}>
            <option value={.2}>0.2 mm radius</option><option value={.4}>0.4 mm radius</option><option value={.6}>0.6 mm radius</option>
          </select></label>
          <label>Surface tension<select aria-label="Blood surface tension" value={settings.surfaceTensionNM}
            onChange={e => setSettings(s => ({ ...s, surfaceTensionNM: Number(e.target.value) }))}>
            <option value={.045}>45 mN/m</option><option value={.055}>55 mN/m</option><option value={.065}>65 mN/m</option>
          </select></label>
          <label>Assumed initial jet disturbance<select aria-label="Initial jet disturbance" value={settings.initialRelativeAmplitude}
            onChange={e => setSettings(s => ({ ...s, initialRelativeAmplitude: Number(e.target.value) }))}>
            <option value={.005}>0.5% of jet radius</option><option value={.01}>1% of jet radius</option><option value={.02}>2% of jet radius</option>
          </select></label>
          <p className="blood-muted">These experimental assumptions control capillary breakup and spreading. They are not measurements of a patient or puncture.</p>
          <div className="blood-hole-buttons" role="group" aria-label="Vessel punctures">{[0, 1, 2].map(index =>
            <button key={index} disabled={!ready || !!error || pending} aria-pressed={openHoles.includes(index)}
              onClick={() => mutate(adapter => {
                const next = openHoles.includes(index) ? openHoles.filter(value => value !== index) : [...openHoles, index];
                adapter.holes(next); setOpenHoles(next);
                interventions.current.push({ action: "set-punctures", timeSeconds: adapter.reading().time, openHoleIndices: [...next] });
              })}>{openHoles.includes(index) ? "Occlude" : "Open"} puncture {index + 1}</button>)}</div>
        </>}
        <label>Playback speed<select aria-label="Experiment playback speed" value={settings.playback} onChange={e => setSettings(s => ({ ...s, playback: Number(e.target.value) }))}>
          <option value={.25}>0.25× · inspect motion</option><option value={1}>1× · physical time</option>
        </select></label>
        <div className="blood-run-buttons">
          <button className="blood-primary" disabled={!ready || !!error} onClick={() => {
            if (running) pause(); else { live.current.running = true; setRunning(true); }
          }}>{running ? <Pause size={16} /> : <Play size={16} />}{running ? "Pause experiment" : "Run experiment"}</button>
          <button onClick={reset}><RotateCcw size={16} />Apply & reset</button>
        </div>
        <button className="blood-export blood-step" disabled={!ready || running || !!error} onClick={() => mutate(adapter => {
          for (let i = 0; i < Math.max(1, Math.round(.01 / adapter.dt)); i++) {
            const result = adapter.step();
            if (!result.accepted) {
              const message = result.reason ?? "Step rejected";
              pause(); setError(message); throw new Error(message);
            }
          }
        })}>Advance 10 ms</button>
        <p className="blood-status" role="status">{notice || (running ? "Running · accepted physical time, with fixed numerical steps." : "Paused · orbit the scene or inspect the current state.")}</p>
        <dl className="blood-metrics">
          <div><dt>Accepted physical time</dt><dd data-testid="experiment-time">{(reading?.time ?? 0).toFixed(3)} s</dd></div>
          <div><dt>Relative volume imbalance</dt><dd data-testid="experiment-volume-error">{(reading?.volumeError ?? 0).toExponential(2)}</dd></div>
          <div><dt>{isTank ? "Tank blood volume" : "Vessel blood volume"}</dt><dd>{(reading?.volumeML ?? 0).toFixed(3)} mL</dd></div>
          <div><dt>{reading?.metricLabel}</dt><dd data-testid="experiment-signal">{(reading?.signal ?? 0).toFixed(3)} {reading?.metricUnit}</dd></div>
          <div><dt>{reading?.secondaryLabel}</dt><dd>{(reading?.secondary ?? 0).toFixed(3)} {reading?.secondaryUnit}</dd></div>
          {!isTank && <>
            <div><dt>Detached drops in flight</dt><dd data-testid="experiment-drops">{reading?.drops ?? 0}</dd></div>
            <div><dt>Peak collected film</dt><dd>{(reading?.filmPeakMM ?? 0).toFixed(3)} mm</dd></div>
            <div><dt>Locally deposited blood</dt><dd>{(reading?.depositedML ?? 0).toFixed(3)} mL</dd></div>
            <div><dt>Impacts outside the tray</dt><dd>{(reading?.escapedML ?? 0).toFixed(3)} mL</dd></div>
            {active.perfusion === "cardiovascular" && <>
              <div><dt>Systemic arterial pressure</dt><dd data-testid="experiment-arterial-pressure">{(reading?.arterialPressureMMHg ?? 0).toFixed(2)} mmHg</dd></div>
              <div><dt>Systemic venous pressure</dt><dd>{(reading?.venousPressureMMHg ?? 0).toFixed(2)} mmHg</dd></div>
              <div><dt>Remaining circulating blood</dt><dd>{(reading?.circulatingML ?? 0).toFixed(3)} mL</dd></div>
              <div><dt>Blood lost through punctures</dt><dd>{(reading?.bloodLossML ?? 0).toFixed(3)} mL</dd></div>
            </>}
          </>}
        </dl>
        {!isTank && (reading?.unresolvedDrippingML ?? 0) > 0 && <p className="blood-experiment-warning">
          Some low-speed flow is outside this jet-breakup approximation. Dripping at the wound is unresolved; that fluid remains in the volume ledger.
        </p>}
        {!isTank && reading?.steepFrontWarning && <p className="blood-experiment-warning">
          Steep local front: the capillary geometry is nonlinear, but the depth-averaged impact and bottom-drag accuracy remain approximate.
        </p>}
        <p className="blood-muted">Playback slows if the device cannot keep up. The displayed time and exported state always use accepted physical steps.</p>
        <h2>Light & material</h2>
        <p className="blood-muted">Live appearance controls leave the accepted fluid state unchanged.</p>
        <div className="blood-inspection-buttons" role="group" aria-label="Experiment camera views">
          {(["overview", "detail"] as const).map(view =>
            <button key={view} disabled={!ready || !!error} onClick={() => {
              try { engine.current?.view.setInspectionView(view); }
              catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
            }}>{view === "overview" ? "Scene overview" : "Inspect material"}</button>)}
        </div>
        <p className="blood-muted">Inspect material magnifies the view without changing light power. Drag to orbit; press Home in the scene to return.</p>
        <label>Illumination<select aria-label="Experiment illumination" value={appearance.illumination} onChange={e => setAppearance(a => ({ ...a, illumination: e.target.value as Appearance["illumination"] }))}>
          <option value="camera">Camera light · moving spotlight</option><option value="studio">Studio light · fixed neutral reference</option>
        </select></label>
        <label>Exposure adjustment<output>{appearance.exposureEV > 0 ? "+" : ""}{appearance.exposureEV.toFixed(2)} EV</output>
          <input aria-label="Experiment exposure" type="range" min={-2} max={2} step={.25} value={appearance.exposureEV}
            onChange={e => setAppearance(a => ({ ...a, exposureEV: Number(e.target.value) }))} />
        </label>
        <label>Blood oxygenation reference<select aria-label="Blood oxygenation reference" value={appearance.oxygenationFraction}
          onChange={e => setAppearance(a => ({ ...a, oxygenationFraction: Number(e.target.value) }))}>
          <option value={.98}>98% · highly oxygenated</option><option value={.75}>75% · venous reference</option><option value={.6}>60% · lower oxygenation</option>
        </select></label>
        {!isTank && <label className="artery-checkbox"><input aria-label="Vessel wall microstructure" type="checkbox" checked={appearance.wallDetail}
          onChange={e => setAppearance(a => ({ ...a, wallDetail: e.target.checked }))} />Vessel wall microstructure</label>}
        <label className="artery-checkbox"><input aria-label="Show neutral reference patches" type="checkbox" checked={appearance.referencePatch}
          onChange={e => setAppearance(a => ({ ...a, referencePatch: e.target.checked }))} />Show neutral reference patches</label>
        <p className="blood-muted">Oxygenation changes spectral absorption and scattering at fixed hematocrit. The interpolation, authored wall texture, and light setup are approximations, not a calibrated surgical camera.</p>
        <button className="blood-export" disabled={!engine.current} onClick={exportEvidence}><Download size={16} />Export experiment evidence</button>
        <details className="blood-experiment-model"><summary>Model scope & assumptions</summary><p>{isTank
          ? "A hydrostatic long-wave model with viscosity-dependent bottom drag and a regularized body footprint. Objects move vertically without rotation. There are no overturning waves, entrained air, droplets or contact-line wetting."
          : "A compliant reservoir drives flow through viscous and inertial aperture losses. A reduced capillary-instability model predicts jet necking and detached drops. Actual landing events deposit volume locally into a prewetted, depth-averaged collector. Low-speed wound dripping, satellite drops, impact spray, internal 3D circulation, wall tearing and clotting remain unresolved."}</p>
          {!isTank && <p>Cardiovascular mode couples a small local branch to a six-compartment circulation with time-varying ventricular elastance and four cardiac valves. Initial conditions equilibrate the isolated circuit, then initialize the intact local pressure from its resistances. This is a lumped reference model; pulse-wave propagation, fluid–wall interaction, baroreflexes and patient-specific anatomy are not resolved.</p>}
          <p>Optical transport uses the sourced blood slab model. Lighting and vessel wall appearance have not been calibrated against surgical footage.</p></details>
      </aside>
    </div>
    <div className="artery-analysis">
      <div><Trace history={history} label={reading?.metricLabel ?? "Response"} unit={reading?.metricUnit ?? ""} />
        {!isTank && active.perfusion === "cardiovascular" && <Trace history={history} label="Systemic arterial pressure" unit="mmHg" field="arterialPressureMMHg" />}</div>
      <section><h2>Inspect motion and conservation together</h2>
        <p>{isTank ? "Check that reflected waves remain continuous, objects displace fluid instead of passing through it, and total blood volume stays constant."
          : "Check that jets start at each aperture, form necks and separate drops, and land in localized moving patches. Compare viscosity and surface tension at the same physical time. Expelled, airborne, deposited and escaped fluid stay in one volume ledger."}</p>
        <p>A passing volume check does not establish visual realism. Record the motion, inspect multiple camera angles, and compare trials with the same physical duration.</p>
        <p className="blood-experiment-warning">{isTank ? "Shallow fill is intentional. This experiment cannot establish how a deep pool splashes around an unrestricted 3D object."
          : "The collection tray starts with a specified 20 µm blood film (0.64 mL). Local impact and spreading are reduced models; secondary spray, overturning sheets and tissue absorption are not resolved."}</p>
      </section>
    </div>
    <section className="blood-experiment-trials" aria-label="Experiment comparisons">
      <h2>Compare observations</h2><p>Keep a paused observation, change a parameter, and repeat at the same physical time. Rows are measurements from this session.</p>
      <button className="blood-export" disabled={!ready || running} onClick={() => {
        const row = engine.current?.reading(); if (row) setTrials(previous => [...previous, { ...row, name: current.title,
          experiment, viscosity: active.viscosity, pressureMMHg: active.pressureMMHg, holeRadiusMM: active.holeRadiusMM,
          shape: active.shape, dropHeightMM: active.dropHeightMM, bodyDensity: active.bodyDensity, openHoles: openHoles.length,
          surfaceTensionNM: active.surfaceTensionNM, initialRelativeAmplitude: active.initialRelativeAmplitude,
          perfusion: active.perfusion, heartRateBpm: active.heartRateBpm, systemicResistanceScale: active.systemicResistanceScale,
          contractilityScale: active.contractilityScale, totalBloodL: active.totalBloodL,
          appearance: { ...appearance }, openHoleIndices: [...openHoles], bodyReleased: dropped,
          interventions: interventions.current.map(event => event.action === "set-punctures"
            ? { ...event, openHoleIndices: [...event.openHoleIndices] } : { ...event }) }].slice(-8));
      }}>Keep current observation</button>
      {trials.length > 0 && <><table><thead><tr><th>Experiment</th><th>Time</th><th>Viscosity</th><th>Response</th><th>Volume imbalance</th></tr></thead>
        <tbody>{trials.map((row, index) => <tr key={index}><td>{row.name}{row.name.includes("puncture") && ` · sites ${row.openHoleIndices.map(i => i + 1).join(", ") || "closed"} · r ${row.holeRadiusMM} mm`}
          {row.name.includes("puncture") && (row.perfusion === "cardiovascular" ? ` · circulation ${row.heartRateBpm} bpm · ${row.totalBloodL} L` : ` · supply ${row.pressureMMHg} mmHg`)}
          {row.experiment === "tank-impact" && ` · ${row.shape} · ${row.bodyReleased ? `${row.dropHeightMM} mm drop` : "not released"} · ${row.bodyDensity} kg/m³`}</td>
          <td>{row.time.toFixed(3)} s</td><td>{(row.viscosity * 1000).toFixed(2)} mPa·s</td><td>{row.signal.toFixed(3)} {row.metricUnit}</td><td>{row.volumeError.toExponential(2)}</td></tr>)}</tbody></table>
        <button className="blood-export" onClick={() => setTrials([])}>Clear observations</button></>}
    </section>
    <div className="blood-notes">
      <section><h2>Purpose-built experiments</h2><p>The tank, vessel and thin-film solvers remain separate. They establish different physical limits and do not modify fat or tissue generation.</p>
        <a href="https://matthias-research.github.io/pages/publications/hfFluid.pdf" target="_blank" rel="noreferrer">Read the height-field fluid research ↗</a></section>
      <section><h2>Traceable appearance</h2><p>Blood colour follows the sourced optical model; the synthetic vessel wall is an illustrative structure. Recorded frames are not clinical reference images.</p>
        <a href={BLOOD_APPEARANCE_PROVENANCE.attributionPath} target="_blank" rel="noreferrer">Optical data, model and attribution ↗</a></section>
    </div>
  </main>;
}
function historyReplace(url: URL) { window.history.replaceState(null, "", url); }
