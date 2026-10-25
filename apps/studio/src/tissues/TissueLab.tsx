import { modelMessage, pbrModelLabel } from "../modelNames";
import { VideoRecorderButton } from "../VideoRecorderPanel";
import { DisplaySettings, SceneResizeHandle } from "../DisplaySettings";
import { useRegisterAccountWorkspace } from "../account/AccountDialog";
import { useEffect, useRef, useState } from "react";
import { materialAssets } from "./assets";
import { publicUrl } from "../api";
import { nativeTissueAvailable, serializeDisplayRecipe, validateEntry, type TissueControls, type TissueEntry, type TissueManifest, type TissueStudy } from "./contracts";
import { TissueViewport, type OrganBakeConfig, type TissueViewportHandle } from "./TissueViewport";
import { NeuralAppearancePanel, type NeuralSurfaceAppearance } from "./NeuralAppearancePanel";
import { supportedOrganSurface } from "./organSurface";
import { resolveBakeOrgan, type OrganMeshBakeResult } from "./organMeshBake";
import { defaultMaterialVariation, newMaterialSeed, validateMaterialVariation, type TissueMaterialVariation } from "./materialVariation";
import { importTissuePbrBundle } from "./pbrBundle";
import { discoverColabCatalog, selectBestColabPbrBundle } from "./colabModels";
import { LearnedTilesPanel } from "./LearnedTilesPanel";
import { catalogGroups, entryFamily, isLearnedEntry, learnedForFamily } from "./learnedCatalog";
import "./tissues.css";

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="tissue-slider"><span>{label}<output>{Number((value * 100).toFixed(1))}%</output></span><input type="range" aria-label={label} min="0" max="1" step=".001" value={value} onChange={event => onChange(Number(event.target.value))} /></label>;
}
function AngleSlider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label className="tissue-slider"><span>{label}<output>{value}°</output></span><input type="range" aria-label={label} min={min} max={max} step="1" value={value} onChange={event => onChange(Number(event.target.value))} /></label>;
}
function PigmentSlider({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const percent = Math.round(value * 100);
  return <label className="tissue-slider"><span>{label}<output>{percent > 0 ? "+" : ""}{percent}%</output></span><input type="range" aria-label={label} aria-valuetext={percent === 0 ? "Neutral" : `${percent > 0 ? "+" : ""}${percent}%`} min="-1" max="1" step=".001" value={value} onChange={event => onChange(Number(event.target.value))} /></label>;
}
const defaults: TissueControls = { vessels: .7, fascia: .15, adipose: 0, wetness: .8, study: "lit", view: "surface", playing: false, time: 0, seed: 42, lighting: "camera", cameraYawDeg: 0, cameraPitchDeg: 0 };
const isLuminalRegion = (region: string) => ["gastric_mucosa", "intestinal_mucosa", "colonic_mucosa"].includes(region);
type LocalPbrMaterial = { bundle: Awaited<ReturnType<typeof importTissuePbrBundle>>; source: string; filename: string };
export default function TissueLab() {
  const [catalog, setCatalog] = useState<TissueEntry[]>([]), [selected, setSelected] = useState("liver");
  const [libraryManifest, setLibraryManifest] = useState<TissueManifest | null>(null), [libraryDirectory, setLibraryDirectory] = useState("");
  const [full, setFull] = useState(false), [controls, setControls] = useState<TissueControls>(defaults), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [libraryManifestSource, setLibraryManifestSource] = useState("");
  const [recording, setRecording] = useState(false), [videoStatus, setVideoStatus] = useState("");
  const [appearance, setAppearance] = useState<NeuralSurfaceAppearance>();
  const [variationSeedDraft, setVariationSeedDraft] = useState(defaultMaterialVariation.seed), [variationSeedError, setVariationSeedError] = useState("");
  const [localPbr, setLocalPbr] = useState<LocalPbrMaterial>(), [pbrBusy, setPbrBusy] = useState(false), [pbrStatus, setPbrStatus] = useState(""), [pbrError, setPbrError] = useState("");
  const [organBakeConfig, setOrganBakeConfig] = useState<OrganBakeConfig>({ enabled: false, tileScaleMm: 51.2, blendSharpness: 6, atlasResolution: 256 });
  const [organBakeResult, setOrganBakeResult] = useState<OrganMeshBakeResult>();
  const pbrRevision = useRef(0), pbrReader = useRef<FileReader | undefined>(undefined), localPbrActive = useRef(false), libraryRequest = useRef<AbortController | undefined>(undefined);
  const pbrValidation = useRef<AbortController | undefined>(undefined);
  const pendingRestoredControls = useRef<Partial<TissueControls> | null>(null);
  const viewport = useRef<TissueViewportHandle>(null);
  const manifest = localPbr?.bundle.manifest ?? libraryManifest;
  const learnedStudy = !localPbr && manifest?.generator === "viscera.tissue-lora/v1";
  const directory = localPbr ? "" : libraryDirectory;
  const manifestSource = localPbr?.bundle.manifestSource ?? libraryManifestSource;
  const outputName = localPbr ? `${manifest!.recipe.organ}-generated-pbr` : selected;
  const editableRelief = Boolean(manifest?.channels.substrate_normal && manifest?.channels.layer_relief);
  const current = catalog.find(item => item.id === selected);
  // A gallery selection is an explicit material source, even while its manifest loads.
  const selectedLearnedTile = Boolean(current && isLearnedEntry(current));
  const activeAppearance = !localPbr && !selectedLearnedTile && appearance?.region === manifest?.recipe.organ ? appearance : undefined;
  const activateGeneratedAppearance = () => {
    if (current && isLearnedEntry(current)) setSelected(entryFamily(current));
  };
  const nativeAvailable = nativeTissueAvailable(current);
  const luminal = localPbr ? isLuminalRegion(localPbr.bundle.manifest.recipe.organ) : Boolean(current?.luminal);
  const edit = <K extends keyof TissueControls>(key: K, value: TissueControls[K]) => setControls(previous => ({ ...previous, [key]: value }));
  const materialVariation = controls.materialVariation ?? defaultMaterialVariation;
  const editMaterialVariation = (changes: Partial<TissueMaterialVariation>) => setControls(previous => ({ ...previous,
    materialVariation: validateMaterialVariation({ ...(previous.materialVariation ?? defaultMaterialVariation), ...changes }),
  }));
  const commitVariationSeed = () => {
    try {
      validateMaterialVariation({ ...materialVariation, seed: variationSeedDraft });
      editMaterialVariation({ seed: variationSeedDraft }); setVariationSeedError("");
    } catch {
      setVariationSeedError("Enter a whole number from 0 to 18446744073709551615, without leading zeros. The last valid seed remains active.");
    }
  };
  const sampleMaterialVariation = () => {
    try {
      const seed = newMaterialSeed();
      editMaterialVariation({ enabled: true, seed }); setVariationSeedDraft(seed); setVariationSeedError("");
    } catch { setVariationSeedError("A new seed could not be created. Enter a seed manually to continue."); }
  };
  const resetMaterialVariation = () => {
    edit("materialVariation", { ...defaultMaterialVariation });
    setVariationSeedDraft(defaultMaterialVariation.seed); setVariationSeedError("");
  };
  const bakeOntoOrganMesh = () => {
    const activeFamily = localPbr ? localPbr.bundle.manifest.recipe.organ : current ? entryFamily(current) : manifest?.recipe.organ;
    const familyTiles = learnedForFamily(catalog, activeFamily);
    setOrganBakeConfig(previous => ({ ...previous, enabled: true }));
    if (!localPbr && !selectedLearnedTile && !activeAppearance && familyTiles.length > 0) {
      pendingRestoredControls.current = { view: "organ" };
      setSelected(familyTiles[0]!.id);
    } else {
      edit("view", "organ");
    }
  };
  const updateBakeOptions = (changes: { tileScaleMm?: number; blendSharpness?: number }) => {
    setOrganBakeConfig(previous => ({ ...previous, enabled: true, ...changes }));
  };
  const cancelPbrImport = () => {
    pbrRevision.current++; pbrReader.current?.abort(); pbrValidation.current?.abort();
    setPbrBusy(false); setPbrStatus("Import cancelled. Your current material is unchanged."); setPbrError("");
  };
  /** Validate and apply a bundle; returns false when superseded or rejected (state already reports why). */
  const acceptPbrSource = async (source: string, filename: string, revision: number, signal: AbortSignal) => {
    setPbrStatus("Checking material channels, dimensions and content hashes…");
    const bundle = await importTissuePbrBundle(source, signal);
    if (revision !== pbrRevision.current) return false;
    libraryRequest.current?.abort(); localPbrActive.current = true;
    setLocalPbr({ bundle, source, filename }); setAppearance(undefined); setLoading(false); setError("");
    setControls(previous => ({ ...previous, vessels: bundle.manifest.recipe.vessel_opacity, fascia: bundle.manifest.recipe.fascia_opacity,
      adipose: bundle.manifest.recipe.adipose_opacity, wetness: bundle.manifest.recipe.wetness, playing: false,
      view: previous.view === "walkthrough" && !isLuminalRegion(bundle.manifest.recipe.organ) || previous.view === "organ" && !supportedOrganSurface(bundle.manifest.recipe.organ) ? "surface" : previous.view }));
    setPbrStatus("Imported locally. Inspect this candidate before using it in a study.");
    return true;
  };
  const importGeneratedSource = async (source: string, filename: string) => {
    const revision = ++pbrRevision.current;
    pbrReader.current?.abort(); pbrValidation.current?.abort();
    const validation = new AbortController(); pbrValidation.current = validation;
    setPbrBusy(true); setPbrError("");
    try { return await acceptPbrSource(source, filename, revision, validation.signal); }
    catch (reason) {
      if (revision === pbrRevision.current) { setPbrError(reason instanceof Error ? reason.message : String(reason)); setPbrStatus("Your previous material remains active."); }
      return false;
    } finally {
      if (revision === pbrRevision.current) { setPbrBusy(false); pbrValidation.current = undefined; }
    }
  };
  const loadBestColabPbr = async () => {
    const revision = ++pbrRevision.current;
    pbrReader.current?.abort(); pbrValidation.current?.abort();
    const validation = new AbortController(); pbrValidation.current = validation;
    setPbrBusy(true); setPbrError(""); setPbrStatus("Checking available generated PBR bundles…");
    try {
      const colabCatalog = await discoverColabCatalog(validation.signal);
      if (revision !== pbrRevision.current) return;
      const activeOrgan = localPbr ? localPbr.bundle.manifest.recipe.organ : (current ? entryFamily(current) : libraryManifest?.recipe.organ) ?? selected;
      const best = selectBestColabPbrBundle(colabCatalog.pbr_bundles, activeOrgan);
      if (!best) throw new Error("No generated PBR bundles were found.");
      setPbrStatus(`Loading ${pbrModelLabel(best)}…`);
      const response = await fetch(publicUrl(best.path), { signal: validation.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`generated PBR bundle unavailable: HTTP ${response.status}`);
      const source = await response.text();
      if (revision !== pbrRevision.current) return;
      const filename = best.path.split("/").pop() ?? `${best.organ}-colab.tissue-pbr.json`;
      await acceptPbrSource(source, filename, revision, validation.signal);
      if (revision === pbrRevision.current) setPbrStatus(`Loaded best generated PBR bundle: ${pbrModelLabel(best)}.`);
    } catch (reason) {
      if (revision === pbrRevision.current) {
        setPbrError(reason instanceof Error ? reason.message : String(reason));
        setPbrStatus("Your previous material remains active.");
      }
    } finally {
      if (revision === pbrRevision.current) { setPbrBusy(false); pbrValidation.current = undefined; }
    }
  };
  const importPbrFile = async (file: File | undefined) => {
    if (!file) return;
    const revision = ++pbrRevision.current;
    pbrReader.current?.abort(); pbrValidation.current?.abort();
    const validation = new AbortController(); pbrValidation.current = validation;
    setPbrBusy(true); setPbrError(""); setPbrStatus("Reading the local material bundle…");
    try {
      if (!file.size || file.size > 32 * 1024 * 1024) throw new Error("Choose a nonempty .tissue-pbr.json bundle no larger than 32 MiB.");
      const reader = new FileReader(); pbrReader.current = reader;
      const source = await new Promise<string>((resolve, reject) => {
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The material file could not be read."));
        reader.onerror = () => reject(new Error("The material file could not be read."));
        reader.onabort = () => reject(new DOMException("Import cancelled", "AbortError"));
        reader.readAsText(file);
      });
      if (revision !== pbrRevision.current) return;
      await acceptPbrSource(source, file.name, revision, validation.signal);
    } catch (reason) {
      if (revision === pbrRevision.current) { setPbrError(reason instanceof Error ? reason.message : String(reason)); setPbrStatus("Your previous material remains active."); }
    } finally {
      if (revision === pbrRevision.current) { setPbrBusy(false); pbrReader.current = undefined; pbrValidation.current = undefined; }
    }
  };
  const returnToLibrary = () => {
    pbrRevision.current++; pbrReader.current?.abort(); pbrValidation.current?.abort(); localPbrActive.current = false;
    setLocalPbr(undefined); setPbrBusy(false); setPbrError(""); setPbrStatus("");
    setError(catalog.length ? "" : "The tissue library is unavailable. Import a local material or reload to retry loading the library.");
  };
  const downloadPbrBundle = () => {
    if (!localPbr) return;
    const url = URL.createObjectURL(new Blob([localPbr.source], { type: "application/json" })), link = document.createElement("a");
    link.href = url; link.download = `${outputName}.tissue-pbr.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  useRegisterAccountWorkspace({
    kind: "tissue-material",
    defaultTitle: `${current?.label ?? selected} · ${controls.study} · ${manifest ? `${manifest.resolution[0]}px` : "512px"}`,
    summary: `${current?.label ?? selected} · vessels ${Math.round(controls.vessels * 100)}% · wet ${Math.round(controls.wetness * 100)}% · ${controls.study}`,
    capture: () => ({
      version: 1,
      selected,
      full,
      controls,
      localPbr: localPbr ? { source: localPbr.source, filename: localPbr.filename } : null,
    }),
    restore: async (payload) => {
      const savedControls = (payload.controls && typeof payload.controls === "object" ? payload.controls : {}) as Partial<TissueControls>;
      const savedPbr = payload.localPbr as { source?: string; filename?: string } | null | undefined;
      if (savedPbr && typeof savedPbr.source === "string" && savedPbr.source) {
        const applied = await importGeneratedSource(savedPbr.source, savedPbr.filename || "saved.tissue-pbr.json");
        if (applied) {
          setControls(previous => ({ ...previous, ...savedControls, playing: false }));
          if (savedControls.materialVariation?.seed) setVariationSeedDraft(savedControls.materialVariation.seed);
        }
        return;
      }
      if (localPbr) returnToLibrary();
      const nextSelected = typeof payload.selected === "string" ? payload.selected : selected;
      const nextFull = Boolean(payload.full);
      if (savedControls.materialVariation?.seed) {
        setVariationSeedDraft(savedControls.materialVariation.seed);
      }
      if (nextSelected !== selected || nextFull !== full) {
        pendingRestoredControls.current = savedControls;
        setSelected(nextSelected);
        setFull(nextFull);
      } else {
        setControls(previous => ({ ...previous, ...savedControls, playing: false }));
      }
    },
  });
  useEffect(() => () => { pbrRevision.current++; pbrReader.current?.abort(); pbrValidation.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(publicUrl("tissue-materials/catalog.json"), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Tissue library is not generated. Run scripts/build_tissue_library.py.");
      const data = await response.json() as { materials: unknown[] }; setCatalog(data.materials.map(validateEntry));
    }).catch(reason => { if (!controller.signal.aborted && !localPbrActive.current) { setError(String(reason)); setLoading(false); } });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!current || localPbr) return;
    const useNative = full && nativeTissueAvailable(current);
    if (full && !useNative) setFull(false);
    const controller = new AbortController(), path = publicUrl(`tissue-materials/${useNative ? current.manifest : current.preview}`);
    libraryRequest.current = controller;
    setLoading(true); setError(""); setLibraryManifest(null);
    void fetch(path, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Material unavailable: HTTP ${response.status}`);
      const source = await response.text();
      if (controller.signal.aborted) return;
      const data = JSON.parse(source) as TissueManifest;
      materialAssets(data);
      setLibraryManifestSource(source);
      setLibraryManifest(data); setLibraryDirectory(path.slice(0, path.lastIndexOf("/"))); setLoading(false);
      const restored = pendingRestoredControls.current;
      pendingRestoredControls.current = null;
      setControls(previous => ({
        ...previous,
        vessels: data.recipe.vessel_opacity,
        fascia: data.recipe.fascia_opacity,
        adipose: data.recipe.adipose_opacity,
        wetness: data.recipe.wetness,
        ...(restored ?? {}),
        view: (restored?.view ?? previous.view) === "walkthrough" && !current.luminal || (restored?.view ?? previous.view) === "organ" && !supportedOrganSurface(data.recipe.organ) ? "surface" : (restored?.view ?? previous.view),
      }));
    }).catch(reason => { if (!controller.signal.aborted) { setError(String(reason)); setLoading(false); } });
    return () => controller.abort();
  }, [current, full, localPbr]);
  const saveRecipe = () => {
    if (!manifest) return;
    const blob = new Blob([serializeDisplayRecipe(manifestSource, controls, `Research appearance study. ${editableRelief ? "Coverage controls both color and separate layer relief." : "Coverage changes color; relief remains the authored baseline."} Lumen geometry and optics are authored; atlas exteriors are approximate. ${localPbr ? `Imported generated PBR candidate; original bundle SHA-256: ${localPbr.bundle.digest}. Optical parameters are not measured and surgical realism is unqualified.` : "Learned RGB retains source illumination and is not calibrated albedo."}`, activeAppearance)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `${outputName}-display-recipe.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const record = async () => {
    setRecording(true); setError(""); setVideoStatus("Recording 5 seconds at 3840 × 2160…");
    try {
      const result = await viewport.current!.record(5), url = URL.createObjectURL(result.blob), link = document.createElement("a");
      link.href = url; link.download = `${outputName}-4k-${controls.view}.${result.metrics.mimeType.startsWith("video/mp4") ? "mp4" : "webm"}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      const metricsUrl = URL.createObjectURL(new Blob([JSON.stringify(result.metrics, null, 2)], { type: "application/json" }));
      link.href = metricsUrl; link.download = `${outputName}-4k-stream-metrics.json`; link.click(); setTimeout(() => URL.revokeObjectURL(metricsUrl), 2000);
      setVideoStatus(`4K capture · ${(1000 / result.metrics.medianFrameMs).toFixed(1)} median render fps · actual encoded cadence may differ`);
    } catch (reason) { setError(String(reason)); setVideoStatus(""); } finally { setRecording(false); }
  };
  const captureFrame = () => {
    setError("");
    try {
      const url = viewport.current?.capture();
      if (!url) throw new Error("Wait for the tissue viewport to load before capturing.");
      const link = document.createElement("a"); link.href = url; link.download = `${outputName}-3840x2160.png`; link.click();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <div className="tissue-lab">
    <header className="tissue-header"><a className="tissue-brand" href="?mode=atlas">VISCERA <span>TISSUE LAB</span></a><nav aria-label="Anatomy workspace"><a href="?mode=atlas">Organs</a><a href="?mode=textures">Photo textures</a><a href="?mode=fat">Adipose</a><a href="?mode=tissues" aria-current="page">Layered tissue</a></nav><DisplaySettings /><VideoRecorderButton /><span className="tissue-tag">RESEARCH / 03</span></header>
    <main className="tissue-stage"><SceneResizeHandle /><div className="tissue-heading"><span>MATERIAL LIBRARY · {String(catalog.length).padStart(2, "0")} STUDIES</span><h1>{controls.view === "walkthrough" ? "Light, from within." : "Beneath the surface."}</h1><p>{controls.view === "walkthrough" ? "Seeded lumen phantom · camera-mounted illumination" : "Organ-specific surfaces. Fine vessels. Layered membranes."}</p></div>
      {manifest && <TissueViewport ref={viewport} manifest={manifest} directory={directory} controls={controls} organBakeConfig={organBakeConfig} onOrganBaked={setOrganBakeResult} onError={setError} {...(localPbr ? { localFiles: localPbr.bundle.files, importedMaterial: { bundleSha256: localPbr.bundle.digest, sourceFile: localPbr.filename, provenance: localPbr.bundle.manifest.provenance } } : {})} {...(activeAppearance ? { appearance: activeAppearance } : {})} />}
      {loading && <div className="tissue-loading" role="status">Loading material channels…</div>}
      {error && <div className="tissue-error" role="alert">{modelMessage(error)}</div>}
      <div className="tissue-caption"><span>{controls.view === "surface" ? "Drag to orbit · scroll to inspect · 80 × 80 mm coupon" : controls.view === "organ" ? "Atlas exterior · drag to orbit · assumed millimetres" : "18 mm/s · fixed surface coordinates · curved 1600 mm loop"}</span><span>{manifest ? `${manifest.resolution[0]}² maps` : "—"}{localPbr ? " · generated PBR candidate" : activeAppearance ? ` · learned RGB ${activeAppearance.resolution}²` : ""}{controls.view === "organ" && organBakeResult ? ` · 3D ${organBakeResult.organ} seamless bake` : ""} · {controls.study}</span></div>
      <div className="tissue-stage-actions"><button disabled={!manifest || recording} onClick={captureFrame}>Save 4K frame ↗</button>{controls.view !== "surface" && <><button disabled={recording} aria-pressed={controls.playing} onClick={() => edit("playing", !controls.playing)}>{controls.playing ? "Pause camera" : "Start camera"}</button><button disabled={recording || pbrBusy} onClick={() => void record()}>{recording ? "Recording…" : "Record 4K · 5s"}</button></>}</div>
    </main>
    <aside className="tissue-panel" inert={recording}><span className="tissue-eyebrow">01 / SPECIMEN</span><h2>Build the surface</h2><p className="tissue-copy">Inspect each layer under a moving light. Separate appearance from relief and illumination.</p>
      {videoStatus && <p className="tissue-copy" role="status">{videoStatus}</p>}
      <section className="tissue-pbr-panel" aria-label="Generated PBR material">
        <div className="tissue-variation-heading"><h3>Generated PBR</h3><span className="tissue-variation-badge">LOCAL IMPORT</span></div>
        <button type="button" className="tissue-wide tissue-variation-primary" disabled={pbrBusy || recording} onClick={() => void loadBestColabPbr()}>{pbrBusy ? "Loading generated PBR…" : "Use generated PBR model"}</button>
        <label className="tissue-field">Import generated PBR material<input type="file" aria-label="Import generated PBR material" accept=".tissue-pbr.json,.json,application/json" onChange={event => { void importPbrFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
        <p className="tissue-variation-help">Import a material bundle from the pretrained PBR notebook. Files stay on this device. This general-domain model produces experimental candidates, without surgeon validation.</p>
        {pbrBusy && <button className="tissue-wide" onClick={cancelPbrImport}>Cancel PBR import</button>}
        {pbrStatus && <p className="tissue-copy" role="status">{modelMessage(pbrStatus)}</p>}
        {pbrError && <p className="tissue-model-error" role="alert">{modelMessage(pbrError)}</p>}
        {localPbr && <><dl className="tissue-pbr-provenance"><div><dt>Local file</dt><dd>{modelMessage(localPbr.filename)}</dd></div><div><dt>Material family</dt><dd>{localPbr.bundle.manifest.recipe.organ.replaceAll("_", " ")}</dd></div><div><dt>Source maps</dt><dd>{localPbr.bundle.manifest.resolution.join(" × ")} · native model output</dd></div><div><dt>Bundle SHA-256</dt><dd title={localPbr.bundle.digest}>{localPbr.bundle.digest}</dd></div></dl><button className="tissue-wide" onClick={downloadPbrBundle}>Export imported PBR bundle</button><button className="tissue-wide" onClick={returnToLibrary}>Return to tissue library</button></>}
      </section>
      <label className="tissue-field">Tissue region<select aria-label="Tissue region" disabled={Boolean(localPbr)} value={localPbr ? "imported" : selected} onChange={event => setSelected(event.target.value)}>{localPbr ? <option value="imported">{localPbr.bundle.manifest.recipe.organ.replaceAll("_", " ")} · imported PBR</option> : catalogGroups(catalog).map(group => <optgroup key={group.label} label={modelMessage(group.label)}>{group.entries.map(item => <option key={item.id} value={item.id}>{modelMessage(item.label)}</option>)}</optgroup>)}</select></label>
      <label className="tissue-field">Map resolution<select aria-label="Map resolution" disabled={Boolean(localPbr)} value={localPbr ? "imported" : full && nativeAvailable ? "4096" : "preview"} onChange={event => setFull(event.target.value === "4096" && nativeAvailable)}>{localPbr ? <option value="imported">Native model · {localPbr.bundle.manifest.resolution[0]}</option> : <><option value="preview">Preview · 512</option><option value="4096" disabled={!nativeAvailable}>{nativeAvailable ? "Native 4K · 4096" : learnedStudy ? "Native 4K · none for learned studies" : "Native 4K · not included"}</option></>}</select></label>
      {!localPbr && current && !nativeAvailable && !learnedStudy && <p className="tissue-copy">Public preview · 512 × 512 source maps. Native 4096 × 4096 maps remain in the local library. A 4K frame or video does not add source texture detail.</p>}
      {!localPbr && current && learnedStudy && <p className="tissue-copy">Learned study · {manifest?.resolution[0]} × {manifest?.resolution[1]} native maps sampled from Generative Model 12 (illumination-flattened observed RGB, not measured albedo). No native 4K maps exist. Vessel, fascia and fat overlays are empty; the wet coat is a uniform authored film. A 4K frame or video does not add source texture detail.</p>}
      {localPbr && (localPbr.bundle.manifest.generator === "viscera.tissue-lora/v1"
        ? <p className="tissue-copy">Generated learned tile · {localPbr.bundle.manifest.resolution[0]}² native maps from the tile generator (appearance synthesis, not measured albedo). Vessel, fascia and fat overlays are empty; the wet coat is a uniform authored film. It lives only in this session: export the bundle to keep it.</p>
        : <p className="tissue-copy">Imported maps keep their native detail. A 4K frame or video does not add source texture detail. This PBR pilot does not separate vessels, fascia, fat or wet-film layers; their coverage controls have no effect on its empty overlays. Return to the library to change tissue family.</p>)}
      <LearnedTilesPanel catalog={catalog} family={localPbr ? localPbr.bundle.manifest.recipe.organ : current ? entryFamily(current) : undefined} selectedId={localPbr ? "" : selected}
        disabled={pbrBusy || recording} onSelect={id => { if (localPbr) returnToLibrary(); setSelected(id); }} onGenerated={importGeneratedSource}
        organBakeActive={controls.view === "organ" && (organBakeConfig.enabled || learnedStudy)}
        organBakeResult={controls.view === "organ" ? organBakeResult : undefined}
        organBakeSourceLabel={activeAppearance ? `Generated appearance · seed ${activeAppearance.seed}` : localPbr?.filename ?? current?.label}
        organBakeTileScaleMm={organBakeConfig.tileScaleMm ?? manifest?.recipe.tile_size_mm ?? 51.2}
        organBakeSharpness={organBakeConfig.blendSharpness ?? 6}
        onBakeOntoOrgan={bakeOntoOrganMesh}
        onUpdateBakeOptions={updateBakeOptions} />
      <label className="tissue-field">View<select aria-label="View" value={controls.view} onChange={event => edit("view", event.target.value as TissueControls["view"])}><option value="surface">Surface coupon</option><option value="organ" disabled={!manifest || !(supportedOrganSurface(manifest.recipe.organ) || (organBakeConfig.enabled && Boolean(resolveBakeOrgan(manifest.recipe.organ))))}>Atlas organ · exterior</option><option value="walkthrough" disabled={!luminal}>Endoscope · lumen phantom</option></select></label>
      {!luminal && <p className="tissue-copy">Choose a mucosa region for the internal camera walkthrough.</p>}
      {controls.view === "walkthrough" && <><label className="tissue-field">Lumen variation seed<input aria-label="Lumen variation seed" type="number" min="0" max="4294967295" value={controls.seed} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 0 && value <= 4294967295) edit("seed", value); }} /></label><button className="tissue-wide" onClick={() => edit("seed", crypto.getRandomValues(new Uint32Array(1))[0]!)}>New lumen variation</button><button className="tissue-wide" onClick={() => setControls(previous => ({ ...previous, time: previous.time === 0 ? .000001 : 0, playing: false }))}>Reset camera</button></>}
      {controls.view === "walkthrough" && <><AngleSlider label="Camera yaw" value={controls.cameraYawDeg ?? 0} min={-180} max={180} onChange={value => edit("cameraYawDeg", value)} /><AngleSlider label="Camera pitch" value={controls.cameraPitchDeg ?? 0} min={-90} max={90} onChange={value => edit("cameraPitchDeg", value)} /><button className="tissue-wide" onClick={() => setControls(previous => ({ ...previous, cameraYawDeg: 0, cameraPitchDeg: 0 }))}>Look along the path</button></>}
      {controls.view === "organ" && <p className="tissue-copy">Inspect the atlas organ from outside. Play and record follow a 24-second exterior orbit; paused frame capture preserves your viewpoint. Surfaces are approximate and organ interiors are not connected.</p>}
      <span className="tissue-eyebrow">02 / SUPERPOSITION</span>
      <Slider label="Vessel coverage" value={controls.vessels} onChange={value => edit("vessels", value)} />
      <Slider label="Fascia coverage" value={controls.fascia} onChange={value => edit("fascia", value)} />
      <Slider label="Adipose coverage" value={controls.adipose} onChange={value => edit("adipose", value)} />
      <Slider label="Wet coat" value={controls.wetness} onChange={value => edit("wetness", value)} />
      <p className="tissue-copy">{editableRelief ? "Coverage adjusts color and relief together. The wet film has its own smoother reflection." : "Coverage blends color in linear light. Surface relief stays at the baked recipe."} Adipose here is a surface layer; the Adipose lab owns fat geometry.</p>
      <section className="tissue-variation-panel" aria-labelledby="tissue-variation-title">
        <div className="tissue-variation-heading"><h3 id="tissue-variation-title">Material variations</h3><span className="tissue-variation-badge">AUTHORED</span></div>
        <p className="tissue-copy">Explore colour and surface variation with a repeatable seed. These controls adjust the current material{localPbr ? "." : "; learned appearance is managed separately below."}</p>
        <label className="tissue-check"><input type="checkbox" aria-label="Enable material variation" checked={materialVariation.enabled} onChange={event => editMaterialVariation({ enabled: event.target.checked })} />Enable material variation</label>
        <label className="tissue-field">Material variation seed<input aria-label="Material variation seed" aria-invalid={Boolean(variationSeedError)} aria-describedby={variationSeedError ? "tissue-variation-seed-error" : "tissue-variation-seed-help"} inputMode="numeric" spellCheck={false} value={variationSeedDraft} onChange={event => { setVariationSeedDraft(event.target.value); setVariationSeedError(""); }} onBlur={commitVariationSeed} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitVariationSeed(); } }} /></label>
        {variationSeedError ? <p className="tissue-model-error" id="tissue-variation-seed-error" role="alert">{variationSeedError}</p> : <p className="tissue-variation-help" id="tissue-variation-seed-help">Keep the seed to reproduce this material. Press Enter or leave the field to apply it.</p>}
        <button className="tissue-wide tissue-variation-primary" onClick={sampleMaterialVariation}>New material variation</button>
        <PigmentSlider label="Pigment warmth" value={materialVariation.warmth} onChange={warmth => editMaterialVariation({ warmth })} />
        <PigmentSlider label="Pigment depth" value={materialVariation.depth} onChange={depth => editMaterialVariation({ depth })} />
        <Slider label="Colour variation" value={materialVariation.strength} onChange={strength => editMaterialVariation({ strength })} />
        <Slider label="Roughness variation" value={materialVariation.roughness} onChange={roughness => editMaterialVariation({ roughness })} />
        <button className="tissue-wide" onClick={resetMaterialVariation}>Reset material variation</button>
      </section>
      <span className="tissue-eyebrow">03 / INSPECT & EXPORT</span>
      <label className="tissue-field">Surface study<select aria-label="Surface study" value={controls.study} onChange={event => edit("study", event.target.value as TissueStudy)}><option value="lit">Lit tissue</option><option value="albedo">Base color · no illumination</option><option value="normal">Normal · composed relief</option><option value="roughness">Roughness · composed film</option></select></label>
      <label className="tissue-field">Lighting<select aria-label="Lighting" value={controls.lighting} onChange={event => edit("lighting", event.target.value as TissueControls["lighting"])}><option value="camera">Camera-mounted light</option><option value="grazing">Grazing light · coupon</option></select></label>
      <button className="tissue-wide" disabled={!manifest} onClick={saveRecipe}>Export material + display recipe</button>
      {!localPbr && current && <div className="tissue-downloads">{["base_color", "substrate", "normal", "roughness", "height", "thickness", ...(editableRelief ? ["substrate_normal", "layer_relief"] : [])].map(channel => <a key={channel} href={publicUrl(`tissue-materials/${(nativeAvailable ? current.manifest! : current.preview).replace("manifest.json", "")}${channel}.png`)} download>{channel.replace("_", " ")} {nativeAvailable ? "4K" : "512"} ↓</a>)}</div>}
      <div hidden={Boolean(localPbr)}><NeuralAppearancePanel region={libraryManifest?.recipe.organ ?? selected} suspended={Boolean(localPbr) || selectedLearnedTile} selectionKey={selected} onActivate={activateGeneratedAppearance} onChange={setAppearance} /></div>
      <p className="tissue-note">Research materials with authored geometry and optics. Imported models predict RGB appearance, not measured optical properties. 4K describes output sampling; anatomical and surgical validation remain outstanding.</p>
    </aside><footer className="tissue-footer">SURFACE / VESSELS / MEMBRANES / LIGHT<span>Reproducible materials · independent fat pipeline</span></footer>
  </div>;
}
