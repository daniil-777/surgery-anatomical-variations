import { useState } from "react";
import { Pause, Play, Square, ChevronDown, ChevronUp } from "lucide-react";
import type { CameraPlannerState } from "./cameraPlannerScene";
import "./cameraPlanningLab.css";

/** A DOM/SVG overview cannot occlude tissue or enter RGBD observations. The
 * main WebGL viewport remains the actual moving first-person scope image. */
export function CameraPathOverlay({ state, pause, stop }: { state: CameraPlannerState | null; pause: () => void; stop: () => void }) {
  const [expanded, setExpanded] = useState(true);
  if (!state || !(["playing", "paused"].includes(state.phase) || state.phase === "complete" && state.targetLabel) || !state.port || state.path.length < 2) return null;
  const complete = state.phase === "complete";
  const project = (p: number[]) => [(p[0]! - state.port![0]!) * .85 + (p[2]! - state.port![2]!) * .53,
    -(p[1]! - state.port![1]!) * .85 + (p[2]! - state.port![2]!) * .28];
  const points = [state.port, ...state.path].map(project), xs = points.map(p => p[0]!), ys = points.map(p => p[1]!);
  const minX = Math.min(...xs) - 20, minY = Math.min(...ys) - 20, spanX = Math.max(...xs) - minX + 20, spanY = Math.max(...ys) - minY + 20;
  const scale = Math.min(260 / spanX, 130 / spanY);
  const screen = (p: number[]) => { const q = project(p); return [(q[0]! - minX - spanX / 2) * scale + 140, (q[1]! - minY - spanY / 2) * scale + 75]; };
  const path = state.path.map(screen), port = screen(state.port), lens = screen(state.positionMm);
  const look = screen(state.positionMm.map((v, i) => v + state.direction[i]! * 18));
  const rotation = Math.atan2(look[1]! - lens[1]!, look[0]! - lens[0]!) * 180 / Math.PI;
  const returning = state.segment < state.returnSegments;
  return <section className="camera-path-overlay" aria-label="Live scope path">
    <div className="camera-path-heading"><span className={state.phase === "paused" ? "paused" : ""} /><strong>{complete ? "Inspection view reached" : state.phase === "paused" ? "Scope paused" : "Live scope view"}</strong>{!complete && <button onClick={() => setExpanded(value => !value)} aria-label={expanded ? "Collapse path overview" : "Expand path overview"}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>}</div>
    <p>{state.targetLabel ? `${complete ? "At" : "Approaching"} ${state.targetLabel}` : returning ? "Guarded approach / return" : "Policy inspection"}{state.loop ? ` · loop ${state.lap}` : ""}</p>
    {expanded && !complete && <><svg viewBox="0 0 280 150" role="img" aria-label="Camera position and planned path, schematic overview">
      <defs><pattern id="camera-path-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="#9ac4b010" /></pattern></defs>
      <rect width="280" height="150" fill="url(#camera-path-grid)" />
      {path.slice(1).map((point, i) => <line key={i} x1={path[i]![0]} y1={path[i]![1]} x2={point[0]} y2={point[1]} stroke={i < state.returnSegments ? "#dbb88b" : "#9ee4c3"} strokeWidth={i === state.segment ? 3 : 1.8} strokeDasharray={i < state.returnSegments ? "4 4" : undefined} opacity={i < state.segment ? .4 : .9} />)}
      {path.map((point, i) => <circle key={i} cx={point[0]} cy={point[1]} r="2.5" fill={i <= state.segment ? "#a8e5c8" : "#658e80"} />)}
      <line x1={port[0]} y1={port[1]} x2={lens[0]} y2={lens[1]} stroke="#a1bbc5" strokeWidth="3" />
      <circle cx={port[0]} cy={port[1]} r="4" fill="#12232a" stroke="#b5c7cd" /><text x={port[0]! + 8} y={port[1]! + 4} fill="#9cb9b2" fontSize="8">Pivot</text>
      <g transform={`translate(${lens[0]},${lens[1]}) rotate(${rotation})`}><path d="M 4 -3 L 28 -16 L 28 16 L 4 3" fill="#a9efd619" stroke="#b9f2d955" /><rect x="-9" y="-4" width="14" height="8" rx="2" fill="#d6e8e5" stroke="#6c9991" /><path d="M 5 -4 L 5 4" stroke="#e9fff7" strokeWidth="2" /></g>
    </svg><div className="camera-path-legend"><span>— Policy</span><span>┄ Guarded return</span><span>Scope + light</span></div></>}
    <div className="camera-path-telemetry"><span>{Math.min(state.segments, state.segment + 1)} / {state.segments} segments</span><span>{state.elapsedSeconds.toFixed(0)} s · {state.clearanceMm} mm guard</span></div>
    <div className="camera-path-actions">{!complete && <button onClick={pause}>{state.phase === "paused" ? <Play size={14} /> : <Pause size={14} />}{state.phase === "paused" ? "Resume" : "Pause"}</button>}<button onClick={stop}><Square size={14} />{complete ? "Dismiss" : "Stop camera"}</button>{!complete && <kbd>Esc</kbd>}</div>
  </section>;
}
