import { apiOnline, apiUrl, bundledJson, publicUrl } from "./api";
import { NEEDS_API } from "./atlasLocal";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Check, CircleCheck, Download, ImagePlus, LoaderCircle, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { atlasError } from "./atlas";
import type { ReferenceColor } from "./atlasMaterial";
import { validateReferenceAnalysis, type ReferenceAnalysis } from "./ReferenceMaterialPanel";
import { REFERENCE_ORGAN_IDS } from "./referenceColor";
import { DEFAULT_LIBRARY_COLOR_OPTIONS, planWholeBodyColor, type WholeBodyColorPlan, type WholeBodyObservation, type WholeBodySurface } from "./wholeBodyColor";
import type { WholeSceneOrgan } from "./WholeSceneViewport";
import "./wholeBodyReference.css";

type Point = [number, number];
type Box = [number, number, number, number];
interface Selection { box: Box | null; foreground_points: Point[]; background_points: Point[] }
interface Region {
  id: string; label: string; organ: string; targets: string[]; selection: Selection;
  identitySource: string;
  surface: WholeBodySurface; mask: string | null; maskSrc: string | null;
  analysis: ReferenceAnalysis | null; reviewed: boolean; error: string;
}
interface Source {
  id: string; label: string; src: string; credit: string; license: string; sourceUrl: string;
  captureGroup: string;
  image: string; regions: Region[];
}
interface Props {
  organs: WholeSceneOrgan[];
  appliedPlan: WholeBodyColorPlan | null;
  referenceColors: Record<string, ReferenceColor>;
  disabled: boolean;
  canRestore: boolean;
  showingPrevious: boolean;
  onCompare: (previous: boolean) => void;
  onApply: (plan: WholeBodyColorPlan) => void;
  onRestore: () => void;
}
interface DefaultProgress {
  phase: "running" | "applying" | "complete" | "cancelled" | "failed";
  completed: number; total: number; label: string;
  plan?: WholeBodyColorPlan;
}
const MAX_SOURCES = 8, MAX_REGIONS = 12;
const generalWarnings = new Set([
  "No colour profile: sRGB is assumed; camera white balance remains in the colour.",
  "Organ identity is assigned by you. Check the mask for other organs, blood, fat and instruments.",
  "This transfers observed colour, not calibrated albedo, tissue optics or physical properties.",
  "Inferred from related outer tissue; this target was not observed.",
  "Bounded palette harmonization; this target was not observed or colour calibrated.",
]);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const cssColor = (color: number[]) => `rgb(${color.map(channel => Math.round(channel * 255)).join(" ")})`;
function assetUrl(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || new URL(value, window.location.origin).origin !== window.location.origin)
    throw new Error("A reference library image has an invalid local address.");
  return publicUrl(value);
}
function creditUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? value : ""; } catch { return ""; }
}
function points(value: unknown): Point[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || !value.every(point => Array.isArray(point) && point.length === 2 && point.every(channel => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1)))
    throw new Error("A reference region has invalid selection points.");
  return value as Point[];
}
function validBox(box: Box | null): box is Box { return Boolean(box && box[0] < box[2] && box[1] < box[3]); }
function readCatalog(value: unknown): Source[] {
  if (!object(value) || !Array.isArray(value.sources) || value.sources.length > MAX_SOURCES) throw new Error("The reference library is incomplete or too large.");
  const ids = new Set<string>();
  return value.sources.map(item => {
    if (!object(item) || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id) || typeof item.label !== "string" || !Array.isArray(item.regions) || item.regions.length > MAX_REGIONS)
      throw new Error("The reference library contains an invalid source.");
    ids.add(item.id); const regionIds = new Set<string>();
    if (item.capture_group !== undefined && (typeof item.capture_group !== "string" || item.capture_group.length > 256)) throw new Error("A reference source has an invalid capture group.");
    const source: Source = { id: item.id, label: item.label, src: assetUrl(item.src), image: "", credit: typeof item.credit === "string" ? item.credit : "", license: typeof item.license === "string" ? item.license : "", sourceUrl: creditUrl(item.source_url), captureGroup: typeof item.capture_group === "string" ? item.capture_group : "", regions: [] };
    source.regions = item.regions.map(region => {
      if (!object(region) || typeof region.id !== "string" || !region.id || regionIds.has(region.id) || typeof region.organ !== "string" || !Object.values(REFERENCE_ORGAN_IDS).includes(region.organ) || !object(region.selection) ||
          !Array.isArray(region.targets) || !region.targets.length || !region.targets.every(target => typeof target === "string" && REFERENCE_ORGAN_IDS[target] === region.organ) || new Set(region.targets).size !== region.targets.length)
        throw new Error("A library region has an unsupported tissue identity or target.");
      regionIds.add(region.id);
      const box = region.selection.box;
      if (!Array.isArray(box) || box.length !== 4 || !box.every(channel => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1) || !validBox(box as Box)) throw new Error("A library region has invalid bounds.");
      const surface = region.surface ?? "unknown";
      if (!["outer", "mucosa", "cut", "unknown"].includes(String(surface))) throw new Error("A library region has an unsupported tissue surface.");
      if (region.identity_source !== undefined && (typeof region.identity_source !== "string" || region.identity_source.length > 1024)) throw new Error("A reference region has an invalid identity source.");
      return { id: `${source.id}:${region.id}`, label: typeof region.label === "string" ? region.label : region.organ, organ: region.organ, targets: region.targets as string[], identitySource: typeof region.identity_source === "string" ? region.identity_source : "", selection: { box: box as Box, foreground_points: points(region.selection.foreground_points), background_points: points(region.selection.background_points) }, surface: surface as WholeBodySurface, maskSrc: region.mask_src ? assetUrl(region.mask_src) : null, mask: null, analysis: null, reviewed: false, error: "" };
    });
    return source;
  });
}
function readData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error("The reference file could not be read."));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The reference file could not be read."));
    reader.readAsDataURL(file);
  });
}
async function decodeImage(file: Blob) {
  if (file.size > 12 * 1024 * 1024) throw new Error("Reference images must be smaller than 12 MB each.");
  const value = await readData(file), image = new Image(); image.src = value; await image.decode();
  if (Math.min(image.naturalWidth, image.naturalHeight) < 16 || image.naturalWidth * image.naturalHeight > 24_000_000) throw new Error("Reference images must have sides of at least 16 pixels and no more than 24 million pixels.");
  return value;
}
function downloadPlan(plan: WholeBodyColorPlan) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "viscera-whole-body-colour-plan.json"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function observationsFrom(sources: Source[]): WholeBodyObservation[] {
  return sources.flatMap(source => source.regions.flatMap(region => region.analysis ? [{ id: region.id, source_id: source.id, organ: region.organ, targets: region.targets, analysis: region.analysis, reviewed: region.reviewed, surface: region.surface, ...(source.captureGroup ? { capture_group: source.captureGroup } : {}), ...(source.sourceUrl ? { source_url: source.sourceUrl } : {}), ...(region.identitySource ? { identity_source: region.identitySource } : {}) }] : []));
}
const analyzable = (region: Region) => validBox(region.selection.box) && region.targets.length > 0;
async function analyzeSource(source: Source, segmentation: "local" | "sam2", signal: AbortSignal): Promise<Source> {
  const regions = source.regions.filter(analyzable);
  const requestRegions = new Map(regions.map((region, index) => [`region-${index}`, region]));
  let value: unknown;
  if (!(await apiOnline())) {
    // the public copy: the API's analysis of this bundled photograph, made at build time with these same regions
    value = await bundledJson(`atlas/reference-material/regions/${source.id}.json`, signal).catch(() => { throw new Error(NEEDS_API.referenceColor); });
  } else {
    const response = await fetch(apiUrl("/api/atlas/reference-material/analyze-regions"), { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ image_base64: source.image.split(",")[1], segmentation, regions: [...requestRegions].map(([id, region]) => ({ id, organ: region.organ, selection: region.selection, ...(region.mask ? { mask_base64: region.mask } : {}) })) }) });
    if (response.status === 404) throw new Error("The running anatomy server is out of date: colour analysis is unavailable. Restart the anatomy server, then apply again.");
    if (!response.ok) throw await atlasError(response);
    value = await response.json();
  }
  if (!object(value) || value.version !== "reference-regions-1" || typeof value.source_sha256 !== "string" || !Array.isArray(value.results) || value.results.length !== regions.length) throw new Error("The batch analysis returned an incomplete result.");
  const entries = new Map<string, { analysis: ReferenceAnalysis | null; error: string }>();
  for (const entry of value.results) {
    if (!object(entry) || typeof entry.id !== "string") throw new Error("The batch analysis returned invalid region identities.");
    const original = requestRegions.get(entry.id); if (!original) throw new Error("The batch analysis returned an unexpected region.");
    if (entries.has(original.id)) throw new Error("The batch analysis returned duplicate region identities.");
    if (typeof entry.error === "string" && !entry.analysis) entries.set(original.id, { analysis: null, error: entry.error });
    else { validateReferenceAnalysis(entry.analysis, original.organ); if (entry.analysis.source_sha256 !== value.source_sha256) throw new Error("The analysis no longer matches this source image."); entries.set(original.id, { analysis: entry.analysis, error: "" }); }
  }
  signal.throwIfAborted();
  return { ...source, regions: source.regions.map(region => entries.has(region.id) ? { ...region, ...entries.get(region.id)!, reviewed: false } : region) };
}

export function WholeBodyReferencePanel({ organs, appliedPlan, referenceColors, disabled, canRestore, showingPrevious, onCompare, onApply, onRestore }: Props) {
  const [defaultStrength, setDefaultStrength] = useState(DEFAULT_LIBRARY_COLOR_OPTIONS.strength);
  const [defaultMode, setDefaultMode] = useState(DEFAULT_LIBRARY_COLOR_OPTIONS.mode);
  const [library, setLibrary] = useState<Source[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [tool, setTool] = useState<"box" | "include" | "exclude">("box");
  const [segmentation, setSegmentation] = useState<"local" | "sam2">("local");
  const [strength, setStrength] = useState(0.65);
  const [mode, setMode] = useState<"chroma" | "color">("chroma");
  const [related, setRelated] = useState(false), [harmonize, setHarmonize] = useState(false);
  const [activity, setActivity] = useState("");
  const [error, setError] = useState("");
  const [defaultProgress, setDefaultProgress] = useState<DefaultProgress | null>(null);
  const automaticRunning = defaultProgress?.phase === "running" || defaultProgress?.phase === "applying";
  const defaultApplied = defaultProgress?.phase === "complete" && defaultProgress.plan === appliedPlan;
  const controlsDisabled = disabled || automaticRunning;
  const existingReferences = Object.keys(referenceColors).length;
  const automaticPalette = useRef(referenceColors);
  const revision = useRef(0), operation = useRef<AbortController | null>(null), backendChosen = useRef(false), drag = useRef<Point | null>(null);
  const editor = useRef<HTMLElement>(null);
  const revealEditor = () => requestAnimationFrame(() => editor.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }));
  const sourcesRef = useRef(sources); sourcesRef.current = sources;
  const invalidate = () => { ++revision.current; operation.current?.abort(); operation.current = null; setActivity(""); setError(""); setDefaultProgress(current => current?.phase === "complete" ? current : null); };
  const cancelDefault = (label = "Cancelled. Your previous materials are unchanged.") => {
    invalidate(); setDefaultProgress(current => current?.phase === "complete" ? current : { phase: "cancelled", completed: defaultProgress?.completed ?? 0, total: defaultProgress?.total ?? 1, label });
  };
  useEffect(() => {
    if (defaultProgress?.phase === "applying" && defaultProgress.plan === appliedPlan) {
      setDefaultProgress(current => current && { ...current, phase: "complete", completed: current.total, label: `All ${Object.keys(appliedPlan!.referenceColors).length} organ materials applied` });
    } else if (defaultProgress?.phase === "complete" && defaultProgress.plan !== appliedPlan) setDefaultProgress(null);
    else if (defaultProgress?.phase === "running" && (disabled || automaticPalette.current !== referenceColors)) cancelDefault("Cancelled because the scene changed. Your current materials are unchanged.");
  }, [appliedPlan, referenceColors, disabled, defaultProgress?.phase]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(publicUrl("body-reference/catalog.json"), { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error("Bundled references are unavailable. You can upload images below."); const value: unknown = await response.json(); const catalog = readCatalog(value); if (!controller.signal.aborted) setLibrary(catalog); }).catch(cause => { if (!controller.signal.aborted) setLibraryError(cause instanceof Error ? cause.message : "Reference library unavailable."); });
    void fetch(apiUrl("/api/atlas/reference-material/status"), { signal: controller.signal }).then(async response => { if (!response.ok) return; const value: unknown = await response.json(); if (!controller.signal.aborted && !backendChosen.current && object(value) && value.default_segmentation === "sam2" && object(value.sam2) && value.sam2.configured === true) setSegmentation("sam2"); }).catch(() => {});
    return () => { controller.abort(); ++revision.current; operation.current?.abort(); };
  }, []);
  const selected = sources.flatMap(source => source.regions.map(region => ({ source, region }))).find(item => item.region.id === active);
  const rows = sources.flatMap(source => source.regions.map(region => ({ source, region })));
  const observations = useMemo(() => observationsFrom(sources), [sources]);
  const proposed = useMemo(() => {
    try { return { plan: planWholeBodyColor(organs, observations, { strength, mode, related, harmonize }), error: "" }; }
    catch (cause) { return { plan: null, error: cause instanceof Error ? cause.message : "The colour assignments are invalid." }; }
  }, [organs, observations, strength, mode, related, harmonize]);
  const reviewed = observations.filter(row => row.reviewed).length;
  const sharedWarnings = [...new Set(Object.values(proposed.plan?.assignments ?? {}).flatMap(assignment => assignment.warnings.filter(warning => generalWarnings.has(warning))))];
  const canonicalOrgans = [...new Set(organs.filter(organ => organ.category !== "skeleton").map(organ => REFERENCE_ORGAN_IDS[organ.id]).filter((organ): organ is string => Boolean(organ)))];
  const organLabel = (id: string) => organs.find(organ => organ.id === id)?.label ?? id.replaceAll("-", " ");
  const coverageList = (plan: WholeBodyColorPlan) => <div className="wb-coverage-list">{Object.values(plan.assignments).map(assignment => <div className="wb-coverage-row" data-basis={assignment.basis} data-target-id={assignment.target_id} key={assignment.target_id}>
    <i style={{ background: cssColor(assignment.color_srgb) }} />
    <span>{organLabel(assignment.target_id)}<small>{assignment.basis === "direct" ? "Reviewed photo" : assignment.basis === "related" ? "Related tissue · inferred" : assignment.basis === "harmonized" ? "Harmonized · inferred" : "Authored · no photo evidence"}{assignment.evidence.length ? ` · ${[...new Set(assignment.evidence.map(evidence => library.find(source => source.id === evidence.source_id)?.label ?? sources.find(source => source.id === evidence.source_id)?.label ?? evidence.source_id))].join(", ")}` : ""}</small>
      {assignment.warnings.filter(warning => !generalWarnings.has(warning)).map((warning, index) => <small className="wb-assignment-warning" key={index}>{warning}</small>)}
    </span>
  </div>)}</div>;
  const updateRegion = (id: string, change: Partial<Region>, clearAnalysis = true) => {
    if (clearAnalysis) invalidate();
    setSources(current => current.map(source => ({ ...source, regions: source.regions.map(region => region.id === id ? { ...region, ...change, ...(clearAnalysis ? { analysis: null, reviewed: false, error: "" } : {}) } : region) })));
  };
  const fetchAsset = async (url: string, signal: AbortSignal) => {
    const response = await fetch(url, { signal }); if (!response.ok) throw new Error("A bundled reference image or mask could not be loaded."); return response.blob();
  };
  const applyDefaultLibrary = async () => {
    if (disabled || automaticRunning || activity || !library.length) return;
    invalidate();
    const id = revision.current, controller = new AbortController(); operation.current = controller;
    automaticPalette.current = referenceColors;
    const total = library.length * 2 + 1;
    let completed = 0;
    const current = () => id === revision.current && !controller.signal.aborted;
    const progress = (label: string) => { if (current()) setDefaultProgress({ phase: "running", completed, total, label }); };
    progress("Loading the default library…");
    try {
      // Fail before loading all images if Studio is connected to an older API.
      const service = await fetch(apiUrl("/api/atlas/reference-material/status"), { signal: controller.signal });
      if (service.status === 404) throw new Error("The running anatomy server is out of date: colour analysis is unavailable. Restart the anatomy server, then apply again.");
      if (!service.ok) throw await atlasError(service);
      if (!current()) return;
      const loaded: Source[] = [];
      // Always use fresh catalogue assignments and masks, never edited drafts.
      for (const [index, source] of library.entries()) {
        if (!current()) return;
        progress(`Loading reference image ${index + 1} of ${library.length}…`);
        const image = await decodeImage(await fetchAsset(source.src, controller.signal));
        if (!current()) return;
        if (!source.regions.length) throw new Error("A default reference has no tissue regions.");
        const regions: Region[] = [];
        for (const region of source.regions) {
          if (!region.maskSrc || !region.identitySource || !analyzable(region)) throw new Error("A default reference is missing its reviewed mask or organ assignment.");
          const blob = await fetchAsset(region.maskSrc, controller.signal);
          if (blob.size > 1024 * 1024) throw new Error("A reviewed mask is too large.");
          const mask = (await readData(blob)).split(",")[1]!;
          if (!current()) return;
          regions.push({ ...region, targets: [...region.targets], selection: structuredClone(region.selection), mask, analysis: null, reviewed: false, error: "" });
        }
        loaded.push({ ...source, image, regions }); ++completed;
      }
      const analysed: Source[] = [];
      for (const [index, source] of loaded.entries()) {
        if (!current()) return;
        progress(`Preparing materials from image ${index + 1} of ${loaded.length}…`);
        const result = await analyzeSource(source, "local", controller.signal);
        if (!current()) return;
        const failed = result.regions.find(region => !region.analysis || region.error);
        if (failed) throw new Error(`${source.label}: ${failed.error || "A tissue region could not be analysed."}`);
        // The user's one-click action accepts the bundled expert annotations.
        // These local rows never mark a custom draft as manually reviewed.
        analysed.push({ ...result, regions: result.regions.map(region => ({ ...region, reviewed: true })) }); ++completed;
      }
      const plan = planWholeBodyColor(organs, observationsFrom(analysed), { ...DEFAULT_LIBRARY_COLOR_OPTIONS, strength: defaultStrength, mode: defaultMode });
      const targets = organs.filter(organ => organ.category !== "skeleton");
      if (!targets.length || targets.some(organ => !plan.referenceColors[organ.id])) throw new Error("The default library could not prepare every organ material.");
      plan.warnings.push("Applied automatically from the default library's reviewed masks and organ assignments. Custom reference drafts were not included.");
      if (!current()) return;
      setDefaultProgress({ phase: "applying", completed, total, label: `Applying ${targets.length} organ materials…`, plan });
      operation.current = null;
      onApply(plan);
    } catch (cause) {
      if (!current()) return;
      operation.current = null;
      setDefaultProgress({ phase: "failed", completed, total, label: `${cause instanceof Error ? cause.message : "The default materials could not be prepared."} Your previous materials are unchanged.` });
    }
  };
  const loadLibrary = async () => {
    const missing = library.filter(source => !sourcesRef.current.some(existing => existing.id === source.id));
    if (sourcesRef.current.length + missing.length > MAX_SOURCES) { setError(`Use up to ${MAX_SOURCES} images at a time. Remove an image before loading more.`); return; }
    invalidate(); const id = revision.current, controller = new AbortController(); operation.current = controller;
    try {
      const added: Source[] = [];
      for (const [index, source] of missing.entries()) {
        if (id !== revision.current || controller.signal.aborted) return;
        setActivity(`Loading reference image ${index + 1} of ${missing.length}…`);
        const image = await decodeImage(await fetchAsset(source.src, controller.signal));
        if (id !== revision.current || controller.signal.aborted) return;
        const regions: Region[] = [];
        for (const region of source.regions) {
          let mask: string | null = null;
          if (region.maskSrc) { const blob = await fetchAsset(region.maskSrc, controller.signal); if (blob.size > 1024 * 1024) throw new Error("A reviewed mask is too large."); mask = (await readData(blob)).split(",")[1]!; }
          if (id !== revision.current || controller.signal.aborted) return;
          regions.push({ ...region, targets: [...region.targets], selection: structuredClone(region.selection), mask });
        }
        added.push({ ...source, image, regions });
      }
      if (id !== revision.current || controller.signal.aborted) return;
      setSources(current => [...current, ...added]); setActive(current => current ?? added[0]?.regions[0]?.id ?? null); setActivity("");
    } catch (cause) { if (id === revision.current && !controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "The reference library could not be loaded."); setActivity(""); } }
  };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    if (sources.length + files.length > MAX_SOURCES) { setError(`Use up to ${MAX_SOURCES} images at a time.`); return; }
    invalidate(); const id = revision.current; setActivity("Opening reference images…");
    try {
      const added: Source[] = [];
      for (const file of files) {
        if (id !== revision.current) return;
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose PNG, JPEG or WebP reference images.");
        const image = await decodeImage(file);
        if (id !== revision.current) return;
        added.push({ id: `upload-${crypto.randomUUID()}`, label: file.name, src: "", credit: "Your uploaded reference", license: "", sourceUrl: "", captureGroup: "", image, regions: [] });
      }
      if (id !== revision.current) return;
      setSources(current => [...current, ...added]); setActivity("");
    } catch (cause) { if (id === revision.current) { setError(cause instanceof Error ? cause.message : "The image could not be opened."); setActivity(""); } }
  };
  const addRegion = (source: Source) => {
    invalidate(); const id = `region-${crypto.randomUUID()}`, organ = canonicalOrgans.includes("liver") ? "liver" : canonicalOrgans[0] ?? "liver";
    const region: Region = { id, label: `Region ${source.regions.length + 1}`, organ, targets: [], identitySource: "User-assigned tissue identity", selection: { box: null, foreground_points: [], background_points: [] }, surface: "unknown", mask: null, maskSrc: null, analysis: null, reviewed: false, error: "" };
    setSources(current => current.map(item => item.id === source.id ? { ...item, regions: [...item.regions, region] } : item)); setActive(id); setTool("box"); revealEditor();
  };
  const point = (event: PointerEvent<HTMLDivElement>): Point => { const bounds = event.currentTarget.getBoundingClientRect(); return [clamp((event.clientX - bounds.left) / bounds.width), clamp((event.clientY - bounds.top) / bounds.height)]; };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (controlsDisabled || !selected || event.button !== 0 || selected.region.mask) return;
    const next = point(event), region = selected.region; event.preventDefault();
    if (tool === "include" && (!validBox(region.selection.box) || next[0] <= region.selection.box[0] || next[0] >= region.selection.box[2] || next[1] <= region.selection.box[1] || next[1] >= region.selection.box[3])) { setError("Place tissue points inside the selected region."); return; }
    if (tool === "box") { drag.current = next; event.currentTarget.setPointerCapture(event.pointerId); updateRegion(region.id, { selection: { box: [next[0], next[1], next[0], next[1]], foreground_points: [], background_points: [] } }); }
    else { const key = tool === "include" ? "foreground_points" : "background_points"; updateRegion(region.id, { selection: { ...region.selection, [key]: [...region.selection[key], next].slice(-32) } }); }
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !selected) return;
    const start = drag.current, end = point(event);
    updateRegion(selected.region.id, { selection: { box: [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])], foreground_points: [], background_points: [] } });
  };
  const analyzeAll = async () => {
    const pending = sources.filter(source => source.regions.some(analyzable));
    if (!pending.length || disabled) return;
    backendChosen.current = true; invalidate(); const id = revision.current, controller = new AbortController(); operation.current = controller;
    setSources(current => current.map(source => ({ ...source, regions: source.regions.map(region => analyzable(region) ? { ...region, analysis: null, reviewed: false, error: "" } : region) })));
    try {
      for (const [index, source] of pending.entries()) {
        setActivity(`Analysing image ${index + 1} of ${pending.length}…`);
        const regions = source.regions.filter(analyzable);
        try {
          const result = await analyzeSource(source, segmentation, controller.signal);
          if (id !== revision.current || controller.signal.aborted) return;
          setSources(current => current.map(item => item.id === source.id ? { ...item, regions: item.regions.map(region => {
            const analysed = result.regions.find(entry => entry.id === region.id);
            return analysed && regions.some(entry => entry.id === region.id) ? { ...region, analysis: analysed.analysis, error: analysed.error, reviewed: false } : region;
          }) } : item));
        } catch (cause) {
          if (id !== revision.current || controller.signal.aborted) return;
          const message = cause instanceof Error ? cause.message : "This source could not be analysed.";
          setSources(current => current.map(item => item.id === source.id ? { ...item, regions: item.regions.map(region => regions.some(original => original.id === region.id) ? { ...region, error: message, analysis: null, reviewed: false } : region) } : item));
        }
      }
    } finally { if (id === revision.current) setActivity(""); }
  };

  return <section className="whole-body-reference" aria-label="Whole-body colour transfer">
    <div className="whole-section-label">PHOTO REFERENCES <span>WHOLE-BODY COLOUR</span></div>
    <div className="wb-automatic" aria-busy={automaticRunning}>
      <h2>One-click body materials</h2>
      <p className="whole-copy">Transfer the library's photo colours to the scene. Reviewed masks and organ assignments are ready.</p>
      <label className="wb-field">Photo transfer<select aria-label="Default library transfer mode" value={defaultMode} disabled={controlsDisabled || Boolean(activity)} onChange={event => setDefaultMode(event.target.value as "chroma" | "color")}><option value="color">Photo colour + brightness</option><option value="chroma">Subtle tint · keep brightness</option></select></label>
      <label className="whole-range"><span>Photo strength<output>{Math.round(defaultStrength * 100)}%</output></span><input aria-label="Default library transfer strength" type="range" min="0" max="1" step="0.01" value={defaultStrength} disabled={controlsDisabled || Boolean(activity)} onChange={event => setDefaultStrength(Number(event.target.value))} /></label>
      <button className="whole-joint wb-auto-apply" type="button" disabled={disabled || automaticRunning || Boolean(activity) || !library.length} onClick={() => void applyDefaultLibrary()}><Sparkles size={15} aria-hidden="true" /><span>Apply default library materials</span></button>
      <p className="wb-help">Photo-based organs use this transfer. Unseen organs receive a subtle inferred tint; their brightness is preserved. Apply again after changing these settings.</p>
      {defaultProgress && (defaultProgress.phase !== "complete" || defaultApplied) && <div className={`wb-auto-progress ${defaultProgress.phase}`}>
        <div className="wb-auto-progress-heading">
          {defaultApplied ? <p role="status" data-testid="default-library-complete"><CircleCheck size={19} aria-hidden="true" />{defaultProgress.label}</p> : <p role={defaultProgress.phase === "failed" ? "alert" : "status"}>{automaticRunning && <LoaderCircle size={14} aria-hidden="true" />}{defaultProgress.label}</p>}
          <span>{Math.round(defaultProgress.completed / defaultProgress.total * 100)}%</span>
        </div>
        <progress aria-label="Default library material progress" max={defaultProgress.total} value={defaultProgress.completed} />
        {defaultApplied && <p className="wb-help">{Object.values(appliedPlan!.assignments).filter(assignment => assignment.basis === "direct").length} photo-based · {Object.values(appliedPlan!.assignments).filter(assignment => assignment.basis === "related" || assignment.basis === "harmonized").length} inferred · {Math.round(appliedPlan!.settings.strength * 100)}% {appliedPlan!.settings.mode === "color" ? "colour + brightness" : "tint only"}</p>}
        {defaultApplied && <details className="wb-coverage" data-testid="default-library-coverage"><summary>Applied materials · {Object.keys(appliedPlan!.assignments).length} organs</summary>{coverageList(appliedPlan!)}</details>}
        {defaultProgress.phase === "running" && <button className="wb-text-button" type="button" onClick={() => cancelDefault()}>Cancel</button>}
      </div>}
    </div>
    {canRestore && appliedPlan && <div className="wb-compare">
      <div className="wb-compare-buttons" role="group" aria-label="Compare whole-body colours">
        <button type="button" disabled={disabled || automaticRunning} aria-pressed={showingPrevious} onClick={() => onCompare(true)}>Before</button>
        <button type="button" disabled={disabled || automaticRunning} aria-pressed={!showingPrevious} onClick={() => onCompare(false)}>Applied colours</button>
      </div>
      <p className="wb-help" role="status">{showingPrevious ? "Showing the previous colours. Your applied palette is kept." : "Showing the applied colours. Compare with Before at the same view."}</p>
      <button className="whole-button wb-restore" type="button" disabled={disabled || automaticRunning} onClick={onRestore}><RotateCcw size={13} />Undo colour application</button>
    </div>}
    <div className="whole-section-label wb-custom-label">CUSTOM REFERENCES <span>OPTIONAL</span></div>
    <h2>Build a shared tissue palette</h2>
    <p className="whole-copy">Use one or several real images. Review each tissue region, then apply the reviewed colours together. Organs without evidence keep their authored appearance.</p>
    <button className="whole-button wb-load" type="button" disabled={controlsDisabled || !library.length || library.every(source => sources.some(item => item.id === source.id))} onClick={() => void loadLibrary()}><ImagePlus size={14} />Load reference library</button>
    {library.length > 0 && <p className="wb-help">{library.length} bundled images · {library.reduce((count, source) => count + source.regions.length, 0)} labelled regions. Load them here to customize and review your own palette.</p>}
    {libraryError && <p className="wb-help">{libraryError}</p>}
    <label className="wb-upload">Add your reference images<input aria-label="Whole-body reference images" type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={controlsDisabled} onChange={event => { void upload(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label>
    <p className="wb-help">Up to {MAX_SOURCES} images. A single image can contain several separately assigned regions.</p>
    {activity && <p className="wb-activity" role="status"><LoaderCircle size={14} />{activity}<button type="button" onClick={invalidate}>Cancel</button></p>}
    {error && <p className="wb-error" role="alert">{error}</p>}
    <div className="wb-sources">{sources.map(source => <section className="wb-source" key={source.id} aria-label={`Reference source ${source.label}`}>
      <div className="wb-source-heading"><img src={source.image} alt={source.label} /><strong>{source.label}</strong><button type="button" aria-label={`Remove source ${source.label}`} disabled={controlsDisabled} onClick={() => { invalidate(); setSources(current => current.filter(item => item.id !== source.id)); if (source.regions.some(region => region.id === active)) setActive(null); }}><Trash2 size={12} /></button></div>
      <p className="wb-credit">{source.sourceUrl ? <a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.credit || "Image source"}</a> : source.credit}{source.license ? ` · ${source.license}` : ""}</p>
      {source.regions.map(region => <div className={`wb-region ${active === region.id ? "active" : ""}`} key={region.id}>
        <button type="button" className="wb-region-title" aria-label={`Edit region ${source.label}: ${region.label}`} aria-pressed={active === region.id} onClick={() => { setActive(region.id); setTool("box"); revealEditor(); }}><span>{region.label}<small>{region.targets.length ? region.targets.map(organLabel).join(", ") : "Choose target structures"}</small></span>{region.reviewed ? <Check size={13} /> : <span>{region.analysis ? "Review" : "Edit"}</span>}</button>
        {region.identitySource && <p className="wb-credit">Identity: {region.identitySource}</p>}
        {region.error && <p className="wb-error" role="alert">{region.error}</p>}
        {region.analysis && <>
          <img className="wb-mask-preview" src={`data:image/png;base64,${region.analysis.overlay_png_base64}`} alt={`Tissue mask for ${region.label} in ${source.label}`} />
          <div className="wb-palette" aria-label={`Palette for ${region.label}`}>{region.analysis.palette_srgb.map((color, index) => <i key={index} style={{ background: cssColor(color) }} />)}</div>
          <p className="wb-help">{Math.round(region.analysis.quality.accepted_fraction * 100)}% retained. Green is used; amber is excluded.</p>
          <details className="wb-warnings"><summary>Analysis notes</summary><ul>{region.analysis.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
          <label className="wb-check"><input type="checkbox" aria-label={`Review region ${source.label}: ${region.label}`} checked={region.reviewed} disabled={controlsDisabled || !region.targets.length} onChange={event => updateRegion(region.id, { reviewed: event.target.checked }, false)} />I reviewed this mask, tissue identity and assigned targets.</label>
        </>}
      </div>)}
      <button className="wb-add" type="button" aria-label={`Add region to ${source.label}`} disabled={controlsDisabled || source.regions.length >= MAX_REGIONS} onClick={() => addRegion(source)}><Plus size={12} />Add tissue region</button>
    </section>)}</div>
    {selected && <section ref={editor} className="wb-editor" aria-label="Tissue region editor">
      <h3>Edit {selected.region.label}</h3>
      <label className="wb-field">Region name<input aria-label="Tissue region name" value={selected.region.label} disabled={controlsDisabled} maxLength={80} onChange={event => updateRegion(selected.region.id, { label: event.target.value }, false)} /></label>
      <label className="wb-field">Tissue in the photo<select aria-label="Reference tissue identity" value={selected.region.organ} disabled={controlsDisabled} onChange={event => { const organ = event.target.value; updateRegion(selected.region.id, { organ, identitySource: "User-assigned tissue identity", targets: organs.filter(target => REFERENCE_ORGAN_IDS[target.id] === organ).map(target => target.id) }); }}>{canonicalOrgans.map(organ => <option key={organ} value={organ}>{organ.replaceAll("-", " ")}</option>)}</select></label>
      <fieldset className="wb-targets"><legend>Apply this region to</legend>{organs.filter(organ => REFERENCE_ORGAN_IDS[organ.id] === selected.region.organ).map(organ => <label className="wb-check" key={organ.id}><input type="checkbox" aria-label={`Target ${organ.label}`} checked={selected.region.targets.includes(organ.id)} disabled={controlsDisabled} onChange={event => updateRegion(selected.region.id, { targets: event.target.checked ? [...selected.region.targets, organ.id] : selected.region.targets.filter(id => id !== organ.id) })} />{organ.label}</label>)}</fieldset>
      <label className="wb-field">Visible surface<select aria-label="Reference tissue surface" value={selected.region.surface} disabled={controlsDisabled} onChange={event => updateRegion(selected.region.id, { surface: event.target.value as WholeBodySurface, reviewed: false }, false)}><option value="unknown">Unknown / mixed</option><option value="outer">Outer tissue surface</option><option value="mucosa">Mucosa / inner surface</option><option value="cut">Cut surface</option></select></label>
      <div className="wb-tools" role="group" aria-label="Whole-body region tools">{(["box", "include", "exclude"] as const).map(value => <button type="button" key={value} aria-pressed={tool === value} disabled={controlsDisabled || Boolean(selected.region.mask)} onClick={() => setTool(value)}>{value === "box" ? "Draw region" : value === "include" ? "+ Tissue" : "− Background"}</button>)}</div>
      <div className="wb-editor-image" data-testid="whole-body-region-selection" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => { pointerMove(event); drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <img src={selected.source.image} alt={`Selected source ${selected.source.label}`} draggable={false} />
        {selected.region.mask && <img className="wb-mask-layer" src={`data:image/png;base64,${selected.region.mask}`} alt="Provided binary tissue mask" />}
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">{selected.region.selection.box && <rect x={selected.region.selection.box[0]} y={selected.region.selection.box[1]} width={Math.max(0, selected.region.selection.box[2] - selected.region.selection.box[0])} height={Math.max(0, selected.region.selection.box[3] - selected.region.selection.box[1])} fill="none" stroke="#fcf9d7" strokeWidth="2" vectorEffect="non-scaling-stroke" />}{selected.region.selection.foreground_points.map(([x, y], i) => <circle key={`f${i}`} cx={x} cy={y} r="0.014" fill="#79e3b8" />)}{selected.region.selection.background_points.map(([x, y], i) => <circle key={`b${i}`} cx={x} cy={y} r="0.014" fill="#ff897b" />)}</svg>
      </div>
      {selected.region.mask ? <p className="wb-help">This region uses a provided mask. <button className="wb-text-button" type="button" disabled={controlsDisabled} onClick={() => updateRegion(selected.region.id, { mask: null, maskSrc: null })}>Replace mask with a drawn region</button></p> : <>
        <p className="wb-help">Draw around one tissue type. Choose its identity and targets yourself; segmentation does not identify organs.</p>
        <button className="wb-text-button" type="button" disabled={controlsDisabled} onClick={() => updateRegion(selected.region.id, { selection: { box: [0, 0, 1, 1], foreground_points: [], background_points: [] } })}>Use full image for this region</button>
        <fieldset className="wb-bounds"><legend>Region bounds (%)</legend>{(["Left", "Top", "Right", "Bottom"] as const).map((label, index) => <label key={label}>{label}<input type="number" aria-label={`Whole-body region ${label.toLowerCase()}`} min="0" max="100" step="1" disabled={controlsDisabled} value={Math.round((selected.region.selection.box ?? [0, 0, 1, 1])[index]! * 100)} onChange={event => { const box: Box = [...(selected.region.selection.box ?? [0, 0, 1, 1])]; box[index] = clamp(Number(event.target.value) / 100); updateRegion(selected.region.id, { selection: { box, foreground_points: [], background_points: [] } }); }} /></label>)}</fieldset>
      </>}
      <button className="wb-text-button" type="button" disabled={controlsDisabled} onClick={() => { invalidate(); setSources(current => current.map(source => ({ ...source, regions: source.regions.filter(region => region.id !== selected.region.id) }))); setActive(null); }}><Trash2 size={11} />Remove region</button>
    </section>}
    {sources.length > 0 && <>
      <label className="wb-check"><input type="checkbox" aria-label="Use SAM 2 for whole-body regions" checked={segmentation === "sam2"} disabled={controlsDisabled} onChange={event => { backendChosen.current = true; invalidate(); setSegmentation(event.target.checked ? "sam2" : "local"); }} />Use configured SAM 2 for regions without masks</label>
      <button className="whole-button wb-analyze" type="button" disabled={controlsDisabled || Boolean(activity) || !rows.some(({ region }) => analyzable(region))} onClick={() => void analyzeAll()}><ImagePlus size={14} />Analyse all regions</button>
      {rows.some(({ region }) => !analyzable(region)) && <p className="wb-help">Regions without a valid selection and target are skipped.</p>}
    </>}
    <p className="wb-review-count" role="status">{reviewed} reviewed regions · {observations.length} analysed</p>
    <label className="whole-range"><span>Transfer strength<output>{Math.round(strength * 100)}%</output></span><input aria-label="Whole-body transfer strength" type="range" min="0" max="1" step="0.01" value={strength} disabled={controlsDisabled} onChange={event => setStrength(Number(event.target.value))} /></label>
    <label className="wb-field">Transfer<select aria-label="Whole-body transfer mode" value={mode} disabled={controlsDisabled} onChange={event => setMode(event.target.value as "chroma" | "color")}><option value="chroma">Colour only</option><option value="color">Colour and brightness</option></select></label>
    <label className="wb-check"><input type="checkbox" aria-label="Borrow related tissue colours" checked={related} disabled={controlsDisabled} onChange={event => setRelated(event.target.checked)} />Borrow from related tissue for unseen structures</label>
    <label className="wb-check"><input type="checkbox" aria-label="Harmonize other soft organs" checked={harmonize} disabled={controlsDisabled} onChange={event => setHarmonize(event.target.checked)} />Gently harmonize the remaining soft organs</label>
    <p className="wb-help">Borrowing and harmonization are inferred display adjustments, not measurements of unseen organs. Only reviewed outer surfaces inform them. Wetness, texture, shape and physics stay authored.</p>
    {proposed.error && <p className="wb-error" role="alert">{proposed.error}</p>}
    {proposed.plan && <details className="wb-coverage" open data-testid="whole-body-coverage"><summary>Custom proposal · {Object.keys(proposed.plan.assignments).length} soft structures</summary>
      <p className="wb-help">{Object.values(proposed.plan.assignments).filter(item => item.basis === "direct").length} directly sampled · {Object.values(proposed.plan.assignments).filter(item => item.basis === "related").length} related · {Object.values(proposed.plan.assignments).filter(item => item.basis === "harmonized").length} harmonized · {Object.values(proposed.plan.assignments).filter(item => item.basis === "authored").length} authored</p>
      {coverageList(proposed.plan)}
    </details>}
    {sharedWarnings.length > 0 && <details className="wb-warnings"><summary>Colour interpretation notes</summary><ul>{sharedWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
    {proposed.plan?.warnings.length ? <details className="wb-warnings"><summary>Palette notes</summary><ul>{proposed.plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
    <button className="whole-joint wb-apply" type="button" disabled={controlsDisabled || Boolean(activity) || !reviewed || !proposed.plan} onClick={() => { if (proposed.plan && reviewed) onApply(proposed.plan); }}><Check size={14} /><span>Apply all reviewed colours</span></button>
    {existingReferences > 0 && <p className="wb-help">Applying replaces the current reference palette. Structures marked authored return to their designed colours.</p>}
    <button className="whole-button wb-restore" type="button" disabled={controlsDisabled || !canRestore} onClick={onRestore}><RotateCcw size={13} />Restore previous colours</button>
    <button className="whole-button wb-download" type="button" disabled={controlsDisabled || (!appliedPlan && (!reviewed || !proposed.plan))} onClick={() => { const plan = appliedPlan ?? (reviewed ? proposed.plan : null); if (plan) downloadPlan(plan); }}><Download size={13} />Download colour plan</button>
    <p className="wb-help">{appliedPlan ? "Downloads the applied plan and all contributing source hashes. Unapplied edits are not included." : "Downloads the reviewed proposal and all contributing source hashes. It has not yet been applied."}</p>
    {appliedPlan && <p className="wb-applied" role="status">Whole-body palette applied · {Object.keys(appliedPlan.referenceColors).length} structures · {Math.round(appliedPlan.settings.strength * 100)}%</p>}
    <p className="wb-help">Images are analysed by your configured anatomy server. Observed camera colour is not calibrated tissue reflectance, organ recognition or a measured whole-body material model.</p>
  </section>;
}
