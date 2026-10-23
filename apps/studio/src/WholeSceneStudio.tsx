import { VideoRecorderButton } from "./VideoRecorderPanel";
import { DisplaySettings, SceneResizeHandle } from "./DisplaySettings";
import { publicUrl } from "./api";
import type { FatSceneOptions } from "./fat/sceneLayerView";
import { ApiNotice } from "./ApiNotice";
import { useEffect, useRef, useState } from "react";
import { Activity, ArrowLeft, ArrowDown, ArrowUp, Camera, Check, ChevronRight, Eye, EyeOff, Focus, Hand, Layers3, LoaderCircle, MousePointer2, Move3D, Pause, Play, RotateCcw, Shuffle, Video, X } from "lucide-react";
import { WholeSceneViewport, type WholeSceneViewportHandle, type WholeSceneStats, type WholeSceneToolMode, type WholeSceneToolState, type WholeSceneNavigationState } from "./WholeSceneViewport";
import { BASELINE_VARIATION, createWholeSceneVariation, type WholeSceneCategory } from "./wholeSceneModel";
import { readLearnedSceneMaterials, type LearnedSceneMaterials } from "./wholeScenePhysics";
import { ReferenceMaterialPanel } from "./ReferenceMaterialPanel";
import { WholeBodyReferencePanel } from "./WholeBodyReferencePanel";
import type { WholeBodyColorPlan } from "./wholeBodyColor";
import { REFERENCE_ORGAN_IDS } from "./referenceColor";
import type { ReferenceColor } from "./atlasMaterial";
import "./wholeScene.css";

const categories: { id: WholeSceneCategory; label: string; color: string }[] = [
  { id: "digestive", label: "Digestive organs", color: "#c98677" },
  { id: "respiratory", label: "Lungs & airways", color: "#bf939c" },
  { id: "cardiovascular", label: "Heart & vessels", color: "#aa5354" },
  { id: "urinary", label: "Urinary system", color: "#b58065" },
  { id: "connective", label: "Diaphragm & supports", color: "#bfa09b" },
  { id: "skeleton", label: "Skeletal landmarks", color: "#d2cabb" },
];
const views = [
  ["front", "Front"], ["back", "Back"], ["left", "Left"], ["right", "Right"], ["top", "Top"], ["bottom", "Bottom"], ["oblique", "¾ view"],
] as const;
const dissections = [
  { id: "full", label: "Full torso", hidden: [] },
  { id: "laparoscopic", label: "Laparoscopic", hidden: ["right-lung", "left-lung", "heart", "trachea", "bronchi", "diaphragm", "esophagus", "aorta", "vena-cava", "urinary-bladder"] },
  { id: "abdominal", label: "Abdominal", hidden: ["right-lung", "left-lung", "heart", "trachea", "bronchi", "diaphragm"] },
  { id: "deep", label: "Deep anatomy", hidden: ["right-lung", "left-lung", "heart", "trachea", "bronchi", "diaphragm", "liver", "stomach", "colon", "small-intestine"] },
] as const;
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
interface ReferenceState { colors: Record<string, ReferenceColor>; plan: WholeBodyColorPlan | null }
function withoutPlanTarget(plan: WholeBodyColorPlan | null, target: string): WholeBodyColorPlan | null {
  if (!plan || !plan.assignments[target]) return plan;
  const assignments = { ...plan.assignments }, referenceColors = { ...plan.referenceColors };
  delete assignments[target]; delete referenceColors[target];
  return Object.keys(assignments).length ? { ...plan, assignments, referenceColors, warnings: [...plan.warnings, `Individual reference edit superseded the whole-body assignment for ${target}.`] } : null;
}

export default function WholeSceneStudio({ onBack, textureLab = false }: { onBack: () => void; textureLab?: boolean }) {
  const viewport = useRef<WholeSceneViewportHandle>(null);
  const [variation, setVariation] = useState(BASELINE_VARIATION);
  const [fatOptions, setFatOptions] = useState<FatSceneOptions>(() => ({ enabled: new URLSearchParams(location.search).get("fat") === "1", seed: 42, thicknessMm: 5, omentum: true, perirenal: true, lighting: "studio", study: "tissue", wetness: .52 }));
  const [fatStatus, setFatStatus] = useState("disabled");
  const [seed, setSeed] = useState("42");
  const [strength, setStrength] = useState(0.65);
  const [severity, setSeverity] = useState(0.35);
  const [autoVarying, setAutoVarying] = useState(false);
  const [visibility, setVisibility] = useState<Partial<Record<WholeSceneCategory, boolean>>>({ skeleton: false });
  const [breathing, setBreathing] = useState(false);
  const [photoDetail, setPhotoDetail] = useState(textureLab ? 0.6 : 0);   // photo-derived surface detail (photoDetail.ts): the texture lab's layer, 0 = the plain materials
  const [autoRotate, setAutoRotate] = useState(false);
  const [navigation, setNavigation] = useState<WholeSceneNavigationState | null>(null);
  const exploring = navigation?.mode === "explore";
  const [cameraControlsExpanded, setCameraControlsExpanded] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [referenceState, setReferenceState] = useState<ReferenceState>({ colors: {}, plan: null });
  const [previousReferences, setPreviousReferences] = useState<ReferenceState | null>(null);
  const [showPreviousReferences, setShowPreviousReferences] = useState(false);
  const displayedReferences = showPreviousReferences && previousReferences ? previousReferences : referenceState;
  const referenceColors = referenceState.colors;
  const [hiddenOrgans, setHiddenOrgans] = useState<string[]>([]);
  const [dissection, setDissection] = useState<string | null>("full");
  const [stats, setStats] = useState<WholeSceneStats | null>(null);
  const [view, setView] = useState<typeof views[number][0] | "orbit">("front");
  const [recording, setRecording] = useState(false);
  const [recordingKind, setRecordingKind] = useState<"tour" | "interaction" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("Original atlas arrangement");
  const [panel, setPanel] = useState<"scene" | "references" | "body">("scene");
  const controlsPanel = useRef<HTMLElement>(null);
  const sceneStage = useRef<HTMLElement>(null);
  const [physicsMaterials, setPhysicsMaterials] = useState<LearnedSceneMaterials | null>(null);
  const [physicsLoading, setPhysicsLoading] = useState(false);
  const [physicsRunning, setPhysicsRunning] = useState(false);
  const [toolMode, setToolMode] = useState<WholeSceneToolMode>("orbit");
  const [toolRadius, setToolRadius] = useState(6);
  const [toolDepth, setToolDepth] = useState(2);
  const [continuousPush, setContinuousPush] = useState(false);
  const [pushSpeed, setPushSpeed] = useState(3);
  const [toolStatus, setToolStatus] = useState<WholeSceneToolState | null>(null);
  const physicsRequest = useRef<AbortController | null>(null);
  useEffect(() => () => physicsRequest.current?.abort(), []);
  const ready = Boolean(stats) && navigation?.ready !== false;
  const selectedInfo = stats?.organs.find(organ => organ.id === selected);
  const instrumentsReady = Boolean(!exploring && physicsMaterials && physicsRunning && !physicsLoading && toolStatus?.ready && recordingKind !== "tour");
  function enterExploration() {
    viewport.current?.releaseTool(); setToolMode("orbit"); setAutoRotate(false); setBreathing(false); setPhysicsRunning(false);
    requestAnimationFrame(() => viewport.current?.enterExploration());
    if (window.matchMedia("(max-width: 760px)").matches) sceneStage.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }
  function chooseTool(mode: WholeSceneToolMode) {
    viewport.current?.exitExploration();
    viewport.current?.releaseTool(); setToolMode(mode); setAutoRotate(false);
    setNotice(mode === "orbit" ? "Camera navigation" : mode === "push" ? "Blunt palpator · click a surface to attach, then move" : "Fenestrated grasper · click a surface to attach, then move");
    if (window.matchMedia("(max-width: 760px)").matches) sceneStage.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  }

  function selectDissection(id: typeof dissections[number]["id"]) {
    viewport.current?.releaseTool();
    const preset = dissections.find(item => item.id === id)!;
    setHiddenOrgans([...preset.hidden]); setVisibility({ skeleton: false }); setDissection(id);
    setSelected(null); setAutoRotate(false); setView("oblique"); viewport.current?.view("oblique");
    setNotice(id === "full" ? "All soft structures visible" : `${preset.label} · overlying structures hidden`);
  }
  function toggleOrgan(id: string) {
    viewport.current?.releaseTool();
    setDissection(null);
    setHiddenOrgans(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    if (selected === id) setSelected(null);
  }
  function focusOrgan(id: string) {
    viewport.current?.releaseTool();
    const organ = stats?.organs.find(item => item.id === id); if (!organ) return;
    if (hiddenOrgans.includes(id) || visibility[organ.category] === false) setDissection(null);
    setHiddenOrgans(current => current.filter(item => item !== id));
    setVisibility(current => ({ ...current, [organ.category]: true })); setSelected(id);
    setAutoRotate(false); setView("orbit"); viewport.current?.focusOrgan(id);
    if (window.matchMedia("(max-width: 760px)").matches) sceneStage.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  }

  async function applyPhysics() {
    physicsRequest.current?.abort();
    const controller = new AbortController(); physicsRequest.current = controller;
    setPhysicsLoading(true); setError("");
    try {
      const response = await fetch(publicUrl("anatomy-scene/learned-materials.json"), { signal: controller.signal });
      if (!response.ok) throw new Error("Learned scene materials could not be loaded. The current scene is preserved.");
      const data = readLearnedSceneMaterials(await response.json());
      const assigned = new Set(data.materials.map(material => material.id));
      if (stats?.organs.some(organ => organ.category !== "skeleton" && !assigned.has(organ.id))) throw new Error("Material assignments are incomplete. No physics was applied.");
      setPhysicsMaterials(data); setPhysicsRunning(true); setBreathing(true);
      setNotice(`Learned materials applied · ${data.materials.length} soft structures`);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Physics could not be applied.");
    } finally { if (!controller.signal.aborted) setPhysicsLoading(false); }
  }

  function vary(fresh: boolean) {
    const parsed = fresh ? crypto.getRandomValues(new Uint32Array(1))[0]! : Number(seed);
    if (!/^\d+$/.test(String(parsed)) || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 4294967295 || (!fresh && !seed.trim())) {
      setError("Enter a whole-number seed between 0 and 4,294,967,295."); return;
    }
    const next = fresh && parsed === variation.seed ? (parsed + 1) >>> 0 : parsed;
    setSeed(String(next)); setError("");
    setVariation(createWholeSceneVariation(next, strength, severity));
    setNotice(`Joint variation · seed ${next}`);
  }
  function restore() {
    setAutoVarying(false);
    setReferenceState({ colors: {}, plan: null }); setPreviousReferences(null); setShowPreviousReferences(false);
    setVariation(BASELINE_VARIATION); setError(""); setNotice("Original atlas arrangement restored");
  }
  useEffect(() => {
    if (!autoVarying || !ready || recording) return;
    const timer = window.setInterval(() => {
      const next = crypto.getRandomValues(new Uint32Array(1))[0]!;
      setSeed(String(next));
      setVariation(createWholeSceneVariation(next, strength, severity));
      setNotice(`Endless joint variation · seed ${next}`);
    }, 2400);
    return () => window.clearInterval(timer);
  }, [autoVarying, ready, recording, strength, severity]);
  function changeView(id: typeof views[number][0]) {
    viewport.current?.releaseTool();
    setAutoRotate(false); setView(id); viewport.current?.view(id);
  }
  function capture() {
    try {
      const data = viewport.current?.screenshot(); if (!data) throw new Error("The scene is still loading.");
      const anchor = document.createElement("a"); anchor.href = data; anchor.download = `viscera-whole-scene-${variation.seed}-${view}.png`; anchor.click();
      setNotice("Scene image saved");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Image could not be saved."); }
  }
  async function record() {
    if (!viewport.current || recording) return;
    viewport.current.releaseTool(); setToolMode("orbit"); setRecordingKind("tour");
    setError(""); setAutoRotate(false); setView("orbit"); setRecording(true); setNotice("Recording a 12-second camera orbit…");
    try {
      const blob = await viewport.current.recordTour(12);
      download(blob, `viscera-whole-scene-${variation.seed}-tour.webm`); setNotice("Camera tour saved");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Video could not be recorded."); }
    finally { setRecording(false); setRecordingKind(null); }
  }
  async function recordInteraction() {
    if (!viewport.current || recording || !instrumentsReady) return;
    setError(""); setAutoRotate(false); setRecordingKind("interaction"); setRecording(true);
    setNotice("Recording 20 seconds of instrument interaction…");
    try {
      const blob = await viewport.current.recordInteraction(20);
      download(blob, `viscera-whole-scene-${variation.seed}-instruments.webm`);
      setNotice("Instrument recording saved");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Interaction could not be recorded."); }
    finally { setRecording(false); setRecordingKind(null); }
  }

  return <div className="whole-scene-studio">
    <header className="whole-header">
      <button className="whole-brand" onClick={onBack} aria-label="Back to organ studio"><Activity size={22} /><span>VISCERA <small>ATLAS</small></span></button>
      <nav className="anatomy-workspace-tabs" aria-label="Anatomy workspace"><button onClick={onBack}>Organ studio</button><button aria-current="page">Whole scene</button><button onClick={() => { window.location.href = "?mode=imports"; }}>Import 3D</button><button onClick={() => { window.location.href = "?mode=fat"; }}>Fat lab</button></nav>
      <DisplaySettings /><VideoRecorderButton /><span className="whole-header-note">A body, in context.</span>
      <button className="whole-button whole-image-button" disabled={!ready || recording} onClick={capture}><Camera size={14} />Save image</button>
      <button className="whole-button whole-record-button" disabled={!ready || exploring} onClick={() => recording ? viewport.current?.stopRecording() : void record()}><Video size={14} />{recording ? "Stop recording" : "Record tour"}</button>
      <ApiNotice />
    </header>

    <main ref={sceneStage} className={`whole-stage${physicsMaterials ? " whole-stage-instruments" : ""}${exploring ? " whole-exploring" : ""}`} aria-label="Connected anatomy scene" onPointerDownCapture={event => { if ((event.target as HTMLElement).tagName === "CANVAS" && toolMode === "orbit") setView("orbit"); }}>
      <SceneResizeHandle />
      <WholeSceneViewport ref={viewport} fatOptions={fatOptions} onFatStatus={setFatStatus} variation={variation} visibility={visibility} hiddenOrgans={hiddenOrgans} breathing={breathing} photoDetail={photoDetail} autoRotate={autoRotate} selectedOrgan={selected} onSelect={setSelected} onReady={setStats} onError={setError} onRecordingChange={setRecording} physicsMaterials={physicsMaterials} physicsRunning={physicsRunning} referenceColors={displayedReferences.colors} bodyReferencePlan={displayedReferences.plan} toolMode={toolMode} toolRadiusMm={toolRadius} toolDepthMm={toolDepth} continuousPush={continuousPush} pushSpeedMmS={pushSpeed} onToolStatus={setToolStatus} onNavigationChange={setNavigation} />
      {exploring && <section className="whole-exploration" aria-label="Interior camera controls">
        <div className="whole-exploration-heading"><strong>Between-organ inspection</strong><button type="button" aria-label={cameraControlsExpanded ? "Collapse camera controls" : "Expand camera controls"} aria-expanded={cameraControlsExpanded} onClick={() => setCameraControlsExpanded(value => !value)}>{cameraControlsExpanded ? "−" : "+"}</button><button type="button" aria-label="Exit interior exploration" onClick={() => viewport.current?.exitExploration()}><X size={16} /></button></div>
        <div hidden={!cameraControlsExpanded}><p>Drag to look · WASD / Q E to move · arrow keys to look · Escape to exit</p>
        <div className="whole-exploration-movement" role="group" aria-label="Move camera">{([['forward','Forward'],['back','Back'],['left','Left'],['right','Right'],['up','Up'],['down','Down']] as const).map(([direction,label]) => <button key={direction} type="button" aria-label={`Move camera ${label.toLowerCase()}`} onClick={() => viewport.current?.moveExploration(direction)}>{label}</button>)}</div>
        <div className="whole-exploration-movement" role="group" aria-label="Look around">{([['left',10,0],['right',-10,0],['up',0,10],['down',0,-10]] as const).map(([label,yaw,pitch]) => <button key={label} type="button" aria-label={`Look ${label}`} onClick={() => viewport.current?.lookExploration(yaw,pitch)}>Look {label}</button>)}</div>
        <p role="status">{navigation?.blocked ? `Movement stopped near ${navigation.blockedBy ?? 'a surface'}. Turn or move away.` : navigation?.message}</p>
        <button type="button" onClick={() => viewport.current?.resetExploration()}>Reset inspection camera</button></div>
      </section>}
      <div className="whole-heading"><div className="whole-eyebrow"><span /> HUMAN ANATOMY / OPEN ATLAS</div><h1>The connected body</h1><p>Thorax to pelvis. Explore the body’s connected systems.</p></div>
      <div className="whole-stage-actions">
        <button aria-label="Fit whole scene" title="Fit whole scene" disabled={!ready || recording} onClick={() => viewport.current?.fit()}><Focus size={17} /></button>
        <button aria-label="Camera tour" title="Camera tour" aria-pressed={autoRotate} disabled={!ready || recording || exploring} onClick={() => { viewport.current?.releaseTool(); setToolMode("orbit"); setAutoRotate(value => !value); }}>{autoRotate ? <Pause size={16} /> : <Play size={16} />}</button>
        <button className="whole-mobile-toggle" aria-label="Scene controls" onClick={() => controlsPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" })}><Layers3 size={17} /></button>
      </div>
      {!ready && !error && <div className="whole-loading" role="status"><LoaderCircle className="atlas-spinning" size={22} /><strong>Assembling the body</strong><span>Loading the registered anatomy atlas…</span></div>}
      {error && <div className="whole-error" role="alert"><span>{error}</span><button aria-label="Dismiss scene error" onClick={() => setError("")}>×</button></div>}
      {recording && <div className="whole-recording" role="status"><span />{recordingKind === "interaction" ? "Recording instrument interaction" : "Recording camera tour"}</div>}
      {physicsMaterials && <div className="whole-tool-strip" aria-label="Laparoscopic tools">
        <div role="group" aria-label="Interaction mode"><button aria-pressed={toolMode === "orbit"} disabled={recordingKind === "tour"} onClick={() => chooseTool("orbit")}><MousePointer2 size={14} />Camera</button><button aria-pressed={toolMode === "push"} disabled={!instrumentsReady} onClick={() => chooseTool("push")}><Move3D size={14} />Push</button><button aria-pressed={toolMode === "grasp"} disabled={!instrumentsReady} onClick={() => chooseTool("grasp")}><Hand size={14} />Grasp</button><button className="whole-tool-release" title="Release instrument (Escape)" aria-label="Release instrument" disabled={!toolStatus?.active} onClick={() => viewport.current?.releaseTool()}><X size={14} /></button></div>
        {toolMode === "push" && <label className="whole-continuous-push"><input type="checkbox" checked={continuousPush} disabled={!instrumentsReady} onChange={event => { viewport.current?.releaseTool(); setContinuousPush(event.target.checked); }} /><span>Continuous push</span><output>{toolStatus?.holdingPush ? `${toolStatus.depthMm.toFixed(1)} / 20 mm` : `${pushSpeed} mm/s`}</output></label>}
        <small>{!physicsRunning ? "Resume physics to use an instrument" : !toolStatus?.ready ? "Preparing surface contact…" : toolMode === "orbit" ? "Orbit to expose a surface, then choose Push or Grasp" : toolMode === "push" && continuousPush ? toolStatus?.holdingPush ? toolStatus.message : "Hold mouse or trackpad button to press deeper · release to stop" : toolStatus?.active ? "Move to manipulate · wheel for depth · Escape releases" : toolStatus?.message || "Click to attach, or hold a surface and drag"}</small>
      </div>}
      {selectedInfo && <section className="whole-selection" aria-label="Selected structure">
        <div><span className="whole-selection-dot" style={{ background: selectedInfo.color }} /><div><small>{categories.find(category => category.id === selectedInfo.category)?.label}</small><strong>{selectedInfo.label}</strong></div><button className="whole-selection-close" aria-label="Clear organ selection" onClick={() => setSelected(null)}><X size={13} /></button></div>
        <div className="whole-selection-actions"><button disabled={recording} onClick={() => focusOrgan(selectedInfo.id)}><Focus size={13} />Focus organ</button><button disabled={recording} onClick={() => toggleOrgan(selectedInfo.id)}><EyeOff size={13} />Hide organ</button></div>
      </section>}
      <div className="whole-orientation"><span>{!autoRotate && view === "front" ? "R" : !autoRotate && view === "back" ? "L" : ""}</span><small>{autoRotate || view === "orbit" ? "FREE ORBIT · USE A VIEW PRESET TO REORIENT" : ({ front: "ANTERIOR VIEW · PATIENT RIGHT IS SCREEN LEFT", back: "POSTERIOR VIEW · PATIENT LEFT IS SCREEN LEFT", left: "PATIENT LEFT · LATERAL VIEW", right: "PATIENT RIGHT · LATERAL VIEW", top: "SUPERIOR VIEW · LOOKING INFERIORLY", bottom: "INFERIOR VIEW · LOOKING SUPERIORLY", oblique: "OBLIQUE VIEW · PATIENT LEFT / ANTERIOR" })[view]}</small><span>{!autoRotate && view === "front" ? "L" : !autoRotate && view === "back" ? "R" : ""}</span></div>
      <div className="whole-view-bar" aria-label="Camera views">{views.map(([id, label]) => <button key={id} disabled={!ready || recording} aria-pressed={!autoRotate && view === id} onClick={() => changeView(id)}>{label}</button>)}</div>
      <div className="whole-stage-caption"><span>{exploring ? "Between-organ inspection · drag to look · move with on-screen controls" : selected ? stats?.organs.find(organ => organ.id === selected)?.label ?? selected : toolMode === "orbit" ? "Drag to orbit · scroll to explore · click an organ" : toolMode === "push" ? "Blunt palpator · hold and press a tissue surface" : "Fenestrated grasper · hold and move a tissue surface"}</span><span>{stats ? `${stats.organs.length} structures` : "—"}</span></div>
    </main>

    <aside ref={controlsPanel} className="whole-controls" aria-label="Whole scene controls">
      <div className="whole-panel-tabs whole-three-tabs"><button aria-pressed={panel === "scene"} onClick={() => setPanel("scene")}>Scene controls</button><button aria-pressed={panel === "body"} onClick={() => setPanel("body")}>Whole-body colour</button><button aria-pressed={panel === "references"} onClick={() => setPanel("references")}>Atlas references</button></div>
      <div className="whole-panel-scroll">
        <div hidden={panel !== "body"}><WholeBodyReferencePanel organs={stats?.organs ?? []} appliedPlan={referenceState.plan} referenceColors={referenceColors} disabled={!ready || recording} canRestore={Boolean(previousReferences)} showingPrevious={showPreviousReferences && Boolean(previousReferences)} onCompare={previous => {
          setShowPreviousReferences(previous); setNotice(previous ? "Before · previous colours" : "Applied reference colours");
        }} onApply={plan => {
          setPreviousReferences(referenceState); setReferenceState({ colors: plan.referenceColors, plan }); setShowPreviousReferences(false);
          setNotice(`Whole-body reference palette applied · ${Object.keys(plan.referenceColors).length} structures`);
        }} onRestore={() => {
          if (!previousReferences) return;
          setReferenceState(previousReferences); setPreviousReferences(null); setShowPreviousReferences(false); setNotice("Previous reference colours restored");
        }} /></div>
        {panel === "scene" ? <>
          <div className="whole-camera-entry"><button className="whole-button" disabled={!ready || recording} aria-pressed={exploring} onClick={() => exploring ? viewport.current?.exitExploration() : enterExploration()}>{exploring ? 'Return to orbit' : 'Explore between organs'}</button><p>Camera-mounted light and surface collision checks. Choose a dissection to expose deeper spaces. This inspects the atlas between surfaces; organ interiors are not reconstructed. Motion and tools pause during inspection.</p></div>
          <div className="whole-section-label">01 <span>THE ASSEMBLY</span></div>
          <h2>One coordinated specimen</h2><p className="whole-copy">Explore the organs together, with the airways, vessels and ducts that connect them.</p>
          <div className="whole-dissection" aria-label="Dissection presets">{dissections.map(preset => <button key={preset.id} disabled={!ready || recording} aria-pressed={dissection === preset.id} onClick={() => selectDissection(preset.id)}>{preset.label}</button>)}</div>
          {dissection && dissection !== "full" && <p className="whole-cutaway-note">Overlying organs hidden for inspection. Positions are preserved.</p>}
          <div className="whole-layers">{categories.map(category => <label key={category.id}><i style={{ background: category.color }} /><span>{category.label}</span><input type="checkbox" checked={visibility[category.id] !== false} onChange={event => { setDissection(null); setVisibility(current => ({ ...current, [category.id]: event.target.checked })); }} /></label>)}</div>
          <label className="whole-motion"><Layers3 size={15} /><span>Experimental fat layers<small>Omental apron and perirenal pads</small></span><input aria-label="Experimental fat layers" type="checkbox" disabled={!ready || recording} checked={fatOptions.enabled} onChange={event => { const enabled = event.target.checked; setFatOptions(current => ({ ...current, enabled })); const url = new URL(location.href); if (enabled) url.searchParams.set("fat", "1"); else url.searchParams.delete("fat"); history.replaceState(null, "", url); }} /></label>
          {fatOptions.enabled && <section aria-label="Adipose layer controls">
            <div className="whole-fat-heading"><span>ADIPOSE / IN CONTEXT</span><h3>Inspect the tissue planes</h3><p>Connected fat bands, thin intercord tissue and a wet surface. Select a depot, then inspect it from any view.</p></div>
            {fatStatus === "building" && <p className="whole-copy" role="status">Generating organ-aware fat layers…</p>}
            <div className="whole-fat-focus" role="group" aria-label="Inspect fat depots">{([
              ["fat-omentum", "Focus omentum", "abdominal", "front"],
              ["fat-left-kidney-perirenal", "Focus left perirenal fat", "deep", "back"],
              ["fat-right-kidney-perirenal", "Focus right perirenal fat", "deep", "back"],
            ] as const).map(([id,label,dissection,view])=><button key={id} className="whole-button" disabled={fatStatus!=="ready"||recording} onClick={()=>{setAutoRotate(false);selectDissection(dissection);setFatOptions(current=>({...current,omentum:id==="fat-omentum",perirenal:id!=="fat-omentum"}));setView(view);viewport.current?.view(view);viewport.current?.focusOrgan(id);}}><Focus size={13}/>{label}</button>)}</div>
            <div className="whole-fat-fields">
              <label>Lighting<select aria-label="Fat illumination" value={fatOptions.lighting??"studio"} disabled={recording} onChange={e=>setFatOptions(current=>({...current,lighting:e.target.value as NonNullable<FatSceneOptions["lighting"]>}))}><option value="studio">Soft studio</option><option value="surgical">Camera light</option><option value="grazing">Grazing side light</option></select></label>
              <label>Surface study<select aria-label="Fat surface study" value={fatOptions.study??"tissue"} disabled={recording} onChange={e=>setFatOptions(current=>({...current,study:e.target.value as NonNullable<FatSceneOptions["study"]>}))}><option value="tissue">Lit tissue</option><option value="color">Base colour · unlit</option><option value="relief">Relief · neutral clay</option><option value="geometry">Geometry · neutral clay</option></select></label>
            </div>
            <label className="whole-range"><span>Surface wet coat<output>{Math.round((fatOptions.wetness??.52)*100)}%</output></span><input aria-label="Fat wetness" type="range" min="0" max="1" step=".01" disabled={recording} value={fatOptions.wetness??.52} onChange={e=>setFatOptions(current=>({...current,wetness:Number(e.target.value)}))}/></label>
            <div className="whole-layers"><label><span>Omental apron</span><input aria-label="Omental apron" type="checkbox" checked={fatOptions.omentum} onChange={event => setFatOptions(current => ({ ...current, omentum: event.target.checked }))} /></label><label><span>Perirenal pads</span><input aria-label="Perirenal pads" type="checkbox" checked={fatOptions.perirenal} onChange={event => setFatOptions(current => ({ ...current, perirenal: event.target.checked }))} /></label></div>
            <label className="whole-range"><span>Fat thickness<output>{fatOptions.thicknessMm} mm</output></span><input aria-label="Fat thickness" type="range" min="2" max="12" step="1" value={fatOptions.thicknessMm} onChange={event => setFatOptions(current => ({ ...current, thicknessMm: Number(event.target.value) }))} /></label>
            <label className="whole-fat-seed">Fat seed<input aria-label="Fat seed" type="number" min="0" max="4294967295" value={fatOptions.seed} disabled={recording} onChange={e=>{const seed=Number(e.target.value);if(Number.isInteger(seed)&&seed>=0&&seed<=4294967295)setFatOptions(current=>({...current,seed}));}}/></label>
            <button className="whole-button" disabled={recording} onClick={() => setFatOptions(current => ({ ...current, seed: crypto.getRandomValues(new Uint32Array(1))[0]! }))}><Shuffle size={13} />Resample fat layers</button>
            <p className="whole-scope">Authored anatomical depots with sampled clearance checks and local shell-thickness optics. Shared organ motion; fat sliding, gravity and contact are not solved. <a href="?mode=fat">Open fat lab and surgical references ↗</a></p>
          </section>}
          <label className="whole-motion"><Activity size={15} /><span>Breathing<small>{physicsMaterials ? "Respiratory loading of the soft tissues" : "Gentle illustrative motion"}</small></span><input type="checkbox" checked={breathing} onChange={event => setBreathing(event.target.checked)} /></label>
          {textureLab && <><label className="whole-range"><span>Photo detail<output>{Math.round(photoDetail * 100)}%</output></span><input type="range" min={0} max={2} step={0.01} value={photoDetail} aria-label="Photo detail strength" onChange={event => setPhotoDetail(Number(event.target.value))} /></label>
          <p className="whole-copy">Real tissue detail from licensed surgical photographs (DSAD, CC BY 4.0) over the organs that have one, lighting flattened, no repetition; it modulates each tissue's colour without shifting it.</p></>}
          <div className="whole-section-label">02 <span>JOINT VARIATION</span></div>
          <h2>Shape, colour & disease</h2><p className="whole-copy">Vary the entire scene in one step. A shared spatial deformation keeps the atlas structures together.</p>
          <label className="whole-range"><span>Shape variation<output>{Math.round(strength * 100)}%</output></span><input aria-label="Shape variation" type="range" min="0.05" max="1" step="0.05" value={strength} onChange={event => setStrength(Number(event.target.value))} /></label>
          <label className="whole-range"><span>Disease appearance<output>{Math.round(severity * 100)}%</output></span><input aria-label="Disease appearance" type="range" min="0" max="1" step="0.05" value={severity} onChange={event => setSeverity(Number(event.target.value))} /></label>
          <div className="whole-seed-row"><label>Scene seed<input aria-label="Scene seed" type="text" inputMode="numeric" value={seed} onChange={event => setSeed(event.target.value)} /></label><button className="whole-button" disabled={!ready || recording} onClick={() => vary(false)} title="Apply this seed and the selected settings">Replay seed</button></div>
          <button className="whole-joint" disabled={!ready || recording} onClick={() => vary(true)}><Shuffle size={16} /><span>Joint scene variation</span><ChevronRight size={16} /></button>
          <button className="whole-button" aria-pressed={autoVarying} disabled={!ready || recording} onClick={() => { const next = !autoVarying; setAutoVarying(next); if (next) vary(true); }}>{autoVarying ? <Pause size={13} /> : <Play size={13} />}{autoVarying ? "Pause endless variation" : "Auto-vary scene endlessly"}</button>
          <button className="whole-restore" disabled={!ready || recording} onClick={restore}><RotateCcw size={13} />Restore atlas</button>
          <p className="whole-scope">Disease colours and texture changes are synthetic visual studies. They do not represent a diagnosed patient or a physiological disease simulation.</p>
          {selectedInfo && REFERENCE_ORGAN_IDS[selectedInfo.id] ? <ReferenceMaterialPanel
            key={selectedInfo.id} organ={REFERENCE_ORGAN_IDS[selectedInfo.id]!} organLabel={selectedInfo.label}
            reference={referenceColors[selectedInfo.id]} disabled={!ready || recording}
            onApply={reference => {
              setReferenceState(current => { const next = { ...current.colors }; if (reference) next[selectedInfo.id] = reference; else delete next[selectedInfo.id]; return { colors: next, plan: withoutPlanTarget(current.plan, selectedInfo.id) }; });
              setPreviousReferences(null); setShowPreviousReferences(false);
              setNotice(`${selectedInfo.label} reference colour ${reference ? "applied" : "cleared"}`);
            }} /> : <p className="whole-scope">Select an organ to transfer colour from a reference image.</p>}
          <div className="whole-section-label">03 <span>LEARNED MATERIALS & MOTION</span></div>
          <h2>Feel the connected scene</h2><p className="whole-copy">Apply distinct material estimates to every soft structure, then explore their coupled deformation and recovery.</p>
          <button className="whole-joint whole-physics-apply" disabled={!ready || physicsLoading || recording} onClick={() => void applyPhysics()}>{physicsLoading ? <LoaderCircle size={16} className="atlas-spinning" /> : <Activity size={16} />}<span>{physicsLoading ? "Applying learned physics…" : "Apply learned physics to all organs"}</span></button>
          {physicsMaterials && <div className="whole-physics-controls">
            <p className="whole-physics-status">{physicsMaterials.materials.length} soft structures · {physicsRunning ? "Simulation running" : "Simulation paused"}</p>
            <div><button className="whole-button" aria-label={physicsRunning ? "Pause physics" : "Resume physics"} disabled={exploring} onClick={() => setPhysicsRunning(value => !value)}>{physicsRunning ? <Pause size={13} /> : <Play size={13} />}{physicsRunning ? "Pause physics" : "Resume physics"}</button><button className="whole-button" onClick={() => { viewport.current?.resetPhysics(); setNotice("Physics state reset"); }}><RotateCcw size={13} />Reset motion</button></div>
            <button className="whole-button" disabled={!physicsRunning} onClick={() => { viewport.current?.pulsePhysics(); setNotice("Palpation pulse applied; watch the tissue recover"); }}>Palpate selected organ</button>
            <button className="whole-restore" onClick={() => { viewport.current?.releaseTool(); setToolMode("orbit"); setPhysicsMaterials(null); setPhysicsRunning(false); setBreathing(false); setNotice("Static anatomy restored"); }}>Remove physics</button>
          </div>}
          <p className="whole-scope">Learned from synthetic material responses. Coupled viscoelastic preview with authored supports and loading; organ-to-organ contact, fluid pressure and validated surgical mechanics are not resolved.</p>
          <section className="whole-instrument-panel" aria-label="Instrument settings">
            <div className="whole-section-label">04 <span>SURFACE INTERACTION</span></div>
            <h2>Laparoscopic instruments</h2>
            <p className="whole-copy">Use the blunt palpator to press tissue, or close the fenestrated grasper on a surface and move it. Rotate the body or hide overlying organs to reach a deeper surface.</p>
            {!physicsMaterials ? <p className="whole-tool-status">Apply learned physics above to enable the instruments.</p> : <>
              <label className="whole-range"><span>Probe tip radius<output>{toolRadius} mm</output></span><input aria-label="Probe tip radius" type="range" min="3" max="10" step="1" value={toolRadius} disabled={!instrumentsReady || toolMode !== "push" || Boolean(toolStatus?.active)} onChange={event => setToolRadius(Number(event.target.value))} /></label>
              <label className="whole-range"><span>Initial push depth<output>{toolDepth} mm</output></span><input aria-label="Initial push depth" type="range" min="0" max="8" step="0.5" value={toolDepth} disabled={!instrumentsReady || toolMode !== "push" || Boolean(toolStatus?.active)} onChange={event => setToolDepth(Number(event.target.value))} /></label>
              {toolMode === "push" && continuousPush && <><label className="whole-range"><span>Push speed<output>{pushSpeed} mm/s</output></span><input aria-label="Push speed" type="range" min="0.5" max="5" step="0.5" value={pushSpeed} disabled={!instrumentsReady || Boolean(toolStatus?.active)} onChange={event => setPushSpeed(Number(event.target.value))} /></label><p className="whole-tool-status">Hold the button on tissue to advance continuously, up to 20 mm. Reaction force changes with the tissue response; release to watch recovery.</p></>}
              <button className="whole-button whole-engage" disabled={!instrumentsReady || toolMode === "orbit" || Boolean(toolStatus?.active)} onClick={() => { viewport.current?.engageSelectedTool(); sceneStage.current?.querySelector("canvas")?.focus(); }}>Engage at view centre</button>
              <div className="whole-depth-actions"><button className="whole-button" disabled={!toolStatus?.active || !instrumentsReady} onClick={() => viewport.current?.adjustToolDepth(1)}><ArrowDown size={13} />Move deeper</button><button className="whole-button" disabled={!toolStatus?.active || !instrumentsReady} onClick={() => viewport.current?.adjustToolDepth(-1)}><ArrowUp size={13} />Withdraw</button></div>
              <p className="whole-tool-status" role="status">{toolStatus?.message || "Choose an instrument in the scene toolbar."}</p>
              {toolStatus?.active && <dl className="whole-contact-readout" aria-label="Instrument contact measurements"><div><dt>Estimated reaction</dt><dd>{toolStatus.reactionN.toFixed(2)} N</dd></div><div><dt>Tip overlap</dt><dd>{toolStatus.penetrationMm.toFixed(3)} mm</dd></div><div><dt>Target residual</dt><dd>{toolStatus.slipMm.toFixed(2)} mm</dd></div></dl>}
              <button className="whole-button whole-engage" disabled={!instrumentsReady || recording} onClick={() => void recordInteraction()}><Video size={13} />Record interaction</button>
              <p className="whole-scope">Recording keeps the camera still so you can inspect your instrument movements. Keyboard: focus the canvas; Enter engages/releases, arrows move laterally, Page Up/Down adjust depth, Escape releases.</p>
            </>}
            <p className="whole-scope">Contact is checked against visible tissue surfaces. Hidden layers are excluded; bone remains fixed. The instrument and tissue response are a simulation preview, not validated surgical mechanics.</p>
          </section>
          <details className="whole-organ-details"><summary>Explore the structures <span>{stats?.organs.length ?? "—"}</span></summary><p className="whole-scope">Select an organ to focus the camera, or hide it to inspect the structures beneath it.</p><div>{stats?.organs.map(organ => <div className="whole-organ-row" key={organ.id}><button aria-pressed={selected === organ.id} onClick={() => setSelected(current => current === organ.id ? null : organ.id)}>{organ.label}{selected === organ.id && <Check size={12} />}</button><button aria-label={`Focus ${organ.label}`} title={`Focus ${organ.label}`} disabled={recording} onClick={() => focusOrgan(organ.id)}><Focus size={12} /></button><button aria-label={`${hiddenOrgans.includes(organ.id) ? "Show" : "Hide"} ${organ.label}`} aria-pressed={!hiddenOrgans.includes(organ.id)} onClick={() => toggleOrgan(organ.id)}>{hiddenOrgans.includes(organ.id) ? <EyeOff size={13} /> : <Eye size={13} />}</button></div>)}</div></details>
        </> : panel === "references" ? <>
          <div className="whole-section-label">OPEN ANATOMY <span>REFERENCE DESK</span></div>
          <h2>Built in a shared body frame</h2><p className="whole-copy">Abdominal organs, ducts and vessels retain the BodyParts3D body frame. The liver uses a reconstructed display envelope. Heart and lung surfaces are fitted from the Human Reference Atlas; those placements are an approximation.</p>
          <a className="whole-reference" href="https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html" target="_blank" rel="noreferrer"><Layers3 size={18} /><span><strong>BodyParts3D / Anatomography</strong><small>3D reference · Database Center for Life Science</small></span><ChevronRight size={14} /></a>
          <p className="whole-copy">BodyParts3D, © The Database Center for Life Science. Distributed under <a href="https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html" target="_blank" rel="noreferrer">CC BY 4.0</a>. The viewer adds tissue materials and bounded scene deformations.</p>
          <a className="whole-reference" href="https://humanatlas.io/3d-reference-library" target="_blank" rel="noreferrer"><Layers3 size={18} /><span><strong>Human Reference Atlas / HuBMAP</strong><small>CC BY 4.0 · Fitted heart and lung surfaces</small></span><ChevronRight size={14} /></a><p className="whole-copy"><a href={publicUrl("anatomy-scene/manifest.json")} target="_blank" rel="noreferrer">Full model credits, modifications and source hashes</a></p>
          <a className="whole-reference" href="https://openstax.org/books/anatomy-and-physiology-2e/pages/23-1-overview-of-the-digestive-system" target="_blank" rel="noreferrer"><Layers3 size={18} /><span><strong>OpenStax Anatomy & Physiology</strong><small>2D reference · Digestive system relationships</small></span><ChevronRight size={14} /></a>
          <div className="whole-reference-image"><img src={publicUrl("anatomy-scene/references/accessory-organs.jpg")} alt="Open anatomy illustration showing the digestive organs together" loading="lazy" /><span>OpenStax College (2013) · CC BY 3.0. Accessory digestive organs.</span></div>
          <a className="whole-copy" href="https://commons.wikimedia.org/wiki/File:2422_Accessory_Organs.jpg" target="_blank" rel="noreferrer">Image source & attribution</a><h3>Read the anatomy</h3><ul className="whole-anatomy-notes"><li>The liver occupies the patient’s upper right; the stomach lies mostly to the left.</li><li>The gallbladder sits beneath the liver. Biliary ducts approach the duodenum.</li><li>The pancreas lies behind the stomach; kidneys sit toward the posterior body wall.</li><li>The diaphragm separates the chest from the abdomen.</li></ul>
          <p className="whole-scope">One atlas represents one anatomy. Shared deformation preserves the assembly but does not establish population realism, collision-free disease changes, or validated tissue mechanics.</p>
        </> : null}
      </div>
      <div className="whole-panel-footer"><span /><p role="status">{notice}</p></div>
    </aside>
    <footer className="whole-footer"><span>BodyParts3D · CC BY 4.0</span><span>Registered anatomy · authored tissue appearance</span><button onClick={() => setPanel("references")}>Sources & scope <ArrowLeft size={11} /></button></footer>
  </div>;
}
