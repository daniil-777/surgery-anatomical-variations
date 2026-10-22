// The platform's domain model and the ports every backend implements (Supabase in production, an in-memory twin in
// tests and the offline UI suite). Records mirror the SQL tables in supabase/migrations with camelCase names;
// timestamps are ISO-8601 strings in UTC. Nothing here imports React, three.js or supabase-js.

export type Uuid = string;
export type IsoDate = string;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// Accounts ----------------------------------------------------------------------------------------------------------

export type Appearance = "system" | "light" | "dark";

export interface Plan {
  id: string;
  title: string;
  storageQuotaBytes: number;
  maxFileBytes: number;
  versionRetentionDays: number;
  maxProjects: number;
}

export interface Profile {
  id: Uuid;
  username: string | null;
  displayName: string | null;
  avatarAssetId: Uuid | null;
  planId: string;
  appearance: Appearance;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export type OAuthProvider = "google" | "apple" | "github" | "azure";
export type IdentityProvider = OAuthProvider | "email";

export interface AccountUser {
  id: Uuid;
  email: string | null;
  emailConfirmed: boolean;
  /** Linked sign-in methods, e.g. ["email", "google"]. */
  providers: IdentityProvider[];
  createdAt: IsoDate;
  lastSignInAt: IsoDate | null;
}

export interface Session {
  user: AccountUser;
  /** Access-token expiry (epoch seconds) or null when unknown. */
  expiresAt: number | null;
}

export type AuthEvent = "signed_in" | "signed_out" | "token_refreshed" | "user_updated" | "password_recovery";

export interface Usage {
  planId: string;
  planTitle: string;
  storageQuotaBytes: number;
  maxFileBytes: number;
  versionRetentionDays: number;
  maxProjects: number;
  usedBytes: number;
  pendingBytes: number;
  projectCount: number;
  versionCount: number;
  libraryCount: number;
  importCount: number;
  trashCount: number;
}

// Assets ------------------------------------------------------------------------------------------------------------

export type AssetStatus = "pending" | "ready";

export interface Asset {
  id: Uuid;
  sha256: string;
  byteSize: number;
  mimeType: string;
  objectPath: string;
  status: AssetStatus;
  createdAt: IsoDate;
}

/** MIME types the storage bucket accepts (supabase/migrations …_platform_assets.sql). */
export const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/ktx2",
  "video/mp4",
  "video/webm",
  "model/gltf-binary",
  "model/gltf+json",
  "model/obj",
  "model/stl",
  "model/vnd.usdz+zip",
  "application/json",
  "application/gzip",
  "application/zip",
  "application/octet-stream",
  "text/plain",
] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export interface UploadProgress {
  loaded: number;
  total: number;
}

// Projects ----------------------------------------------------------------------------------------------------------

export type VersionKind = "initial" | "autosave" | "manual" | "named" | "restore" | "duplicate" | "import";
export type CommitKind = "autosave" | "manual" | "named";

export interface Project {
  id: Uuid;
  labId: string;
  title: string;
  description: string;
  headVersionId: Uuid | null;
  headSeq: number;
  draftAssetId: Uuid | null;
  draftStateSha256: string | null;
  draftThumbnailAssetId: Uuid | null;
  draftRev: number;
  draftSavedAt: IsoDate | null;
  thumbnailAssetId: Uuid | null;
  favorite: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  openedAt: IsoDate | null;
  trashedAt: IsoDate | null;
}

export interface ProjectVersion {
  id: Uuid;
  projectId: Uuid;
  seq: number;
  parentVersionId: Uuid | null;
  kind: VersionKind;
  label: string | null;
  snapshotAssetId: Uuid;
  stateSha256: string;
  thumbnailAssetId: Uuid | null;
  restoredFromVersionId: Uuid | null;
  labSchemaVersion: number;
  appBuild: string | null;
  byteSize: number;
  createdAt: IsoDate;
}

export interface NamedAttachment {
  /** ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ */
  name: string;
  assetId: Uuid;
}

/** An uploaded snapshot ready to be referenced by create/saveDraft/commit. */
export interface SnapshotRef {
  snapshotAssetId: Uuid;
  stateSha256: string;
  thumbnailAssetId: Uuid | null;
  attachments: NamedAttachment[];
  labSchemaVersion: number;
  appBuild: string | null;
}

export interface ProjectListQuery {
  labId?: string;
  trashed?: boolean;
  favorite?: boolean;
  search?: string;
  orderBy?: "updated" | "created" | "title" | "opened";
  limit?: number;
}

export interface ProjectPatch {
  title?: string;
  description?: string;
  favorite?: boolean;
  /** Stamps opened_at = now. */
  opened?: true;
  /** true moves to the trash (stamped now), false restores from the trash. */
  trashed?: boolean;
}

// Library -----------------------------------------------------------------------------------------------------------

export type LibraryKind = "shape" | "material" | "texture" | "recording" | "scene" | "image" | "model";

export type LibraryFileRole =
  | "primary"
  | "mesh"
  | "albedo"
  | "normal"
  | "roughness"
  | "metalness"
  | "height"
  | "ao"
  | "emissive"
  | "opacity"
  | "thumbnail"
  | "preview"
  | "video"
  | "data"
  | "spec"
  | "material"
  | "other";

export interface LibraryFile {
  filename: string;
  assetId: Uuid;
  role: LibraryFileRole;
  position: number;
  /** Filled when the asset row is known. */
  byteSize?: number;
  mimeType?: string;
}

export interface LibraryItem {
  id: Uuid;
  kind: LibraryKind;
  title: string;
  description: string;
  tags: string[];
  labId: string | null;
  sourceProjectId: Uuid | null;
  sourceVersionId: Uuid | null;
  metadata: JsonObject;
  thumbnailAssetId: Uuid | null;
  favorite: boolean;
  byteSize: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  trashedAt: IsoDate | null;
  /** Present on get(); list() may omit it. */
  files?: LibraryFile[];
}

export interface LibraryListQuery {
  kind?: LibraryKind;
  favorite?: boolean;
  trashed?: boolean;
  tag?: string;
  search?: string;
  limit?: number;
}

export interface LibraryItemInput {
  kind: LibraryKind;
  title: string;
  description?: string;
  tags?: string[];
  labId?: string | null;
  sourceProjectId?: Uuid | null;
  sourceVersionId?: Uuid | null;
  metadata?: JsonObject;
  thumbnailAssetId?: Uuid | null;
  files: Array<{ filename: string; assetId: Uuid; role: LibraryFileRole; position?: number }>;
}

export interface LibraryPatch {
  title?: string;
  description?: string;
  tags?: string[];
  favorite?: boolean;
  trashed?: boolean;
}

// Imports -----------------------------------------------------------------------------------------------------------

export type SourceApp =
  | "unity"
  | "blender"
  | "maya"
  | "3ds-max"
  | "cinema-4d"
  | "houdini"
  | "sketchup"
  | "substance"
  | "zbrush"
  | "reality-composer"
  | "sketchfab"
  | "other"
  | "unknown";

export type DetectedBy = "metadata" | "filename" | "user" | "none";
export type ImportFormat = "glb" | "gltf" | "fbx" | "obj" | "stl" | "ply" | "usdz" | "dae" | "zip";

export interface ImportStats {
  meshes: number;
  vertices: number;
  triangles: number;
  materials: number;
  textures: number;
  animations: number;
  skinned: boolean;
  /** Axis-aligned size in the file's units, or null when nothing could be measured. */
  bbox: { x: number; y: number; z: number } | null;
  units?: string;
  upAxis?: "Y" | "Z";
  /** Free-form notes from the analysis (e.g. "textures referenced but not bundled"). */
  notes?: string[];
}

export interface ImportedObject {
  id: Uuid;
  title: string;
  sourceApp: SourceApp;
  sourceDetail: string | null;
  detectedBy: DetectedBy;
  format: ImportFormat;
  originalAssetId: Uuid;
  displayAssetId: Uuid | null;
  thumbnailAssetId: Uuid | null;
  stats: ImportStats;
  tags: string[];
  favorite: boolean;
  byteSize: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  trashedAt: IsoDate | null;
}

export interface ImportListQuery {
  sourceApp?: SourceApp;
  favorite?: boolean;
  trashed?: boolean;
  search?: string;
  limit?: number;
}

export interface ImportedObjectInput {
  title: string;
  format: ImportFormat;
  originalAssetId: Uuid;
  sourceApp: SourceApp;
  sourceDetail: string | null;
  detectedBy: DetectedBy;
  displayAssetId: Uuid | null;
  thumbnailAssetId: Uuid | null;
  stats: ImportStats;
  tags?: string[];
}

export interface ImportPatch {
  title?: string;
  tags?: string[];
  favorite?: boolean;
  trashed?: boolean;
  /** A user correction of the detected application (stored with detected_by = 'user'). */
  sourceApp?: SourceApp;
}

// Errors ------------------------------------------------------------------------------------------------------------

export type PlatformErrorCode =
  | "not_authenticated"
  | "not_found"
  | "invalid_input"
  | "quota_exceeded"
  | "file_too_large"
  | "version_conflict"
  | "draft_conflict"
  | "asset_not_ready"
  | "asset_busy"
  | "upload_missing"
  | "size_mismatch"
  | "limit_reached"
  | "project_trashed"
  | "invalid_credentials"
  | "email_not_confirmed"
  | "user_exists"
  | "weak_password"
  | "rate_limited"
  | "provider_disabled"
  | "accounts_disabled"
  | "network"
  | "aborted"
  | "unknown";

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly status: number | null;
  readonly detail: string | null;

  constructor(
    code: PlatformErrorCode,
    message?: string,
    options?: { status?: number | null | undefined; detail?: string | null | undefined; cause?: unknown },
  ) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PlatformError";
    this.code = code;
    this.status = options?.status ?? null;
    this.detail = options?.detail ?? null;
  }
}

/** By shape, not instanceof: errors can cross realms (lab iframes) and duplicated chunks. */
export function isPlatformError(error: unknown, code?: PlatformErrorCode): error is PlatformError {
  if (error instanceof PlatformError) return code === undefined || error.code === code;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "PlatformError" && typeof candidate.code === "string" && (code === undefined || candidate.code === code);
}

// Ports -------------------------------------------------------------------------------------------------------------

export interface SignUpInput {
  email: string;
  password: string;
  username?: string;
  displayName?: string;
}

export interface AuthPort {
  /** The current session (null when signed out). */
  current(): Session | null;
  /** Resolves once the stored session is restored and any OAuth/magic-link callback in the URL is exchanged. */
  ready(): Promise<Session | null>;
  onChange(listener: (event: AuthEvent, session: Session | null) => void): () => void;
  signInWithPassword(email: string, password: string): Promise<Session>;
  signInWithUsername(username: string, password: string): Promise<Session>;
  signUp(input: SignUpInput): Promise<{ session: Session | null; needsEmailConfirmation: boolean }>;
  sendEmailCode(email: string, options?: { createUser?: boolean }): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<Session>;
  /** Navigates away to the provider; resolves only if navigation did not happen. */
  signInWithOAuth(provider: OAuthProvider): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  /** Signs in with the 6-digit code from a password-reset email (works on any device); then call updatePassword. */
  verifyRecoveryCode(email: string, code: string): Promise<Session>;
  /** Fresh sign-in for sensitive actions (password change, account deletion) on accounts that have a password. */
  reauthenticate(password: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  signOut(scope?: "local" | "global"): Promise<void>;
  linkIdentity(provider: OAuthProvider): Promise<void>;
  unlinkIdentity(provider: OAuthProvider): Promise<void>;
  usernameAvailable(username: string): Promise<boolean>;
}

export interface AssetPutOptions {
  /** Defaults to blob.type, falling back to application/octet-stream. Must be one of ALLOWED_MIME_TYPES. */
  mimeType?: AllowedMimeType;
  /** Precomputed SHA-256 (hex) when the caller already hashed the bytes. */
  sha256?: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

export interface AssetPort {
  /** Hash → reserve (dedup, quota) → upload → confirm. Returns the ready asset. */
  put(blob: Blob, options?: AssetPutOptions): Promise<Asset>;
  /** Asset rows of the signed-in account (unknown ids are omitted). */
  describe(assetIds: Uuid[]): Promise<Asset[]>;
  /** A short-lived URL for display or download (download = suggested filename). */
  url(assetId: Uuid, options?: { download?: string; expiresInSeconds?: number }): Promise<string>;
  /** The bytes (cached locally by SHA-256: content-addressed assets never change). */
  get(assetId: Uuid, options?: { signal?: AbortSignal }): Promise<Blob>;
}

export interface ProjectPort {
  list(query?: ProjectListQuery): Promise<Project[]>;
  get(projectId: Uuid): Promise<Project>;
  create(input: { labId: string; title: string; description?: string } & SnapshotRef): Promise<Project>;
  update(projectId: Uuid, patch: ProjectPatch): Promise<Project>;
  /** Only for trashed projects. */
  deleteForever(projectId: Uuid): Promise<void>;
  versions(projectId: Uuid): Promise<ProjectVersion[]>;
  versionAttachments(versionId: Uuid): Promise<NamedAttachment[]>;
  draftAttachments(projectId: Uuid): Promise<NamedAttachment[]>;
  saveDraft(projectId: Uuid, expected: { headVersionId: Uuid | null; draftRev: number }, snapshot: SnapshotRef): Promise<Project>;
  discardDraft(projectId: Uuid, expectedDraftRev: number): Promise<Project>;
  /**
   * Commits the next version and clears the draft. 409 version_conflict when the head moved, draft_conflict when the
   * draft changed since `expected.draftRev`. Returns the updated project (new head, new draft_rev) with the version.
   */
  commit(
    projectId: Uuid,
    expected: { headVersionId: Uuid | null; draftRev: number },
    kind: CommitKind,
    snapshot: SnapshotRef,
    label?: string,
  ): Promise<{ project: Project; version: ProjectVersion }>;
  /**
   * Non-destructive restore: an existing draft is first kept as an autosave version, then a restore version that
   * reuses the chosen version's files becomes the head. Same conflict rules and return shape as commit().
   */
  restore(
    projectId: Uuid,
    versionId: Uuid,
    expected: { headVersionId: Uuid | null; draftRev: number },
  ): Promise<{ project: Project; version: ProjectVersion }>;
  label(versionId: Uuid, label: string | null): Promise<ProjectVersion>;
  deleteVersion(versionId: Uuid): Promise<void>;
  duplicate(projectId: Uuid, title: string, versionId?: Uuid): Promise<Project>;
}

export interface LibraryPort {
  list(query?: LibraryListQuery): Promise<LibraryItem[]>;
  get(itemId: Uuid): Promise<LibraryItem>;
  create(input: LibraryItemInput): Promise<LibraryItem>;
  update(itemId: Uuid, patch: LibraryPatch): Promise<LibraryItem>;
  deleteForever(itemId: Uuid): Promise<void>;
}

export interface ImportPort {
  list(query?: ImportListQuery): Promise<ImportedObject[]>;
  get(objectId: Uuid): Promise<ImportedObject>;
  create(input: ImportedObjectInput): Promise<ImportedObject>;
  update(objectId: Uuid, patch: ImportPatch): Promise<ImportedObject>;
  deleteForever(objectId: Uuid): Promise<void>;
}

export interface ProfilePatch {
  username?: string | null;
  displayName?: string | null;
  appearance?: Appearance;
  avatarAssetId?: Uuid | null;
}

export interface AccountPort {
  profile(): Promise<Profile>;
  updateProfile(patch: ProfilePatch): Promise<Profile>;
  usage(): Promise<Usage>;
  /** Permanently deletes the account and every file (confirmation must be the literal "DELETE"). */
  deleteAccount(confirmation: "DELETE"): Promise<void>;
}

export interface PlatformBackend {
  readonly kind: "supabase" | "memory";
  readonly auth: AuthPort;
  readonly assets: AssetPort;
  readonly projects: ProjectPort;
  readonly library: LibraryPort;
  readonly imports: ImportPort;
  readonly account: AccountPort;
}
