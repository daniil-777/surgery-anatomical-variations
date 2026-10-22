// SupabaseBackend: every port of types.ts over supabase-js 2.118 (DESIGN.md §6-§8). Reads go through row level
// security; invariant writes through the SECURITY DEFINER RPCs with their p_* parameters exactly as in
// supabase/migrations; plain edits (title, favourite, trash, opened) through the column grants. Errors arrive as
// PostgREST bodies (code PT<status>, message = platform code) and leave as PlatformError.
//
// Signed out, nothing is requested except supabase-js restoring a stored session and username_available (the deploy
// smoke fails on any HTTP status >= 400). Load this module lazily (import()) so supabase-js stays out of the first
// paint of pages that never sign in.

import { createClient, type SupabaseClient, type SupabaseClientOptions, type SupportedStorage } from "@supabase/supabase-js";
import { createAssetPort, type AssetPortOptions, type PlatformAssetPort } from "../assets";
import type { BlobCache } from "../blobCache";
import type { SupabasePlatformConfig } from "../config";
import { fromFunctionsError, fromPostgrestError, platformError, toPlatformError, type PostgrestErrorLike } from "../errors";
import type {
  AccountPort,
  CommitKind,
  ImportedObject,
  ImportedObjectInput,
  ImportListQuery,
  ImportPatch,
  ImportPort,
  LibraryItem,
  LibraryItemInput,
  LibraryListQuery,
  LibraryPatch,
  LibraryPort,
  NamedAttachment,
  PlatformBackend,
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
import { ilikeContainsPattern, isUuid, isValidUsername, normalizeTags, normalizeUsername } from "../memory/rules";
import { AUTH_STORAGE_KEY, SupabaseAuth, type LocationLike } from "./auth";
import { asRows, mapAttachment, mapImport, mapLibraryItem, mapProfile, mapProject, mapProjectAndVersion, mapUsage, mapVersion } from "./mappers";
import { SupabaseTransport } from "./transport";

const LIBRARY_WITH_FILES = "*, library_item_files(filename, asset_id, role, position, assets(byte_size, mime_type))";

interface Response {
  data: unknown;
  error: PostgrestErrorLike | null;
  status: number;
}

/** Awaits a PostgREST builder and returns its data, or throws the mapped PlatformError. */
async function run(request: PromiseLike<Response>): Promise<unknown> {
  let response: Response;
  try {
    response = await request;
  } catch (error) {
    throw toPlatformError(error);
  }
  if (response.error) throw fromPostgrestError(response.error, response.status);
  return response.data;
}

function notFound(what: string): never {
  throw platformError("not_found", { status: 404, detail: what });
}

function attachmentsJson(attachments: readonly NamedAttachment[] | null | undefined): Array<{ name: string; asset_id: string }> {
  return (attachments ?? []).map((attachment) => ({ name: attachment.name, asset_id: attachment.assetId }));
}

function compareNames(a: NamedAttachment, b: NamedAttachment): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

type Gate = () => Promise<unknown>;

// Projects -----------------------------------------------------------------------------------------------------------

const PROJECT_ORDER: Record<NonNullable<ProjectListQuery["orderBy"]>, string> = {
  updated: "updated_at",
  created: "created_at",
  title: "title",
  opened: "opened_at",
};

class SupabaseProjects implements ProjectPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly gate: Gate,
  ) {}

  async list(query: ProjectListQuery = {}): Promise<Project[]> {
    await this.gate();
    let request = this.client.from("projects").select("*");
    request = query.trashed === true ? request.not("trashed_at", "is", null) : request.is("trashed_at", null);
    if (query.labId !== undefined) request = request.eq("lab_id", query.labId);
    if (query.favorite !== undefined) request = request.eq("favorite", query.favorite);
    const search = query.search?.trim();
    if (search) request = request.ilike("title", ilikeContainsPattern(search));
    const order = query.orderBy ?? "updated";
    request = request.order(PROJECT_ORDER[order], { ascending: order === "title", nullsFirst: false }).order("id", { ascending: true });
    if (query.limit !== undefined) request = request.limit(query.limit);
    return asRows(await run(request), "projects").map(mapProject);
  }

  async get(projectId: Uuid): Promise<Project> {
    await this.gate();
    if (!isUuid(projectId)) notFound("project");
    const row = await run(this.client.from("projects").select("*").eq("id", projectId).maybeSingle());
    if (!row) notFound("project");
    return mapProject(row);
  }

  async create(input: { labId: string; title: string; description?: string } & SnapshotRef): Promise<Project> {
    await this.gate();
    return mapProject(
      await run(
        this.client.rpc("create_project", {
          p_lab_id: input.labId,
          p_title: input.title.trim(),
          p_snapshot_asset_id: input.snapshotAssetId,
          p_state_sha256: input.stateSha256,
          p_thumbnail_asset_id: input.thumbnailAssetId,
          p_lab_schema_version: input.labSchemaVersion,
          p_app_build: input.appBuild,
          p_attachments: attachmentsJson(input.attachments),
          p_description: input.description ?? "",
        }),
      ),
    );
  }

  async update(projectId: Uuid, patch: ProjectPatch): Promise<Project> {
    await this.gate();
    if (!isUuid(projectId)) notFound("project");
    const row: Record<string, unknown> = {};
    if (patch.title !== undefined) row.title = patch.title.trim();
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.favorite !== undefined) row.favorite = patch.favorite;
    // the database replaces both stamps with its own now()
    if (patch.opened === true) row.opened_at = nowIso();
    if (patch.trashed !== undefined) row.trashed_at = patch.trashed ? nowIso() : null;
    if (Object.keys(row).length === 0) return this.get(projectId);
    const updated = await run(this.client.from("projects").update(row).eq("id", projectId).select("*").maybeSingle());
    if (!updated) notFound("project");
    return mapProject(updated);
  }

  async deleteForever(projectId: Uuid): Promise<void> {
    await this.gate();
    if (!isUuid(projectId)) notFound("project");
    const deleted = asRows(await run(this.client.from("projects").delete().eq("id", projectId).select("id")), "projects");
    if (deleted.length > 0) return;
    // row level security deletes trashed projects only: tell "missing" from "not in the trash"
    const existing = await run(this.client.from("projects").select("id").eq("id", projectId).maybeSingle());
    if (!existing) notFound("project");
    throw platformError("invalid_input", { status: 409, detail: "only projects in the trash can be deleted" });
  }

  async versions(projectId: Uuid): Promise<ProjectVersion[]> {
    await this.gate();
    if (!isUuid(projectId)) return [];
    const rows = await run(this.client.from("project_versions").select("*").eq("project_id", projectId).order("seq", { ascending: false }));
    return asRows(rows, "project_versions").map(mapVersion);
  }

  async versionAttachments(versionId: Uuid): Promise<NamedAttachment[]> {
    await this.gate();
    if (!isUuid(versionId)) return [];
    const rows = await run(this.client.from("project_version_assets").select("name, asset_id").eq("version_id", versionId));
    return asRows(rows, "project_version_assets").map(mapAttachment).sort(compareNames);
  }

  async draftAttachments(projectId: Uuid): Promise<NamedAttachment[]> {
    await this.gate();
    if (!isUuid(projectId)) return [];
    const rows = await run(this.client.from("project_draft_assets").select("name, asset_id").eq("project_id", projectId));
    return asRows(rows, "project_draft_assets").map(mapAttachment).sort(compareNames);
  }

  async saveDraft(projectId: Uuid, expected: { headVersionId: Uuid | null; draftRev: number }, snapshot: SnapshotRef): Promise<Project> {
    await this.gate();
    return mapProject(
      await run(
        this.client.rpc("save_draft", {
          p_project_id: projectId,
          p_expected_head_version_id: expected.headVersionId,
          p_expected_draft_rev: expected.draftRev,
          p_snapshot_asset_id: snapshot.snapshotAssetId,
          p_state_sha256: snapshot.stateSha256,
          p_thumbnail_asset_id: snapshot.thumbnailAssetId,
          p_attachments: attachmentsJson(snapshot.attachments),
          // kept with the draft, so a restore that turns it into a version records what the lab reported
          p_lab_schema_version: snapshot.labSchemaVersion,
          p_app_build: snapshot.appBuild,
        }),
      ),
    );
  }

  async discardDraft(projectId: Uuid, expectedDraftRev: number): Promise<Project> {
    await this.gate();
    return mapProject(await run(this.client.rpc("discard_draft", { p_project_id: projectId, p_expected_draft_rev: expectedDraftRev })));
  }

  async commit(
    projectId: Uuid,
    expected: { headVersionId: Uuid | null; draftRev: number },
    kind: CommitKind,
    snapshot: SnapshotRef,
    label?: string,
  ): Promise<{ project: Project; version: ProjectVersion }> {
    await this.gate();
    return mapProjectAndVersion(
      await run(
        this.client.rpc("commit_version", {
          p_project_id: projectId,
          p_expected_head_version_id: expected.headVersionId,
          p_expected_draft_rev: expected.draftRev,
          p_kind: kind,
          p_snapshot_asset_id: snapshot.snapshotAssetId,
          p_state_sha256: snapshot.stateSha256,
          p_label: label === undefined ? null : label.trim(),
          p_thumbnail_asset_id: snapshot.thumbnailAssetId,
          p_lab_schema_version: snapshot.labSchemaVersion,
          p_app_build: snapshot.appBuild,
          p_attachments: attachmentsJson(snapshot.attachments),
        }),
      ),
      "commit_version",
    );
  }

  async restore(
    projectId: Uuid,
    versionId: Uuid,
    expected: { headVersionId: Uuid | null; draftRev: number },
  ): Promise<{ project: Project; version: ProjectVersion }> {
    await this.gate();
    return mapProjectAndVersion(
      await run(
        this.client.rpc("restore_version", {
          p_project_id: projectId,
          p_version_id: versionId,
          p_expected_head_version_id: expected.headVersionId,
          p_expected_draft_rev: expected.draftRev,
        }),
      ),
      "restore_version",
    );
  }

  async label(versionId: Uuid, label: string | null): Promise<ProjectVersion> {
    await this.gate();
    return mapVersion(await run(this.client.rpc("label_version", { p_version_id: versionId, p_label: label === null ? null : label.trim() })));
  }

  async deleteVersion(versionId: Uuid): Promise<void> {
    await this.gate();
    await run(this.client.rpc("delete_version", { p_version_id: versionId }));
  }

  async duplicate(projectId: Uuid, title: string, versionId?: Uuid): Promise<Project> {
    await this.gate();
    return mapProject(await run(this.client.rpc("duplicate_project", { p_project_id: projectId, p_title: title.trim(), p_version_id: versionId ?? null })));
  }
}

// Library ------------------------------------------------------------------------------------------------------------

class SupabaseLibrary implements LibraryPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly gate: Gate,
  ) {}

  async list(query: LibraryListQuery = {}): Promise<LibraryItem[]> {
    await this.gate();
    let request = this.client.from("library_items").select("*");
    request = query.trashed === true ? request.not("trashed_at", "is", null) : request.is("trashed_at", null);
    if (query.kind !== undefined) request = request.eq("kind", query.kind);
    if (query.favorite !== undefined) request = request.eq("favorite", query.favorite);
    if (query.tag !== undefined) request = request.contains("tags", [query.tag]);
    const search = query.search?.trim();
    if (search) request = request.ilike("title", ilikeContainsPattern(search));
    request = request.order("created_at", { ascending: false }).order("id", { ascending: true });
    if (query.limit !== undefined) request = request.limit(query.limit);
    return asRows(await run(request), "library_items").map(mapLibraryItem);
  }

  async get(itemId: Uuid): Promise<LibraryItem> {
    await this.gate();
    if (!isUuid(itemId)) notFound("library_item");
    const row = await run(this.client.from("library_items").select(LIBRARY_WITH_FILES).eq("id", itemId).maybeSingle());
    if (!row) notFound("library_item");
    return mapLibraryItem(row);
  }

  async create(input: LibraryItemInput): Promise<LibraryItem> {
    await this.gate();
    const created = mapLibraryItem(
      await run(
        this.client.rpc("create_library_item", {
          p_kind: input.kind,
          p_title: input.title.trim(),
          p_files: input.files.map((file) => ({ filename: file.filename, asset_id: file.assetId, role: file.role, position: file.position })),
          p_description: input.description ?? "",
          p_tags: normalizeTags(input.tags),
          p_lab_id: input.labId ?? null,
          p_source_project_id: input.sourceProjectId ?? null,
          p_source_version_id: input.sourceVersionId ?? null,
          p_metadata: input.metadata ?? {},
          p_thumbnail_asset_id: input.thumbnailAssetId ?? null,
        }),
      ),
    );
    try {
      // the RPC returns the item row; the files (with sizes and types) come with the item
      return await this.get(created.id);
    } catch {
      return { ...created, files: input.files.map((file) => ({ filename: file.filename, assetId: file.assetId, role: file.role, position: file.position ?? 0 })) };
    }
  }

  async update(itemId: Uuid, patch: LibraryPatch): Promise<LibraryItem> {
    await this.gate();
    if (!isUuid(itemId)) notFound("library_item");
    const row: Record<string, unknown> = {};
    if (patch.title !== undefined) row.title = patch.title.trim();
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.tags !== undefined) row.tags = normalizeTags(patch.tags);
    if (patch.favorite !== undefined) row.favorite = patch.favorite;
    if (patch.trashed !== undefined) row.trashed_at = patch.trashed ? nowIso() : null;
    if (Object.keys(row).length === 0) return this.get(itemId);
    const updated = await run(this.client.from("library_items").update(row).eq("id", itemId).select(LIBRARY_WITH_FILES).maybeSingle());
    if (!updated) notFound("library_item");
    return mapLibraryItem(updated);
  }

  async deleteForever(itemId: Uuid): Promise<void> {
    await this.gate();
    if (!isUuid(itemId)) notFound("library_item");
    const deleted = asRows(await run(this.client.from("library_items").delete().eq("id", itemId).select("id")), "library_items");
    if (deleted.length > 0) return;
    const existing = await run(this.client.from("library_items").select("id").eq("id", itemId).maybeSingle());
    if (!existing) notFound("library_item");
    throw platformError("invalid_input", { status: 409, detail: "only items in the trash can be deleted" });
  }
}

// Imported objects ---------------------------------------------------------------------------------------------------

class SupabaseImports implements ImportPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly gate: Gate,
  ) {}

  async list(query: ImportListQuery = {}): Promise<ImportedObject[]> {
    await this.gate();
    let request = this.client.from("imported_objects").select("*");
    request = query.trashed === true ? request.not("trashed_at", "is", null) : request.is("trashed_at", null);
    if (query.sourceApp !== undefined) request = request.eq("source_app", query.sourceApp);
    if (query.favorite !== undefined) request = request.eq("favorite", query.favorite);
    const search = query.search?.trim();
    if (search) request = request.ilike("title", ilikeContainsPattern(search));
    request = request.order("created_at", { ascending: false }).order("id", { ascending: true });
    if (query.limit !== undefined) request = request.limit(query.limit);
    return asRows(await run(request), "imported_objects").map(mapImport);
  }

  async get(objectId: Uuid): Promise<ImportedObject> {
    await this.gate();
    if (!isUuid(objectId)) notFound("imported_object");
    const row = await run(this.client.from("imported_objects").select("*").eq("id", objectId).maybeSingle());
    if (!row) notFound("imported_object");
    return mapImport(row);
  }

  async create(input: ImportedObjectInput): Promise<ImportedObject> {
    await this.gate();
    return mapImport(
      await run(
        this.client.rpc("create_imported_object", {
          p_title: input.title.trim(),
          p_format: input.format,
          p_original_asset_id: input.originalAssetId,
          p_source_app: input.sourceApp,
          p_source_detail: input.sourceDetail === null ? null : input.sourceDetail.trim() || null,
          p_detected_by: input.detectedBy,
          p_display_asset_id: input.displayAssetId,
          p_thumbnail_asset_id: input.thumbnailAssetId,
          p_stats: input.stats,
          p_tags: normalizeTags(input.tags),
        }),
      ),
    );
  }

  async update(objectId: Uuid, patch: ImportPatch): Promise<ImportedObject> {
    await this.gate();
    if (!isUuid(objectId)) notFound("imported_object");
    const row: Record<string, unknown> = {};
    if (patch.title !== undefined) row.title = patch.title.trim();
    if (patch.tags !== undefined) row.tags = normalizeTags(patch.tags);
    if (patch.favorite !== undefined) row.favorite = patch.favorite;
    if (patch.trashed !== undefined) row.trashed_at = patch.trashed ? nowIso() : null;
    if (patch.sourceApp !== undefined) {
      row.source_app = patch.sourceApp;
      row.detected_by = "user";
    }
    if (Object.keys(row).length === 0) return this.get(objectId);
    const updated = await run(this.client.from("imported_objects").update(row).eq("id", objectId).select("*").maybeSingle());
    if (!updated) notFound("imported_object");
    return mapImport(updated);
  }

  async deleteForever(objectId: Uuid): Promise<void> {
    await this.gate();
    if (!isUuid(objectId)) notFound("imported_object");
    const deleted = asRows(await run(this.client.from("imported_objects").delete().eq("id", objectId).select("id")), "imported_objects");
    if (deleted.length > 0) return;
    const existing = await run(this.client.from("imported_objects").select("id").eq("id", objectId).maybeSingle());
    if (!existing) notFound("imported_object");
    throw platformError("invalid_input", { status: 409, detail: "only objects in the trash can be deleted" });
  }
}

// Account ------------------------------------------------------------------------------------------------------------

class SupabaseAccount implements AccountPort {
  constructor(
    private readonly client: SupabaseClient,
    private readonly auth: SupabaseAuth,
  ) {}

  async profile(): Promise<Profile> {
    const session = await this.auth.requireSession();
    const row = await run(this.client.from("profiles").select("*").eq("id", session.user.id).maybeSingle());
    if (!row) notFound("profile");
    return mapProfile(row);
  }

  async updateProfile(patch: ProfilePatch): Promise<Profile> {
    const session = await this.auth.requireSession();
    const row: Record<string, unknown> = {};
    if (patch.username !== undefined) {
      const username = patch.username === null ? null : normalizeUsername(patch.username);
      if (username !== null && !isValidUsername(username)) throw platformError("invalid_input", { status: 422, detail: "username" });
      row.username = username;
    }
    if (patch.displayName !== undefined) row.display_name = patch.displayName === null ? null : patch.displayName.trim() || null;
    if (patch.appearance !== undefined) row.appearance = patch.appearance;
    if (patch.avatarAssetId !== undefined) row.avatar_asset_id = patch.avatarAssetId;
    if (Object.keys(row).length === 0) return this.profile();
    let updated: unknown;
    try {
      updated = await run(this.client.from("profiles").update(row).eq("id", session.user.id).select("*").maybeSingle());
    } catch (error) {
      const mapped = toPlatformError(error);
      // profiles.username is unique: 23505 (mapped to invalid_input/409) means the name is taken
      if (mapped.code === "invalid_input" && mapped.status === 409 && row.username !== undefined) {
        throw platformError("user_exists", { status: 409, detail: "username", cause: error });
      }
      throw mapped;
    }
    if (!updated) notFound("profile");
    return mapProfile(updated);
  }

  async usage(): Promise<Usage> {
    await this.auth.requireSession();
    return mapUsage(await run(this.client.rpc("my_usage")));
  }

  async deleteAccount(confirmation: "DELETE"): Promise<void> {
    if (confirmation !== "DELETE") throw platformError("invalid_input", { status: 400, detail: "confirmation" });
    // account-delete refuses sessions signed in more than ten minutes ago; ask before calling it
    await this.auth.requireFreshSession();
    let result: { data: unknown; error: unknown };
    try {
      result = await this.client.functions.invoke("account-delete", { body: { confirmation } });
    } catch (error) {
      throw toPlatformError(error);
    }
    if (result.error) throw await fromFunctionsError(result.error);
    // the account is gone; forget the session on this device (the server-side sign-out answers 4xx, which is fine)
    try {
      await this.client.auth.signOut({ scope: "local" });
    } catch {
      // nothing left to sign out of
    }
  }
}

// Backend ------------------------------------------------------------------------------------------------------------

export type SupabaseClientFactory = (supabaseUrl: string, supabaseKey: string, options: SupabaseClientOptions<"public">) => SupabaseClient;

export interface SupabaseBackendDeps {
  /** For tests: a client factory (default: supabase-js createClient). */
  createClient?: SupabaseClientFactory;
  /** fetch for supabase-js, uploads and TUS (default: the global fetch). */
  fetch?: typeof fetch;
  /** Where supabase-js keeps the session (default: localStorage under "viscera.platform.auth"). */
  authStorage?: SupportedStorage;
  /** The page location (default: globalThis.location); decides whether a ?code= callback is exchanged. */
  location?: LocationLike | null;
  navigate?: (url: string) => void;
  /** Downloaded-bytes cache (default: IndexedDB "viscera-platform-blobs", 256 MB). */
  blobCache?: BlobCache | null;
  assetOptions?: Omit<AssetPortOptions, "cache">;
  directStorageHost?: boolean;
}

export class SupabaseBackend implements PlatformBackend {
  readonly kind = "supabase" as const;
  readonly client: SupabaseClient;
  readonly auth: SupabaseAuth;
  readonly assets: PlatformAssetPort;
  readonly projects: ProjectPort;
  readonly library: LibraryPort;
  readonly imports: ImportPort;
  readonly account: AccountPort;

  constructor(
    readonly config: SupabasePlatformConfig,
    deps: SupabaseBackendDeps = {},
  ) {
    const location = deps.location === undefined ? (typeof globalThis.location !== "undefined" ? globalThis.location : null) : deps.location;
    const fetchImpl = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const auth: NonNullable<SupabaseClientOptions<"public">["auth"]> = {
      flowType: "pkce",
      storageKey: AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      // exchange a callback only when the URL carries one (PKCE ?code=); a plain visit never touches the URL
      detectSessionInUrl: location !== null && new URLSearchParams(location.search).has("code"),
    };
    if (deps.authStorage) auth.storage = deps.authStorage;
    const factory: SupabaseClientFactory = deps.createClient ?? ((supabaseUrl, supabaseKey, options) => createClient(supabaseUrl, supabaseKey, options));
    this.client = factory(config.supabaseUrl, config.supabaseKey, { auth, global: { fetch: fetchImpl } });

    const authOptions: ConstructorParameters<typeof SupabaseAuth>[2] = { location };
    if (deps.navigate) authOptions.navigate = deps.navigate;
    this.auth = new SupabaseAuth(this.client, config, authOptions);
    const transportOptions: ConstructorParameters<typeof SupabaseTransport>[3] = { fetch: fetchImpl };
    if (deps.directStorageHost !== undefined) transportOptions.directStorageHost = deps.directStorageHost;
    const transport = new SupabaseTransport(this.client, config, this.auth, transportOptions);
    const assetOptions: AssetPortOptions = { ...deps.assetOptions };
    if (deps.blobCache !== undefined) assetOptions.cache = deps.blobCache;
    this.assets = createAssetPort(transport, assetOptions);
    const gate: Gate = () => this.auth.requireSession();
    this.projects = new SupabaseProjects(this.client, gate);
    this.library = new SupabaseLibrary(this.client, gate);
    this.imports = new SupabaseImports(this.client, gate);
    this.account = new SupabaseAccount(this.client, this.auth);
    this.auth.onChange((event) => {
      if (event === "signed_out") this.assets.reset();
    });
  }
}
