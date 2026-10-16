import { apiGet, apiOnline, apiUrl, publicUrl, reportError, reportReady } from "./api";
import { NEEDS_API, bundledReference } from "./atlasLocal";
// the browser samplers and the disease renderer load on first use: a visitor who never samples offline does not pay
// for their code at first paint (their weights are fetched on demand by the modules themselves)
const samplers = {
  joint: () => import("./atlasJointLocal"),
  shape: () => import("./atlasShapeSampler"),
  disease: () => import("./atlasDiseaseSampler"),
  renderer: () => import("./atlasDiseaseLocal"),
};
import { PhotoDetailControl } from "./PhotoDetailControl";
import type { PhotoTileInfo } from "./photoDetail";
import { ApiNotice } from "./ApiNotice";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, Box, Camera, Check, ChevronDown,
  CircleHelp, ExternalLink, FlaskConical, Focus, Layers3, LoaderCircle, RotateCcw, Search,
  Settings2, Shuffle, Sparkles, X, Hand, Undo2, Redo2,
} from "lucide-react";
import { AtlasViewport, type AtlasMeshStats, type AtlasView, type AtlasViewportHandle } from "./AtlasViewport";
import { AtlasSurfacePanel } from "./AtlasSurfacePanel";
import { ReferenceMaterialPanel } from "./ReferenceMaterialPanel";
import { AtlasDiseasePanel } from "./AtlasDiseasePanel";
import { AtlasModelsPanel } from "./AtlasModelsPanel";
import { AtlasModelSelector } from "./AtlasModelSelector";
import { AtlasPhysicsLab } from "./AtlasPhysicsLab";
import { sameAtlasDisease, type AtlasDiseaseSpec } from "./atlasDisease";
import { sameAtlasMaterial, validateAtlasMaterial, type AtlasMaterialRecipe } from "./atlasMaterial";
import {
  atlasError, defaultAtlasSpec, safeSourceUrl, sameAtlasRecipe, sameAtlasGeometry, sampleAtlasRecipe, validateAtlasCatalog,
  validateAtlasGeneration, validateAtlasSpec, validateAtlasDiseaseSampling, validateAtlasJointSampling,
  type AtlasAppearance, type AtlasCatalog, type AtlasGeneration, type AtlasSpec,
} from "./atlas";
import { applySculptEdits, commitSculpt, emptySculptHistory, redoSculpt, undoSculpt, type SurfaceEdit } from "./atlasSculptHistory";
import { createAtlasVesselNetwork } from "./atlasVessels";
// the whole scene (its viewport, physics and tools) loads only when opened
const WholeSceneStudio = lazy(() => import("./WholeSceneStudio"));
import "./atlas.css";

const modes: { id: AtlasAppearance; label: string; title: string }[] = [
  { id: "tissue", label: "Tissue", title: "Designed tissue appearance; not measured reflectance" },
  { id: "clay", label: "Clay", title: "Neutral material to inspect the geometry" },
  { id: "source", label: "Source", title: "Reference model colors" },
];
const views: { id: AtlasView; label: string }[] = [
  { id: "front", label: "Front" }, { id: "back", label: "Back" },
  { id: "top", label: "Top" }, { id: "oblique", label: "¾ view" },
];
const count = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const description = (key: string) => ({
  scale_x: "Width along the reference X axis", scale_y: "Height along the reference Y axis",
  scale_z: "Depth along the reference Z axis", bend: "Smooth curvature through the reference",
  twist: "Gradual rotation along the reference", taper: "Relative fullness from one end to the other",
  asymmetry: "Smooth, bounded left–right shape imbalance",
}[key] ?? "Bounded variation relative to the selected reference");
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function errorText(error: unknown) { return error instanceof Error ? error.message : "The request could not be completed."; }
const emptyStats: AtlasMeshStats = { triangles: 0, vertices: 0, extentMm: [0, 0, 0] };

/** textureLab: the texture lab (textures.html, ?mode=textures). The photo-derived detail layer and its controls exist
 * only there; the organ studio proper keeps its procedural surfaces exactly as before that layer existed. */
export default function AtlasStudio({ textureLab = false }: { textureLab?: boolean } = {}) {
  const [wholeSceneOpen, setWholeSceneOpen] = useState(() => /^(textures-)?scene$/.test(new URLSearchParams(window.location.search).get("mode") ?? ""));
  const switchWorkspace = (open: boolean) => {
    if (open) { cancelPendingPreview(); activeRequest.current?.abort(); ++requestId.current; setBusy(null); }
    setWholeSceneOpen(open);
    const url = new URL(window.location.href);
    url.searchParams.set("mode", textureLab ? (open ? "textures-scene" : "textures") : (open ? "scene" : "atlas"));
    window.history.replaceState(null, "", url);
  };
  const [catalog, setCatalog] = useState<AtlasCatalog | null>(null);
  const catalogRef = useRef<AtlasCatalog | null>(null);
  const [draft, setDraft] = useState<AtlasSpec | null>(null);
  const [generated, setGenerated] = useState<AtlasGeneration | null>(null);
  const committed = useRef<AtlasGeneration | null>(null);
  const committedSurface = useRef<AtlasMaterialRecipe | null>(null);
  const [surfaceDraft, setSurfaceDraft] = useState<AtlasMaterialRecipe | null>(null);
  const [photoDetail, setPhotoDetail] = useState(textureLab ? 1 : 0);   // photo-derived surface detail (photoDetail.ts): the texture lab's layer, 0 = the plain material
  const [photoRelief, setPhotoRelief] = useState(textureLab ? 0.03 : 0);
  const [photoTile, setPhotoTile] = useState<PhotoTileInfo | null>(null);
  const [surfaceSeedText, setSurfaceSeedText] = useState("42");
  const [inspectorTab, setInspectorTab] = useState<"shape" | "surface" | "disease" | "sculpt">(textureLab ? "surface" : "shape");
  const [diseaseSeedText, setDiseaseSeedText] = useState("42");
  const [seedText, setSeedText] = useState("42");
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"library" | "generate" | "compile" | "learned" | "joint" | "disease" | "surface" | "preview" | null>("library");
  const [exporting, setExporting] = useState(false);
  const [sculptHistory, setSculptHistory] = useState(emptySculptHistory);
  const sculptHistoryRef = useRef(sculptHistory); sculptHistoryRef.current = sculptHistory;
  const [sculptEnabled, setSculptEnabled] = useState(false);
  const [sculptRadius, setSculptRadius] = useState(35);
  const [sculptStiffness, setSculptStiffness] = useState(0.45);
  const [sculptReport, setSculptReport] = useState("");
  const [vesselsEnabled, setVesselsEnabled] = useState(true);
  const [vesselDensity, setVesselDensity] = useState(0.5);
  const [vesselVisibility, setVesselVisibility] = useState(0.65);
  const [vesselRadiusScale, setVesselRadiusScale] = useState(1);
  const [vesselSeed, setVesselSeed] = useState(42);
  const [error, setError] = useState("");
  const [textMessage, setTextMessage] = useState<{ accepted: boolean; text: string } | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [matchDimensions, setMatchDimensions] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [physicsGeneration, setPhysicsGeneration] = useState<AtlasGeneration | null>(null);
  const physicsButton = useRef<HTMLButtonElement>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const modelSwitchingRef = useRef(false);
  const [modelRevision, setModelRevision] = useState(0);
  const [modelNotice, setModelNotice] = useState("");
  const modelsButton = useRef<HTMLButtonElement>(null);
  const modelsFocusReturn = useRef<HTMLButtonElement | null>(null);
  const [textAdapterAvailable, setTextAdapterAvailable] = useState(false);
  const [useTextAdapter, setUseTextAdapter] = useState(false);
  const [jointAvailable, setJointAvailable] = useState(false);
  // the trained shape and disease samplers: active in the model status and, without the API, bundled with this copy
  const [learnedAvailable, setLearnedAvailable] = useState(false);
  const [diseaseSamplerAvailable, setDiseaseSamplerAvailable] = useState(false);
  const [jointTemperature, setJointTemperature] = useState(1);
  const [jointGeneration, setJointGeneration] = useState<1 | 2>(1);
  const jointGenerationRef = useRef<1 | 2>(1);
  const catalogRefreshId = useRef(0);
  const [jointSeverity, setJointSeverity] = useState<"auto" | "mild" | "moderate" | "severe">("auto");
  const updateJointState = useCallback(async (available: boolean, generation: 1 | 2 = 1) => {
    setModelRevision(revision => revision + 1);
    setJointGeneration(generation);
    const rendererVersion = generation === 2 ? "disease-v2" : undefined;
    if (jointGenerationRef.current === generation && catalogRef.current?.renderer_version === rendererVersion) { setJointAvailable(available); return true; }
    jointGenerationRef.current = generation;
    setJointAvailable(false);
    const refreshId = ++catalogRefreshId.current;
    setJointSeverity("auto");
    return await apiGet("/api/atlas/catalog", undefined, "atlas/catalog.json").then(async response => {
      if (!response.ok) throw await atlasError(response);
      const next: unknown = await response.json(); validateAtlasCatalog(next);
      if (refreshId !== catalogRefreshId.current) return false;
      if (next.renderer_version !== rendererVersion) throw new Error("The active model changed while its anatomy library was loading. Reopen Trained models to refresh it.");
      catalogRef.current = next; setCatalog(next);
      setJointAvailable(available);
      setDraft(current => {
        if (!current) return current;
        const recipe = { ...current };
        if (next.renderer_version) recipe.renderer_version = next.renderer_version;
        else delete recipe.renderer_version;
        if (recipe.disease && !next.diseases?.profiles.some(profile => profile.id === recipe.disease?.profile_id && profile.supported !== false)) delete recipe.disease;
        return recipe;
      });
      return true;
    }).catch(cause => { if (refreshId === catalogRefreshId.current) setError(errorText(cause)); return false; });
  }, []);
  const updateLanguageState = useCallback((enabled: boolean, explicitlySelected = false) => {
    setTextAdapterAvailable(enabled);
    // Availability is not consent to use a research adapter. Status refreshes
    // must preserve an opt-out; only the explicit Enable action selects it.
    if (!enabled) setUseTextAdapter(false);
    else if (explicitlySelected) setUseTextAdapter(true);
  }, []);
  useEffect(() => {
    if (wholeSceneOpen) return;
    const controller = new AbortController();
    // the public copy carries the API's model status and, for the samplers that run in the browser, the models
    // themselves (public/models/*): without the API a sampler is available when its metadata is bundled
    void apiGet("/api/atlas/models", { signal: controller.signal }, "atlas/models.json").then(async response => {
      if (!response.ok) throw new Error("Text adapter availability could not be checked");
      const status = await response.json();
      updateLanguageState(status.source === "imported" && status.language_enabled === true && !status.wording_bundle_sha256);
      const online = await apiOnline();
      // offline, a sampler is available when its exported model is bundled (the metadata file is enough to know)
      const bundled = (model: string) => online || fetch(publicUrl(`models/${model}/model.json`), { signal: controller.signal }).then((r) => r.ok, () => false);
      const [joint, shape, disease] = await Promise.all([bundled("joint-v2"), bundled("shape-v2"), bundled("disease-recipes-v2")]);
      setJointAvailable(joint && status.lanes?.joint?.status === "active" && /^[a-f0-9]{64}$/.test(status.joint_bundle_sha256));
      setLearnedAvailable(shape && status.lanes?.shape?.status === "active");
      setDiseaseSamplerAvailable(disease && status.lanes?.disease?.status === "active");
      const generation = status.joint_generation === 2 ? 2 : 1;
      setJointGeneration(generation); jointGenerationRef.current = generation;
    }).catch(() => { if (!controller.signal.aborted) { updateLanguageState(false); setJointAvailable(false); setLearnedAvailable(false); setDiseaseSamplerAvailable(false); } });
    return () => controller.abort();
  }, [updateLanguageState, wholeSceneOpen]);
  const [variationStrength, setVariationStrength] = useState(1);
  const [stats, setStats] = useState(emptyStats);
  const [details, setDetails] = useState(false);
  const [view, setView] = useState<AtlasView>("oblique");
  const [mobilePanel, setMobilePanel] = useState<"library" | "shape" | null>(null);
  const viewport = useRef<AtlasViewportHandle>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const controlsDisabled = modelSwitching || Boolean(busy && busy !== "preview");

  const cancelPendingPreview = useCallback(() => {
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    previewTimer.current = null;
  }, []);

  const handleModelBusy = useCallback((switching: boolean) => {
    modelSwitchingRef.current = switching;
    setModelSwitching(switching);
    if (switching) cancelPendingPreview();
  }, [cancelPendingPreview]);
  const handleModelActivated = useCallback(async (available: boolean, generation: 1 | 2) => {
    if (!await updateJointState(available, generation)) throw new Error("The anatomy controls could not be refreshed.");
    setError("");
    setModelNotice("Model switched. Generate a joint variation to apply it to your organ.");
  }, [updateJointState]);

  const generate = useCallback(async (spec: AtlasSpec, options: { learned?: boolean; jointTemperature?: number; severity?: "auto" | "mild" | "moderate" | "severe"; matchDimensions?: boolean; surfaceOnly?: boolean; sampleSurface?: boolean; sampleDisease?: boolean; preview?: boolean } = {}): Promise<boolean> => {
    if (modelSwitchingRef.current) return false;
    if (sculptHistoryRef.current.present.length && committed.current && (options.learned || options.jointTemperature !== undefined || options.sampleDisease || !sameAtlasGeometry(committed.current.spec, spec))) {
      cancelPendingPreview(); setBusy(null);
      const previous = committed.current.spec;
      draftRef.current = previous; setDraft(previous);
      setSeedText(String(previous.seed)); setDiseaseSeedText(String(previous.disease?.seed ?? 42));
      setError("Reset the sculpture before generating a different shape. Surface appearance edits preserve your sculpture.");
      return false;
    }
    cancelPendingPreview();
    activeRequest.current?.abort();
    const id = ++requestId.current;
    const library = catalogRef.current;
    if (!library) { setBusy(null); return false; }
    try { validateAtlasSpec(spec, library); } catch (cause) { setError(errorText(cause)); setBusy(null); return false; }
    const controller = new AbortController();
    activeRequest.current = controller;
    const joint = options.jointTemperature !== undefined;
    setBusy(options.preview ? "preview" : joint ? "joint" : options.learned ? "learned" : options.sampleDisease ? "disease" : options.surfaceOnly ? "surface" : "generate"); setError("");
    const expectedGeometry = options.surfaceOnly ? committed.current?.scene.metadata?.geometry_sha256 : undefined;
    try {
      let result: unknown;
      if (!(await apiOnline())) {
        // the public copy has no generation service: the API's routes run in the browser from the bundled reference
        // specimen of the template — the joint flow (atlasJointLocal.ts), the trained shape sampler (atlasShapeSampler.ts),
        // the trained disease sampler (atlasDiseaseSampler.ts), and plain generation through realizeSpecLocally
        // (the disease-v2 morphology in atlasDiseaseLocal.ts, the healthy surface in atlasLocal.ts); the trained
        // material sampler alone still needs the API
        if (options.sampleSurface) throw new Error(NEEDS_API.materialSampler);
        const reference = await bundledReference(spec.template_id, controller.signal);
        const template = library.organs.flatMap((organ) => organ.templates).find((item) => item.id === spec.template_id);
        if (!template) throw new Error("Unknown reference.");
        result = joint ? await (await samplers.joint()).sampleJointLocally(reference, template, spec, options.jointTemperature!, options.severity ?? "auto", library.diseases, controller.signal)
          : options.learned ? await (await samplers.shape()).sampleShapeLocally(reference, template, spec, options.matchDimensions ?? true, library.diseases, controller.signal)
          : options.sampleDisease ? await (await samplers.disease()).sampleDiseaseLocally(reference, template, spec, library.diseases, controller.signal)
          : sameAtlasRecipe(spec, defaultAtlasSpec(library, spec.template_id)) ? reference
          : await (await samplers.renderer()).realizeSpecLocally(reference, spec, template, library.diseases, controller.signal);
      } else {
        const response = await fetch(apiUrl(joint ? "/api/atlas/sample-joint" : options.sampleDisease ? "/api/atlas/sample-disease" : options.learned ? "/api/atlas/sample" : options.sampleSurface ? "/api/atlas/sample-material" : "/api/atlas/generate"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(joint ? { spec, seed: spec.seed, temperature: options.jointTemperature, ...(options.severity ? { severity: options.severity } : {}) } : options.sampleDisease ? { spec, seed: spec.disease?.seed } : options.learned ? { spec, match_dimensions: options.matchDimensions ?? true } : options.sampleSurface ? { spec, seed: spec.material?.seed } : spec), signal: controller.signal,
        });
        if (!response.ok) throw await atlasError(response);
        result = await response.json();
      }
      validateAtlasGeneration(result, library);
      if (joint) {
        validateAtlasJointSampling(spec, result, options.jointTemperature!, options.severity ?? "auto");
      } else if (options.sampleDisease) {
        validateAtlasDiseaseSampling(spec, result);
      } else if (options.learned) {
        if (result.spec.template_id !== spec.template_id || result.spec.seed !== spec.seed || result.spec.appearance !== spec.appearance || !sameAtlasMaterial(result.spec.material, spec.material) || !sameAtlasDisease(result.spec.disease, spec.disease) ||
            !result.summary.model || typeof result.summary.model !== "object" || Array.isArray(result.summary.model))
          throw new Error("The learned variation did not preserve the requested reference, seed and appearance, or has no model provenance.");
      } else if (options.sampleSurface) {
        if (!sameAtlasRecipe({ ...spec, material: null }, { ...result.spec, material: null }) ||
            result.spec.material?.organ !== spec.material?.organ || result.spec.material?.preset !== spec.material?.preset || result.spec.material?.seed !== spec.material?.seed ||
            !result.summary.material_model || typeof result.summary.material_model !== "object" || Array.isArray(result.summary.material_model))
          throw new Error("The sampled surface did not preserve the requested anatomy, preset and appearance seed, or has no material-model provenance.");
      } else if (!sameAtlasRecipe(spec, result.spec)) throw new Error("The returned recipe differs from the requested variation. The previous preview was preserved.");
      if (id !== requestId.current) return false;
      if (options.surfaceOnly) {
        const before = expectedGeometry;
        const after = result.scene.metadata?.geometry_sha256;
        if (typeof before !== "string" || before !== after)
          throw new Error("The surface update did not preserve the displayed geometry. The previous preview was preserved.");
      }
      const previous = committed.current;
      if (previous && (!sameAtlasGeometry(previous.spec, result.spec) || previous.scene.metadata?.geometry_sha256 !== result.scene.metadata?.geometry_sha256)) {
        setSculptHistory(emptySculptHistory()); setSculptReport("");
      }
      committed.current = result; setGenerated(result);
      if (joint) setModelNotice("");
      draftRef.current = result.spec; setDraft(result.spec);
      // Shape seeds configure explicit sampling, not the geometry sliders.
      // Keep a seed being typed while a background preview finishes.
      if (!options.preview) { setSeedText(String(result.spec.seed)); setDiseaseSeedText(String(result.spec.disease?.seed ?? 42)); }
      const organ = library.organs.find((entry) => entry.templates.some((template) => template.id === result.spec.template_id));
      const surface = result.spec.material ?? (committedSurface.current?.organ === organ?.id ? committedSurface.current : undefined) ?? (organ ? library.materials?.defaults[organ.id] : undefined) ?? null;
      committedSurface.current = surface;
      setSurfaceDraft(surface ? { ...surface } : null);
      if (!options.preview) setSurfaceSeedText(String(surface?.seed ?? 42));
      if (!options.preview) setMobilePanel(null);
      return true;
    } catch (cause) {
      if (id === requestId.current && !controller.signal.aborted) {
        setError(errorText(cause));
        const previous = committed.current;
        if (previous && spec.template_id !== previous.spec.template_id) {
          // A failed reference selection must not leave the previous organ's
          // surface panel editing a different, undisplayed template.
          draftRef.current = previous.spec; setDraft(previous.spec); setSeedText(String(previous.spec.seed)); setDiseaseSeedText(String(previous.spec.disease?.seed ?? 42));
          const surface = committedSurface.current;
          setSurfaceDraft(surface ? { ...surface } : null); setSurfaceSeedText(String(surface?.seed ?? 42));
        }
      }
      return false;
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  }, [cancelPendingPreview]);

  const isSurfaceOnly = (spec: AtlasSpec) => {
    const previous = committed.current?.spec;
    return Boolean(catalogRef.current?.materials && previous && sameAtlasGeometry(previous, spec));
  };
  const schedulePreview = (spec: AtlasSpec) => {
    // Invalidate immediately, before the debounce: an older response must not
    // commit while a newer slider value is waiting to be sent.
    cancelPendingPreview();
    activeRequest.current?.abort(); ++requestId.current;
    draftRef.current = spec; setDraft(spec); setTextMessage(null); setError("");
    setBusy("preview");
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null;
      void generate(spec, { preview: true, surfaceOnly: isSurfaceOnly(spec) });
    }, 240);
  };
  const editControls = (controls: AtlasSpec["controls"]) => {
    if (draftRef.current) schedulePreview({ ...draftRef.current, controls });
  };
  const editSurface = (material: AtlasMaterialRecipe) => {
    setSurfaceDraft(material); setSurfaceSeedText(String(material.seed));
    if (draftRef.current) schedulePreview({ ...draftRef.current, material, appearance: "tissue" });
  };
  const editSurfaceSeed = (value: string) => {
    setSurfaceSeedText(value);
    if (!surfaceDraft) return;
    const seed = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
    if (Number.isSafeInteger(seed) && seed >= 0 && seed <= 4294967295) {
      const material = { ...surfaceDraft, seed };
      setSurfaceDraft(material);
      if (draftRef.current) schedulePreview({ ...draftRef.current, material, appearance: "tissue" });
    } else {
      // Invalid in-progress text must not be replaced by an earlier response.
      cancelPendingPreview(); activeRequest.current?.abort(); ++requestId.current; setBusy(null);
    }
  };

  const editDisease = (disease: AtlasDiseaseSpec | null) => {
    const current = draftRef.current;
    if (!current) return;
    setDiseaseSeedText(String(disease?.seed ?? 42));
    const next = { ...current };
    if (catalogRef.current?.renderer_version) next.renderer_version = catalogRef.current.renderer_version;
    if (disease) next.disease = disease;
    else delete next.disease;
    schedulePreview(next);
  };
  const editDiseaseSeed = (value: string) => {
    setDiseaseSeedText(value);
    const current = draftRef.current;
    if (!current?.disease) return;
    const seed = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
    if (Number.isSafeInteger(seed) && seed >= 0 && seed <= 4294967295) {
      schedulePreview({ ...current, disease: { ...current.disease, seed } });
    } else {
      cancelPendingPreview(); activeRequest.current?.abort(); ++requestId.current; setBusy(null);
    }
  };

  useEffect(() => {
    if (wholeSceneOpen || committed.current) return;
    const controller = new AbortController();
    let live = true;
    const load = async () => {
      try {
        const response = await apiGet("/api/atlas/catalog", { signal: controller.signal }, "atlas/catalog.json");
        if (!response.ok) throw await atlasError(response);
        const result: unknown = await response.json();
        validateAtlasCatalog(result);
        if (!live) return;
        catalogRef.current = result; setCatalog(result);
        const requested = new URLSearchParams(window.location.search).get("template");
        const template = result.organs.flatMap((organ) => organ.templates).find((item) => item.id === requested)
          ?? result.organs.find((organ) => organ.id === "liver")?.templates[0]
          ?? result.organs[0]!.templates[0]!;
        const spec = defaultAtlasSpec(result, template.id);
        setDraft(spec);
        await generate(spec);
      } catch (cause) {
        if (live && !controller.signal.aborted) { setError(errorText(cause)); setBusy(null); }
      }
    };
    void load();
    return () => { live = false; controller.abort(); cancelPendingPreview(); activeRequest.current?.abort(); ++requestId.current; };
  }, [generate, cancelPendingPreview, wholeSceneOpen]);

  const selectedOrgan = catalog?.organs.find((organ) => organ.templates.some((template) => template.id === draft?.template_id));
  const displayedOrgan = catalog?.organs.find((organ) => organ.templates.some((template) => template.id === generated?.spec.template_id));
  const vesselScene = useMemo(() => {
    const scene = generated?.scene;
    if (!scene || !vesselsEnabled || !generated.spec.material || generated.spec.appearance !== "tissue") return scene ?? null;
    return { ...scene, organs: scene.organs.map(organ => ({ ...organ, metadata: {
      ...organ.metadata, surface_vessels: createAtlasVesselNetwork(organ, {
        organId: displayedOrgan?.id ?? "liver", seed: vesselSeed, density: vesselDensity,
        visibility: vesselVisibility, radiusScale: vesselRadiusScale,
      }),
    } })) };
  }, [generated?.scene, generated?.spec.appearance, displayedOrgan?.id, vesselsEnabled, vesselSeed, vesselDensity, vesselVisibility, vesselRadiusScale]);
  const displayedScene = useMemo(() => vesselScene ? applySculptEdits(vesselScene, sculptHistory.present) : null, [vesselScene, sculptHistory.present]);
  // The physics service reconstructs the committed recipe; local sculpture
  // cannot be reproduced by that contract yet.
  const physicsSupported = displayedOrgan?.id === "liver" && !sculptHistory.present.length;
  const physicsDisabled = !generated || !physicsSupported || Boolean(busy) || exporting || modelSwitching || modelsOpen;
  const physicsHelp = !generated ? "Select a liver reference to explore physical interaction."
    : displayedOrgan?.id !== "liver" ? "Hands-on physics currently supports liver only."
    : sculptHistory.present.length ? "Reset the sculpture to use the physics lab."
    : "Grasp, press and release the displayed liver.";
  const openPhysicsLab = () => {
    if (physicsDisabled || !generated || !displayedScene) return;
    setSculptEnabled(false);
    setPhysicsGeneration({ ...generated, scene: displayedScene });
  };
  const onSculptCommit = useCallback((edit: SurfaceEdit, report: string) => {
    setSculptHistory(history => commitSculpt(history, edit)); setSculptReport(report);
  }, []);
  const displayedTemplate = displayedOrgan?.templates.find((template) => template.id === generated?.spec.template_id);
  const dirty = !sameAtlasRecipe(draft, generated?.spec ?? null);
  const surfacePending = !sameAtlasMaterial(surfaceDraft, generated?.spec.material) || (surfaceDraft !== null && String(surfaceDraft.seed) !== surfaceSeedText);
  const diseaseSummary = generated?.summary.disease;
  const displacementLimited = Boolean(diseaseSummary && typeof diseaseSummary === "object" && "displacement_limited_by_source_mesh" in diseaseSummary && diseaseSummary.displacement_limited_by_source_mesh === true);
  const displacementFraction = diseaseSummary && typeof diseaseSummary === "object" && "applied_displacement_fraction" in diseaseSummary && typeof diseaseSummary.applied_displacement_fraction === "number" && Number.isFinite(diseaseSummary.applied_displacement_fraction) && diseaseSummary.applied_displacement_fraction >= 0 && diseaseSummary.applied_displacement_fraction <= 1 ? diseaseSummary.applied_displacement_fraction : undefined;
  const shapeProjection = diseaseSummary && typeof diseaseSummary === "object" && "shape_control_projection" in diseaseSummary ? diseaseSummary.shape_control_projection : undefined;
  const appliedShapeFraction = shapeProjection && typeof shapeProjection === "object" && "applied_fraction" in shapeProjection && typeof shapeProjection.applied_fraction === "number" && Number.isFinite(shapeProjection.applied_fraction) && shapeProjection.applied_fraction >= 0 && shapeProjection.applied_fraction < 1 ? shapeProjection.applied_fraction : undefined;
  const diseasePending = !sameAtlasDisease(draft?.disease, generated?.spec.disease) || Boolean(draft?.disease && String(draft.disease.seed) !== diseaseSeedText);
  const filteredOrgans = useMemo(() => catalog?.organs.filter((organ) =>
    `${organ.label} ${organ.templates.map((template) => template.label).join(" ")}`.toLowerCase().includes(search.toLowerCase().trim()),
  ) ?? [], [catalog, search]);
  const sourceLink = safeSourceUrl(displayedTemplate?.source_url ?? displayedTemplate?.url);
  const referenceNote = ({
    brain: "The male and female brain references share Allen atlas geometry resized to each body. They are not independent donor brains.",
    "urinary-bladder": "Reference configuration; filling state unknown. Flattening is retained from the source rather than interpreted as pathology.",
    kidney: "These capsule and hilum display surfaces retain open recesses. They are not closed parenchymal volumes.",
    stomach: "This BodyParts3D reference is a strongly reduced mesh. Rendering cannot recover its missing fine geometry.",
    gallbladder: "This BodyParts3D reference is a strongly reduced mesh. Rendering cannot recover its missing fine geometry.",
  } as Record<string, string>)[displayedOrgan?.id ?? ""];

  const currentDraft = (): AtlasSpec | null => {
    if (!draftRef.current || !catalog) return null;
    const spec = { ...draftRef.current, seed: /^\d+$/.test(seedText.trim()) ? Number(seedText) : NaN };
    if (spec.disease) spec.disease = { ...spec.disease, seed: /^\d+$/.test(diseaseSeedText.trim()) ? Number(diseaseSeedText) : NaN };
    validateAtlasSpec(spec, catalog);
    return spec;
  };
  const applyDraft = () => {
    try { const spec = currentDraft(); if (spec) void generate(spec); }
    catch (cause) { setError(errorText(cause)); }
  };
  const applySurface = (sample = false, override?: AtlasMaterialRecipe) => {
    if (!generated || !surfaceDraft || controlsDisabled) return;
    try {
      const material = { ...(override ?? surfaceDraft), seed: /^\d+$/.test(surfaceSeedText.trim()) ? Number(surfaceSeedText) : NaN };
      validateAtlasMaterial(material, displayedOrgan?.id);
      setTextMessage(null);
      const spec = { ...(draftRef.current ?? generated.spec), material, appearance: "tissue" as const };
      void generate(spec, { surfaceOnly: isSurfaceOnly(spec), sampleSurface: sample });
    } catch (cause) { setError(errorText(cause)); }
  };
  const sampleVariation = (freshSeed = false) => {
    try {
      const spec = currentDraft();
      if (spec && catalog) {
        if (freshSeed) {
          const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
          spec.seed = seed === spec.seed ? (seed + 1) >>> 0 : seed;
        }
        const sampled = sampleAtlasRecipe(catalog, spec, variationStrength);
        draftRef.current = sampled; setDraft(sampled); setSeedText(String(sampled.seed)); setTextMessage(null); void generate(sampled);
      }
    } catch (cause) { setError(errorText(cause)); }
  };
  const learnedVariation = () => {
    try {
      const spec = currentDraft();
      if (spec?.disease) throw new Error("Use Learned disease variation while a disease profile is active.");
      if (spec) { setTextMessage(null); void generate(spec, { learned: true, matchDimensions }); }
    } catch (cause) { setError(errorText(cause)); }
  };
  const learnedDiseaseVariation = () => {
    try {
      const spec = currentDraft();
      if (spec?.disease) { setTextMessage(null); void generate(spec, { sampleDisease: true }); }
    } catch (cause) { setError(errorText(cause)); }
  };
  const jointVariation = (freshSeed = false) => {
    if (!jointAvailable || controlsDisabled) return;
    try {
      const spec = currentDraft();
      if (spec) {
        if (freshSeed) {
          const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
          spec.seed = seed === spec.seed ? (seed + 1) >>> 0 : seed;
        }
        setTextMessage(null);
        void generate(spec, { jointTemperature, ...(jointGeneration === 2 ? { severity: spec.disease ? jointSeverity : "auto" } : {}) });
      }
    } catch (cause) { setError(errorText(cause)); }
  };
  const chooseTemplate = (id: string) => {
    if (!catalog) return;
    const spec = defaultAtlasSpec(catalog, id);
    spec.appearance = draft?.appearance ?? "tissue";
    if (spec.appearance !== "tissue") delete spec.material;
    draftRef.current = spec; setDraft(spec); setSeedText(String(spec.seed)); setDiseaseSeedText("42"); setTextMessage(null); setPrompt("");
    void generate(spec);
  };
  const compile = async () => {
    if (!prompt.trim() || (busyRef.current && busyRef.current !== "preview")) return;
    let spec: AtlasSpec | null;
    try { spec = currentDraft(); } catch (cause) { setError(errorText(cause)); return; }
    if (!spec || !catalog) return;
    cancelPendingPreview(); activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const id = ++requestId.current;
    setBusy("compile"); setError(""); setTextMessage(null);
    try {
      const response = await fetch(apiUrl("/api/atlas/compile"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt.trim(), spec, ...(useTextAdapter ? { use_trained_language: true } : {}) }), signal: controller.signal,
      });
      if (!response.ok) throw await atlasError(response);
      const result = await response.json() as Record<string, unknown>;
      if (id !== requestId.current) return;
      if (!["accepted", "clarify", "unsupported"].includes(String(result.status)) || typeof result.message !== "string")
        throw new Error("The text compiler returned an invalid response.");
      if (result.status !== "accepted") {
        setTextMessage({ accepted: false, text: result.message });
        return;
      }
      validateAtlasSpec(result.spec, catalog);
      const succeeded = await generate(result.spec);
      if (succeeded) setTextMessage({ accepted: true, text: result.message });
    } catch (cause) {
      if (id === requestId.current && !controller.signal.aborted) setError(errorText(cause));
    } finally { if (id === requestId.current) setBusy(null); }
  };
  const changeAppearance = (appearance: AtlasAppearance) => {
    if (controlsDisabled) return;
    try {
      const spec = draftRef.current;
      if (spec) {
        const next = { ...spec, appearance };
        const lastSurface = committedSurface.current;
        if (appearance !== "tissue") delete next.material;
        else if (lastSurface && lastSurface.organ === selectedOrgan?.id) next.material = { ...lastSurface };
        void generate(next, { surfaceOnly: isSurfaceOnly(next) });
      }
    } catch (cause) { setError(errorText(cause)); }
  };
  const exportGLB = async (format: "glb" | "unity" = "glb") => {
    if (!generated || exporting) return;
    setExporting(true); setError("");
    const spec = generated.spec;
    try {
      const response = await fetch(apiUrl("/api/atlas/export"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec, format, texture_resolution: format === "unity" ? 4096 : 2048,
          ...(sculptHistory.present.length ? { surface_edits: sculptHistory.present } : {}),
          ...(vesselScene ? { surface_vessels: vesselScene.organs.filter(organ => organ.metadata?.surface_vessels).map(organ => ({ organ_id: organ.id, network: organ.metadata!.surface_vessels })) } : {}),
        }),
      });
      if (!response.ok) throw await atlasError(response);
      const blob = await response.blob();
      const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (format === "glb" && (header.length !== 4 || String.fromCharCode(...header) !== "glTF"))
        throw new Error("The server did not return a valid GLB file.");
      if (format === "unity" && (header[0] !== 80 || header[1] !== 75)) throw new Error("The server did not return a Unity ZIP package.");
      saveBlob(blob, `viscera-${spec.template_id.replace(/[^a-z0-9_-]/gi, "-")}-${spec.seed}${format === "unity" ? "-unity-4k.zip" : ".glb"}`);
    } catch (cause) { setError(errorText(cause)); }
    finally { setExporting(false); }
  };
  const capture = () => {
    const data = viewport.current?.screenshot();
    if (!data || !generated) return;
    const link = document.createElement("a"); link.href = data;
    link.download = `viscera-${generated.spec.template_id}-${view}.png`; link.click();
  };

  useEffect(() => { if (generated) reportReady(textureLab ? "textures" : "atlas"); }, [generated, textureLab]);
  useEffect(() => { if (error) reportError(error); }, [error]);

  if (wholeSceneOpen) return <Suspense fallback={<div className="atlas-loading" role="status">Loading the whole scene…</div>}><WholeSceneStudio onBack={() => switchWorkspace(false)} textureLab={textureLab} /></Suspense>;

  return <div className={`atlas-studio ${mobilePanel ? `atlas-show-${mobilePanel}` : ""}`}>
    <header className="atlas-header">
      <a className="atlas-brand" href={textureLab ? "?mode=textures" : "?mode=atlas"} aria-label="VISCERA Atlas home"><Activity size={22} /><span>VISCERA <small>{textureLab ? "TEXTURE LAB" : "ATLAS"}</small></span></a>
      <div className="atlas-header-divider" />
      <nav className="anatomy-workspace-tabs" aria-label="Anatomy workspace"><button aria-current="page">Organ studio</button><button onClick={() => switchWorkspace(true)}>Whole scene</button></nav>
      <div className="atlas-header-fill" />
      <AtlasModelSelector disabled={Boolean(busy) || exporting || modelsOpen} revision={modelRevision} onBusyChange={handleModelBusy} onActivated={handleModelActivated} onManage={trigger => { modelsFocusReturn.current = trigger; setModelsOpen(true); }} />
      <button ref={modelsButton} className="atlas-btn atlas-models-button" disabled={modelSwitching || Boolean(busy) || exporting} onClick={() => { modelsFocusReturn.current = modelsButton.current; setModelsOpen(true); }}>Trained models</button>
      <a className="atlas-legacy-link" href="?mode=legacy"><ArrowLeft size={13} /> Procedural studio</a>
      <button className="atlas-btn atlas-unity-export" aria-label="Export Unity 4K" onClick={() => void exportGLB("unity")} disabled={!generated?.spec.material || exporting || modelSwitching || Boolean(busy)} title={generated?.spec.material ? "Download the displayed sculpture and 4096 × 4096 PBR texture maps for Unity" : "Switch to Tissue appearance to export Unity materials"}>
        {exporting ? <LoaderCircle size={15} className="atlas-spinning" /> : <ArrowDownToLine size={15} />}<span>{exporting ? "Baking…" : "Unity 4K"}</span>
      </button>
      <button className="atlas-btn atlas-export" aria-label="Export GLB" onClick={() => void exportGLB()} disabled={!generated || exporting || modelSwitching || Boolean(busy)} title={dirty || surfacePending || diseasePending ? "Export the displayed organ; unapplied edits are excluded" : "Export the displayed organ with provenance"}>
        {exporting ? <LoaderCircle size={15} className="atlas-spinning" /> : <ArrowDownToLine size={15} />}<span>Export GLB</span>
      </button>
    </header>
    <ApiNotice />
    {modelsOpen && <AtlasModelsPanel onClose={() => { setModelsOpen(false); requestAnimationFrame(() => (modelsFocusReturn.current ?? modelsButton.current)?.focus()); }} onLanguageState={updateLanguageState} onJointState={updateJointState} />}
    {physicsGeneration && <AtlasPhysicsLab generation={physicsGeneration} onClose={() => { setPhysicsGeneration(null); requestAnimationFrame(() => physicsButton.current?.focus()); }} />}

    <aside className="atlas-library" aria-label="Anatomy library">
      <div className="atlas-panel-heading"><span>REFERENCE LIBRARY</span><span className="atlas-counter">{catalog?.organs.length ?? "—"}</span><button className="atlas-mobile-close" onClick={() => setMobilePanel(null)} aria-label="Close library"><X size={16} /></button></div>
      <label className="atlas-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an organ" aria-label="Find an organ" /></label>
      <div className="atlas-organ-list">
        {filteredOrgans.map((organ, index) => <div key={organ.id} className={`atlas-organ-group ${selectedOrgan?.id === organ.id ? "selected" : ""}`}>
          <button className="atlas-organ-button" aria-pressed={selectedOrgan?.id === organ.id} disabled={modelSwitching} onClick={() => chooseTemplate(organ.templates[0]!.id)}>
            <span className="atlas-organ-index">{String(index + 1).padStart(2, "0")}</span><span>{organ.label}</span><span className="atlas-template-count">{organ.templates.length}</span><ChevronDown size={13} />
          </button>
          {selectedOrgan?.id === organ.id && <div className="atlas-template-list">{organ.templates.map((template) => <button key={template.id} className={draft?.template_id === template.id ? "active" : ""} aria-pressed={draft?.template_id === template.id} disabled={modelSwitching} onClick={() => chooseTemplate(template.id)}>
            <span className="atlas-reference-dot" /><span>{template.label}</span>{draft?.template_id === template.id && <Check size={12} />}
          </button>)}</div>}
        </div>)}
        {catalog && !filteredOrgans.length && <p className="atlas-empty-search">No organs match “{search}”.</p>}
        {!catalog && busy && <p className="atlas-library-loading"><LoaderCircle size={16} className="atlas-spinning" /> Loading reference library…</p>}
      </div>
      <div className="atlas-library-note"><Layers3 size={18} /><div><strong>Built on open anatomy</strong><p>Original reference shapes. Reproducible, bounded variations.</p></div></div>
    </aside>

    <main className="atlas-main">
      <div className="atlas-stage">
        <AtlasViewport ref={viewport} scene={displayedScene} sculptEnabled={sculptEnabled && !busy && !exporting} sculptRadius={sculptRadius} sculptStiffness={sculptStiffness} onSculptCommit={onSculptCommit} fitKey={generated?.spec.template_id} appearance={generated?.spec.appearance ?? "tissue"} wireframe={wireframe} photoDetail={photoDetail} photoRelief={photoRelief} onStats={setStats} onError={setError} />
        <div className="atlas-stage-heading">
          <div className="atlas-stage-eyebrow"><span />{generated ? "LIVE 3D PREVIEW" : "ANATOMY LIBRARY"}</div>
          <h1>{displayedOrgan?.label ?? "Explore anatomy"}</h1>
          <p>{displayedTemplate?.label ?? "Reference geometry, ready for close inspection"}</p>
          {generated?.spec.disease && <p className="atlas-stage-disease">{catalog?.diseases?.profiles.find(profile => profile.id === generated.spec.disease?.profile_id)?.label} · synthetic prototype</p>}
        </div>
        <div className="atlas-mobile-tools"><button onClick={() => setMobilePanel("library")}><Layers3 size={15} /> Organs</button><button onClick={() => setMobilePanel("shape")}><Settings2 size={15} /> Shape</button></div>
        <div className="atlas-material-tabs" role="group" aria-label="Preview material">{modes.map((mode) => <button key={mode.id} className={generated?.spec.appearance === mode.id ? "active" : ""} aria-pressed={generated?.spec.appearance === mode.id} disabled={!generated || modelSwitching || Boolean(busy)} title={mode.title} onClick={() => changeAppearance(mode.id)}>{mode.label}</button>)}</div>
        <div className="atlas-sculpt-toolbar" role="group" aria-label="Surface interaction">
          <button aria-pressed={!sculptEnabled} onClick={() => setSculptEnabled(false)}>Orbit</button>
          <button aria-pressed={sculptEnabled} disabled={!generated || Boolean(busy) || exporting} onClick={() => { setSculptEnabled(true); setInspectorTab("sculpt"); }}><Hand size={13} />Sculpt</button>
          <button aria-label="Undo sculpture" disabled={!sculptHistory.past.length || Boolean(busy)} onClick={() => setSculptHistory(undoSculpt)}><Undo2 size={13} /></button>
          <button aria-label="Redo sculpture" disabled={!sculptHistory.future.length || Boolean(busy)} onClick={() => setSculptHistory(redoSculpt)}><Redo2 size={13} /></button>
        </div>
        <div className="atlas-stage-tools">
          <button title="Fit organ in view" aria-label="Fit organ in view" onClick={() => viewport.current?.fit()} disabled={!generated}><Focus size={17} /></button>
          <button title="Toggle mesh wireframe" aria-label="Toggle mesh wireframe" aria-pressed={wireframe} className={wireframe ? "active" : ""} onClick={() => setWireframe(!wireframe)} disabled={!generated}><Box size={17} /></button>
          <button title="Save preview image" aria-label="Save preview image" onClick={capture} disabled={!generated}><Camera size={17} /></button>
          <button title="Reference and validation details" aria-label="Reference and validation details" aria-expanded={details} className={details ? "active" : ""} onClick={() => setDetails(!details)}><CircleHelp size={17} /></button>
        </div>
        {details && <div className="atlas-details"><div><strong>Reference & validation</strong><button aria-label="Close reference details" onClick={() => setDetails(false)}><X size={14} /></button></div>
          <dl><dt>Source</dt><dd>{displayedTemplate?.source ?? "Loading"}</dd><dt>License</dt><dd>{displayedTemplate?.license ?? "—"}</dd><dt>Coordinates</dt><dd>Centered, Y-up · millimetres</dd></dl>
          <p>Variants use a reference mesh with bounded deformations. Tissue colors are designed appearances. Anatomy and material response require expert validation.</p>
          {referenceNote && <p>{referenceNote}</p>}
          <p>Front / Back / Top are viewer directions. They do not establish patient orientation. The physics lab offers a synthetic liver interaction prototype; other organs and sculpted surfaces are not supported yet.</p>
          {sourceLink && <a href={sourceLink} target="_blank" rel="noreferrer">Open reference source <ExternalLink size={12} /></a>}
        </div>}
        {busy === "preview" ? <div className="atlas-live-progress" role="status"><LoaderCircle size={13} className="atlas-spinning" />Updating preview…</div> : busy && <div className={`atlas-progress ${generated ? "has-preview" : ""}`} role="status"><LoaderCircle size={21} className="atlas-spinning" /><span>{busy === "library" ? "Opening the anatomy library" : busy === "compile" ? "Interpreting your anatomy instruction" : busy === "joint" ? "Sampling shape, color and disease together" : busy === "learned" ? "Sampling the trained shape model" : busy === "disease" ? "Sampling the trained disease prior" : busy === "surface" ? "Preparing tissue appearance" : "Preparing reference geometry"}</span><small>{generated ? "The previous preview remains visible until this one is ready." : "Loading geometry and its source information"}</small></div>}
        {!generated && !busy && error && <div className="atlas-start-error"><Layers3 size={32} /><h2>The anatomy preview is unavailable</h2><p>{error}</p><button className="atlas-btn" onClick={() => catalog && draft ? void generate(draft) : window.location.reload()}>Try again <ArrowRight size={14} /></button></div>}
        <div className="atlas-stage-bottom"><div className="atlas-view-tabs" role="group" aria-label="Camera view">{views.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); viewport.current?.view(item.id); }} disabled={!generated}>{item.label}</button>)}</div><span className="atlas-orbit-hint">{sculptEnabled ? "Drag tissue to sculpt · Right-drag to orbit" : "Drag to orbit · Scroll to zoom"}</span></div>
        {generated && <div className="atlas-dimensions"><span>{stats.extentMm.map((n) => n.toFixed(1)).join(" × ")} <small>mm</small></span><span>X × Y × Z bounding size</span></div>}
      </div>
      <section className="atlas-physics-entry" aria-label="Physical interaction">
        <div><strong>Physical interaction</strong><p id="atlas-physics-help">{physicsHelp}</p></div>
        <button ref={physicsButton} className="atlas-btn" aria-haspopup="dialog" aria-describedby="atlas-physics-help" disabled={physicsDisabled} onClick={openPhysicsLab}><FlaskConical size={15} />Physics lab</button>
      </section>
      <section className="atlas-prompt-area" aria-label="Text to anatomy">
        {error && generated && <div className="atlas-inline-error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={14} /></button></div>}
        <div className="atlas-prompt-label"><Sparkles size={14} /><span>{catalog?.diseases ? "Anatomy with words" : catalog?.materials ? "Shape & surface with words" : "Shape with words"}</span><small>Bounded anatomical edits</small></div>
        {textAdapterAvailable && <label className="atlas-text-model-toggle"><input type="checkbox" checked={useTextAdapter} disabled={modelSwitching || Boolean(busy)} onChange={event => setUseTextAdapter(event.target.checked)} />Use trained text adapter · shape edits, compiler guarded</label>}
        <form className="atlas-prompt-box" onSubmit={(event) => { event.preventDefault(); void compile(); }}>
          <textarea aria-label="Describe an anatomy variation" placeholder={`Try “Make the ${(selectedOrgan?.label ?? "organ").toLowerCase()} slightly wider and ${catalog?.materials ? "wetter" : "less tapered"}”`} value={prompt} disabled={!draft || modelSwitching || Boolean(busy)} onChange={(event) => setPrompt(event.target.value)} rows={2} maxLength={2000} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void compile(); } }} />
          <button type="submit" className="atlas-prompt-send" aria-label="Apply text instruction" disabled={!prompt.trim() || !draft || modelSwitching || Boolean(busy)}>{busy === "compile" ? <LoaderCircle size={18} className="atlas-spinning" /> : <ArrowRight size={18} />}</button>
        </form>
        <div className={`atlas-text-feedback ${textMessage?.accepted === false ? "unsupported" : ""}`} aria-live="polite">{textMessage ? <><span>{textMessage.accepted ? <Check size={12} /> : <CircleHelp size={12} />}</span>{textMessage.text}</> : <span>{catalog?.diseases ? "Describe shape, surface or a supported disease profile." : catalog?.materials ? "Describe shape, tissue finish or pigment." : "Describe size, taper, bend, twist or asymmetry."} Unsupported requests stay unapplied.</span>}</div>
      </section>
    </main>

    <aside className="atlas-inspector" aria-label="Anatomy controls">
      <div className="atlas-panel-heading"><div className="atlas-inspector-tabs" role="tablist" aria-label="Anatomy editor" onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const tabs = ["shape", "surface", "disease", "sculpt"] as const;
          const index = tabs.indexOf(inspectorTab);
          const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[3] : tabs[(index + (event.key === "ArrowRight" ? 1 : 3)) % 4]!;
          setInspectorTab(next); if (next === "sculpt") setSculptEnabled(true); requestAnimationFrame(() => document.getElementById(`atlas-tab-${next}`)?.focus());
        }
      }}>{(["shape", "surface", "disease", "sculpt"] as const).map(tab => <button key={tab} id={`atlas-tab-${tab}`} role="tab" tabIndex={inspectorTab === tab ? 0 : -1} aria-selected={inspectorTab === tab} aria-controls={`atlas-${tab}-panel`} onClick={() => { setInspectorTab(tab); if (tab === "sculpt") setSculptEnabled(true); }}>{tab[0]!.toUpperCase() + tab.slice(1)}</button>)}</div><button className="atlas-mobile-close" onClick={() => setMobilePanel(null)} aria-label="Close anatomy controls"><X size={16} /></button></div>
      <div className="atlas-inspector-scroll">
        <section className="atlas-joint-controls" aria-label="Joint learned variation" hidden={inspectorTab === "sculpt" || inspectorTab === "surface"}>
          <div className="atlas-recipe-heading"><span>{jointGeneration === 2 ? "Joint shape + color flow" : "Joint shape + color VAE"}</span></div>
          {modelNotice && <p className="atlas-model-selection-notice" role="status">{modelNotice}</p>}
          <p className="atlas-model-help">{jointAvailable ? "Samples mesh, tissue color and the selected disease together. Choose Baseline in Disease for a disease-free variation." : "The bundled joint model is unavailable. Open Trained models to check its status or select another model."}</p>
          {jointAvailable && <>
            <label className="atlas-seed-label" htmlFor="atlas-joint-seed">Joint variation seed</label>
            <div className="atlas-seed"><input id="atlas-joint-seed" type="text" inputMode="numeric" autoComplete="off" value={seedText} disabled={!draft || controlsDisabled} onChange={event => setSeedText(event.target.value)} /><button aria-label="Randomize joint variation seed" disabled={!draft || controlsDisabled} onClick={() => setSeedText(String(crypto.getRandomValues(new Uint32Array(1))[0]!))}><Shuffle size={15} /></button></div>
            <label className="atlas-control"><span><span>Joint variation temperature</span><output>{jointTemperature.toFixed(1)}</output></span><input type="range" aria-label="Joint variation temperature" min={0.2} max={1.5} step={0.1} value={jointTemperature} disabled={!draft || controlsDisabled} onChange={event => setJointTemperature(Number(event.target.value))} /></label>
            {jointGeneration === 2 && <label className="atlas-variation-range"><span>Disease design range</span><select aria-label="Disease design range" value={jointSeverity} disabled={!draft?.disease || controlsDisabled} onChange={event => setJointSeverity(event.target.value as typeof jointSeverity)}><option value="auto">All ranges</option><option value="mild">Mild appearance</option><option value="moderate">Moderate appearance</option><option value="severe">Severe appearance</option></select><small>Visual design strength, not a clinical stage.</small></label>}
          </>}
          <button className="atlas-btn atlas-generate" onClick={() => jointVariation()} disabled={!jointAvailable || !draft || controlsDisabled}>{busy === "joint" ? <LoaderCircle size={15} className="atlas-spinning" /> : <Sparkles size={15} />}{jointGeneration === 2 ? "Joint flow variation" : "Joint VAE variation"}</button>
          {jointAvailable && <><button className="atlas-sample" onClick={() => jointVariation(true)} disabled={!draft || controlsDisabled}><Shuffle size={13} />New joint variation</button><p className="atlas-model-help">The same seed and temperature replay the same result. Higher temperature explores more of the trained variation.</p></>}
          {Boolean(generated?.summary.joint_model) && <p className="atlas-model-status" role="status"><Check size={11} />{generated?.spec.renderer_version === "disease-v2" ? "Joint flow variation applied" : "Joint VAE variation applied"}</p>}
        </section>
        {inspectorTab === "sculpt" ? <div id="atlas-sculpt-panel" role="tabpanel" aria-labelledby="atlas-tab-sculpt">
          <div className="atlas-recipe-heading"><span>Shape with your hands</span><Hand size={16} /></div>
          <p className="atlas-control-intro">Pick any surface point and drag. The surrounding tissue follows with a smooth, connected falloff. Release to keep the shape.</p>
          <div className="atlas-controls">
            <label className="atlas-control"><span>Influence radius<output>{sculptRadius} mm</output></span><input aria-label="Sculpt influence radius" type="range" min="8" max="100" step="1" value={sculptRadius} onChange={e => setSculptRadius(Number(e.target.value))} /></label>
            <label className="atlas-control"><span>Tissue resistance<output>{Math.round(sculptStiffness * 100)}%</output></span><input aria-label="Sculpt tissue resistance" type="range" min="0" max="1" step="0.05" value={sculptStiffness} onChange={e => setSculptStiffness(Number(e.target.value))} /></label>
          </div>
          <button className="atlas-sample" aria-pressed={sculptEnabled} onClick={() => setSculptEnabled(!sculptEnabled)}>{sculptEnabled ? "Switch to orbit" : "Enable surface sculpting"}</button>
          <button className="atlas-sample" disabled={!sculptHistory.present.length} onClick={() => { setSculptHistory(emptySculptHistory()); setSculptReport(""); }}><RotateCcw size={13} />Reset sculpture</button>
          <p className="atlas-sculpt-report" role="status">{sculptReport || "Drag a point on the organ to begin."}</p>
          <p className="atlas-control-intro">Undo and redo preserve complete strokes. Surface colors and vessels follow the tissue, and both exports include the sculpted shape.</p>
          <p className="atlas-surface-evidence">Geometry-inspired authoring with local stretch and fold guards. This tool does not simulate measured tissue mechanics or prevent every self-intersection.</p>
        </div> : inspectorTab === "disease" ? <div id="atlas-disease-panel" role="tabpanel" aria-labelledby="atlas-tab-disease"><AtlasDiseasePanel library={catalog?.diseases} organ={selectedOrgan?.id} recipe={draft?.disease} seedText={diseaseSeedText} onRecipe={editDisease} onSeedText={editDiseaseSeed} onApply={applyDraft} onSample={() => sampleVariation(true)} onLearned={learnedDiseaseVariation} learnedAvailable={diseaseSamplerAvailable} disabled={!generated || controlsDisabled} pending={diseasePending} updating={busy === "preview"} learnedApplied={Boolean(generated?.summary.disease_model)} displacementLimited={displacementLimited} displacementFraction={displacementFraction} expanded={jointGeneration === 2} /></div> : inspectorTab === "surface" ? <div id="atlas-surface-panel" role="tabpanel" aria-labelledby="atlas-tab-surface">{textureLab && <div className="atlas-lab-intro" role="note"><strong>Texture lab.</strong> Real tissue detail cut from licensed surgical photographs lies over the procedural material of the organs that have one: strength, relief and the photograph's colour below. The organ studio proper keeps its procedural surfaces; this is a viewer layer, exports do not carry it. <a href="?mode=atlas">Open the organ studio without it</a>.</div>}<section className="atlas-vessel-controls" aria-label="Surface vessels">
          <div className="atlas-recipe-heading"><span>Surface vessels</span><label><input type="checkbox" aria-label="Show surface vessels" disabled={!generated?.spec.material} checked={vesselsEnabled} onChange={e => setVesselsEnabled(e.target.checked)} /> Visible</label></div>
          <p className="atlas-control-intro">Fine, tapering branches embedded in the tissue finish.</p>
          <div className="atlas-controls">
            <label className="atlas-control"><span>Branch density<output>{Math.round(vesselDensity * 100)}%</output></span><input aria-label="Vessel branch density" type="range" min="0.15" max="1" step="0.05" value={vesselDensity} disabled={!vesselsEnabled || !generated?.spec.material} onChange={e => setVesselDensity(Number(e.target.value))} /></label>
            <label className="atlas-control"><span>Visibility<output>{Math.round(vesselVisibility * 100)}%</output></span><input aria-label="Vessel visibility" type="range" min="0" max="1" step="0.05" value={vesselVisibility} disabled={!vesselsEnabled || !generated?.spec.material} onChange={e => setVesselVisibility(Number(e.target.value))} /></label>
            <label className="atlas-control"><span>Calibre<output>{vesselRadiusScale.toFixed(2)}×</output></span><input aria-label="Vessel calibre" type="range" min="0.5" max="1.8" step="0.05" value={vesselRadiusScale} disabled={!vesselsEnabled || !generated?.spec.material} onChange={e => setVesselRadiusScale(Number(e.target.value))} /></label>
          </div>
          <button className="atlas-sample" disabled={!vesselsEnabled || !generated?.spec.material} onClick={() => setVesselSeed(seed => (seed + 1) >>> 0)}><Shuffle size={13} />New branching pattern</button>
        </section>{textureLab && displayedOrgan && <PhotoDetailControl organ={displayedOrgan.id} value={photoDetail} relief={photoRelief} tile={photoTile} onTile={setPhotoTile} onChange={setPhotoDetail} onRelief={setPhotoRelief} disabled={(generated?.spec.appearance ?? "tissue") !== "tissue"} onApplyColor={surfaceDraft ? (reference) => applySurface(false, { ...surfaceDraft, reference_color: { ...reference, strength: 0.7, mode: "chroma" } }) : undefined} />}{displayedOrgan && surfaceDraft && <ReferenceMaterialPanel key={displayedOrgan.id} organ={displayedOrgan.id} organLabel={displayedOrgan.label} reference={generated?.spec.material?.reference_color} disabled={!generated || controlsDisabled} onApply={reference => applySurface(false, { ...surfaceDraft, reference_color: reference })} />}<AtlasSurfacePanel library={catalog?.materials} organ={displayedOrgan?.id} recipe={surfaceDraft} seedText={surfaceSeedText} onRecipe={editSurface} onSeedText={editSurfaceSeed} onApply={() => applySurface()} onSample={() => applySurface(true)} disabled={!generated || controlsDisabled} pending={surfacePending} updating={busy === "preview"} /></div> : <div id="atlas-shape-panel" role="tabpanel" aria-labelledby="atlas-tab-shape">
        <div className="atlas-recipe-heading"><span>Reference variation</span><button onClick={() => { if (catalog && draft) editControls(defaultAtlasSpec(catalog, draft.template_id).controls); }} disabled={!draft || controlsDisabled} title="Reset shape controls to the reference"><RotateCcw size={13} /> Reset</button></div>
        <p className="atlas-control-intro">Sliders update the organ automatically. Camera framing stays fixed so size changes remain visible.</p>
        {appliedShapeFraction !== undefined && <p className="atlas-disease-source-limit" role="status">This source mesh permits {(appliedShapeFraction * 100).toFixed(1)}% of the requested shape edit. Sliders show the applied values.</p>}
        <div className="atlas-controls">{catalog?.controls.map((control) => <label className="atlas-control" key={control.key} title={control.description ?? description(control.key)}>
          <span><span>{control.label}</span><output>{(draft?.controls[control.key] ?? control.default) > 0 ? "+" : ""}{(draft?.controls[control.key] ?? control.default).toFixed(2)}</output></span>
          <input type="range" aria-label={control.label} min={control.min} max={control.max} step={0.02} value={draft?.controls[control.key] ?? control.default} disabled={!draft || controlsDisabled} onChange={(event) => { if (draftRef.current) editControls({ ...draftRef.current.controls, [control.key]: Number(event.target.value) }); }} />
        </label>)}</div>
        <div className={`atlas-recipe-state ${dirty ? "pending" : ""}`} aria-live="polite">{busy === "preview" ? <><LoaderCircle size={12} className="atlas-spinning" />Updating shape preview…</> : dirty ? <><span />Changes not applied — retry parameters</> : generated ? <><Check size={12} /> Preview matches this recipe</> : <span>Waiting for reference geometry</span>}</div>
        {dirty && !busy && <button className="atlas-sample" disabled={modelSwitching} onClick={applyDraft}>Apply parameters<ArrowRight size={13} /></button>}
        <label className="atlas-variation-range" htmlFor="atlas-variation-range"><span>Variation range</span><select id="atlas-variation-range" value={variationStrength} disabled={!draft || controlsDisabled} onChange={(event) => setVariationStrength(Number(event.target.value))}><option value={0.4}>Subtle · 40%</option><option value={0.7}>Balanced · 70%</option><option value={1}>Broad · 100%</option></select></label>
        <button className="atlas-btn atlas-generate" onClick={() => sampleVariation(true)} disabled={!draft || controlsDisabled}>{busy === "generate" ? <LoaderCircle size={16} className="atlas-spinning" /> : <Sparkles size={15} />} {busy === "generate" ? "Preparing geometry…" : "Generate variation"}<ArrowRight size={15} /></button>
        <p className="atlas-model-help">Each click samples a new seed within the selected control range.</p>
        <div className="atlas-seed-label"><label htmlFor="atlas-seed">Variation seed</label><span>Reproducible</span></div>
        <div className="atlas-seed"><input id="atlas-seed" type="text" inputMode="numeric" autoComplete="off" value={seedText} disabled={!draft || controlsDisabled} onChange={(event) => setSeedText(event.target.value)} /><button aria-label="Randomize variation seed" title="Choose a seed for Sample shape from seed" disabled={!draft || controlsDisabled} onClick={() => setSeedText(String(crypto.getRandomValues(new Uint32Array(1))[0]!))}><Shuffle size={15} /></button></div>
        <button className="atlas-sample" onClick={() => sampleVariation()} disabled={!draft || controlsDisabled}><Shuffle size={13} />Sample shape from seed</button>
        <p className="atlas-model-help">The same seed and range reproduce the same shape. Editing the seed alone does not deform it.</p>
        <div className="atlas-model-controls">
          <button className="atlas-sample atlas-learned" onClick={learnedVariation} disabled={!draft || controlsDisabled || Boolean(draft.disease) || !learnedAvailable} title={draft?.disease ? jointGeneration === 2 ? "Use Joint flow variation above" : "Use Learned disease variation in the Disease tab" : learnedAvailable ? undefined : "The trained shape model is unavailable"}>{busy === "learned" ? <LoaderCircle size={13} className="atlas-spinning" /> : <Sparkles size={13} />}Learned variation</button>
          <label className="atlas-model-dimensions"><input type="checkbox" checked={matchDimensions} disabled={!draft || modelSwitching || Boolean(busy) || Boolean(draft.disease) || !learnedAvailable} onChange={(event) => setMatchDimensions(event.target.checked)} />Keep overall dimensions</label>
          <p className="atlas-model-help">{draft?.disease ? jointGeneration === 2 ? "Use Joint flow variation above to vary shape, colour and the selected disease together." : "Shape-only sampling is unavailable with disease active. Use the Disease tab." : learnedAvailable ? "Trained shape model · synthetic design distribution" : "The trained shape model is unavailable. Open Trained models to check its status."}</p>
          {Boolean(generated?.summary.model) && <p className="atlas-model-status" role="status"><Check size={11} />Model variation applied</p>}
        </div>
        <section className="atlas-specimen-info"><h2>Displayed specimen</h2><dl><dt>Triangles</dt><dd>{generated ? count(stats.triangles) : "—"}</dd><dt>Vertices</dt><dd>{generated ? count(stats.vertices) : "—"}</dd><dt>Seed</dt><dd>{generated?.spec.seed ?? "—"}</dd><dt>Appearance</dt><dd>{modes.find((mode) => mode.id === generated?.spec.appearance)?.label ?? "—"}</dd></dl>
          <button className="atlas-details-link" onClick={() => setDetails(!details)}>Source & validation details <ExternalLink size={12} /></button>
        </section>
        </div>}
      </div>
      <div className="atlas-inspector-note">{inspectorTab === "disease" ? "Synthetic design controls, not clinical diagnosis, staging or a patient-specific surgical plan." : inspectorTab === "surface" ? "Authored tissue appearance. Independent optical and tissue-architecture validation remain pending." : "Each generated shape is an unreviewed variation of its cited reference."}</div>
    </aside>
    <footer className="atlas-footer"><span><span className={generated ? "ready" : ""} />{generated ? "Reference geometry loaded" : busy ? "Loading anatomy" : "Preview unavailable"}</span><span>{catalog ? `${catalog.organs.length} organ families · ${catalog.organs.reduce((n, organ) => n + organ.templates.length, 0)} references` : "Open anatomy library"}</span><span>Surface preview · Y-up · mm</span></footer>
  </div>;
}
