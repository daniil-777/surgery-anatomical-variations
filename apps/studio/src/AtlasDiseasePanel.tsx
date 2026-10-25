import { Activity, ArrowRight, Check, ExternalLink, RotateCcw, Shuffle, Sparkles } from "lucide-react";
import { safeSourceUrl } from "./atlas";
import { defaultAtlasDisease, DISEASE_CONTROLS, type AtlasDiseaseLibrary, type AtlasDiseaseSpec } from "./atlasDisease";

interface Props {
  library: AtlasDiseaseLibrary | undefined;
  organ: string | undefined;
  recipe: AtlasDiseaseSpec | null | undefined;
  seedText: string;
  onRecipe: (recipe: AtlasDiseaseSpec | null) => void;
  onSeedText: (value: string) => void;
  onApply: () => void;
  onSample: () => void;
  onLearned: () => void;
  /** whether the trained disease prior can answer: active in the model status and, without the API, bundled */
  learnedAvailable: boolean;
  disabled: boolean;
  pending: boolean;
  updating: boolean;
  learnedApplied: boolean;
  displacementLimited?: boolean;
  displacementFraction?: number | undefined;
  expanded?: boolean;
}
export function AtlasDiseasePanel({ library, organ, recipe, seedText, onRecipe, onSeedText, onApply, onSample, onLearned, learnedAvailable, disabled, pending, updating, learnedApplied, displacementLimited, displacementFraction, expanded }: Props) {
  if (!library || !organ) return <div className="atlas-surface-unavailable"><Activity size={24} /><h2>Disease controls unavailable</h2><p>This anatomy server does not provide disease morphology profiles.</p></div>;
  const profiles = library.profiles.filter(profile => profile.organ === organ);
  const selected = profiles.find(profile => profile.id === recipe?.profile_id);
  const source = safeSourceUrl(selected?.source_url);
  const limits = selected ? (Array.isArray(selected.limits) ? selected.limits.join(" ") : selected.limits) : "";
  return <div className="atlas-disease-panel">
    <div className="atlas-recipe-heading"><span>Disease morphology</span><button disabled={disabled || !recipe} onClick={() => recipe && onRecipe(defaultAtlasDisease(library, organ, recipe.profile_id, recipe.seed))} title="Reset disease morphology controls"><RotateCcw size={13} />Reset</button></div>
    <p className="atlas-disease-badge">Synthetic morphology prototype</p>
    <p className="atlas-control-intro">Organ-specific design controls update the preview automatically. Intensity is not a clinical stage or severity score.</p>
    {recipe && displacementLimited && <p className="atlas-disease-source-limit" role="status">Source geometry limits this design{expanded && displacementFraction !== undefined ? `: ${(displacementFraction * 100).toFixed(1)}% of the requested local displacement was retained.` : ". Displacement was reduced to preserve this mesh."}</p>}
    <label className="atlas-disease-select"><span>Disease profile</span><select aria-label="Disease profile" value={recipe?.profile_id ?? ""} disabled={disabled} onChange={event => onRecipe(event.target.value ? defaultAtlasDisease(library, organ, event.target.value, recipe?.seed) : null)}>
      <option value="">Baseline · no disease modifier</option>
      {profiles.map(profile => <option key={profile.id} value={profile.id} disabled={profile.supported === false}>{profile.label}{profile.supported === false ? " · reference only" : ""}</option>)}
    </select></label>
    {!recipe ? <p className="atlas-control-intro">The cited reference shape is shown without a disease modifier. Baseline does not certify healthy anatomy.</p> : <>
      <div className="atlas-controls">{DISEASE_CONTROLS.map(control => {
        const label = control.key === "severity" ? "Morphology intensity" : library.controls.find(entry => entry.key === control.key)?.label ?? control.label;
        return <label className="atlas-control" key={control.key}><span><span>{label}</span><output>{control.key === "count" ? recipe.count : `${Math.round(recipe[control.key] * 100)}%`}</output></span>
          <input type="range" aria-label={label} min={control.min} max={control.max} step={control.key === "count" ? 1 : 0.01} value={recipe[control.key]} disabled={disabled} onChange={event => onRecipe({ ...recipe, [control.key]: Number(event.target.value) })} />
        </label>;
      })}</div>
      <fieldset className="atlas-disease-location"><legend>Feature location</legend><p>Normalized reference axes; not patient directions.</p><div className="atlas-controls">{["X", "Y", "Z"].map((axis, index) => <label className="atlas-control" key={axis}><span><span>{axis} position</span><output>{recipe.location[index]!.toFixed(2)}</output></span><input type="range" aria-label={`Disease location ${axis}`} min={-1} max={1} step={0.02} value={recipe.location[index]} disabled={disabled} onChange={event => { const location = [...recipe.location] as AtlasDiseaseSpec["location"]; location[index] = Number(event.target.value); onRecipe({ ...recipe, location }); }} /></label>)}</div></fieldset>
      <div className="atlas-seed-label"><label htmlFor="atlas-disease-seed">Disease seed</label><span>Reproducible pattern</span></div>
      <div className="atlas-seed"><input id="atlas-disease-seed" type="text" inputMode="numeric" autoComplete="off" value={seedText} disabled={disabled} onChange={event => onSeedText(event.target.value)} /><button aria-label="Randomize disease seed" disabled={disabled} onClick={() => onRecipe({ ...recipe, seed: crypto.getRandomValues(new Uint32Array(1))[0]! })}><Shuffle size={15} /></button></div>
      <button className="atlas-btn atlas-generate" disabled={disabled} onClick={onSample}><Sparkles size={15} />Generate variation<ArrowRight size={15} /></button>
      <p className="atlas-model-help">A new seed varies shape and disease controls together. Surface settings stay fixed.</p>
      {expanded ? <p className="atlas-model-help">Use Generative Model 2 variation above to sample the expanded disease model. Intensity requests can be limited by this reference mesh.</p> : <><button className="atlas-sample atlas-learned" disabled={disabled || !learnedAvailable} onClick={onLearned} title={learnedAvailable ? undefined : "The trained disease prior is unavailable"}><Sparkles size={13} />Learned disease variation</button>
      <p className="atlas-model-help">{learnedAvailable ? "Samples the trained synthetic prior while preserving shape and surface controls. The resulting disease seed replays the realized pattern." : "The trained disease prior is unavailable. Open Trained models to check its status."}</p></>}
      {learnedApplied && <p className="atlas-model-status" role="status"><Check size={11} />Disease model variation applied</p>}
    </>}
    <div className={`atlas-recipe-state ${pending ? "pending" : ""}`} aria-live="polite">{updating ? <><span />Updating disease preview…</> : pending ? <><span />Disease changes not applied</> : <><Check size={12} />Preview matches this recipe</>}</div>
    {pending && !updating && <button className="atlas-sample" disabled={disabled} onClick={onApply}>Apply disease parameters<ArrowRight size={13} /></button>}
    {selected && <div className="atlas-disease-evidence"><strong>Reference & limits</strong><p>{limits}</p>{source && <a href={source} target="_blank" rel="noreferrer">View morphology reference {selected.source_ref}<ExternalLink size={12} /></a>}</div>}
    {profiles.some(profile => profile.supported === false) && <details className="atlas-disease-unavailable"><summary>Reference-only profiles</summary>{profiles.filter(profile => profile.supported === false).map(profile => <p key={profile.id}><strong>{profile.label}</strong><br />{profile.unavailable_reason}</p>)}</details>}
  </div>;
}
