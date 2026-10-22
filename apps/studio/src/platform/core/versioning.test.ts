import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabRestoreReport, LabSessionDocument } from "../bridge/labSession";
import { sha256OfBlob } from "./hash";
import { createSnapshotStore, snapshotStateSha256 } from "./snapshot";
import {
  PlatformError,
  type Asset,
  type AssetPort,
  type CommitKind,
  type JsonValue,
  type NamedAttachment,
  type Project,
  type ProjectPatch,
  type ProjectPort,
  type ProjectVersion,
  type SnapshotRef,
  type VersionKind,
} from "./types";
import {
  INEXACT_RESTORE_LABEL,
  ProjectSession,
  SessionError,
  busyGate,
  canonicalJson,
  createIndexedDbJournal,
  createMemoryJournal,
  createProject,
  createProjectLock,
  documentFingerprint,
  installBeforeUnload,
  projectLockName,
  sessionGates,
  shouldWarnBeforeUnload,
  type Connectivity,
  type LabReloadRequest,
  type LocalAttachmentEntry,
  type LocalFileStore,
  type ProjectLock,
  type ProjectSessionOptions,
  type SessionLab,
  type SessionState,
  type SnapshotLoadOptions,
  type SnapshotSaveOptions,
  type SnapshotStore,
  type StoredSnapshot,
} from "./versioning";

// Fakes ---------------------------------------------------------------------------------------------------------------

const now = (): string => new Date(Date.now()).toISOString();
const signal = new AbortController().signal;

type Expected = { headVersionId: string | null; draftRev: number };

/** The project RPCs with the semantics of supabase/migrations …_platform_projects.sql and DESIGN.md §15.2. */
class FakeProjects implements ProjectPort {
  readonly rows = new Map<string, Project>();
  readonly versionRows = new Map<string, ProjectVersion>();
  readonly versionFiles = new Map<string, NamedAttachment[]>();
  readonly draftFiles = new Map<string, NamedAttachment[]>();
  readonly calls: string[] = [];
  /** saveDraft waits for this while set (a slow network). */
  gate: Promise<void> | null = null;
  /** The server's own draft_rev bookkeeping on commit and restore: the session must adopt the project it returns. */
  extraDraftRevOnVersion = 0;
  private readonly failures: Array<{ method: string; error: unknown }> = [];
  private ids = 0;

  failNext(method: string, error: unknown, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ method, error });
  }

  private enter(method: string): void {
    this.calls.push(method);
    const index = this.failures.findIndex((failure) => failure.method === method);
    if (index >= 0) throw this.failures.splice(index, 1)[0]!.error;
  }

  private nextId(prefix: string): string {
    this.ids += 1;
    return `${prefix}-${this.ids}`;
  }

  row(projectId: string): Project {
    const row = this.rows.get(projectId);
    if (!row) throw new PlatformError("not_found", "project", { status: 404 });
    return row;
  }

  private writable(projectId: string): Project {
    const row = this.row(projectId);
    if (row.trashedAt !== null) throw new PlatformError("project_trashed", "restore the project from the trash first", { status: 409 });
    return row;
  }

  private requireExpected(row: Project, expected: Expected): void {
    if (row.headVersionId !== expected.headVersionId) {
      throw new PlatformError("version_conflict", "version_conflict", {
        status: 409,
        detail: JSON.stringify({ head_version_id: row.headVersionId, head_seq: row.headSeq }),
      });
    }
    if (expected.draftRev !== row.draftRev) {
      throw new PlatformError("draft_conflict", "draft_conflict", { status: 409, detail: JSON.stringify({ draft_rev: row.draftRev }) });
    }
  }

  private clearDraft(row: Project): void {
    row.draftAssetId = null;
    row.draftStateSha256 = null;
    row.draftThumbnailAssetId = null;
    row.draftSavedAt = null;
    row.draftRev += 1;
    this.draftFiles.delete(row.id);
  }

  private addVersion(row: Project, kind: VersionKind, snapshot: SnapshotRef, extra: Partial<ProjectVersion> = {}): ProjectVersion {
    const version: ProjectVersion = {
      id: this.nextId("version"),
      projectId: row.id,
      seq: row.headSeq + 1,
      parentVersionId: row.headVersionId,
      kind,
      label: null,
      snapshotAssetId: snapshot.snapshotAssetId,
      stateSha256: snapshot.stateSha256,
      thumbnailAssetId: snapshot.thumbnailAssetId,
      restoredFromVersionId: null,
      labSchemaVersion: snapshot.labSchemaVersion,
      appBuild: snapshot.appBuild,
      byteSize: 0,
      createdAt: now(),
      ...extra,
    };
    this.versionRows.set(version.id, version);
    this.versionFiles.set(version.id, [...snapshot.attachments]);
    row.headVersionId = version.id;
    row.headSeq = version.seq;
    row.updatedAt = version.createdAt;
    row.thumbnailAssetId = snapshot.thumbnailAssetId ?? row.thumbnailAssetId;
    return { ...version };
  }

  async list(): Promise<Project[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async get(projectId: string): Promise<Project> {
    this.enter("get");
    return { ...this.row(projectId) };
  }

  async create(input: { labId: string; title: string; description?: string } & SnapshotRef): Promise<Project> {
    this.enter("create");
    const stamp = now();
    const row: Project = {
      id: this.nextId("project"),
      labId: input.labId,
      title: input.title,
      description: input.description ?? "",
      headVersionId: null,
      headSeq: 0,
      draftAssetId: null,
      draftStateSha256: null,
      draftThumbnailAssetId: null,
      draftRev: 0,
      draftSavedAt: null,
      thumbnailAssetId: input.thumbnailAssetId,
      favorite: false,
      createdAt: stamp,
      updatedAt: stamp,
      openedAt: null,
      trashedAt: null,
    };
    this.rows.set(row.id, row);
    this.addVersion(row, "initial", input);
    return { ...row };
  }

  async update(projectId: string, patch: ProjectPatch): Promise<Project> {
    this.enter("update");
    const row = this.row(projectId);
    if (patch.opened) row.openedAt = now();
    return { ...row };
  }

  async deleteForever(): Promise<void> {
    this.enter("deleteForever");
  }

  async versions(projectId: string): Promise<ProjectVersion[]> {
    this.enter("versions");
    return [...this.versionRows.values()]
      .filter((version) => version.projectId === projectId)
      .sort((a, b) => b.seq - a.seq)
      .map((version) => ({ ...version }));
  }

  async versionAttachments(versionId: string): Promise<NamedAttachment[]> {
    this.enter("versionAttachments");
    return [...(this.versionFiles.get(versionId) ?? [])];
  }

  async draftAttachments(projectId: string): Promise<NamedAttachment[]> {
    this.enter("draftAttachments");
    return [...(this.draftFiles.get(projectId) ?? [])];
  }

  async saveDraft(projectId: string, expected: Expected, snapshot: SnapshotRef): Promise<Project> {
    this.enter("saveDraft");
    if (this.gate) await this.gate;
    const row = this.writable(projectId);
    this.requireExpected(row, expected);
    row.draftAssetId = snapshot.snapshotAssetId;
    row.draftStateSha256 = snapshot.stateSha256;
    row.draftThumbnailAssetId = snapshot.thumbnailAssetId;
    row.draftRev += 1;
    row.draftSavedAt = now();
    row.updatedAt = row.draftSavedAt;
    row.thumbnailAssetId = snapshot.thumbnailAssetId ?? row.thumbnailAssetId;
    this.draftFiles.set(projectId, [...snapshot.attachments]);
    return { ...row };
  }

  async discardDraft(projectId: string): Promise<Project> {
    this.enter("discardDraft");
    const row = this.writable(projectId);
    this.clearDraft(row);
    return { ...row };
  }

  async commit(projectId: string, expected: Expected, kind: CommitKind, snapshot: SnapshotRef, label?: string): Promise<{ project: Project; version: ProjectVersion }> {
    this.enter("commit");
    const row = this.writable(projectId);
    this.requireExpected(row, expected);
    const name = label?.trim() || null;
    if (kind === "named" && name === null) throw new PlatformError("invalid_input", "a named version needs a label", { status: 422 });
    const version = this.addVersion(row, kind, snapshot, { label: name });
    this.clearDraft(row);
    row.draftRev += this.extraDraftRevOnVersion;
    return { project: { ...row }, version };
  }

  async restore(projectId: string, versionId: string, expected: Expected): Promise<{ project: Project; version: ProjectVersion }> {
    this.enter("restore");
    const row = this.writable(projectId);
    this.requireExpected(row, expected);
    const source = this.versionRows.get(versionId);
    if (!source || source.projectId !== projectId) throw new PlatformError("not_found", "version", { status: 404 });
    if (row.draftAssetId !== null) {
      // the draft is kept as an autosave version first, in the same transaction (DESIGN.md §15.2)
      this.addVersion(row, "autosave", {
        snapshotAssetId: row.draftAssetId,
        stateSha256: row.draftStateSha256 ?? "",
        thumbnailAssetId: row.draftThumbnailAssetId,
        attachments: this.draftFiles.get(row.id) ?? [],
        labSchemaVersion: 1,
        appBuild: null,
      });
    }
    const snapshot: SnapshotRef = {
      snapshotAssetId: source.snapshotAssetId,
      stateSha256: source.stateSha256,
      thumbnailAssetId: source.thumbnailAssetId,
      attachments: this.versionFiles.get(source.id) ?? [],
      labSchemaVersion: source.labSchemaVersion,
      appBuild: source.appBuild,
    };
    const version = this.addVersion(row, "restore", snapshot, { restoredFromVersionId: source.id });
    this.clearDraft(row);
    row.draftRev += this.extraDraftRevOnVersion;
    return { project: { ...row }, version };
  }

  async label(versionId: string, label: string | null): Promise<ProjectVersion> {
    this.enter("label");
    const version = this.versionRows.get(versionId)!;
    version.label = label;
    return { ...version };
  }

  async deleteVersion(): Promise<void> {
    this.enter("deleteVersion");
  }

  async duplicate(): Promise<Project> {
    this.enter("duplicate");
    throw new Error("not used");
  }
}

/** Snapshots in memory; local-only attachments are kept as manifest entries only, like snapshot.ts. */
class FakeSnapshots implements SnapshotStore {
  readonly documents = new Map<string, LabSessionDocument>();
  readonly localEntries = new Map<string, Record<string, LocalAttachmentEntry>>();
  readonly saves: Array<{ document: LabSessionDocument; thumbnail: Blob | null; localOnly: readonly string[] | undefined }> = [];
  onSave: (() => void) | null = null;
  private readonly failures: unknown[] = [];
  private ids = 0;

  failNext(error: unknown): void {
    this.failures.push(error);
  }

  async save(document: LabSessionDocument, options: SnapshotSaveOptions): Promise<SnapshotRef> {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.onSave?.();
    this.ids += 1;
    const id = `snapshot-${this.ids}`;
    const local = new Set(options.localOnly ?? []);
    const uploaded: Record<string, Blob> = {};
    const entries: Record<string, LocalAttachmentEntry> = {};
    for (const [name, blob] of Object.entries(document.attachments ?? {})) {
      if (local.has(name)) entries[name] = { sha256: await sha256OfBlob(blob), bytes: blob.size, mime: blob.type };
      else uploaded[name] = blob;
    }
    const copy: LabSessionDocument = { schema: document.schema, labId: document.labId, state: JSON.parse(JSON.stringify(document.state)) as JsonValue };
    if (Object.keys(uploaded).length > 0) copy.attachments = uploaded;
    this.documents.set(id, copy);
    this.localEntries.set(id, entries);
    this.saves.push({ document: copy, thumbnail: options.thumbnail, localOnly: options.localOnly });
    return {
      snapshotAssetId: id,
      stateSha256: this.ids.toString(16).padStart(64, "0"),
      thumbnailAssetId: options.thumbnail ? `thumbnail-${this.ids}` : null,
      attachments: Object.keys(uploaded).map((name) => ({ name, assetId: `${id}-${name}` })),
      labSchemaVersion: 1,
      appBuild: null,
    };
  }

  async load(snapshot: StoredSnapshot, options: SnapshotLoadOptions): Promise<LabSessionDocument> {
    const document = this.documents.get(snapshot.snapshotAssetId);
    if (!document) throw new PlatformError("not_found", "snapshot", { status: 404 });
    const copy: LabSessionDocument = { ...document, state: JSON.parse(JSON.stringify(document.state)) as JsonValue };
    for (const [name, entry] of Object.entries(this.localEntries.get(snapshot.snapshotAssetId) ?? {})) {
      const blob = options.getLocalAttachment ? await options.getLocalAttachment(name, entry) : null;
      if (blob) copy.attachments = { ...(copy.attachments ?? {}), [name]: blob };
    }
    return copy;
  }

  stateOf(snapshotAssetId: string | null | undefined): JsonValue | undefined {
    return snapshotAssetId ? this.documents.get(snapshotAssetId)?.state : undefined;
  }
}

class FakeLab implements SessionLab {
  labId = "organ";
  state: JsonValue = { value: 0 };
  busyReason: false | string = false;
  serializeCalls = 0;
  failSerialize: Error | null = null;
  /** A lab that adds its own fields when it serializes (normalisation after a restore). */
  normalize: ((state: JsonValue) => JsonValue) | null = null;
  /** Attachments (and which of them stay on the device) handed over with every document. */
  attachments: Record<string, Blob> | null = null;
  localOnly: string[] | null = null;
  private readonly listeners = new Set<(kind: "document" | "view") => void>();
  private readonly leaveListeners = new Set<() => void>();

  busy(): false | string {
    return this.busyReason;
  }
  async serialize(): Promise<LabSessionDocument> {
    this.serializeCalls += 1;
    if (this.failSerialize) throw this.failSerialize;
    const state = JSON.parse(JSON.stringify(this.state)) as JsonValue;
    const document: LabSessionDocument = { schema: "viscera.test-session/1", labId: this.labId, state: this.normalize ? this.normalize(state) : state };
    if (this.attachments) document.attachments = { ...this.attachments };
    if (this.localOnly) document.localOnly = [...this.localOnly];
    return document;
  }
  onLeave(listener: () => void): () => void {
    this.leaveListeners.add(listener);
    return () => {
      this.leaveListeners.delete(listener);
    };
  }
  leave(): void {
    for (const listener of [...this.leaveListeners]) listener();
  }
  async thumbnail(): Promise<Blob | null> {
    return new Blob(["still"], { type: "image/webp" });
  }
  onChange(listener: (kind: "document" | "view") => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  emit(kind: "document" | "view" = "document"): void {
    for (const listener of [...this.listeners]) listener(kind);
  }
  edit(value: number, kind: "document" | "view" = "document"): void {
    this.state = { value };
    this.emit(kind);
  }
}

function fakeConnectivity() {
  let online = true;
  const listeners = new Set<(online: boolean) => void>();
  const connectivity: Connectivity = {
    online: () => online,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    connectivity,
    set(value: boolean) {
      online = value;
      for (const listener of [...listeners]) listener(value);
    },
  };
}

/** Assets in memory, content-addressed like the real port: what was uploaded is listed by SHA-256. */
function memoryAssets() {
  const blobs = new Map<string, Blob>();
  const uploaded: string[] = [];
  const port: AssetPort = {
    async put(blob, options) {
      const sha256 = options?.sha256 ?? (await sha256OfBlob(blob));
      const id = `asset-${sha256}`;
      if (!blobs.has(id)) {
        blobs.set(id, blob);
        uploaded.push(sha256);
      }
      const asset: Asset = {
        id,
        sha256,
        byteSize: blob.size,
        mimeType: options?.mimeType ?? "application/octet-stream",
        objectPath: `u/${sha256.slice(0, 2)}/${sha256}`,
        status: "ready",
        createdAt: now(),
      };
      return asset;
    },
    async describe() {
      return [];
    },
    async url(assetId) {
      return `memory:${assetId}`;
    },
    async get(assetId) {
      const blob = blobs.get(assetId);
      if (!blob) throw new PlatformError("not_found", "asset", { status: 404 });
      return blob;
    },
  };
  return { port, uploaded };
}

const labDocument = (value: number, labId = "organ"): LabSessionDocument => ({ schema: "viscera.test-session/1", labId, state: { value } });
const fingerprint = async (document: LabSessionDocument): Promise<string> => canonicalJson(document.state);
const count = (calls: string[], method: string): number => calls.filter((call) => call === method).length;

interface SetupOptions extends Partial<ProjectSessionOptions> {
  draftValue?: number;
  trashed?: boolean;
  /** What the lab reports for the first open. */
  firstReport?: LabRestoreReport;
  prepare?: (fakes: { projects: FakeProjects; snapshots: FakeSnapshots; lab: FakeLab; project: Project }) => Promise<void> | void;
}

async function setup(options: SetupOptions = {}) {
  const { draftValue, trashed, firstReport, prepare, ...sessionOptions } = options;
  const projects = new FakeProjects();
  const snapshots = new FakeSnapshots();
  const lab = new FakeLab();
  const net = fakeConnectivity();
  const initialRef = await snapshots.save(labDocument(0), { thumbnail: null, signal });
  let project = await projects.create({ labId: "organ", title: "Liver study", ...initialRef });
  if (draftValue !== undefined) {
    const draftRef = await snapshots.save(labDocument(draftValue), { thumbnail: null, signal });
    project = await projects.saveDraft(project.id, { headVersionId: project.headVersionId, draftRev: 0 }, draftRef);
  }
  if (trashed) {
    projects.row(project.id).trashedAt = now();
    project = { ...projects.row(project.id) };
  }
  const reloads: LabReloadRequest[] = [];
  const duringReload: { hook: (() => void) | null; report: LabRestoreReport | null } = { hook: null, report: firstReport ?? null };
  const reloadLab = vi.fn(async (request: LabReloadRequest): Promise<LabRestoreReport> => {
    reloads.push(request);
    lab.state = JSON.parse(JSON.stringify(request.document.state)) as JsonValue;
    duringReload.hook?.();
    const report = duringReload.report ?? { exact: true, warnings: [] };
    duringReload.report = null;
    return report;
  });
  await prepare?.({ projects, snapshots, lab, project });
  const session = new ProjectSession({
    projects,
    snapshots,
    lab,
    project,
    reloadLab,
    fingerprint,
    connectivity: net.connectivity,
    stampOpened: false,
    // most tests look at one rule at a time: the 60 s cloud cadence and the journal have their own tests
    draftMinIntervalMs: 0,
    journal: null,
    lock: null,
    ...sessionOptions,
  });
  await session.open();
  projects.calls.length = 0;
  snapshots.saves.length = 0;
  // open() serialized the restored lab once for its baseline (DESIGN.md §15.6)
  lab.serializeCalls = 0;
  return { projects, snapshots, lab, net, session, reloads, reloadLab, duringReload, projectId: project.id };
}

/** Another tab or device writes to the same project behind the session's back. */
async function elsewhere(projects: FakeProjects, snapshots: FakeSnapshots, projectId: string, value: number, action: "draft" | "commit") {
  const row = projects.row(projectId);
  const ref = await snapshots.save(labDocument(value), { thumbnail: null, signal });
  const expected = { headVersionId: row.headVersionId, draftRev: row.draftRev };
  if (action === "draft") await projects.saveDraft(projectId, expected, ref);
  else await projects.commit(projectId, expected, "manual", ref);
  snapshots.saves.pop();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-21T09:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

// Drafts ------------------------------------------------------------------------------------------------------------------

describe("autosave", () => {
  it("opens clean and saves a draft draftIdleMs after the last change", async () => {
    const { lab, projects, snapshots, session, reloads } = await setup();
    expect(reloads[0]).toMatchObject({ reason: "open", version: { kind: "initial", seq: 1 }, document: { state: { value: 0 } }, missingLocal: [] });
    expect(session.getState()).toMatchObject({ status: "clean", pending: false, headSeq: 1, hasDraft: false, draftRev: 0 });
    lab.edit(1);
    expect(session.getState()).toMatchObject({ status: "dirty", pending: true });
    await advance(1_000);
    lab.edit(2);
    await advance(1_999);
    expect(count(projects.calls, "saveDraft")).toBe(0);
    await advance(1);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    expect(snapshots.saves.map((save) => save.document.state)).toEqual([{ value: 2 }]);
    // drafts carry no thumbnail (DESIGN.md §15.5: thumbnails only on commit and close)
    expect(snapshots.saves[0]?.thumbnail).toBeNull();
    expect(session.getState()).toMatchObject({ status: "saved", pending: false, hasDraft: true, draftRev: 1, activity: "idle" });
    expect(session.getState().lastSavedAt).toBe("2026-10-21T09:00:03.000Z");
  });

  it("stores a thumbnail with the draft written on close", async () => {
    const { lab, projects, snapshots, session } = await setup();
    lab.edit(1);
    expect(await session.flush({ close: true })).toBe("saved");
    expect(snapshots.saves.at(-1)?.thumbnail).toBeInstanceOf(Blob);
    // a draft written without one makes the card stale: closing refreshes it even without new changes
    lab.edit(2);
    await advance(2_000);
    expect(snapshots.saves.at(-1)?.thumbnail).toBeNull();
    expect(await session.flush("close")).toBe("saved");
    expect(snapshots.saves.at(-1)?.thumbnail).toBeInstanceOf(Blob);
    expect(count(projects.calls, "saveDraft")).toBe(3);
    // nothing stale, nothing pending: closing writes nothing
    expect(await session.flush("close")).toBe("saved");
    expect(count(projects.calls, "saveDraft")).toBe(3);
    // pagehide and a hidden page save, without a thumbnail
    lab.edit(3);
    expect(await session.flush("pagehide")).toBe("saved");
    expect(snapshots.saves.at(-1)?.thumbnail).toBeNull();
  });

  it("saves at the latest draftMaxWaitMs after the first unsaved change while edits continue", async () => {
    const { lab, projects, snapshots } = await setup();
    for (let second = 1; second <= 20; second++) {
      lab.edit(second);
      await advance(1_000);
    }
    expect(count(projects.calls, "saveDraft")).toBe(1);
    expect(snapshots.saves[0]?.document.state).toEqual({ value: 15 });
    await advance(1_000);
    expect(count(projects.calls, "saveDraft")).toBe(2);
    expect(snapshots.saves[1]?.document.state).toEqual({ value: 20 });
  });

  it("uploads nothing when the state equals what is stored", async () => {
    const { lab, projects, snapshots, session } = await setup();
    lab.emit("document");
    await advance(2_000);
    expect(lab.serializeCalls).toBe(1);
    expect(snapshots.saves).toHaveLength(0);
    expect(session.getState()).toMatchObject({ status: "clean", pending: false });
    lab.edit(1);
    await advance(2_000);
    expect(snapshots.saves).toHaveLength(1);
    lab.edit(2);
    lab.edit(1);
    await advance(2_000);
    expect(snapshots.saves).toHaveLength(1);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    expect(session.getState().status).toBe("saved");
  });

  it("saves changes made while a save is in flight afterwards", async () => {
    const { lab, projects, snapshots, session } = await setup();
    let release!: () => void;
    projects.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saving", activity: "saving" });
    lab.edit(2);
    expect(session.getState()).toMatchObject({ status: "saving", pending: true });
    projects.gate = null;
    release();
    await advance(0);
    expect(session.getState()).toMatchObject({ status: "dirty", pending: true });
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saved", pending: false, draftRev: 2 });
    expect(snapshots.saves.map((save) => save.document.state)).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("never serializes while the lab is busy or recording, and saves once it is idle", async () => {
    const { lab, projects, session } = await setup();
    lab.busyReason = "recording";
    lab.edit(1);
    await advance(10_000);
    expect(lab.serializeCalls).toBe(0);
    expect(session.getState()).toMatchObject({ status: "dirty", activity: "waiting-for-lab", waitingFor: "recording", busyReason: "recording" });
    lab.busyReason = false;
    await advance(500);
    expect(lab.serializeCalls).toBe(1);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    expect(session.getState()).toMatchObject({ status: "saved", activity: "idle", waitingFor: null });
  });

  it("waits again when the lab turns busy between the check and serialize()", async () => {
    const { lab, projects, session } = await setup();
    lab.failSerialize = new Error("busy now");
    const original = lab.serialize.bind(lab);
    lab.serialize = async () => {
      lab.busyReason = "baking";
      return original();
    };
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "dirty", waitingFor: "baking", error: null });
    lab.failSerialize = null;
    lab.serialize = original;
    lab.busyReason = false;
    await advance(500);
    expect(count(projects.calls, "saveDraft")).toBe(1);
  });

  it("reports a lab that cannot serialize, and tries again with the next change", async () => {
    const { lab, projects, session } = await setup();
    lab.failSerialize = new Error("The sculpt buffer is being rebuilt.");
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "error", pending: true, error: { code: "unknown", operation: "draft" } });
    lab.failSerialize = null;
    lab.edit(2);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saved", error: null });
    expect(count(projects.calls, "saveDraft")).toBe(1);
  });

  it("refuses to store another lab's state in the project", async () => {
    const { lab, projects, session } = await setup();
    lab.labId = "scene";
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "error", error: { code: "lab_mismatch" }, failure: { code: "lab_mismatch" } });
    expect(count(projects.calls, "saveDraft")).toBe(0);
  });

  it("flush() saves at once (pagehide, leaving the editor)", async () => {
    const { lab, projects, session } = await setup();
    expect(await session.flush()).toBe("clean");
    lab.edit(1);
    expect(await session.flush()).toBe("saved");
    expect(count(projects.calls, "saveDraft")).toBe(1);
    await advance(30_000);
    expect(count(projects.calls, "saveDraft")).toBe(1);
  });
});

// Checkpoints -------------------------------------------------------------------------------------------------------------

describe("checkpoint versions", () => {
  it("commits an autosave version after checkpointEveryMs of editing", async () => {
    const { lab, projects, session } = await setup({ checkpointEveryMs: 10_000 });
    for (let second = 1; second <= 12; second++) {
      lab.edit(second);
      await advance(1_000);
    }
    expect(session.getState().editingMs).toBe(11_000);
    await advance(1_000);
    expect(count(projects.calls, "saveDraft")).toBe(0);
    expect(count(projects.calls, "commit")).toBe(1);
    const [head] = await projects.versions(session.project.id);
    expect(head).toMatchObject({ kind: "autosave", seq: 2 });
    expect(session.getState()).toMatchObject({ status: "saved", headSeq: 2, hasDraft: false, editingMs: 0, pending: false });
  });

  it("turns a stored draft into a version when the checkpoint falls on an unchanged state", async () => {
    const { lab, projects, snapshots, session } = await setup({ checkpointEveryMs: 3_000 });
    lab.edit(1);
    await advance(1_000);
    lab.edit(2);
    await advance(2_000);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    lab.edit(2);
    await advance(1_500);
    lab.emit("document");
    await advance(2_000);
    expect(session.getState().editingMs).toBe(0);
    expect(count(projects.calls, "commit")).toBe(1);
    // the version carries a thumbnail, so the unchanged state goes out once more with it (content-addressed: no new bytes)
    expect(snapshots.saves.map((save) => [save.document.state, save.thumbnail instanceof Blob])).toEqual([
      [{ value: 2 }, false],
      [{ value: 2 }, true],
    ]);
    expect((await projects.versions(session.project.id))[0]).toMatchObject({ kind: "autosave", snapshotAssetId: "snapshot-3", thumbnailAssetId: "thumbnail-3" });
  });

  it("gives view changes drafts but no checkpoint credit", async () => {
    const { lab, projects, session } = await setup({ checkpointEveryMs: 5_000 });
    for (let second = 1; second <= 30; second++) {
      lab.edit(second, "view");
      await advance(1_000);
    }
    await advance(5_000);
    expect(count(projects.calls, "commit")).toBe(0);
    expect(count(projects.calls, "saveDraft")).toBe(2);
    expect(session.getState()).toMatchObject({ editingMs: 0, status: "saved" });
  });

  it("counts at most editingGapMs for one pause between edits", async () => {
    const { lab, session } = await setup({ editingGapMs: 5_000 });
    lab.edit(1);
    await advance(3_000);
    lab.edit(2);
    await advance(3_600_000);
    lab.edit(3);
    expect(session.getState().editingMs).toBe(8_000);
  });
});

// Explicit versions ------------------------------------------------------------------------------------------------------

describe("manual and named versions", () => {
  it("⌘S commits pending changes as a manual version and is a no-op without changes", async () => {
    const { lab, projects, snapshots, session } = await setup();
    lab.edit(5);
    const version = await session.saveNow();
    expect(version).toMatchObject({ kind: "manual", seq: 2, label: null });
    // commit_version checks the head and the draft revision itself: one request
    expect(projects.calls).toEqual(["commit"]);
    expect(snapshots.saves.at(-1)?.document.state).toEqual({ value: 5 });
    expect(snapshots.saves.at(-1)?.thumbnail).toBeInstanceOf(Blob);
    expect(session.getState()).toMatchObject({ status: "saved", headSeq: 2, hasDraft: false, pending: false, draftRev: 1 });
    await advance(20_000);
    expect(count(projects.calls, "saveDraft")).toBe(0);
    expect(await session.saveNow()).toBeNull();
    expect(count(projects.calls, "commit")).toBe(1);
  });

  it("⌘S after an autosaved draft commits the draft's state", async () => {
    const { lab, projects, session } = await setup();
    lab.edit(4);
    await advance(2_000);
    expect(session.getState().hasDraft).toBe(true);
    const version = await session.commit("manual");
    expect(version).toMatchObject({ kind: "manual", seq: 2 });
    expect(projects.row(session.project.id)).toMatchObject({ draftAssetId: null, draftRev: 2 });
    expect(session.getState()).toMatchObject({ hasDraft: false, draftRev: 2 });
    lab.edit(5);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saved", draftRev: 3 });
  });

  it("⇧⌘S always commits a named version, and needs a name", async () => {
    const { projects, session } = await setup();
    await expect(session.saveNamed("  ")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(session.commit("named", "x".repeat(121))).rejects.toMatchObject({ code: "invalid_input" });
    const version = await session.saveNamed("  Liver baseline ");
    expect(version).toMatchObject({ kind: "named", label: "Liver baseline", seq: 2 });
    expect(count(projects.calls, "commit")).toBe(1);
  });

  it("waits for a busy lab before committing, up to busyTimeoutMs", async () => {
    const { lab, session } = await setup({ busyTimeoutMs: 5_000 });
    lab.edit(1);
    lab.busyReason = "exporting";
    const waiting = session.commit("manual");
    await advance(1_000);
    expect(session.getState()).toMatchObject({ activity: "waiting-for-lab", waitingFor: "exporting" });
    lab.busyReason = false;
    await advance(500);
    expect(await waiting).toMatchObject({ kind: "manual" });
    lab.edit(2);
    lab.busyReason = "recording";
    const refused = session.commit("manual").catch((error: unknown) => error);
    await advance(5_000);
    expect(await refused).toMatchObject({ code: "lab_busy" });
    expect(session.getState()).toMatchObject({ status: "error", pending: true });
  });
});

// DESIGN.md §15.2: commit and restore name the draft revision and return the project --------------------------------------

describe("versions return the project", () => {
  it("adopts the project ⌘S and checkpoints return, so the next draft never conflicts", async () => {
    const { lab, projects, session, projectId } = await setup({ checkpointEveryMs: 3_000 });
    projects.extraDraftRevOnVersion = 5;
    lab.edit(1);
    await session.saveNow();
    expect(projects.row(projectId).draftRev).toBe(6);
    expect(session.getState()).toMatchObject({ draftRev: 6, headSeq: 2, status: "saved" });
    lab.edit(2);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saved", conflict: null, draftRev: 7, hasDraft: true });
    // a checkpoint (autosave version), then a draft again
    for (let second = 0; second < 4; second++) {
      lab.edit(10 + second);
      await advance(1_000);
    }
    await advance(2_000);
    expect(count(projects.calls, "commit")).toBe(2);
    lab.edit(20);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saved", conflict: null, draftRev: projects.row(projectId).draftRev });
    expect(count(projects.calls, "get")).toBe(0);
  });

  it("refuses to commit over a draft another device saved, and keeps that draft", async () => {
    const { lab, projects, snapshots, session, projectId } = await setup();
    await elsewhere(projects, snapshots, projectId, 42, "draft");
    projects.calls.length = 0;
    lab.edit(1);
    await expect(session.saveNow()).rejects.toMatchObject({ code: "draft_conflict" });
    expect(projects.calls).toEqual(["commit"]);
    expect(session.getState()).toMatchObject({ status: "conflict", conflict: { kind: "draft", operation: "commit", remoteDraftRev: 1 } });
    expect(snapshots.stateOf(projects.row(projectId).draftAssetId)).toEqual({ value: 42 });
  });

  it("leaves keeping an autosaved draft to restore_version, with nothing uploaded again", async () => {
    const { lab, projects, snapshots, session, projectId } = await setup();
    const initial = session.getState().headVersionId!;
    lab.edit(4);
    await advance(2_000);
    projects.calls.length = 0;
    snapshots.saves.length = 0;
    const restored = await session.restore(initial);
    expect(projects.calls.slice(0, 2)).toEqual(["restore", "versionAttachments"]);
    expect(snapshots.saves).toHaveLength(0);
    const versions = await projects.versions(projectId);
    expect(versions.map((version) => [version.seq, version.kind])).toEqual([
      [3, "restore"],
      [2, "autosave"],
      [1, "initial"],
    ]);
    expect(snapshots.stateOf(versions[1]?.snapshotAssetId)).toEqual({ value: 4 });
    expect(restored).toMatchObject({ kind: "restore", restoredFromVersionId: initial });
    expect(session.getState()).toMatchObject({ status: "saved", headSeq: 3, hasDraft: false, draftRev: projects.row(projectId).draftRev });
  });

  it("puts unsaved work into the draft before restoring, so the server keeps it", async () => {
    const { lab, projects, snapshots, session, projectId } = await setup();
    const initial = session.getState().headVersionId!;
    lab.edit(3);
    await session.restore(initial);
    expect(projects.calls.slice(0, 2)).toEqual(["saveDraft", "restore"]);
    expect(snapshots.saves.map((save) => [save.document.state, save.thumbnail])).toEqual([[{ value: 3 }, null]]);
    const [restore, kept] = await projects.versions(projectId);
    expect(restore).toMatchObject({ kind: "restore", seq: 3 });
    expect(kept).toMatchObject({ kind: "autosave", seq: 2 });
    expect(snapshots.stateOf(kept?.snapshotAssetId)).toEqual({ value: 3 });
    expect(lab.state).toEqual({ value: 0 });
  });

  it("stops a restore that meets another device's draft, and overwrite keeps that draft first", async () => {
    const { projects, snapshots, session, projectId, reloads } = await setup();
    const initial = session.getState().headVersionId!;
    await elsewhere(projects, snapshots, projectId, 77, "draft");
    await expect(session.restore(initial)).rejects.toMatchObject({ code: "draft_conflict" });
    expect(session.getState()).toMatchObject({ status: "conflict", conflict: { kind: "draft", operation: "restore" } });
    await session.overwrite();
    const versions = await projects.versions(projectId);
    expect(versions.map((version) => version.kind)).toEqual(["restore", "autosave", "initial"]);
    expect(snapshots.stateOf(versions[1]?.snapshotAssetId)).toEqual({ value: 77 });
    expect(reloads.at(-1)).toMatchObject({ reason: "restore", document: { state: { value: 0 } } });
    expect(session.getState()).toMatchObject({ status: "saved", conflict: null });
  });
});

// Conflicts -------------------------------------------------------------------------------------------------------------

describe("conflicts", () => {
  it("stops on a draft saved by another tab and reloads the server's state on request", async () => {
    const { lab, projects, snapshots, session, reloads, projectId } = await setup();
    await elsewhere(projects, snapshots, projectId, 99, "draft");
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({
      status: "conflict",
      pending: true,
      conflict: { kind: "draft", operation: "draft", remoteDraftRev: 1 },
      error: { code: "draft_conflict" },
    });
    const saves = count(projects.calls, "saveDraft");
    lab.edit(2);
    await advance(60_000);
    expect(count(projects.calls, "saveDraft")).toBe(saves);
    await expect(session.commit("manual")).rejects.toBeInstanceOf(SessionError);
    await session.reloadRemote();
    expect(reloads.at(-1)).toMatchObject({ reason: "remote", version: null, document: { state: { value: 99 } } });
    expect(lab.state).toEqual({ value: 99 });
    expect(session.getState()).toMatchObject({ status: "clean", pending: false, conflict: null, error: null, draftRev: 1, hasDraft: true });
    lab.edit(100);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saved", draftRev: 2 });
  });

  it("saveAsCopy keeps this tab's state as a new project and continues there", async () => {
    const { lab, projects, snapshots, session, projectId } = await setup();
    await elsewhere(projects, snapshots, projectId, 99, "draft");
    lab.edit(1);
    await advance(2_000);
    expect(session.getState().status).toBe("conflict");
    const copy = await session.saveAsCopy("  Liver study (copy) ");
    expect(copy).toMatchObject({ title: "Liver study (copy)", labId: "organ", headSeq: 1 });
    expect(session.project.id).toBe(copy.id);
    expect(session.getState()).toMatchObject({ status: "saved", projectId: copy.id, headSeq: 1, conflict: null, pending: false });
    const [head] = await projects.versions(copy.id);
    expect(snapshots.stateOf(head?.snapshotAssetId)).toEqual({ value: 1 });
    expect(snapshots.stateOf(projects.row(projectId).draftAssetId)).toEqual({ value: 99 });
    lab.edit(3);
    await advance(2_000);
    expect(projects.row(copy.id).draftRev).toBe(1);
    await expect(session.saveAsCopy("")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("overwrite keeps the other side's draft as an autosave version, then saves this tab's state", async () => {
    const { lab, projects, snapshots, session, projectId } = await setup();
    await elsewhere(projects, snapshots, projectId, 99, "draft");
    lab.edit(1);
    await advance(2_000);
    snapshots.saves.length = 0;
    await session.overwrite();
    const versions = await projects.versions(projectId);
    expect(versions.map((version) => version.kind)).toEqual(["autosave", "initial"]);
    // their draft is committed by reference (its stored files) and ours was uploaded by the attempt that met the
    // conflict: the overwrite uploads nothing
    expect(snapshots.stateOf(versions[0]?.snapshotAssetId)).toEqual({ value: 99 });
    expect(snapshots.saves).toHaveLength(0);
    expect(snapshots.stateOf(projects.row(projectId).draftAssetId)).toEqual({ value: 1 });
    expect(session.getState()).toMatchObject({ status: "saved", conflict: null, pending: false, headSeq: 2, hasDraft: true });
  });

  it("overwrite repeats a commit that met a newer version", async () => {
    const { lab, projects, snapshots, session, projectId } = await setup();
    await elsewhere(projects, snapshots, projectId, 42, "commit");
    lab.edit(1);
    await expect(session.commit("named", "Mine")).rejects.toMatchObject({ code: "version_conflict" });
    expect(session.getState()).toMatchObject({ status: "conflict", conflict: { kind: "version", operation: "commit", remoteHeadSeq: 2 } });
    await session.overwrite();
    const [head, theirs] = await projects.versions(projectId);
    expect(head).toMatchObject({ kind: "named", label: "Mine", seq: 3 });
    expect(snapshots.stateOf(head?.snapshotAssetId)).toEqual({ value: 1 });
    expect(snapshots.stateOf(theirs?.snapshotAssetId)).toEqual({ value: 42 });
    expect(session.getState()).toMatchObject({ status: "saved", headSeq: 3 });
  });
});

// Network ------------------------------------------------------------------------------------------------------------------

describe("offline and failures", () => {
  it("keeps the captured state while offline and retries with backoff, even after the lab went away", async () => {
    const { lab, projects, snapshots, session } = await setup();
    projects.failNext("saveDraft", new PlatformError("network", "Failed to fetch"), 2);
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "offline", pending: true, error: { code: "network", operation: "draft" } });
    expect(session.getState().retryAt).toBe(Date.now() + 1_000);
    // the lab iframe is gone (reloading): only the captured state can still be saved
    lab.busyReason = "loading";
    lab.edit(2);
    expect(session.getState().status).toBe("offline");
    await advance(1_000);
    expect(count(projects.calls, "saveDraft")).toBe(2);
    expect(session.getState().status).toBe("offline");
    await advance(2_000);
    expect(count(projects.calls, "saveDraft")).toBe(3);
    expect(lab.serializeCalls).toBe(1);
    expect(snapshots.saves).toHaveLength(1);
    expect(snapshots.stateOf(projects.row(session.project.id).draftAssetId)).toEqual({ value: 1 });
    // the later edit is still pending and is saved once the lab is back
    expect(session.getState()).toMatchObject({ status: "dirty", pending: true });
    lab.busyReason = false;
    await advance(2_500);
    expect(session.getState()).toMatchObject({ status: "saved", pending: false });
    expect(snapshots.stateOf(projects.row(session.project.id).draftAssetId)).toEqual({ value: 2 });
  });

  it("retries at once when the browser is back online", async () => {
    const { lab, net, projects, session } = await setup({ retryDelaysMs: [60_000] });
    projects.failNext("saveDraft", new PlatformError("network", "Failed to fetch"));
    lab.edit(1);
    await advance(2_000);
    expect(session.getState().status).toBe("offline");
    net.set(true);
    await advance(0);
    expect(session.getState()).toMatchObject({ status: "saved", retryAt: null, error: null });
  });

  it("treats any failure as offline while the browser says so", async () => {
    const { lab, net, snapshots, session } = await setup();
    net.set(false);
    snapshots.failNext(new TypeError("Load failed"));
    lab.edit(1);
    await advance(2_000);
    expect(session.getState().status).toBe("offline");
    net.set(true);
    await advance(0);
    expect(session.getState().status).toBe("saved");
  });

  it("flush() tries again at once while offline", async () => {
    const { lab, projects, session } = await setup({ retryDelaysMs: [60_000] });
    projects.failNext("saveDraft", new PlatformError("network", "Failed to fetch"));
    lab.edit(1);
    expect(await session.flush()).toBe("offline");
    expect(await session.flush()).toBe("saved");
  });

  it("retries server errors a bounded number of times, then reports them until retry()", async () => {
    const { lab, projects, session } = await setup({ transientRetries: 2, retryDelaysMs: [1_000] });
    projects.failNext("saveDraft", new PlatformError("unknown", "Service Unavailable", { status: 503 }), 3);
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "dirty", error: { code: "unknown", status: 503 } });
    await advance(1_000);
    await advance(1_000);
    expect(session.getState()).toMatchObject({ status: "error", retryAt: null });
    await advance(60_000);
    expect(count(projects.calls, "saveDraft")).toBe(3);
    await session.retry();
    expect(session.getState()).toMatchObject({ status: "saved", error: null });
  });

  it("retries a reservation that is being collected (asset_busy)", async () => {
    const { lab, projects, session } = await setup({ retryDelaysMs: [1_000] });
    projects.failNext("saveDraft", new PlatformError("asset_busy", "asset_busy", { status: 409 }));
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "dirty", error: { code: "asset_busy" } });
    await advance(1_000);
    expect(session.getState()).toMatchObject({ status: "saved", error: null });
  });

  it("reports permanent errors at once and saves again with the next change", async () => {
    const { lab, projects, session } = await setup();
    projects.failNext("saveDraft", new PlatformError("quota_exceeded", "Your storage is full.", { status: 413 }));
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "error", retryAt: null, error: { code: "quota_exceeded", message: "Your storage is full." } });
    await advance(60_000);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    lab.edit(2);
    expect(session.getState().status).toBe("error");
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saved", error: null });
  });

  it("becomes read-only when the project is moved to the Trash elsewhere, and can still save a copy", async () => {
    const { lab, projects, session, projectId } = await setup();
    projects.row(projectId).trashedAt = now();
    lab.edit(1);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "readonly", pending: true, error: { code: "project_trashed" } });
    await expect(session.commit("manual")).rejects.toMatchObject({ code: "project_trashed" });
    lab.edit(2);
    await advance(30_000);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    const copy = await session.saveAsCopy("Rescued study");
    expect(session.getState()).toMatchObject({ status: "saved", projectId: copy.id, pending: false });
  });
});

// Restore and open -----------------------------------------------------------------------------------------------------

describe("restore and open", () => {
  it("restores a version without losing the work in progress", async () => {
    const { lab, projects, snapshots, session, reloads } = await setup();
    const initial = session.getState().headVersionId!;
    lab.edit(2);
    await session.commit("named", "Two");
    lab.edit(3);
    const restored = await session.restore(initial);
    const versions = await projects.versions(session.project.id);
    expect(versions.map((version) => [version.seq, version.kind])).toEqual([
      [4, "restore"],
      [3, "autosave"],
      [2, "named"],
      [1, "initial"],
    ]);
    expect(snapshots.stateOf(versions[1]?.snapshotAssetId)).toEqual({ value: 3 });
    expect(restored).toMatchObject({ kind: "restore", restoredFromVersionId: initial, seq: 4 });
    expect(reloads.at(-1)).toMatchObject({ reason: "restore", version: { id: restored.id }, document: { state: { value: 0 } } });
    expect(lab.state).toEqual({ value: 0 });
    expect(session.getState()).toMatchObject({
      status: "saved",
      headSeq: 4,
      hasDraft: false,
      pending: false,
      lastRestore: { exact: true, warnings: [] },
    });
    // the restored state is what is stored: nothing to upload until the next real edit
    lab.emit("document");
    await advance(2_000);
    expect(count(projects.calls, "saveDraft")).toBe(1);
  });

  it("ignores changes the lab emits while it is being reloaded", async () => {
    const { lab, projects, session, duringReload } = await setup();
    lab.edit(1);
    await advance(2_000);
    duringReload.hook = () => lab.edit(55);
    await session.restore(session.getState().headVersionId!);
    duringReload.hook = null;
    await advance(10_000);
    expect(session.getState()).toMatchObject({ status: "saved", pending: false });
    expect(count(projects.calls, "saveDraft")).toBe(1);
  });

  it("never restores twice when only showing the restored version failed", async () => {
    const { session, projects, reloadLab } = await setup();
    reloadLab.mockRejectedValueOnce(new Error("The lab did not load."));
    await expect(session.restore(session.getState().headVersionId!)).rejects.toThrow(/did not load/);
    expect(session.getState()).toMatchObject({ status: "error", error: { operation: "reload" }, headSeq: 2, labLeft: true });
    await session.retry();
    expect(count(projects.calls, "restore")).toBe(1);
    expect(session.getState()).toMatchObject({ status: "clean", headSeq: 2, labLeft: false });
  });

  it("reports a restore that failed offline to its caller and never repeats it on its own", async () => {
    const { lab, net, projects, session } = await setup();
    const initial = session.getState().headVersionId!;
    lab.edit(2);
    await session.commit("manual");
    projects.failNext("restore", new PlatformError("network", "Failed to fetch"));
    await expect(session.restore(initial)).rejects.toMatchObject({ code: "network" });
    expect(session.getState()).toMatchObject({ status: "saved", retryAt: null, error: { code: "network", operation: "restore" }, headSeq: 2 });
    net.set(true);
    await advance(120_000);
    expect(count(projects.calls, "restore")).toBe(1);
    lab.edit(3);
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saved", error: null, hasDraft: true });
  });

  it("retries a project that could not be opened and shows it once the server answers", async () => {
    const projects = new FakeProjects();
    const snapshots = new FakeSnapshots();
    const lab = new FakeLab();
    const ref = await snapshots.save(labDocument(4), { thumbnail: null, signal });
    const project = await projects.create({ labId: "organ", title: "Liver study", ...ref });
    projects.failNext("versions", new PlatformError("unknown", "Bad Gateway", { status: 502 }));
    const reloadLab = vi.fn(async (request: LabReloadRequest) => {
      lab.state = request.document.state;
    });
    const session = new ProjectSession({ projects, snapshots, lab, project, reloadLab, fingerprint, connectivity: null, retryDelaysMs: [1_000], journal: null });
    await expect(session.open()).rejects.toMatchObject({ status: 502 });
    expect(session.getState()).toMatchObject({ status: "error", error: { operation: "reload" } });
    expect(session.getState().retryAt).not.toBeNull();
    await advance(1_000);
    expect(reloadLab).toHaveBeenCalledTimes(1);
    expect(lab.state).toEqual({ value: 4 });
    expect(session.getState()).toMatchObject({ status: "clean", error: null, retryAt: null });
  });

  it("open() shows the draft when there is one and stamps opened_at", async () => {
    const { reloads, session, projects } = await setup({ draftValue: 7, stampOpened: true });
    expect(reloads[0]).toMatchObject({ reason: "open", version: null, document: { state: { value: 7 } } });
    expect(session.getState()).toMatchObject({ status: "clean", hasDraft: true, draftRev: 1 });
    expect(projects.row(session.project.id).openedAt).not.toBeNull();
  });

  it("does not save a lab that has not shown the project yet", async () => {
    const projects = new FakeProjects();
    const snapshots = new FakeSnapshots();
    const lab = new FakeLab();
    const ref = await snapshots.save(labDocument(0), { thumbnail: null, signal });
    const project = await projects.create({ labId: "organ", title: "Liver study", ...ref });
    const session = new ProjectSession({ projects, snapshots, lab, project, reloadLab: async () => undefined, fingerprint, connectivity: null, journal: null });
    lab.edit(9);
    await advance(30_000);
    expect(lab.serializeCalls).toBe(0);
    expect(session.getState()).toMatchObject({ status: "clean", pending: false });
  });

  it("keeps a trashed project read-only", async () => {
    const { lab, projects, session } = await setup({ trashed: true });
    expect(session.getState().status).toBe("readonly");
    lab.edit(1);
    await advance(30_000);
    expect(count(projects.calls, "saveDraft")).toBe(0);
    await expect(session.commit("manual")).rejects.toMatchObject({ code: "project_trashed" });
    await expect(session.restore("version-1")).rejects.toMatchObject({ code: "project_trashed" });
  });
});

describe("documents of another lab", () => {
  it("never shows a stored document of another lab in the project", async () => {
    const projects = new FakeProjects();
    const snapshots = new FakeSnapshots();
    const lab = new FakeLab();
    const ref = await snapshots.save(labDocument(3, "scene"), { thumbnail: null, signal });
    const project = await projects.create({ labId: "organ", title: "Mixed up", ...ref });
    const reloadLab = vi.fn(async () => undefined);
    const session = new ProjectSession({ projects, snapshots, lab, project, reloadLab, fingerprint, connectivity: null, journal: null, lock: null });
    await expect(session.open()).rejects.toMatchObject({ code: "lab_mismatch" });
    expect(reloadLab).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({ status: "error", failure: { code: "lab_mismatch", operation: "reload" } });
  });

  it("drops a journal entry whose document belongs to another lab", async () => {
    const journal = createMemoryJournal();
    const { session, projectId } = await setup({
      journal,
      prepare: async ({ project }) => {
        await journal.write({
          projectId: project.id,
          labId: "organ",
          document: labDocument(5, "scene"),
          fingerprint: "other",
          savedAt: Date.now(),
          baseHeadVersionId: project.headVersionId,
          baseDraftRev: project.draftRev,
        });
      },
    });
    expect(session.getState().recoverable).toBeNull();
    expect(await journal.read(projectId)).toBeNull();
  });
});

// Creation and lifetime ----------------------------------------------------------------------------------------------------

describe("creation and disposal", () => {
  it("creates a project from the guest lab and continues saving into it", async () => {
    const projects = new FakeProjects();
    const snapshots = new FakeSnapshots();
    const lab = new FakeLab();
    lab.state = { value: 7 };
    // an edit while the snapshot uploads must still reach the new project
    snapshots.onSave = () => {
      snapshots.onSave = null;
      lab.edit(8);
    };
    const session = await ProjectSession.createProject({
      projects,
      snapshots,
      lab,
      labId: "organ",
      title: "  Untitled Organ Design Project ",
      reloadLab: async () => undefined,
      fingerprint,
      connectivity: null,
      journal: null,
    });
    expect(session.project).toMatchObject({ title: "Untitled Organ Design Project", labId: "organ", headSeq: 1 });
    expect(snapshots.saves[0]?.document.state).toEqual({ value: 7 });
    expect(snapshots.saves[0]?.thumbnail).toBeInstanceOf(Blob);
    expect(session.getState()).toMatchObject({ status: "dirty", pending: true });
    await advance(2_000);
    expect(session.getState()).toMatchObject({ status: "saved", draftRev: 1 });
    expect(snapshots.stateOf(projects.row(session.project.id).draftAssetId)).toEqual({ value: 8 });
  });

  it("takes the lab and its dependencies apart: createProject(labId, title, lab, deps)", async () => {
    const projects = new FakeProjects();
    const snapshots = new FakeSnapshots();
    const lab = new FakeLab();
    lab.state = { value: 2 };
    const deps = { projects, snapshots, reloadLab: async () => undefined, fingerprint, connectivity: null, journal: null };
    const fromStatic = await ProjectSession.createProject("organ", "Static", lab, deps);
    const fromFunction = await createProject("organ", "Function", lab, deps);
    expect([fromStatic.project.title, fromFunction.project.title]).toEqual(["Static", "Function"]);
    expect(fromFunction.getState()).toMatchObject({ status: "saved", headSeq: 1, labId: "organ" });
    await expect(createProject("organ", "", lab, deps)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses to create a project from another lab's state", async () => {
    const lab = new FakeLab();
    lab.labId = "scene";
    await expect(
      ProjectSession.createProject({
        projects: new FakeProjects(),
        snapshots: new FakeSnapshots(),
        lab,
        labId: "organ",
        title: "Organ",
        reloadLab: async () => undefined,
        fingerprint,
        connectivity: null,
      }),
    ).rejects.toMatchObject({ code: "lab_mismatch" });
  });

  it("dispose stops timers, unsubscribes and refuses later work", async () => {
    const { lab, net, projects, session } = await setup();
    const listener = vi.fn();
    session.subscribe(listener);
    lab.edit(1);
    listener.mockClear();
    session.dispose();
    expect(lab.listenerCount).toBe(0);
    lab.edit(2);
    lab.busyReason = "running";
    net.set(true);
    await advance(60_000);
    expect(lab.serializeCalls).toBe(0);
    expect(projects.calls).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    await expect(session.commit("manual")).rejects.toMatchObject({ code: "disposed" });
    await expect(session.open()).rejects.toMatchObject({ code: "disposed" });
    expect(await session.flush()).toBe("dirty");
    session.dispose();
  });

  it("notifies subscribers only when the state changes", async () => {
    const { lab, session } = await setup();
    const statuses: string[] = [];
    const unsubscribe = session.subscribe((state) => statuses.push(`${state.status}/${state.activity}`));
    lab.edit(1);
    // a second edit at the same moment changes nothing a subscriber can see
    lab.edit(2);
    await advance(2_000);
    unsubscribe();
    lab.edit(3);
    expect(statuses).toEqual(["dirty/idle", "saving/saving", "saved/idle"]);
  });
});

// DESIGN.md §15.5–15.6 -------------------------------------------------------------------------------------------------

function fakeLock(held: boolean, acquirable = held) {
  const lost = new Set<() => void>();
  let isHeld = held;
  const lock: ProjectLock = {
    name: "viscera.project:test",
    held: () => isHeld,
    acquire: async () => {
      if (acquirable) isHeld = true;
      return isHeld;
    },
    takeOver: async () => {
      isHeld = true;
    },
    onLost(listener) {
      lost.add(listener);
      return () => {
        lost.delete(listener);
      };
    },
    release: () => {
      isHeld = false;
    },
  };
  return {
    lock,
    steal() {
      isHeld = false;
      for (const listener of [...lost]) listener();
    },
  };
}

describe("cloud cadence", () => {
  it("writes the cloud draft at most once per draftMinIntervalMs while editing continues", async () => {
    const { lab, projects, snapshots, session } = await setup({ draftMinIntervalMs: 60_000 });
    for (let second = 0; second < 130; second++) {
      lab.edit(second + 1);
      await advance(1_000);
    }
    // the first burst goes out at draftMaxWaitMs (15 s), the next one 60 s later
    expect(snapshots.saves.map((save) => save.document.state)).toEqual([{ value: 15 }, { value: 75 }]);
    await advance(6_000);
    expect(count(projects.calls, "saveDraft")).toBe(3);
    // an explicit flush does not wait for the cadence
    lab.edit(500);
    expect(await session.flush()).toBe("saved");
    expect(snapshots.saves.at(-1)?.document.state).toEqual({ value: 500 });
  });

  it("writes nothing to the cloud while the state hash is unchanged, however long edits go on", async () => {
    const { lab, projects, session } = await setup({ draftMinIntervalMs: 60_000 });
    for (let second = 0; second < 200; second++) {
      // the lab reports changes, but its document is the stored one
      lab.emit(second % 2 === 0 ? "document" : "view");
      await advance(1_000);
    }
    await advance(2_000);
    expect(count(projects.calls, "saveDraft")).toBe(0);
    expect(session.getState()).toMatchObject({ status: "clean", pending: false });
  });
});

describe("local journal", () => {
  it("journals every change on this device and drops the entry once the cloud has it", async () => {
    const journal = createMemoryJournal();
    const { lab, session, projectId } = await setup({ journal });
    lab.edit(1);
    expect(session.getState().localCopy).toBe("pending");
    await advance(999);
    expect(await journal.read(projectId)).toBeNull();
    await advance(1);
    const entry = await journal.read(projectId);
    expect(entry).toMatchObject({ projectId, labId: "organ", document: { state: { value: 1 } }, baseDraftRev: 0 });
    expect(session.getState()).toMatchObject({ localCopy: "saved", status: "dirty" });
    await advance(1_000);
    expect(session.getState().status).toBe("saved");
    expect(await journal.read(projectId)).toBeNull();
  });

  it("keeps the newest state on the device while offline", async () => {
    const journal = createMemoryJournal();
    const { lab, projects, session, projectId } = await setup({ journal, retryDelaysMs: [60_000] });
    projects.failNext("saveDraft", new PlatformError("network", "Failed to fetch"), 5);
    lab.edit(1);
    await advance(2_000);
    lab.edit(2);
    await advance(1_000);
    expect(session.getState()).toMatchObject({ status: "offline", localCopy: "saved", pending: true });
    expect((await journal.read(projectId))?.document.state).toEqual({ value: 2 });
  });

  it("offers unsaved changes a closed tab left behind, and recovers them into the project", async () => {
    const journal = createMemoryJournal();
    const { lab, projects, snapshots, session, reloads, projectId } = await setup({
      journal,
      prepare: async ({ project }) => {
        await journal.write({
          projectId: project.id,
          labId: "organ",
          document: labDocument(42),
          fingerprint: canonicalJson({ value: 42 }),
          savedAt: Date.parse("2026-10-21T08:55:00Z"),
          baseHeadVersionId: project.headVersionId,
          baseDraftRev: project.draftRev,
        });
      },
    });
    expect(session.getState()).toMatchObject({ status: "clean", recoverable: { savedAt: "2026-10-21T08:55:00.000Z", stale: false } });
    // the offered entry is not overwritten by new edits while the user decides
    lab.edit(5);
    await advance(3_000);
    expect((await journal.read(projectId))?.document.state).toEqual({ value: 42 });
    expect(session.getState().recoverable).toMatchObject({ stale: true });
    await session.recover();
    expect(reloads.at(-1)).toMatchObject({ reason: "recover", version: null, document: { state: { value: 42 } }, missingLocal: [] });
    expect(lab.state).toEqual({ value: 42 });
    await advance(0);
    expect(session.getState()).toMatchObject({ status: "saved", recoverable: null, pending: false });
    expect(snapshots.stateOf(projects.row(projectId).draftAssetId)).toEqual({ value: 42 });
    // the version history kept the draft written in the meantime (value 5)
    const [kept] = await projects.versions(projectId);
    expect(kept).toMatchObject({ kind: "autosave" });
    expect(snapshots.stateOf(kept?.snapshotAssetId)).toEqual({ value: 5 });
    expect(await journal.read(projectId)).toBeNull();
  });

  it("discards offered changes, and drops entries the server already has", async () => {
    const journal = createMemoryJournal();
    const write = (projectId: string, value: number, base: Project) =>
      journal.write({
        projectId,
        labId: "organ",
        document: labDocument(value),
        fingerprint: canonicalJson({ value }),
        savedAt: Date.now(),
        baseHeadVersionId: base.headVersionId,
        baseDraftRev: base.draftRev,
      });
    const offered = await setup({ journal, prepare: ({ project }) => write(project.id, 9, project) });
    expect(offered.session.getState().recoverable).not.toBeNull();
    await offered.session.discardRecovery();
    expect(offered.session.getState().recoverable).toBeNull();
    expect(await journal.read(offered.projectId)).toBeNull();
    const same = await setup({ journal, prepare: ({ project }) => write(project.id, 0, project) });
    expect(same.session.getState().recoverable).toBeNull();
    expect(await journal.read(same.projectId)).toBeNull();
  });

  it("keeps an offered entry when a version is restored meanwhile", async () => {
    const journal = createMemoryJournal();
    const { session, projectId } = await setup({
      journal,
      prepare: async ({ project }) => {
        await journal.write({
          projectId: project.id,
          labId: "organ",
          document: labDocument(11),
          fingerprint: canonicalJson({ value: 11 }),
          savedAt: Date.now(),
          baseHeadVersionId: project.headVersionId,
          baseDraftRev: project.draftRev,
        });
      },
    });
    await session.restore(session.getState().headVersionId!);
    expect((await journal.read(projectId))?.document.state).toEqual({ value: 11 });
    expect(session.getState().recoverable).not.toBeNull();
  });

  it("has an in-memory journal and none without IndexedDB", async () => {
    const journal = createMemoryJournal();
    const entry = {
      projectId: "p",
      labId: "organ",
      document: labDocument(1),
      fingerprint: "f",
      savedAt: 1,
      baseHeadVersionId: null,
      baseDraftRev: 0,
    };
    await journal.write(entry);
    expect(await journal.read("p")).toBe(entry);
    await journal.clear("p");
    expect(await journal.read("p")).toBeNull();
    expect(createIndexedDbJournal()).toBeNull();
  });
});

describe("one editing tab", () => {
  it("opens read-only while another tab holds the lock, and takes over on Edit Here", async () => {
    const { lock } = fakeLock(false);
    const { lab, projects, session } = await setup({ lock });
    expect(session.getState()).toMatchObject({ status: "readonly", readonlyReason: "locked" });
    expect(session.gates().save).toMatchObject({ enabled: false, reason: expect.stringContaining("Edit Here") });
    lab.edit(1);
    await advance(10_000);
    expect(count(projects.calls, "saveDraft")).toBe(0);
    await expect(session.commit("manual")).rejects.toMatchObject({ code: "readonly" });
    await session.takeOver();
    expect(lock.held()).toBe(true);
    expect(session.getState()).toMatchObject({ status: "clean", readonlyReason: null });
    lab.edit(2);
    await advance(2_000);
    expect(session.getState().status).toBe("saved");
  });

  it("takes the lock when it opens and edits when nobody else holds it", async () => {
    const { lock } = fakeLock(false, true);
    const { lab, session } = await setup({ lock });
    expect(lock.held()).toBe(true);
    expect(session.getState()).toMatchObject({ status: "clean", readonlyReason: null });
    lab.edit(1);
    await advance(2_000);
    expect(session.getState().status).toBe("saved");
    session.dispose();
    expect(lock.held()).toBe(false);
  });

  it("saves what it has, then turns read-only when another tab takes over", async () => {
    const { lock, steal } = fakeLock(true);
    const { lab, projects, snapshots, session } = await setup({ lock });
    expect(session.getState().readonlyReason).toBeNull();
    lab.edit(3);
    steal();
    await advance(0);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    expect(snapshots.stateOf(projects.row(session.project.id).draftAssetId)).toEqual({ value: 3 });
    expect(session.getState()).toMatchObject({ status: "readonly", readonlyReason: "locked", pending: false });
    session.dispose();
    expect(lock.held()).toBe(false);
  });

  it("gives a saved copy its own lock when it has a lock factory", async () => {
    const made: Array<{ id: string; lock: ProjectLock }> = [];
    const factory = (projectId: string): ProjectLock => {
      const { lock } = fakeLock(false, true);
      made.push({ id: projectId, lock });
      return lock;
    };
    const { session, projectId } = await setup({ lock: factory });
    expect(made.map((entry) => [entry.id, entry.lock.held()])).toEqual([[projectId, true]]);
    const copy = await session.saveAsCopy("Copy");
    expect(made.map((entry) => [entry.id, entry.lock.held()])).toEqual([
      [projectId, false],
      [copy.id, true],
    ]);
  });

  it("uses Web Locks: one holder, ifAvailable for the second, steal for Edit Here", async () => {
    class FakeLocks {
      holder: { reject: (error: unknown) => void } | null = null;
      request(name: string, options: LockOptions, callback: (lock: { name: string } | null) => unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
          if (this.holder && options.ifAvailable) {
            Promise.resolve(callback(null)).then(resolve, reject);
            return;
          }
          if (this.holder && options.steal) {
            const previous = this.holder;
            this.holder = null;
            previous.reject(new DOMException("The lock was stolen.", "AbortError"));
          }
          const entry = { reject };
          this.holder = entry;
          Promise.resolve(callback({ name })).then((value) => {
            if (this.holder === entry) this.holder = null;
            resolve(value);
          }, reject);
        });
      }
    }
    const locks = new FakeLocks() as unknown as LockManager;
    const first = createProjectLock("p1", { locks });
    const second = createProjectLock("p1", { locks, retries: 0 });
    expect(first.name).toBe(projectLockName("p1"));
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    const lost = vi.fn();
    first.onLost(lost);
    await second.takeOver();
    await advance(0);
    expect(lost).toHaveBeenCalledTimes(1);
    expect([first.held(), second.held()]).toEqual([false, true]);
    second.release();
    expect(second.held()).toBe(false);
    expect(await createProjectLock("p2", { locks: null }).acquire()).toBe(true);
    // a holder in this very tab lets go asynchronously (React StrictMode remounts the editor): the next one retries
    const third = createProjectLock("p3", { locks });
    expect(await third.acquire()).toBe(true);
    third.release();
    const fourth = createProjectLock("p3", { locks, retries: 2, retryDelayMs: 50 });
    const acquiring = fourth.acquire();
    await advance(50);
    expect(await acquiring).toBe(true);
  });
});

describe("restores the lab cannot reproduce exactly", () => {
  it("names the restored source version and waits for the user before autosaving", async () => {
    const { lab, projects, session, duringReload } = await setup();
    const initial = session.getState().headVersionId!;
    lab.edit(2);
    await session.commit("manual");
    duringReload.report = { exact: false, warnings: ["The simulation restarted from rest."] };
    await session.restore(initial);
    expect(session.getState()).toMatchObject({
      awaitingAck: true,
      acknowledgementNeeded: true,
      lastRestore: { exact: false, warnings: ["The simulation restarted from rest."] },
    });
    expect((await projects.versions(session.project.id)).find((version) => version.id === initial)?.label).toBe(INEXACT_RESTORE_LABEL);
    lab.edit(3);
    await advance(30_000);
    expect(count(projects.calls, "saveDraft")).toBe(0);
    await session.acknowledgeRestore();
    await advance(2_000);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    expect(session.getState()).toMatchObject({ awaitingAck: false, status: "saved" });
  });

  it("keeps a version the user named under its own name", async () => {
    const { lab, projects, session, duringReload } = await setup();
    lab.edit(2);
    const named = await session.saveNamed("Before the cut");
    lab.edit(3);
    await session.saveNow();
    duringReload.report = { exact: false, warnings: [] };
    await session.restore(named.id);
    expect(count(projects.calls, "label")).toBe(0);
    expect((await projects.versions(session.project.id)).find((version) => version.id === named.id)?.label).toBe("Before the cut");
  });

  it("keeps a draft it could not reproduce as a named version before autosave replaces it", async () => {
    const { lab, projects, snapshots, session, projectId } = await setup({ draftValue: 7, firstReport: { exact: false, warnings: ["Sculpt detail was rebuilt."] } });
    expect(session.getState().awaitingAck).toBe(true);
    lab.edit(9);
    await advance(30_000);
    expect(snapshots.stateOf(projects.row(projectId).draftAssetId)).toEqual({ value: 7 });
    snapshots.saves.length = 0;
    await session.acknowledgeRestore();
    const [kept] = await projects.versions(projectId);
    expect(kept).toMatchObject({ kind: "named", label: INEXACT_RESTORE_LABEL });
    // committed by reference: the draft's own files
    expect(snapshots.saves).toHaveLength(0);
    expect(snapshots.stateOf(kept?.snapshotAssetId)).toEqual({ value: 7 });
    await advance(2_000);
    expect(snapshots.stateOf(projects.row(projectId).draftAssetId)).toEqual({ value: 9 });
  });

  it("takes the lab's own serialization after a restore as the clean state", async () => {
    const { lab, projects, session } = await setup({
      prepare: ({ lab: fake }) => {
        fake.normalize = (state) => ({ ...(state as Record<string, JsonValue>), units: "mm" });
      },
    });
    lab.emit("document");
    await advance(5_000);
    expect(count(projects.calls, "saveDraft")).toBe(0);
    expect(session.getState().status).toBe("clean");
    lab.edit(1);
    await advance(2_000);
    expect(count(projects.calls, "saveDraft")).toBe(1);
  });
});

describe("a lab that leaves", () => {
  it("stops saving its later edits, still stores what it captured, and comes back with open()", async () => {
    const journal = createMemoryJournal();
    const { lab, projects, snapshots, session, projectId } = await setup({ journal });
    lab.edit(1);
    await advance(1_000);
    lab.leave();
    await advance(0);
    expect(session.getState()).toMatchObject({ labLeft: true, detached: true, status: "saved" });
    expect(session.gates().restore).toMatchObject({ enabled: false, reason: expect.stringContaining("no longer shows") });
    expect(snapshots.stateOf(projects.row(projectId).draftAssetId)).toEqual({ value: 1 });
    // a fresh document of the same lab must never be taken for the project
    lab.state = { value: 0 };
    lab.edit(99);
    await advance(10_000);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    await expect(session.commit("manual")).rejects.toMatchObject({ code: "detached" });
    await session.open();
    expect(lab.state).toEqual({ value: 1 });
    expect(session.getState()).toMatchObject({ labLeft: false, status: "clean" });
  });
});

// DESIGN.md §15.7: local-only attachments --------------------------------------------------------------------------------

describe("local-only attachments", () => {
  async function device(options: { assets: ReturnType<typeof memoryAssets>; projects: FakeProjects; project: Project; localFiles?: LocalFileStore }) {
    const lab = new FakeLab();
    const reloads: LabReloadRequest[] = [];
    const reloadLab = async (request: LabReloadRequest) => {
      reloads.push(request);
      lab.state = request.document.state;
      lab.attachments = request.document.attachments ?? null;
      lab.localOnly = request.document.localOnly ?? null;
      return { exact: request.missingLocal.length === 0, warnings: request.missingLocal.map((item) => `${item.name} is not on this device.`) };
    };
    const session = new ProjectSession({
      projects: options.projects,
      snapshots: createSnapshotStore(options.assets.port),
      lab,
      project: options.project,
      reloadLab,
      connectivity: null,
      stampOpened: false,
      journal: null,
      lock: null,
      draftMinIntervalMs: 0,
      localFiles: options.localFiles,
    });
    await session.open();
    return { lab, reloads, session };
  }

  it("hashes them into the state but never uploads them, finds them again on this device, and names the missing ones elsewhere", async () => {
    vi.useRealTimers();
    const assets = memoryAssets();
    const projects = new FakeProjects();
    const store = createSnapshotStore(assets.port);
    const shared = new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" });
    const privateFile = new Blob(["patient-free test bytes that stay here"], { type: "application/json" });
    const created = await projects.create({
      labId: "organ",
      title: "Local files",
      ...(await store.save(
        { schema: "viscera.test-session/1", labId: "organ", state: { value: 1 }, attachments: { "shared.bin": shared, "local.json": privateFile }, localOnly: ["local.json"] },
        { thumbnail: null, signal, localOnly: ["local.json"] },
      )),
    });
    const privateSha = await sha256OfBlob(privateFile);
    expect(assets.uploaded).not.toContain(privateSha);
    expect(assets.uploaded).toContain(await sha256OfBlob(shared));

    // this device: a store of local files (as the editor wires the blob cache)
    const files = new Map<string, Blob>();
    const localFiles: LocalFileStore = {
      get: async (sha256) => files.get(sha256) ?? null,
      put: async (sha256, blob) => {
        files.set(sha256, blob);
      },
    };
    files.set(privateSha, privateFile);
    const here = await device({ assets, projects, project: { ...projects.row(created.id) }, localFiles });
    expect(here.reloads[0]).toMatchObject({ missingLocal: [], document: { localOnly: ["local.json"] } });
    expect(await here.reloads[0]?.document.attachments?.["local.json"]?.text()).toBe("patient-free test bytes that stay here");

    // an edit of the local file is saved (its hash changes the state) without uploading it
    const edited = new Blob(["edited local bytes"], { type: "application/json" });
    here.lab.attachments = { "shared.bin": shared, "local.json": edited };
    here.lab.state = { value: 2 };
    here.lab.emit("document");
    expect(await here.session.flush()).toBe("saved");
    const editedSha = await sha256OfBlob(edited);
    expect(assets.uploaded).not.toContain(editedSha);
    expect(files.get(editedSha)).toBe(edited);
    const draftState = projects.row(created.id).draftStateSha256;
    expect(draftState).toBe(await snapshotStateSha256({ schema: "viscera.test-session/1", labId: "organ", state: { value: 2 }, attachments: { "shared.bin": shared, "local.json": edited } }));

    // restoring the first version on this device finds its local file in memory
    await here.session.saveNow();
    await here.session.restore(created.headVersionId!);
    expect(here.reloads.at(-1)).toMatchObject({ reason: "restore", missingLocal: [] });
    expect(await here.reloads.at(-1)?.document.attachments?.["local.json"]?.text()).toBe("patient-free test bytes that stay here");

    // another device has no copy: the lab hears which file is missing (and the rest of the document is intact)
    const elsewhereDevice = await device({ assets, projects, project: { ...projects.row(created.id) } });
    const opened = elsewhereDevice.reloads[0];
    expect(opened?.missingLocal).toEqual([{ name: "local.json", sha256: privateSha }]);
    expect(Object.keys(opened?.document.attachments ?? {})).toEqual(["shared.bin"]);
    expect(opened?.document.localOnly).toEqual(["local.json"]);
    expect(elsewhereDevice.session.getState().lastRestore).toEqual({ exact: false, warnings: ["local.json is not on this device."] });
    expect(assets.uploaded).not.toContain(privateSha);
    here.session.dispose();
    elsewhereDevice.session.dispose();
  });

  it("accepts snapshot.ts createSnapshotStore as its SnapshotStore port (compile-time check)", () => {
    const asStore = (port: AssetPort): SnapshotStore => createSnapshotStore(port);
    expect(typeof asStore).toBe("function");
  });
});

describe("fingerprints", () => {
  it("default to snapshot.ts stateSha256, the value the server stores as draft_state_sha256", async () => {
    vi.useRealTimers();
    const assets = memoryAssets();
    const projects = new FakeProjects();
    const store = createSnapshotStore(assets.port);
    const lab = new FakeLab();
    const project = await projects.create({ labId: "organ", title: "Hash", ...(await store.save(labDocument(0), { thumbnail: null, signal })) });
    const session = new ProjectSession({
      projects,
      snapshots: store,
      lab,
      project,
      reloadLab: async (request) => {
        lab.state = request.document.state;
      },
      connectivity: null,
      stampOpened: false,
      journal: null,
      lock: null,
    });
    await session.open();
    lab.edit(5);
    expect(await session.flush()).toBe("saved");
    expect(projects.row(project.id).draftStateSha256).toBe(await snapshotStateSha256(labDocument(5)));
    // the same state again is no change: nothing is written
    projects.calls.length = 0;
    lab.edit(5);
    expect(await session.flush()).toBe("saved");
    expect(projects.calls).toEqual([]);
    session.dispose();
  });

  it("are stable under key order and follow every attachment byte", async () => {
    vi.useRealTimers();
    const sculpt = (last: number) => new Blob([new Uint8Array([1, 2, last])], { type: "application/octet-stream" });
    const a = await documentFingerprint({ schema: "s/1", labId: "organ", state: { b: 1, a: [1, { y: 2, x: 3 }] }, attachments: { sculpt: sculpt(3) } });
    const b = await documentFingerprint({ schema: "s/1", labId: "organ", state: { a: [1, { x: 3, y: 2 }], b: 1 }, attachments: { sculpt: sculpt(3) } });
    const c = await documentFingerprint({ schema: "s/1", labId: "organ", state: { b: 1, a: [1, { y: 2, x: 3 }] }, attachments: { sculpt: sculpt(4) } });
    const d = await documentFingerprint({ schema: "s/2", labId: "organ", state: { b: 1, a: [1, { y: 2, x: 3 }] }, attachments: { sculpt: sculpt(3) } });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
    expect(canonicalJson({ b: [true, null, "x"], a: 1.5 })).toBe('{"a":1.5,"b":[true,null,"x"]}');
  });
});

// Gates and the busy lab (DESIGN.md §15.6) -----------------------------------------------------------------------------

describe("gates", () => {
  it("polls the lab's busy reason while subscribed and gates Restore, Close and Record on it", async () => {
    const { lab, session } = await setup();
    const unsubscribe = session.subscribe(() => undefined);
    expect(session.gates()).toMatchObject({ save: { enabled: true }, restore: { enabled: true }, close: { enabled: true }, record: { enabled: true } });
    lab.busyReason = "recording";
    await advance(500);
    expect(session.getState().busyReason).toBe("recording");
    const busy = session.gates();
    for (const action of ["save", "saveAsCopy", "restore", "close", "record"] as const) {
      expect(busy[action]).toEqual({ enabled: false, reason: "The lab is busy (recording). Wait until it finishes." });
    }
    // a lab that is still loading can be closed or replaced, not saved or recorded
    lab.busyReason = "loading";
    await advance(500);
    expect(session.gates()).toMatchObject({
      restore: { enabled: true },
      close: { enabled: true },
      record: { enabled: false, reason: "The lab is still loading." },
      save: { enabled: false },
    });
    lab.busyReason = false;
    await advance(500);
    expect(session.getState().busyReason).toBeNull();
    unsubscribe();
    lab.busyReason = "running";
    await advance(2_000);
    expect(session.getState().busyReason).toBeNull();
  });

  it("explains what blocks each action", () => {
    const base = {
      status: "saved",
      activity: "idle",
      busyReason: null,
      readonlyReason: null,
      labLeft: false,
    } as unknown as SessionState;
    expect(sessionGates(base).restore).toEqual({ enabled: true, reason: null });
    expect(sessionGates({ ...base, status: "conflict" }).restore.reason).toMatch(/another tab or on another device/);
    expect(sessionGates({ ...base, status: "conflict" }).saveAsCopy.enabled).toBe(true);
    expect(sessionGates({ ...base, readonlyReason: "trashed", status: "readonly" }).save.reason).toBe("This project is in the Trash.");
    expect(sessionGates({ ...base, readonlyReason: "trashed", status: "readonly" }).record.enabled).toBe(true);
    expect(sessionGates({ ...base, activity: "restoring" }).restore.reason).toBe("Wait until the version has opened.");
    expect(sessionGates({ ...base, activity: "restoring" }).close.enabled).toBe(true);
    expect(busyGate("unavailable", "close").enabled).toBe(true);
    expect(busyGate(false, "record").enabled).toBe(true);
  });
});

describe("beforeunload", () => {
  class Target {
    readonly listeners = new Map<string, Set<(event: Event) => void>>();
    visibilityState = "visible";
    addEventListener(type: string, listener: (event: Event) => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
    }
    removeEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.get(type)?.delete(listener);
    }
    fire(type: string, event: Record<string, unknown> = {}) {
      const record = { defaultPrevented: false, returnValue: undefined as unknown, preventDefault() {
        record.defaultPrevented = true;
      }, ...event };
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(record as unknown as Event);
      return record;
    }
    size(): number {
      let total = 0;
      for (const set of this.listeners.values()) total += set.size;
      return total;
    }
  }

  it("asks before leaving while there is unsaved work or a save in flight, and flushes on pagehide and when hidden", async () => {
    const { lab, projects, session } = await setup();
    const window = new Target();
    const document = new Target();
    const uninstall = installBeforeUnload(session, { window, document });
    expect(window.fire("beforeunload").defaultPrevented).toBe(false);
    lab.edit(1);
    expect(shouldWarnBeforeUnload(session.getState())).toBe(true);
    const asked = window.fire("beforeunload");
    expect(asked.defaultPrevented).toBe(true);
    expect(asked.returnValue).toBe("");
    // asking also saved
    await advance(0);
    expect(count(projects.calls, "saveDraft")).toBe(1);
    expect(window.fire("beforeunload").defaultPrevented).toBe(false);
    lab.edit(2);
    window.fire("pagehide");
    await advance(0);
    expect(count(projects.calls, "saveDraft")).toBe(2);
    lab.edit(3);
    document.fire("visibilitychange");
    await advance(0);
    expect(count(projects.calls, "saveDraft")).toBe(2);
    document.visibilityState = "hidden";
    document.fire("visibilitychange");
    await advance(0);
    expect(count(projects.calls, "saveDraft")).toBe(3);
    uninstall();
    expect(window.size() + document.size()).toBe(0);
    expect(shouldWarnBeforeUnload({ ...session.getState(), pending: false, status: "saving" })).toBe(true);
  });
});
