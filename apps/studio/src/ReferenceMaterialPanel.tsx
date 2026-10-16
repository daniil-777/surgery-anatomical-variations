import { apiOnline, apiUrl, bundledJson, publicUrl } from "./api";
import { NEEDS_API } from "./atlasLocal";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ImagePlus, LoaderCircle, Paintbrush, RotateCcw } from "lucide-react";
import { atlasError } from "./atlas";
import { validateReferenceColor, type ReferenceColor } from "./atlasMaterial";
import { REFERENCE_EXAMPLES, type ReferenceExample } from "./referenceExamples";
import "./referenceMaterial.css";

type Point = [number, number];
type Box = [number, number, number, number];
export interface ReferenceAnalysis {
  version: "reference-analysis-1";
  organ: string;
  source_sha256: string;
  mask_sha256: string;
  width: number;
  height: number;
  mask_png_base64: string;
  overlay_png_base64: string;
  palette_srgb: [number, number, number][];
  quality: { selected_pixels: number; accepted_pixels: number; accepted_fraction: number };
  warnings: string[];
  reference_color: ReferenceColor;
}
export function validateReferenceAnalysis(value: unknown, organ: string): asserts value is ReferenceAnalysis {
  if (!value || typeof value !== "object") throw new Error("The reference analysis is invalid.");
  const result = value as ReferenceAnalysis;
  validateReferenceColor(result.reference_color, organ);
  if (result.version !== "reference-analysis-1" || result.organ !== organ ||
      result.source_sha256 !== result.reference_color.source_sha256 || result.mask_sha256 !== result.reference_color.mask_sha256 ||
      !Number.isInteger(result.width) || result.width < 1 || result.width > 4096 ||
      !Number.isInteger(result.height) || result.height < 1 || result.height > 4096 ||
      typeof result.mask_png_base64 !== "string" || !result.mask_png_base64 ||
      typeof result.overlay_png_base64 !== "string" || !result.overlay_png_base64 ||
      !Array.isArray(result.palette_srgb) || result.palette_srgb.length < 1 || result.palette_srgb.length > 16 ||
      !result.palette_srgb.every(color => Array.isArray(color) && color.length === 3 && color.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1)) ||
      !Array.isArray(result.warnings) || !result.warnings.every(warning => typeof warning === "string") ||
      !result.quality || !Number.isInteger(result.quality.selected_pixels) || result.quality.selected_pixels < 1 ||
      !Number.isInteger(result.quality.accepted_pixels) || result.quality.accepted_pixels < 1 || result.quality.accepted_pixels > result.quality.selected_pixels ||
      !Number.isFinite(result.quality.accepted_fraction) || result.quality.accepted_fraction <= 0 || result.quality.accepted_fraction > 1)
    throw new Error("The reference analysis returned incomplete or mismatched colour data.");
}
const cssColor = (color: number[]) => `rgb(${color.map(channel => Math.round(channel * 255)).join(" ")})`;
const clamp = (value: number) => Math.min(1, Math.max(0, value));
function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The image could not be read."));
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
}
interface Props {
  organ: string;
  organLabel: string;
  reference: ReferenceColor | null | undefined;
  disabled: boolean;
  onApply: (reference: ReferenceColor | null) => void;
}

/** A reference is only committed after the operator has reviewed its mask and target. */
export function ReferenceMaterialPanel({ organ, organLabel, reference, disabled, onApply }: Props) {
  const [source, setSource] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [example, setExample] = useState<ReferenceExample | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [mask, setMask] = useState("");
  const [maskName, setMaskName] = useState("");
  const [box, setBox] = useState<Box | null>(null);
  const [foreground, setForeground] = useState<Point[]>([]);
  const [background, setBackground] = useState<Point[]>([]);
  const [tool, setTool] = useState<"box" | "include" | "exclude">("box");
  const [segmentation, setSegmentation] = useState<"local" | "sam2">("local");
  const [analysis, setAnalysis] = useState<ReferenceAnalysis | null>(null);
  const [strength, setStrength] = useState(reference?.strength ?? 0.7);
  const [mode, setMode] = useState<ReferenceColor["mode"]>(reference?.mode ?? "chroma");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showOverlay, setShowOverlay] = useState(true);
  const version = useRef(0);
  const request = useRef<AbortController | null>(null);
  const backendChosen = useRef(false);
  const drag = useRef<Point | null>(null);
  const invalidate = () => {
    ++version.current; request.current?.abort(); request.current = null;
    setAnalysis(null); setConfirmed(false); setLoading(false); setSourceLoading(false); setError("");
  };
  useEffect(() => () => { ++version.current; request.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl("/api/atlas/reference-material/status"), { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const status: unknown = await response.json();
      if (controller.signal.aborted || backendChosen.current || !status || typeof status !== "object") return;
      const available = status as { default_segmentation?: unknown; sam2?: { configured?: unknown } };
      if (available.default_segmentation === "sam2" && available.sam2?.configured === true) setSegmentation("sam2");
    }).catch(() => { /* Older anatomy servers retain the explicit local default. */ });
    return () => controller.abort();
  }, []);

  const clearSource = () => {
    setSource(""); setSourceName(""); setExample(null); setMask(""); setMaskName("");
    setBox(null); setForeground([]); setBackground([]); setTool("box"); drag.current = null;
  };
  const loadExample = async (next: ReferenceExample) => {
    invalidate(); clearSource(); setExample(next); setSourceLoading(true);
    const id = version.current, controller = new AbortController(); request.current = controller;
    try {
      const response = await fetch(publicUrl(next.src), { signal: controller.signal });
      if (!response.ok) throw new Error("The example could not be loaded. Try again or upload a reference image.");
      const blob = await response.blob();
      const value = await dataUrl(new File([blob], next.label, { type: blob.type }));
      const decoded = new Image(); decoded.src = value; await decoded.decode();
      if (id !== version.current || controller.signal.aborted) return;
      setSource(value); setSourceName(next.label);
      setBox([...next.box]); setForeground(next.foreground.map(point => [...point])); setBackground(next.background.map(point => [...point]));
    } catch (cause) {
      if (id === version.current && !controller.signal.aborted) {
        setExample(null); setError(cause instanceof Error ? cause.message : "The example could not be opened.");
      }
    } finally { if (id === version.current) setSourceLoading(false); }
  };
  const upload = async (file: File | undefined, isMask = false) => {
    if (!file) return;
    invalidate();
    if (isMask) { setMask(""); setMaskName(""); }
    else clearSource();
    const id = version.current;
    try {
      if (file.size > 12 * 1024 * 1024) throw new Error("Choose an image smaller than 12 MB.");
      if (!(isMask ? ["image/png"] : ["image/png", "image/jpeg", "image/webp"]).includes(file.type))
        throw new Error(isMask ? "Choose a PNG mask with white foreground and black background." : "Choose a PNG, JPEG or WebP image.");
      const value = await dataUrl(file);
      const decoded = new Image(); decoded.src = value; await decoded.decode();
      if (id !== version.current) return;
      if (isMask) { setMask(value.split(",")[1]!); setMaskName(file.name); }
      else { setSource(value); setSourceName(file.name); }
    } catch (cause) { if (id === version.current) setError(cause instanceof Error ? cause.message : "The image could not be opened."); }
  };
  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)];
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const next = point(event);
    if (tool === "include" && (!box || next[0] <= box[0] || next[0] >= box[2] || next[1] <= box[1] || next[1] >= box[3])) {
      setError("Place tissue points inside the selected region."); return;
    }
    invalidate();
    if (tool === "include") { setForeground(points => [...points, next].slice(-32)); return; }
    if (tool === "exclude") { setBackground(points => [...points, next].slice(-32)); return; }
    drag.current = next; setBox([next[0], next[1], next[0], next[1]]);
    setForeground([]); setBackground([]); event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const end = point(event), start = drag.current;
    setBox([Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])]);
  };
  const validBox = Boolean(box && box[2] - box[0] >= 0.01 && box[3] - box[1] >= 0.01);
  const analyze = async () => {
    if (!source || !validBox || disabled) return;
    backendChosen.current = true;
    invalidate();
    const id = version.current, controller = new AbortController(); request.current = controller;
    setLoading(true); setShowOverlay(true);
    try {
      if (!(await apiOnline())) {
        // the public copy: the API's analysis of a bundled example (its default region), made at build time
        if (!example) throw new Error(NEEDS_API.referenceColor);
        const bundled = await bundledJson(`atlas/reference-material/examples/${example.id}.json`, controller.signal).catch(() => { throw new Error(NEEDS_API.referenceColor); }) as Record<string, unknown>;
        // the organ is the identity you assign, as online: the bundled analysis of the photograph carries the one it was made with
        if (bundled && typeof bundled === "object" && bundled.reference_color && typeof bundled.reference_color === "object") { bundled.organ = organ; bundled.reference_color = { ...(bundled.reference_color as Record<string, unknown>), organ }; }
        validateReferenceAnalysis(bundled, organ);
        if (id === version.current && !controller.signal.aborted) setAnalysis(bundled);
        return;
      }
      const response = await fetch(apiUrl("/api/atlas/reference-material/analyze"), {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ image_base64: source.split(",")[1], organ, selection: { box, foreground_points: foreground, background_points: background }, segmentation, ...(mask ? { mask_base64: mask } : {}) }),
      });
      if (!response.ok) throw await atlasError(response);
      const result: unknown = await response.json(); validateReferenceAnalysis(result, organ);
      if (id === version.current && !controller.signal.aborted) setAnalysis(result);
    } catch (cause) {
      if (id === version.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Reference analysis failed.");
    } finally { if (id === version.current) setLoading(false); }
  };
  const apply = () => {
    if (!analysis || !confirmed || disabled || loading) return;
    onApply({ ...analysis.reference_color, strength, mode });
  };
  return <section className="atlas-reference-material" aria-label="Reference image colour transfer">
    <div className="atlas-recipe-heading"><span><ImagePlus size={14} />Colour from a reference</span>{reference && <button type="button" disabled={disabled} onClick={() => onApply(null)}><RotateCcw size={12} />Clear reference colour</button>}</div>
    <p className="atlas-control-intro">Select tissue in a surgical image, review its mask, then transfer its colour to <strong>{organLabel}</strong>. Lighting in the photo affects the result.</p>
    <div className="atlas-reference-examples" role="group" aria-label="Included reference images">
      {REFERENCE_EXAMPLES.map((item, index) => <button type="button" key={item.id} aria-label={`Use colon reference ${index + 1}`} aria-pressed={example?.id === item.id} disabled={disabled} onClick={() => void loadExample(item)}>
        <img src={publicUrl(item.src)} alt="" width="1920" height="1080" loading="lazy" />
        <span>{item.label}</span>
      </button>)}
    </div>
    <p className="atlas-reference-help atlas-reference-credit">Porcine colon · ex vivo · three views of one specimen.<br /><a href="https://doi.org/10.5281/zenodo.17598453" target="_blank" rel="noreferrer">DRENDS · Loza et al.</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></p>
    {sourceLoading && <p className="atlas-reference-help" role="status">Loading reference image…</p>}
    <label className="atlas-reference-upload">Reference image<input aria-label="Reference image" type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label>
    {source && <>
      <p className="atlas-reference-filename" title={sourceName}>{sourceName}</p>
      {example && <p className="atlas-reference-help">Example source: porcine colon. A starter region is selected; review it before using its colour on {organLabel}.</p>}
      <div className="atlas-reference-tools" role="group" aria-label="Reference region tools">{(["box", "include", "exclude"] as const).map(value => <button type="button" key={value} aria-pressed={tool === value} disabled={disabled || Boolean(mask)} onClick={() => setTool(value)}>{value === "box" ? "Draw region" : value === "include" ? "+ Tissue" : "− Background"}</button>)}</div>
      <div className="atlas-reference-image" data-testid="reference-image-selection" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => { pointerMove(event); drag.current = null; }} onPointerCancel={() => { drag.current = null; setBox(null); invalidate(); }}>
        <img src={source} alt={`Reference for ${organLabel}. Draw a region around the tissue.`} draggable={false} />
        {analysis && showOverlay && <img className="atlas-reference-overlay" src={`data:image/png;base64,${analysis.overlay_png_base64}`} alt="Tissue segmentation overlay" draggable={false} />}
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          {box && <rect x={box[0]} y={box[1]} width={Math.max(0, box[2] - box[0])} height={Math.max(0, box[3] - box[1])} fill="none" stroke="#f3f5d8" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          {foreground.map(([x, y], index) => <circle key={`in-${index}`} cx={x} cy={y} r="0.014" fill="#75e1b9" stroke="#102621" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
          {background.map(([x, y], index) => <circle key={`out-${index}`} cx={x} cy={y} r="0.014" fill="#ff887d" stroke="#321919" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        </svg>
      </div>
      <p className="atlas-reference-help">Drag around one organ with its centre on tissue. Add tissue or background points to refine it. Organ identity is supplied by you.</p>
      <div className="atlas-reference-actions"><button type="button" disabled={disabled} onClick={() => { invalidate(); setBox([0, 0, 1, 1]); setForeground([]); setBackground([]); }}>Select entire image</button><button type="button" disabled={disabled || (!foreground.length && !background.length)} onClick={() => { invalidate(); setForeground([]); setBackground([]); }}>Clear points</button></div>
      <details className="atlas-reference-advanced"><summary>Mask and segmentation options</summary>
        <fieldset className="atlas-reference-bounds"><legend>Region bounds (% of image)</legend>{(["Left", "Top", "Right", "Bottom"] as const).map((label, index) => <label key={label}>{label}<input type="number" aria-label={`Reference region ${label.toLowerCase()}`} min="0" max="100" step="1" value={Math.round((box ?? [0, 0, 1, 1])[index]! * 100)} disabled={disabled} onChange={event => { invalidate(); const next: Box = [...(box ?? [0, 0, 1, 1])]; next[index] = clamp(Number(event.target.value) / 100); setBox(next); setForeground([]); setBackground([]); }} /></label>)}</fieldset>
        <label className="atlas-reference-upload">Optional reviewed PNG mask<input aria-label="Reference mask" type="file" accept="image/png" disabled={disabled} onChange={event => { void upload(event.target.files?.[0], true); event.target.value = ""; }} /></label>
        <p className="atlas-reference-help">White tissue, black background, same dimensions as the photo. A reviewed mask gives the most control.</p>
        {mask && <div className="atlas-reference-actions"><span className="atlas-reference-filename">{maskName}</span><button type="button" disabled={disabled} onClick={() => { invalidate(); setMask(""); setMaskName(""); }}>Remove mask</button></div>}
        <label className="atlas-reference-check"><input type="checkbox" checked={segmentation === "sam2"} disabled={disabled || Boolean(mask)} onChange={event => { backendChosen.current = true; invalidate(); setSegmentation(event.target.checked ? "sam2" : "local"); }} />Use configured SAM 2 model</label>
        <p className="atlas-reference-help">SAM 2 is preferred when installed on the server. Uncheck it to use local region refinement.</p>
      </details>
      <p className="atlas-reference-help">Segmentation: {mask ? "reviewed mask" : segmentation === "sam2" ? "SAM 2" : "local region refinement"}.</p>
      <button type="button" className="atlas-btn atlas-reference-analyze" disabled={disabled || loading || !validBox} onClick={() => void analyze()}>{loading ? <LoaderCircle size={14} className="atlas-reference-spinner" /> : <ImagePlus size={14} />}{loading ? "Analysing region…" : "Analyse reference region"}</button>
    </>}
    {error && <p className="atlas-reference-error" role="alert">{error}</p>}
    {analysis && <div className="atlas-reference-result">
      <label className="atlas-reference-check"><input type="checkbox" checked={showOverlay} onChange={event => setShowOverlay(event.target.checked)} />Show tissue mask</label>
      <div className="atlas-reference-palette" aria-label="Observed tissue palette">{analysis.palette_srgb.map((color, index) => <span key={index} style={{ backgroundColor: cssColor(color) }} title={cssColor(color)} />)}</div>
      <p className="atlas-reference-help" role="status">{Math.round(analysis.quality.accepted_fraction * 100)}% of selected tissue retained after highlight and shadow filtering. Green is used; amber is excluded.</p>
      {analysis.warnings.length > 0 && <ul className="atlas-reference-warnings">{analysis.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <label className="atlas-control"><span>Transfer strength<output>{Math.round(strength * 100)}%</output></span><input aria-label="Reference transfer strength" type="range" min="0" max="1" step="0.01" value={strength} disabled={disabled} onChange={event => setStrength(Number(event.target.value))} /></label>
      <label className="atlas-reference-mode">Transfer<select aria-label="Reference transfer mode" value={mode} disabled={disabled} onChange={event => setMode(event.target.value as ReferenceColor["mode"])}><option value="chroma">Colour only</option><option value="color">Colour and brightness</option></select></label>
      <p className="atlas-reference-help">{mode === "chroma" ? "Keeps the organ’s current lightness. Start here when the photo has strong surgical lighting." : "Also copies the photo’s brightness. Dim or coloured lighting can make the organ look darker or warmer; lower the strength if needed."}</p>
      <label className="atlas-reference-check atlas-reference-confirm"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} />{example ? `I reviewed this colon example and want its colour on ${organLabel}.` : `I confirm the highlighted tissue is ${organLabel}.`}</label>
      <button type="button" className="atlas-btn atlas-reference-apply" disabled={disabled || !confirmed} onClick={apply}><Paintbrush size={14} />Apply reference colour</button>
    </div>}
    {reference && <p className="atlas-reference-applied" role="status">Reference colour applied · {Math.round(reference.strength * 100)}% · {reference.mode === "chroma" ? "colour only" : "colour and brightness"}</p>}
    <p className="atlas-reference-help">Photos are processed by the configured anatomy server. This transfers observed colour; it does not identify organs or recover measured tissue optics.</p>
  </section>;
}
