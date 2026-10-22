// analyzeFiles: from the files a person dropped (a model, a model with its sidecars, a folder or a zip) to everything
// an imported object needs — format, main file, title, source application with evidence, statistics, notes, a preview
// GLB, a thumbnail and the original to keep. Browser entry point; every step that needs no DOM also runs in node.
// Sizes and counts are refused before any byte is read; between stages the page gets a chance to paint the progress
// and cancellation is checked.

import type { AllowedMimeType, DetectedBy, ImportFormat, ImportStats, SourceApp } from "../types";
import { blobPart, cleanLabel } from "./bytes";
import { detectSource } from "./detect";
import { ImportChoiceError, importRefusal, throwIfAborted } from "./errors";
import { IMPORT_LIMITS, formatBytes, importBudget, type ImportBudget } from "./limits";
import { loadModel } from "./loaders";
import { exportDisplayGlb, prepareDisplay } from "./normalize";
import { basename, FileSet, normalizePath, stem, type FileEntry } from "./paths";
import { ImportResources } from "./resources";
import { FORMAT_LABEL, SUPPORTED_SUMMARY, sniffBytes, sniffRefusal, type ModelFormat, type SniffResult } from "./sniff";
import { checkSceneLimits, measureScene, toImportStats } from "./stats";
import { renderThumbnail } from "./thumbnail";
import { extractZip, zipFiles } from "./zip";

export type ImportStage = "reading" | "detecting" | "loading" | "measuring" | "converting" | "thumbnail" | "packaging";

export interface ImportProgress {
  stage: ImportStage;
  /** Progress of the whole analysis from 0 to 1; it never decreases and ends at 1. */
  fraction: number;
}

export interface AnalyzeOptions {
  signal?: AbortSignal | undefined;
  /** The plan's per-file limit (Usage.maxFileBytes): the original and the preview GLB must each fit in it. */
  maxBytes: number;
  onProgress?: ((progress: ImportProgress) => void) | undefined;
  /** The model to import when the selection holds several (one of ImportChoiceError.candidates). */
  mainFile?: string | undefined;
  /** Make the preview GLB (default true; never made for GLB originals). */
  displayGlb?: boolean | undefined;
  /** Render the thumbnail (default true). */
  thumbnail?: boolean | undefined;
}

export type ImportFileRole = "model" | "sidecar" | "extra" | "ignored";

export interface ImportAnalysis {
  /** Format of the main model (a zip bundle reports the format of the model inside it). */
  format: ImportFormat;
  /** Path of the main model in the selection or in the zip. */
  mainFile: string;
  title: string;
  sourceApp: SourceApp;
  sourceDetail: string | null;
  detectedBy: DetectedBy;
  /** Why the source application was chosen (or why not), deciding finding first. */
  evidence: string[];
  stats: ImportStats;
  /** What the preview leaves out or changes, in sentences (the same list as stats.notes). */
  notes: string[];
  /** Binary glTF for the viewer; null when the original is already GLB (view the original) or none could be made. */
  displayGlb: Blob | null;
  /** 512 × 512 WebP (PNG where the browser cannot encode WebP), or null when nothing could be rendered. */
  thumbnail: Blob | null;
  /** The file to keep: the selected file, the selected zip, or a zip of every selected file. Typed for upload. */
  original: Blob;
  originalName: string;
  originalMime: AllowedMimeType;
  container: "file" | "zip" | "selection";
  files: Array<{ path: string; bytes: number; role: ImportFileRole }>;
}

/** Which model wins when a bundle holds several (a glTF next to its FBX, …). */
const FORMAT_PRIORITY: readonly ModelFormat[] = ["glb", "gltf", "fbx", "usdz", "obj", "ply", "stl"];

/** File stems that say nothing about the model ("scene.gltf" in every Sketchfab download). */
const GENERIC_STEMS = /^(scene|model|untitled|export|exported|mesh|object|default|file|asset|output|untitled[-_ ]?\d*)$/i;

const MAX_NOTES = 20;

const TRIM_ADVICE = "Leave out files the model doesn't use, or reduce its textures and export again.";

/** Where each stage starts on the overall scale: rough shares of the time a typical import spends in it. */
const STAGE_STARTS: ReadonlyArray<readonly [ImportStage, number]> = [
  ["reading", 0],
  ["detecting", 0.15],
  ["loading", 0.2],
  ["measuring", 0.5],
  ["converting", 0.55],
  ["thumbnail", 0.8],
  ["packaging", 0.92],
];

class ProgressReporter {
  private fraction = 0;
  private readonly listener: ((progress: ImportProgress) => void) | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(listener: ((progress: ImportProgress) => void) | undefined, signal: AbortSignal | undefined) {
    this.listener = listener;
    this.signal = signal;
  }

  /** Reports `within` (0–1) of `stage`, lets the page paint, then stops if the import was cancelled. */
  async report(stage: ImportStage, within = 0): Promise<void> {
    const index = STAGE_STARTS.findIndex(([name]) => name === stage);
    const start = STAGE_STARTS[index]?.[1] ?? 0;
    const end = STAGE_STARTS[index + 1]?.[1] ?? 1;
    this.fraction = Math.max(this.fraction, start + (end - start) * Math.min(1, Math.max(0, within)));
    this.listener?.({ stage, fraction: this.fraction });
    await nextTask();
    throwIfAborted(this.signal);
  }

  finish(): void {
    this.fraction = 1;
    this.listener?.({ stage: "packaging", fraction: 1 });
  }
}

/** One macrotask: long synchronous steps (parsing, exporting) then start after the browser has painted. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Classified {
  entry: FileEntry;
  sniff: SniffResult;
}

function pathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizePath(relative || file.name) || file.name || "file";
}

function checkSelectionSize(total: number, budget: ImportBudget): void {
  if (total > budget.storageBytes) {
    throw importRefusal(`The selection is ${formatBytes(total)}; your plan stores files up to ${formatBytes(budget.storageBytes)}.`, "selection-too-large", {
      code: "file_too_large",
      advice: TRIM_ADVICE,
    });
  }
  if (total > budget.analysisBytes) {
    throw importRefusal(`The selection is ${formatBytes(total)}; imports are limited to ${formatBytes(budget.analysisBytes)}.`, "selection-too-large", {
      code: "file_too_large",
      advice: TRIM_ADVICE,
    });
  }
}

function classify(entries: FileEntry[]): Classified[] {
  return entries.map((entry) => ({ entry, sniff: sniffBytes(entry.path, entry.bytes.subarray(0, IMPORT_LIMITS.sniffBytes), entry.bytes.length) }));
}

function pickMain(classified: Classified[], requested: string | undefined): Classified {
  const models = classified.filter((item) => item.sniff.kind === "model");
  if (requested !== undefined) {
    const wanted = (normalizePath(requested) ?? requested).toLowerCase();
    const match = models.find((item) => item.entry.path.toLowerCase() === wanted);
    if (!match) throw importRefusal(`${requested} is not one of the models in the selection.`, "main-file-not-found");
    return match;
  }
  if (models.length === 0) throw nothingToImport(classified);
  for (const format of FORMAT_PRIORITY) {
    const candidates = models.filter((item) => item.sniff.kind === "model" && item.sniff.format === format);
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      throw new ImportChoiceError(
        `The selection holds ${candidates.length} ${FORMAT_LABEL[format]} models (${candidates.map((item) => basename(item.entry.path)).join(", ")}).`,
        models.map((item) => item.entry.path),
      );
    }
  }
  return models[0]!;
}

function nothingToImport(classified: Classified[]): Error {
  const refusals = classified.flatMap((item) => (item.sniff.kind === "unsupported" ? [item.sniff] : []));
  // Advice for project files (.blend, .unitypackage …) first: it says exactly what to export.
  const advised = refusals.find((item) => item.app !== null) ?? refusals.find((item) => item.format !== null) ?? refusals[0];
  if (advised) return sniffRefusal(advised);
  if (classified.some((item) => item.sniff.kind === "bundle")) {
    return importRefusal("The zip contains another zip.", "nested-zip", { advice: "Unpack it and import the model inside." });
  }
  if (classified.some((item) => item.sniff.kind === "sidecar")) {
    return importRefusal("There is no 3D model in the selection, only textures or companion files.", "no-model", {
      advice: "Select the model file (.gltf, .glb, .fbx, .obj, .stl, .ply or .usdz) together with them.",
    });
  }
  return importRefusal("There is no 3D model in the selection.", "no-model", { advice: `Supported: ${SUPPORTED_SUMMARY}.` });
}

function roleOf(item: Classified, main: Classified): ImportFileRole {
  if (item === main) return "model";
  if (item.sniff.kind === "sidecar") return "sidecar";
  if (item.sniff.kind === "junk") return "ignored";
  return "extra";
}

function chooseTitle(fromFile: string | null, mainPath: string, containerName: string | null): string {
  const candidates = [fromFile, stem(mainPath), containerName ? stem(containerName) : null, "Imported model"];
  for (const [index, candidate] of candidates.entries()) {
    const cleaned = candidate ? cleanLabel(candidate, 120) : "";
    if (!cleaned) continue;
    // A generic file stem only wins when nothing better follows.
    if (index === 1 && GENERIC_STEMS.test(cleaned) && candidates.slice(2, 3).some(Boolean)) continue;
    return cleaned;
  }
  return "Imported model";
}

function selectionRoot(paths: string[]): string | null {
  const first = paths[0]?.split("/")[0];
  if (!first || paths.some((path) => !path.startsWith(`${first}/`))) return null;
  return first;
}

function listSome(names: string[]): string {
  return `${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}`;
}

export async function analyzeFiles(files: File[], options: AnalyzeOptions): Promise<ImportAnalysis> {
  const { signal } = options;
  throwIfAborted(signal);
  if (files.length === 0) throw importRefusal("No files were selected.", "no-files", { advice: "Choose a 3D file to import." });
  if (files.length > IMPORT_LIMITS.files) {
    throw importRefusal(`${files.length} files were selected; an import can use at most ${IMPORT_LIMITS.files}.`, "too-many-files", {
      code: "limit_reached",
      advice: "Select only the model and the files it uses, or zip them.",
    });
  }
  const budget = importBudget(options.maxBytes);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  checkSelectionSize(totalBytes, budget);
  const progress = new ProgressReporter(options.onProgress, signal);

  // Read the selection (sizes are checked above, before any byte is read).
  await progress.report("reading");
  const selected: FileEntry[] = [];
  let bytesRead = 0;
  for (const file of files) {
    selected.push({ path: pathOf(file), bytes: new Uint8Array(await file.arrayBuffer()) });
    bytesRead += file.size;
    await progress.report("reading", totalBytes > 0 ? bytesRead / totalBytes : 1);
  }

  // A zip alone is a bundle to unpack. Next to a model, a zip is just kept with the original; next to other files
  // only, it is ambiguous.
  await progress.report("detecting");
  const selectedKinds = classify(selected);
  const bundles = selectedKinds.filter((item) => item.sniff.kind === "bundle");
  let container: ImportAnalysis["container"] = files.length === 1 ? "file" : "selection";
  let containerName: string | null = null;
  let entries = selected;
  const notes: string[] = [];
  if (bundles.length > 0 && selected.length === 1) {
    const zip = bundles[0]!;
    entries = extractZip(zip.entry.bytes, budget, basename(zip.entry.path)).entries;
    container = "zip";
    containerName = zip.entry.path;
  } else if (bundles.length > 0 && !selectedKinds.some((item) => item.sniff.kind === "model")) {
    throw importRefusal("The selection mixes a .zip with other files.", "zip-and-files", { advice: "Select either one .zip or the model's own files, not both." });
  } else if (files.length > 1) {
    containerName = selectionRoot(selected.map((entry) => entry.path));
  }

  const classified = container === "zip" ? classify(entries) : selectedKinds;
  const usable = classified.filter((item) => item.sniff.kind !== "junk");
  const main = pickMain(usable, options.mainFile);
  if (main.sniff.kind !== "model") throw importRefusal("The selected file is not a model this importer reads.", "no-model", { advice: `Supported: ${SUPPORTED_SUMMARY}.` });
  const format = main.sniff.format;

  const otherModels = usable.filter((item) => item !== main && item.sniff.kind === "model").map((item) => basename(item.entry.path));
  if (otherModels.length > 0) notes.push(`Also in the selection, not imported: ${listSome(otherModels)}.`);
  const skipped = usable.filter((item) => item.sniff.kind === "unsupported" || item.sniff.kind === "bundle").map((item) => basename(item.entry.path));
  if (skipped.length > 0) notes.push(`Kept with the original but not read: ${listSome(skipped)}.`);

  const resources = new ImportResources();
  let stats: ImportStats;
  let detection: ReturnType<typeof detectSource>;
  let title: string;
  let displayGlb: Blob | null = null;
  let thumbnail: Blob | null = null;
  try {
    await progress.report("loading");
    const fileSet = new FileSet(usable.map((item) => item.entry));
    const model = await loadModel({ main: main.entry, format, files: fileSet, resources, budget, signal });

    await progress.report("measuring");
    const label = basename(main.entry.path);
    const measure = measureScene(model.root);
    checkSceneLimits(measure, label);
    notes.push(...model.notes);
    if (measure.morphTargets) notes.push("Has morph targets (blend shapes).");
    detection = detectSource({
      ...model.signals,
      names: [main.entry.path, ...(containerName ? [containerName] : [])],
      paths: usable.map((item) => item.entry.path),
    });
    title = chooseTitle(model.title, main.entry.path, containerName);
    const display = prepareDisplay(model, resources);
    notes.push(...display.notes);

    if (format !== "glb" && options.displayGlb !== false) {
      await progress.report("converting");
      const exported = await exportDisplayGlb(display.scene, model.animations, Math.min(budget.storageBytes, IMPORT_LIMITS.analysisBytes), signal);
      displayGlb = exported.glb;
      notes.push(...exported.notes);
    }
    if (options.thumbnail !== false) {
      await progress.report("thumbnail");
      const rendered = await renderThumbnail(display.scene, { signal });
      thumbnail = rendered.blob;
      if (rendered.note) notes.push(rendered.note);
    }
    const kept = [...new Set(notes)].slice(0, MAX_NOTES).map((note) => cleanLabel(note, 300));
    notes.length = 0;
    notes.push(...kept);
    stats = toImportStats(measure, { animations: model.animations.length, units: model.units, upAxis: model.upAxis, notes });
  } finally {
    resources.dispose();
  }

  // The original: the file itself, the zip as selected, or every selected file zipped together.
  await progress.report("packaging");
  let original: Blob;
  let originalName: string;
  let originalMime: AllowedMimeType;
  if (container === "file") {
    originalMime = main.sniff.mime;
    original = files[0]!.slice(0, files[0]!.size, originalMime);
    originalName = basename(main.entry.path);
  } else if (container === "zip") {
    originalMime = "application/zip";
    original = files[0]!.slice(0, files[0]!.size, originalMime);
    originalName = basename(containerName ?? "import.zip");
  } else {
    originalMime = "application/zip";
    original = new Blob([blobPart(zipFiles(usable.map((item) => item.entry)))], { type: originalMime });
    originalName = `${cleanLabel((containerName ?? stem(main.entry.path)).replace(/[\\/:*?"<>|]+/g, "-"), 100) || "import"}.zip`;
  }
  if (original.size > budget.storageBytes) {
    throw importRefusal(`The original is ${formatBytes(original.size)}; your plan stores files up to ${formatBytes(budget.storageBytes)}.`, "original-too-large", {
      code: "file_too_large",
      advice: TRIM_ADVICE,
    });
  }
  progress.finish();

  return {
    format,
    mainFile: main.entry.path,
    title,
    sourceApp: detection.sourceApp,
    sourceDetail: detection.sourceDetail,
    detectedBy: detection.detectedBy,
    evidence: detection.evidence,
    stats,
    notes,
    displayGlb,
    thumbnail,
    original,
    originalName,
    originalMime,
    container,
    files: classified.map((item) => ({ path: item.entry.path, bytes: item.entry.bytes.length, role: roleOf(item, main) })),
  };
}
