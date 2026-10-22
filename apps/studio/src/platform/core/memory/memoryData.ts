// The memory twin's data side: the Storage bucket + reserve/confirm (an AssetTransport), projects with drafts and
// versions, the library, imported objects and the account — each operation restating its SQL function in
// supabase/migrations step by step, in the same order of checks, with the same error codes, statuses and details.
// Every write runs in MemoryStore.mutate (atomic, like the function's transaction).

import type { AssetReservation, AssetTransport, TransportUploadOptions } from "../assets";
import { isAssetBusy, platformError, throwIfAborted } from "../errors";
import { toJsonValue } from "../json";
import type {
  AccountPort,
  Asset,
  CommitKind,
  ImportedObject,
  ImportedObjectInput,
  ImportListQuery,
  ImportPatch,
  ImportPort,
  ImportStats,
  JsonObject,
  LibraryFile,
  LibraryItem,
  LibraryItemInput,
  LibraryListQuery,
  LibraryPatch,
  LibraryPort,
  NamedAttachment,
  Plan,
  PlatformErrorCode,
  Profile,
  ProfilePatch,
  Project,
  ProjectListQuery,
  ProjectPatch,
  ProjectPort,
  ProjectVersion,
  SnapshotRef,
  Usage,
  Uuid,
} from "../types";
import type { MemoryAuth } from "./memoryAuth";
import type { MemoryAssetRow, MemoryImportRow, MemoryLibraryRow, MemoryProjectRow, MemoryState, MemoryStore, MemoryVersionRow } from "./memoryStore";
import {
  APPEARANCES,
  ATTACHMENT_NAME_PATTERN,
  btrim,
  BUCKET_FILE_SIZE_LIMIT,
  charLength,
  COMMIT_KINDS,
  DETECTED_BY_VALUES,
  ilikeContainsPattern,
  ilikeMatches,
  IMPORT_FORMATS,
  isAllowedMime,
  isUuid,
  isValidLibraryFilename,
  isValidTitle,
  isValidUsername,
  jsonbTextLength,
  LAB_ID_PATTERN,
  LIBRARY_FILE_ROLES,
  LIBRARY_KINDS,
  MAX_ATTACHMENTS,
  MAX_DESCRIPTION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_IMPORTED_OBJECTS,
  MAX_JSON_METADATA_BYTES,
  MAX_LIBRARY_FILES,
  MAX_LIBRARY_ITEMS,
  MAX_PENDING_ASSETS,
  MAX_SOURCE_DETAIL_LENGTH,
  MAX_VERSIONS_PER_PROJECT,
  normalizeTags,
  normalizeUsername,
  SHA256_PATTERN,
  SOURCE_APPS,
  validTags,
} from "./rules";

const DEFAULT_ROW_LIMIT = 1000;
/** A pending reservation counts as an upload in progress for an hour after it was made or renewed. */
const UPLOAD_SLOT_WINDOW_MS = 3600 * 1000;

function raise(code: PlatformErrorCode, status: number, detail?: string): never {
  throw platformError(code, { status, detail: detail ?? null });
}

/** A uuid parameter: PostgREST rejects a malformed one with 22P02 before the function runs. */
function uuidParam(value: unknown, field: string): Uuid {
  if (!isUuid(value)) raise("invalid_input", 400, field);
  return value.toLowerCase();
}

function optionalUuidParam(value: unknown, field: string): Uuid | null {
  return value === null || value === undefined ? null : uuidParam(value, field);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ORDER BY <timestamp> DESC NULLS LAST. */
function descending(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

/** Rows a client may see: deleting and rejected rows are on their way out (the transports leave them out). */
function isVisibleAsset(row: MemoryAssetRow): boolean {
  return row.status === "pending" || row.status === "ready";
}

function toAsset(row: MemoryAssetRow): Asset {
  const status = row.status === "ready" ? "ready" : "pending";
  return { id: row.id, sha256: row.sha256, byteSize: row.byteSize, mimeType: row.mimeType, objectPath: row.objectPath, status, createdAt: row.createdAt };
}

function toProject(row: MemoryProjectRow): Project {
  const { ownerId: _owner, draftLabSchemaVersion: _schema, draftAppBuild: _build, ...project } = row;
  return { ...project };
}

function toVersion(row: MemoryVersionRow): ProjectVersion {
  const { ownerId: _owner, ...version } = row;
  return { ...version };
}

function toImport(row: MemoryImportRow): ImportedObject {
  const { ownerId: _owner, ...object } = row;
  return { ...object, tags: [...object.tags], stats: structuredClone(object.stats) };
}

function planOf(state: MemoryState, uid: Uuid): Plan {
  const profile = state.profiles.find((candidate) => candidate.id === uid);
  const plan = profile ? state.plans.find((candidate) => candidate.id === profile.planId) : undefined;
  if (!plan) raise("not_found", 404, "profile");
  return plan;
}

/** private.ready_asset_size: 0 for null; the caller's ready asset's size; not_found / asset_busy / asset_not_ready otherwise. */
function readyAssetSize(state: MemoryState, uid: Uuid, assetId: Uuid | null, field: string): number {
  if (assetId === null) return 0;
  const asset = state.assets.find((candidate) => candidate.id === assetId && candidate.ownerId === uid);
  if (!asset) raise("not_found", 404, field);
  // being collected: the client stores the bytes again and refers to the new asset
  if (asset.status === "deleting") raise("asset_busy", 409, field);
  if (asset.status !== "ready") raise("asset_not_ready", 409, field);
  return asset.byteSize;
}

/** Sum of the distinct assets' sizes (each asset counted once, as the SQL `a.id in (…)` does). */
function distinctBytes(state: MemoryState, assetIds: ReadonlyArray<Uuid | null>): number {
  const ids = new Set(assetIds.filter((id): id is Uuid => id !== null));
  return state.assets.reduce((sum, asset) => (ids.has(asset.id) ? sum + asset.byteSize : sum), 0);
}

interface AttachmentRow {
  name: string;
  assetId: Uuid;
}

/** private.attachment_rows. */
function attachmentRows(state: MemoryState, uid: Uuid, attachments: unknown): AttachmentRow[] {
  if (attachments === null || attachments === undefined) return [];
  if (!Array.isArray(attachments)) raise("invalid_input", 422, "attachments must be an array");
  if (attachments.length > MAX_ATTACHMENTS) raise("invalid_input", 422, "at most 64 attachments");
  const names = new Set<string>();
  const rows: AttachmentRow[] = [];
  for (const item of attachments as unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) raise("invalid_input", 422, "attachment must be an object");
    const { name, assetId } = item as Partial<NamedAttachment>;
    if (typeof name !== "string" || !ATTACHMENT_NAME_PATTERN.test(name)) raise("invalid_input", 422, "attachment name");
    if (names.has(name)) raise("invalid_input", 422, `duplicate attachment name ${name}`);
    if (!isUuid(assetId)) raise("invalid_input", 422, "attachment asset_id");
    names.add(name);
    const id = assetId.toLowerCase();
    readyAssetSize(state, uid, id, `attachment ${name}`);
    rows.push({ name, assetId: id });
  }
  return rows;
}

function checkSha(value: unknown, field: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) raise("invalid_input", 422, field);
}

function checkSchemaVersion(value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000) raise("invalid_input", 422, "lab_schema_version");
}

function checkAppBuild(value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || charLength(value) < 1 || charLength(value) > 64) raise("invalid_input", 422, "app_build");
}

function cleanLabel(label: string | null | undefined): string | null {
  // nullif(btrim(coalesce(p_label, '')), ''), after the client's trim
  const value = btrim((label ?? "").trim());
  return value === "" ? null : value;
}

// Storage + reserve/confirm ------------------------------------------------------------------------------------------

export class MemoryTransport implements AssetTransport {
  private readonly objectUrls = new Map<string, string>();

  constructor(
    private readonly store: MemoryStore,
    private readonly auth: MemoryAuth,
    private readonly delay: () => Promise<void>,
  ) {}

  async reserve(input: { sha256: string; byteSize: number; mimeType: string }, signal?: AbortSignal): Promise<AssetReservation> {
    await this.delay();
    throwIfAborted(signal);
    try {
      return this.reserveRow(input);
    } catch (error) {
      if (isAssetBusy(error)) await noteBusyAnswer(this.store);
      throw error;
    }
  }

  /** private.require_upload_slot: at most 8 pending reservations made or renewed within the last hour. */
  private requireUploadSlot(state: MemoryState, uid: Uuid): void {
    const since = this.store.now() - UPLOAD_SLOT_WINDOW_MS;
    const inProgress = state.assets.filter((asset) => asset.ownerId === uid && asset.status === "pending" && Date.parse(asset.lastUsedAt) > since).length;
    if (inProgress >= MAX_PENDING_ASSETS) raise("limit_reached", 403, `at most ${MAX_PENDING_ASSETS} uploads in progress per account`);
  }

  private reserveRow(input: { sha256: string; byteSize: number; mimeType: string }): AssetReservation {
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      if (!SHA256_PATTERN.test(input.sha256)) raise("invalid_input", 422, "sha256");
      if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) raise("invalid_input", 422, "byte_size");
      // "image/png; charset=binary" is image/png (DESIGN.md §15.4)
      const mimeType = btrim(input.mimeType.split(";")[0] ?? "");
      if (!isAllowedMime(mimeType)) raise("invalid_input", 422, "mime_type");
      const existing = state.assets.find((asset) => asset.ownerId === uid && asset.sha256 === input.sha256);
      if (existing) {
        if (existing.byteSize !== input.byteSize) raise("invalid_input", 422, "byte_size differs from the stored file with this sha256");
        // the old copy is being removed this moment (DESIGN.md §15.3); once its row is gone a reservation starts afresh
        if (existing.status === "deleting") raise("asset_busy", 409, "being collected");
        if (existing.status !== "rejected") {
          // renewing a reservation that stopped counting as in progress takes a slot again
          if (existing.status === "pending" && Date.parse(existing.lastUsedAt) <= this.store.now() - UPLOAD_SLOT_WINDOW_MS) this.requireUploadSlot(state, uid);
          existing.lastUsedAt = this.store.timestamp();
          return { assetId: existing.id, objectPath: existing.objectPath, status: existing.status === "ready" ? "ready" : "pending" };
        }
      }
      const plan = planOf(state, uid);
      if (input.byteSize > plan.maxFileBytes) raise("file_too_large", 413, `${input.byteSize} bytes; the limit is ${plan.maxFileBytes}`);
      if (!existing) {
        // every row counts until maintenance drops it: pending, ready, rejected and deleting alike (DESIGN.md §15.4)
        const used = state.assets.reduce((sum, asset) => (asset.ownerId === uid ? sum + asset.byteSize : sum), 0);
        if (used + input.byteSize > plan.storageQuotaBytes) raise("quota_exceeded", 413, `${used} of ${plan.storageQuotaBytes} bytes used`);
      }
      this.requireUploadSlot(state, uid);
      if (existing) {
        // a rejected upload is reserved again (its bytes already count): the client stores them once more
        existing.status = "pending";
        existing.mimeType = mimeType;
        existing.lastUsedAt = this.store.timestamp();
        return { assetId: existing.id, objectPath: existing.objectPath, status: "pending" };
      }
      const now = this.store.timestamp();
      const row: MemoryAssetRow = {
        id: this.store.newId(),
        ownerId: uid,
        sha256: input.sha256,
        byteSize: input.byteSize,
        mimeType,
        objectPath: `${uid}/${input.sha256.slice(0, 2)}/${input.sha256}`,
        status: "pending",
        createdAt: now,
        lastUsedAt: now,
        readyAt: null,
      };
      state.assets.push(row);
      return { assetId: row.id, objectPath: row.objectPath, status: "pending" };
    });
  }

  /** The bucket's rules: size and MIME limits, and the policies "upload/replace reserved objects" (own folder, own
   *  pending reservation; upsert only while pending). */
  private async storeObject(objectPath: string, blob: Blob, options: TransportUploadOptions, chunked: boolean): Promise<void> {
    await this.delay();
    throwIfAborted(options.signal);
    const uid = this.auth.requireUid();
    if (blob.size > BUCKET_FILE_SIZE_LIMIT) throw platformError("file_too_large", { status: 413, detail: "The object exceeded the maximum allowed size" });
    if (!isAllowedMime(options.mimeType)) throw platformError("invalid_input", { status: 415, detail: `mime type ${options.mimeType} is not supported` });
    const allowed =
      objectPath.split("/")[0] === uid &&
      this.store.state.assets.some((asset) => asset.objectPath === objectPath && asset.ownerId === uid && asset.status === "pending");
    if (!allowed) throw platformError("unknown", { status: 403, detail: "new row violates row-level security policy" });
    if (chunked) {
      const chunk = 6 * 1024 * 1024;
      for (let loaded = Math.min(chunk, blob.size); loaded < blob.size; loaded += chunk) {
        throwIfAborted(options.signal);
        options.onProgress?.(loaded);
      }
    }
    await this.store.putObject(objectPath, blob);
    this.objectUrls.delete(objectPath);
    this.store.mutate((state) => {
      state.objects = state.objects.filter((object) => object.path !== objectPath);
      state.objects.push({ path: objectPath, byteSize: blob.size, mimeType: options.mimeType, createdAt: this.store.timestamp() });
    });
    options.onProgress?.(blob.size);
  }

  uploadStandard(objectPath: string, blob: Blob, options: TransportUploadOptions): Promise<void> {
    return this.storeObject(objectPath, blob, options, false);
  }

  uploadResumable(objectPath: string, blob: Blob, options: TransportUploadOptions): Promise<void> {
    return this.storeObject(objectPath, blob, options, true);
  }

  async confirm(assetId: Uuid, signal?: AbortSignal): Promise<Asset> {
    await this.delay();
    throwIfAborted(signal);
    const outcome = this.store.mutate((state): Asset | { rejected: string } => {
      const uid = this.auth.requireUid(state);
      const id = uuidParam(assetId, "p_asset_id");
      const asset = state.assets.find((candidate) => candidate.id === id && candidate.ownerId === uid);
      if (!asset) raise("not_found", 404, "asset");
      if (asset.status === "ready") return toAsset(asset);
      if (asset.status === "deleting") raise("asset_busy", 409, "being collected");
      if (asset.status === "rejected") raise("size_mismatch", 409, "rejected: reserve the file again and upload it once more");
      const object = state.objects.find((candidate) => candidate.path === asset.objectPath);
      if (!object) raise("upload_missing", 409, asset.objectPath);
      if (object.byteSize !== asset.byteSize) {
        // private.error_response: the mark is kept (committed) and the answer is still 409 size_mismatch
        asset.status = "rejected";
        return { rejected: `stored ${object.byteSize} bytes, reserved ${asset.byteSize}` };
      }
      // the grace before an unreferenced file is collected starts now
      const now = this.store.timestamp();
      asset.status = "ready";
      asset.readyAt = now;
      asset.lastUsedAt = now;
      return toAsset(asset);
    });
    if ("rejected" in outcome) throw platformError("size_mismatch", { status: 409, detail: outcome.rejected });
    return outcome;
  }

  async describe(assetIds: Uuid[]): Promise<Asset[]> {
    await this.delay();
    const uid = this.auth.requireUid();
    const wanted = new Set(assetIds.filter(isUuid).map((id) => id.toLowerCase()));
    return this.store.state.assets.filter((asset) => asset.ownerId === uid && wanted.has(asset.id) && isVisibleAsset(asset)).map(toAsset);
  }

  private async objectUrl(path: string, blob: Blob): Promise<string> {
    const known = this.objectUrls.get(path);
    if (known) return known;
    let url: string;
    if (typeof URL.createObjectURL === "function") {
      url = URL.createObjectURL(blob);
    } else {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      url = `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
    }
    this.objectUrls.set(path, url);
    return url;
  }

  async signedUrls(objectPaths: string[], _expiresInSeconds: number): Promise<Array<string | null>> {
    await this.delay();
    const uid = this.auth.requireUid();
    return Promise.all(
      objectPaths.map(async (path) => {
        const object = this.store.state.objects.find((candidate) => candidate.path === path);
        if (path.split("/")[0] !== uid || !object) return null;
        const blob = await this.store.getObject(path);
        return blob ? this.objectUrl(path, blob.slice(0, blob.size, object.mimeType)) : null;
      }),
    );
  }

  async download(objectPath: string, signal?: AbortSignal): Promise<Blob> {
    await this.delay();
    throwIfAborted(signal);
    const uid = this.auth.requireUid();
    const object = this.store.state.objects.find((candidate) => candidate.path === objectPath);
    const blob = object && objectPath.split("/")[0] === uid ? await this.store.getObject(objectPath) : null;
    if (!object || !blob) throw platformError("not_found", { status: 404, detail: "Object not found" });
    return blob.slice(0, blob.size, object.mimeType);
  }

  /** Account deletion: forget object URLs of removed objects. */
  forget(paths: readonly string[]): void {
    for (const path of paths) {
      const url = this.objectUrls.get(path);
      if (url && url.startsWith("blob:") && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
      this.objectUrls.delete(path);
    }
  }
}

// Collection (the maintenance job, simulated) ------------------------------------------------------------------------

/** private.asset_is_referenced: a row of any table still points at the asset. */
export function assetIsReferenced(state: MemoryState, assetId: Uuid): boolean {
  return (
    state.versions.some((version) => version.snapshotAssetId === assetId || version.thumbnailAssetId === assetId) ||
    state.versionAssets.some((row) => row.assetId === assetId) ||
    state.draftAssets.some((row) => row.assetId === assetId) ||
    state.projects.some((project) => project.draftAssetId === assetId || project.draftThumbnailAssetId === assetId || project.thumbnailAssetId === assetId) ||
    state.libraryItems.some((item) => item.thumbnailAssetId === assetId) ||
    state.libraryFiles.some((row) => row.assetId === assetId) ||
    state.imports.some((object) => object.originalAssetId === assetId || object.displayAssetId === assetId || object.thumbnailAssetId === assetId) ||
    state.profiles.some((profile) => profile.avatarAssetId === assetId)
  );
}

/**
 * The first phase of collecting orphans (maintenance_forget_assets, DESIGN.md §15.3) for the given assets, without its
 * grace periods: the unreferenced ones become "deleting" (rows already deleting are returned again), and reserve_asset,
 * confirm_asset and every reference answer asset_busy until the second phase. Returns the ids being collected.
 */
export function markAssetsDeleting(store: MemoryStore, assetIds: readonly Uuid[]): Uuid[] {
  const wanted = new Set(assetIds.filter(isUuid).map((id) => id.toLowerCase()));
  return store.mutate((state) => {
    const marked: Uuid[] = [];
    for (const asset of state.assets) {
      if (!wanted.has(asset.id) || assetIsReferenced(state, asset.id)) continue;
      asset.status = "deleting";
      marked.push(asset.id);
    }
    return marked;
  });
}

/**
 * The second phase: the maintenance function removes the objects of "deleting" assets through the Storage API, then
 * maintenance_finish_assets drops the rows still deleting and unreferenced. Returns the ids dropped.
 */
export async function finishAssetCollection(store: MemoryStore): Promise<Uuid[]> {
  store.collectionFinishesAfterBusyAnswers = null;
  const doomed = store.state.assets.filter((asset) => asset.status === "deleting");
  const paths = new Set(doomed.map((asset) => asset.objectPath));
  await store.deleteObjects([...paths]);
  return store.mutate((state) => {
    state.objects = state.objects.filter((object) => !paths.has(object.path));
    const dropped = new Set(doomed.filter((asset) => !assetIsReferenced(state, asset.id)).map((asset) => asset.id));
    state.assets = state.assets.filter((asset) => !(asset.status === "deleting" && dropped.has(asset.id)));
    return [...dropped];
  });
}

/** A client was answered asset_busy: a simulated maintenance run set to finish after that many answers does so now. */
async function noteBusyAnswer(store: MemoryStore): Promise<void> {
  const left = store.collectionFinishesAfterBusyAnswers;
  if (left === null) return;
  if (left > 1) {
    store.collectionFinishesAfterBusyAnswers = left - 1;
    return;
  }
  await finishAssetCollection(store);
}

// Projects -----------------------------------------------------------------------------------------------------------

function lockOwnProject(state: MemoryState, uid: Uuid, projectId: unknown): MemoryProjectRow {
  const id = uuidParam(projectId, "p_project_id");
  const project = state.projects.find((candidate) => candidate.id === id && candidate.ownerId === uid);
  if (!project) raise("not_found", 404, "project");
  if (project.trashedAt !== null) raise("project_trashed", 409, "restore the project from the trash first");
  return project;
}

function requireHead(project: MemoryProjectRow, expected: Uuid | null): void {
  const wanted = expected === null ? null : expected.toLowerCase();
  if (project.headVersionId !== wanted) {
    raise("version_conflict", 409, JSON.stringify({ head_version_id: project.headVersionId, head_seq: project.headSeq }));
  }
}

/** The draft revision the caller saw (save_draft, discard_draft, commit_version, restore_version). */
function requireDraftRev(project: MemoryProjectRow, expected: unknown): void {
  if (expected !== project.draftRev) raise("draft_conflict", 409, JSON.stringify({ draft_rev: project.draftRev }));
}

/** private.clear_draft: drops the working copy and moves draft_rev on by one (also when there was no draft). */
function clearDraft(state: MemoryState, project: MemoryProjectRow): void {
  state.draftAssets = state.draftAssets.filter((row) => row.parentId !== project.id);
  project.draftAssetId = null;
  project.draftStateSha256 = null;
  project.draftThumbnailAssetId = null;
  project.draftLabSchemaVersion = null;
  project.draftAppBuild = null;
  project.draftSavedAt = null;
  project.draftRev += 1;
}

/** private.require_version_room: at most 1 000 versions per project, `needed` being how many the caller adds. */
function requireVersionRoom(state: MemoryState, projectId: Uuid, needed = 1): void {
  if (state.versions.filter((version) => version.projectId === projectId).length + needed > MAX_VERSIONS_PER_PROJECT) {
    raise("limit_reached", 403, `at most ${MAX_VERSIONS_PER_PROJECT} versions per project`);
  }
}

function countActiveProjects(state: MemoryState, uid: Uuid): number {
  return state.projects.filter((project) => project.ownerId === uid && project.trashedAt === null).length;
}

export class MemoryProjects implements ProjectPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly auth: MemoryAuth,
    private readonly delay: () => Promise<void>,
  ) {}

  private attachVersionAssets(state: MemoryState, uid: Uuid, version: MemoryVersionRow, attachments: unknown): void {
    const rows = attachmentRows(state, uid, attachments);
    for (const row of rows) state.versionAssets.push({ parentId: version.id, ownerId: uid, name: row.name, assetId: row.assetId });
    version.byteSize = distinctBytes(state, [version.snapshotAssetId, ...rows.map((row) => row.assetId)]);
  }

  private copyVersionAssets(state: MemoryState, uid: Uuid, from: Uuid, to: Uuid): void {
    const rows = state.versionAssets.filter((row) => row.parentId === from);
    for (const row of rows) state.versionAssets.push({ parentId: to, ownerId: uid, name: row.name, assetId: row.assetId });
  }

  async list(query: ProjectListQuery = {}): Promise<Project[]> {
    await this.delay();
    const uid = this.auth.requireUid();
    const search = query.search?.trim();
    const pattern = search ? ilikeContainsPattern(search) : null;
    const rows = this.store.state.projects.filter(
      (project) =>
        project.ownerId === uid &&
        (query.trashed === true ? project.trashedAt !== null : project.trashedAt === null) &&
        (query.labId === undefined || project.labId === query.labId) &&
        (query.favorite === undefined || project.favorite === query.favorite) &&
        (pattern === null || ilikeMatches(project.title, pattern)),
    );
    const order = query.orderBy ?? "updated";
    rows.sort((a, b) => {
      const primary =
        order === "title"
          ? compareText(a.title, b.title)
          : order === "created"
            ? descending(a.createdAt, b.createdAt)
            : order === "opened"
              ? descending(a.openedAt, b.openedAt)
              : descending(a.updatedAt, b.updatedAt);
      return primary !== 0 ? primary : compareText(a.id, b.id);
    });
    return rows.slice(0, query.limit ?? DEFAULT_ROW_LIMIT).map(toProject);
  }

  async get(projectId: Uuid): Promise<Project> {
    await this.delay();
    const uid = this.auth.requireUid();
    const id = isUuid(projectId) ? projectId.toLowerCase() : null;
    const project = this.store.state.projects.find((candidate) => candidate.id === id && candidate.ownerId === uid);
    if (!project) raise("not_found", 404, "project");
    return toProject(project);
  }

  async create(input: { labId: string; title: string; description?: string } & SnapshotRef): Promise<Project> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const snapshotAssetId = optionalUuidParam(input.snapshotAssetId, "p_snapshot_asset_id");
      const thumbnailAssetId = optionalUuidParam(input.thumbnailAssetId, "p_thumbnail_asset_id");
      const title = btrim(input.title.trim());
      const description = input.description ?? "";
      if (typeof input.labId !== "string" || !LAB_ID_PATTERN.test(input.labId)) raise("invalid_input", 422, "lab_id");
      if (charLength(title) < 1 || charLength(title) > 120) raise("invalid_input", 422, "title");
      if (charLength(description) > MAX_DESCRIPTION_LENGTH) raise("invalid_input", 422, "description");
      checkSha(input.stateSha256, "state_sha256");
      if (snapshotAssetId === null) raise("invalid_input", 422, "snapshot_asset_id");
      checkSchemaVersion(input.labSchemaVersion);
      checkAppBuild(input.appBuild);
      const plan = planOf(state, uid);
      if (countActiveProjects(state, uid) >= plan.maxProjects) raise("limit_reached", 403, `at most ${plan.maxProjects} projects on this plan`);
      readyAssetSize(state, uid, snapshotAssetId, "snapshot_asset_id");
      readyAssetSize(state, uid, thumbnailAssetId, "thumbnail_asset_id");
      const now = this.store.timestamp();
      const project: MemoryProjectRow = {
        id: this.store.newId(),
        ownerId: uid,
        labId: input.labId,
        title,
        description,
        headVersionId: null,
        headSeq: 0,
        draftAssetId: null,
        draftStateSha256: null,
        draftThumbnailAssetId: null,
        draftRev: 0,
        draftSavedAt: null,
        thumbnailAssetId,
        favorite: false,
        createdAt: now,
        updatedAt: now,
        openedAt: null,
        trashedAt: null,
      };
      state.projects.push(project);
      const version: MemoryVersionRow = {
        id: this.store.newId(),
        projectId: project.id,
        ownerId: uid,
        seq: 1,
        parentVersionId: null,
        kind: "initial",
        label: null,
        snapshotAssetId,
        stateSha256: input.stateSha256,
        thumbnailAssetId,
        restoredFromVersionId: null,
        labSchemaVersion: input.labSchemaVersion,
        appBuild: input.appBuild ?? null,
        byteSize: 0,
        createdAt: now,
      };
      state.versions.push(version);
      this.attachVersionAssets(state, uid, version, input.attachments);
      project.headVersionId = version.id;
      project.headSeq = 1;
      return toProject(project);
    });
  }

  async update(projectId: Uuid, patch: ProjectPatch): Promise<Project> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const id = isUuid(projectId) ? projectId.toLowerCase() : null;
      const project = state.projects.find((candidate) => candidate.id === id && candidate.ownerId === uid);
      if (!project) raise("not_found", 404, "project");
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!isValidTitle(title)) raise("invalid_input", 400, "projects_title_check");
        project.title = title;
      }
      if (patch.description !== undefined) {
        if (charLength(patch.description) > MAX_DESCRIPTION_LENGTH) raise("invalid_input", 400, "projects_description_check");
        project.description = patch.description;
      }
      if (patch.favorite !== undefined) project.favorite = patch.favorite;
      if (patch.opened === true) project.openedAt = this.store.timestamp();
      if (patch.trashed === false && project.trashedAt !== null) {
        // private.check_project_untrash: back from the trash only within the plan's project limit
        const plan = planOf(state, uid);
        if (countActiveProjects(state, uid) >= plan.maxProjects) raise("limit_reached", 403, `at most ${plan.maxProjects} projects on this plan`);
      }
      if (patch.trashed !== undefined) project.trashedAt = patch.trashed ? this.store.timestamp() : null;
      // projects.updated_at is "last content change": renames, favourites and trash do not move it
      return toProject(project);
    });
  }

  async deleteForever(projectId: Uuid): Promise<void> {
    await this.delay();
    this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const id = isUuid(projectId) ? projectId.toLowerCase() : null;
      const project = state.projects.find((candidate) => candidate.id === id && candidate.ownerId === uid);
      if (!project) raise("not_found", 404, "project");
      if (project.trashedAt === null) raise("invalid_input", 409, "only projects in the trash can be deleted");
      const versionIds = new Set(state.versions.filter((version) => version.projectId === project.id).map((version) => version.id));
      state.projects = state.projects.filter((candidate) => candidate !== project);
      state.versions = state.versions.filter((version) => version.projectId !== project.id);
      state.versionAssets = state.versionAssets.filter((row) => !versionIds.has(row.parentId));
      state.draftAssets = state.draftAssets.filter((row) => row.parentId !== project.id);
      // on delete set null: copies keep their history, library items keep their files
      for (const version of state.versions) {
        if (version.parentVersionId !== null && versionIds.has(version.parentVersionId)) version.parentVersionId = null;
        if (version.restoredFromVersionId !== null && versionIds.has(version.restoredFromVersionId)) version.restoredFromVersionId = null;
      }
      for (const item of state.libraryItems) {
        if (item.sourceProjectId === project.id) item.sourceProjectId = null;
        if (item.sourceVersionId !== null && versionIds.has(item.sourceVersionId)) item.sourceVersionId = null;
      }
    });
  }

  async versions(projectId: Uuid): Promise<ProjectVersion[]> {
    await this.delay();
    const uid = this.auth.requireUid();
    const id = isUuid(projectId) ? projectId.toLowerCase() : null;
    return this.store.state.versions
      .filter((version) => version.projectId === id && version.ownerId === uid)
      .sort((a, b) => b.seq - a.seq)
      .map(toVersion);
  }

  async versionAttachments(versionId: Uuid): Promise<NamedAttachment[]> {
    await this.delay();
    const uid = this.auth.requireUid();
    const id = isUuid(versionId) ? versionId.toLowerCase() : null;
    return this.store.state.versionAssets
      .filter((row) => row.parentId === id && row.ownerId === uid)
      .sort((a, b) => compareText(a.name, b.name))
      .map((row) => ({ name: row.name, assetId: row.assetId }));
  }

  async draftAttachments(projectId: Uuid): Promise<NamedAttachment[]> {
    await this.delay();
    const uid = this.auth.requireUid();
    const id = isUuid(projectId) ? projectId.toLowerCase() : null;
    return this.store.state.draftAssets
      .filter((row) => row.parentId === id && row.ownerId === uid)
      .sort((a, b) => compareText(a.name, b.name))
      .map((row) => ({ name: row.name, assetId: row.assetId }));
  }

  async saveDraft(projectId: Uuid, expected: { headVersionId: Uuid | null; draftRev: number }, snapshot: SnapshotRef): Promise<Project> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const expectedHead = optionalUuidParam(expected.headVersionId, "p_expected_head_version_id");
      const snapshotAssetId = optionalUuidParam(snapshot.snapshotAssetId, "p_snapshot_asset_id");
      const thumbnailAssetId = optionalUuidParam(snapshot.thumbnailAssetId, "p_thumbnail_asset_id");
      const project = lockOwnProject(state, uid, projectId);
      requireHead(project, expectedHead);
      requireDraftRev(project, expected.draftRev);
      checkSha(snapshot.stateSha256, "state_sha256");
      if (snapshotAssetId === null) raise("invalid_input", 422, "snapshot_asset_id");
      // optional here: what the lab reported, kept for a restore that turns the draft into a version
      const labSchemaVersion = snapshot.labSchemaVersion ?? null;
      if (labSchemaVersion !== null) checkSchemaVersion(labSchemaVersion);
      checkAppBuild(snapshot.appBuild);
      readyAssetSize(state, uid, snapshotAssetId, "snapshot_asset_id");
      readyAssetSize(state, uid, thumbnailAssetId, "thumbnail_asset_id");
      state.draftAssets = state.draftAssets.filter((row) => row.parentId !== project.id);
      for (const row of attachmentRows(state, uid, snapshot.attachments)) {
        state.draftAssets.push({ parentId: project.id, ownerId: uid, name: row.name, assetId: row.assetId });
      }
      const now = this.store.timestamp();
      project.draftAssetId = snapshotAssetId;
      project.draftStateSha256 = snapshot.stateSha256;
      project.draftThumbnailAssetId = thumbnailAssetId;
      project.draftLabSchemaVersion = labSchemaVersion;
      project.draftAppBuild = snapshot.appBuild ?? null;
      project.draftRev += 1;
      project.draftSavedAt = now;
      project.updatedAt = now;
      project.thumbnailAssetId = thumbnailAssetId ?? project.thumbnailAssetId;
      return toProject(project);
    });
  }

  async discardDraft(projectId: Uuid, expectedDraftRev: number): Promise<Project> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const project = lockOwnProject(state, uid, projectId);
      requireDraftRev(project, expectedDraftRev);
      clearDraft(state, project);
      const head = state.versions.find((version) => version.id === project.headVersionId);
      project.thumbnailAssetId = head?.thumbnailAssetId ?? project.thumbnailAssetId;
      return toProject(project);
    });
  }

  async commit(
    projectId: Uuid,
    expected: { headVersionId: Uuid | null; draftRev: number },
    kind: CommitKind,
    snapshot: SnapshotRef,
    label?: string,
  ): Promise<{ project: Project; version: ProjectVersion }> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const expectedHead = optionalUuidParam(expected.headVersionId, "p_expected_head_version_id");
      const snapshotAssetId = optionalUuidParam(snapshot.snapshotAssetId, "p_snapshot_asset_id");
      const thumbnailAssetId = optionalUuidParam(snapshot.thumbnailAssetId, "p_thumbnail_asset_id");
      const project = lockOwnProject(state, uid, projectId);
      requireHead(project, expectedHead);
      requireDraftRev(project, expected.draftRev);
      const labelValue = cleanLabel(label);
      if (!COMMIT_KINDS.includes(kind)) raise("invalid_input", 422, "kind");
      if (kind === "named" && labelValue === null) raise("invalid_input", 422, "a named version needs a label");
      if (labelValue !== null && charLength(labelValue) > 120) raise("invalid_input", 422, "label");
      checkSha(snapshot.stateSha256, "state_sha256");
      if (snapshotAssetId === null) raise("invalid_input", 422, "snapshot_asset_id");
      checkSchemaVersion(snapshot.labSchemaVersion);
      checkAppBuild(snapshot.appBuild);
      readyAssetSize(state, uid, snapshotAssetId, "snapshot_asset_id");
      readyAssetSize(state, uid, thumbnailAssetId, "thumbnail_asset_id");
      requireVersionRoom(state, project.id);
      const now = this.store.timestamp();
      const version: MemoryVersionRow = {
        id: this.store.newId(),
        projectId: project.id,
        ownerId: uid,
        seq: project.headSeq + 1,
        parentVersionId: project.headVersionId,
        kind,
        label: labelValue,
        snapshotAssetId,
        stateSha256: snapshot.stateSha256,
        thumbnailAssetId,
        restoredFromVersionId: null,
        labSchemaVersion: snapshot.labSchemaVersion,
        appBuild: snapshot.appBuild ?? null,
        byteSize: 0,
        createdAt: now,
      };
      state.versions.push(version);
      this.attachVersionAssets(state, uid, version, snapshot.attachments);
      clearDraft(state, project);
      project.headVersionId = version.id;
      project.headSeq = version.seq;
      project.updatedAt = now;
      project.thumbnailAssetId = thumbnailAssetId ?? project.thumbnailAssetId;
      return { project: toProject(project), version: toVersion(version) };
    });
  }

  /**
   * restore_version's first step: an unsaved draft becomes an "autosave" version on top of the head, with its
   * attachments and what the lab reported with it, so restoring never loses work (DESIGN.md §15.2). Returns the new
   * version's id, or null without a draft.
   */
  private keepDraftAsVersion(state: MemoryState, uid: Uuid, project: MemoryProjectRow, now: string): Uuid | null {
    if (project.draftAssetId === null || project.draftStateSha256 === null) return null;
    const head = state.versions.find((candidate) => candidate.id === project.headVersionId);
    const version: MemoryVersionRow = {
      id: this.store.newId(),
      projectId: project.id,
      ownerId: uid,
      seq: project.headSeq + 1,
      parentVersionId: project.headVersionId,
      kind: "autosave",
      label: null,
      snapshotAssetId: project.draftAssetId,
      stateSha256: project.draftStateSha256,
      thumbnailAssetId: project.draftThumbnailAssetId,
      restoredFromVersionId: null,
      labSchemaVersion: project.draftLabSchemaVersion ?? head?.labSchemaVersion ?? 1,
      appBuild: project.draftAppBuild ?? null,
      byteSize: 0,
      createdAt: now,
    };
    state.versions.push(version);
    const attachments = state.draftAssets.filter((row) => row.parentId === project.id);
    for (const row of attachments) state.versionAssets.push({ parentId: version.id, ownerId: uid, name: row.name, assetId: row.assetId });
    version.byteSize = distinctBytes(state, [version.snapshotAssetId, ...attachments.map((row) => row.assetId)]);
    return version.id;
  }

  async restore(
    projectId: Uuid,
    versionId: Uuid,
    expected: { headVersionId: Uuid | null; draftRev: number },
  ): Promise<{ project: Project; version: ProjectVersion }> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const expectedHead = optionalUuidParam(expected.headVersionId, "p_expected_head_version_id");
      const sourceId = uuidParam(versionId, "p_version_id");
      const project = lockOwnProject(state, uid, projectId);
      requireHead(project, expectedHead);
      requireDraftRev(project, expected.draftRev);
      const source = state.versions.find((version) => version.id === sourceId && version.projectId === project.id && version.ownerId === uid);
      if (!source) raise("not_found", 404, "version");
      requireVersionRoom(state, project.id, project.draftAssetId === null ? 1 : 2);
      // one transaction: both versions share its time
      const now = this.store.timestamp();
      const keptId = this.keepDraftAsVersion(state, uid, project, now);
      const version: MemoryVersionRow = {
        id: this.store.newId(),
        projectId: project.id,
        ownerId: uid,
        seq: project.headSeq + (keptId === null ? 1 : 2),
        parentVersionId: keptId ?? project.headVersionId,
        kind: "restore",
        label: null,
        snapshotAssetId: source.snapshotAssetId,
        stateSha256: source.stateSha256,
        thumbnailAssetId: source.thumbnailAssetId,
        restoredFromVersionId: source.id,
        labSchemaVersion: source.labSchemaVersion,
        appBuild: source.appBuild,
        byteSize: source.byteSize,
        createdAt: now,
      };
      state.versions.push(version);
      this.copyVersionAssets(state, uid, source.id, version.id);
      clearDraft(state, project);
      project.headVersionId = version.id;
      project.headSeq = version.seq;
      project.updatedAt = now;
      project.thumbnailAssetId = source.thumbnailAssetId ?? project.thumbnailAssetId;
      return { project: toProject(project), version: toVersion(version) };
    });
  }

  async label(versionId: Uuid, label: string | null): Promise<ProjectVersion> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const id = uuidParam(versionId, "p_version_id");
      const labelValue = cleanLabel(label);
      if (labelValue !== null && charLength(labelValue) > 120) raise("invalid_input", 422, "label");
      const version = state.versions.find((candidate) => candidate.id === id && candidate.ownerId === uid);
      if (!version) raise("not_found", 404, "version");
      // a trashed project's history is read-only
      lockOwnProject(state, uid, version.projectId);
      version.label = labelValue;
      return toVersion(version);
    });
  }

  async deleteVersion(versionId: Uuid): Promise<void> {
    await this.delay();
    this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const id = uuidParam(versionId, "p_version_id");
      const version = state.versions.find((candidate) => candidate.id === id && candidate.ownerId === uid);
      if (!version) raise("not_found", 404, "version");
      // a trashed project's history is read-only
      const project = lockOwnProject(state, uid, version.projectId);
      if (project.headVersionId === version.id) raise("invalid_input", 422, "the current version cannot be deleted");
      if (version.label !== null) raise("invalid_input", 422, "remove the name before deleting a named version");
      state.versions = state.versions.filter((candidate) => candidate !== version);
      state.versionAssets = state.versionAssets.filter((row) => row.parentId !== version.id);
      for (const other of state.versions) {
        if (other.parentVersionId === version.id) other.parentVersionId = null;
        if (other.restoredFromVersionId === version.id) other.restoredFromVersionId = null;
      }
      for (const item of state.libraryItems) if (item.sourceVersionId === version.id) item.sourceVersionId = null;
    });
  }

  async duplicate(projectId: Uuid, title: string, versionId?: Uuid): Promise<Project> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const sourceProjectId = uuidParam(projectId, "p_project_id");
      const wantedVersion = optionalUuidParam(versionId, "p_version_id");
      const cleanTitle = btrim(title.trim());
      if (charLength(cleanTitle) < 1 || charLength(cleanTitle) > 120) raise("invalid_input", 422, "title");
      const sourceProject = state.projects.find((candidate) => candidate.id === sourceProjectId && candidate.ownerId === uid);
      if (!sourceProject) raise("not_found", 404, "project");
      const sourceVersionId = wantedVersion ?? sourceProject.headVersionId;
      const source = state.versions.find((version) => version.id === sourceVersionId && version.projectId === sourceProject.id && version.ownerId === uid);
      if (!source) raise("not_found", 404, "version");
      const plan = planOf(state, uid);
      if (countActiveProjects(state, uid) >= plan.maxProjects) raise("limit_reached", 403, `at most ${plan.maxProjects} projects on this plan`);
      const now = this.store.timestamp();
      const project: MemoryProjectRow = {
        id: this.store.newId(),
        ownerId: uid,
        labId: sourceProject.labId,
        title: cleanTitle,
        description: sourceProject.description,
        headVersionId: null,
        headSeq: 0,
        draftAssetId: null,
        draftStateSha256: null,
        draftThumbnailAssetId: null,
        draftRev: 0,
        draftSavedAt: null,
        thumbnailAssetId: source.thumbnailAssetId,
        favorite: false,
        createdAt: now,
        updatedAt: now,
        openedAt: null,
        trashedAt: null,
      };
      state.projects.push(project);
      const version: MemoryVersionRow = {
        id: this.store.newId(),
        projectId: project.id,
        ownerId: uid,
        seq: 1,
        parentVersionId: null,
        kind: "duplicate",
        label: null,
        snapshotAssetId: source.snapshotAssetId,
        stateSha256: source.stateSha256,
        thumbnailAssetId: source.thumbnailAssetId,
        restoredFromVersionId: source.id,
        labSchemaVersion: source.labSchemaVersion,
        appBuild: source.appBuild,
        byteSize: source.byteSize,
        createdAt: now,
      };
      state.versions.push(version);
      this.copyVersionAssets(state, uid, source.id, version.id);
      project.headVersionId = version.id;
      project.headSeq = 1;
      return toProject(project);
    });
  }
}

// Library ------------------------------------------------------------------------------------------------------------

function libraryFiles(state: MemoryState, itemId: Uuid): LibraryFile[] {
  return state.libraryFiles
    .filter((row) => row.itemId === itemId)
    .sort((a, b) => a.position - b.position || compareText(a.filename, b.filename))
    .map((row) => {
      const file: LibraryFile = { filename: row.filename, assetId: row.assetId, role: row.role, position: row.position };
      const asset = state.assets.find((candidate) => candidate.id === row.assetId);
      if (asset) {
        file.byteSize = asset.byteSize;
        file.mimeType = asset.mimeType;
      }
      return file;
    });
}

function toLibraryItem(state: MemoryState, row: MemoryLibraryRow, withFiles: boolean): LibraryItem {
  const { ownerId: _owner, ...item } = row;
  const result: LibraryItem = { ...item, tags: [...item.tags], metadata: structuredClone(item.metadata) };
  if (withFiles) result.files = libraryFiles(state, row.id);
  return result;
}

export class MemoryLibrary implements LibraryPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly auth: MemoryAuth,
    private readonly delay: () => Promise<void>,
  ) {}

  private own(state: MemoryState, uid: Uuid, itemId: unknown): MemoryLibraryRow {
    const id = isUuid(itemId) ? itemId.toLowerCase() : null;
    const item = state.libraryItems.find((candidate) => candidate.id === id && candidate.ownerId === uid);
    if (!item) raise("not_found", 404, "library_item");
    return item;
  }

  async list(query: LibraryListQuery = {}): Promise<LibraryItem[]> {
    await this.delay();
    const uid = this.auth.requireUid();
    const state = this.store.state;
    const search = query.search?.trim();
    const pattern = search ? ilikeContainsPattern(search) : null;
    return state.libraryItems
      .filter(
        (item) =>
          item.ownerId === uid &&
          (query.trashed === true ? item.trashedAt !== null : item.trashedAt === null) &&
          (query.kind === undefined || item.kind === query.kind) &&
          (query.favorite === undefined || item.favorite === query.favorite) &&
          (query.tag === undefined || item.tags.includes(query.tag)) &&
          (pattern === null || ilikeMatches(item.title, pattern)),
      )
      .sort((a, b) => descending(a.createdAt, b.createdAt) || compareText(a.id, b.id))
      .slice(0, query.limit ?? DEFAULT_ROW_LIMIT)
      .map((item) => toLibraryItem(state, item, false));
  }

  async get(itemId: Uuid): Promise<LibraryItem> {
    await this.delay();
    const uid = this.auth.requireUid();
    return toLibraryItem(this.store.state, this.own(this.store.state, uid, itemId), true);
  }

  async create(input: LibraryItemInput): Promise<LibraryItem> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const sourceProjectId = optionalUuidParam(input.sourceProjectId, "p_source_project_id");
      const sourceVersionId = optionalUuidParam(input.sourceVersionId, "p_source_version_id");
      const thumbnailAssetId = optionalUuidParam(input.thumbnailAssetId, "p_thumbnail_asset_id");
      const title = btrim(input.title.trim());
      const description = input.description ?? "";
      const tags = normalizeTags(input.tags);
      const labId = input.labId ?? null;
      if (!LIBRARY_KINDS.includes(input.kind)) raise("invalid_input", 422, "kind");
      if (charLength(title) < 1 || charLength(title) > 120) raise("invalid_input", 422, "title");
      if (charLength(description) > MAX_DESCRIPTION_LENGTH) raise("invalid_input", 422, "description");
      if (!validTags(tags)) raise("invalid_input", 422, "tags");
      if (labId !== null && !LAB_ID_PATTERN.test(labId)) raise("invalid_input", 422, "lab_id");
      let metadata: JsonObject;
      try {
        const value = toJsonValue(input.metadata ?? {}, { path: "metadata" });
        if (value === null || typeof value !== "object" || Array.isArray(value)) raise("invalid_input", 422, "metadata");
        metadata = value;
      } catch {
        raise("invalid_input", 422, "metadata");
      }
      if (jsonbTextLength(metadata) > MAX_JSON_METADATA_BYTES) raise("invalid_input", 422, "metadata");
      if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_LIBRARY_FILES) {
        raise("invalid_input", 422, "files: 1 to 64 entries");
      }
      if (sourceProjectId !== null && !state.projects.some((project) => project.id === sourceProjectId && project.ownerId === uid)) {
        raise("not_found", 404, "source_project_id");
      }
      if (
        sourceVersionId !== null &&
        !state.versions.some(
          (version) => version.id === sourceVersionId && version.ownerId === uid && (sourceProjectId === null || version.projectId === sourceProjectId),
        )
      ) {
        raise("not_found", 404, "source_version_id");
      }
      readyAssetSize(state, uid, thumbnailAssetId, "thumbnail_asset_id");
      // trash included (DESIGN.md §15.4)
      if (state.libraryItems.filter((row) => row.ownerId === uid).length >= MAX_LIBRARY_ITEMS) {
        raise("limit_reached", 403, `at most ${MAX_LIBRARY_ITEMS} library items per account`);
      }
      const now = this.store.timestamp();
      const item: MemoryLibraryRow = {
        id: this.store.newId(),
        ownerId: uid,
        kind: input.kind,
        title,
        description,
        tags,
        labId,
        sourceProjectId,
        sourceVersionId,
        metadata,
        thumbnailAssetId,
        favorite: false,
        byteSize: 0,
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
      };
      state.libraryItems.push(item);
      const names = new Set<string>();
      for (const file of input.files) {
        if (file === null || typeof file !== "object") raise("invalid_input", 422, "file entry must be an object");
        const filename = file.filename;
        if (!isValidLibraryFilename(filename)) raise("invalid_input", 422, "filename");
        const role = file.role ?? "other";
        if (!LIBRARY_FILE_ROLES.includes(role)) raise("invalid_input", 422, `role of ${filename}`);
        // the position as JSON text must be 1-4 digits and at most 1000 (no sign, no fraction)
        if (file.position !== undefined && (!/^[0-9]{1,4}$/.test(JSON.stringify(file.position) ?? "") || file.position > 1000)) {
          raise("invalid_input", 422, `position of ${filename}`);
        }
        const position = file.position ?? 0;
        if (names.has(filename.toLowerCase())) raise("invalid_input", 422, `duplicate filename ${filename}`);
        names.add(filename.toLowerCase());
        if (!isUuid(file.assetId)) raise("invalid_input", 422, `asset_id of ${filename}`);
        const assetId = file.assetId.toLowerCase();
        readyAssetSize(state, uid, assetId, filename);
        state.libraryFiles.push({ itemId: item.id, ownerId: uid, filename, assetId, role, position });
      }
      item.byteSize = distinctBytes(state, [...state.libraryFiles.filter((row) => row.itemId === item.id).map((row) => row.assetId), item.thumbnailAssetId]);
      return toLibraryItem(state, item, true);
    });
  }

  async update(itemId: Uuid, patch: LibraryPatch): Promise<LibraryItem> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const item = this.own(state, uid, itemId);
      let changed = false;
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!isValidTitle(title)) raise("invalid_input", 400, "library_items_title_check");
        item.title = title;
        changed = true;
      }
      if (patch.description !== undefined) {
        if (charLength(patch.description) > MAX_DESCRIPTION_LENGTH) raise("invalid_input", 400, "library_items_description_check");
        item.description = patch.description;
        changed = true;
      }
      if (patch.tags !== undefined) {
        const tags = normalizeTags(patch.tags);
        if (!validTags(tags)) raise("invalid_input", 400, "library_items_tags_check");
        item.tags = tags;
        changed = true;
      }
      if (patch.favorite !== undefined) {
        item.favorite = patch.favorite;
        changed = true;
      }
      if (patch.trashed !== undefined) {
        item.trashedAt = patch.trashed ? this.store.timestamp() : null;
        changed = true;
      }
      // library_items_touch_updated_at
      if (changed) item.updatedAt = this.store.timestamp();
      return toLibraryItem(state, item, true);
    });
  }

  async deleteForever(itemId: Uuid): Promise<void> {
    await this.delay();
    this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const item = this.own(state, uid, itemId);
      if (item.trashedAt === null) raise("invalid_input", 409, "only items in the trash can be deleted");
      state.libraryItems = state.libraryItems.filter((candidate) => candidate !== item);
      state.libraryFiles = state.libraryFiles.filter((row) => row.itemId !== item.id);
    });
  }
}

// Imported objects ---------------------------------------------------------------------------------------------------

export class MemoryImports implements ImportPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly auth: MemoryAuth,
    private readonly delay: () => Promise<void>,
  ) {}

  private own(state: MemoryState, uid: Uuid, objectId: unknown): MemoryImportRow {
    const id = isUuid(objectId) ? objectId.toLowerCase() : null;
    const object = state.imports.find((candidate) => candidate.id === id && candidate.ownerId === uid);
    if (!object) raise("not_found", 404, "imported_object");
    return object;
  }

  async list(query: ImportListQuery = {}): Promise<ImportedObject[]> {
    await this.delay();
    const uid = this.auth.requireUid();
    const search = query.search?.trim();
    const pattern = search ? ilikeContainsPattern(search) : null;
    return this.store.state.imports
      .filter(
        (object) =>
          object.ownerId === uid &&
          (query.trashed === true ? object.trashedAt !== null : object.trashedAt === null) &&
          (query.sourceApp === undefined || object.sourceApp === query.sourceApp) &&
          (query.favorite === undefined || object.favorite === query.favorite) &&
          (pattern === null || ilikeMatches(object.title, pattern)),
      )
      .sort((a, b) => descending(a.createdAt, b.createdAt) || compareText(a.id, b.id))
      .slice(0, query.limit ?? DEFAULT_ROW_LIMIT)
      .map(toImport);
  }

  async get(objectId: Uuid): Promise<ImportedObject> {
    await this.delay();
    const uid = this.auth.requireUid();
    return toImport(this.own(this.store.state, uid, objectId));
  }

  async create(input: ImportedObjectInput): Promise<ImportedObject> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const originalAssetId = optionalUuidParam(input.originalAssetId, "p_original_asset_id");
      const displayAssetId = optionalUuidParam(input.displayAssetId, "p_display_asset_id");
      const thumbnailAssetId = optionalUuidParam(input.thumbnailAssetId, "p_thumbnail_asset_id");
      const title = btrim(input.title.trim());
      let detail = input.sourceDetail === null ? null : btrim(input.sourceDetail.trim());
      if (detail === "") detail = null;
      const tags = normalizeTags(input.tags);
      if (charLength(title) < 1 || charLength(title) > 120) raise("invalid_input", 422, "title");
      if (!IMPORT_FORMATS.includes(input.format)) raise("invalid_input", 422, "format");
      if (!SOURCE_APPS.includes(input.sourceApp)) raise("invalid_input", 422, "source_app");
      if (!DETECTED_BY_VALUES.includes(input.detectedBy)) raise("invalid_input", 422, "detected_by");
      if (detail !== null) detail = [...detail].slice(0, MAX_SOURCE_DETAIL_LENGTH).join("");
      let stats: ImportStats;
      try {
        const value = toJsonValue(input.stats, { path: "stats" });
        if (value === null || typeof value !== "object" || Array.isArray(value) || jsonbTextLength(value) > MAX_JSON_METADATA_BYTES) {
          raise("invalid_input", 422, "stats");
        }
        stats = value as unknown as ImportStats;
      } catch {
        raise("invalid_input", 422, "stats");
      }
      if (!validTags(tags)) raise("invalid_input", 422, "tags");
      if (originalAssetId === null) raise("invalid_input", 422, "original_asset_id");
      readyAssetSize(state, uid, originalAssetId, "original_asset_id");
      readyAssetSize(state, uid, displayAssetId, "display_asset_id");
      readyAssetSize(state, uid, thumbnailAssetId, "thumbnail_asset_id");
      // trash included (DESIGN.md §15.4)
      if (state.imports.filter((row) => row.ownerId === uid).length >= MAX_IMPORTED_OBJECTS) {
        raise("limit_reached", 403, `at most ${MAX_IMPORTED_OBJECTS} imported objects per account`);
      }
      const now = this.store.timestamp();
      const object: MemoryImportRow = {
        id: this.store.newId(),
        ownerId: uid,
        title,
        sourceApp: input.sourceApp,
        sourceDetail: detail,
        detectedBy: input.detectedBy,
        format: input.format,
        originalAssetId,
        displayAssetId,
        thumbnailAssetId,
        stats,
        tags,
        favorite: false,
        byteSize: distinctBytes(state, [originalAssetId, displayAssetId, thumbnailAssetId]),
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
      };
      state.imports.push(object);
      return toImport(object);
    });
  }

  async update(objectId: Uuid, patch: ImportPatch): Promise<ImportedObject> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const object = this.own(state, uid, objectId);
      let changed = false;
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!isValidTitle(title)) raise("invalid_input", 400, "imported_objects_title_check");
        object.title = title;
        changed = true;
      }
      if (patch.tags !== undefined) {
        const tags = normalizeTags(patch.tags);
        if (!validTags(tags)) raise("invalid_input", 400, "imported_objects_tags_check");
        object.tags = tags;
        changed = true;
      }
      if (patch.favorite !== undefined) {
        object.favorite = patch.favorite;
        changed = true;
      }
      if (patch.trashed !== undefined) {
        object.trashedAt = patch.trashed ? this.store.timestamp() : null;
        changed = true;
      }
      if (patch.sourceApp !== undefined) {
        if (!SOURCE_APPS.includes(patch.sourceApp)) raise("invalid_input", 400, "imported_objects_source_app_check");
        object.sourceApp = patch.sourceApp;
        object.detectedBy = "user";
        changed = true;
      }
      if (changed) object.updatedAt = this.store.timestamp();
      return toImport(object);
    });
  }

  async deleteForever(objectId: Uuid): Promise<void> {
    await this.delay();
    this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const object = this.own(state, uid, objectId);
      if (object.trashedAt === null) raise("invalid_input", 409, "only objects in the trash can be deleted");
      state.imports = state.imports.filter((candidate) => candidate !== object);
    });
  }
}

// Account ------------------------------------------------------------------------------------------------------------

export class MemoryAccount implements AccountPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly auth: MemoryAuth,
    private readonly transport: MemoryTransport,
    private readonly delay: () => Promise<void>,
  ) {}

  async profile(): Promise<Profile> {
    await this.delay();
    const uid = this.auth.requireUid();
    const profile = this.store.state.profiles.find((candidate) => candidate.id === uid);
    if (!profile) raise("not_found", 404, "profile");
    return { ...profile };
  }

  async updateProfile(patch: ProfilePatch): Promise<Profile> {
    await this.delay();
    return this.store.mutate((state) => {
      const uid = this.auth.requireUid(state);
      const profile = state.profiles.find((candidate) => candidate.id === uid);
      if (!profile) raise("not_found", 404, "profile");
      let changed = false;
      if (patch.username !== undefined) {
        const username = patch.username === null ? null : normalizeUsername(patch.username);
        if (username !== null && !isValidUsername(username)) raise("invalid_input", 400, "username");
        if (username !== null && state.profiles.some((other) => other.id !== uid && other.username === username)) {
          raise("user_exists", 409, "username");
        }
        profile.username = username;
        changed = true;
      }
      if (patch.displayName !== undefined) {
        const displayName = patch.displayName === null ? null : patch.displayName.trim() || null;
        if (displayName !== null && charLength(displayName) > MAX_DISPLAY_NAME_LENGTH) raise("invalid_input", 400, "display_name");
        profile.displayName = displayName;
        changed = true;
      }
      if (patch.appearance !== undefined) {
        if (!APPEARANCES.includes(patch.appearance)) raise("invalid_input", 400, "appearance");
        profile.appearance = patch.appearance;
        changed = true;
      }
      if (patch.avatarAssetId !== undefined) {
        const avatar = optionalUuidParam(patch.avatarAssetId, "avatar_asset_id");
        // private.check_profile_avatar: only a changed avatar is checked
        if (avatar !== null && avatar !== profile.avatarAssetId) readyAssetSize(state, uid, avatar, "avatar_asset_id");
        profile.avatarAssetId = avatar;
        changed = true;
      }
      if (changed) profile.updatedAt = this.store.timestamp();
      return { ...profile };
    });
  }

  async usage(): Promise<Usage> {
    await this.delay();
    const state = this.store.state;
    const uid = this.auth.requireUid(state);
    const plan = planOf(state, uid);
    const own = <T extends { ownerId: Uuid }>(rows: T[]): T[] => rows.filter((row) => row.ownerId === uid);
    const assets = own(state.assets);
    const projects = own(state.projects);
    const library = own(state.libraryItems);
    const imports = own(state.imports);
    return {
      planId: plan.id,
      planTitle: plan.title,
      storageQuotaBytes: plan.storageQuotaBytes,
      maxFileBytes: plan.maxFileBytes,
      versionRetentionDays: plan.versionRetentionDays,
      maxProjects: plan.maxProjects,
      // used + pending is what the quota counts: stored files (ready, or being collected) and uploads that are not usable
      // files (in progress, or stored with another size and awaiting collection)
      usedBytes: assets.filter((asset) => asset.status === "ready" || asset.status === "deleting").reduce((sum, asset) => sum + asset.byteSize, 0),
      pendingBytes: assets.filter((asset) => asset.status === "pending" || asset.status === "rejected").reduce((sum, asset) => sum + asset.byteSize, 0),
      projectCount: projects.filter((project) => project.trashedAt === null).length,
      versionCount: own(state.versions).length,
      libraryCount: library.filter((item) => item.trashedAt === null).length,
      importCount: imports.filter((object) => object.trashedAt === null).length,
      trashCount:
        projects.filter((project) => project.trashedAt !== null).length +
        library.filter((item) => item.trashedAt !== null).length +
        imports.filter((object) => object.trashedAt !== null).length,
    };
  }

  async deleteAccount(confirmation: "DELETE"): Promise<void> {
    if (confirmation !== "DELETE") throw platformError("invalid_input", { status: 400, detail: "confirmation" });
    await this.delay();
    const removed = this.store.mutate((state) => {
      // the account-delete function checks that the sign-in is recent (DESIGN.md §15.9)
      const uid = this.auth.requireFreshUid(state);
      const user = state.users.find((candidate) => candidate.id === uid);
      const paths = state.objects.filter((object) => object.path.split("/")[0] === uid).map((object) => object.path);
      const owned = <T extends { ownerId: Uuid }>(rows: T[]): T[] => rows.filter((row) => row.ownerId !== uid);
      state.assets = owned(state.assets);
      state.objects = state.objects.filter((object) => object.path.split("/")[0] !== uid);
      state.projects = owned(state.projects);
      state.versions = owned(state.versions);
      state.versionAssets = owned(state.versionAssets);
      state.draftAssets = owned(state.draftAssets);
      state.libraryItems = owned(state.libraryItems);
      state.libraryFiles = owned(state.libraryFiles);
      state.imports = owned(state.imports);
      state.profiles = state.profiles.filter((profile) => profile.id !== uid);
      state.users = state.users.filter((candidate) => candidate.id !== uid);
      if (user) state.codes = state.codes.filter((code) => code.email !== user.email);
      return paths;
    });
    await this.store.deleteObjects(removed);
    this.transport.forget(removed);
    this.auth.accountDeleted();
  }
}
