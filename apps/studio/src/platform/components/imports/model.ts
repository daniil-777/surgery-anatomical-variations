// Pure helpers of the Imports space (APPLE_STYLE_SPEC §3.5, DESIGN.md G4): the All · Unity · Blender · Other scope and
// its counts, search, how a drop of files and folders splits into imports (a model with its .bin, .mtl and textures),
// the per-file limit, job progress, and the wording of formats, sources and statistics. No React and no DOM, so all of
// it is unit-tested in node.

import type { DetectedBy, ImportedObject, ImportFormat, ImportStats, SourceApp } from "../../core/types";

// Source scope -------------------------------------------------------------------------------------------------------

export type SourceFilter = "all" | "unity" | "blender" | "other";
export type SourceGroup = Exclude<SourceFilter, "all">;

export const SOURCE_FILTERS: readonly SourceFilter[] = ["all", "unity", "blender", "other"];
export const SOURCE_GROUPS: readonly SourceGroup[] = ["unity", "blender", "other"];

export const FILTER_LABEL: Record<SourceFilter, string> = { all: "All", unity: "Unity", blender: "Blender", other: "Other" };

/** Every application in the order the "Change Source" sheet lists them (the two named scopes first). */
export const SOURCE_APP_ORDER: readonly SourceApp[] = [
  "unity",
  "blender",
  "maya",
  "3ds-max",
  "cinema-4d",
  "houdini",
  "sketchup",
  "substance",
  "zbrush",
  "reality-composer",
  "sketchfab",
  "other",
  "unknown",
];

/** Application names as text (no third-party logos, §3.5). */
export const SOURCE_LABEL: Record<SourceApp, string> = {
  unity: "Unity",
  blender: "Blender",
  maya: "Maya",
  "3ds-max": "3ds Max",
  "cinema-4d": "Cinema 4D",
  houdini: "Houdini",
  sketchup: "SketchUp",
  substance: "Substance",
  zbrush: "ZBrush",
  "reality-composer": "Reality Composer",
  sketchfab: "Sketchfab",
  other: "Other App",
  unknown: "Unknown App",
};

/** The short form on a card's chip. */
export function sourceBadge(app: SourceApp): string {
  return app === "other" ? "Other" : app === "unknown" ? "Unknown" : SOURCE_LABEL[app];
}

/** What a screen reader hears for the chip. */
export function sourceDescription(app: SourceApp): string {
  return app === "unknown" ? "Source app unknown" : `Made in ${SOURCE_LABEL[app]}`;
}

/** Unity and Blender have their own scope; every other application (and "unknown") is Other. */
export function sourceGroup(app: SourceApp): SourceGroup {
  return app === "unity" || app === "blender" ? app : "other";
}

export function sourceCounts(objects: ReadonlyArray<Pick<ImportedObject, "sourceApp">>): Record<SourceFilter, number> {
  const counts: Record<SourceFilter, number> = { all: 0, unity: 0, blender: 0, other: 0 };
  for (const object of objects) {
    counts.all += 1;
    counts[sourceGroup(object.sourceApp)] += 1;
  }
  return counts;
}

/** The segment for #/imports?source=…: no source is All; an application without its own scope selects Other. */
export function filterFromRoute(source: SourceApp | undefined): SourceFilter {
  return source === undefined ? "all" : sourceGroup(source);
}

/** The ?source= value for a segment (undefined for All; "other" names the Other scope). */
export function routeSourceForFilter(filter: SourceFilter): SourceApp | undefined {
  return filter === "all" ? undefined : filter;
}

export function matchesFilter(object: Pick<ImportedObject, "sourceApp">, filter: SourceFilter): boolean {
  return filter === "all" || sourceGroup(object.sourceApp) === filter;
}

type Searchable = Pick<ImportedObject, "title" | "tags" | "sourceApp" | "sourceDetail" | "format">;

function searchTerms(query: string): string[] {
  return query.toLocaleLowerCase("en-US").split(/\s+/).filter((term) => term !== "");
}

/** Every word of the query appears in the title, a tag, the application, the exporter's words or the format. */
export function matchesSearch(object: Searchable, query: string): boolean {
  const terms = searchTerms(query);
  if (terms.length === 0) return true;
  const haystack = [object.title, ...object.tags, SOURCE_LABEL[object.sourceApp], object.sourceDetail ?? "", FORMAT_SHORT[object.format]]
    .join("\n")
    .toLocaleLowerCase("en-US");
  return terms.every((term) => haystack.includes(term));
}

export function visibleImports<T extends Searchable>(objects: readonly T[], filter: SourceFilter, query: string): T[] {
  return objects.filter((object) => matchesFilter(object, filter) && matchesSearch(object, query));
}

/** Non-empty sections in scope order (Unity, Blender, Other); items keep their order. */
export function sectionsBySource<T extends Pick<ImportedObject, "sourceApp">>(objects: readonly T[]): Array<{ group: SourceGroup; items: T[] }> {
  return SOURCE_GROUPS.map((group) => ({ group, items: objects.filter((object) => sourceGroup(object.sourceApp) === group) })).filter(
    (section) => section.items.length > 0,
  );
}

// Formats and wording ------------------------------------------------------------------------------------------------

export const FORMAT_SHORT: Record<ImportFormat, string> = {
  glb: "GLB",
  gltf: "glTF",
  fbx: "FBX",
  obj: "OBJ",
  stl: "STL",
  ply: "PLY",
  usdz: "USDZ",
  dae: "COLLADA",
  zip: "ZIP",
};

export const FORMAT_NAME: Record<ImportFormat, string> = {
  glb: "glTF Binary 2.0 (GLB)",
  gltf: "glTF 2.0",
  fbx: "Autodesk FBX",
  obj: "Wavefront OBJ",
  stl: "STL",
  ply: "PLY (Stanford)",
  usdz: "USDZ",
  dae: "COLLADA",
  zip: "ZIP Archive",
};

const FORMAT_EXTENSION: Record<ImportFormat, string> = {
  glb: "glb",
  gltf: "gltf",
  fbx: "fbx",
  obj: "obj",
  stl: "stl",
  ply: "ply",
  usdz: "usdz",
  dae: "dae",
  zip: "zip",
};

/** "12,480 triangles", or the point count of a point cloud. */
export function geometrySummary(stats: Pick<ImportStats, "triangles" | "vertices">, locale = "en-US"): string {
  const number = new Intl.NumberFormat(locale);
  if (stats.triangles > 0) return `${number.format(stats.triangles)} ${stats.triangles === 1 ? "triangle" : "triangles"}`;
  return `${number.format(stats.vertices)} ${stats.vertices === 1 ? "point" : "points"}`;
}

/** "GLB · 12,480 triangles" under a card's title. */
export function cardSubtitle(object: Pick<ImportedObject, "format" | "stats">, locale = "en-US"): string {
  return `${FORMAT_SHORT[object.format]} · ${geometrySummary(object.stats, locale)}`;
}

export const DETECTED_BY_LABEL: Record<DetectedBy, string> = {
  metadata: "File Metadata",
  filename: "File Names",
  user: "Set by You",
  none: "Not Detected",
};

/** One sentence on where the source application came from. */
export function detectionSummary(object: Pick<ImportedObject, "sourceApp" | "sourceDetail" | "detectedBy">): string {
  const detail = object.sourceDetail?.trim() ? `“${object.sourceDetail.trim()}”` : null;
  switch (object.detectedBy) {
    case "metadata":
      return detail ? `Read from the file: ${detail}.` : "Read from the file's own metadata.";
    case "filename":
      return "Guessed from the file and folder names; the file itself names no application.";
    case "user":
      return detail ? `Set by you. The file says ${detail}.` : "Set by you.";
    case "none":
      return detail ? `The file says ${detail}, which is not an application VISCERA recognises.` : "The file names no application.";
  }
}

const UNIT_NAME: Record<string, string> = {
  m: "Meters",
  cm: "Centimeters",
  mm: "Millimeters",
  km: "Kilometers",
  in: "Inches",
  ft: "Feet",
  yd: "Yards",
};

/** "Meters", or "Not declared" when the file states no unit (OBJ, STL, PLY). */
export function unitsLabel(units: string | undefined): string {
  if (!units) return "Not declared";
  return UNIT_NAME[units.toLowerCase()] ?? units;
}

/** "1.2 × 0.8 × 2 m" (the unit is left out when the file declares none); null when nothing was measured. */
export function formatBounds(stats: Pick<ImportStats, "bbox" | "units">, locale = "en-US"): string | null {
  if (!stats.bbox) return null;
  const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 });
  const sides = [stats.bbox.x, stats.bbox.y, stats.bbox.z].map((value) => number.format(value)).join(" × ");
  return stats.units ? `${sides} ${stats.units}` : sides;
}

// Names for downloads ------------------------------------------------------------------------------------------------

/** A file name from a title: no path separators, reserved or control characters, at most 100 characters. */
export function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 100)
    .trim();
  return cleaned || "Imported model";
}

/** The original's download name: a zip when several files were kept together, else the model's own extension. */
export function originalFileName(object: Pick<ImportedObject, "title" | "format">, mimeType: string | null): string {
  const extension = mimeType === "application/zip" ? "zip" : FORMAT_EXTENSION[object.format];
  return `${safeFileName(object.title)}.${extension}`;
}

export function glbFileName(object: Pick<ImportedObject, "title">): string {
  return `${safeFileName(object.title)}.glb`;
}

/** The asset that shows the model in 3D: the preview GLB, or the original when it is a GLB itself. */
export function viewerAssetId(object: Pick<ImportedObject, "displayAssetId" | "originalAssetId" | "format">): string | null {
  if (object.displayAssetId) return object.displayAssetId;
  return object.format === "glb" ? object.originalAssetId : null;
}

// Tags ---------------------------------------------------------------------------------------------------------------

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 32;

/** Adds the comma-separated tags of `input`; duplicates (any case) are skipped, and so is anything over the limits. */
export function addTags(current: readonly string[], input: string): { tags: string[]; rejected: string[] } {
  const tags = [...current];
  const seen = new Set(tags.map((tag) => tag.toLocaleLowerCase("en-US")));
  const rejected: string[] = [];
  for (const raw of input.split(",")) {
    const tag = raw.replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    if ([...tag].length > MAX_TAG_LENGTH || tags.length >= MAX_TAGS) {
      rejected.push(tag);
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return { tags, rejected };
}

export function removeTag(current: readonly string[], tag: string): string[] {
  return current.filter((candidate) => candidate !== tag);
}

// Limits -------------------------------------------------------------------------------------------------------------

const MiB = 1024 * 1024;

/** Plan limits are defined in binary units, so they read "50 MB" the way the plans are sold. */
export function formatLimit(bytes: number): string {
  const trim = (value: number) => (value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, ""));
  if (bytes >= 1024 * MiB) return `${trim(bytes / (1024 * MiB))} GB`;
  if (bytes >= MiB) return `${trim(bytes / MiB)} MB`;
  if (bytes >= 1024) return `${trim(bytes / 1024)} KB`;
  return `${Math.max(0, Math.round(bytes))} bytes`;
}

// Splitting a drop into imports --------------------------------------------------------------------------------------

export type ImportFileKind = "model" | "archive" | "sidecar" | "project" | "unsupported" | "extra" | "junk";

/** Models that are complete in one file. */
const SELF_CONTAINED = new Set(["glb", "stl", "ply", "usdz"]);
/** Models that can point at other files (glTF → .bin and images, OBJ → .mtl → images, FBX → external textures). */
const WITH_SIDECARS = new Set(["gltf", "obj", "fbx"]);
const SIDECARS = new Set([
  "bin", "mtl",
  "png", "jpg", "jpeg", "jpe", "webp", "gif", "bmp", "avif", "tga", "tif", "tiff", "ktx2", "ktx", "dds", "psd", "exr", "hdr",
]);
/** Application project files: refused with advice on what to export instead. */
const PROJECT_FILES = new Set([
  "blend", "blend1", "unitypackage", "prefab", "unity", "max", "ma", "mb", "c4d", "hip", "hipnc", "hiplc", "skp", "ztl", "zpr",
  "spp", "sbsar", "sbs", "rcproject", "reality",
]);
/** 3D formats the importer does not read: each becomes its own (refused) import so the reason is shown. */
const OTHER_3D = new Set([
  "dae", "3ds", "3mf", "amf", "dxf", "abc", "x3d", "wrl", "vrml", "lwo", "lws", "3dm", "step", "stp", "iges", "igs", "ifc", "x",
  "vox", "usd", "usda", "usdc", "gcode", "gz",
]);
const JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", ".localized", "icon\r"]);

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stemOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/** Forward slashes, no leading slash or "." segments (paths come from webkitRelativePath or folder drops). */
export function cleanPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/** What a file is for the purpose of grouping, decided from its name (the importer reads the bytes later). */
export function fileKind(path: string): ImportFileKind {
  const lower = cleanPath(path).toLowerCase();
  const name = baseName(lower);
  if (lower.startsWith("__macosx/") || lower.includes("/__macosx/") || JUNK_NAMES.has(name) || name.startsWith("._")) return "junk";
  if (lower.split("/").some((part) => part === ".git" || part === ".svn")) return "junk";
  const extension = extensionOf(lower);
  if (SELF_CONTAINED.has(extension) || WITH_SIDECARS.has(extension)) return "model";
  if (extension === "zip") return "archive";
  if (SIDECARS.has(extension)) return "sidecar";
  if (PROJECT_FILES.has(extension)) return "project";
  if (OTHER_3D.has(extension)) return "unsupported";
  return "extra";
}

export interface DroppedFileInfo {
  /** webkitRelativePath for files from folders, else the file name. */
  path: string;
  size: number;
}

export interface ImportGroupPlan {
  /** The file the import is named after (the model, the zip, or the refused file). */
  main: number;
  /** Indexes into the dropped files, the main file first. */
  files: number[];
  /**
   * "model" and "archive" are imported; "refused" is a project or unsupported file that the importer explains;
   * "loose" holds companion files without any model (the importer says what is missing).
   */
  kind: "model" | "archive" | "refused" | "loose";
  /** File name of the main file. */
  label: string;
}

export interface ImportPlan {
  groups: ImportGroupPlan[];
  /** Duplicates, system clutter, and documents or textures that belong to no model. */
  ignored: number[];
}

function isAncestorDirectory(ancestor: string, directory: string): boolean {
  return ancestor === "" || directory === ancestor || directory.startsWith(`${ancestor}/`);
}

/**
 * Splits dropped files into imports: one per model, zip, or refused file. Companion files (.bin, .mtl, textures) join
 * the model with the same name in the same folder; otherwise the models whose folder holds them (the nearest folder
 * wins, ties share the file); otherwise the only model that can use them. GLB, STL, PLY and USDZ are complete files
 * and never get companions, so their original stays the file itself. Documents join a model only by name
 * ("chair.fbx.meta", "chair.txt").
 */
export function planImports(files: readonly DroppedFileInfo[]): ImportPlan {
  const ignored: number[] = [];
  const groups: ImportGroupPlan[] = [];
  const seen = new Set<string>();
  const paths = files.map((file) => cleanPath(file.path) || file.path);
  const attachable: Array<{ index: number; kind: "sidecar" | "extra" }> = [];

  for (const [index, file] of files.entries()) {
    const path = paths[index] ?? file.path;
    const key = `${path.toLowerCase()}\n${file.size}`;
    if (seen.has(key)) {
      ignored.push(index);
      continue;
    }
    seen.add(key);
    const kind = fileKind(path);
    switch (kind) {
      case "junk":
        ignored.push(index);
        break;
      case "model":
        groups.push({ main: index, files: [index], kind: "model", label: baseName(path) });
        break;
      case "archive":
        groups.push({ main: index, files: [index], kind: "archive", label: baseName(path) });
        break;
      case "project":
      case "unsupported":
        groups.push({ main: index, files: [index], kind: "refused", label: baseName(path) });
        break;
      case "sidecar":
      case "extra":
        attachable.push({ index, kind });
        break;
    }
  }

  const hosts = groups.filter((group) => group.kind === "model" && WITH_SIDECARS.has(extensionOf(paths[group.main] ?? "")));
  // Companions with nothing else dropped become one import, so the importer can say what is missing; next to a model,
  // a zip or a refused project file they are simply not used.
  const onlyCompanions = groups.length === 0;
  const loose: number[] = [];

  for (const { index, kind } of attachable) {
    const path = paths[index] ?? "";
    const directory = dirName(path).toLowerCase();
    const stem = stemOf(path);
    const byName = hosts.filter((host) => {
      const hostPath = paths[host.main] ?? "";
      if (dirName(hostPath).toLowerCase() !== directory) return false;
      const hostName = baseName(hostPath).toLowerCase();
      return stemOf(hostPath) === stem || hostName === stem;
    });
    let targets = byName;
    if (targets.length === 0 && kind === "sidecar") {
      const containing = hosts.filter((host) => isAncestorDirectory(dirName(paths[host.main] ?? "").toLowerCase(), directory));
      if (containing.length > 0) {
        const depth = Math.max(...containing.map((host) => dirName(paths[host.main] ?? "").length));
        targets = containing.filter((host) => dirName(paths[host.main] ?? "").length === depth);
      } else if (hosts.length === 1) {
        targets = hosts;
      }
    }
    if (targets.length > 0) {
      for (const target of targets) target.files.push(index);
    } else if (onlyCompanions && kind === "sidecar") {
      loose.push(index);
    } else {
      ignored.push(index);
    }
  }

  if (loose.length > 0) {
    const first = loose[0]!;
    groups.push({ main: first, files: loose, kind: "loose", label: baseName(paths[first] ?? "") });
  }
  groups.sort((a, b) => a.main - b.main);
  ignored.sort((a, b) => a - b);
  return { groups, ignored };
}

/**
 * Refuses an import before any byte is read when a file, or all of its files together (the original is then kept as
 * one zip), exceed the plan's per-file limit. Refused groups are left to the importer, which explains them.
 */
export function sizeRefusal(files: readonly DroppedFileInfo[], group: ImportGroupPlan, maxBytes: number): string | null {
  if (group.kind === "refused" || !(maxBytes > 0)) return null;
  for (const index of group.files) {
    const file = files[index];
    if (file && file.size > maxBytes) {
      return `“${baseName(cleanPath(file.path))}” is ${formatLimit(file.size)}. Your plan stores files up to ${formatLimit(maxBytes)} each.`;
    }
  }
  const total = group.files.reduce((sum, index) => sum + (files[index]?.size ?? 0), 0);
  if (group.files.length > 1 && total > maxBytes) {
    return `These ${group.files.length} files are ${formatLimit(total)} together and are kept as one file. Your plan stores files up to ${formatLimit(maxBytes)} each.`;
  }
  return null;
}

// Job progress -------------------------------------------------------------------------------------------------------

export type AnalysisStage = "reading" | "detecting" | "loading" | "measuring" | "converting" | "thumbnail" | "packaging";

export const STAGE_LABEL: Record<AnalysisStage, string> = {
  reading: "Reading Files…",
  detecting: "Detecting the Source App…",
  loading: "Loading the Model…",
  measuring: "Measuring…",
  converting: "Making a GLB Preview…",
  thumbnail: "Rendering a Thumbnail…",
  packaging: "Packaging the Original…",
};

export type JobState =
  | { status: "waiting" }
  | { status: "analyzing"; stage: AnalysisStage; fraction: number }
  | { status: "uploading"; loaded: number; total: number }
  | { status: "saving" }
  | { status: "done"; objectId: string }
  | { status: "failed"; reason: string; advice: string | null; retryable: boolean };

/** Analysis fills the first 60 % of a job's bar, uploads the next 37 %, saving the record the rest. */
const ANALYSIS_SHARE = 0.6;
const UPLOAD_SHARE = 0.37;

function unit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** 0…1 for the job's bar; null while it waits (an indeterminate bar). */
export function jobFraction(state: JobState): number | null {
  switch (state.status) {
    case "waiting":
      return null;
    case "analyzing":
      return ANALYSIS_SHARE * unit(state.fraction);
    case "uploading":
      return ANALYSIS_SHARE + UPLOAD_SHARE * (state.total > 0 ? unit(state.loaded / state.total) : 0);
    case "saving":
      return ANALYSIS_SHARE + UPLOAD_SHARE;
    case "done":
    case "failed":
      return 1;
  }
}

/** The status line of an import row. */
export function jobStatusText(state: JobState, locale = "en-US"): string {
  switch (state.status) {
    case "waiting":
      return "Waiting…";
    case "analyzing":
      return STAGE_LABEL[state.stage];
    case "uploading": {
      const mb = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
      const loaded = mb.format(Math.max(0, state.loaded) / 1e6);
      const total = mb.format(Math.max(0, state.total) / 1e6);
      return `Uploading ${loaded} of ${total} MB…`;
    }
    case "saving":
      return "Saving…";
    case "done":
      return "Imported";
    case "failed":
      return state.reason;
  }
}

/** Progress never moves backwards, whatever order the stages report in. */
export function advanceJob(previous: JobState, next: JobState): JobState {
  if (previous.status !== "analyzing" || next.status !== "analyzing") return next;
  return next.fraction < previous.fraction ? { ...next, fraction: previous.fraction } : next;
}
