import { apiGet, apiUrl } from "./api";
import { useEffect, useRef, useState } from "react";
import { Activity, ArrowDownToLine, LoaderCircle, Pause, Play, RotateCcw, X } from "lucide-react";
import { atlasError, type AtlasGeneration } from "./atlas";
import { AtlasPhysicsViewport } from "./AtlasPhysicsViewport";
import { AtlasPhysicsPlayground } from "./AtlasPhysicsPlayground";
import { forceMagnitude, physicsParameterFields, readPhysicsObservation, readPhysicsRun, readPhysicsStatus, type PhysicsObservation, type PhysicsParameters, type PhysicsPlayground, type PhysicsProtocol, type PhysicsRun, type PhysicsSource, type PhysicsStatus } from "./atlasPhysics";
import "./atlasPhysics.css";

const protocols: { id: PhysicsProtocol; label: string; description: string }[] = [
  { id: "indent", label: "Indentation", description: "A spherical probe presses, holds and releases to compare loading, hold response and recovery." },
  { id: "grasp", label: "Grasp & release", description: "A prescribed surface attachment lifts a small patch, holds and releases. Jaw friction is not modeled." },
  { id: "cut", label: "Cutting", description: "A virtual blade opens a predefined seam in the coarse simulation mesh through scripted bond release." },
];
const number = (value: number, digits = 2) => value.toLocaleString("en", { maximumFractionDigits: digits, minimumFractionDigits: digits });

function ForceChart({ run, frame }: { run: PhysicsRun; frame: number }) {
  const width = 560, height = 116, left = 42, right = 12, top = 13, bottom = 25;
  const forces = run.frames.map(forceMagnitude);
  const maximum = Math.max(...forces, 0.001) * 1.1;
  const duration = run.frames.at(-1)!.time_s;
  const x = (time: number) => left + time / duration * (width - left - right);
  const y = (force: number) => height - bottom - force / maximum * (height - top - bottom);
  const points = run.frames.map((item, index) => `${x(item.time_s)},${y(forces[index]!)}`).join(" ");
  const current = run.frames[frame]!;
  return <div className="physics-force-chart">
    <div><strong>{run.protocol === "cut" ? "Scripted fracture resistance" : "Tool reaction force"}</strong><span>{number(forceMagnitude(current), 3)} N <small>at {number(current.time_s)} s</small></span></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${run.protocol === "cut" ? "Scripted fracture resistance" : "Tool reaction force"} over ${number(duration)} seconds; peak ${number(run.metrics.peak_tool_force_n, 3)} newtons`}>
      {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1={left} x2={width - right} y1={y(maximum * fraction)} y2={y(maximum * fraction)} className="physics-chart-grid" /><text x={left - 7} y={y(maximum * fraction) + 3} textAnchor="end">{number(maximum * fraction, 2)}</text></g>)}
      <polyline points={points} fill="none" stroke="#8bcfc3" strokeWidth="2" />
      <line x1={x(current.time_s)} x2={x(current.time_s)} y1={top} y2={height - bottom} stroke="#d1e5df" strokeDasharray="3 3" />
      <circle cx={x(current.time_s)} cy={y(forceMagnitude(current))} r="3.5" fill="#d9eee7" />
      <text x={left} y={height - 6}>0 s</text><text x={width - right} y={height - 6} textAnchor="end">{number(duration)} s</text><text x="9" y="10">N</text>
    </svg>
  </div>;
}

export function AtlasPhysicsLab({ generation, onClose }: { generation: AtlasGeneration; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<PhysicsStatus | null>(null);
  const [mode, setMode] = useState<"hands" | "recorded">("hands");
  const [playgroundRevision, setPlaygroundRevision] = useState(0);
  const [playgroundData, setPlaygroundData] = useState<PhysicsPlayground | null>(null);
  const [playgroundAppliedFingerprint, setPlaygroundAppliedFingerprint] = useState("");
  const [protocol, setProtocol] = useState<PhysicsProtocol>("indent");
  const [source, setSource] = useState<PhysicsSource>("learned");
  const [parameters, setParameters] = useState<PhysicsParameters | null>(null);
  const [amplitude, setAmplitude] = useState(6);
  const [run, setRun] = useState<PhysicsRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [observation, setObservation] = useState<PhysicsObservation | null>(null);
  const [observationName, setObservationName] = useState("");
  const [observationError, setObservationError] = useState("");
  const [importingObservation, setImportingObservation] = useState(false);
  const [loadingExample, setLoadingExample] = useState(false);
  const importId = useRef(0);
  const exampleRequest = useRef<AbortController | null>(null);
  const request = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const cancel = () => { request.current?.abort(); requestId.current++; setBusy(false); setPlaying(false); if (busy) setNotice("Stopped waiting. The server finishes its current solve in the background; a new experiment can run afterward."); };
  const invalidate = () => { cancel(); setRun(null); setFrame(0); setError(""); };
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void apiGet("/api/physics/status", { signal: controller.signal }, "physics/status.json").then(async response => {
      if (!response.ok) throw await atlasError(response);
      const next = readPhysicsStatus(await response.json());
      if (!controller.signal.aborted) { setStatus(next); setParameters(next.defaults); }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Physics service unavailable."); });
    return () => { controller.abort(); request.current?.abort(); exampleRequest.current?.abort(); requestId.current++; importId.current++; };
  }, []);

  useEffect(() => {
    if (!playing || !run) return;
    const startTime = performance.now(); const from = run.frames[frame]!.time_s;
    let animation = 0;
    const tick = (now: number) => {
      const elapsed = from + (now - startTime) / 1000;
      let next = run.frames.findIndex(item => item.time_s > elapsed) - 1;
      if (next === -2) next = run.frames.length - 1;
      setFrame(Math.max(0, next));
      if (elapsed >= run.frames.at(-1)!.time_s) setPlaying(false);
      else animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
    // Capture the current frame on Play; updates must not restart the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, run]);

  const simulate = async () => {
    if (!status || !parameters || busy || (source === "learned" && (importingObservation || observationError))) return;
    invalidate();
    const controller = new AbortController(); request.current = controller;
    const id = ++requestId.current;
    setBusy(true); setNotice("");
    try {
      const response = await fetch(apiUrl("/api/physics/run"), { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ spec: generation.spec, protocol, amplitude_mm: amplitude, parameter_source: source, ...(source === "manual" ? { parameters } : observation ? { observation } : {}) }) });
      if (!response.ok) throw await atlasError(response);
      const next = readPhysicsRun(await response.json(), { spec: generation.spec, protocol, parameter_source: source, vertices: generation.scene.organs[0]!.positions.length / 3 });
      if (id !== requestId.current || controller.signal.aborted) return;
      setRun(next); setFrame(0);
      setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (cause) { if (id === requestId.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The physics experiment failed."); }
    finally { if (id === requestId.current) setBusy(false); }
  };
  const download = () => {
    if (!run) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...run, displayed_spec: generation.spec, displayed_scene: generation.scene }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `viscera-liver-${run.protocol}-physics.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const loadObservation = async (file: File) => {
    invalidate(); const id = ++importId.current;
    setObservation(null); setObservationName(file.name); setObservationError(""); setImportingObservation(true);
    try {
      if (file.size === 0 || file.size > 262144 || !file.name.toLowerCase().endsWith(".json")) throw new Error("Choose a nonempty calibration JSON file no larger than 256 KiB.");
      const parsed = readPhysicsObservation(JSON.parse(await file.text()), status?.model_version === "liver-inverse-sls-2.0.0" ? "varied" : "standard");
      if (id === importId.current) setObservation(parsed);
    } catch (cause) { if (id === importId.current) setObservationError(cause instanceof Error ? cause.message : "Calibration JSON could not be read."); }
    finally { if (id === importId.current) setImportingObservation(false); }
  };
  const clearObservation = () => { invalidate(); importId.current++; setObservation(null); setObservationName(""); setObservationError(""); setImportingObservation(false); };
  const downloadExample = async () => {
    if (loadingExample) return;
    const controller = new AbortController(); exampleRequest.current = controller; setLoadingExample(true);
    try {
      const response = await apiGet("/api/physics/demo-observation", { signal: controller.signal }, "physics/demo-observation.json");
      if (!response.ok) throw await atlasError(response);
      const example = readPhysicsObservation({ ...await response.json(), provenance: "VISCERA synthetic demonstration; not a tissue measurement." });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(example, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "viscera-synthetic-calibration-example.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The calibration example is unavailable."); }
    finally { if (!controller.signal.aborted) setLoadingExample(false); }
  };
  const current = run?.frames[frame];
  const stable = run?.metrics.finite_state && run.metrics.inverted_elements === 0 && run.metrics.minimum_jacobian > 0 && run.metrics.rejected_steps === 0 && (run.metrics.unconverged_steps ?? 0) === 0 && (run.metrics.loaded_contact_gap_frames ?? 0) === 0 && run.metrics.numerical_status !== "NEEDS_REFINEMENT";
  const activeResult = mode === "hands" ? playgroundData : run;
  const recipe = activeResult?.parameters ?? parameters;
  const materialValid = Boolean(status && parameters && (source === "manual" || (status.status === "ready" && !importingObservation && !observationError)));
  const materialFingerprint = JSON.stringify({ source, parameters: source === "manual" ? parameters : null, observation: source === "learned" ? observation : null });
  const materialPending = Boolean(playgroundData && materialFingerprint !== playgroundAppliedFingerprint);
  return <dialog ref={dialog} className={`physics-lab ${mode === "hands" ? "physics-hands-on" : ""}`} aria-labelledby="physics-title" aria-describedby="physics-evidence" onClose={() => { cancel(); onClose(); }} onCancel={() => cancel()}>
    <header className="physics-header"><div><span className="physics-eyebrow"><Activity size={13} /> VISCERA · MECHANICS RESEARCH</span><h2 id="physics-title">Liver physics lab</h2></div><button className="physics-close" aria-label="Close physics lab" onClick={() => dialog.current?.close()}><X size={20} /></button></header>
    <div className="physics-evidence" id="physics-evidence"><span>SYNTHETIC PROTOTYPE</span><p>Independent AI trained on synthetic force–displacement tests. Uploaded calibration remains unverified; numerical checks do not establish surgical realism.</p></div>
    <div className="physics-lab-modes" role="group" aria-label="Physics lab mode"><button aria-pressed={mode === "hands"} onClick={() => { cancel(); setMode("hands"); }}>Hands-on</button><button aria-pressed={mode === "recorded"} onClick={() => { cancel(); setMode("recorded"); }}>Recorded experiments</button><p>{mode === "hands" ? "Grab it. Push it. Drop it. Explore the response directly." : "Repeatable tool trajectories, force curves and numerical assessment."}</p></div>
    <div className="physics-layout">
      <section className="physics-experiment" aria-label="Physics experiment controls">
        <span className="physics-section-label">{mode === "hands" ? "MATERIAL / PHYSICS NETWORK" : "01 / EXPERIMENT"}</span>
        {mode === "recorded" && <>
        <div className="physics-protocols" role="group" aria-label="Surgical test protocol">{protocols.map(item => <button key={item.id} className={protocol === item.id ? "active" : ""} aria-pressed={protocol === item.id} onClick={() => { if (protocol !== item.id) { invalidate(); setProtocol(item.id); } }}>{item.label}</button>)}</div>
        <p className="physics-help">{protocols.find(item => item.id === protocol)!.description}</p>
        <label className="physics-control"><span>{protocol === "cut" ? "Retraction travel" : "Tool travel"} <output>{number(amplitude, 1)} mm</output></span><input type="range" aria-label={protocol === "cut" ? "Retraction travel" : "Tool travel"} min="1" max="12" step="0.5" value={amplitude} onChange={event => { invalidate(); setAmplitude(Number(event.target.value)); }} /></label>
        </>}
        <label className="physics-select">Parameter source<select value={source} onChange={event => { invalidate(); setSource(event.target.value as PhysicsSource); }}><option value="learned">Separate physics AI network</option><option value="manual">Manual material parameters</option></select></label>
        <p className="physics-help">{status?.model_version === "liver-inverse-sls-2.0.0" && source === "learned" && <strong>Physics AI v2 · varied loading histories<br /></strong>}{source === "learned" ? observation ? `${status?.model_version === "liver-inverse-sls-2.0.0" ? "The network proposes material properties; a bounded physics fit refines them against your unverified calibration." : "The network infers elastic and relaxation properties from your unverified calibration."} The same inferred material is applied to this liver.` : `${status?.model_version === "liver-inverse-sls-2.0.0" ? "The network proposes material properties; a bounded physics fit refines them against a synthetic reference test." : "The network identifies elastic and relaxation properties from a synthetic reference test."} Shape and color models do not estimate these properties.` : "Set constitutive parameters explicitly to compare sensitivity. Values describe this experiment, not an individual liver."}</p>
        {source === "learned" && status?.application_policy && <p className="physics-help" data-testid="physics-calibration-policy">Calibration checks: parameter precision and unexplained response patterns. Uncertain fits need a better measurement before application.</p>}
        {source === "learned" && <details className="physics-calibration"><summary>{observationName ? "Uploaded calibration" : "Use your calibration JSON"}</summary>
          <p>{status?.model_version === "liver-inverse-sls-2.0.0" ? "Physics AI v2 accepts 16–257 samples over 1–12 seconds: small-strain ramps, holds, releases and cycles with 0.5–5% peak strain. Include enough loading and relaxation to identify the response." : "81 samples, every 0.075 s from 0–6 s. Use 2.5% uniaxial strain: ramp 0–0.6 s, hold to 3.6 s, unload to 4.2 s, then recover."} Calibrated specimen length, cross-sectional area and provenance are required.</p>
          <label className="physics-file">Calibration JSON<input type="file" accept=".json,application/json" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void loadObservation(file); }} /></label>
          {observationName && <p className="physics-calibration-name">{importingObservation ? "Reading " : observation ? "Loaded · unverified: " : "Invalid: "}{observationName}</p>}
          {observation && <p>{observation.provenance}</p>}
          {observationError && <p className="physics-error" role="alert">{observationError}</p>}
          <div className="physics-calibration-actions"><button type="button" onClick={() => void downloadExample()} disabled={loadingExample}>{loadingExample ? "Loading example…" : "Download example"}</button>{observationName && <button type="button" onClick={clearObservation}>Use synthetic demo</button>}</div>
          <p>{observation ? "Your file is sent to the physics API when you run the experiment. Its clinical validity has not been verified." : "Default: built-in synthetic demonstration. Video without calibrated forces and geometry cannot identify these properties."}</p>
        </details>}
        {status?.status === "unavailable" && source === "learned" && <p className="physics-error">The trained physics network is unavailable. Manual parameters can still be tested.</p>}
        {source === "manual" && parameters && <div className="physics-manual">{physicsParameterFields.map(field => <label className="physics-control" key={field.key}><span>{field.label}<output>{number(parameters[field.key], field.step < 1 ? 3 : 0)} {field.unit}</output></span><input type="range" aria-label={field.label} min={field.min} max={field.max} step={field.step} value={parameters[field.key]} onChange={event => { invalidate(); setParameters({ ...parameters, [field.key]: Number(event.target.value) }); }} /></label>)}</div>}
        {mode === "hands" ? <><button className="atlas-btn physics-run" disabled={!materialValid} onClick={() => { setPlaygroundRevision(value => value + 1); setError(""); }}>Apply material</button><p className="physics-help" role="status">{materialPending ? "Material edits are pending. Apply them to reset the liver with the new response." : "The liver is free to move. Material changes take effect when you apply them."}</p></> : <button className="atlas-btn physics-run" disabled={!status || !parameters || busy || (source === "learned" && (status.status !== "ready" || importingObservation || Boolean(observationError)))} onClick={() => void simulate()}>{busy ? <LoaderCircle size={15} className="atlas-spinning" /> : <Play size={15} />} {busy ? "Running experiment…" : "Run experiment"}</button>}
        {busy && <><button className="physics-cancel" onClick={cancel}>Stop waiting</button><p className="physics-help">The server completes this solve even if you stop waiting or close the lab.</p></>}
        {notice && <p className="physics-help" role="status">{notice}</p>}
        <p className="physics-help physics-binding">Applied to the displayed liver.<br /><code>{generation.spec.template_id}</code></p>
        {error && <p className="physics-error" role="alert">{error}</p>}
      </section>
      {mode === "hands" ? <section className="physics-result" aria-label="Hands-on liver playground">{parameters ? <AtlasPhysicsPlayground generation={generation} source={source} parameters={parameters} observation={observation} revision={playgroundRevision} enabled={materialValid} onPrepared={next => { setPlaygroundData(next); setPlaygroundAppliedFingerprint(materialFingerprint); }} /> : <div className="physics-empty" role="status"><LoaderCircle size={23} className="atlas-spinning" /><p>Loading the interactive material…</p></div>}</section> : <section className="physics-result" aria-label="Physics playback and results">
        <AtlasPhysicsViewport scene={generation.scene} run={run} frame={frame} />
        <div className="physics-playback">
          <button className="physics-icon" aria-label={playing ? "Pause simulation playback" : "Play simulation playback"} disabled={!run} onClick={() => { if (run && frame === run.frames.length - 1) setFrame(0); setPlaying(!playing); }}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
          <button className="physics-icon" aria-label="Rewind simulation" disabled={!run} onClick={() => { setPlaying(false); setFrame(0); }}><RotateCcw size={14} /></button>
          <input type="range" aria-label="Simulation time" min="0" max={Math.max(1, (run?.frames.length ?? 1) - 1)} step="1" value={frame} disabled={!run} aria-valuetext={current ? `${number(current.time_s)} seconds, ${current.phase}` : "No experiment yet"} onChange={event => { setPlaying(false); setFrame(Number(event.target.value)); }} />
          <span>{current ? `${number(current.time_s)} s` : "0.00 s"}<small>{current?.phase ?? "Ready"}</small></span>
        </div>
        {run ? <>
          <div className="physics-result-heading"><span className="physics-section-label">02 / NUMERICAL ASSESSMENT</span><span className={stable ? "physics-stable" : "physics-unstable"}>{stable ? "Finite · no inverted elements" : "Numerical refinement needed"}</span></div>
          <div className="physics-metrics">
            <div><span>Peak reaction</span><strong>{number(run.metrics.peak_tool_force_n, 3)} <small>N</small></strong><p>Virtual tool load</p></div>
            <div><span>Max volume error</span><strong>{number(run.metrics.maximum_volume_error_pct)} <small>%</small></strong><p>Deviation from rest volume</p></div>
            <div><span>Minimum Jacobian</span><strong>{number(run.metrics.minimum_jacobian, 3)}</strong><p>Positive is non-inverted</p></div>
            <div><span>Residual motion</span><strong>{number(run.metrics.residual_displacement_mm)} <small>mm</small></strong><p>End-of-test displacement</p></div>
          </div>
          <ForceChart run={run} frame={frame} />
          <div className="physics-run-details"><span>Peak motion {number(run.metrics.peak_displacement_mm)} mm</span><span>{run.metrics.rejected_steps} rejected steps</span>{run.metrics.unconverged_steps !== undefined && <span>{run.metrics.unconverged_steps} unconverged steps</span>}<span>P95 step {number(run.metrics.p95_step_ms)} ms</span>{protocol === "cut" && <span>{run.metrics.severed_bonds} severed bonds · {number(run.metrics.fracture_dissipation_j, 5)} J</span>}{protocol === "cut" && run.metrics.maximum_seam_opening_mm !== undefined && <span>Seam opening {number(run.metrics.maximum_seam_opening_mm)} mm</span>}</div>
          {protocol === "indent" && run.metrics.maximum_contact_penetration_mm !== undefined && <p className="physics-contact-metrics">Max probe penetration {number(run.metrics.maximum_contact_penetration_mm, 3)} mm{run.metrics.loaded_contact_gap_frames !== undefined && ` · ${run.metrics.loaded_contact_gap_frames} loaded frames without contact`}<small>Penalty contact allows overlap. Probe stiffness controls this numerical approximation.</small></p>}
          <p className="physics-metrics-note">These metrics assess numerical behavior. Realism needs independent force, displacement and surgical-video measurements.</p>
        </> : <div className="physics-empty" role="status"><Activity size={23} /><div><strong>{busy ? "Solving the tool–tissue interaction" : "A repeatable test for soft-tissue behavior"}</strong><p>{busy ? "The server computes deformation, forces and stability metrics. Playback appears when the trajectory is ready." : "Choose a protocol and run an experiment to inspect deformation, tool forces and volume preservation."}</p></div></div>}
      </section>}
    </div>
    <footer className="physics-footer"><details open={Boolean(activeResult?.learning.parameter_intervals_90)}><summary>{activeResult ? "Applied parameters & evidence limits" : "Material parameters & evidence limits"}</summary>
      {recipe && <dl className="physics-parameter-summary">{physicsParameterFields.map(field => <div key={field.key}><dt>{field.label}{activeResult?.learning.source === "learned" && <small>{activeResult.learning.predicted_parameters?.[field.key] === undefined ? "Fixed assumption" : activeResult.learning.observation_origin === "user_supplied_calibration_unverified" ? "Inferred from supplied test" : "Inferred from synthetic test"}</small>}</dt><dd>{number(recipe[field.key], field.step < 1 ? 3 : 0)} {field.unit}{activeResult?.learning.parameter_intervals_90?.[field.key] ? <small>{number(activeResult.learning.parameter_intervals_90[field.key]!.lower, field.step < 1 ? 3 : 0)}–{number(activeResult.learning.parameter_intervals_90[field.key]!.upper, field.step < 1 ? 3 : 0)} · synthetic 90% interval</small> : activeResult?.learning.ensemble_std?.[field.key] !== undefined && <small> ± {number(activeResult.learning.ensemble_std[field.key]!, 3)} ensemble SD</small>}</dd></div>)}</dl>}
      <p>{activeResult?.learning.scope ?? status?.scope ?? "Synthetic system-identification research. No human surgical calibration has been performed."}</p>
      {activeResult?.learning.observation_provenance && <p>Calibration source (unverified): {activeResult.learning.observation_provenance}</p>}
      {activeResult?.learning.stress_nrmse !== undefined && <p>Calibration stress error: {number(activeResult.learning.stress_nrmse * 100)}% of peak observed stress (RMSE). This measures fit to the supplied trace, not transfer to human surgery.</p>}
      {activeResult?.learning.application_diagnostics && <p data-testid="applied-calibration-policy">Calibration precision and response checks passed on the supplied trace. These checks are calibrated on synthetic experiments; they do not validate human tissue behavior.</p>}
      {activeResult?.learning.uncertainty_scope && <p>{activeResult.learning.uncertainty_scope}</p>}
      {activeResult?.learning.model_id && <p>Physics model: <code>{activeResult.learning.model_id}</code></p>}
      {activeResult?.limitations.map((item, index) => <p key={index}>{item}</p>)}
      <p>Ensemble spread, when present, measures variation among fitted models; it is not clinical uncertainty. Predefined tools and boundary conditions do not reproduce a complete surgical scene.</p>
    </details>{mode === "recorded" && <button className="atlas-btn" disabled={!run} onClick={download}><ArrowDownToLine size={15} />Download run JSON</button>}</footer>
  </dialog>;
}
