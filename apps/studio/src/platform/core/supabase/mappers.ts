// PostgREST rows (snake_case, timestamps as "2026-10-21T18:00:00.123456+00:00", bigint columns as JSON numbers or
// numeric strings) → the camelCase records of types.ts. Every field is checked; a row of the wrong shape throws
// PlatformError("unknown") naming the field instead of leaking undefined into the UI.

import type { AssetReservation } from "../assets";
import { platformError } from "../errors";
import { isPlainObject } from "../json";
import type {
  Appearance,
  Asset,
  AssetStatus,
  DetectedBy,
  ImportedObject,
  ImportFormat,
  ImportStats,
  IsoDate,
  JsonObject,
  LibraryFile,
  LibraryFileRole,
  LibraryItem,
  LibraryKind,
  NamedAttachment,
  Profile,
  Project,
  ProjectVersion,
  SourceApp,
  Usage,
  VersionKind,
} from "../types";
import { APPEARANCES, DETECTED_BY_VALUES, IMPORT_FORMATS, LIBRARY_FILE_ROLES, LIBRARY_KINDS, SOURCE_APPS } from "../memory/rules";

export type Row = Record<string, unknown>;

function malformed(table: string, field: string): never {
  throw platformError("unknown", { detail: `unexpected ${table}.${field} from the server` });
}

export function asRow(value: unknown, table: string): Row {
  if (!isPlainObject(value)) malformed(table, "*");
  return value;
}

/** An array response as rows (anything else is an empty list only when null). */
export function asRows(value: unknown, table: string): Row[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) malformed(table, "[]");
  return value.map((row) => asRow(row, table));
}

function str(row: Row, table: string, field: string): string {
  const value = row[field];
  if (typeof value !== "string") malformed(table, field);
  return value;
}

function strOrNull(row: Row, table: string, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") malformed(table, field);
  return value;
}

function num(row: Row, table: string, field: string): number {
  const value = row[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return malformed(table, field);
}

function bool(row: Row, table: string, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") malformed(table, field);
  return value;
}

function oneOf<T extends string>(row: Row, table: string, field: string, allowed: readonly T[]): T {
  const value = row[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) malformed(table, field);
  return value as T;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Postgres timestamptz text → Date.prototype.toISOString form (UTC, milliseconds). Unparseable input is kept. */
export function normalizeTimestamp(value: string): IsoDate {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return value;
  const [, date, time, fraction, zone] = match;
  const millis = fraction ? fraction.slice(0, 4).padEnd(4, "0") : "";
  let offset = zone ?? "Z";
  if (/^[+-]\d{2}$/.test(offset)) offset = `${offset}:00`;
  else if (/^[+-]\d{4}$/.test(offset)) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const seconds = (time as string).length === 5 ? `${time}:00` : time;
  const parsed = new Date(`${date}T${seconds}${millis}${offset.toUpperCase()}`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function iso(row: Row, table: string, field: string): IsoDate {
  return normalizeTimestamp(str(row, table, field));
}

function isoOrNull(row: Row, table: string, field: string): IsoDate | null {
  const value = strOrNull(row, table, field);
  return value === null ? null : normalizeTimestamp(value);
}

function strings(row: Row, table: string, field: string): string[] {
  const value = row[field];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) malformed(table, field);
  return [...(value as string[])];
}

function jsonObject(row: Row, table: string, field: string): JsonObject {
  const value = row[field];
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) malformed(table, field);
  return value as JsonObject;
}

/**
 * assets.status values a client works with. "deleting" (being collected) and "rejected" (confirm found the wrong size)
 * rows are on their way out, so describe() leaves them out; the RPCs answer asset_busy / size_mismatch for them.
 */
export function isUsableAssetRow(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const status = (value as Row).status;
  return status === "pending" || status === "ready";
}

export function mapAsset(value: unknown): Asset {
  const row = asRow(value, "assets");
  return {
    id: str(row, "assets", "id"),
    sha256: str(row, "assets", "sha256"),
    byteSize: num(row, "assets", "byte_size"),
    mimeType: str(row, "assets", "mime_type"),
    objectPath: str(row, "assets", "object_path"),
    status: oneOf<AssetStatus>(row, "assets", "status", ["pending", "ready"]),
    createdAt: iso(row, "assets", "created_at"),
  };
}

/** reserve_asset returns a one-row table. */
export function mapReservation(value: unknown): AssetReservation {
  const row = Array.isArray(value) ? asRow(value[0], "reserve_asset") : asRow(value, "reserve_asset");
  return {
    assetId: str(row, "reserve_asset", "asset_id"),
    objectPath: str(row, "reserve_asset", "object_path"),
    status: oneOf<AssetStatus>(row, "reserve_asset", "status", ["pending", "ready"]),
  };
}

export function mapProject(value: unknown): Project {
  const row = asRow(value, "projects");
  const t = "projects";
  return {
    id: str(row, t, "id"),
    labId: str(row, t, "lab_id"),
    title: str(row, t, "title"),
    description: strOrNull(row, t, "description") ?? "",
    headVersionId: strOrNull(row, t, "head_version_id"),
    headSeq: num(row, t, "head_seq"),
    draftAssetId: strOrNull(row, t, "draft_asset_id"),
    draftStateSha256: strOrNull(row, t, "draft_state_sha256"),
    draftThumbnailAssetId: strOrNull(row, t, "draft_thumbnail_asset_id"),
    draftRev: num(row, t, "draft_rev"),
    draftSavedAt: isoOrNull(row, t, "draft_saved_at"),
    thumbnailAssetId: strOrNull(row, t, "thumbnail_asset_id"),
    favorite: bool(row, t, "favorite"),
    createdAt: iso(row, t, "created_at"),
    updatedAt: iso(row, t, "updated_at"),
    openedAt: isoOrNull(row, t, "opened_at"),
    trashedAt: isoOrNull(row, t, "trashed_at"),
  };
}

const VERSION_KINDS: readonly VersionKind[] = ["initial", "autosave", "manual", "named", "restore", "duplicate", "import"];

export function mapVersion(value: unknown): ProjectVersion {
  const row = asRow(value, "project_versions");
  const t = "project_versions";
  return {
    id: str(row, t, "id"),
    projectId: str(row, t, "project_id"),
    seq: num(row, t, "seq"),
    parentVersionId: strOrNull(row, t, "parent_version_id"),
    kind: oneOf(row, t, "kind", VERSION_KINDS),
    label: strOrNull(row, t, "label"),
    snapshotAssetId: str(row, t, "snapshot_asset_id"),
    stateSha256: str(row, t, "state_sha256"),
    thumbnailAssetId: strOrNull(row, t, "thumbnail_asset_id"),
    restoredFromVersionId: strOrNull(row, t, "restored_from_version_id"),
    labSchemaVersion: num(row, t, "lab_schema_version"),
    appBuild: strOrNull(row, t, "app_build"),
    byteSize: num(row, t, "byte_size"),
    createdAt: iso(row, t, "created_at"),
  };
}

/** commit_version / restore_version: jsonb { project, version } (DESIGN.md §15.2). */
export function mapProjectAndVersion(value: unknown, rpc: string): { project: Project; version: ProjectVersion } {
  const row = asRow(value, rpc);
  if (!isPlainObject(row.project)) malformed(rpc, "project");
  if (!isPlainObject(row.version)) malformed(rpc, "version");
  return { project: mapProject(row.project), version: mapVersion(row.version) };
}

export function mapAttachment(value: unknown): NamedAttachment {
  const row = asRow(value, "attachments");
  return { name: str(row, "attachments", "name"), assetId: str(row, "attachments", "asset_id") };
}

export function mapLibraryFile(value: unknown): LibraryFile {
  const row = asRow(value, "library_item_files");
  const t = "library_item_files";
  const file: LibraryFile = {
    filename: str(row, t, "filename"),
    assetId: str(row, t, "asset_id"),
    role: oneOf<LibraryFileRole>(row, t, "role", LIBRARY_FILE_ROLES),
    position: num(row, t, "position"),
  };
  // embedded assets(byte_size, mime_type) when the select asked for it (null when the row is not visible)
  const asset = row.assets;
  if (isPlainObject(asset)) {
    if (typeof asset.byte_size === "number" || typeof asset.byte_size === "string") file.byteSize = num(asset, "assets", "byte_size");
    if (typeof asset.mime_type === "string") file.mimeType = asset.mime_type;
  }
  return file;
}

function compareFiles(a: LibraryFile, b: LibraryFile): number {
  return a.position - b.position || (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
}

export function mapLibraryItem(value: unknown): LibraryItem {
  const row = asRow(value, "library_items");
  const t = "library_items";
  const item: LibraryItem = {
    id: str(row, t, "id"),
    kind: oneOf<LibraryKind>(row, t, "kind", LIBRARY_KINDS),
    title: str(row, t, "title"),
    description: strOrNull(row, t, "description") ?? "",
    tags: strings(row, t, "tags"),
    labId: strOrNull(row, t, "lab_id"),
    sourceProjectId: strOrNull(row, t, "source_project_id"),
    sourceVersionId: strOrNull(row, t, "source_version_id"),
    metadata: jsonObject(row, t, "metadata"),
    thumbnailAssetId: strOrNull(row, t, "thumbnail_asset_id"),
    favorite: bool(row, t, "favorite"),
    byteSize: num(row, t, "byte_size"),
    createdAt: iso(row, t, "created_at"),
    updatedAt: iso(row, t, "updated_at"),
    trashedAt: isoOrNull(row, t, "trashed_at"),
  };
  if (Array.isArray(row.library_item_files)) item.files = row.library_item_files.map(mapLibraryFile).sort(compareFiles);
  return item;
}

function statNumber(stats: Row, field: string): number {
  const value = stats[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** imported_objects.stats (stored as the client sent it) → ImportStats with defaults for missing counts. */
export function mapStats(value: unknown): ImportStats {
  const stats: Row = isPlainObject(value) ? value : {};
  const box = stats.bbox;
  const bbox =
    isPlainObject(box) && typeof box.x === "number" && typeof box.y === "number" && typeof box.z === "number" ? { x: box.x, y: box.y, z: box.z } : null;
  const result: ImportStats = {
    meshes: statNumber(stats, "meshes"),
    vertices: statNumber(stats, "vertices"),
    triangles: statNumber(stats, "triangles"),
    materials: statNumber(stats, "materials"),
    textures: statNumber(stats, "textures"),
    animations: statNumber(stats, "animations"),
    skinned: stats.skinned === true,
    bbox,
  };
  if (typeof stats.units === "string") result.units = stats.units;
  if (stats.upAxis === "Y" || stats.upAxis === "Z") result.upAxis = stats.upAxis;
  if (Array.isArray(stats.notes) && stats.notes.every((note) => typeof note === "string")) result.notes = [...(stats.notes as string[])];
  return result;
}

export function mapImport(value: unknown): ImportedObject {
  const row = asRow(value, "imported_objects");
  const t = "imported_objects";
  return {
    id: str(row, t, "id"),
    title: str(row, t, "title"),
    sourceApp: oneOf<SourceApp>(row, t, "source_app", SOURCE_APPS),
    sourceDetail: strOrNull(row, t, "source_detail"),
    detectedBy: oneOf<DetectedBy>(row, t, "detected_by", DETECTED_BY_VALUES),
    format: oneOf<ImportFormat>(row, t, "format", IMPORT_FORMATS),
    originalAssetId: str(row, t, "original_asset_id"),
    displayAssetId: strOrNull(row, t, "display_asset_id"),
    thumbnailAssetId: strOrNull(row, t, "thumbnail_asset_id"),
    stats: mapStats(row.stats),
    tags: strings(row, t, "tags"),
    favorite: bool(row, t, "favorite"),
    byteSize: num(row, t, "byte_size"),
    createdAt: iso(row, t, "created_at"),
    updatedAt: iso(row, t, "updated_at"),
    trashedAt: isoOrNull(row, t, "trashed_at"),
  };
}

export function mapProfile(value: unknown): Profile {
  const row = asRow(value, "profiles");
  const t = "profiles";
  return {
    id: str(row, t, "id"),
    username: strOrNull(row, t, "username"),
    displayName: strOrNull(row, t, "display_name"),
    avatarAssetId: strOrNull(row, t, "avatar_asset_id"),
    planId: str(row, t, "plan_id"),
    appearance: oneOf<Appearance>(row, t, "appearance", APPEARANCES),
    createdAt: iso(row, t, "created_at"),
    updatedAt: iso(row, t, "updated_at"),
  };
}

/** my_usage() jsonb. */
export function mapUsage(value: unknown): Usage {
  const row = asRow(value, "my_usage");
  const t = "my_usage";
  return {
    planId: str(row, t, "plan_id"),
    planTitle: str(row, t, "plan_title"),
    storageQuotaBytes: num(row, t, "storage_quota_bytes"),
    maxFileBytes: num(row, t, "max_file_bytes"),
    versionRetentionDays: num(row, t, "version_retention_days"),
    maxProjects: num(row, t, "max_projects"),
    usedBytes: num(row, t, "used_bytes"),
    pendingBytes: num(row, t, "pending_bytes"),
    projectCount: num(row, t, "project_count"),
    versionCount: num(row, t, "version_count"),
    libraryCount: num(row, t, "library_count"),
    importCount: num(row, t, "import_count"),
    trashCount: num(row, t, "trash_count"),
  };
}
