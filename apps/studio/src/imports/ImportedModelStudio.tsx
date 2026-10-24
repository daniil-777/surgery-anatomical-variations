import { OPERATIVE_REGIONS } from "../operativeView";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine, Box, Check, FolderOpen, Focus, Layers, LoaderCircle,
  Pause, Play, RotateCcw, Shuffle, Sparkles, Upload,
} from "lucide-react";
import { DisplaySettings, SceneResizeHandle } from "../DisplaySettings";
import { VideoRecorderButton } from "../VideoRecorderPanel";
import { WhistleMicButton } from "../whistleMic";
import { ImportedViewport, type ImportedCameraPreset, type ImportedViewportHandle } from "./ImportedViewport";
import { exportImportedModelGLB, inspectImportedRoot, loadImportedModel, type ImportedModel } from "./importModel";
import { LAPAROSCOPIC_SCENE_PRESETS, loadLaparoscopicSceneModel, type LaparoscopicScenePresetId } from "./laparoscopicScene";
import {
  applySceneVariation, applyVariation, compileImportedText, createVariationState,
  discoverSceneOrgans, disposeVariationState, loadImportedVariationSystem,
  resetVariation, sampleNeuralVariation,
  type MultiOrganSceneVariationReport, type SceneOrganAssignment,
} from "./variations";
import { tubularStructure } from "./tissueDetail";
import "./imports.css";

type System = Awaited<ReturnType<typeof loadImportedVariationSystem>>;
type Recipe = ReturnType<typeof sampleNeuralVariation>;
type State = ReturnType<typeof createVariationState>;
type Report = Awaited<ReturnType<typeof applyVariation>> | MultiOrganSceneVariationReport;
type Session = { model: ImportedModel; state: State };
type Applied = {
  recipe: Recipe;
  report: Report;
  shapeStrength: number;
  textureStrength: number;
  prompt?: string;
  multiOrganCount?: number;
};

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
  const [organAssignments, setOrganAssignments] = useState<SceneOrganAssignment[]>([]);
  const [liveTextures, setLiveTextures] = useState(0);
  const [system, setSystem] = useState<System | null>(null), [modelError, setModelError] = useState("");
  const [modelAttempt, setModelAttempt] = useState(0);
  const [referenceId, setReferenceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [severity, setSeverity] = useState<"auto" | "mild" | "moderate" | "severe">("auto");
  const [randomPathology, setRandomPathology] = useState(false);
  const [seamlessTextures, setSeamlessTextures] = useState(false);
  const [seed, setSeed] = useState("42"), [temperature, setTemperature] = useState(0.7);
  const [scope, setScope] = useState<"both" | "shape" | "texture">("both");
  const [shapeStrength, setShapeStrength] = useState(35), [textureStrength, setTextureStrength] = useState(35);
  const [prompt, setPrompt] = useState(""), [applied, setApplied] = useState<Applied | null>(null);
  const [autoVary, setAutoVary] = useState(false);
  const [autoVaryIntervalMs, setAutoVaryIntervalMs] = useState(1800);
  const [autoVaryCount, setAutoVaryCount] = useState(0);
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

  useEffect(() => {
    if (session && system && organAssignments.length === 0) {
      setOrganAssignments(discoverSceneOrgans(session.state, system));
    }
  }, [session, system, organAssignments.length]);

  useEffect(() => () => {
    if (session) { disposeVariationState(session.state); session.model.dispose(); }
  }, [session]);

  useEffect(() => {
    if (!busy) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [busy]);

  const isMultiOrganScene = organAssignments.length > 1;
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
    setAutoVary(false);
    const task = begin(selected.length > 1 ? `Opening ${selected.length} files…` : "Opening model…");
    let model: ImportedModel | null = null, state: State | null = null;
    try {
      model = await loadImportedModel(selected, task.controller.signal, { allowMultiModelScene: true });
      if (!task.current()) { model.dispose(); return; }
      state = createVariationState(model.root);
      const untextured = model.stats.textures === 0;
      setSeamlessTextures(untextured);
      if (untextured) {
        setShapeStrength(prev => Math.max(prev, 55));
        setTextureStrength(prev => Math.max(prev, 85));
      }
      setLiveTextures(model.stats.textures);
      const discovered = system ? discoverSceneOrgans(state, system) : [];
      setOrganAssignments(discovered);
      if (system) {
        setReferenceId(discovered[0]?.referenceId || inferReferenceForFilename(system, model.filename));
      }
      setSession({ model, state });
      setApplied(null);
      setAutoVaryCount(0);
      setRevision(value => value + 1);
      setAutoRotate(false);
      setNotice(
        discovered.length > 1
          ? `Opened ${model.filename} (${discovered.length} 3D organs detected and classified). Ready to vary shapes and textures.`
          : `Opened ${model.filename}. Original geometry and materials are ready.`,
      );
    } catch (cause) {
      if (state) disposeVariationState(state);
      model?.dispose();
      if (task.current()) setError(readable(cause));
    } finally { if (task.current()) setBusy(""); }
  };

  const loadLaparoscopicPreset = async (presetId: LaparoscopicScenePresetId) => {
    setAutoVary(false);
    const task = begin("Loading co-registered laparoscopic 3D scene…");
    let model: ImportedModel | null = null, state: State | null = null;
    try {
      model = await loadLaparoscopicSceneModel(presetId, task.controller.signal);
      if (!task.current()) { model.dispose(); return; }
      state = createVariationState(model.root);
      const activeSystem = system ?? await loadImportedVariationSystem(task.controller.signal);
      if (!task.current()) { disposeVariationState(state); model.dispose(); return; }
      if (!system) setSystem(activeSystem);

      const discovered = discoverSceneOrgans(state, activeSystem);
      setOrganAssignments(discovered);
      setReferenceId(discovered[0]?.referenceId ?? "hra-liver-female");
      setSeamlessTextures(true);
      const nextShape = Math.max(shapeStrength, 45);
      const nextTexture = Math.max(textureStrength, 88);
      setShapeStrength(nextShape);
      setTextureStrength(nextTexture);

      // Immediately synthesize authentic organ-specific 3D seamless PBR textures across all co-registered organs
      const initialSeed = /^\d+$/.test(seed) ? Number(seed) : 42;
      const sceneReport = await applySceneVariation(state, activeSystem, {
        seed: initialSeed,
        temperature,
        assignments: discovered,
        severity,
        randomPathology,
        shapeStrength: nextShape / 100,
        textureStrength: nextTexture / 100,
        synthesizeSeamlessTextures: true,
        signal: task.controller.signal,
      });
      if (!task.current()) { disposeVariationState(state); model.dispose(); return; }
      const updatedStats = inspectImportedRoot(model.root);
      setLiveTextures(updatedStats.textures);
      setSession({ model, state });
      setApplied({
        recipe: sceneReport.organReports[0]!.recipe,
        report: sceneReport,
        shapeStrength: nextShape / 100,
        textureStrength: nextTexture / 100,
        multiOrganCount: discovered.length,
      });
      setAutoVaryCount(1);
      setRevision(value => value + 1);
      setAutoRotate(false);
      setNotice(
        `Loaded ${model.filename}: ${discovered.length} co-registered anatomical structures with ${updatedStats.textures} seamless 3D PBR tissue maps.`,
      );
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
    const task = begin(kind === "text" ? "Applying text edits…" : isMultiOrganScene ? `Varying ${organAssignments.length} scene organs…` : "Generating variation…");
    try {
      if (!/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed)) || Number(seed) > 0xffffffff)
        throw new Error("Variation seed must be a whole number from 0 to 4,294,967,295.");
      const value = kind === "next" ? (Number(seed) + 1) % 0x100000000 : Number(seed);
      const shape = scope === "texture" ? 0 : shapeStrength / 100;
      const texture = scope === "shape" ? 0 : textureStrength / 100;

      if (isMultiOrganScene && kind !== "text") {
        const sceneReport = await applySceneVariation(session.state, system, {
          seed: value,
          temperature,
          assignments: organAssignments,
          severity,
          randomPathology,
          shapeStrength: shape,
          textureStrength: texture,
          synthesizeSeamlessTextures: seamlessTextures,
          signal: task.controller.signal,
        });
        if (!task.current()) return;
        if (kind === "next") setSeed(String(value));
        const updatedStats = inspectImportedRoot(session.model.root);
        setLiveTextures(updatedStats.textures);
        setApplied({
          recipe: sceneReport.organReports[0]!.recipe,
          report: sceneReport,
          shapeStrength: shape,
          textureStrength: texture,
          multiOrganCount: organAssignments.length,
        });
        setAutoVaryCount(c => c + 1);
        setRevision(previous => previous + 1);
        setNotice(`Scene variation ${value} applied across ${organAssignments.length} co-registered organs (${updatedStats.textures} PBR maps).`);
        return;
      }

      const recipe = kind === "text"
        ? compileImportedText(system, referenceId, textPrompt, applied?.recipe.reference.id === referenceId ? applied.recipe : undefined)
        : sampleNeuralVariation(system, {
            referenceId,
            seed: value,
            temperature,
            ...(profileId ? { profileId, severity } : {}),
          });
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
      setAutoVaryCount(c => c + 1);
      setRevision(previous => previous + 1);
      setNotice(kind === "text" ? "Text edits applied. Export the GLB or restore the original at any time."
        : `Variation ${value} applied. The same seed and settings reproduce this result.`);
    } catch (cause) { if (task.current()) setError(readable(cause)); }
    finally { if (task.current()) setBusy(""); }
  };

  // Endless automatic scene variation loop
  useEffect(() => {
    if (!autoVary || !session || !system || !referenceId || busy) return;
    const timer = window.setTimeout(() => {
      void apply("next");
    }, autoVaryIntervalMs);
    return () => window.clearTimeout(timer);
  }, [autoVary, autoVaryIntervalMs, session, system, referenceId, busy, seed, revision]);

  const updateOrganAssignment = (slotId: string, patch: Partial<Pick<SceneOrganAssignment, "referenceId" | "profileId">>) => {
    if (!system) return;
    setOrganAssignments(current => current.map(item => {
      if (item.slotId !== slotId) return item;
      const nextRefId = patch.referenceId ?? item.referenceId;
      const refObj = system.references.find(r => r.id === nextRefId) ?? system.references[0]!;
      let nextProfId = patch.profileId !== undefined ? patch.profileId : item.profileId;
      if (nextProfId && !system.profiles.some(p => p.id === nextProfId && p.organ === refObj.organ)) {
        nextProfId = null;
      }
      return {
        ...item,
        referenceId: refObj.id,
        organ: refObj.organ,
        profileId: nextProfId,
      };
    }));
  };

  const reset = () => {
    if (!session || busy) return;
    setAutoVary(false);
    resetVariation(session.state);
    setLiveTextures(session.model.stats.textures);
    setApplied(null); setRevision(value => value + 1);
    setError(""); setNotice("Original geometry, colours and materials restored.");
  };

  const exportModel = async () => {
    if (!session || busy) return;
    setAutoVary(false);
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

  const setCameraView = (preset: ImportedCameraPreset) => {
    setAutoRotate(false);
    viewport.current?.view(preset);
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
        <div className="import-scene-title">
          <span>{session ? `${session.model.filename}${isMultiOrganScene ? ` · ${organAssignments.length} STRUCTURES` : ""}` : "YOUR MODEL OR LAPAROSCOPIC SCENE, NEW POSSIBILITIES"}</span>
          <span>{autoVary ? `AUTO-VARYING #${autoVaryCount} · SEED ${seed}` : applied ? `VARIATION · SEED ${seed}` : "ORIGINAL"}</span>
        </div>
        <ImportedViewport ref={viewport} object={session?.model.root ?? null} revision={revision} autoRotate={autoRotate} onError={setError} />
        {!session && <div className="import-empty">
          <div className="import-empty-icon"><Upload size={34} /></div>
          <h1>Bring a 3D organ or<br />a whole laparoscopic scene.</h1>
          <p>Upload one or more 3D organ meshes (GLB, glTF, OBJ, STL), or open the co-registered human laparoscopic multi-organ 3D scene to vary shapes and seamless 3D textures endlessly.</p>
          <div className="import-empty-actions">
            <button className="import-primary" disabled={Boolean(busy)} onClick={() => files.current?.click()}><Upload size={17} />Upload 3D model / scene</button>
            <button disabled={Boolean(busy)} onClick={() => void loadLaparoscopicPreset("full-laparoscopy")}><Layers size={17} />Load laparoscopic 3D scene (24 structures)</button>
          </div>
          <span>GLB · glTF · OBJ · STL · Multi-Organ Laparoscopy</span>
        </div>}
        {session && <div className="import-scene-toolbar">
          <button disabled={Boolean(busy)} onClick={() => viewport.current?.fit()}><Focus size={16} />Fit</button>
          <div className="import-camera-presets" role="group" aria-label="Surgical camera views">
            <button type="button" disabled={Boolean(busy)} onClick={() => setCameraView("anterior")}>Anterior</button>
            {isMultiOrganScene && OPERATIVE_REGIONS.map(region => <button key={region.id} type="button" disabled={Boolean(busy)} onClick={() => {setAutoRotate(false);viewport.current?.inspect(region.id);}} title={region.description}>Scope: {region.label}</button>)}
            <button type="button" disabled={Boolean(busy)} onClick={() => setCameraView("subhepatic")} title="30° subhepatic laparoscope view into Calot’s triangle and gallbladder fossa">30° Subhepatic</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => setCameraView("hepatobiliary")}>Hepatobiliary (R)</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => setCameraView("foregut")}>Foregut &amp; Spleen (L)</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => setCameraView("posterior")}>Retroperitoneal</button>
          </div>
          <label><input type="checkbox" checked={autoRotate} onChange={event => setAutoRotate(event.target.checked)} />Turntable</label>
          <span>Drag to orbit · scroll to zoom</span>
        </div>}
        <SceneResizeHandle />
        {dragging && <div className="import-drop-overlay"><Upload size={36} /><strong>Drop your 3D organ or multi-organ laparoscopic scene files</strong></div>}
      </section>
      <aside className="import-inspector" aria-label="Import and variation controls">
        <section>
          <div className="import-section-heading"><span>01 / SOURCE</span><FolderOpen size={17} /></div>
          <h2>{session ? (isMultiOrganScene ? `Multi-organ scene (${organAssignments.length} structures)` : "Model loaded") : "Start with a model or 3D scene"}</h2>
          <p>Select a single 3D model, multiple 3D organ files at once, or a multi-organ laparoscopic scene.</p>
          <input ref={files} aria-label="3D model files" type="file" multiple accept=".glb,.gltf,.obj,.stl,.bin,.mtl,.png,.jpg,.jpeg" hidden onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; void importFiles(selected); }} />
          <input ref={node => { folder.current = node; node?.setAttribute("webkitdirectory", ""); }} aria-label="3D model folder" type="file" multiple hidden onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; void importFiles(selected); }} />
          <div className="import-source-actions">
            <button disabled={Boolean(busy)} onClick={() => files.current?.click()}><Upload size={16} />{session ? "Replace / upload files" : "Choose files"}</button>
            <button disabled={Boolean(busy)} onClick={() => folder.current?.click()}>Choose folder</button>
          </div>
          <div className="import-preset-box" aria-label="Co-registered laparoscopic 3D scene presets">
            <strong><Layers size={14} />Co-registered human laparoscopic 3D scenes</strong>
            <p className="import-fine">BodyParts3D abdominal structures in their shared atlas coordinates, with refined surfaces:</p>
            <div className="import-preset-actions">
              {LAPAROSCOPIC_SCENE_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={Boolean(busy)}
                  title={preset.description}
                  onClick={() => void loadLaparoscopicPreset(preset.id)}
                >
                  <Sparkles size={14} />{preset.shortLabel}
                </button>
              ))}
            </div>
          </div>
          {session && <><dl className="import-stats"><div><dt>Vertices</dt><dd>{count(session.model.stats.vertices)}</dd></div><div><dt>Triangles</dt><dd>{count(session.model.stats.triangles)}</dd></div><div><dt>Organs / Meshes</dt><dd>{count(session.model.stats.meshes)}</dd></div><div><dt>Textures</dt><dd>{count(liveTextures)}</dd></div></dl>
            {session.model.warnings.map((message, index) => <p className="import-notice" key={index}>{message}</p>)}</>}
        </section>
        <section>
          <div className="import-section-heading"><span>02 / GENERATE</span><Sparkles size={17} /></div>
          <h2>{isMultiOrganScene ? "Multi-organ coupled variations" : "Explore a variation"}</h2>
          <p>{isMultiOrganScene
            ? "Each organ in the scene receives its own coupled 22-DOF Joint Flow v2 shape, 3D seamless PBR tissue maps and pathology while preserving shared anatomical contact interfaces."
            : "The bundled trained flow proposes shape and surface controls. Choose a reference style to transfer them onto your mesh."}</p>
          {modelError ? <p role="alert" className="import-error">{modelError}<button onClick={() => setModelAttempt(value => value + 1)}>Retry model loading</button></p>
            : !system && <p role="status" className="import-fine">Loading generative model…</p>}

          {session && system && isMultiOrganScene && (
            <div className="import-organ-panel" aria-label="Scene organ assignments">
              <div className="import-organ-panel-head">
                <span>DETECTED SCENE ORGANS ({organAssignments.length})</span>
                <span>CO-REGISTERED</span>
              </div>
              <div className="import-organ-list">
                {organAssignments.map(slot => {
                  const supportStructure = Boolean(tubularStructure(slot.name)) || /mesentery/i.test(slot.name);
                  const slotProfiles = supportStructure ? [] : system.profiles.filter(p => p.organ === slot.organ);
                  return (
                    <div className="import-organ-card" key={slot.slotId}>
                      <div className="import-organ-card-top">
                        <strong>{slot.name.replace(/[-_]/g, " ")}</strong>
                        <small>{count(slot.vertices)}v · {count(slot.triangles)}t</small>
                      </div>
                      <div className="import-organ-card-selects">
                        <select
                          aria-label={`Reference for ${slot.name}`}
                          value={slot.referenceId}
                          disabled={Boolean(busy) || supportStructure}
                          onChange={event => updateOrganAssignment(slot.slotId, { referenceId: event.target.value })}
                        >
                          {supportStructure ? <option value={slot.referenceId}>{/mesentery/i.test(slot.name) ? "Connective tissue" : "Vessel / duct wall"}</option> : system.references.map(ref => (
                            <option key={ref.id} value={ref.id}>{ref.label}</option>
                          ))}
                        </select>
                        <select
                          aria-label={`Pathology for ${slot.name}`}
                          value={slot.profileId ?? ""}
                          disabled={Boolean(busy) || supportStructure}
                          onChange={event => updateOrganAssignment(slot.slotId, { profileId: event.target.value || null })}
                        >
                          <option value="">Healthy baseline</option>
                          {slotProfiles.map(prof => (
                            <option key={prof.id} value={prof.id}>{prof.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <fieldset disabled={!session || !system || Boolean(busy)}>
            {!isMultiOrganScene && <>
              <label>Reference style<select aria-label="Reference style" value={referenceId} onChange={event => setReferenceId(event.target.value)}><option value="">Choose a reference style</option>{system?.references.map(reference => <option key={reference.id} value={reference.id}>{reference.label}</option>)}</select></label>
              <label>Joint pathology / condition<select aria-label="Joint pathology profile" value={profileId} onChange={event => setProfileId(event.target.value)}>
                <option value="">Healthy baseline (7D shape + 6D tissue)</option>
                {organProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label} ({profile.pattern})</option>)}
              </select></label>
            </>}
            {isMultiOrganScene && (
              <label className="import-checkbox-row">
                <input
                  type="checkbox"
                  aria-label="Auto-sample multi-organ clinical pathology"
                  checked={randomPathology}
                  onChange={event => setRandomPathology(event.target.checked)}
                />
                <span>Auto-sample clinical pathology across scene organs (cirrhosis, cholecystitis, pancreatitis, cysts, tumours)</span>
              </label>
            )}
            {(profileId || isMultiOrganScene) && <label>Disease severity band<select aria-label="Disease severity band" value={severity} onChange={event => setSeverity(event.target.value as typeof severity)}>
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
          <div className="import-generate-actions">
            <button className="import-primary" disabled={!ready} onClick={() => void apply("sample")}><Sparkles size={16} />{isMultiOrganScene ? "Generate scene variation" : "Generate variation"}</button>
            <button disabled={!ready} onClick={() => void apply("next")}><Shuffle size={16} />Next variation</button>
          </div>

          <div className="import-autovary-bar" aria-label="Endless automatic variation stream">
            <div className="import-autovary-row">
              <button
                type="button"
                className={`import-autovary-btn${autoVary ? " is-active" : ""}`}
                aria-pressed={autoVary}
                disabled={!session || !system || !referenceId}
                onClick={() => setAutoVary(current => !current)}
              >
                {autoVary ? <Pause size={16} /> : <Play size={16} />}
                {autoVary ? "Pause endless auto-vary" : "Auto-vary scene endlessly"}
              </button>
              <select
                aria-label="Auto-vary cadence"
                value={autoVaryIntervalMs}
                onChange={event => setAutoVaryIntervalMs(Number(event.target.value))}
              >
                <option value={1100}>Fast (1.1s)</option>
                <option value={1800}>Balanced (1.8s)</option>
                <option value={3000}>Study (3.0s)</option>
              </select>
            </div>
            <div className="import-autovary-live">
              <span>{autoVary ? "LIVE GENERATIVE STREAM ACTIVE" : "CONTINUOUS STREAM READY"}</span>
              <span>#{autoVaryCount} · SEED {seed}</span>
            </div>
          </div>

          <details><summary>How multi-organ scene variations work</summary><p>The trained flow proposes shape, surface and optional disease variations for each organ. Nearby surfaces share their overall movement, with local changes reduced near sampled contacts. The results are illustrative anatomical variations; contact damping does not guarantee collision-free geometry.</p>{applied?.report.warnings.map((message, index) => <p key={index}>{message}</p>)}</details>
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
        setAutoVary(false); pending.current?.abort(); ++request.current; setBusy(""); setNotice("Operation cancelled. Your previous result is unchanged.");
      }}>Cancel operation</button></> : error ? <span role="alert" className="import-error">{error}</span> : <span role="status">{notice && <Check size={16} />}{notice || "Local import · co-registered multi-organ scenes · reversible variations · portable GLB"}</span>}
    </footer>
  </div>;
}
