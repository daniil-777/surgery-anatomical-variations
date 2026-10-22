// Fixture builders shared by the database suites: unique content, ready assets, projects with versions and drafts,
// library items and imported objects. Every builder goes through the public RPCs as the owner (never around them),
// so a fixture is only ever a state the API itself can produce.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, user, type Row, type TestDb } from "./db";

const CLIENT_TYPES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "studio",
  "src",
  "platform",
  "core",
  "types.ts",
);

/**
 * The string literals of a union type or `as const` array exported by the client's domain types
 * (apps/studio/src/platform/core/types.ts), so the database can be checked against what the client sends.
 */
export function clientLiterals(name: string): string[] {
  const source = readFileSync(CLIENT_TYPES, "utf8");
  const declaration = new RegExp(`export (?:type ${name} =([^;]+);|const ${name} = \\[([^\\]]+)\\] as const;)`).exec(source);
  const body = declaration?.[1] ?? declaration?.[2];
  if (!body) throw new Error(`${name} is not a literal union or const array in types.ts`);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

export interface AssetRef {
  id: string;
  size: number;
  sha: string;
}

export interface Attachment {
  name: string;
  asset_id: string;
}

export interface ProjectRow extends Row {
  id: string;
  owner_id: string;
  lab_id: string;
  title: string;
  description: string;
  head_version_id: string | null;
  head_seq: number;
  draft_asset_id: string | null;
  draft_state_sha256: string | null;
  draft_thumbnail_asset_id: string | null;
  draft_rev: number;
  draft_saved_at: Date | null;
  draft_lab_schema_version: number | null;
  draft_app_build: string | null;
  thumbnail_asset_id: string | null;
  favorite: boolean;
  created_at: Date;
  updated_at: Date;
  opened_at: Date | null;
  trashed_at: Date | null;
}

export interface VersionRow extends Row {
  id: string;
  project_id: string;
  owner_id: string;
  seq: number;
  parent_version_id: string | null;
  kind: string;
  label: string | null;
  snapshot_asset_id: string;
  state_sha256: string;
  thumbnail_asset_id: string | null;
  restored_from_version_id: string | null;
  lab_schema_version: number;
  app_build: string | null;
  byte_size: number;
  created_at: Date;
}

/** commit_version / restore_version answer {project, version}: the rows as JSON (timestamps are ISO strings). */
export interface CommitResult {
  project: Record<string, unknown> & { id: string; head_version_id: string; head_seq: number; draft_rev: number };
  version: Record<string, unknown> & { id: string; seq: number; kind: string };
}

export interface LibraryItemRow extends Row {
  id: string;
  owner_id: string;
  kind: string;
  title: string;
  description: string;
  tags: string[];
  lab_id: string | null;
  source_project_id: string | null;
  source_version_id: string | null;
  metadata: Record<string, unknown>;
  thumbnail_asset_id: string | null;
  favorite: boolean;
  byte_size: number;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
}

export interface LibraryFileInput {
  filename: string;
  asset_id: string;
  role?: string;
  position?: number;
}

export interface ImportedObjectRow extends Row {
  id: string;
  owner_id: string;
  title: string;
  source_app: string;
  source_detail: string | null;
  detected_by: string;
  format: string;
  original_asset_id: string;
  display_asset_id: string | null;
  thumbnail_asset_id: string | null;
  stats: Record<string, unknown>;
  tags: string[];
  favorite: boolean;
  byte_size: number;
  created_at: Date;
  updated_at: Date;
  trashed_at: Date | null;
}

/** The single row of a result, or a test failure that says what was missing. */
export function one<T>(rows: T[], what = "row"): T {
  const [first] = rows;
  if (first === undefined) throw new Error(`expected a ${what}, got none`);
  return first;
}

let contentCounter = 0;

/** Bytes (ASCII text) no other fixture produces, so uploads never deduplicate by accident; exactly `size` long if given. */
export function uniqueContent(label = "content", size?: number): string {
  contentCounter += 1;
  if (size === undefined) return `${contentCounter}:${label}:${randomUUID()}`;
  if (size < 12) throw new Error("uniqueContent needs at least 12 bytes to stay unique");
  const unique = `${contentCounter}:${randomUUID()}`;
  return unique.length >= size ? unique.slice(0, size) : unique.padEnd(size, ".");
}

/** A 64-hex state hash for a label (state_sha256 values are opaque to the database). */
export function stateHash(label: string): string {
  return sha256(`state:${label}`);
}

export async function readyAsset(
  t: TestDb,
  owner: string,
  options: { mime?: string; size?: number; label?: string } = {},
): Promise<AssetRef> {
  const content = uniqueContent(options.label ?? "asset", options.size);
  const id = await t.upload(owner, content, options.mime ?? "application/gzip");
  return { id, size: new TextEncoder().encode(content).byteLength, sha: sha256(content) };
}

/** A reservation that was never uploaded (status pending). */
export async function pendingAsset(t: TestDb, owner: string, mime = "application/gzip"): Promise<AssetRef> {
  const content = uniqueContent("pending");
  const reservation = await t.reserve(owner, content, mime);
  return { id: reservation.asset_id, size: new TextEncoder().encode(content).byteLength, sha: sha256(content) };
}

export async function getProject(t: TestDb, projectId: string): Promise<ProjectRow> {
  return one(await t.admin<ProjectRow>("select * from public.projects where id = $1", [projectId]), "project");
}

export async function getVersion(t: TestDb, versionId: string): Promise<VersionRow> {
  return one(await t.admin<VersionRow>("select * from public.project_versions where id = $1", [versionId]), "version");
}

export async function versionAttachments(t: TestDb, versionId: string): Promise<Attachment[]> {
  return t.admin<Attachment & Row>(
    "select name, asset_id from public.project_version_assets where version_id = $1 order by name",
    [versionId],
  );
}

export async function draftAttachments(t: TestDb, projectId: string): Promise<Attachment[]> {
  return t.admin<Attachment & Row>(
    "select name, asset_id from public.project_draft_assets where project_id = $1 order by name",
    [projectId],
  );
}

export interface CreatedProject {
  project: ProjectRow;
  head: VersionRow;
  snapshot: AssetRef;
  thumbnail: AssetRef | null;
}

export async function createProject(
  t: TestDb,
  owner: string,
  options: {
    title?: string;
    labId?: string;
    description?: string;
    thumbnail?: boolean;
    attachments?: Attachment[];
    snapshot?: AssetRef;
  } = {},
): Promise<CreatedProject> {
  const snapshot = options.snapshot ?? (await readyAsset(t, owner, { label: "snapshot" }));
  const thumbnail = options.thumbnail === false ? null : await readyAsset(t, owner, { label: "thumb", mime: "image/webp" });
  const project = one(
    await t.as<ProjectRow>(
      user(owner),
      `select * from public.create_project(
         p_lab_id => $1, p_title => $2, p_snapshot_asset_id => $3, p_state_sha256 => $4, p_thumbnail_asset_id => $5,
         p_lab_schema_version => 1, p_app_build => 'test', p_attachments => $6, p_description => $7)`,
      [
        options.labId ?? "organ",
        options.title ?? "Liver study",
        snapshot.id,
        stateHash(snapshot.id),
        thumbnail?.id ?? null,
        JSON.stringify(options.attachments ?? []),
        options.description ?? "",
      ],
    ),
    "project",
  );
  const head = await getVersion(t, project.head_version_id ?? "");
  return { project, head, snapshot, thumbnail };
}

export async function commitVersion(
  t: TestDb,
  owner: string,
  projectId: string,
  options: {
    expectedHead?: string | null;
    /** Defaults to the project's current draft revision. */
    expectedDraftRev?: number | null;
    kind?: "autosave" | "manual" | "named";
    label?: string | null;
    thumbnail?: AssetRef | null;
    attachments?: Attachment[];
    snapshot?: AssetRef;
    labSchemaVersion?: number;
    appBuild?: string | null;
  } = {},
): Promise<{ version: VersionRow; project: ProjectRow; result: CommitResult; snapshot: AssetRef }> {
  const current = await getProject(t, projectId);
  const snapshot = options.snapshot ?? (await readyAsset(t, owner, { label: "snapshot" }));
  const { result } = one(
    await t.as<{ result: CommitResult } & Row>(
      user(owner),
      `select public.commit_version(
         p_project_id => $1, p_expected_head_version_id => $2, p_expected_draft_rev => $3, p_kind => $4,
         p_snapshot_asset_id => $5, p_state_sha256 => $6, p_label => $7, p_thumbnail_asset_id => $8, p_attachments => $9,
         p_lab_schema_version => $10, p_app_build => $11) as result`,
      [
        projectId,
        options.expectedHead === undefined ? current.head_version_id : options.expectedHead,
        options.expectedDraftRev === undefined ? current.draft_rev : options.expectedDraftRev,
        options.kind ?? "manual",
        snapshot.id,
        stateHash(snapshot.id),
        options.label ?? null,
        options.thumbnail?.id ?? null,
        JSON.stringify(options.attachments ?? []),
        options.labSchemaVersion ?? 1,
        options.appBuild === undefined ? null : options.appBuild,
      ],
    ),
    "commit result",
  );
  return { version: await getVersion(t, result.version.id), project: await getProject(t, projectId), result, snapshot };
}

/** restore_version as the owner; expected head and draft revision default to the project's current ones. */
export async function restoreVersion(
  t: TestDb,
  owner: string,
  projectId: string,
  versionId: string,
  options: { expectedHead?: string | null; expectedDraftRev?: number | null } = {},
): Promise<{ version: VersionRow; project: ProjectRow; result: CommitResult }> {
  const current = await getProject(t, projectId);
  const { result } = one(
    await t.as<{ result: CommitResult } & Row>(
      user(owner),
      `select public.restore_version(p_project_id => $1, p_version_id => $2, p_expected_head_version_id => $3,
         p_expected_draft_rev => $4) as result`,
      [
        projectId,
        versionId,
        options.expectedHead === undefined ? current.head_version_id : options.expectedHead,
        options.expectedDraftRev === undefined ? current.draft_rev : options.expectedDraftRev,
      ],
    ),
    "restore result",
  );
  return { version: await getVersion(t, result.version.id), project: await getProject(t, projectId), result };
}

export async function saveDraft(
  t: TestDb,
  owner: string,
  projectId: string,
  options: {
    expectedHead?: string | null;
    expectedDraftRev?: number;
    thumbnail?: AssetRef | null;
    attachments?: Attachment[];
    snapshot?: AssetRef;
    labSchemaVersion?: number | null;
    appBuild?: string | null;
  } = {},
): Promise<{ project: ProjectRow; snapshot: AssetRef }> {
  const current = await getProject(t, projectId);
  const snapshot = options.snapshot ?? (await readyAsset(t, owner, { label: "draft" }));
  const project = one(
    await t.as<ProjectRow>(
      user(owner),
      `select * from public.save_draft(
         p_project_id => $1, p_expected_head_version_id => $2, p_expected_draft_rev => $3, p_snapshot_asset_id => $4,
         p_state_sha256 => $5, p_thumbnail_asset_id => $6, p_attachments => $7, p_lab_schema_version => $8,
         p_app_build => $9)`,
      [
        projectId,
        options.expectedHead === undefined ? current.head_version_id : options.expectedHead,
        options.expectedDraftRev ?? current.draft_rev,
        snapshot.id,
        stateHash(snapshot.id),
        options.thumbnail?.id ?? null,
        JSON.stringify(options.attachments ?? []),
        options.labSchemaVersion ?? null,
        options.appBuild ?? null,
      ],
    ),
    "project",
  );
  return { project, snapshot };
}

export async function createLibraryItem(
  t: TestDb,
  owner: string,
  options: {
    kind?: string;
    title?: string;
    files?: LibraryFileInput[];
    tags?: string[];
    thumbnail?: AssetRef | null;
    sourceProjectId?: string | null;
    sourceVersionId?: string | null;
    metadata?: Record<string, unknown>;
    labId?: string | null;
  } = {},
): Promise<LibraryItemRow> {
  const files = options.files ?? [{ filename: "shape.glb", asset_id: (await readyAsset(t, owner, { mime: "model/gltf-binary" })).id, role: "mesh" }];
  return one(
    await t.as<LibraryItemRow>(
      user(owner),
      `select * from public.create_library_item(
         p_kind => $1, p_title => $2, p_files => $3, p_description => '', p_tags => $4, p_lab_id => $5,
         p_source_project_id => $6, p_source_version_id => $7, p_metadata => $8, p_thumbnail_asset_id => $9)`,
      [
        options.kind ?? "shape",
        options.title ?? "Kept liver",
        JSON.stringify(files),
        options.tags ?? [],
        options.labId === undefined ? "organ" : options.labId,
        options.sourceProjectId ?? null,
        options.sourceVersionId ?? null,
        JSON.stringify(options.metadata ?? {}),
        options.thumbnail?.id ?? null,
      ],
    ),
    "library item",
  );
}

export async function createImportedObject(
  t: TestDb,
  owner: string,
  options: {
    title?: string;
    format?: string;
    original?: AssetRef;
    display?: AssetRef | null;
    thumbnail?: AssetRef | null;
    sourceApp?: string;
    tags?: string[];
  } = {},
): Promise<ImportedObjectRow> {
  const original = options.original ?? (await readyAsset(t, owner, { mime: "application/octet-stream", label: "fbx" }));
  return one(
    await t.as<ImportedObjectRow>(
      user(owner),
      `select * from public.create_imported_object(
         p_title => $1, p_format => $2, p_original_asset_id => $3, p_source_app => $4, p_source_detail => 'Blender 4.2',
         p_detected_by => 'metadata', p_display_asset_id => $5, p_thumbnail_asset_id => $6, p_stats => $7, p_tags => $8)`,
      [
        options.title ?? "Imported liver",
        options.format ?? "fbx",
        original.id,
        options.sourceApp ?? "blender",
        options.display?.id ?? null,
        options.thumbnail?.id ?? null,
        JSON.stringify({ meshes: 1, vertices: 8, triangles: 12 }),
        options.tags ?? [],
      ],
    ),
    "imported object",
  );
}

/** Moves a row's trash stamp, as a client would (the trigger normalises it to now()). */
export async function trash(t: TestDb, owner: string, table: "projects" | "library_items" | "imported_objects", id: string): Promise<void> {
  await t.as(user(owner), `update public.${table} set trashed_at = now() where id = $1`, [id]);
}
