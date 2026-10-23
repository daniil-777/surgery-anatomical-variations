import { useEffect, useRef, useState } from "react";
import { Download, Focus, Hand, LoaderCircle, Move3d, MousePointer2, Orbit, Rotate3d, RotateCcw, Scissors } from "lucide-react";
import { publicUrl } from "../api";
import { SceneResizeHandle } from "../DisplaySettings";
import { readCuttingReference } from "./reference";
import type { CuttingReference } from "./types";
import { createScissorsScene, type ScissorsScene, type ScissorsState, type ScissorsMode } from "./scissorsScene";
import "./cutting.css";
import "./scissors.css";

const modes = [
  { id: "place", label: "Place on liver", icon: MousePointer2, help: "Click, tap, or drag across the liver to position open jaws. Then press Close & cut. Right-drag or use two fingers to inspect." },
  { id: "translate", label: "Move in 3D", icon: Move3d, help: "Drag an axis arrow to move the instrument. Use the plane handles for two axes. Arrow keys move X/Y; Page Up/Down moves Z." },
  { id: "rotate", label: "Rotate in 3D", icon: Rotate3d, help: "Drag a colored ring to rotate the scissors. Arrow keys rotate X/Y; Page Up/Down rotates Z. Shift makes a larger step." },
  { id: "orbit", label: "Inspect", icon: Orbit, help: "Drag to orbit the liver, scroll or pinch to zoom. Camera motion preserves all incisions. Space closes the jaws when the scene has focus." },
] as const;
const initial: ScissorsState = { ready: false, busy: false, mode: "place", opening: 1, fps: 0, position: [0, 0, 0], rotation: [0, 0, 0], cutCount: 0, cutSegments: 0, maximumDisplacementMm: 0, maximumLipOpeningMm: 0, notice: "Preparing the liver and scissors…" };

function PoseNumber({ label, value, disabled, onCommit }: { label: string; value: number; disabled: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value.toFixed(1)), [editing, setEditing] = useState(false);
  const cancelCommit = useRef(false);
  useEffect(() => { if (!editing) setDraft(value.toFixed(1)); }, [value, editing]);
  const commit = () => { if (cancelCommit.current) { cancelCommit.current = false; setDraft(value.toFixed(1)); } else if (draft.trim() && Number.isFinite(Number(draft))) onCommit(Number(draft)); else setDraft(value.toFixed(1)); setEditing(false); };
  return <label><span>{label}</span><input type="number" aria-label={label} value={draft} disabled={disabled} step="1" onFocus={() => setEditing(true)} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { cancelCommit.current = true; event.currentTarget.blur(); } }} /></label>;
}

export function LaparoscopicScissorsLab() {
  const host = useRef<HTMLDivElement>(null), runtime = useRef<ScissorsScene | null>(null);
  const [reference, setReference] = useState<CuttingReference | null>(null), [state, setState] = useState(initial);
  const [error, setError] = useState(""), [retry, setRetry] = useState(0), [depth, setDepth] = useState(2), [handle, setHandle] = useState(true);
  useEffect(() => {
    let cancelled = false; setError(""); setState(initial); setReference(null);
    void fetch(publicUrl("cutting/liver-reference.json")).then(async response => {
      if (!response.ok) throw new Error(`The liver reference could not load (${response.status}).`);
      return readCuttingReference(await response.json());
    }).then(value => { if (!cancelled) setReference(value); }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "The liver reference could not load."); });
    return () => { cancelled = true; };
  }, [retry]);
  useEffect(() => {
    if (!reference || !host.current) return;
    try { const scene = createScissorsScene(host.current, reference, setState, setError); runtime.current = scene; setDepth(2); setHandle(true);
      return () => { runtime.current = null; scene.dispose(); };
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The 3D scissors could not start."); }
  }, [reference]);
  const disabled = !state.ready || state.busy || Boolean(error);
  const exportState = () => {
    if (!runtime.current) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(runtime.current.snapshot())], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "viscera-laparoscopic-incisions.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const cutButton = (fullscreen = false) => <button type="button" className="scissors-cut-button" aria-label={fullscreen ? "Close scissors and cut in full screen" : "Close & cut"} disabled={disabled} onClick={() => runtime.current?.cut()}><Scissors size={18} /><span>{state.busy ? "Closing & reopening…" : "Close & cut"}</span>{!fullscreen && <kbd>Space</kbd>}</button>;
  return <section className="cutting-lab scissors-lab" aria-label="Laparoscopic scissors experiment">
    <header className="cutting-heading"><div><span className="cutting-kicker"><Scissors size={13} /> INTERACTIVE INCISION</span><h3>Laparoscopic scissors</h3><p>Position the jaws. Choose your angle. Close to cut.</p></div><span className="cutting-scope">Responsive surface model<br />Uncalibrated tissue mechanics</span></header>
    <div className="cutting-workspace"><div className="cutting-view">
      <div className="cutting-toolbar"><div className="cutting-tools" role="group" aria-label="Scissors interaction mode">{modes.map(({ id, label, icon: Icon }) => <button key={id} type="button" disabled={disabled} aria-pressed={state.mode === id} onClick={() => runtime.current?.setMode(id as ScissorsMode)}><Icon size={15} />{label}</button>)}</div></div>
      <div className="cutting-stage scissors-stage"><SceneResizeHandle /><div ref={host} className="cutting-canvas" data-testid="scissors-viewport" /><div className="cutting-scene-caption"><strong>HRA reference liver</strong><span>18 mm articulated jaws · free 3D pose</span></div><div className="scissors-view-actions"><button type="button" disabled={!state.ready} onClick={() => runtime.current?.fit()}><Focus size={14} />Fit liver</button><button type="button" disabled={!state.ready} onClick={() => runtime.current?.focus()}><Focus size={14} />Focus jaws</button></div><div className="scissors-fullscreen-actions">{cutButton(true)}{modes.map(({ id, icon: Icon }) => <button type="button" key={id} disabled={disabled} aria-pressed={state.mode === id} onClick={() => runtime.current?.setMode(id)}><Icon size={15} />{({ place: "Place jaws", translate: "Move scissors", rotate: "Rotate scissors", orbit: "Orbit camera" })[id]}</button>)}</div><span className="cutting-scale">{state.busy ? "JAW CLOSURE" : `${state.cutCount} INCISIONS · ${Math.round(state.fps)} RENDER FPS`}</span>{!state.ready && !error && <div className="cutting-loading" role="status"><LoaderCircle size={25} className="atlas-spinning" /><strong>Preparing the scissors workspace</strong><span>Loading the reference liver surface.</span></div>}</div>
      <p className="cutting-instruction"><Hand size={16} /><span>{modes.find(mode => mode.id === state.mode)!.help}</span></p>
      <div className="scissors-primary-row">{cutButton()}<button type="button" disabled={disabled} onClick={() => runtime.current?.advance()}>Advance 10 mm</button><button type="button" disabled={disabled} onClick={() => runtime.current?.withdraw()}>Lift clear</button></div>
      <p className="scissors-status" role="status">{state.notice}</p>
    </div><aside className="cutting-controls scissors-controls" aria-label="Scissors position and rotation">
      <h4 className="cutting-section-title">Instrument pose</h4><p>Use the on-scene arrows and rings, or enter a precise pose below. Values apply on Enter or when you leave the field.</p>
      <fieldset disabled={disabled}><legend>Position · mm</legend><div className="scissors-pose-grid">{["X", "Y", "Z"].map((axis, index) => <PoseNumber key={axis} label={`Position ${axis}`} value={state.position[index]!} disabled={disabled} onCommit={value => runtime.current?.setPosition(index, value)} />)}</div></fieldset>
      <fieldset disabled={disabled}><legend>Rotation · degrees</legend><div className="scissors-pose-grid">{["X", "Y", "Z"].map((axis, index) => <PoseNumber key={axis} label={`Rotation ${axis}`} value={state.rotation[index]!} disabled={disabled} onCommit={value => runtime.current?.setRotation(index, value)} />)}</div></fieldset>
      <label className="cutting-control"><span>Insertion below surface<output>{depth.toFixed(1)} mm</output></span><input aria-label="Scissors insertion depth" type="range" min=".5" max="3.5" step=".5" value={depth} disabled={disabled} onChange={event => { const next = Number(event.target.value); setDepth(next); runtime.current?.setDepth(next); }} /></label>
      <p>Placement aligns the open jaws with the clicked surface. Insertion moves along the tool’s local normal. Only tissue caught inside the finite closing jaws is cut.</p>
      <label className="scissors-check"><input type="checkbox" checked={handle} disabled={!state.ready} onChange={event => { setHandle(event.target.checked); runtime.current?.setHandleVisible(event.target.checked); }} />Show instrument handle</label>
      <button type="button" disabled={!state.ready || Boolean(error)} onClick={() => runtime.current?.reset()}><RotateCcw size={15} />Reset incisions</button><p>Reset restores this specimen. Switching experiments also starts a fresh specimen; export the mesh to keep your work.</p>
    </aside></div>
    {error && <div className="cutting-error" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>Reload scissors</button></div>}
    <div className="scissors-result-strip"><span><strong>{state.cutCount}</strong> incisions</span><span><strong>{state.cutSegments}</strong> split surface segments</span><span><strong>{state.maximumLipOpeningMm.toFixed(2)} mm</strong> lip opening</span><span>Moves and rotations preserve cuts</span></div>
    <details className="cutting-notes"><summary>How this cutting experiment works</summary><p>Closing the jaws splits the contacted surface triangles and creates separate incision lips and interior walls. The finite cut follows the current 3D instrument pose. The local compliant surface response is an interactive approximation, not the calibrated volumetric solver. Positioning or orbiting alone never damages tissue.</p><p>This experiment does not simulate full organ division, vessel injury, bleeding, shaft collision, or measured surgical forces. The separate Scalpel & fracture experiment retains the slower learned-material mechanics on a prepared plane. Neither experiment has clinical validation.</p><p>Keyboard: P places, M moves, R rotates, V inspects. Arrow keys adjust X/Y; Page Up/Down adjusts Z. Shift increases the step. Space or Enter closes the scissors when the scene has focus. F fits the liver. Touch supports surface placement and the transform handles.</p><p>{reference?.source.attribution} · {reference?.source.license}</p></details>
    <div className="cutting-footer-actions"><button type="button" disabled={!state.ready || state.busy} onClick={exportState}><Download size={14} />Export incision mesh</button><span className="cutting-diagnostic-note">Use the recorder above for the actual moving 3D scene.</span></div>
  </section>;
}
