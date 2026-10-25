import { Hand, Square, Check } from "lucide-react";
import { useState } from "react";
import type { AutomaticGraspState } from "./automaticGrasp";

export function AutomaticGraspOverlay({ state, stop }: { state: AutomaticGraspState | null; stop: () => void }) {
  const [dismissed, setDismissed] = useState<AutomaticGraspState | null>(null);
  if (!state || state === dismissed || ["idle", "stopped", "blocked"].includes(state.phase)) return null;
  const done = state.phase === "complete";
  return <section className="camera-path-overlay grasp-task-overlay" aria-label="Live automatic grasp">
    <div className="camera-path-heading">{done ? <Check size={16} /> : <Hand size={16} />}<strong>{done ? "Task complete" : "Automatic liver task"}</strong></div>
    <p role="status">{state.message}</p>
    {state.phase === "learning" && <progress max={state.total} value={state.progress} aria-label="Grasp learning progress" />}
    <div className="grasp-task-metrics"><span>Reaction<strong>{state.forceN.toFixed(3)} <small>N</small></strong></span><span>Displacement<strong>{state.displacementMm.toFixed(2)} <small>mm</small></strong></span></div>
    <small>Simulation limits · {state.limits.forceN} N reaction · {state.limits.displacementMm} mm displacement</small>
    <div className="camera-path-actions">{done ? <button onClick={() => setDismissed(state)}>Dismiss grasp result</button> : <><button onClick={stop}><Square size={14} />Stop & release</button><kbd>Esc</kbd></>}</div>
  </section>;
}
