import { ArrowRight, Check, Paintbrush, RotateCcw, Shuffle } from "lucide-react";
import { MATERIAL_CONTROLS, type AtlasMaterialLibrary, type AtlasMaterialRecipe } from "./atlasMaterial";

interface Props {
  library: AtlasMaterialLibrary | undefined;
  organ: string | undefined;
  recipe: AtlasMaterialRecipe | null;
  seedText: string;
  onRecipe: (recipe: AtlasMaterialRecipe) => void;
  onSeedText: (value: string) => void;
  onApply: () => void;
  onSample: () => void;
  disabled: boolean;
  pending: boolean;
  updating: boolean;
}
export function AtlasSurfacePanel({ library, organ, recipe, seedText, onRecipe, onSeedText, onApply, onSample, disabled, pending, updating }: Props) {
  if (!library || !organ || !recipe) return <div className="atlas-surface-unavailable"><Paintbrush size={24} /><h2>Surface library unavailable</h2><p>This anatomy server does not provide editable tissue materials.</p></div>;
  const palettes = library.organ_presets[organ]!;
  return <div className="atlas-surface-panel">
    <div className="atlas-recipe-heading"><span>Tissue appearance</span><button disabled={disabled} onClick={() => onRecipe({ ...library.defaults[organ]!, seed: recipe.seed })} title="Reset this organ’s surface parameters"><RotateCcw size={13} />Reset</button></div>
    <p className="atlas-control-intro">Palettes and finish update the preview automatically, preserving your shape controls.</p>
    <div className="atlas-material-presets" aria-label="Organ-compatible surface presets">{library.presets.map((preset) => <button key={preset.id} disabled={disabled} aria-label={`${preset.label} surface preset`} aria-pressed={recipe.preset === preset.id} title={preset.description} onClick={() => onRecipe({ ...palettes[preset.id].recipe, seed: recipe.seed })}>
      <span className="atlas-palette-swatches" aria-hidden="true">{palettes[preset.id].swatches.map((color, index) => <i key={`${color}-${index}`} style={{ backgroundColor: color }} />)}</span>
      <span>{preset.label}</span>{recipe.preset === preset.id && <Check size={11} />}
    </button>)}</div>
    <div className="atlas-controls atlas-surface-controls">{MATERIAL_CONTROLS.map((control) => <label className="atlas-control" key={control.key} title={control.description}>
      <span><span>{control.label}</span><output>{control.key === "mottle_scale_mm" ? `${recipe[control.key].toFixed(1)} mm` : control.key === "tint" ? `${recipe.tint > 0 ? "+" : ""}${recipe.tint.toFixed(2)}` : `${Math.round(recipe[control.key] * 100)}%`}</output></span>
      <input type="range" aria-label={control.label} min={control.min} max={control.max} step={control.step} value={recipe[control.key]} disabled={disabled} onChange={(event) => onRecipe({ ...recipe, [control.key]: Number(event.target.value) })} />
    </label>)}</div>
    <div className="atlas-seed-label"><label htmlFor="atlas-surface-seed">Appearance seed</label><span>Independent pattern</span></div>
    <div className="atlas-seed"><input id="atlas-surface-seed" type="text" inputMode="numeric" autoComplete="off" value={seedText} disabled={disabled} onChange={(event) => onSeedText(event.target.value)} /><button aria-label="Randomize appearance seed" title="Randomize appearance seed" disabled={disabled} onClick={() => onRecipe({ ...recipe, seed: crypto.getRandomValues(new Uint32Array(1))[0]! })}><Shuffle size={15} /></button></div>
    <button className="atlas-sample" disabled={disabled} onClick={onSample}><Shuffle size={13} />Sample surface</button>
    <p className="atlas-model-help">Samples the trained material prior within this preset.</p>
    <button className="atlas-btn atlas-generate atlas-apply-surface" disabled={disabled} onClick={onApply}><Paintbrush size={15} />Apply surface<ArrowRight size={15} /></button>
    <div className={`atlas-recipe-state ${pending ? "pending" : ""}`} aria-live="polite">{updating ? <><span />Updating surface preview…</> : pending ? <><span />Surface changes not applied</> : <><Check size={12} />Preview matches this surface</>}</div>
    <p className="atlas-surface-evidence">Authored tissue appearance. Colors, texture and finish are design parameters; measured optical properties and tissue architecture remain unvalidated.</p>
  </div>;
}
