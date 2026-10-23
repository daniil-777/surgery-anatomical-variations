import { createContext, useContext, useState } from "react";
import { Columns3 } from "lucide-react";
import { BLOOD_MODELS, type BloodWorkspace } from "./models";
import "./modelSelector.css";

export const BloodModelContext = createContext<{ workspace: BloodWorkspace; choose: (next: BloodWorkspace) => void } | null>(null);

export function useBloodModel() {
  return useContext(BloodModelContext);
}

/**
 * Sidebar control for switching fluid/blood simulation models directly from the
 * right-hand Simulation / Controls panel of any Blood lab workspace.
 */
export function BloodFluidModelControl() {
  const ctx = useBloodModel();
  if (!ctx) return null;
  const current = BLOOD_MODELS.find(model => model.id === ctx.workspace)!;
  return <div className="blood-sidebar-model-control" data-testid="blood-sidebar-model-selector">
    <label>Fluid simulation model
      <select aria-label="Active fluid simulation model" value={ctx.workspace} onChange={e => ctx.choose(e.target.value as BloodWorkspace)}>
        {BLOOD_MODELS.map(model => <option key={model.id} value={model.id}>{model.label} — {model.method} ({model.dimension})</option>)}
      </select>
    </label>
    <p className="blood-muted">{current.dimension} · {current.engine}. {current.bestFor}.</p>
  </div>;
}

/**
 * Model selector for the Blood lab. Each card is a toggle button whose accessible
 * name is exactly the workspace label (harness scripts depend on it); the method,
 * dimension and engine are exposed as its description.
 */
export function BloodModelSelector({ workspace, choose, notice }: { workspace: BloodWorkspace; choose: (next: BloodWorkspace) => void; notice?: string }) {
  const [comparing, setComparing] = useState(false);
  const current = BLOOD_MODELS.find(model => model.id === workspace)!;
  return <div className="blood-navigation blood-model-selector" role="region" aria-label="Fluid simulation model selection">
    <div className="blood-model-selector-head">
      <label className="blood-model-select-bar">
        <span>Fluid &amp; blood simulation model</span>
        <select aria-label="Fluid simulation model" value={workspace} onChange={e => choose(e.target.value as BloodWorkspace)}>
          {BLOOD_MODELS.map(model => <option key={model.id} value={model.id}>{model.label} · {model.method} ({model.dimension} · {model.engine})</option>)}
        </select>
      </label>
      <button type="button" className="blood-model-compare-toggle" aria-expanded={comparing} aria-controls="blood-model-comparison" onClick={() => setComparing(v => !v)}><Columns3 size={14} />{comparing ? "Hide comparison" : "Compare models"}</button>
    </div>
    <nav aria-label="Blood lab workspaces">
      {BLOOD_MODELS.map(model => <button key={model.id} type="button" className="blood-model-card" aria-label={model.label} aria-describedby={`blood-model-${model.id}`}
        aria-pressed={workspace === model.id} onClick={() => choose(model.id)}>
        <strong>{model.label}{model.id === "pool" && <em>New</em>}</strong>
        <span id={`blood-model-${model.id}`}>{model.method}</span>
        <small>{model.dimension} · {model.engine}</small>
      </button>)}
    </nav>
    <p className="blood-model-current"><strong>{current.label}:</strong> {current.bestFor}. <span>Limits: {current.limits}.</span></p>
    {comparing && <div className="blood-model-comparison" id="blood-model-comparison">
      <table>
        <caption>Blood lab models. Verification lists what each model is tested against; none is a clinical validation.</caption>
        <thead><tr><th scope="col">Model</th><th scope="col">Method</th><th scope="col">Dimension · engine</th><th scope="col">Best for</th><th scope="col">Interaction</th><th scope="col">Verification</th><th scope="col">Main limits</th></tr></thead>
        <tbody>{BLOOD_MODELS.map(model => <tr key={model.id} aria-current={workspace === model.id ? "true" : undefined}>
          <th scope="row">{model.label}</th><td>{model.method}</td><td>{model.dimension} · {model.engine}</td><td>{model.bestFor}</td><td>{model.interaction}</td><td>{model.verification}</td><td>{model.limits}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
