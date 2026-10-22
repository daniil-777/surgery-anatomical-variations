// Reading a library item for display: its claims (copied verbatim from the lab that made it — never upgraded), the media
// facts labs and uploads record (size in pixels, duration, geometry counts), a short summary of the remaining metadata,
// and which file the inspector previews. Pure, so it is unit-tested in node.
import type { JsonObject, JsonValue, LibraryFile, LibraryItem, LibraryKind } from "../../core/types";
import { fileExtension } from "./uploadKind";

export interface ItemClaims {
  evidence: string | null;
  limitations: string[];
  rights: string | null;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** metadata.claims as stored by "Add to Library" ({evidence, limitations[], rights?}); null when absent or empty. */
export function readClaims(metadata: JsonObject | null | undefined): ItemClaims | null {
  const claims = metadata?.claims;
  if (!isObject(claims)) return null;
  const evidence = typeof claims.evidence === "string" && claims.evidence.trim() !== "" ? claims.evidence : null;
  const limitations = Array.isArray(claims.limitations)
    ? claims.limitations.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  const rights = typeof claims.rights === "string" && claims.rights.trim() !== "" ? claims.rights : null;
  if (evidence === null && limitations.length === 0 && rights === null) return null;
  return { evidence, limitations, rights };
}

/** Same rule as the lab host's "Add to Library" refusal (core/labs/host.ts isResearchOnly). */
export function isResearchOnly(rights: string | null | undefined): boolean {
  return typeof rights === "string" && /\bresearch[\s_-]*(use[\s_-]*)?only\b/i.test(rights);
}

export interface MediaFacts {
  width?: number;
  height?: number;
  durationMs?: number;
  /** The capture rate a recorder asked for (not a measured frame rate). */
  requestedFps?: number;
  vertices?: number;
  triangles?: number;
  meshes?: number;
  /** The glTF asset.generator string, verbatim. */
  generator?: string;
}

function positive(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function count(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/**
 * Pixel size, duration and geometry counts from the places they are written: metadata.media (Library uploads),
 * metadata.recording (the recorder's RecordingMetrics), metadata.metrics and metadata.stats. The first value found wins.
 */
export function readMediaFacts(metadata: JsonObject | null | undefined): MediaFacts {
  const facts: MediaFacts = {};
  if (!metadata) return facts;
  const sources = [metadata.media, metadata.recording, metadata.metrics, metadata.stats].filter(isObject);
  const first = <T>(read: (source: JsonObject) => T | undefined): T | undefined => {
    for (const source of sources) {
      const value = read(source);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const width = first((source) => positive(source.width));
  const height = first((source) => positive(source.height));
  const durationMs = first((source) => {
    const seconds = positive(source.durationSeconds);
    return positive(source.durationMs) ?? (seconds === undefined ? undefined : seconds * 1000);
  });
  const requestedFps = first((source) => positive(source.requestedFps));
  const vertices = first((source) => count(source.vertices));
  const triangles = first((source) => count(source.triangles));
  const meshes = first((source) => count(source.meshes));
  const generator = first((source) => (typeof source.generator === "string" && source.generator.trim() !== "" ? source.generator : undefined));
  if (width !== undefined) facts.width = width;
  if (height !== undefined) facts.height = height;
  if (durationMs !== undefined) facts.durationMs = durationMs;
  if (requestedFps !== undefined) facts.requestedFps = requestedFps;
  if (vertices !== undefined) facts.vertices = vertices;
  if (triangles !== undefined) facts.triangles = triangles;
  if (meshes !== undefined) facts.meshes = meshes;
  if (generator !== undefined) facts.generator = generator;
  return facts;
}

/** metadata.source.kind === "upload": the item came from the user's own file rather than a lab. */
export function isUpload(metadata: JsonObject | null | undefined): boolean {
  const source = metadata?.source;
  return isObject(source) && source.kind === "upload";
}

export interface SummaryRow {
  key: string;
  value: string;
}

const SUMMARY_SKIP = new Set(["claims", "media", "source"]);

function describeValue(value: JsonValue): string {
  if (value === null) return "—";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 119)}…` : value;
  if (typeof value === "number") return Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value) : String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string" || typeof entry === "number")) {
      const text = value.map(String).join(", ");
      return text.length > 120 ? `${text.slice(0, 119)}…` : text || "—";
    }
    return value.length === 1 ? "1 entry" : `${value.length} entries`;
  }
  const fields = Object.keys(value).length;
  return fields === 1 ? "1 field" : `${fields} fields`;
}

/**
 * The metadata the inspector lists besides claims and media facts: keys exactly as stored, nested objects one level
 * deep ("recording.durationMs"), at most `maxRows` rows.
 */
export function metadataSummary(metadata: JsonObject | null | undefined, maxRows = 12): SummaryRow[] {
  const rows: SummaryRow[] = [];
  if (!metadata) return rows;
  for (const [key, value] of Object.entries(metadata)) {
    if (SUMMARY_SKIP.has(key)) continue;
    if (isObject(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0) continue;
      for (const [child, childValue] of entries) {
        rows.push({ key: `${key}.${child}`, value: describeValue(childValue) });
        if (rows.length >= maxRows) return rows;
      }
    } else {
      rows.push({ key, value: describeValue(value) });
    }
    if (rows.length >= maxRows) return rows;
  }
  return rows;
}

/** How many metadata rows exist beyond the summary's limit (for a "+3 more" hint). */
export function metadataRowCount(metadata: JsonObject | null | undefined): number {
  return metadataSummary(metadata, Number.MAX_SAFE_INTEGER).length;
}

export type FileType = "model" | "image" | "video" | "data" | "text" | "archive" | "other";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "ktx2"]);
const BROWSER_IMAGES = new Set(["png", "jpg", "jpeg", "webp", "avif", "gif"]);

/** The kind of file, from its MIME type when known, else its extension. */
export function fileType(file: Pick<LibraryFile, "filename"> & { mimeType?: string | undefined }): FileType {
  const mime = (file.mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = fileExtension(file.filename);
  if (mime === "model/gltf-binary" || extension === "glb") return "model";
  if (mime.startsWith("model/") || ["gltf", "obj", "stl", "usdz", "fbx", "ply"].includes(extension)) return "model";
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) return "image";
  if (mime.startsWith("video/") || ["mp4", "m4v", "webm"].includes(extension)) return "video";
  if (mime === "application/json" || extension === "json") return "data";
  if (mime === "application/zip" || mime === "application/gzip" || ["zip", "gz"].includes(extension)) return "archive";
  if (mime.startsWith("text/") || ["txt", "md", "csv"].includes(extension)) return "text";
  return "other";
}

/** Only binary glTF opens in the viewer; images only in formats every browser decodes. */
function isViewableModel(file: LibraryFile): boolean {
  const mime = (file.mimeType ?? "").toLowerCase();
  return mime === "model/gltf-binary" || fileExtension(file.filename) === "glb";
}

function isViewableImage(file: LibraryFile): boolean {
  const mime = (file.mimeType ?? "").toLowerCase();
  if (mime) return ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"].includes(mime);
  return BROWSER_IMAGES.has(fileExtension(file.filename));
}

function isViewableVideo(file: LibraryFile): boolean {
  return fileType(file) === "video";
}

export type PreviewChoice =
  | { type: "model"; file: LibraryFile }
  | { type: "image"; file: LibraryFile }
  | { type: "video"; file: LibraryFile }
  | { type: "thumbnail" }
  | { type: "none" };

const ROLE_RANK: Record<string, number> = { primary: 0, mesh: 1, video: 1, preview: 2, albedo: 3 };

function byRole(a: LibraryFile, b: LibraryFile): number {
  return (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || a.position - b.position;
}

const PREFERENCE: Record<LibraryKind, ReadonlyArray<"model" | "image" | "video">> = {
  shape: ["model", "image", "video"],
  model: ["model", "image", "video"],
  scene: ["model", "video", "image"],
  recording: ["video", "model", "image"],
  material: ["image", "model", "video"],
  texture: ["image", "model", "video"],
  image: ["image", "model", "video"],
};

/**
 * What the inspector shows for an item: its mesh in the 3D viewer, an image, a video, or the stored thumbnail. Files
 * whose role is "thumbnail" are never chosen (the item's thumbnail covers them).
 */
export function choosePreview(item: Pick<LibraryItem, "kind" | "thumbnailAssetId"> & { files?: LibraryFile[] | undefined }): PreviewChoice {
  const files = [...(item.files ?? [])].filter((file) => file.role !== "thumbnail").sort(byRole);
  for (const type of PREFERENCE[item.kind]) {
    const match = files.find(type === "model" ? isViewableModel : type === "image" ? isViewableImage : isViewableVideo);
    if (match) return { type, file: match };
  }
  return item.thumbnailAssetId ? { type: "thumbnail" } : { type: "none" };
}

/** The item's texture maps (albedo, normal …) in a stable order, for the inspector's Maps strip. */
export function textureMaps(files: readonly LibraryFile[] | undefined): LibraryFile[] {
  const MAP_ROLES = ["albedo", "normal", "roughness", "metalness", "height", "ao", "emissive", "opacity"];
  return (files ?? [])
    .filter((file) => MAP_ROLES.includes(file.role) && isViewableImage(file))
    .sort((a, b) => MAP_ROLES.indexOf(a.role) - MAP_ROLES.indexOf(b.role) || a.position - b.position);
}

/** "Albedo", "Ambient Occlusion" … for file roles. */
export const ROLE_LABEL: Readonly<Record<string, string>> = {
  primary: "Main File",
  mesh: "Mesh",
  albedo: "Albedo",
  normal: "Normal",
  roughness: "Roughness",
  metalness: "Metalness",
  height: "Height",
  ao: "Ambient Occlusion",
  emissive: "Emissive",
  opacity: "Opacity",
  thumbnail: "Thumbnail",
  preview: "Preview",
  video: "Video",
  data: "Data",
  spec: "Specification",
  material: "Material",
  other: "Other",
};
