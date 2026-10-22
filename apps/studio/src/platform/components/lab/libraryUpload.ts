// "Add to Library" from a lab: uploads every file content-addressed (assets.put dedups by SHA-256), then creates one
// library item that records where it came from. Claims a lab makes about its output are copied verbatim into the item's
// metadata (DESIGN.md §2 anti-goals): the platform adds provenance, never qualities.

import type { LabLibraryExport } from "../../bridge/labSession";
import { storableMimeType } from "../../core/snapshot";
import type { AssetPort, JsonObject, JsonValue, LibraryFileRole, LibraryItem, LibraryKind, LibraryPort, Uuid } from "../../core/types";

export interface LibraryUploadFile {
  filename: string;
  role: LibraryFileRole;
  blob: Blob;
}

export interface LibraryUploadRequest {
  kind: LibraryKind;
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  labId: string | null;
  sourceProjectId: Uuid | null;
  sourceVersionId: Uuid | null;
  files: LibraryUploadFile[];
  thumbnail: Blob | null;
  metadata: JsonObject;
}

export interface LibraryUploadOptions {
  /** Aggregate bytes over every file and the thumbnail. */
  onProgress?: ((progress: { loaded: number; total: number }) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** library_items.metadata is at most 64 KB of JSON; lab metadata beyond this budget is left out (and says so). */
export const LIBRARY_METADATA_BUDGET = 60 * 1024;
const MAX_TITLE = 120;

/** A title the database accepts (1–120 characters, trimmed). */
export function libraryTitle(title: string, fallback = "Untitled"): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  const value = trimmed === "" ? fallback : trimmed;
  return value.length > MAX_TITLE ? `${value.slice(0, MAX_TITLE - 1).trimEnd()}…` : value;
}

/** Tags the database accepts: trimmed, 1–32 characters, no control characters, unique (any case), at most 20. */
export function libraryTags(tags: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags ?? []) {
    // eslint-disable-next-line no-control-regex
    const tag = String(raw).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 32).trim();
    if (tag === "" || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
    if (result.length === 20) break;
  }
  return result;
}

/** A file name the database accepts: no slashes or control characters, no leading dot, at most 180 characters. */
export function libraryFilename(name: string, fallback = "file"): string {
  // eslint-disable-next-line no-control-regex
  let value = name.replace(/[/\\\x00-\x1f\x7f]/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (value === "") value = fallback;
  if (value.length <= 180) return value;
  const dot = value.lastIndexOf(".");
  const extension = dot > 0 && value.length - dot <= 12 ? value.slice(dot) : "";
  return `${value.slice(0, 180 - extension.length)}${extension}`;
}

/** Makes file names unique case-insensitively ("a.png", "a 2.png"), as library_item_files requires. */
export function uniqueFilenames(files: readonly LibraryUploadFile[]): LibraryUploadFile[] {
  const seen = new Set<string>();
  return files.map((file) => {
    const base = libraryFilename(file.filename);
    let candidate = base;
    for (let copy = 2; seen.has(candidate.toLowerCase()); copy += 1) {
      const dot = base.lastIndexOf(".");
      candidate = dot > 0 ? `${base.slice(0, dot)} ${copy}${base.slice(dot)}` : `${base} ${copy}`;
    }
    seen.add(candidate.toLowerCase());
    return candidate === file.filename ? file : { ...file, filename: candidate };
  });
}

function jsonLength(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export interface ProvenanceInput {
  /** What made the item: a lab export action, the platform's snapshot or its recorder. */
  via: "lab-export" | "snapshot" | "recording";
  labId: string | null;
  labTitle: string | null;
  projectId: Uuid | null;
  versionId: Uuid | null;
  /** The project had changes not yet in a version when the item was made. */
  unsavedChanges: boolean;
  exportId?: string | undefined;
}

export interface ItemMetadataInput {
  claims: LabLibraryExport["claims"];
  provenance: ProvenanceInput;
  /** The lab's generator/material/solver revisions (document.versions). */
  labVersions?: Record<string, string> | null | undefined;
  /** The lab's own metadata (copied as is, when it fits). */
  lab?: JsonObject | null | undefined;
  /** Platform facts about the file (recording metrics …). */
  extra?: JsonObject | undefined;
}

/** The item's metadata: claims verbatim, provenance, lab revisions, then the lab's metadata if it fits the budget. */
export function libraryItemMetadata(input: ItemMetadataInput): JsonObject {
  const claims: JsonObject = { evidence: input.claims.evidence, limitations: [...input.claims.limitations] };
  if (input.claims.rights !== undefined) claims.rights = input.claims.rights;
  const provenance: JsonObject = {
    via: input.provenance.via,
    labId: input.provenance.labId,
    labTitle: input.provenance.labTitle,
    projectId: input.provenance.projectId,
    versionId: input.provenance.versionId,
    unsavedChanges: input.provenance.unsavedChanges,
    createdWith: "VISCERA account platform",
  };
  if (input.provenance.exportId !== undefined) provenance.exportId = input.provenance.exportId;
  const metadata: JsonObject = { claims, provenance };
  if (input.labVersions && Object.keys(input.labVersions).length > 0) metadata.labVersions = { ...input.labVersions };
  if (input.extra) Object.assign(metadata, input.extra);
  if (input.lab && Object.keys(input.lab).length > 0) {
    const candidate: JsonObject = { ...metadata, lab: input.lab };
    if (jsonLength(candidate) <= LIBRARY_METADATA_BUDGET) return candidate;
    metadata.labMetadataOmitted = true;
  }
  return metadata;
}

/** Turns a lab export into an upload request (title and file names made valid, claims kept verbatim). */
export function exportToRequest(
  exported: LabLibraryExport,
  context: { exportId: string; labId: string | null; labTitle: string | null; projectId: Uuid | null; versionId: Uuid | null; unsavedChanges: boolean; labVersions?: Record<string, string> | null },
): LibraryUploadRequest {
  return {
    kind: exported.kind,
    title: libraryTitle(exported.title),
    description: exported.description,
    tags: exported.tags,
    labId: context.labId,
    sourceProjectId: context.projectId,
    sourceVersionId: context.versionId,
    files: uniqueFilenames(exported.files.map((file) => ({ filename: file.filename, role: file.role, blob: file.blob }))),
    thumbnail: exported.thumbnail ?? null,
    metadata: libraryItemMetadata({
      claims: exported.claims,
      provenance: {
        via: "lab-export",
        labId: context.labId,
        labTitle: context.labTitle,
        projectId: context.projectId,
        versionId: context.versionId,
        unsavedChanges: context.unsavedChanges,
        exportId: context.exportId,
      },
      labVersions: context.labVersions ?? null,
      lab: exported.metadata ?? null,
    }),
  };
}

/** Uploads the files (one at a time, so quota errors arrive in order) and creates the library item. */
export async function uploadToLibrary(
  ports: { assets: AssetPort; library: LibraryPort },
  request: LibraryUploadRequest,
  options: LibraryUploadOptions = {},
): Promise<LibraryItem> {
  if (request.files.length === 0) throw new Error("Nothing to add: the item has no files.");
  const parts: Blob[] = [...request.files.map((file) => file.blob), ...(request.thumbnail ? [request.thumbnail] : [])];
  const total = parts.reduce((sum, blob) => sum + blob.size, 0);
  const loaded = parts.map(() => 0);
  const report = () => options.onProgress?.({ loaded: loaded.reduce((sum, value) => sum + value, 0), total });
  report();
  const assetIds: Uuid[] = [];
  for (const [index, blob] of parts.entries()) {
    const asset = await ports.assets.put(blob, {
      mimeType: storableMimeType(blob.type),
      onProgress: (progress) => {
        loaded[index] = Math.min(blob.size, progress.loaded);
        report();
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    loaded[index] = blob.size;
    report();
    assetIds.push(asset.id);
  }
  const thumbnailAssetId = request.thumbnail ? (assetIds[assetIds.length - 1] ?? null) : null;
  return ports.library.create({
    kind: request.kind,
    title: libraryTitle(request.title),
    ...(request.description !== undefined ? { description: request.description.slice(0, 2000) } : {}),
    ...(request.tags !== undefined ? { tags: libraryTags(request.tags) } : {}),
    labId: request.labId,
    sourceProjectId: request.sourceProjectId,
    sourceVersionId: request.sourceVersionId,
    metadata: request.metadata,
    thumbnailAssetId,
    files: request.files.map((file, index) => ({ filename: file.filename, assetId: assetIds[index] as Uuid, role: file.role, position: index })),
  });
}
