// Adobe-style project sessions: the lab's state is journalled on this device, autosaved to the project's cloud draft,
// versions accumulate from checkpoints, ⌘S and named saves, and any version can be restored without losing the work in
// progress (DESIGN.md §6, §8 and the binding review addendum §15.2, §15.5–15.7).
//
// Cadence. Every lab change marks the session dirty. journalIdleMs after the last change (journalMaxWaitMs after the
// first at the latest) the lab is serialized into the local journal (IndexedDB, whole documents with attachments), so a
// crash, a closed tab or a lost connection costs at most a moment of work; on the next open the session offers
// "Recover unsaved changes". The cloud draft follows draftIdleMs after the last change (draftMaxWaitMs at the latest),
// at most once per draftMinIntervalMs and only when the state's SHA-256 changed (snapshot.ts stateSha256, the value the
// server stores as draft_state_sha256). "view" changes (camera, panels) never create versions; "document" changes
// count as editing time, and after checkpointEveryMs of editing since the last version the next save commits an
// "autosave" version. Thumbnails go with versions and with the draft written on close. Nothing is serialized while the
// lab is busy or recording.
//
// Concurrency. Every write names the head and the draft revision it started from (commit_version and restore_version
// too) and adopts the project the server returns, so ⌘S and checkpoints never leave a stale draft revision behind.
// Another tab or device moving them answers 409 and the session stops in "conflict" until the user picks
// reloadRemote(), saveAsCopy() or overwrite(). One write at a time: every server operation runs on one queue. A second
// tab of the same project opens read-only (Web Locks) until takeOver(). Network failures keep the captured state and
// retry with backoff; flush() is for pagehide and leaving the editor.
//
// Lab documents. A document of another lab is never stored in or shown from a project. Attachments a lab lists in
// localOnly are hashed into the state but never uploaded (snapshot.ts); the session keeps their bytes on this device so
// restores here find them again, and tells the lab which ones it could not find (LabRestoreContext.missingLocal).

import type { LabRestoreReport, LabSessionDocument } from "../bridge/labSession";
import { sha256OfBlob } from "./hash";
import { labSchemaVersionOf, snapshotStateSha256 } from "./snapshot";
import {
  PlatformError,
  isPlatformError,
  type CommitKind,
  type IsoDate,
  type JsonValue,
  type NamedAttachment,
  type Project,
  type ProjectPort,
  type ProjectVersion,
  type SnapshotRef,
  type Uuid,
} from "./types";

// Ports this module needs (snapshot.ts, labs/host.ts and the browser implement them) ----------------------------------

/** Where a stored snapshot lives: a version's or the draft's snapshot asset plus its named attachments. */
export interface StoredSnapshot {
  snapshotAssetId: Uuid;
  attachments: NamedAttachment[];
}

/** A local-only attachment as the snapshot manifest lists it. */
export interface LocalAttachmentEntry {
  sha256: string;
  bytes: number;
  mime: string;
}

// optional members without "| undefined", so these options pass straight to snapshot.ts createSnapshotStore
export interface SnapshotSaveOptions {
  thumbnail: Blob | null;
  signal: AbortSignal;
  /** The document's localOnly attachments: hashed into the state and listed, never uploaded (DESIGN.md §15.7). */
  localOnly?: readonly string[];
}

export interface SnapshotLoadOptions {
  signal: AbortSignal;
  /** The bytes of a local-only attachment from this device; null leaves the attachment out of the document. */
  getLocalAttachment?: (name: string, entry: LocalAttachmentEntry) => Promise<Blob | null>;
}

/** save() options for a document: its local-only attachments stay on this device. */
function saveOptionsFor(document: LabSessionDocument, thumbnail: Blob | null, signal: AbortSignal): SnapshotSaveOptions {
  const localOnly = document.localOnly;
  return localOnly && localOnly.length > 0 ? { thumbnail, signal, localOnly } : { thumbnail, signal };
}

/** Uploads and downloads lab documents, content-addressed (snapshot.ts createSnapshotStore satisfies it). */
export interface SnapshotStore {
  save(document: LabSessionDocument, options: SnapshotSaveOptions): Promise<SnapshotRef>;
  load(snapshot: StoredSnapshot, options: SnapshotLoadOptions): Promise<LabSessionDocument>;
}

/** The connected lab (labs/host.ts LabConnection satisfies it). */
export interface SessionLab {
  /** A reason while serializing would be unsafe (lab busy, recording, loading), else false. */
  busy(): false | string;
  /** The lab's document, already copied into the platform realm. */
  serialize(): Promise<LabSessionDocument>;
  thumbnail?(width: number, height: number): Promise<Blob | null>;
  onChange(listener: (kind: "document" | "view") => void): () => void;
  /** The lab left without the platform asking (it unloaded or navigated): its later edits are not the project's. */
  onLeave?(listener: () => void): () => void;
}

/** Device storage for local-only attachments by SHA-256 (blobCache.ts BlobCache fits): later opens here find them. */
export interface LocalFileStore {
  get(sha256: string): Promise<Blob | null>;
  put(sha256: string, blob: Blob): Promise<void>;
}

export type LabReloadReason = "open" | "restore" | "remote" | "recover";

/** A local-only attachment of a stored document that is not on this device (LabRestoreContext.missingLocal). */
export interface MissingLocalAttachment {
  name: string;
  sha256: string;
}

export interface LabReloadRequest {
  /**
   * open: first load of the project; restore: a version was restored; remote: the stored state replaces this tab's;
   * recover: unsaved changes from the local journal.
   */
  reason: LabReloadReason;
  document: LabSessionDocument;
  /** The version shown, or null for the project's draft or journalled changes. */
  version: ProjectVersion | null;
  signal: AbortSignal;
  /** For the lab's restore context: local-only attachments this device does not have (the lab asks for the file). */
  missingLocal: MissingLocalAttachment[];
}

export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Connectivity {
  online(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

// Local journal (DESIGN.md §15.5) -----------------------------------------------------------------------------------

export interface JournalEntry {
  projectId: Uuid;
  labId: string;
  /** The whole document, attachments included. */
  document: LabSessionDocument;
  fingerprint: string;
  /** When it was written (epoch ms). */
  savedAt: number;
  /** The server state the unsaved changes started from. */
  baseHeadVersionId: Uuid | null;
  baseDraftRev: number;
}

/** Unsaved lab documents kept on this device until the cloud has them. */
export interface SessionJournal {
  read(projectId: Uuid): Promise<JournalEntry | null>;
  write(entry: JournalEntry): Promise<void>;
  clear(projectId: Uuid): Promise<void>;
}

export const JOURNAL_DATABASE = "viscera-platform-journal";
const JOURNAL_STORE = "entries";

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Record<keyof JournalEntry, unknown>>;
  const document = entry.document as Partial<Record<keyof LabSessionDocument, unknown>> | null | undefined;
  return (
    typeof entry.projectId === "string" &&
    typeof entry.labId === "string" &&
    typeof entry.fingerprint === "string" &&
    typeof entry.savedAt === "number" &&
    (entry.baseHeadVersionId === null || typeof entry.baseHeadVersionId === "string") &&
    typeof entry.baseDraftRev === "number" &&
    typeof document === "object" &&
    document !== null &&
    typeof document.schema === "string" &&
    typeof document.labId === "string" &&
    "state" in document
  );
}

/** A journal in memory (tests, or a browser without IndexedDB: it then only survives within the tab). */
export function createMemoryJournal(): SessionJournal {
  const entries = new Map<Uuid, JournalEntry>();
  return {
    async read(projectId) {
      return entries.get(projectId) ?? null;
    },
    async write(entry) {
      entries.set(entry.projectId, entry);
    },
    async clear(projectId) {
      entries.delete(projectId);
    },
  };
}

interface StoredAttachment {
  type: string;
  bytes: ArrayBuffer;
}

// attachments go in as bytes: WebKit refuses Blobs in IndexedDB in private (ephemeral) sessions
async function storableEntry(entry: JournalEntry): Promise<unknown> {
  const attachments: Record<string, StoredAttachment> = {};
  for (const [name, blob] of Object.entries(entry.document.attachments ?? {})) {
    attachments[name] = { type: blob.type, bytes: await blob.arrayBuffer() };
  }
  const { attachments: _blobs, ...document } = entry.document;
  return { ...entry, document, attachments };
}

function entryFromStorage(value: unknown): JournalEntry | null {
  if (!isJournalEntry(value)) return null;
  const { attachments: stored, ...entry } = value as JournalEntry & { attachments?: unknown };
  const document: LabSessionDocument = { ...entry.document };
  if (typeof stored === "object" && stored !== null) {
    const attachments: Record<string, Blob> = {};
    for (const [name, part] of Object.entries(stored as Record<string, unknown>)) {
      const attachment = part as Partial<StoredAttachment> | null;
      if (attachment && attachment.bytes instanceof ArrayBuffer) {
        attachments[name] = new Blob([attachment.bytes], { type: typeof attachment.type === "string" ? attachment.type : "" });
      }
    }
    if (Object.keys(attachments).length > 0) document.attachments = attachments;
  }
  return { ...entry, document };
}

/** The journal in IndexedDB (attachment bytes included), or null where the browser has none. */
export function createIndexedDbJournal(options: { name?: string | undefined; factory?: IDBFactory | undefined } = {}): SessionJournal | null {
  const factory = options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) return null;
  const name = options.name ?? JOURNAL_DATABASE;
  let database: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (database) return database;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(JOURNAL_STORE, { keyPath: "projectId" });
      };
      request.onsuccess = () => {
        const db = request.result;
        // another tab upgrading the database: let it, and open again next time
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("The local journal could not be opened."));
    });
    database = opening;
    opening.catch(() => {
      database = null;
    });
    return opening;
  };
  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(JOURNAL_STORE, mode);
      const request = body(transaction.objectStore(JOURNAL_STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error("The local journal failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("The local journal write was aborted."));
    });
  };
  return {
    async read(projectId) {
      const value: unknown = await run("readonly", (store) => store.get(projectId));
      return entryFromStorage(value);
    },
    async write(entry) {
      // the bytes are read before the transaction opens: an IndexedDB transaction ends at the first await
      const value = await storableEntry(entry);
      await run("readwrite", (store) => store.put(value));
    },
    async clear(projectId) {
      await run("readwrite", (store) => store.delete(projectId));
    },
  };
}

// Editing lock (DESIGN.md §15.5) -------------------------------------------------------------------------------------

/** The tab that edits a project; another tab opens it read-only until "Edit Here". */
export interface ProjectLock {
  readonly name: string;
  held(): boolean;
  /** Takes the lock when no other tab holds it. */
  acquire(): Promise<boolean>;
  /** "Edit Here": takes the lock from the other tab, which turns read-only. */
  takeOver(): Promise<void>;
  /** Another tab took the lock. */
  onLost(listener: () => void): () => void;
  release(): void;
}

export function projectLockName(projectId: Uuid): string {
  return `viscera.project:${projectId}`;
}

export interface ProjectLockOptions {
  /** The Web Locks manager (defaults to navigator.locks; null: every tab edits, 409 conflicts still guard writes). */
  locks?: LockManager | null | undefined;
  /**
   * More attempts when the lock is taken: a holder in this very tab (a React StrictMode remount, an editor replaced by
   * the copy it saved) lets go asynchronously.
   */
  retries?: number | undefined;
  retryDelayMs?: number | undefined;
}

/** Web Locks for one project. Without the API (old browsers) every tab edits, and 409 conflicts still guard writes. */
export function createProjectLock(projectId: Uuid, options: ProjectLockOptions = {}): ProjectLock {
  const locks = options.locks === undefined ? ((globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks ?? null) : options.locks;
  const retries = Math.max(0, Math.floor(options.retries ?? 3));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 100);
  const name = projectLockName(projectId);
  const lost = new Set<() => void>();
  let held = false;
  let releaseHeld: (() => void) | null = null;
  const request = (lockOptions: LockOptions): Promise<boolean> => {
    if (!locks) {
      held = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let granted = false;
      locks
        .request(name, lockOptions, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          granted = true;
          held = true;
          resolve(true);
          // held until release(), or until another tab steals it
          return new Promise<void>((done) => {
            releaseHeld = done;
          });
        })
        .catch(() => {
          // a holder whose lock another tab stole is rejected with an AbortError
          if (!granted) {
            resolve(false);
            return;
          }
          const wasHeld = held;
          held = false;
          releaseHeld = null;
          if (!wasHeld) return;
          for (const listener of [...lost]) {
            try {
              listener();
            } catch {
              // a failing listener must not keep the others from hearing it
            }
          }
        });
    });
  };
  return {
    name,
    held: () => held,
    async acquire() {
      for (let attempt = 0; ; attempt += 1) {
        if (held) return true;
        if (await request({ mode: "exclusive", ifAvailable: true })) return true;
        if (attempt >= retries) return false;
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, retryDelayMs));
      }
    },
    async takeOver() {
      if (!held) await request({ mode: "exclusive", steal: true });
    },
    onLost(listener) {
      lost.add(listener);
      return () => {
        lost.delete(listener);
      };
    },
    release() {
      const done = releaseHeld;
      releaseHeld = null;
      held = false;
      done?.();
    },
  };
}

// a browser window: tabs of one origin share Web Locks (no default in node or workers)
function defaultLockFactory(): ((projectId: Uuid) => ProjectLock) | null {
  const scope = globalThis as { window?: unknown; navigator?: { locks?: LockManager } };
  if (scope.window === undefined || !scope.navigator?.locks) return null;
  return (projectId) => createProjectLock(projectId);
}

// State -------------------------------------------------------------------------------------------------------------

export type SessionStatus = "clean" | "dirty" | "saving" | "saved" | "offline" | "conflict" | "error" | "readonly";
export type SessionActivity =
  | "idle"
  | "waiting-for-lab"
  | "saving"
  | "committing"
  | "restoring"
  | "reloading"
  | "recovering"
  | "resolving";
export type SessionOperation = "draft" | "commit" | "restore" | "reload" | "copy" | "recover";
/** trashed: the project is in the Trash; locked: another tab edits it; option: opened read-only on purpose. */
export type ReadonlyReason = "trashed" | "locked" | "option";
/** Why flush() runs; "close" also stores a fresh thumbnail for the project card. */
export type SessionFlushReason = "pagehide" | "hidden" | "beforeunload" | "navigate" | "close" | "manual";

export interface SessionConflict {
  /** version: another tab or device committed; draft: it saved its own working copy. */
  kind: "version" | "draft";
  operation: SessionOperation;
  remoteHeadVersionId: Uuid | null;
  remoteHeadSeq: number | null;
  remoteDraftRev: number | null;
}

export interface SessionFailure {
  /** A PlatformErrorCode, or lab_busy / lab_mismatch / readonly / conflict / detached / timeout / unknown. */
  code: string;
  message: string;
  status: number | null;
  operation: SessionOperation;
}

export interface RecoverableChanges {
  /** When the unsaved changes were written on this device. */
  savedAt: IsoDate;
  /** The project changed elsewhere since: recovering first keeps that newer working copy as a version. */
  stale: boolean;
}

export interface SessionState {
  status: SessionStatus;
  activity: SessionActivity;
  projectId: Uuid;
  labId: string;
  headVersionId: Uuid | null;
  headSeq: number;
  draftRev: number;
  hasDraft: boolean;
  /** Local changes the server has not acknowledged (prompt before unloading when true). */
  pending: boolean;
  /** When the project's content was last stored (by this session or, before any save here, by anyone). */
  lastSavedAt: IsoDate | null;
  /** The lab's busy reason while a save waits for it. */
  waitingFor: string | null;
  /** The lab's busy reason right now (polled while the state has subscribers), else null: gates Restore, Close, Record. */
  busyReason: string | null;
  /** What went wrong last (cleared by the next success). */
  failure: SessionFailure | null;
  /** The same as failure (its first name). */
  error: SessionFailure | null;
  conflict: SessionConflict | null;
  /** Epoch ms of the next automatic retry. */
  retryAt: number | null;
  /** Editing time accumulated since the last version (checkpoint accounting). */
  editingMs: number;
  /** The lab's report from the last open, restore or reload. */
  lastRestore: LabRestoreReport | null;
  readonlyReason: ReadonlyReason | null;
  /**
   * The lab left without the platform asking (an unexpected load, pagehide or navigation of its frame), or reloading
   * it failed: nothing is saved until open().
   */
  labLeft: boolean;
  /** The same as labLeft (its first name). */
  detached: boolean;
  /** Unsaved changes found in the local journal when the project opened, unlike the cloud's: recover() or discardRecovery(). */
  recoverable: RecoverableChanges | null;
  /** An inexact restore: autosave waits until acknowledgeRestore() (DESIGN.md §15.6). */
  awaitingAck: boolean;
  /** The same as awaitingAck (its first name). */
  acknowledgementNeeded: boolean;
  /** The local journal: off (none), pending (a change not yet journalled), saved (every change is), failed. */
  localCopy: "off" | "pending" | "saved" | "failed";
}

export class SessionError extends Error {
  readonly code: "lab_busy" | "lab_mismatch" | "readonly" | "conflict" | "detached" | "disposed" | "timeout";
  constructor(code: SessionError["code"], message: string) {
    super(message);
    this.name = code === "timeout" ? "TimeoutError" : "SessionError";
    this.code = code;
  }
}

/** The name given to a version an inexact restore could not reproduce, so it is kept forever. */
export const INEXACT_RESTORE_LABEL = "Kept before an inexact restore";

// Gates (DESIGN.md §15.6: Restore, Close and Record wait for an idle lab) ----------------------------------------------

export interface SessionGate {
  enabled: boolean;
  /** Why not, as a sentence for a tooltip or toast (null while enabled). */
  reason: string | null;
}

export interface SessionGates {
  /** ⌘S and ⇧⌘S. */
  save: SessionGate;
  saveAsCopy: SessionGate;
  restore: SessionGate;
  close: SessionGate;
  record: SessionGate;
}

// a lab that is still loading holds no work: it can be closed or replaced by a restore
const PASSIVE_BUSY = new Set(["loading", "unavailable"]);

function gate(reason: string | null): SessionGate {
  return reason === null ? { enabled: true, reason: null } : { enabled: false, reason };
}

function first(...reasons: Array<string | null>): string | null {
  for (const reason of reasons) if (reason !== null) return reason;
  return null;
}

/** What a busy lab reason blocks: everything for real work (recording, running…), only saving and recording while it loads. */
export function busyGate(busyReason: string | null | false, action: "save" | "restore" | "close" | "record"): SessionGate {
  if (!busyReason) return gate(null);
  if (PASSIVE_BUSY.has(busyReason) && (action === "restore" || action === "close")) return gate(null);
  return gate(busyReason === "loading" ? "The lab is still loading." : `The lab is busy (${busyReason}). Wait until it finishes.`);
}

/** Which project actions the editor offers now, and why not (pure: compute it from the subscribed state). */
export function sessionGates(state: SessionState): SessionGates {
  const readonly =
    state.readonlyReason === "locked"
      ? "This project is open in another tab. Choose Edit Here to edit it in this tab."
      : state.readonlyReason === "trashed"
        ? "This project is in the Trash."
        : state.readonlyReason === "option"
          ? "This project is open read-only."
          : null;
  const conflict = state.status === "conflict" ? "This project changed in another tab or on another device. Resolve that first." : null;
  const left = state.labLeft ? "The lab no longer shows this project. Open the project again." : null;
  const moving =
    state.activity === "restoring" || state.activity === "reloading" || state.activity === "recovering"
      ? "Wait until the version has opened."
      : null;
  const busy = (action: "save" | "restore" | "close" | "record"): string | null => busyGate(state.busyReason, action).reason;
  return {
    save: gate(first(readonly, conflict, left, moving, busy("save"))),
    saveAsCopy: gate(first(left, moving, busy("save"))),
    restore: gate(first(readonly, conflict, left, moving, busy("restore"))),
    close: gate(busy("close")),
    record: gate(first(left, moving, busy("record"))),
  };
}

// Options -----------------------------------------------------------------------------------------------------------

export interface ProjectSessionTiming {
  draftIdleMs: number;
  draftMaxWaitMs: number;
  /** Cloud drafts at most this often (DESIGN.md §15.5); explicit saves and flushes do not wait. */
  draftMinIntervalMs: number;
  journalIdleMs: number;
  journalMaxWaitMs: number;
  checkpointEveryMs: number;
  /** The most one pause between two document changes counts as editing (longer pauses are time away). */
  editingGapMs: number;
  /** How often a busy lab is asked again (saves waiting for it, and state.busyReason while subscribed). */
  busyPollMs: number;
  /** How long an explicit save waits for a busy lab. */
  busyTimeoutMs: number;
  serializeTimeoutMs: number;
  /** Backoff for automatic retries (the last delay repeats while offline). */
  retryDelaysMs: readonly number[];
  /** Automatic retries of server errors before the session reports "error". */
  transientRetries: number;
}

export const DEFAULT_SESSION_TIMING: Readonly<ProjectSessionTiming> = {
  draftIdleMs: 2_000,
  draftMaxWaitMs: 15_000,
  draftMinIntervalMs: 60_000,
  journalIdleMs: 1_000,
  journalMaxWaitMs: 5_000,
  checkpointEveryMs: 600_000,
  editingGapMs: 60_000,
  busyPollMs: 500,
  busyTimeoutMs: 30_000,
  serializeTimeoutMs: 20_000,
  retryDelaysMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  transientRetries: 5,
};

/** Project card size (16:10, APPLE_STYLE_SPEC §3.3). */
export const DEFAULT_THUMBNAIL_SIZE = { width: 640, height: 400 } as const;

type TimingOptions = { [K in keyof ProjectSessionTiming]?: ProjectSessionTiming[K] | undefined };

export interface ProjectSessionOptions extends TimingOptions {
  projects: ProjectPort;
  snapshots: SnapshotStore;
  lab: SessionLab;
  project: Project;
  /**
   * Reloads the lab iframe when needed and applies the document (labs/host.ts labReloader: the lab opens with
   * restore=pending, restore() goes only to a fresh lab, and missingLocal reaches the lab's restore context).
   */
  reloadLab: (request: LabReloadRequest) => Promise<LabRestoreReport | void>;
  readonly?: boolean | undefined;
  /** Thumbnail size for versions and the closing draft; null stores none. */
  thumbnailSize?: { width: number; height: number } | null | undefined;
  /** State fingerprint for no-op detection (default: snapshot.ts snapshotStateSha256, the server's state_sha256). */
  fingerprint?: ((document: LabSessionDocument) => Promise<string>) | undefined;
  clock?: SessionClock | undefined;
  /** Online/offline signals (defaults to the browser's; null disables). */
  connectivity?: Connectivity | null | undefined;
  /** open() stamps the project's opened_at (default true). */
  stampOpened?: boolean | undefined;
  /** The local journal (defaults to IndexedDB where the browser has it; null disables). */
  journal?: SessionJournal | null | undefined;
  /**
   * This project's editing lock, or a factory for it (a saved copy then gets its own). Default: Web Locks in a browser
   * window. open() takes it; held by another tab, the project opens read-only until takeOver(). dispose() releases it.
   * null: no lock.
   */
  lock?: ProjectLock | ((projectId: Uuid) => ProjectLock) | null | undefined;
  /** Device storage for local-only attachments (default: this session's memory only). */
  localFiles?: LocalFileStore | null | undefined;
}

export interface CreateProjectOptions extends Omit<ProjectSessionOptions, "project" | "readonly"> {
  labId: string;
  title: string;
  description?: string | undefined;
}

/** createProject(labId, title, lab, deps): everything else a session needs. */
export type CreateProjectDeps = Omit<CreateProjectOptions, "labId" | "title" | "lab">;

// Fingerprints ------------------------------------------------------------------------------------------------------

/** JSON with object keys sorted, so equal states give equal text. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
}

async function sha256Hex(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

// Blobs never change, and the lab host hands an unchanged attachment over as the same Blob: hash its bytes once
const attachmentDigests = new WeakMap<Blob, string>();

/**
 * SHA-256 over the canonical schema, lab id, state, versions and every attachment's type, size and bytes. Kept for
 * callers that want the MIME type in the hash; sessions default to snapshot.ts snapshotStateSha256 (the server's).
 */
export async function documentFingerprint(document: LabSessionDocument): Promise<string> {
  const attachments: Record<string, string> = {};
  const parts = document.attachments ?? {};
  for (const name of Object.keys(parts).sort()) {
    const blob = parts[name];
    if (blob === undefined) continue;
    let digest = attachmentDigests.get(blob);
    if (digest === undefined) {
      digest = await sha256Hex(await blob.arrayBuffer());
      attachmentDigests.set(blob, digest);
    }
    attachments[name] = `${blob.type};${blob.size};${digest}`;
  }
  const text = canonicalJson({
    schema: document.schema,
    labId: document.labId,
    state: document.state,
    versions: document.versions ?? {},
    attachments,
  });
  return sha256Hex(new TextEncoder().encode(text));
}

// Helpers -----------------------------------------------------------------------------------------------------------

type ChangeKind = "document" | "view";

interface LabSnapshot {
  document: LabSessionDocument;
  fingerprint: string;
  /** The change counter the document includes. */
  seq: number;
  /** The newest "document" change it includes (view changes do not count as edits). */
  documentSeq: number;
}

interface Capture extends LabSnapshot {
  thumbnail: Blob | null;
  /** Set once uploaded (a retry reuses it). */
  ref: SnapshotRef | null;
}

interface StoredState {
  fingerprint: string;
  ref: SnapshotRef | null;
}

interface LoadedDocument {
  document: LabSessionDocument;
  missingLocal: MissingLocalAttachment[];
}

interface KeptDraft extends StoredState {
  document: LabSessionDocument;
}

type FailedOperation =
  | { operation: "draft" }
  | { operation: "commit"; kind: CommitKind; label: string | undefined }
  | { operation: "restore"; versionId: Uuid }
  | { operation: "reload"; reason: "open" | "remote" };

type FailureClass = "conflict" | "offline" | "transient" | "readonly" | "fatal";
type TimerName = "idle" | "max" | "retry" | "busy" | "journalIdle" | "journalMax" | "busyWatch";
const ALL_TIMERS: readonly TimerName[] = ["idle", "max", "retry", "busy", "journalIdle", "journalMax", "busyWatch"];

// local-only attachment bytes this session keeps for restores (oldest dropped first)
const MAX_LOCAL_BLOBS = 64;

const systemClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

function browserConnectivity(): Connectivity | null {
  const scope = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
    navigator?: { onLine?: boolean };
  };
  const add = scope.addEventListener;
  const remove = scope.removeEventListener;
  if (typeof add !== "function" || typeof remove !== "function") return null;
  return {
    online: () => scope.navigator?.onLine !== false,
    subscribe(listener) {
      const online = (): void => listener(true);
      const offline = (): void => listener(false);
      add.call(scope, "online", online);
      add.call(scope, "offline", offline);
      return () => {
        remove.call(scope, "online", online);
        remove.call(scope, "offline", offline);
      };
    },
  };
}

function refFromVersion(version: ProjectVersion, attachments: NamedAttachment[]): SnapshotRef {
  return {
    snapshotAssetId: version.snapshotAssetId,
    stateSha256: version.stateSha256,
    thumbnailAssetId: version.thumbnailAssetId,
    attachments,
    labSchemaVersion: version.labSchemaVersion,
    appBuild: version.appBuild,
  };
}

/** The project's stored draft by reference: committing it reuses its files exactly (local-only entries included). */
function refFromDraft(project: Project, attachments: NamedAttachment[], schema: string): SnapshotRef | null {
  if (project.draftAssetId === null || project.draftStateSha256 === null) return null;
  return {
    snapshotAssetId: project.draftAssetId,
    stateSha256: project.draftStateSha256,
    thumbnailAssetId: project.draftThumbnailAssetId,
    attachments,
    labSchemaVersion: labSchemaVersionOf(schema),
    appBuild: null,
  };
}

const TRANSIENT_CODES = new Set(["rate_limited", "asset_not_ready", "upload_missing", "size_mismatch", "asset_busy"]);

function classifyFailure(error: unknown, online: boolean): FailureClass {
  if (isPlatformError(error, "version_conflict") || isPlatformError(error, "draft_conflict")) return "conflict";
  if (isPlatformError(error, "project_trashed")) return "readonly";
  if (!online) return "offline";
  if (isPlatformError(error)) {
    if (error.code === "network") return "offline";
    if (TRANSIENT_CODES.has(error.code)) return "transient";
    if (error.code === "unknown") return error.status === null || error.status >= 500 ? "transient" : "fatal";
    return "fatal";
  }
  // fetch() rejects with a TypeError when the network is unreachable
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return "offline";
  return "fatal";
}

function describeFailure(error: unknown, operation: SessionOperation): SessionFailure {
  if (isPlatformError(error)) return { code: error.code, message: error.message, status: error.status, operation };
  if (error instanceof SessionError) return { code: error.code, message: error.message, status: null, operation };
  if (error instanceof Error) {
    return { code: error.name === "TimeoutError" ? "timeout" : "unknown", message: error.message, status: null, operation };
  }
  return { code: "unknown", message: String(error), status: null, operation };
}

function parseConflict(error: unknown, operation: SessionOperation): SessionConflict {
  let detail: Record<string, unknown> = {};
  if (isPlatformError(error) && error.detail) {
    try {
      const parsed: unknown = JSON.parse(error.detail);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
    } catch {
      // the detail is informational only
    }
  }
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
  return {
    kind: isPlatformError(error, "draft_conflict") ? "draft" : "version",
    operation,
    remoteHeadVersionId: typeof detail.head_version_id === "string" ? detail.head_version_id : null,
    remoteHeadSeq: number(detail.head_seq),
    remoteDraftRev: number(detail.draft_rev),
  };
}

function sameState(a: SessionState, b: SessionState): boolean {
  for (const key of Object.keys(a) as Array<keyof SessionState>) if (!Object.is(a[key], b[key])) return false;
  return true;
}

function sleep(clock: SessionClock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SessionError("disposed", "The project session was closed."));
      return;
    }
    const onAbort = (): void => {
      clock.clearTimeout(handle);
      reject(new SessionError("disposed", "The project session was closed."));
    };
    const handle = clock.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    throw new PlatformError("invalid_input", "A project title has 1 to 120 characters.", { status: 422, detail: "title" });
  }
  return trimmed;
}

function resolveTiming(options: TimingOptions): ProjectSessionTiming {
  const timing: ProjectSessionTiming = { ...DEFAULT_SESSION_TIMING };
  for (const key of Object.keys(DEFAULT_SESSION_TIMING) as Array<keyof ProjectSessionTiming>) {
    const value = options[key];
    if (value !== undefined) (timing as Record<keyof ProjectSessionTiming, unknown>)[key] = value;
  }
  return timing;
}

function createOptionsFrom(first: CreateProjectOptions | string, title?: string, lab?: SessionLab, deps?: CreateProjectDeps): CreateProjectOptions {
  if (typeof first !== "string") return first;
  if (lab === undefined || deps === undefined) throw new TypeError("createProject(labId, title, lab, deps) needs the lab and its dependencies.");
  return { ...deps, labId: first, title: title ?? "", lab };
}

// Session -----------------------------------------------------------------------------------------------------------

export class ProjectSession {
  private readonly projects: ProjectPort;
  private readonly snapshots: SnapshotStore;
  private readonly lab: SessionLab;
  private readonly reloadLab: ProjectSessionOptions["reloadLab"];
  private readonly clock: SessionClock;
  private readonly timing: ProjectSessionTiming;
  private readonly fingerprintOf: (document: LabSessionDocument) => Promise<string>;
  private readonly thumbnailSize: { width: number; height: number } | null;
  private readonly connectivity: Connectivity | null;
  private readonly stampOpened: boolean;
  private readonly journal: SessionJournal | null;
  private readonly lockFactory: ((projectId: Uuid) => ProjectLock) | null;
  private readonly localFiles: LocalFileStore | null;
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(state: SessionState) => void>();
  private readonly unsubscribers: Array<() => void> = [];

  private lock: ProjectLock | null;
  private lockUnsubscribe: (() => void) | null = null;
  private record: Project;
  private state: SessionState;
  private readonlyOption: boolean;
  private readonlyReason: ReadonlyReason | null;
  private disposed = false;
  // the lab shows this project's state (after open, create or a reload); before that its edits are not the project's
  private attached = false;
  // it showed it and then left (or a reload failed)
  private detached = false;

  // change tracking
  private changeSeq = 0;
  private savedSeq = 0;
  private lastDocumentSeq = 0;
  private burstStartedAt: number | null = null;
  private journalBurstStartedAt: number | null = null;
  private lastDocumentChangeAt: number | null = null;
  private editingMs = 0;
  private suppressChanges = 0;

  // the newest serialization of the lab, shared by the journal and the cloud draft
  private latest: LabSnapshot | null = null;
  private serializing: Promise<unknown> = Promise.resolve();

  // what the server holds and what still has to reach it
  private stored: StoredState | null = null;
  private unsent: Capture | null = null;
  private failed: FailedOperation | null = null;
  private savedThisSession = false;
  private lastSavedAt: IsoDate | null;
  private lastCloudWriteAt: number | null = null;
  private forceNextCloudWrite = false;
  // the project card shows an older look than what is stored (drafts carry no thumbnail)
  private thumbnailStale = false;

  // the local journal
  private journaledSeq = 0;
  private journaledFingerprint: string | null = null;
  private journalFailed = false;
  private journalRunning = false;
  private journalTail: Promise<unknown> = Promise.resolve();
  private recovery: JournalEntry | null = null;
  private recoverableView: RecoverableChanges | null = null;

  // local-only attachment bytes seen on this device, by SHA-256
  private readonly localBlobs = new Map<string, Blob>();

  // an inexact restore waits for the user; a draft it could not reproduce becomes a named version first
  private awaitingAck = false;
  private keepDraft: KeptDraft | null = null;

  private idleTimer: unknown = null;
  private maxTimer: unknown = null;
  private retryTimer: unknown = null;
  private busyTimer: unknown = null;
  private journalIdleTimer: unknown = null;
  private journalMaxTimer: unknown = null;
  private busyWatchTimer: unknown = null;
  private retryAttempt = 0;
  private autosaveQueued = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: ProjectSessionOptions) {
    this.projects = options.projects;
    this.snapshots = options.snapshots;
    this.lab = options.lab;
    this.reloadLab = options.reloadLab;
    this.clock = options.clock ?? systemClock;
    this.timing = resolveTiming(options);
    this.fingerprintOf = options.fingerprint ?? snapshotStateSha256;
    this.thumbnailSize = options.thumbnailSize === undefined ? { ...DEFAULT_THUMBNAIL_SIZE } : options.thumbnailSize;
    this.connectivity = options.connectivity === undefined ? browserConnectivity() : options.connectivity;
    this.stampOpened = options.stampOpened ?? true;
    this.journal = options.journal === undefined ? createIndexedDbJournal() : options.journal;
    this.localFiles = options.localFiles ?? null;
    const lockOption = options.lock;
    this.lockFactory = typeof lockOption === "function" ? lockOption : lockOption === undefined ? defaultLockFactory() : null;
    this.lock = typeof lockOption === "function" || lockOption === undefined ? (this.lockFactory?.(options.project.id) ?? null) : lockOption;
    this.record = { ...options.project };
    this.readonlyOption = options.readonly === true;
    // the editing lock is taken by open() (or createProject); until then nothing is saved anyway
    this.readonlyReason = options.project.trashedAt !== null ? "trashed" : this.readonlyOption ? "option" : null;
    this.lastSavedAt = options.project.draftSavedAt ?? options.project.updatedAt;
    this.state = {
      status: this.readonlyReason !== null ? "readonly" : "clean",
      activity: "idle",
      projectId: this.record.id,
      labId: this.record.labId,
      headVersionId: this.record.headVersionId,
      headSeq: this.record.headSeq,
      draftRev: this.record.draftRev,
      hasDraft: this.record.draftAssetId !== null,
      pending: false,
      lastSavedAt: this.lastSavedAt,
      waitingFor: null,
      busyReason: null,
      failure: null,
      error: null,
      conflict: null,
      retryAt: null,
      editingMs: 0,
      lastRestore: null,
      readonlyReason: this.readonlyReason,
      labLeft: false,
      detached: false,
      recoverable: null,
      awaitingAck: false,
      acknowledgementNeeded: false,
      localCopy: this.journal ? "saved" : "off",
    };
    this.unsubscribers.push(this.lab.onChange((kind) => this.handleChange(kind === "view" ? "view" : "document")));
    if (this.lab.onLeave) this.unsubscribers.push(this.lab.onLeave(() => this.handleLeave()));
    this.watchLock();
    if (this.connectivity) {
      this.unsubscribers.push(this.connectivity.subscribe((online) => {
        if (online) this.handleOnline();
      }));
    }
  }

  /**
   * Creates a project from what the lab shows now (guest → "Save as Project", or a new project) and returns a session
   * bound to it, already saved. createProject(labId, title, lab, deps) is the same with the lab and its dependencies
   * passed apart.
   */
  static createProject(options: CreateProjectOptions): Promise<ProjectSession>;
  static createProject(labId: string, title: string, lab: SessionLab, deps: CreateProjectDeps): Promise<ProjectSession>;
  static async createProject(first: CreateProjectOptions | string, title?: string, lab?: SessionLab, deps?: CreateProjectDeps): Promise<ProjectSession> {
    const options = createOptionsFrom(first, title, lab, deps);
    const name = validTitle(options.title);
    const timing = resolveTiming(options);
    const clock = options.clock ?? systemClock;
    const source = options.lab;
    const signal = new AbortController().signal;
    const deadline = clock.now() + timing.busyTimeoutMs;
    for (let reason = source.busy(); reason; reason = source.busy()) {
      if (clock.now() >= deadline) throw new SessionError("lab_busy", `The lab is busy (${reason}); try again when it finishes.`);
      await sleep(clock, timing.busyPollMs, signal);
    }
    // changes made while the project is being created must not be lost to the new session
    let captured = false;
    let missed: ChangeKind | null = null;
    const stopListening = source.onChange((kind) => {
      if (captured) missed = missed === "document" || kind === "document" ? "document" : "view";
    });
    try {
      const document = await source.serialize();
      captured = true;
      if (document.labId !== options.labId) {
        throw new SessionError("lab_mismatch", `The lab holds "${document.labId}" state, not "${options.labId}".`);
      }
      const fingerprint = await (options.fingerprint ?? snapshotStateSha256)(document);
      const size = options.thumbnailSize === undefined ? DEFAULT_THUMBNAIL_SIZE : options.thumbnailSize;
      let thumbnail: Blob | null = null;
      if (size && source.thumbnail && !source.busy()) {
        try {
          thumbnail = await source.thumbnail(size.width, size.height);
        } catch {
          thumbnail = null;
        }
      }
      const ref = await options.snapshots.save(document, saveOptionsFor(document, thumbnail, signal));
      const project = await options.projects.create({
        labId: options.labId,
        title: name,
        description: options.description ?? "",
        ...ref,
      });
      const session = new ProjectSession({ ...options, project });
      // a brand-new project: nobody else can hold its lock
      await session.claimLock();
      await session.rememberLocal(document);
      session.seed({ fingerprint, ref }, project.createdAt, thumbnail === null);
      if (missed) session.handleChange(missed);
      return session;
    } finally {
      stopListening();
    }
  }

  // public API -------------------------------------------------------------------------------------------------------

  get project(): Project {
    return this.record;
  }

  getState(): SessionState {
    return this.state;
  }

  /** State changes; while anyone listens the lab's busy reason is polled into state.busyReason. */
  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    this.watchBusy();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.clearTimer("busyWatch");
    };
  }

  hasUnsavedChanges(): boolean {
    return this.hasUnsaved();
  }

  /** Which actions the editor offers now (sessionGates of the current state). */
  gates(): SessionGates {
    return sessionGates(this.state);
  }

  /**
   * Takes the editing lock (another tab holding it: read-only), loads the project's draft (or head version) into the
   * lab and starts clean; work the lab captured before it left is saved first. Unsaved changes found in the local
   * journal are offered as state.recoverable.
   */
  open(): Promise<LabRestoreReport | null> {
    if (this.disposed) return Promise.reject(this.disposedError());
    return this.enqueue(async () => {
      await this.claimLock();
      return this.reloadTask("open", "check");
    });
  }

  /**
   * Saves pending changes now: the local journal, then the cloud draft without waiting for the cadence (pagehide,
   * visibilitychange, leaving the editor). "close" (or { close: true }) also stores a fresh thumbnail for the project
   * card. Never throws; the state says what happened.
   */
  async flush(reason?: SessionFlushReason | { close?: boolean | undefined }): Promise<SessionStatus> {
    try {
      if (this.disposed || this.readonlyReason !== null || this.state.status === "conflict") return this.state.status;
      const closing = reason === "close" || (typeof reason === "object" && reason !== null && reason.close === true);
      this.clearDebounce();
      if (this.journal && this.journaledSeq < this.changeSeq) await this.runJournal();
      if (this.state.status === "offline" || this.state.status === "error") {
        this.clearTimer("retry");
        await this.runFailed();
      } else if (this.hasUnsaved() || (closing && this.thumbnailStale)) {
        await this.enqueue(() => this.autosave({ force: true, close: closing }));
      } else {
        await this.tail;
      }
    } catch {
      // the state says what happened
    }
    return this.state.status;
  }

  /**
   * ⌘S ("manual", a no-op returning null when nothing changed since the head) or ⇧⌘S ("named", always a new version
   * with the label). Pending changes are part of the version.
   */
  commit(kind: "manual" | "named", label?: string): Promise<ProjectVersion | null> {
    try {
      this.assertWritable();
    } catch (error) {
      return Promise.reject(error);
    }
    const name = label?.trim() ?? "";
    if (kind === "named" && name === "") {
      return Promise.reject(new PlatformError("invalid_input", "A named version needs a name.", { status: 422, detail: "label" }));
    }
    if (name.length > 120) {
      return Promise.reject(new PlatformError("invalid_input", "Version names have at most 120 characters.", { status: 422, detail: "label" }));
    }
    this.clearDebounce();
    return this.enqueue(async () => {
      // an explicit save is the user's acknowledgement of an inexact restore
      await this.completeAcknowledgement();
      return this.commitTask(kind, name === "" ? undefined : name, kind === "manual");
    });
  }

  /** ⌘S: a manual version of the current state; null when nothing changed since the head. */
  saveNow(): Promise<ProjectVersion | null> {
    return this.commit("manual");
  }

  /** ⇧⌘S: a named version (kept forever), always created. */
  saveNamed(label: string): Promise<ProjectVersion> {
    return this.commit("named", label) as Promise<ProjectVersion>;
  }

  /**
   * Restores a version non-destructively: unsaved work becomes the draft, which the server keeps as an autosave version
   * before it adds the "restore" version; the lab is then reloaded with it.
   */
  restore(versionId: Uuid): Promise<ProjectVersion> {
    try {
      this.assertWritable();
    } catch (error) {
      return Promise.reject(error);
    }
    this.clearDebounce();
    return this.enqueue(async () => {
      await this.completeAcknowledgement();
      return this.restoreTask(versionId);
    });
  }

  /** After an inexact restore (state.awaitingAck): the user has seen the warnings; autosave resumes. */
  acknowledgeRestore(): Promise<void> {
    if (this.disposed) return Promise.reject(this.disposedError());
    if (!this.awaitingAck) return Promise.resolve();
    return this.enqueue(async () => {
      await this.completeAcknowledgement();
      this.settle();
    });
  }

  /** Shows the journalled unsaved changes in the lab and saves them (see state.recoverable). */
  recover(): Promise<LabRestoreReport | null> {
    try {
      this.assertWritable();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.recovery) return Promise.resolve(null);
    this.clearDebounce();
    return this.enqueue(() => this.recoverTask());
  }

  /** The same as recover(). */
  recoverUnsaved(): Promise<LabRestoreReport | null> {
    return this.recover();
  }

  /** Throws the journalled unsaved changes away. */
  async discardRecovery(): Promise<void> {
    if (this.disposed || this.recovery === null) return;
    this.recovery = null;
    this.publish({});
    await this.clearJournal(this.record.id);
  }

  /** The same as discardRecovery(). */
  discardUnsaved(): Promise<void> {
    return this.discardRecovery();
  }

  /** Conflict: drop local changes and show what the server has (its draft, else its head version). */
  reloadRemote(): Promise<LabRestoreReport | null> {
    if (this.disposed) return Promise.reject(this.disposedError());
    this.clearDebounce();
    this.clearTimer("retry");
    return this.enqueue(() => this.reloadTask("remote", "clear"));
  }

  /** "Edit Here": read-only because another tab edits the project; steal the editing lock and show the latest state. */
  async takeOver(): Promise<LabRestoreReport | null> {
    if (this.disposed) throw this.disposedError();
    if (this.readonlyReason !== "locked") return null;
    await this.lock?.takeOver();
    this.alive();
    this.readonlyReason = this.record.trashedAt !== null ? "trashed" : null;
    if (this.readonlyReason !== null) {
      this.publish({ status: "readonly" });
      return null;
    }
    // the other tab saved what it had; its journal entry (if any) is offered, not dropped
    return this.enqueue(() => this.reloadTask("remote", "check"));
  }

  /** The same as takeOver(). */
  editHere(): Promise<LabRestoreReport | null> {
    return this.takeOver();
  }

  /**
   * Keeps what the lab shows as a new project (conflict, read-only or "Couldn't Save"); the session continues with the
   * copy (and its own editing lock), the original project stays as the server has it.
   */
  saveAsCopy(title: string): Promise<Project> {
    if (this.disposed) return Promise.reject(this.disposedError());
    let name: string;
    try {
      name = validTitle(title);
    } catch (error) {
      return Promise.reject(error);
    }
    this.clearDebounce();
    return this.enqueue(() => this.copyTask(name));
  }

  /**
   * Conflict: this tab's state wins. The other side's unsaved draft is first kept as an autosave version, then the
   * failed save (draft, commit or restore) is repeated against the current head.
   */
  overwrite(): Promise<void> {
    if (this.disposed) return Promise.reject(this.disposedError());
    if (this.state.status !== "conflict") return Promise.resolve();
    const failed: FailedOperation = this.failed ?? { operation: "draft" };
    return this.enqueue(() => this.overwriteTask(failed));
  }

  /** Repeats the failed operation now ("Couldn't Save" → Try Again; offline → retry before the backoff ends). */
  async retry(): Promise<void> {
    if (this.disposed || this.state.status === "conflict") return;
    this.clearTimer("retry");
    this.retryAttempt = 0;
    await this.runFailed();
  }

  /** Stops everything and releases the editing lock. Call flush("close") first when leaving the editor. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of ALL_TIMERS) this.clearTimer(timer);
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // the lab may be gone already
      }
    }
    this.lockUnsubscribe?.();
    this.lockUnsubscribe = null;
    this.lock?.release();
    this.abort.abort();
    this.listeners.clear();
  }

  // change tracking -------------------------------------------------------------------------------------------------

  private get readonlyMode(): boolean {
    return this.readonlyReason !== null;
  }

  private handleChange(kind: ChangeKind): void {
    if (this.disposed || this.suppressChanges > 0 || !this.attached) return;
    const now = this.clock.now();
    this.changeSeq += 1;
    if (kind === "document") {
      if (this.lastDocumentChangeAt !== null) {
        this.editingMs += Math.min(Math.max(0, now - this.lastDocumentChangeAt), this.timing.editingGapMs);
      }
      this.lastDocumentChangeAt = now;
      this.lastDocumentSeq = this.changeSeq;
    }
    if (this.readonlyMode) {
      this.publish({});
      return;
    }
    this.burstStartedAt ??= now;
    this.journalBurstStartedAt ??= now;
    this.scheduleJournal();
    const status = this.state.status;
    if (status === "conflict" || (status === "offline" && this.retryTimer !== null)) {
      // a conflict waits for the user; offline retries on its own timer with the newest state
      this.publish({});
      return;
    }
    this.publish(status === "clean" || status === "saved" ? { status: "dirty" } : {});
    this.scheduleAutosave();
  }

  private hasUnsaved(): boolean {
    return this.changeSeq > this.savedSeq || this.unsent !== null;
  }

  /** Milliseconds until the cloud may take the next draft. */
  private cloudWait(): number {
    if (this.lastCloudWriteAt === null) return 0;
    return Math.max(0, this.lastCloudWriteAt + this.timing.draftMinIntervalMs - this.clock.now());
  }

  private scheduleAutosave(): void {
    if (this.disposed) return;
    const now = this.clock.now();
    const wait = this.cloudWait();
    this.clearTimer("idle");
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null;
      this.kick();
    }, Math.max(this.timing.draftIdleMs, wait));
    if (this.maxTimer === null) {
      const start = this.burstStartedAt ?? now;
      this.maxTimer = this.clock.setTimeout(() => {
        this.maxTimer = null;
        this.kick();
      }, Math.max(0, start + this.timing.draftMaxWaitMs - now, wait));
    }
  }

  private kick(): void {
    if (this.disposed || this.autosaveQueued) return;
    this.autosaveQueued = true;
    this.enqueue(async () => {
      this.autosaveQueued = false;
      const force = this.forceNextCloudWrite;
      this.forceNextCloudWrite = false;
      await this.autosave({ force });
    }).catch(() => undefined);
  }

  private handleOnline(): void {
    if (this.disposed || this.state.status !== "offline") return;
    this.clearTimer("retry");
    this.retryAttempt = 0;
    void this.runFailed();
  }

  /** The lab left on its own: its later edits are not this project's; what it captured before still goes out. */
  private handleLeave(): void {
    if (this.disposed || !this.attached) return;
    this.attached = false;
    this.detached = true;
    this.clearTimer("journalIdle");
    this.clearTimer("journalMax");
    this.publish({});
    if (this.hasUnsaved() && (this.unsent !== null || (this.latest !== null && this.latest.seq === this.changeSeq))) {
      this.forceNextCloudWrite = true;
      this.kick();
    }
  }

  /** Another tab took over editing: this tab saves what it still has, then turns read-only. */
  private handleLockLost(): void {
    if (this.disposed || this.readonlyReason === "locked") return;
    void this.flush().finally(() => {
      if (this.disposed) return;
      this.readonlyReason = this.record.trashedAt !== null ? "trashed" : "locked";
      for (const timer of ["idle", "max", "retry", "busy", "journalIdle", "journalMax"] as const) this.clearTimer(timer);
      this.publish({ status: "readonly", activity: "idle", retryAt: null });
    });
  }

  private watchLock(): void {
    const lock = this.lock;
    this.lockUnsubscribe = lock ? lock.onLost(() => this.handleLockLost()) : null;
  }

  /** open() and createProject: take the editing lock; held by another tab, this one stays read-only. */
  private async claimLock(): Promise<void> {
    const lock = this.lock;
    if (lock === null || this.readonlyOption || this.record.trashedAt !== null) return;
    let held = lock.held();
    if (!held) {
      try {
        held = await lock.acquire();
      } catch {
        held = false;
      }
      this.alive();
    }
    this.readonlyReason = held ? null : "locked";
    const status = this.state.status;
    this.publish({ status: held ? (status === "readonly" ? "clean" : status) : "readonly" });
  }

  /** A saved copy continues here: the original's lock goes, the copy gets its own (with a lock factory). */
  private async switchLock(projectId: Uuid): Promise<void> {
    this.lockUnsubscribe?.();
    this.lockUnsubscribe = null;
    this.lock?.release();
    this.lock = this.lockFactory ? this.lockFactory(projectId) : null;
    if (this.lock === null) return;
    this.watchLock();
    let held = false;
    try {
      held = await this.lock.acquire();
    } catch {
      held = false;
    }
    this.alive();
    if (!held) this.readonlyReason = "locked";
  }

  private readBusy(): string | null {
    try {
      const reason = this.lab.busy();
      return reason ? String(reason) : null;
    } catch {
      return "unavailable";
    }
  }

  private refreshBusy(): void {
    const reason = this.readBusy();
    if (reason !== this.state.busyReason) this.publish({ busyReason: reason });
  }

  // the bridge has no busy event: poll it while a UI listens (gates for Restore, Close and Record)
  private watchBusy(): void {
    if (this.disposed || this.busyWatchTimer !== null) return;
    this.refreshBusy();
    const tick = (): void => {
      this.busyWatchTimer = null;
      if (this.disposed || this.listeners.size === 0) return;
      this.refreshBusy();
      this.busyWatchTimer = this.clock.setTimeout(tick, this.timing.busyPollMs);
    };
    this.busyWatchTimer = this.clock.setTimeout(tick, this.timing.busyPollMs);
  }

  // queue and timers --------------------------------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => {
      if (this.disposed) throw this.disposedError();
      return task();
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private clearTimer(which: TimerName): void {
    const key = `${which}Timer` as const;
    const handle = this[key];
    if (handle !== null) this.clock.clearTimeout(handle);
    this[key] = null;
  }

  private clearDebounce(): void {
    this.clearTimer("idle");
    this.clearTimer("max");
  }

  private disposedError(): SessionError {
    return new SessionError("disposed", "The project session was closed.");
  }

  private alive(): void {
    if (this.disposed) throw this.disposedError();
  }

  private assertWritable(): void {
    this.alive();
    if (this.record.trashedAt !== null) {
      throw new PlatformError("project_trashed", "Restore the project from the Trash to change it.", { status: 409 });
    }
    if (this.readonlyReason === "locked") {
      throw new SessionError("readonly", "This project is being edited in another tab. Choose Edit Here to edit it in this one.");
    }
    if (this.readonlyMode) throw new SessionError("readonly", "This project is read-only.");
    if (this.detached) throw new SessionError("detached", "The lab no longer shows this project. Open the project again to keep editing.");
    if (this.state.status === "conflict") {
      throw new SessionError("conflict", "Another tab or device changed this project: reload it, save a copy or overwrite first.");
    }
  }

  private expected(): { headVersionId: Uuid | null; draftRev: number } {
    return { headVersionId: this.record.headVersionId, draftRev: this.record.draftRev };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => reject(new SessionError("timeout", message)), ms);
      promise.then(
        (value) => {
          this.clock.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.clock.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private recoverableState(): RecoverableChanges | null {
    const entry = this.recovery;
    if (entry === null) {
      this.recoverableView = null;
      return null;
    }
    const savedAt = new Date(entry.savedAt).toISOString();
    const stale = entry.baseHeadVersionId !== this.record.headVersionId || entry.baseDraftRev !== this.record.draftRev;
    const previous = this.recoverableView;
    if (previous && previous.savedAt === savedAt && previous.stale === stale) return previous;
    this.recoverableView = { savedAt, stale };
    return this.recoverableView;
  }

  private localCopyState(): SessionState["localCopy"] {
    if (!this.journal) return "off";
    if (this.journalFailed) return "failed";
    return !this.hasUnsaved() || this.journaledSeq >= this.changeSeq ? "saved" : "pending";
  }

  /** Patches carry `error`; failure, labLeft and awaitingAck (and their first names) are derived here. */
  private publish(patch: Partial<SessionState>): void {
    if (this.disposed) return;
    const record = this.record;
    const merged: SessionState = { ...this.state, ...patch };
    const next: SessionState = {
      ...merged,
      projectId: record.id,
      labId: record.labId,
      headVersionId: record.headVersionId,
      headSeq: record.headSeq,
      draftRev: record.draftRev,
      hasDraft: record.draftAssetId !== null,
      pending: this.hasUnsaved(),
      lastSavedAt: this.lastSavedAt,
      failure: merged.error,
      editingMs: this.editingMs,
      readonlyReason: this.readonlyReason,
      labLeft: this.detached,
      detached: this.detached,
      recoverable: this.recoverableState(),
      awaitingAck: this.awaitingAck,
      acknowledgementNeeded: this.awaitingAck,
      localCopy: this.localCopyState(),
    };
    if (sameState(next, this.state)) return;
    this.state = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // a failing UI listener must not break saving
      }
    }
  }

  // local-only attachments -------------------------------------------------------------------------------------------

  /** Keeps the bytes of the document's local-only attachments on this device (memory, and localFiles when given). */
  private async rememberLocal(document: LabSessionDocument): Promise<void> {
    const names = document.localOnly;
    const parts = document.attachments;
    if (!names || names.length === 0 || !parts) return;
    for (const name of names) {
      const blob = parts[name];
      if (!blob) continue;
      try {
        const sha256 = await sha256OfBlob(blob);
        if (this.localBlobs.has(sha256)) continue;
        this.localBlobs.set(sha256, blob);
        while (this.localBlobs.size > MAX_LOCAL_BLOBS) {
          const oldest = this.localBlobs.keys().next().value;
          if (oldest === undefined) break;
          this.localBlobs.delete(oldest);
        }
        if (this.localFiles) await this.localFiles.put(sha256, blob).catch(() => undefined);
      } catch {
        // kept in the state's hash either way; a restore here would then ask the lab for the file
      }
    }
  }

  private async localAttachment(sha256: string): Promise<Blob | null> {
    const known = this.localBlobs.get(sha256);
    if (known) return known;
    if (!this.localFiles) return null;
    try {
      const blob = await this.localFiles.get(sha256);
      // a device store may be cleared or damaged: only the exact bytes count
      return blob && (await sha256OfBlob(blob)) === sha256 ? blob : null;
    } catch {
      return null;
    }
  }

  /**
   * Downloads a stored document, supplying local-only attachments from this device and listing those it does not have.
   * A document of another lab is refused (DESIGN.md §15.6).
   */
  private async loadSnapshot(snapshot: StoredSnapshot): Promise<LoadedDocument> {
    const local = new Set<string>();
    const missingLocal: MissingLocalAttachment[] = [];
    const document = await this.snapshots.load(snapshot, {
      signal: this.abort.signal,
      getLocalAttachment: async (name, entry) => {
        local.add(name);
        const blob = await this.localAttachment(entry.sha256);
        if (blob === null) missingLocal.push({ name, sha256: entry.sha256 });
        return blob;
      },
    });
    this.alive();
    if (document.labId !== this.record.labId) {
      throw new SessionError("lab_mismatch", `The stored state belongs to "${document.labId}", not to this project's lab "${this.record.labId}".`);
    }
    // saved again later (a kept draft), they must stay on this device
    if (local.size > 0) document.localOnly = [...local].sort();
    missingLocal.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { document, missingLocal };
  }

  // capture -----------------------------------------------------------------------------------------------------------

  /**
   * One serialization of the idle lab at a time, shared by the journal and the cloud draft; a snapshot that already
   * covers every change is reused. Null while the lab is busy (or turns busy during the call).
   */
  private snapshotLab(): Promise<LabSnapshot | null> {
    const run = this.serializing.then(async (): Promise<LabSnapshot | null> => {
      this.alive();
      if (this.latest !== null && this.latest.seq === this.changeSeq) return this.latest;
      // a lab that left may show another document now (even a fresh one of the same lab): never the project's state
      if (!this.attached || this.lab.busy()) return null;
      const seq = this.changeSeq;
      const documentSeq = this.lastDocumentSeq;
      let document: LabSessionDocument;
      try {
        document = await this.withTimeout(this.lab.serialize(), this.timing.serializeTimeoutMs, "The lab did not hand over its state in time.");
      } catch (error) {
        this.alive();
        // it became busy (a recording started, the lab is reloading) between the check and the call
        if (this.lab.busy()) return null;
        throw error;
      }
      this.alive();
      if (document.labId !== this.record.labId) {
        throw new SessionError("lab_mismatch", `The lab holds "${document.labId}" state, but this project belongs to "${this.record.labId}".`);
      }
      const fingerprint = await this.fingerprintOf(document);
      this.alive();
      await this.rememberLocal(document);
      this.alive();
      const snapshot: LabSnapshot = { document, fingerprint, seq, documentSeq };
      if (this.latest === null || this.latest.seq <= seq) this.latest = snapshot;
      return snapshot;
    });
    this.serializing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A capture the server can take as is: the failed one still covering every change, else the newest snapshot. */
  private currentCapture(): Capture | null {
    if (this.unsent !== null && this.unsent.seq === this.changeSeq) return this.unsent;
    if (this.latest !== null && this.latest.seq === this.changeSeq) return { ...this.latest, thumbnail: null, ref: null };
    return null;
  }

  private waitForLab(reason: string): void {
    this.publish({ activity: "waiting-for-lab", waitingFor: reason, busyReason: reason });
    if (this.busyTimer !== null) return;
    this.busyTimer = this.clock.setTimeout(() => {
      this.busyTimer = null;
      this.kick();
    }, this.timing.busyPollMs);
  }

  /**
   * The lab's state for the cloud. Busy: autosave (wait=false) stores a capture it already has or schedules a poll;
   * explicit saves wait up to busyTimeoutMs. State captured before the lab went away or got busy still goes out.
   */
  private async captureLab(options: { thumbnail: boolean; wait: boolean }): Promise<Capture | null> {
    const deadline = this.clock.now() + this.timing.busyTimeoutMs;
    for (;;) {
      const reason = this.lab.busy();
      let snapshot: LabSnapshot | null = null;
      if (!reason) snapshot = await this.snapshotLab();
      if (snapshot === null) {
        const current = this.currentCapture();
        if (current) return current;
        if (!this.attached) {
          // the lab left: only what it captured before can still go out
          if (!options.wait && this.unsent) return this.unsent;
          if (!options.wait) return null;
          throw new SessionError("detached", "The lab no longer shows this project. Open the project again to keep editing.");
        }
        const busy = this.lab.busy() || reason || "busy";
        if (!options.wait) {
          // autosave stores an older capture rather than nothing; the newer changes wait for the lab
          if (this.unsent) return this.unsent;
          this.waitForLab(busy);
          return null;
        }
        if (this.clock.now() >= deadline) throw new SessionError("lab_busy", `The lab is busy (${busy}); try again when it finishes.`);
        this.publish({ activity: "waiting-for-lab", waitingFor: busy, busyReason: busy });
        await sleep(this.clock, this.timing.busyPollMs, this.abort.signal);
        continue;
      }
      this.clearTimer("busy");
      this.clearDebounce();
      this.burstStartedAt = null;
      this.publish({ waitingFor: null });
      let thumbnail: Blob | null = null;
      if (options.thumbnail && this.thumbnailSize && this.lab.thumbnail && !this.lab.busy()) {
        try {
          thumbnail = await this.lab.thumbnail(this.thumbnailSize.width, this.thumbnailSize.height);
        } catch {
          thumbnail = null;
        }
        this.alive();
      }
      return { ...snapshot, thumbnail, ref: null };
    }
  }

  // the local journal -------------------------------------------------------------------------------------------------

  private scheduleJournal(): void {
    // while recovery is undecided the journal keeps the entry it offers
    if (!this.journal || this.disposed || this.readonlyMode || !this.attached || this.recovery !== null) return;
    const now = this.clock.now();
    this.clearTimer("journalIdle");
    this.journalIdleTimer = this.clock.setTimeout(() => {
      this.journalIdleTimer = null;
      void this.runJournal();
    }, this.timing.journalIdleMs);
    if (this.journalMaxTimer === null) {
      const start = this.journalBurstStartedAt ?? now;
      this.journalMaxTimer = this.clock.setTimeout(() => {
        this.journalMaxTimer = null;
        void this.runJournal();
      }, Math.max(0, start + this.timing.journalMaxWaitMs - now));
    }
  }

  private journalOp<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.journalTail.then(operation, operation);
    this.journalTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async clearJournal(projectId: Uuid): Promise<void> {
    const journal = this.journal;
    if (!journal) return;
    if (projectId === this.record.id) this.journaledFingerprint = null;
    try {
      await this.journalOp(() => journal.clear(projectId));
    } catch {
      // an entry left behind is offered once more and then discarded
    }
  }

  private async runJournal(): Promise<void> {
    const journal = this.journal;
    if (!journal || this.disposed || this.readonlyMode || !this.attached || this.recovery !== null || this.journalRunning) return;
    if (this.journaledSeq >= this.changeSeq) return;
    this.journalRunning = true;
    this.clearTimer("journalIdle");
    this.clearTimer("journalMax");
    this.journalBurstStartedAt = null;
    let retryLater = false;
    try {
      const snapshot = await this.snapshotLab();
      if (snapshot === null) {
        // busy (recording, loading): try again shortly
        retryLater = true;
        return;
      }
      const projectId = this.record.id;
      if (this.stored !== null && snapshot.fingerprint === this.stored.fingerprint) {
        // back to what the server has: an older entry would only offer stale "unsaved" changes
        if (this.journaledFingerprint !== null) await this.clearJournal(projectId);
      } else if (snapshot.fingerprint !== this.journaledFingerprint) {
        const entry: JournalEntry = {
          projectId,
          labId: this.record.labId,
          document: snapshot.document,
          fingerprint: snapshot.fingerprint,
          savedAt: this.clock.now(),
          baseHeadVersionId: this.record.headVersionId,
          baseDraftRev: this.record.draftRev,
        };
        await this.journalOp(() => journal.write(entry));
        this.journaledFingerprint = snapshot.fingerprint;
      }
      this.journaledSeq = Math.max(this.journaledSeq, snapshot.seq);
      this.journalFailed = false;
      // the cloud caught up while the entry was being written
      if (this.savedSeq >= snapshot.seq && this.journaledFingerprint !== null) await this.clearJournal(projectId);
    } catch {
      // storage refused (quota, private browsing) or the lab could not serialize: the cloud draft still runs
      if (!this.disposed) this.journalFailed = true;
    } finally {
      this.journalRunning = false;
      if (!this.disposed) {
        this.publish({});
        if (retryLater) {
          this.clearTimer("journalMax");
          this.journalMaxTimer = this.clock.setTimeout(() => {
            this.journalMaxTimer = null;
            void this.runJournal();
          }, this.timing.busyPollMs);
        } else if (this.journaledSeq < this.changeSeq && this.journalIdleTimer === null && this.journalMaxTimer === null) {
          this.scheduleJournal();
        }
      }
    }
  }

  /** On open: unsaved work this device journalled that the server does not have is offered for recovery. */
  private async checkJournal(storedFingerprint: string): Promise<void> {
    const journal = this.journal;
    this.recovery = null;
    if (!journal) return;
    let entry: JournalEntry | null = null;
    try {
      entry = await this.journalOp(() => journal.read(this.record.id));
    } catch {
      return;
    }
    this.alive();
    if (entry === null) return;
    if (entry.labId !== this.record.labId || entry.document.labId !== this.record.labId || entry.fingerprint === storedFingerprint) {
      await this.clearJournal(this.record.id);
      return;
    }
    this.recovery = entry;
  }

  /** After a cloud write: the journal is only needed for changes newer than what the server now has. */
  private afterStored(capture: Capture): void {
    if (this.journal && this.journaledFingerprint !== null && this.journaledSeq <= capture.seq) {
      void this.clearJournal(this.record.id);
    }
  }

  // store ---------------------------------------------------------------------------------------------------------------

  private async upload(capture: Capture): Promise<SnapshotRef> {
    if (capture.ref) return capture.ref;
    // the same state uploaded by a failed attempt (or already stored) needs no second upload
    if (this.unsent?.ref && this.unsent.fingerprint === capture.fingerprint && capture.thumbnail === null) {
      capture.ref = this.unsent.ref;
      return capture.ref;
    }
    if (this.stored?.ref && this.stored.fingerprint === capture.fingerprint && capture.thumbnail === null) {
      capture.ref = this.stored.ref;
      return capture.ref;
    }
    const ref = await this.snapshots.save(capture.document, saveOptionsFor(capture.document, capture.thumbnail, this.abort.signal));
    this.alive();
    capture.ref = ref;
    return ref;
  }

  /** The server holds everything up to this capture (stored now, or already equal to what it had). */
  private acknowledge(capture: Capture, stored: boolean): void {
    this.savedSeq = Math.max(this.savedSeq, capture.seq);
    if (this.unsent !== null && this.unsent.seq <= capture.seq) this.unsent = null;
    this.failed = null;
    if (!stored) return;
    this.savedThisSession = true;
    this.thumbnailStale = capture.thumbnail === null;
    this.afterStored(capture);
  }

  /** After a successful operation: saved/clean, or dirty again when changes arrived meanwhile. */
  private settle(): void {
    this.clearTimer("retry");
    this.retryAttempt = 0;
    const unsaved = this.hasUnsaved();
    const status: SessionStatus = this.readonlyMode ? "readonly" : unsaved ? "dirty" : this.savedThisSession ? "saved" : "clean";
    this.publish({ status, activity: "idle", waitingFor: null, error: null, conflict: null, retryAt: null });
    if (unsaved && !this.readonlyMode && this.attached) this.scheduleAutosave();
  }

  /** A version is the head now: adopt the project the server returned with it (its head and draft revision). */
  private applyVersion(version: ProjectVersion, stored: StoredState, project: Project): void {
    this.record = { ...project };
    this.stored = stored;
    this.editingMs = 0;
    this.lastSavedAt = version.createdAt;
  }

  private async autosave(options: { force?: boolean; close?: boolean } = {}): Promise<void> {
    if (this.disposed || this.readonlyMode || this.state.status === "conflict") return;
    // an inexact restore waits for the user before anything replaces what is stored
    if (this.awaitingAck) return;
    const closing = options.close === true;
    if (!this.hasUnsaved() && !(closing && this.thumbnailStale)) {
      this.settle();
      return;
    }
    if (!options.force) {
      const wait = this.cloudWait();
      if (wait > 0) {
        this.clearTimer("idle");
        this.idleTimer = this.clock.setTimeout(() => {
          this.idleTimer = null;
          this.kick();
        }, wait);
        return;
      }
    }
    const checkpointDue = this.lastDocumentSeq > this.savedSeq && this.editingMs >= this.timing.checkpointEveryMs;
    let capture: Capture | null = null;
    try {
      capture = await this.captureLab({ thumbnail: closing || checkpointDue, wait: false });
      if (capture === null) return;
      await this.store(capture);
    } catch (error) {
      this.fail(error, { operation: "draft" }, capture);
    }
  }

  private async store(capture: Capture): Promise<void> {
    const checkpoint = capture.documentSeq > this.savedSeq && this.editingMs >= this.timing.checkpointEveryMs;
    const unchanged = this.stored !== null && capture.fingerprint === this.stored.fingerprint;
    if (unchanged && !(capture.thumbnail !== null && this.thumbnailStale)) {
      // nothing new for the server; a due checkpoint still turns the stored draft into a version
      if (checkpoint && this.record.draftAssetId !== null) {
        await this.commitCapture(capture, "autosave", undefined);
        return;
      }
      this.acknowledge(capture, false);
      this.settle();
      return;
    }
    if (checkpoint) {
      await this.commitCapture(capture, "autosave", undefined);
      return;
    }
    await this.writeDraft(capture);
    this.settle();
  }

  /** Uploads the capture and makes it the project's draft (save_draft with the head and draft revision it started from). */
  private async writeDraft(capture: Capture): Promise<void> {
    this.publish({ status: "saving", activity: "saving" });
    const ref = await this.upload(capture);
    const project = await this.projects.saveDraft(this.record.id, this.expected(), ref);
    this.alive();
    this.record = { ...project };
    this.stored = { fingerprint: capture.fingerprint, ref };
    this.lastSavedAt = project.draftSavedAt ?? new Date(this.clock.now()).toISOString();
    this.lastCloudWriteAt = this.clock.now();
    this.acknowledge(capture, true);
  }

  private async commitCapture(capture: Capture, kind: CommitKind, label: string | undefined): Promise<ProjectVersion> {
    this.publish({ status: "saving", activity: "committing" });
    const ref = await this.upload(capture);
    // commit_version checks the head and the draft revision (409), so another device's draft is never cleared unseen
    const { project, version } = await this.projects.commit(this.record.id, this.expected(), kind, ref, label);
    this.alive();
    this.applyVersion(version, { fingerprint: capture.fingerprint, ref }, project);
    this.acknowledge(capture, true);
    this.settle();
    return version;
  }

  private async commitTask(kind: CommitKind, label: string | undefined, skipUnchanged: boolean): Promise<ProjectVersion | null> {
    let capture: Capture | null = null;
    try {
      capture = await this.captureLab({ thumbnail: true, wait: true });
      if (capture === null) throw new SessionError("lab_busy", "The lab is busy.");
      const unchanged = this.stored !== null && capture.fingerprint === this.stored.fingerprint && this.record.draftAssetId === null;
      if (skipUnchanged && unchanged) {
        this.acknowledge(capture, false);
        this.settle();
        return null;
      }
      return await this.commitCapture(capture, kind, label);
    } catch (error) {
      this.fail(error, { operation: "commit", kind, label }, capture);
      throw error;
    }
  }

  // restore, reload, recover ------------------------------------------------------------------------------------------

  /**
   * Before a restore: unsaved work becomes the draft, and restore_version keeps the draft as an autosave version before
   * it adds the restore version (DESIGN.md §15.2), in one transaction.
   */
  private async saveWorkInProgress(): Promise<void> {
    if (!this.hasUnsaved()) return;
    let capture: Capture | null = null;
    try {
      capture = await this.captureLab({ thumbnail: false, wait: true });
      if (capture === null) throw new SessionError("lab_busy", "The lab is busy.");
      if (this.stored !== null && capture.fingerprint === this.stored.fingerprint) {
        this.acknowledge(capture, false);
        return;
      }
      await this.writeDraft(capture);
    } catch (error) {
      this.fail(error, { operation: "draft" }, capture);
      throw error;
    }
  }

  private async restoreTask(versionId: Uuid): Promise<ProjectVersion> {
    await this.saveWorkInProgress();
    let result: { project: Project; version: ProjectVersion };
    try {
      this.publish({ status: "saving", activity: "restoring" });
      result = await this.projects.restore(this.record.id, versionId, this.expected());
      this.alive();
    } catch (error) {
      this.fail(error, { operation: "restore", versionId });
      throw error;
    }
    const { project, version } = result;
    // the server's head is the restored version from here on; an unknown fingerprint makes the next save upload
    this.applyVersion(version, { fingerprint: "", ref: null }, project);
    this.savedThisSession = true;
    // the card shows the restored version's thumbnail (or, without one, an older look until the next close)
    this.thumbnailStale = version.thumbnailAssetId === null;
    try {
      const attachments = await this.projects.versionAttachments(version.id);
      this.alive();
      const { document, missingLocal } = await this.loadSnapshot({ snapshotAssetId: version.snapshotAssetId, attachments });
      const fingerprint = await this.fingerprintOf(document);
      this.alive();
      // the work in progress is a version now; an entry still offered for recovery stays the user's call
      if (this.recovery === null) await this.clearJournal(this.record.id);
      await this.showInLab("restore", document, version, missingLocal);
      this.stored = await this.takeBaseline({ fingerprint, ref: refFromVersion(version, attachments) });
      if (this.awaitingAck) await this.keepInexactSource(version, null);
      this.settle();
      return version;
    } catch (error) {
      // only showing it failed: a retry reloads the head, never restores twice
      this.fail(error, { operation: "reload", reason: "remote" });
      throw error;
    }
  }

  private async loadRemote(project: Project): Promise<LoadedDocument & { version: ProjectVersion | null; ref: SnapshotRef | null }> {
    if (project.draftAssetId !== null) {
      const attachments = await this.projects.draftAttachments(project.id);
      this.alive();
      const loaded = await this.loadSnapshot({ snapshotAssetId: project.draftAssetId, attachments });
      return { ...loaded, version: null, ref: refFromDraft(project, attachments, loaded.document.schema) };
    }
    const versions = await this.projects.versions(project.id);
    this.alive();
    const head = versions.find((version) => version.id === project.headVersionId);
    if (!head) throw new PlatformError("not_found", "The project's current version could not be found.", { status: 404 });
    const attachments = await this.projects.versionAttachments(head.id);
    this.alive();
    const loaded = await this.loadSnapshot({ snapshotAssetId: head.snapshotAssetId, attachments });
    return { ...loaded, version: head, ref: refFromVersion(head, attachments) };
  }

  /**
   * Hands a stored document to the host, which reloads the lab. Changes the lab emits until that resolves are ignored
   * (DESIGN.md §15.6); an inexact report makes autosave wait for acknowledgeRestore().
   */
  private async showInLab(
    reason: LabReloadReason,
    document: LabSessionDocument,
    version: ProjectVersion | null,
    missingLocal: MissingLocalAttachment[],
  ): Promise<LabRestoreReport | null> {
    if (document.labId !== this.record.labId) {
      throw new SessionError("lab_mismatch", `The stored state belongs to "${document.labId}", not to this project's lab "${this.record.labId}".`);
    }
    this.suppressChanges += 1;
    this.clearDebounce();
    for (const timer of ["busy", "journalIdle", "journalMax"] as const) this.clearTimer(timer);
    this.publish({ activity: reason === "restore" ? "restoring" : reason === "recover" ? "recovering" : "reloading" });
    let report: LabRestoreReport | null;
    try {
      let raw: LabRestoreReport | void;
      try {
        raw = await this.reloadLab({ reason, document, version, signal: this.abort.signal, missingLocal });
      } catch (error) {
        // a half-reloaded lab shows no stored state: its edits must not be saved into the project
        this.attached = false;
        this.detached = true;
        throw error;
      }
      this.alive();
      report = raw ? { exact: raw.exact === true, warnings: [...raw.warnings] } : null;
      this.attached = true;
      this.detached = false;
      // the lab now shows exactly this document: earlier local changes belonged to the one it replaced
      this.changeSeq += 1;
      this.savedSeq = this.changeSeq;
      this.journaledSeq = this.changeSeq;
      this.journaledFingerprint = null;
      this.burstStartedAt = null;
      this.journalBurstStartedAt = null;
      this.unsent = null;
      this.latest = null;
      this.awaitingAck = report !== null && !report.exact && reason !== "recover";
    } finally {
      this.suppressChanges -= 1;
    }
    await this.rememberLocal(document);
    this.publish({ lastRestore: report });
    return report;
  }

  /**
   * DESIGN.md §15.6: once a restore resolved, the lab's own serialization is the clean state, so its normalizations
   * are not saved as edits. Kept as stored when the lab is busy, cannot serialize, or a change arrived meanwhile.
   */
  private async takeBaseline(stored: StoredState): Promise<StoredState> {
    const seq = this.changeSeq;
    if (this.savedSeq !== seq || this.lab.busy()) return stored;
    try {
      const snapshot = await this.snapshotLab();
      if (snapshot === null || snapshot.seq !== seq || this.changeSeq !== seq) return stored;
      return snapshot.fingerprint === stored.fingerprint ? stored : { fingerprint: snapshot.fingerprint, ref: null };
    } catch {
      return stored;
    }
  }

  /**
   * An inexact restore keeps its source forever: a version is named (unless the user named it already); a draft,
   * which has no name, becomes a named version when the user acknowledges, before autosave may replace it.
   */
  private async keepInexactSource(version: ProjectVersion | null, draft: KeptDraft | null): Promise<void> {
    if (version === null) {
      this.keepDraft = draft;
      return;
    }
    const target = version.kind === "restore" && version.restoredFromVersionId ? version.restoredFromVersionId : version.id;
    try {
      let label = version.label;
      if (target !== version.id) {
        const versions = await this.projects.versions(this.record.id);
        label = versions.find((candidate) => candidate.id === target)?.label ?? null;
      }
      if (label === null) await this.projects.label(target, INEXACT_RESTORE_LABEL);
    } catch {
      // naming only protects the version from expiry; the restore itself stands
    }
  }

  private async completeAcknowledgement(): Promise<void> {
    if (!this.awaitingAck) return;
    const keep = this.keepDraft;
    if (keep !== null) {
      try {
        // the draft's own files when they are known (nothing uploaded again), else its document
        const ref = keep.ref ?? (await this.snapshots.save(keep.document, saveOptionsFor(keep.document, null, this.abort.signal)));
        const { project, version } = await this.projects.commit(this.record.id, this.expected(), "named", ref, INEXACT_RESTORE_LABEL);
        this.alive();
        const lab = this.stored;
        this.applyVersion(version, { fingerprint: keep.fingerprint, ref }, project);
        // what the lab shows is still its own (baseline) state
        if (lab !== null) this.stored = lab;
        this.keepDraft = null;
      } catch (error) {
        this.fail(error, { operation: "draft" });
        throw error;
      }
    }
    this.awaitingAck = false;
    this.publish({});
  }

  private async reloadTask(reason: "open" | "remote", journal: "check" | "clear"): Promise<LabRestoreReport | null> {
    try {
      this.publish({ activity: "reloading" });
      // work captured before the lab left still goes out before the stored state replaces it
      if (reason === "open" && this.hasUnsaved()) await this.autosave({ force: true });
      if (reason === "remote") {
        this.record = await this.projects.get(this.record.id);
        this.alive();
        if (this.record.trashedAt !== null) this.readonlyReason = "trashed";
      }
      if (journal === "clear") {
        this.recovery = null;
        await this.clearJournal(this.record.id);
      }
      const remote = await this.loadRemote(this.record);
      this.alive();
      const fingerprint = await this.fingerprintOf(remote.document);
      this.alive();
      if (journal === "check") await this.checkJournal(fingerprint);
      const report = await this.showInLab(reason, remote.document, remote.version, remote.missingLocal);
      this.stored = await this.takeBaseline({ fingerprint, ref: remote.ref });
      this.failed = null;
      this.editingMs = 0;
      this.savedThisSession = false;
      this.lastSavedAt = this.record.draftSavedAt ?? this.record.updatedAt;
      this.lastCloudWriteAt = null;
      if (this.awaitingAck) await this.keepInexactSource(remote.version, { document: remote.document, fingerprint, ref: remote.ref });
      if (reason === "open" && this.stampOpened && !this.readonlyMode) {
        // opened_at only orders the project lists; it changes neither the head nor the draft revision
        await this.projects.update(this.record.id, { opened: true }).catch(() => undefined);
        this.alive();
      }
      this.settle();
      return report;
    } catch (error) {
      this.fail(error, { operation: "reload", reason });
      throw error;
    }
  }

  /** Commits the server's unsaved draft as an autosave version (its stored files, by reference), so replacing it loses nothing. */
  private async keepRemoteDraft(remote: Project): Promise<Project> {
    if (remote.draftAssetId === null) return remote;
    const attachments = await this.projects.draftAttachments(remote.id);
    this.alive();
    // read for its schema; the version reuses the stored files as they are
    const { document } = await this.loadSnapshot({ snapshotAssetId: remote.draftAssetId, attachments });
    const ref = refFromDraft(remote, attachments, document.schema) ?? (await this.snapshots.save(document, saveOptionsFor(document, null, this.abort.signal)));
    const { project } = await this.projects.commit(remote.id, { headVersionId: remote.headVersionId, draftRev: remote.draftRev }, "autosave", ref);
    this.alive();
    return project;
  }

  private async recoverTask(): Promise<LabRestoreReport | null> {
    const entry = this.recovery;
    if (entry === null) return null;
    try {
      this.publish({ activity: "recovering" });
      let remote = await this.projects.get(this.record.id);
      this.alive();
      if (remote.trashedAt !== null) throw new PlatformError("project_trashed", "The project was moved to the Trash.", { status: 409 });
      // the project moved on since these changes were journalled: its newer working copy becomes a version first
      if (remote.headVersionId !== entry.baseHeadVersionId || remote.draftRev !== entry.baseDraftRev) {
        remote = await this.keepRemoteDraft(remote);
      }
      this.record = remote;
      // a journal entry holds every attachment's bytes: nothing is missing on this device
      const report = await this.showInLab("recover", entry.document, null, []);
      this.recovery = null;
      // the lab shows work the server does not have: one document change, already in the journal, saved right away
      this.changeSeq += 1;
      this.lastDocumentSeq = this.changeSeq;
      this.journaledSeq = this.changeSeq;
      this.journaledFingerprint = entry.fingerprint;
      this.stored = null;
      this.lastCloudWriteAt = null;
      this.publish({ status: "dirty", activity: "idle", error: null });
      this.forceNextCloudWrite = true;
      this.kick();
      return report;
    } catch (error) {
      if (!this.disposed) this.publish({ activity: "idle", error: describeFailure(error, "recover") });
      throw error;
    }
  }

  private async copyTask(title: string): Promise<Project> {
    const before = this.state.status;
    const previousId = this.record.id;
    let capture: Capture | null = null;
    try {
      this.publish({ activity: "resolving" });
      capture = await this.captureLab({ thumbnail: true, wait: true });
      if (capture === null) throw new SessionError("lab_busy", "The lab is busy.");
      this.publish({ status: "saving" });
      const ref = await this.upload(capture);
      const project = await this.projects.create({ labId: this.record.labId, title, description: this.record.description, ...ref });
      this.alive();
      this.record = { ...project };
      this.readonlyOption = false;
      this.readonlyReason = null;
      this.stored = { fingerprint: capture.fingerprint, ref };
      this.editingMs = 0;
      this.lastSavedAt = project.createdAt;
      this.unsent = null;
      this.recovery = null;
      this.keepDraft = null;
      this.awaitingAck = false;
      // the copy holds what the journal kept for the original
      await this.clearJournal(previousId);
      this.journaledFingerprint = null;
      await this.switchLock(project.id);
      this.acknowledge(capture, true);
      this.settle();
      return project;
    } catch (error) {
      // the session keeps its project and state; only the copy failed
      if (!this.disposed) {
        const status = (before === "clean" || before === "saved") && this.hasUnsaved() ? "dirty" : before;
        this.publish({ status, activity: "idle", error: describeFailure(error, "copy") });
        if (status === "dirty") this.scheduleAutosave();
      }
      throw error;
    }
  }

  private async overwriteTask(failed: FailedOperation): Promise<void> {
    try {
      this.publish({ activity: "resolving" });
      const remote = await this.projects.get(this.record.id);
      this.alive();
      if (remote.trashedAt !== null) throw new PlatformError("project_trashed", "The project was moved to the Trash.", { status: 409 });
      // the other side's working copy is not in the history yet: keep it as an autosave version first
      this.record = await this.keepRemoteDraft(remote);
      // what the server stores is theirs now; ours always uploads
      this.stored = null;
      this.publish({ status: "dirty", activity: "idle", conflict: null, error: null });
    } catch (error) {
      this.fail(error, failed);
      throw error;
    }
    switch (failed.operation) {
      case "commit":
        await this.commitTask(failed.kind, failed.label, false);
        return;
      case "restore":
        await this.restoreTask(failed.versionId);
        return;
      case "reload":
        await this.reloadTask(failed.reason, "check");
        return;
      case "draft":
        await this.autosave({ force: true });
        if (this.state.status === "conflict" || this.state.status === "error") {
          throw new PlatformError("unknown", this.state.error?.message ?? "The overwrite did not complete.");
        }
        return;
    }
  }

  /** Repeats the failed operation (automatic retries, retry(), flush() while offline). */
  private async runFailed(): Promise<void> {
    let failed: FailedOperation = this.failed ?? { operation: "draft" };
    // a restored version that could not be shown: edits made since on the still-valid old state are kept instead
    if (failed.operation === "reload" && failed.reason === "remote" && this.attached && this.hasUnsaved()) {
      failed = { operation: "draft" };
    }
    try {
      switch (failed.operation) {
        case "draft":
          await this.enqueue(() => this.autosave({ force: true }));
          return;
        case "commit":
          await this.enqueue(() => this.commitTask(failed.kind, failed.label, failed.kind !== "named"));
          return;
        case "restore":
          await this.enqueue(() => this.restoreTask(failed.versionId));
          return;
        case "reload":
          await this.enqueue(() => this.reloadTask(failed.reason, "check"));
          return;
      }
    } catch {
      // the failure is in the state again
    }
  }

  private scheduleRetry(): void {
    this.clearTimer("retry");
    const delays = this.timing.retryDelaysMs;
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)] ?? 30_000;
    this.retryAttempt += 1;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      void this.runFailed();
    }, delay);
    this.publish({ retryAt: this.clock.now() + delay });
  }

  private fail(error: unknown, operation: FailedOperation, capture: Capture | null = null): void {
    if (this.disposed || (error instanceof SessionError && error.code === "disposed")) return;
    // keep the captured state: the lab may be gone by the time the save can be repeated
    if (capture !== null) this.unsent = capture;
    const failure = describeFailure(error, operation.operation);
    const online = this.connectivity ? this.connectivity.online() : true;
    const kind = classifyFailure(error, online);
    if (kind === "conflict") {
      this.failed = operation;
      this.clearDebounce();
      this.clearTimer("retry");
      this.publish({ status: "conflict", activity: "idle", conflict: parseConflict(error, operation.operation), error: failure, retryAt: null });
      return;
    }
    if (kind === "readonly") {
      this.readonlyReason = "trashed";
      this.failed = null;
      this.clearDebounce();
      this.clearTimer("retry");
      this.record = { ...this.record, trashedAt: this.record.trashedAt ?? new Date(this.clock.now()).toISOString() };
      this.publish({ status: "readonly", activity: "idle", error: failure, retryAt: null });
      return;
    }
    let retry: FailedOperation = operation;
    if (operation.operation === "restore") {
      // a failed restore is its caller's to report and repeat: never restore later on a timer; only unsaved work retries
      if (!this.hasUnsaved()) {
        this.failed = null;
        this.publish({ status: this.savedThisSession ? "saved" : "clean", activity: "idle", error: failure, waitingFor: null, retryAt: null });
        return;
      }
      retry = { operation: "draft" };
    }
    this.failed = retry;
    if (kind === "offline") {
      this.publish({ status: "offline", activity: "idle", error: failure, waitingFor: null });
      this.scheduleRetry();
    } else if (kind === "transient" && this.retryAttempt < this.timing.transientRetries) {
      this.publish({ status: this.hasUnsaved() ? "dirty" : "error", activity: "idle", error: failure, waitingFor: null });
      this.scheduleRetry();
    } else {
      this.publish({ status: "error", activity: "idle", error: failure, waitingFor: null, retryAt: null });
    }
  }

  private seed(stored: StoredState, savedAt: IsoDate, thumbnailMissing: boolean): void {
    this.attached = true;
    this.stored = stored;
    this.savedThisSession = true;
    this.lastSavedAt = savedAt;
    this.thumbnailStale = thumbnailMissing;
    this.publish({ status: this.readonlyMode ? "readonly" : "saved" });
  }
}

/** ProjectSession.createProject as a function: "Save as Project" from a lab opened without a project. */
export function createProject(options: CreateProjectOptions): Promise<ProjectSession>;
export function createProject(labId: string, title: string, lab: SessionLab, deps: CreateProjectDeps): Promise<ProjectSession>;
export function createProject(first: CreateProjectOptions | string, title?: string, lab?: SessionLab, deps?: CreateProjectDeps): Promise<ProjectSession> {
  try {
    return ProjectSession.createProject(createOptionsFrom(first, title, lab, deps));
  } catch (error) {
    return Promise.reject(error);
  }
}

// beforeunload (DESIGN.md §15.5) -------------------------------------------------------------------------------------

/** True while leaving the page would lose work: changes the cloud does not have, or a save still in flight. */
export function shouldWarnBeforeUnload(state: SessionState): boolean {
  if (state.status === "saving") return true;
  if (state.activity === "saving" || state.activity === "committing" || state.activity === "restoring") return true;
  if (state.activity === "recovering" || state.activity === "resolving") return true;
  return state.pending;
}

export interface UnloadEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface BeforeUnloadOptions {
  /** The page's window (defaults to the global one). */
  window?: UnloadEventTarget | undefined;
  /** Its document, for visibilitychange (defaults to the global one). */
  document?: (UnloadEventTarget & { readonly visibilityState: string }) | undefined;
}

/**
 * While the session has work the cloud does not have, leaving the page asks first (beforeunload); pagehide and a hidden
 * page flush it. Returns the uninstaller, so a React effect is `useEffect(() => installBeforeUnload(session), [session])`.
 */
export function installBeforeUnload(
  session: Pick<ProjectSession, "getState" | "flush">,
  options: BeforeUnloadOptions = {},
): () => void {
  const target = options.window ?? (globalThis as { window?: UnloadEventTarget }).window;
  const page = options.document ?? (globalThis as { document?: UnloadEventTarget & { readonly visibilityState: string } }).document;
  if (!target) return () => undefined;
  const beforeUnload = (event: Event): void => {
    if (!shouldWarnBeforeUnload(session.getState())) return;
    event.preventDefault();
    // older browsers show the prompt only for a returnValue
    (event as BeforeUnloadEvent).returnValue = "";
    void session.flush("beforeunload");
  };
  const pagehide = (): void => {
    void session.flush("pagehide");
  };
  const visibility = (): void => {
    if (page?.visibilityState === "hidden") void session.flush("hidden");
  };
  target.addEventListener("beforeunload", beforeUnload);
  target.addEventListener("pagehide", pagehide);
  page?.addEventListener("visibilitychange", visibility);
  return () => {
    target.removeEventListener("beforeunload", beforeUnload);
    target.removeEventListener("pagehide", pagehide);
    page?.removeEventListener("visibilitychange", visibility);
  };
}
