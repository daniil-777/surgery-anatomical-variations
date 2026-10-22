// Lab session documents ⇄ stored snapshots. A snapshot is the gzip of canonical JSON
//   { format: "viscera-lab-snapshot", version: 1, schema, labId, state, versions,
//     attachments: { name: { sha256, bytes, mime, local? } } }
// with every binary attachment stored as its own content-addressed asset (deduplicated across versions), except
// "local only" attachments a lab keeps on the device (the document's `localOnly` list): those are hashed and listed but
// never uploaded, and a restore on a device without them reports them as missingLocal (DESIGN.md §15.7).
// stateSha256 = SHA-256 of the canonical JSON of { schema, labId, state, versions, attachments: { name: sha256 } }
// (DESIGN.md §15.5): stable across browsers (gzip bytes are not), and it changes whenever the state or any attachment's
// bytes change. The versioning engine compares it to skip saves that change nothing.

import { LAB_ATTACHMENT_NAME, type LabRestoreContext, type LabSessionDocument } from "../bridge/labSession";
import { platformError } from "./errors";
import { EMPTY_SHA256, isBlobLike, isSha256Hex, sha256Hex, sha256OfBlob } from "./hash";
import { canonicalStringify, isPlainObject } from "./json";
import { ALLOWED_MIME_TYPES, PlatformError, type AllowedMimeType, type AssetPort, type JsonValue, type NamedAttachment, type SnapshotRef } from "./types";

export const SNAPSHOT_FORMAT = "viscera-lab-snapshot";
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_MIME: AllowedMimeType = "application/gzip";
/** The database limit on attachments per version (private.attachment_rows). */
export const MAX_SNAPSHOT_ATTACHMENTS = 64;
/** The free plan's per-file limit; callers pass the account's own limit when they know it. */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

const LAB_ID = /^[a-z][a-z0-9-]{1,31}$/;

export interface SnapshotAttachmentEntry {
  sha256: string;
  bytes: number;
  /** The attachment's own type, handed back on restore (it may differ from the stored asset's MIME type). */
  mime: string;
  /** Kept on the user's device, never uploaded: restoring it needs the local file again. */
  local?: true;
}

export interface EncodedAttachment {
  name: string;
  blob: Blob;
  sha256: string;
  bytes: number;
  /** The type to store the asset under (an allowed MIME type; application/octet-stream when the blob's is not). */
  mimeType: AllowedMimeType;
}

export interface EncodedSnapshot {
  /** gzip of the canonical snapshot JSON (application/gzip). */
  snapshot: Blob;
  stateSha256: string;
  /** Non-empty attachments to upload (zero-byte and local-only ones live in the manifest only). */
  attachments: EncodedAttachment[];
  /** Names of the attachments kept on the device (listed and hashed, not uploaded). */
  local: string[];
}

export interface EncodeSnapshotOptions {
  /** Per-file limit (snapshot and each uploaded attachment); defaults to the free plan's 50 MB. */
  maxFileBytes?: number;
  /** More attachments to keep on the device, besides the document's own `localOnly`: hashed, never uploaded. */
  localOnly?: readonly string[];
}

const ALLOWED = new Set<string>(ALLOWED_MIME_TYPES);

/** The MIME type to store `type` under: itself when the bucket accepts it, else application/octet-stream. */
export function storableMimeType(type: string): AllowedMimeType {
  const base = type.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED.has(base) ? (base as AllowedMimeType) : "application/octet-stream";
}

function invalid(detail: string, message: string): PlatformError {
  return platformError("invalid_input", { status: 422, detail, message });
}

function tooLarge(what: string, bytes: number, limit: number): PlatformError {
  return platformError("file_too_large", {
    status: 413,
    detail: `${what}: ${bytes} bytes; the limit is ${limit}`,
    message: `${what} is larger than your plan allows (${Math.ceil(limit / (1024 * 1024))} MB per file).`,
  });
}

function checkHeader(document: LabSessionDocument): void {
  if (typeof document.schema !== "string" || document.schema.length === 0 || document.schema.length > 200) {
    throw invalid("schema", "The lab session needs a schema name of 1 to 200 characters.");
  }
  if (typeof document.labId !== "string" || !LAB_ID.test(document.labId)) {
    throw invalid("labId", "The lab id must look like \"organ\" or \"tissue-lab\".");
  }
}

/** The document's localOnly names plus the caller's (names without an attachment are ignored). */
function localOnlyNames(document: LabSessionDocument, extra: readonly string[] | undefined): Set<string> {
  const names = new Set<string>(extra ?? []);
  const own: unknown = document.localOnly;
  if (own === undefined || own === null) return names;
  if (!Array.isArray(own) || !own.every((name) => typeof name === "string")) {
    throw invalid("localOnly", "localOnly must list attachment names.");
  }
  for (const name of own) names.add(name);
  return names;
}

function normalizeVersions(versions: unknown): Record<string, string> {
  if (versions === undefined || versions === null) return {};
  if (!isPlainObject(versions)) throw invalid("versions", "versions must map names to revision strings.");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(versions)) {
    if (typeof value !== "string") throw invalid(`versions.${key}`, `versions.${key} must be a string.`);
    result[key] = value;
  }
  return result;
}

interface PreparedAttachment {
  name: string;
  blob: Blob;
  entry: SnapshotAttachmentEntry;
}

async function prepareAttachments(attachments: unknown, maxFileBytes: number, localOnly: ReadonlySet<string> = new Set()): Promise<PreparedAttachment[]> {
  if (attachments === undefined || attachments === null) return [];
  if (!isPlainObject(attachments)) throw invalid("attachments", "attachments must map names to Blobs.");
  const names = Object.keys(attachments).sort();
  if (names.length > MAX_SNAPSHOT_ATTACHMENTS) {
    throw invalid("attachments", `A lab session can carry at most ${MAX_SNAPSHOT_ATTACHMENTS} attachments.`);
  }
  return Promise.all(
    names.map(async (name) => {
      if (!LAB_ATTACHMENT_NAME.test(name)) {
        throw invalid(`attachments.${name}`, `The attachment name "${name}" is not allowed (letters, digits, . _ -; at most 64).`);
      }
      const blob = attachments[name];
      if (!isBlobLike(blob)) throw invalid(`attachments.${name}`, `The attachment "${name}" is not a Blob.`);
      const local = localOnly.has(name);
      if (!local && blob.size > maxFileBytes) throw tooLarge(`The attachment "${name}"`, blob.size, maxFileBytes);
      const sha256 = blob.size === 0 ? EMPTY_SHA256 : await sha256OfBlob(blob);
      const entry: SnapshotAttachmentEntry = { sha256, bytes: blob.size, mime: blob.type };
      if (local) entry.local = true;
      return { name, blob, entry };
    }),
  );
}

/** What stateSha256 is computed from: attachments by their bytes' hash only. */
function hashedDocument(document: LabSessionDocument, versions: Record<string, string>, prepared: PreparedAttachment[]): Record<string, unknown> {
  const attachments: Record<string, string> = {};
  for (const item of prepared) attachments[item.name] = item.entry.sha256;
  return { schema: document.schema, labId: document.labId, state: document.state, versions, attachments };
}

/** The stored snapshot document: the manifest lists size, type and locality as well. */
function snapshotDocument(document: LabSessionDocument, versions: Record<string, string>, prepared: PreparedAttachment[]): Record<string, unknown> {
  const attachments: Record<string, SnapshotAttachmentEntry> = {};
  for (const item of prepared) attachments[item.name] = item.entry;
  return { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, schema: document.schema, labId: document.labId, state: document.state, versions, attachments };
}

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = await new Response(stream).arrayBuffer();
  return new Blob([bytes], { type: SNAPSHOT_MIME });
}

async function gunzipText(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return blob.text();
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * Validates the document (lab id, schema, JSON-safe state, attachment names/sizes), computes stateSha256 and builds the
 * gzip snapshot. Throws PlatformError invalid_input / file_too_large with a sentence fit for the UI.
 */
export async function encodeSnapshot(document: LabSessionDocument, options: EncodeSnapshotOptions = {}): Promise<EncodedSnapshot> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  checkHeader(document);
  const versions = normalizeVersions(document.versions);
  const prepared = await prepareAttachments(document.attachments, maxFileBytes, localOnlyNames(document, options.localOnly));
  const stateSha256 = await sha256Hex(canonicalStringify(hashedDocument(document, versions, prepared), { path: "session" }));
  const snapshot = await gzip(canonicalStringify(snapshotDocument(document, versions, prepared), { path: "session" }));
  if (snapshot.size > maxFileBytes) throw tooLarge("The saved state", snapshot.size, maxFileBytes);
  const attachments = prepared
    .filter((item) => item.entry.bytes > 0 && !item.entry.local)
    .map((item) => ({ name: item.name, blob: item.blob, sha256: item.entry.sha256, bytes: item.entry.bytes, mimeType: storableMimeType(item.entry.mime) }));
  return { snapshot, stateSha256, attachments, local: prepared.filter((item) => item.entry.local).map((item) => item.name) };
}

/** stateSha256 alone (no gzip): cheap change detection for a document. */
export async function snapshotStateSha256(document: LabSessionDocument): Promise<string> {
  checkHeader(document);
  const versions = normalizeVersions(document.versions);
  const prepared = await prepareAttachments(document.attachments, Number.POSITIVE_INFINITY);
  // local-only attachments count by their bytes like any other, so no option is needed here
  return sha256Hex(canonicalStringify(hashedDocument(document, versions, prepared), { path: "session" }));
}

export interface DecodedSnapshotManifest {
  schema: string;
  labId: string;
  state: JsonValue;
  versions: Record<string, string>;
  attachments: Record<string, SnapshotAttachmentEntry>;
}

function corrupt(detail: string): PlatformError {
  return platformError("invalid_input", { status: 422, detail, message: "This saved version cannot be read." });
}

/** Reads and validates a snapshot's JSON without fetching attachments. */
export async function readSnapshotManifest(blob: Blob): Promise<DecodedSnapshotManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await gunzipText(blob));
  } catch (error) {
    throw platformError("invalid_input", { status: 422, detail: "snapshot is not gzip JSON", message: "This saved version cannot be read.", cause: error });
  }
  if (!isPlainObject(parsed) || parsed.format !== SNAPSHOT_FORMAT) throw corrupt("not a viscera-lab-snapshot");
  if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version)) throw corrupt("version");
  if (parsed.version > SNAPSHOT_VERSION) {
    throw platformError("invalid_input", {
      status: 422,
      detail: `snapshot version ${parsed.version}`,
      message: "This version was saved by a newer release of VISCERA. Reload the page to open it.",
    });
  }
  if (typeof parsed.schema !== "string" || typeof parsed.labId !== "string" || !("state" in parsed)) throw corrupt("header");
  const versions = normalizeVersions(parsed.versions);
  const attachments: Record<string, SnapshotAttachmentEntry> = {};
  const rawAttachments = parsed.attachments ?? {};
  if (!isPlainObject(rawAttachments)) throw corrupt("attachments");
  for (const [name, value] of Object.entries(rawAttachments)) {
    if (!LAB_ATTACHMENT_NAME.test(name) || !isPlainObject(value)) throw corrupt(`attachment ${name}`);
    const { sha256, bytes, mime, local } = value;
    if (!isSha256Hex(sha256) || typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || typeof mime !== "string") {
      throw corrupt(`attachment ${name}`);
    }
    attachments[name] = local === true ? { sha256, bytes, mime, local: true } : { sha256, bytes, mime };
  }
  return { schema: parsed.schema, labId: parsed.labId, state: parsed.state as JsonValue, versions, attachments };
}

export interface DecodeSnapshotOptions {
  /** Re-hash every attachment against the manifest (default true). */
  verify?: boolean;
  /** Supplies a local-only attachment (e.g. the file the user picks again); null or absent leaves it out. */
  getLocalAttachment?: (name: string, entry: SnapshotAttachmentEntry) => Promise<Blob | null>;
}

export interface DecodedSnapshot {
  document: LabSessionDocument;
  /** For the lab's restore(): the local-only attachments this device could not supply (left out of the document). */
  context: LabRestoreContext;
}

/**
 * Snapshot → lab session document and restore context. getAttachment(name, entry) returns the bytes of each non-empty
 * attachment (the caller maps names to assets); sizes and, by default, SHA-256 are checked against the manifest, and
 * each Blob is handed back with the type it was saved with. Local-only attachments come from getLocalAttachment; the
 * ones it cannot supply are listed in context.missingLocal, and the document's localOnly names every local one.
 */
export async function decodeSnapshotWithContext(
  blob: Blob,
  getAttachment: (name: string, entry: SnapshotAttachmentEntry) => Promise<Blob>,
  options: DecodeSnapshotOptions = {},
): Promise<DecodedSnapshot> {
  const manifest = await readSnapshotManifest(blob);
  const verify = options.verify ?? true;
  const names = Object.keys(manifest.attachments).sort();
  const restored = await Promise.all(
    names.map(async (name): Promise<[string, Blob] | null> => {
      const entry = manifest.attachments[name] as SnapshotAttachmentEntry;
      if (entry.bytes === 0) return [name, new Blob([], { type: entry.mime })];
      let bytes: Blob | null;
      if (entry.local) {
        bytes = options.getLocalAttachment ? await options.getLocalAttachment(name, entry) : null;
        if (bytes === null) return null;
      } else {
        bytes = await getAttachment(name, entry);
      }
      if (!isBlobLike(bytes) || bytes.size !== entry.bytes) throw corrupt(`attachment ${name} has the wrong size`);
      if (verify && (await sha256Hex(bytes)) !== entry.sha256) throw corrupt(`attachment ${name} does not match its checksum`);
      return [name, bytes.type === entry.mime ? bytes : bytes.slice(0, bytes.size, entry.mime)];
    }),
  );
  const present = restored.filter((entry): entry is [string, Blob] => entry !== null);
  const document: LabSessionDocument = { schema: manifest.schema, labId: manifest.labId, state: manifest.state };
  if (present.length > 0) document.attachments = Object.fromEntries(present);
  const local = names.filter((name) => manifest.attachments[name]?.local === true);
  if (local.length > 0) document.localOnly = local;
  if (Object.keys(manifest.versions).length > 0) document.versions = manifest.versions;
  const missingLocal = names.flatMap((name, index) =>
    restored[index] === null ? [{ name, sha256: (manifest.attachments[name] as SnapshotAttachmentEntry).sha256 }] : [],
  );
  return { document, context: { missingLocal } };
}

/** decodeSnapshotWithContext without the context. */
export async function decodeSnapshot(
  blob: Blob,
  getAttachment: (name: string, entry: SnapshotAttachmentEntry) => Promise<Blob>,
  options: DecodeSnapshotOptions = {},
): Promise<LabSessionDocument> {
  return (await decodeSnapshotWithContext(blob, getAttachment, options)).document;
}

export interface UploadSnapshotOptions {
  /** A thumbnail to store with the version (PNG/JPEG/WebP). */
  thumbnail?: Blob | null;
  labSchemaVersion?: number;
  appBuild?: string | null;
  signal?: AbortSignal;
  /** Aggregate progress over the snapshot, its attachments and the thumbnail. */
  onProgress?: (progress: { loaded: number; total: number }) => void;
}

/** The integer schema revision stored with a version: the trailing "/<n>" of the lab's schema id, else 1. */
export function labSchemaVersionOf(schema: string): number {
  const match = /\/(\d{1,7})$/.exec(schema);
  const value = match ? Number(match[1]) : 1;
  return Math.min(Math.max(Number.isInteger(value) ? value : 1, 1), 1_000_000);
}

export interface SnapshotStoreOptions {
  /** The account's per-file limit (Usage.maxFileBytes); defaults to the free plan's. */
  maxFileBytes?: () => number;
  /** Stored with every version (e.g. the site's build id); null when unknown. */
  appBuild?: string | null;
}

/** Where a stored snapshot lives (a version's or a draft's snapshot asset and its named attachments). */
export interface StoredSnapshotRef {
  snapshotAssetId: string;
  attachments: NamedAttachment[];
}

export interface SnapshotLoadOptions {
  signal: AbortSignal;
  /** Supplies a local-only attachment on this device (e.g. a file the user picks again); null when it cannot. */
  getLocalAttachment?: (name: string, entry: SnapshotAttachmentEntry) => Promise<Blob | null>;
}

/**
 * Documents ⇄ assets for the versioning engine (structurally its SnapshotStore port): save() encodes, uploads and
 * returns the SnapshotRef that create/saveDraft/commit take; load() downloads, verifies and decodes; loadWithContext()
 * also returns the restore context (local-only attachments missing on this device).
 */
export function createSnapshotStore(
  assets: AssetPort,
  options: SnapshotStoreOptions = {},
): {
  save(document: LabSessionDocument, saveOptions: { thumbnail: Blob | null; signal: AbortSignal; localOnly?: readonly string[] }): Promise<SnapshotRef>;
  load(snapshot: StoredSnapshotRef, loadOptions: SnapshotLoadOptions): Promise<LabSessionDocument>;
  loadWithContext(snapshot: StoredSnapshotRef, loadOptions: SnapshotLoadOptions): Promise<DecodedSnapshot>;
} {
  async function loadWithContext(snapshot: StoredSnapshotRef, loadOptions: SnapshotLoadOptions): Promise<DecodedSnapshot> {
    const blob = await assets.get(snapshot.snapshotAssetId, { signal: loadOptions.signal });
    const byName = new Map(snapshot.attachments.map((attachment) => [attachment.name, attachment.assetId]));
    const decodeOptions: DecodeSnapshotOptions = {};
    if (loadOptions.getLocalAttachment) decodeOptions.getLocalAttachment = loadOptions.getLocalAttachment;
    return decodeSnapshotWithContext(
      blob,
      async (name) => {
        const assetId = byName.get(name);
        if (!assetId) throw corrupt(`attachment ${name} is not stored with this version`);
        return assets.get(assetId, { signal: loadOptions.signal });
      },
      decodeOptions,
    );
  }

  return {
    async save(document, saveOptions) {
      const encodeOptions: EncodeSnapshotOptions = {};
      if (options.maxFileBytes) encodeOptions.maxFileBytes = options.maxFileBytes();
      if (saveOptions.localOnly) encodeOptions.localOnly = saveOptions.localOnly;
      const encoded = await encodeSnapshot(document, encodeOptions);
      return uploadEncodedSnapshot(assets, encoded, {
        thumbnail: saveOptions.thumbnail,
        labSchemaVersion: labSchemaVersionOf(document.schema),
        appBuild: options.appBuild ?? null,
        signal: saveOptions.signal,
      });
    },
    async load(snapshot, loadOptions) {
      return (await loadWithContext(snapshot, loadOptions)).document;
    },
    loadWithContext,
  };
}

/** Uploads an encoded snapshot (snapshot, attachments, thumbnail) and returns the reference create/save/commit take. */
export async function uploadEncodedSnapshot(assets: AssetPort, encoded: EncodedSnapshot, options: UploadSnapshotOptions = {}): Promise<SnapshotRef> {
  const parts: Array<{ blob: Blob; mimeType: AllowedMimeType; sha256?: string }> = [
    { blob: encoded.snapshot, mimeType: SNAPSHOT_MIME },
    ...encoded.attachments.map((item) => ({ blob: item.blob, mimeType: item.mimeType, sha256: item.sha256 })),
  ];
  const thumbnail = options.thumbnail ?? null;
  if (thumbnail) parts.push({ blob: thumbnail, mimeType: storableMimeType(thumbnail.type) });
  const total = parts.reduce((sum, part) => sum + part.blob.size, 0);
  const loaded = parts.map(() => 0);
  const report = () => options.onProgress?.({ loaded: loaded.reduce((sum, value) => sum + value, 0), total });
  // sequential: one upload at a time keeps the order of quota errors predictable and the connection free for the lab
  const assetIds: string[] = [];
  for (const [index, part] of parts.entries()) {
    const putOptions: Parameters<AssetPort["put"]>[1] = {
      mimeType: part.mimeType,
      onProgress: (progress) => {
        loaded[index] = progress.loaded;
        report();
      },
    };
    if (part.sha256 !== undefined) putOptions.sha256 = part.sha256;
    if (options.signal) putOptions.signal = options.signal;
    const asset = await assets.put(part.blob, putOptions);
    loaded[index] = part.blob.size;
    report();
    assetIds.push(asset.id);
  }
  const attachments: NamedAttachment[] = encoded.attachments.map((item, index) => ({ name: item.name, assetId: assetIds[index + 1] as string }));
  return {
    snapshotAssetId: assetIds[0] as string,
    stateSha256: encoded.stateSha256,
    thumbnailAssetId: thumbnail ? (assetIds[assetIds.length - 1] as string) : null,
    attachments,
    labSchemaVersion: options.labSchemaVersion ?? 1,
    appBuild: options.appBuild ?? null,
  };
}
