import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { WhistleMicButton } from "./whistleMic";
import { modelMessage } from "./modelNames";
import type { SceneTextHint } from "./sceneTextEdits";
import "./sceneTextEditor.css";

export function SceneTextEditor({ id, targets, target, onTarget, hints, disabled, busy, onApply, message, version = 0 }: {
  id?: string;
  targets: { id: string; label: string }[]; target: string; onTarget: (id: string) => void;
  hints: SceneTextHint[]; disabled: boolean; busy?: boolean; onApply: (text: string) => void;
  message?: string; version?: number;
}) {
  const [prompt, setPrompt] = useState("");
  const [speech, setSpeech] = useState("");
  const [listening, setListening] = useState(false);
  const session = useRef({ target, version, disabled, onApply }); session.current = { target, version, disabled, onApply };
  const speechTarget = useRef({ target, version });
  useEffect(() => { setPrompt(""); setSpeech(""); }, [target, version]);
  const apply = (text: string) => { if (!disabled && !busy && text.trim()) onApply(text); };
  return <section id={id} tabIndex={id ? -1 : undefined} className={`scene-text-editor${id ? " scene-shortcut-destination" : ""}`} aria-label="Scene text-to-shape editor">
    <div className="scene-text-heading"><Sparkles size={16} /><h2>Anatomy with words</h2></div>
    <p>Describe a disease, shape or surface change. Apply a hint, type an instruction, or use your voice.</p>
    <label>Edit target<select aria-label="Text edit target" value={target} disabled={disabled || listening} onChange={event => onTarget(event.target.value)}>
      {targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    <div className="scene-text-hints" aria-label="Scene disease hints">
      {hints.map(hint => <button key={hint.id} type="button" title={hint.prompt} disabled={disabled || listening} onClick={() => { setPrompt(hint.prompt); apply(hint.prompt); }}>{hint.label}</button>)}
    </div>
    <form onSubmit={event => { event.preventDefault(); apply(prompt); }}>
      <textarea aria-label="Describe a variation" placeholder="Try a disease hint, or “wider; wetter”" value={prompt} maxLength={2000} rows={3} disabled={disabled || listening}
        onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); apply(prompt); } }} />
      <div className="scene-text-actions"><button type="submit" disabled={disabled || listening || !prompt.trim()}><Sparkles size={15} />{busy ? "Applying…" : "Apply text"}</button>
        <WhistleMicButton disabled={disabled} onStatusChange={(text, phase) => {
          if (phase === "loading") speechTarget.current = { target, version };
          setListening(["loading", "listening", "transcribing"].includes(phase)); setSpeech(modelMessage(text).replace(/Cactus Whistle|Whistle|Needle3?/gi, "speech model"));
        }} onTranscript={text => { if (session.current.target === speechTarget.current.target && session.current.version === speechTarget.current.version) setPrompt(text); }}
          onCommit={text => {
            const now = session.current;
            if (now.disabled || now.target !== speechTarget.current.target || now.version !== speechTarget.current.version) { setSpeech("The scene or target changed. Please record the instruction again."); return; }
            setPrompt(text); now.onApply(text);
          }} />
      </div>
    </form>
    {speech && <p role="status">{speech}</p>}
    <p className="scene-text-feedback" aria-live="polite">{message || "Shape and appearance update together. Unsupported instructions leave the scene unchanged."}</p>
  </section>;
}
