import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Box, Check, FolderOpen, Focus, LoaderCircle, RotateCcw, Shuffle, Sparkles, Upload } from "lucide-react";
import { DisplaySettings, SceneResizeHandle } from "../DisplaySettings";
import { VideoRecorderButton } from "../VideoRecorderPanel";
import { WhistleMicButton } from "../whistleMic";
import { ImportedViewport, type ImportedViewportHandle } from "./ImportedViewport";
import { exportImportedModelGLB, inspectImportedRoot, loadImportedModel, type ImportedModel } from "./importModel";
import {
  applyVariation, compileImportedText, createVariationState, disposeVariationState,
  loadImportedVariationSystem, resetVariation, sampleNeuralVariation,
} from "./variations";
import "./imports.css";

type System = Awaited<ReturnType<typeof loadImportedVariationSystem>>;
type Recipe = ReturnType<typeof sampleNeuralVariation>;
type State = ReturnType<typeof createVariationState>;
type Report = Awaited<ReturnType<typeof applyVariation>>;
type Session = { model: ImportedModel; state: State };
type Applied = { recipe: Recipe; report: Report; shapeStrength: number; textureStrength: number; prompt?: string };
const readable = (error: unknown) => error instanceof Error ? error.message : "The operation could not be completed.";
const count = (value: number) => new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

function inferReferenceForFilename(system: System, filename: string): string {
  const lower = filename.toLowerCase();
  const organKeywords: [string, string][] = [
    ["liver", "liver"], ["hep", "liver"],
    ["lung", "lung"], ["pulm", "lung"],
    ["heart", "heart"], ["card", "heart"],
    ["kidney", "kidney"], ["renal", "kidney"],
    ["brain", "brain"], ["cort", "brain"],
    ["stomach", "stomach"], ["gastr", "stomach"],
    ["pancreas", "pancreas"],
    ["spleen", "spleen"],
    ["gallbladder", "gallbladder"],
    ["bladder", "urinary-bladder"],
    ["colon", "large-intestine"], ["large-intestine", "large-intestine"],
    ["small-intestine", "small-intestine"], ["bowel", "small-intestine"],
  ];
  for (const [token, organ] of organKeywords) {
    if (lower.includes(token)) {
      const match = system.references.find(ref => ref.organ === organ);
      if (match) return match.id;
    }
  }
  return system.references.find(ref => ref.id === "hra-liver-female")?.id ?? system.references[0]?.id ?? "";
}

export default function ImportedModelStudio() {
  const [session, setSession] = useState<Session | null>(null);
  const [liveTextures, setLiveTextures] = useState(0);
  const [system, setSystem] = useState<System | null>(null), [modelError, setModelError] = useState("");
  const [modelAttempt, setModelAttempt] = useState(0);
  const [referenceId, setReferenceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [severity, setSeverity] = useState<"auto" | "mild" | "moderate" | "severe">("auto");
  const [seamlessTextures, setSeamlessTextures] = useState(false);
  const [seed, setSeed] = useState("42"), [temperature, setTemperature] = useState(0.7);
  const [scope, setScope] = useState<"both" | "shape" | "texture">("both");
  const [shapeStrength, setShapeStrength] = useState(35), [textureStrength, setTextureStrength] = useState(35);
  const [prompt, setPrompt] = useState(""), [applied, setApplied] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0), [autoRotate, setAutoRotate] = useState(false), [dragging, setDragging] = useState(false);
  const viewport = useRef<ImportedViewportHandle>(null), files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null), request = useRef(0), pending = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++request.current; pending.current?.abort(); };
  }, []);
  useEffect(() => {
    let active = true;
    setModelError("");
    void loadImportedVariationSystem().then(value => {
      if (!active) return;
      setSystem(value);
      setReferenceId(prev => prev || inferReferenceForFilename(value, session?.model.filename ?? "liver"));
    }).catch(cause => { if (active) setModelError(readable(cause)); });
    return () => { active = false; };
  }, [modelAttempt]);
  useEffect(() => () => {
    if (session) { disposeVariationState(session.state); session.model.dispose(); }
  }, [session]);
  useEffect(() => {
    if (!busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [busy]);

  const selectedReference = system?.references.find(ref => ref.id === referenceId) ?? null;
  const organProfiles = system && selectedReference
    ? system.profiles.filter(profile => profile.organ === selectedReference.organ)
    : [];

  useEffect(() => {
    if (profileId && !organProfiles.some(profile => profile.id === profileId)) {
      setProfileId("");
    }
  }, [referenceId, profileId, organProfiles]);

  const begin = (label: string) => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const id = ++request.current;
    setBusy(label); setError(""); setNotice("");
    return { id, controller, current: () => mounted.current && request.current === id && !controller.signal.aborted };
  };
  const importFiles = async (selected: readonly File[]) => {
    if (!selected.length) return;
    const task = begin("Opening model…");
    let model: ImportedModel | null = null, state: State | null = null;
    try {
      model = await loadImportedModel(selected, task.controller.signal);
      if (!task.current()) { model.dispose(); return; }
      state = createVariationState(model.root);
      const untextured = model.stats.textures === 0;
      setSeamlessTextures(untextured);
      if (untextured) {
        setShapeStrength(prev => Math.max(prev, 55));
        setTextureStrength(prev => Math.max(prev, 75));
      }
      setLiveTextures(model.stats.textures);
      if (system && !referenceId) {
        setReferenceId(inferReferenceForFilename(system, model.filename));
      }
      setSession({ model, state }); setApplied(null); setRevision(value => value + 1);
      setAutoRotate(false); setNotice(`Opened ${model.filename}. Original geometry and materials are ready.`);
    } catch (cause) {
      if (state) disposeVariationState(state);
      model?.dispose();
      if (task.current()) setError(readable(cause));
    } finally { if (task.current()) setBusy(""); }
  };
  const apply = async (kind: "sample" | "next" | "text", overridePrompt?: string) => {
    if (!session || !system || !referenceId || busy) return;
    const textPrompt = overridePrompt ?? prompt;
    if (overridePrompt !== undefined) setPrompt(overridePrompt);
    const task = begin(kind === "text" ? "Applying text edits…" : "Generating variation…");
    try {
      if (!/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed)) || Number(seed) > 0xffffffff)
        throw new Error("Variation seed must be a whole number from 0 to 4,294,967,295.");
      const value = kind === "next" ? (Number(seed) + 1) % 0x100000000 : Number(seed);
      const recipe = kind === "text"
        ? compileImportedText(system, referenceId, textPrompt, applied?.recipe.reference.id === referenceId ? applied.recipe : undefined)
        : sampleNeuralVariation(system, {
            referenceId,
            seed: value,
            temperature,
            ...(profileId ? { profileId, severity } : {}),
          });
      const shape = scope === "texture" ? 0 : shapeStrength / 100;
      const texture = scope === "shape" ? 0 : textureStrength / 100;
      const report = await applyVariation(session.state, recipe, {
        shapeStrength: shape,
        textureStrength: texture,
        synthesizeSeamlessTextures: seamlessTextures,
        signal: task.controller.signal,
      });
      if (!task.current()) return;
      if (kind === "next") setSeed(String(value));
      const updatedStats = inspectImportedRoot(session.model.root);
      setLiveTextures(updatedStats.textures);
      setApplied({ recipe, report, shapeStrength: shape, textureStrength: texture, ...(kind === "text" ? { prompt: textPrompt } : {}) });
      setRevision(previous => previous + 1);
      setNotice(kind === "text" ? "Text edits applied. Export the GLB or restore the original at any time."
        : `Variation ${value} applied. The same seed and settings reproduce this result.`);
    } catch (cause) { if (task.current()) setError(readable(cause)); }
    finally { if (task.current()) setBusy(""); }
  };
  const reset = () => {
    if (!session || busy) return;
    resetVariation(session.state);
    setLiveTextures(session.model.stats.textures);
    setApplied(null); setRevision(value => value + 1);
    setError(""); setNotice("Original geometry, colours and materials restored.");
  };
  const exportModel = async () => {
    if (!session || busy) return;
    const task = begin("Preparing GLB…");
    try {
      const blob = await exportImportedModelGLB(session.model);
      if (task.current()) {
        const stem = session.model.filename.replace(/\.[^.]+$/, "").replace(/[^\w.-]/g, "_").slice(0, 100) || "model";
        save(blob, `${stem}-${applied ? "variation" : "original"}.glb`);
        setNotice("GLB prepared with the current geometry, colours and materials.");
      }
    } catch (cause) { if (task.current()) setError(readable(cause)); }
    finally { if (task.current()) setBusy(""); }
  };
  const exportRecipe = () => {
    if (!session || !applied) return;
    save(new Blob([JSON.stringify({ schema: "viscera.import-variation/v1", source: session.model.source,
      filename: session.model.filename, ...applied }, null, 2)], { type: "application/json" }), "viscera-variation.json");
  };
  const ready = Boolean(session && system && referenceId && !busy);

  return <div className={`import-studio${dragging ? " is-dragging" : ""}`}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); void importFiles(Array.from(event.dataTransfer.files)); }}>
    <header className="import-header">
      <a className="import-brand" href="?mode=atlas"><Box size={24} /><span>VISCERA<small>IMPORT LAB</small></span></a>
      <nav aria-label="Anatomy workspace"><a href="?mode=atlas">Organ studio</a><a href="?mode=imports" aria-current="page">Import 3D</a><a href="?mode=scene">Whole scene</a></nav>
      <div className="import-header-tools"><DisplaySettings /><VideoRecorderButton /></div>
    </header>
    <main className="import-workspace">
      <section className={`import-scene${session ? "" : " is-empty"}`} aria-label="Imported model scene" data-import-revision={revision}>
        <div className="import-scene-title"><span>{session ? session.model.filename : "YOUR MODEL, NEW POSSIBILITIES"}</span><span>{applied ? "VARIATION" : "ORIGINAL"}</span></div>
        <ImportedViewport ref={viewport} object={session?.model.root ?? null} revision={revision} autoRotate={autoRotate} onError={setError} />
        {!session && <div className="import-empty"><div className="import-empty-icon"><Upload size={34} /></div><h1>Bring your shape.<br />Explore its variations.</h1><p>Open a 3D export from Blender, Unity or another modelling tool. Keep its colours, then shape what comes next.</p><button className="import-primary" disabled={Boolean(busy)} onClick={() => files.current?.click()}><Upload size={17} />Upload 3D model</button><span>GLB · glTF · OBJ · STL</span></div>}
        {session && <div className="import-scene-toolbar"><button disabled={Boolean(busy)} onClick={() => viewport.current?.fit()}><Focus size={16} />Fit model</button><label><input type="checkbox" checked={autoRotate} onChange={event => setAutoRotate(event.target.checked)} />Turntable</label><span>Drag to orbit · scroll to zoom</span></div>}
        <SceneResizeHandle />
        {dragging && <div className="import-drop-overlay"><Upload size={36} /><strong>Drop your model and its assets</strong></div>}
      </section>
      <aside className="import-inspector" aria-label="Import and variation controls">
        <section>
          <div className="import-section-heading"><span>01 / SOURCE</span><FolderOpen size={17} /></div>
          <h2>{session ? "Model loaded" : "Start with a model"}</h2>
          <p>GLB is the simplest way to keep materials and textures together. For glTF or OBJ, include its buffer, MTL and image files.</p>
          <input ref={files} aria-label="3D model files" type="file" multiple accept=".glb,.gltf,.obj,.stl,.bin,.mtl,.png,.jpg,.jpeg" hidden onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; void importFiles(selected); }} />
          <input ref={node => { folder.current = node; node?.setAttribute("webkitdirectory", ""); }} aria-label="3D model folder" type="file" multiple hidden onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; void importFiles(selected); }} />
          <div className="import-source-actions"><button disabled={Boolean(busy)} onClick={() => files.current?.click()}><Upload size={16} />{session ? "Replace model" : "Choose files"}</button><button disabled={Boolean(busy)} onClick={() => folder.current?.click()}>Choose folder</button></div>
          <p className="import-fine">Files stay in this browser tab; export your result to keep it. Static meshes only. Bake procedural shaders to PNG or JPEG textures first.</p>
          {session && <><dl className="import-stats"><div><dt>Vertices</dt><dd>{count(session.model.stats.vertices)}</dd></div><div><dt>Triangles</dt><dd>{count(session.model.stats.triangles)}</dd></div><div><dt>Meshes</dt><dd>{count(session.model.stats.meshes)}</dd></div><div><dt>Textures</dt><dd>{count(liveTextures)}</dd></div></dl>
            {session.model.warnings.map((message, index) => <p className="import-notice" key={index}>{message}</p>)}</>}
        </section>
        <section>
          <div className="import-section-heading"><span>02 / GENERATE</span><Sparkles size={17} /></div><h2>Explore a variation</h2>
          <p>The bundled trained flow proposes shape and surface controls. Choose a reference style to transfer them onto your mesh.</p>
          {modelError ? <p role="alert" className="import-error">{modelError}<button onClick={() => setModelAttempt(value => value + 1)}>Retry model loading</button></p>
            : !system && <p role="status" className="import-fine">Loading generative model…</p>}
          <fieldset disabled={!session || !system || Boolean(busy)}>
            <label>Reference style<select aria-label="Reference style" value={referenceId} onChange={event => setReferenceId(event.target.value)}><option value="">Choose a reference style</option>{system?.references.map(reference => <option key={reference.id} value={reference.id}>{reference.label}</option>)}</select></label>
            <label>Joint pathology / condition<select aria-label="Joint pathology profile" value={profileId} onChange={event => setProfileId(event.target.value)}>
              <option value="">Healthy baseline (7D shape + 6D tissue)</option>
              {organProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label} ({profile.pattern})</option>)}
            </select></label>
            {profileId && <label>Disease severity band<select aria-label="Disease severity band" value={severity} onChange={event => setSeverity(event.target.value as typeof severity)}>
              <option value="auto">Auto (sampled by Joint Flow v2)</option>
              <option value="mild">Mild (10–35%)</option>
              <option value="moderate">Moderate (35–70%)</option>
              <option value="severe">Severe (70–100%)</option>
            </select></label>}
            <label>Vary<select aria-label="Variation scope" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="both">Shape and texture</option><option value="shape">Shape only</option><option value="texture">Texture only</option></select></label>
            <label className="import-checkbox-row"><input type="checkbox" aria-label="Synthesize seamless 3D PBR textures" checked={seamlessTextures} disabled={scope === "shape"} onChange={event => setSeamlessTextures(event.target.checked)} /><span>Synthesize seamless 3D PBR textures (BaseColor + Normal + Roughness)</span></label>
            <label>Shape strength<output>{shapeStrength}%</output><input type="range" aria-label="Shape strength" min="0" max="100" step="5" value={shapeStrength} disabled={scope === "texture"} onChange={event => setShapeStrength(Number(event.target.value))} /></label>
            <label>Texture blend<output>{textureStrength}%</output><input type="range" aria-label="Texture blend" min="0" max="100" step="5" value={textureStrength} disabled={scope === "shape"} onChange={event => setTextureStrength(Number(event.target.value))} /></label>
            <div className="import-pair"><label>Seed<input aria-label="Variation seed" type="number" min="0" max="4294967295" step="1" value={seed} onChange={event => setSeed(event.target.value)} /></label><label>Temperature<input aria-label="Flow temperature" type="number" min="0.1" max="1.5" step="0.1" value={temperature} onChange={event => setTemperature(Number(event.target.value))} /></label></div>
          </fieldset>
          <div className="import-generate-actions"><button className="import-primary" disabled={!ready} onClick={() => void apply("sample")}><Sparkles size={16} />Generate variation</button><button disabled={!ready} onClick={() => void apply("next")}><Shuffle size={16} />Next variation</button></div>
          <details><summary>How variations work</summary><p>The 22-DOF Joint Flow v2 samples coupled 3D shape, tissue material and optional pathology controls, transferring them onto the uploaded surface. Untextured meshes automatically receive seamless 3D rest-space PBR textures (BaseColor, Normal, Roughness) plus continuous 3D vertex colours.</p>{applied?.report.warnings.map((message, index) => <p key={index}>{message}</p>)}</details>
        </section>
        <section>
          <div className="import-section-heading"><span>03 / DESCRIBE</span></div><h2>Text-guided edits</h2>
          <label className="import-prompt-label">Describe a variation<textarea aria-label="Describe a variation" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={1000} rows={3} placeholder="wider; flatter; twist 0.2; wetter" disabled={Boolean(busy)} /></label>
          <p className="import-fine">Supported commands edit the recipe; they do not create new parts or topology. Unrecognised instructions are rejected.</p>
          <div className="import-describe-actions">
            <button disabled={!ready || !prompt.trim()} onClick={() => void apply("text")}><Sparkles size={16} />Apply text</button>
            <WhistleMicButton
              className="import-prompt-mic whistle-mic-btn"
              disabled={Boolean(busy)}
              onTranscript={(liveText) => setPrompt(liveText)}
              onCommit={(cleanText) => {
                setPrompt(cleanText);
                if (ready) void apply("text", cleanText);
              }}
            />
          </div>
          <details><summary>Supported text commands</summary><p>Try “wider”, “narrower”, “taller”, “shorter”, “deeper”, “flatter”, “wetter” or “drier”. Separate edits with semicolons. Explicit controls such as “twist 0.2” use values from −1 to 1. Percentages and physical dimensions are not supported.</p></details>
        </section>
        <section>
          <div className="import-section-heading"><span>04 / KEEP</span><ArrowDownToLine size={17} /></div><h2>Take it with you</h2>
          <div className="import-export-actions"><button className="import-primary" disabled={!session || Boolean(busy)} onClick={() => void exportModel()}><ArrowDownToLine size={16} />Export GLB</button><button disabled={!applied || Boolean(busy)} onClick={exportRecipe}>Download recipe</button><button disabled={!session || Boolean(busy)} onClick={reset}><RotateCcw size={16} />Restore original</button></div>
          <p className="import-fine">The GLB contains your current result. A recipe records the source hashes, model and controls for reproducibility.</p>
        </section>
      </aside>
    </main>
    <footer className="import-status" aria-live="polite">
      {busy ? <><span role="status"><LoaderCircle size={16} className="import-spinner" />{busy}</span><button onClick={() => {
        pending.current?.abort(); ++request.current; setBusy(""); setNotice("Operation cancelled. Your previous result is unchanged.");
      }}>Cancel operation</button></> : error ? <span role="alert" className="import-error">{error}</span> : <span role="status">{notice && <Check size={16} />}{notice || "Local import · reversible variations · portable GLB"}</span>}
    </footer>
  </div>;
}
