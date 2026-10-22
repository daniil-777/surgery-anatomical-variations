// The platform side of the lab-session contract: connects to a lab running in a same-origin iframe.
//
// Discovery: the lab's registerLabSession() posts "viscera:lab-session" to the parent; the host accepts it only from
// this iframe's window and this origin, then reads window.__visceraLabSessions on the iframe (it also looks there
// directly, for a lab that registered before the host started listening). The iframe can reload or navigate at any
// time: every new document gets a fresh registry, so the connection notices the new document, drops the old adapter
// and reconnects, keeping its own listeners.
//
// Realms: values a lab hands over (states, Blobs, claims) belong to the iframe's realm and die with its document; a
// Blob of a detached iframe may never finish reading. Everything is therefore copied into the platform realm before it
// is kept: states as checked JSON, Blobs byte for byte. In the other direction a restored document is cloned into the
// lab's realm, so lab code may use instanceof.
//
// Also installed in each lab document (capture phase): platform shortcuts (⌘S …), interception of links that would
// replace the lab document, the same for navigations the lab starts by script (Navigation API, where the browser has
// it), and pagehide/visibilitychange as flush signals. A new document the platform did not ask for (reload()) means
// the lab left: onLeave fires and the project session stops saving (DESIGN.md §15.6).
//
// Labs open with ?restore=pending (registry.ts labUrl): they wait for restore() or startFresh() instead of running their
// default start-up. labReloader() turns a connection into the project session's reloadLab.

import {
  LAB_ATTACHMENT_NAME,
  LAB_READY_MESSAGE,
  LAB_RESTORE_PENDING_PARAM,
  LAB_SESSION_PROTOCOL,
  type LabLibraryExport,
  type LabLibraryFile,
  type LabRestoreContext,
  type LabRestoreReport,
  type LabSessionAdapter,
  type LabSessionDocument,
  type LabSessionEvent,
  type LabSessionRegistry,
} from "../../bridge/labSession";
import type { JsonObject, JsonValue, LibraryFileRole, LibraryKind } from "../types";
import {
  classifyShortcut,
  decideLabNavigation,
  decideScriptedNavigation,
  detectShortcutPlatform,
  isRepeatSensitive,
  type LabNavigationRequest,
  type ShortcutAction,
  type ShortcutPlatform,
} from "./navigation";
import { LAB_ID_PATTERN } from "./registry";
import { genericThumbnail, isRecordingActive, largestVisibleCanvas, type ThumbnailBackground } from "./thumbnail";

export type LabChangeKind = "document" | "view";
export type FlushReason = "pagehide" | "hidden";

/** The lab went away without the platform asking: it unloaded, or a new document replaced it. */
export interface LabLeaveEvent {
  reason: "unloaded" | "navigated";
  url: string | null;
}

// The part of the Navigation API used here (not in TypeScript's DOM library yet).
interface NavigateEventLike {
  readonly cancelable: boolean;
  readonly hashChange?: boolean;
  readonly downloadRequest?: string | null;
  readonly destination?: { readonly url: string; readonly sameDocument: boolean };
  preventDefault(): void;
}

interface NavigationLike {
  addEventListener(type: "navigate", listener: (event: Event) => void): void;
  removeEventListener(type: "navigate", listener: (event: Event) => void): void;
}

/** The database's limit on attachments per snapshot (private.attachment_rows). */
export const MAX_ATTACHMENTS = 64;
const MAX_JSON_DEPTH = 200;

// Errors ------------------------------------------------------------------------------------------------------------

/** No adapter is registered (still loading, navigated away, or the connection was closed). */
export class LabUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabUnavailableError";
  }
}

/** The lab (or a platform job holding it) is busy; try again when busy() is false. */
export class LabBusyError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`The lab is busy (${reason}).`);
    this.name = "LabBusyError";
    this.reason = reason;
  }
}

/** A lab handed over something the contract does not allow (path says where). */
export class LabDocumentError extends Error {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(`${path} ${problem}`);
    this.name = "LabDocumentError";
    this.path = path;
  }
}

export class LabTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** A lab export whose rights mark it research-only: it may not enter the Library (DESIGN.md §15.7). */
export class LabRightsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabRightsError";
  }
}

/** Rights wording that keeps an export out of the Library ("research-only", "research use only"). */
export function isResearchOnly(claims: { readonly rights?: string | undefined }): boolean {
  return typeof claims.rights === "string" && /\bresearch[\s_-]*(use[\s_-]*)?only\b/i.test(claims.rights);
}

// Realm normalisation (pure) ----------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// a plain object of any realm: its prototype is null or that realm's Object.prototype (whose own prototype is null)
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * A deep copy in this realm that is exactly what JSON can carry: finite numbers, safe integers (uint64 seeds must be
 * decimal strings per the contract), strings, booleans, null, arrays and plain objects. undefined members are dropped
 * and undefined array slots become null, as JSON.stringify does. Anything else throws a LabDocumentError naming the
 * path, so a lab bug surfaces at save time instead of as a project that cannot be restored.
 */
export function cloneJson(value: unknown, path = "value", depth = 0): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new LabDocumentError(path, "is not a finite number");
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new LabDocumentError(path, "is an integer beyond 2^53 (store it as a decimal string)");
      }
      return value;
    case "object": {
      if (depth >= MAX_JSON_DEPTH) throw new LabDocumentError(path, "is nested too deeply (a cycle?)");
      if (Array.isArray(value)) {
        const items: unknown[] = value;
        return items.map((item, index) => (item === undefined ? null : cloneJson(item, `${path}[${index}]`, depth + 1)));
      }
      if (!isPlainObject(value)) throw new LabDocumentError(path, "is not a plain object (binary data belongs in attachments)");
      const copy: JsonObject = {};
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        copy[key] = cloneJson(item, `${path}.${key}`, depth + 1);
      }
      return copy;
    }
    default:
      throw new LabDocumentError(path, `is a ${typeof value}, which JSON cannot store`);
  }
}

interface BlobLike {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isBlobLike(value: unknown): value is BlobLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { size?: unknown; type?: unknown; arrayBuffer?: unknown };
  return typeof candidate.arrayBuffer === "function" && typeof candidate.type === "string" && typeof candidate.size === "number";
}

/**
 * The same bytes as a Blob of this realm. Blobs from another realm (instanceof fails there) are read and rebuilt with
 * the same type; the cache maps a foreign Blob object to its copy so an unchanged attachment is read once.
 */
export async function toHostBlob(value: unknown, path = "blob", cache?: WeakMap<object, Blob>): Promise<Blob> {
  if (value instanceof Blob) return value;
  if (!isBlobLike(value)) throw new LabDocumentError(path, "is not a Blob");
  const cached = cache?.get(value);
  if (cached) return cached;
  const bytes = await value.arrayBuffer();
  if (bytes.byteLength !== value.size) {
    throw new LabDocumentError(path, `read ${bytes.byteLength} bytes of ${value.size}`);
  }
  const blob = new Blob([bytes], { type: value.type });
  cache?.set(value, blob);
  return blob;
}

/** Checks a lab's serialize() result and copies it into this realm (states as JSON, attachments byte for byte). */
export async function normalizeLabDocument(raw: unknown, cache?: WeakMap<object, Blob>): Promise<LabSessionDocument> {
  if (!isRecord(raw)) throw new LabDocumentError("document", "is not an object");
  const { schema, labId, state, versions, attachments, localOnly } = raw;
  if (typeof schema !== "string" || schema.trim() === "" || schema.length > 200) {
    throw new LabDocumentError("schema", "must be a non-empty string of at most 200 characters");
  }
  if (typeof labId !== "string" || !LAB_ID_PATTERN.test(labId)) {
    throw new LabDocumentError("labId", "must be a registry id (a-z, 0-9 and -, 2–32 characters)");
  }
  if (state === undefined) throw new LabDocumentError("state", "is missing");
  const document: LabSessionDocument = { schema, labId, state: cloneJson(state, "state") };
  if (versions !== undefined && versions !== null) {
    if (!isRecord(versions)) throw new LabDocumentError("versions", "must map names to version strings");
    const copy: Record<string, string> = {};
    for (const [name, version] of Object.entries(versions)) {
      if (typeof version !== "string") throw new LabDocumentError(`versions.${name}`, "is not a string");
      copy[name] = version;
    }
    document.versions = copy;
  }
  if (attachments !== undefined && attachments !== null) {
    if (!isRecord(attachments)) throw new LabDocumentError("attachments", "must map names to Blobs");
    const entries = Object.entries(attachments).filter(([, blob]) => blob !== undefined);
    if (entries.length > MAX_ATTACHMENTS) throw new LabDocumentError("attachments", `has more than ${MAX_ATTACHMENTS} entries`);
    const copy: Record<string, Blob> = {};
    for (const [name, blob] of entries) {
      if (!LAB_ATTACHMENT_NAME.test(name)) {
        throw new LabDocumentError(`attachments.${name}`, "is not a valid name (letters, digits, . _ -, at most 64, starting with a letter or digit)");
      }
      copy[name] = await toHostBlob(blob, `attachments.${name}`, cache);
    }
    document.attachments = copy;
  }
  if (localOnly !== undefined && localOnly !== null) {
    if (!Array.isArray(localOnly)) throw new LabDocumentError("localOnly", "must list attachment names");
    // names without an attachment have nothing to keep on the device
    const names = new Set<string>();
    for (const [index, name] of (localOnly as unknown[]).entries()) {
      if (typeof name !== "string" || !LAB_ATTACHMENT_NAME.test(name)) throw new LabDocumentError(`localOnly[${index}]`, "is not an attachment name");
      if (document.attachments?.[name] !== undefined) names.add(name);
    }
    if (names.size > 0) document.localOnly = [...names].sort();
  }
  return document;
}

const LIBRARY_KINDS: readonly LibraryKind[] = ["shape", "material", "texture", "recording", "scene", "image", "model"];
const LIBRARY_FILE_ROLES: readonly LibraryFileRole[] = [
  "primary", "mesh", "albedo", "normal", "roughness", "metalness", "height", "ao", "emissive", "opacity", "thumbnail",
  "preview", "video", "data", "spec", "material", "other",
];
// library_item_files.filename: no slash, backslash or control characters, 1–180, no leading dot, trimmed
const LIBRARY_FILENAME = /^[^/\\\x00-\x1f\x7f]{1,180}$/;

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new LabDocumentError(path, "is not a string");
  return value;
}

/**
 * Checks a lab's "Add to Library" result and copies it into this realm. Claims (evidence, limitations, rights) are
 * copied character for character: the platform never rewrites what a lab says about its own output.
 */
export async function normalizeLibraryExport(raw: unknown, cache?: WeakMap<object, Blob>): Promise<LabLibraryExport> {
  if (!isRecord(raw)) throw new LabDocumentError("export", "is not an object");
  const kind = raw.kind;
  if (typeof kind !== "string" || !LIBRARY_KINDS.includes(kind as LibraryKind)) {
    throw new LabDocumentError("kind", "is not a library kind");
  }
  const title = requireString(raw.title, "title");
  if (title.trim() === "") throw new LabDocumentError("title", "is empty");
  if (!Array.isArray(raw.files) || raw.files.length === 0) throw new LabDocumentError("files", "must list at least one file");
  const files: LabLibraryFile[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (raw.files as unknown[]).entries()) {
    const path = `files[${index}]`;
    if (!isRecord(entry)) throw new LabDocumentError(path, "is not an object");
    const filename = requireString(entry.filename, `${path}.filename`);
    if (!LIBRARY_FILENAME.test(filename) || filename.startsWith(".") || filename !== filename.trim()) {
      throw new LabDocumentError(`${path}.filename`, "is not a valid file name");
    }
    if (seen.has(filename.toLowerCase())) throw new LabDocumentError(`${path}.filename`, "repeats another file name");
    seen.add(filename.toLowerCase());
    const role = entry.role;
    if (typeof role !== "string" || !LIBRARY_FILE_ROLES.includes(role as LibraryFileRole)) {
      throw new LabDocumentError(`${path}.role`, "is not a library file role");
    }
    files.push({ filename, role: role as LibraryFileRole, blob: await toHostBlob(entry.blob, `${path}.blob`, cache) });
  }
  const claims = raw.claims;
  if (!isRecord(claims)) throw new LabDocumentError("claims", "are missing");
  if (!Array.isArray(claims.limitations)) throw new LabDocumentError("claims.limitations", "is not a list");
  const result: LabLibraryExport = {
    kind: kind as LibraryKind,
    title,
    files,
    claims: {
      evidence: requireString(claims.evidence, "claims.evidence"),
      limitations: (claims.limitations as unknown[]).map((item, index) => requireString(item, `claims.limitations[${index}]`)),
    },
  };
  if (claims.rights !== undefined) result.claims.rights = requireString(claims.rights, "claims.rights");
  if (raw.description !== undefined) result.description = requireString(raw.description, "description");
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) throw new LabDocumentError("tags", "is not a list");
    result.tags = (raw.tags as unknown[]).map((tag, index) => requireString(tag, `tags[${index}]`));
  }
  if (raw.thumbnail !== undefined) {
    result.thumbnail = raw.thumbnail === null ? null : await toHostBlob(raw.thumbnail, "thumbnail", cache);
  }
  if (raw.metadata !== undefined) {
    const metadata = cloneJson(raw.metadata, "metadata");
    if (!isRecord(metadata)) throw new LabDocumentError("metadata", "is not an object");
    result.metadata = metadata as JsonObject;
  }
  return result;
}

/** A restore report copied into this realm; malformed reports count as inexact. */
export function copyRestoreReport(report: unknown): LabRestoreReport {
  if (!isRecord(report)) return { exact: false, warnings: [] };
  const warnings = Array.isArray(report.warnings)
    ? (report.warnings as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  return { exact: report.exact === true, warnings };
}

/** The lab's "ready" postMessage, accepted only from this iframe's window and this origin. */
export function isLabReadyMessage(
  event: { readonly source: unknown; readonly origin: string; readonly data: unknown },
  frameWindow: unknown,
  origin: string,
): boolean {
  if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) return false;
  if (event.origin !== origin) return false;
  const data = event.data;
  if (!isRecord(data)) return false;
  return data.type === LAB_READY_MESSAGE && data.protocol === LAB_SESSION_PROTOCOL;
}

// Connection --------------------------------------------------------------------------------------------------------

/** The iframe element (an HTMLIFrameElement satisfies it). */
export interface LabFrame {
  readonly contentWindow: Window | null;
  readonly contentDocument: Document | null;
  /** Written by reload(). */
  src: string;
  addEventListener(type: "load", listener: () => void): void;
  removeEventListener(type: "load", listener: () => void): void;
}

/** The platform's own window (the parent of the lab iframe). */
export interface HostWindow {
  readonly location: { readonly origin: string };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface HostTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: HostTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export interface LabConnectionOptions {
  /**
   * The lab this connection serves (a project's lab_id). The contract makes the most recently registered adapter the
   * current one; with labId set, an adapter another lab registers on top (a nested dialog) neither replaces this
   * lab's adapter nor hides its changes.
   */
  labId?: string | undefined;
  /** How long to wait for the lab to register after the frame (re)loads; ready() rejects afterwards. */
  timeoutMs?: number | undefined;
  /** Upper bound for restore() (including the wait for the lab to become idle). */
  restoreTimeoutMs?: number | undefined;
  /** The platform window (defaults to the global window). */
  window?: HostWindow | undefined;
  /** Mac uses ⌘, everything else Ctrl (defaults to navigator detection). */
  platform?: ShortcutPlatform | undefined;
  /** Shortcut handlers; only shortcuts with a handler are taken from the lab (and prevented). */
  shortcuts?: Partial<Record<ShortcutAction, () => void>> | undefined;
  /** ⌘S / Ctrl+S (same as shortcuts.save). */
  onSave?: (() => void) | undefined;
  /** ⇧⌘S / Ctrl+Shift+S (same as shortcuts["save-version"]). */
  onSaveNamed?: (() => void) | undefined;
  /** A click that would replace the lab document; without this handler links behave normally. */
  onNavigate?: ((request: LabNavigationRequest) => void) | undefined;
  /** The lab document is being hidden or unloaded: save now. */
  onFlush?: ((reason: FlushReason) => void) | undefined;
  thumbnailBackground?: ThumbnailBackground | undefined;
  timers?: HostTimers | undefined;
}

export interface LabExportInfo {
  id: string;
  label: string;
  kind: LibraryKind;
}

/** A lab's "Add to Library" action as the platform runs it: checked, copied into this realm, rights enforced. */
export interface LabHostExport extends LabExportInfo {
  run(options?: { signal?: AbortSignal | undefined }): Promise<LabLibraryExport>;
}

export interface LabRestoreOptions {
  signal?: AbortSignal | undefined;
  /** Upper bound including the wait for an idle lab (defaults to restoreTimeoutMs). */
  timeoutMs?: number | undefined;
  /** For the lab's restore context: local-only attachments this device does not have (DESIGN.md §15.7). */
  missingLocal?: ReadonlyArray<{ readonly name: string; readonly sha256: string }> | undefined;
}

/** The registered lab, as menus and titles show it. */
export interface LabInfo {
  labId: string;
  title: string;
}

export interface LabConnection {
  /** The registered adapter, or null while the lab loads, after it disposed its session, or after a navigation. */
  adapter(): LabSessionAdapter | null;
  /** The registered lab's id and title (null while none is registered). */
  info(): LabInfo | null;
  /** Resolves once an adapter is registered; rejects when none registers within timeoutMs of a (re)load. */
  ready(): Promise<LabSessionAdapter>;
  /**
   * Loads the frame (again) on the platform's behalf — not a "leave" — and resolves with the adapter the new document
   * registers. Use it before restore() on a lab that was already restored or touched.
   */
  reload(url?: string): Promise<LabSessionAdapter>;
  /**
   * True while the lab is fresh: since its document loaded it received no document, was not started, reported no
   * change and saw no key or pointer input. Otherwise reload() before restore().
   */
  canRestore(): boolean;
  /** The current frame URL (null when unreadable). */
  url(): string | null;
  /** Change notifications of the current adapter. */
  onChange(listener: (kind: LabChangeKind) => void): () => void;
  /** Fires whenever the current adapter changes (null included). */
  onAdapter(listener: (adapter: LabSessionAdapter | null) => void): () => void;
  /** The lab's session ended: it disposed its adapter, or the frame navigated to a new document. */
  onDispose(listener: (labId: string) => void): () => void;
  /** The lab left without the platform asking (an unexpected unload or load); saving into a project must stop. */
  onLeave(listener: (event: LabLeaveEvent) => void): () => void;
  /** The adapter's busy reason, "recording" while a scene recording runs, a platform hold, or "loading". */
  busy(): false | string;
  /** Marks the lab busy for a platform job (recording, capture); returns the release. One GPU job at a time. */
  hold(reason: string): () => void;
  /** serialize() checked and copied into the platform realm. Throws LabBusyError while busy. */
  serialize(): Promise<LabSessionDocument>;
  /**
   * Applies a document to the freshly loaded lab (once per load; waits for it to register and become idle; a document
   * of another lab than the registered or pinned one is refused). missingLocal reaches the lab's restore context.
   */
  restore(document: LabSessionDocument, options?: LabRestoreOptions): Promise<LabRestoreReport>;
  /**
   * The platform will not restore this load (a new project, or the restore failed): a lab opened with
   * ?restore=pending runs its default start-up now. Resolves true when the lab was asked; false when it already
   * started, was restored, or was not opened pending.
   */
  startFresh(options?: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined }): Promise<boolean>;
  /** The adapter's thumbnail, else a generic still of the largest visible canvas; null while busy or blank. */
  thumbnail(width: number, height: number): Promise<Blob | null>;
  /** The canvas to record: the adapter's choice, else the largest visible canvas. */
  recordingCanvas(): HTMLCanvasElement | null;
  exportActions(): LabExportInfo[];
  /** The lab's "Add to Library" actions; run() is runExport() of that action. */
  exports(): LabHostExport[];
  /**
   * Runs a lab export (holding the lab busy) and returns it checked and copied into the platform realm. Exports whose
   * rights mark them research-only are refused with LabRightsError.
   */
  runExport(id: string, options?: { signal?: AbortSignal | undefined }): Promise<LabLibraryExport>;
  dispose(): void;
}

interface Waiter {
  /** Resolve only with an adapter of a document newer than this generation. */
  after: number;
  resolve(adapter: LabSessionAdapter): void;
  reject(error: Error): void;
}

function safely<T extends unknown[]>(callback: ((...args: T) => void) | undefined, ...args: T): void {
  if (!callback) return;
  try {
    callback(...args);
  } catch {
    // a failing platform listener must not break the lab or the other listeners
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function settleOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

class LabHostConnection implements LabConnection {
  private readonly frame: LabFrame;
  private readonly host: HostWindow;
  private readonly options: LabConnectionOptions;
  private readonly timers: HostTimers;
  private readonly platform: ShortcutPlatform;
  private readonly timeoutMs: number;
  private readonly restoreTimeoutMs: number;

  private registry: LabSessionRegistry | null = null;
  private unsubscribeRegistry: (() => void) | null = null;
  // the registry's adapters as seen through its events, oldest first (it exposes only the newest)
  private registered: LabSessionAdapter[] = [];
  private current: LabSessionAdapter | null = null;
  private frameDocument: Document | null = null;
  private detachDocument: (() => void) | null = null;
  private generation = 0;
  // what this document received: nothing yet, a restore (running, done or failed), or startFresh(); a document can
  // only go to a fresh one, and a lab whose restore failed may still be started fresh
  private loadUse: "fresh" | "restoring" | "restored" | "restore-failed" | "started" = "fresh";
  // the lab reported a change or the user touched it since it loaded: it is no longer fresh for restore()
  private touchedSinceLoad = false;
  // documents the platform asked for (the first load, reload()); any other new document means the lab left
  private expectedLoads = 0;
  private leaveReported = false;
  private readonly holds = new Map<symbol, string>();
  private readonly changeListeners = new Set<(kind: LabChangeKind) => void>();
  private readonly adapterListeners = new Set<(adapter: LabSessionAdapter | null) => void>();
  private readonly disposeListeners = new Set<(labId: string) => void>();
  private readonly leaveListeners = new Set<(event: LabLeaveEvent) => void>();
  private waiters: Waiter[] = [];
  private readyTimer: unknown = null;
  private readyError: Error | null = null;
  private disposed = false;
  private readonly blobCache = new WeakMap<object, Blob>();

  constructor(frame: LabFrame, options: LabConnectionOptions) {
    const host = options.window ?? (globalThis as { window?: HostWindow }).window;
    if (!host) throw new Error("connectLab needs the platform window.");
    this.frame = frame;
    this.host = host;
    this.options = options;
    this.timers = options.timers ?? globalTimers;
    this.platform = options.platform ?? detectShortcutPlatform((globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.restoreTimeoutMs = options.restoreTimeoutMs ?? 60_000;
    host.addEventListener("message", this.onMessage);
    frame.addEventListener("load", this.onLoad);
    // a frame still on its initial about:blank document has the lab's own load ahead of it: that load is expected
    const initial = this.readFrameDocument();
    if (initial === null || initial.URL === "about:blank") this.expectedLoads = 1;
    this.restartReadyTimer();
    this.sync(true);
  }

  // discovery

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.disposed) return;
    if (!isLabReadyMessage(event, this.frame.contentWindow, this.host.location.origin)) return;
    this.sync(false);
  };

  private readonly onLoad = (): void => {
    this.sync(false);
  };

  private readFrameDocument(): Document | null {
    try {
      return this.frame.contentDocument;
    } catch {
      return null;
    }
  }

  private readRegistry(): LabSessionRegistry | null {
    try {
      return this.frame.contentWindow?.__visceraLabSessions ?? null;
    } catch {
      // another origin: nothing to talk to
      return null;
    }
  }

  private sync(initial: boolean): void {
    if (this.disposed) return;
    const frameDocument = this.readFrameDocument();
    if (frameDocument !== this.frameDocument) this.switchDocument(frameDocument, initial);
    const registry = this.readRegistry();
    if (registry !== null && registry !== this.registry) this.attachRegistry(registry);
  }

  private switchDocument(frameDocument: Document | null, initial: boolean): void {
    this.detachDocument?.();
    this.detachDocument = null;
    this.generation += 1;
    this.loadUse = "fresh";
    this.touchedSinceLoad = false;
    this.detachRegistry();
    const previous = this.current;
    this.setAdapter(null);
    if (previous) for (const listener of [...this.disposeListeners]) safely(listener, previous.labId);
    if (!initial) {
      if (this.expectedLoads > 0) this.expectedLoads -= 1;
      else if (!this.leaveReported) this.reportLeave("navigated");
    }
    this.leaveReported = false;
    this.frameDocument = frameDocument;
    this.readyError = null;
    this.restartReadyTimer();
    if (frameDocument) this.detachDocument = this.attachDocument(frameDocument);
  }

  private reportLeave(reason: LabLeaveEvent["reason"]): void {
    this.leaveReported = true;
    const event: LabLeaveEvent = { reason, url: this.url() };
    for (const listener of [...this.leaveListeners]) safely(listener, event);
  }

  private attachRegistry(registry: LabSessionRegistry): void {
    this.detachRegistry();
    this.registry = registry;
    if (registry.protocol !== LAB_SESSION_PROTOCOL) {
      this.fail(new LabUnavailableError(`The lab speaks session protocol ${String(registry.protocol)}; the platform speaks ${LAB_SESSION_PROTOCOL}.`));
      return;
    }
    try {
      this.unsubscribeRegistry = registry.subscribe((event) => this.onRegistryEvent(registry, event));
      const current = registry.current();
      if (current) this.registered.push(current);
      this.setAdapter(this.pickAdapter(registry));
    } catch (error) {
      this.fail(new LabUnavailableError(`The lab session registry failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private detachRegistry(): void {
    const unsubscribe = this.unsubscribeRegistry;
    this.unsubscribeRegistry = null;
    this.registry = null;
    this.registered = [];
    try {
      unsubscribe?.();
    } catch {
      // the old document's realm may be gone already
    }
  }

  /** The newest adapter of this connection's lab (or simply the newest one when no lab is pinned). */
  private pickAdapter(registry: LabSessionRegistry): LabSessionAdapter | null {
    const pinned = this.options.labId;
    if (pinned !== undefined) {
      for (let index = this.registered.length - 1; index >= 0; index--) {
        const adapter = this.registered[index];
        if (adapter && adapter.labId === pinned) return adapter;
      }
      return null;
    }
    try {
      return registry.current();
    } catch {
      return null;
    }
  }

  private onRegistryEvent(registry: LabSessionRegistry, event: LabSessionEvent): void {
    if (this.disposed || registry !== this.registry) return;
    if (event.type === "change") {
      this.touchedSinceLoad = true;
      if (this.current && event.labId === this.current.labId) {
        const kind: LabChangeKind = event.kind === "view" ? "view" : "document";
        for (const listener of [...this.changeListeners]) safely(listener, kind);
      }
      return;
    }
    if (event.type === "register") {
      if (!this.registered.includes(event.adapter)) this.registered.push(event.adapter);
    } else {
      // the event names the lab, not the adapter: drop the newest of that lab, as a stack would
      for (let index = this.registered.length - 1; index >= 0; index--) {
        if (this.registered[index]?.labId === event.labId) {
          this.registered.splice(index, 1);
          break;
        }
      }
    }
    const before = this.current;
    const next = this.pickAdapter(registry);
    this.setAdapter(next);
    if (event.type === "dispose" && before && before.labId === event.labId && next !== before) {
      for (const listener of [...this.disposeListeners]) safely(listener, event.labId);
    }
  }

  private setAdapter(adapter: LabSessionAdapter | null): void {
    if (adapter === this.current) return;
    this.current = adapter;
    if (adapter) {
      this.readyError = null;
      this.clearReadyTimer();
      const due = this.waiters.filter((waiter) => waiter.after < this.generation);
      this.waiters = this.waiters.filter((waiter) => waiter.after >= this.generation);
      for (const waiter of due) waiter.resolve(adapter);
    }
    for (const listener of [...this.adapterListeners]) safely(listener, adapter);
  }

  /** Rejects whoever waits for this document's adapter (a reload() waits for the next document instead). */
  private fail(error: Error): void {
    this.readyError = error;
    this.clearReadyTimer();
    const due = this.waiters.filter((waiter) => waiter.after < this.generation);
    this.waiters = this.waiters.filter((waiter) => waiter.after >= this.generation);
    for (const waiter of due) waiter.reject(error);
  }

  private restartReadyTimer(): void {
    this.clearReadyTimer();
    if (this.disposed || this.current) return;
    this.readyTimer = this.timers.setTimeout(() => {
      this.readyTimer = null;
      if (!this.current && !this.disposed) {
        this.fail(new LabTimeoutError(`The lab did not register a session within ${Math.round(this.timeoutMs / 1000)} s.`));
      }
    }, this.timeoutMs);
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) this.timers.clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  // listeners inside the lab document

  private attachDocument(frameDocument: Document): () => void {
    const frameWindow = frameDocument.defaultView;
    const navigation = (frameWindow as unknown as { navigation?: NavigationLike } | null)?.navigation ?? null;
    const keydown = (event: Event): void => {
      this.touchedSinceLoad = true;
      this.handleKey(event as KeyboardEvent);
    };
    const pointerdown = (): void => {
      this.touchedSinceLoad = true;
    };
    const click = (event: Event): void => this.handleClick(event as MouseEvent, frameDocument);
    const navigate = (event: Event): void => this.handleScriptedNavigation(event as unknown as NavigateEventLike, frameDocument);
    // an unloading document also turns hidden (Chrome fires it after pagehide): one flush is enough
    let unloading = false;
    const visibility = (): void => {
      if (frameDocument.visibilityState === "hidden" && !unloading) safely(this.options.onFlush, "hidden");
    };
    const pagehide = (event: Event): void => {
      unloading = true;
      safely(this.options.onFlush, "pagehide");
      // a page kept in the back/forward cache comes back as it was: that is not the lab leaving
      const persisted = (event as { persisted?: boolean }).persisted === true;
      if (!persisted && !this.disposed && this.expectedLoads === 0 && !this.leaveReported) this.reportLeave("unloaded");
    };
    try {
      frameDocument.addEventListener("keydown", keydown, true);
      frameDocument.addEventListener("pointerdown", pointerdown, true);
      frameDocument.addEventListener("click", click, true);
      frameDocument.addEventListener("visibilitychange", visibility);
      frameWindow?.addEventListener("pagehide", pagehide);
      navigation?.addEventListener("navigate", navigate);
    } catch {
      // a document of another origin cannot be instrumented
    }
    return () => {
      try {
        frameDocument.removeEventListener("keydown", keydown, true);
        frameDocument.removeEventListener("pointerdown", pointerdown, true);
        frameDocument.removeEventListener("click", click, true);
        frameDocument.removeEventListener("visibilitychange", visibility);
        frameWindow?.removeEventListener("pagehide", pagehide);
        navigation?.removeEventListener("navigate", navigate);
      } catch {
        // already gone with its document
      }
    };
  }

  private shortcutHandler(action: ShortcutAction): (() => void) | undefined {
    const explicit = this.options.shortcuts?.[action];
    if (explicit) return explicit;
    if (action === "save") return this.options.onSave;
    if (action === "save-version") return this.options.onSaveNamed;
    return undefined;
  }

  private handleKey(event: KeyboardEvent): void {
    if (this.disposed) return;
    const action = classifyShortcut(event, this.platform);
    if (!action) return;
    const handler = this.shortcutHandler(action);
    if (!handler) return;
    // the browser's own ⌘S (save page) and the lab's handlers never see a platform shortcut
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat && isRepeatSensitive(action)) return;
    safely(handler);
  }

  private handleClick(event: MouseEvent, frameDocument: Document): void {
    const onNavigate = this.options.onNavigate;
    if (this.disposed || !onNavigate) return;
    const target = event.target as { closest?: (selectors: string) => Element | null } | null;
    const anchor = typeof target?.closest === "function" ? target.closest("a[href], area[href]") : null;
    if (!anchor) return;
    const raw = anchor.getAttribute("href");
    if (raw === null) return;
    let href: string;
    try {
      href = new URL(raw, frameDocument.baseURI).href;
    } catch {
      return;
    }
    const decision = decideLabNavigation(
      {
        href,
        target: anchor.getAttribute("target") ?? "",
        download: anchor.hasAttribute("download"),
        button: event.button,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
      },
      this.url() ?? frameDocument.URL,
    );
    if (decision.action !== "intercept") return;
    event.preventDefault();
    safely(onNavigate, decision.request);
  }

  /** location.href = …, form submissions and other navigations links do not cover (Navigation API). */
  private handleScriptedNavigation(event: NavigateEventLike, frameDocument: Document): void {
    const onNavigate = this.options.onNavigate;
    // the platform's own loads (reload(), the first load) pass
    if (this.disposed || !onNavigate || this.expectedLoads > 0) return;
    if (!event.cancelable || event.hashChange === true) return;
    if (event.downloadRequest !== null && event.downloadRequest !== undefined) return;
    const destination = event.destination;
    if (!destination || destination.sameDocument) return;
    const decision = decideScriptedNavigation(destination.url, this.url() ?? frameDocument.URL);
    if (decision.action !== "intercept") return;
    event.preventDefault();
    safely(onNavigate, decision.request);
  }

  // public API

  adapter(): LabSessionAdapter | null {
    return this.current;
  }

  info(): LabInfo | null {
    const adapter = this.current;
    if (!adapter) return null;
    try {
      return { labId: String(adapter.labId), title: String(adapter.title) };
    } catch {
      return null;
    }
  }

  ready(): Promise<LabSessionAdapter> {
    if (this.current) return Promise.resolve(this.current);
    if (this.disposed) return Promise.reject(new LabUnavailableError("The lab connection is closed."));
    if (this.readyError) return Promise.reject(this.readyError);
    return new Promise((resolve, reject) => this.waiters.push({ after: this.generation - 1, resolve, reject }));
  }

  reload(url?: string): Promise<LabSessionAdapter> {
    if (this.disposed) return Promise.reject(new LabUnavailableError("The lab connection is closed."));
    const target = url ?? this.url() ?? this.frame.src;
    const after = this.generation;
    const loaded = new Promise<LabSessionAdapter>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new LabTimeoutError(`The lab did not load within ${Math.round(this.timeoutMs / 1000)} s.`));
      }, this.timeoutMs);
      const waiter: Waiter = {
        after,
        resolve: (adapter) => {
          this.timers.clearTimeout(timer);
          resolve(adapter);
        },
        reject: (error) => {
          this.timers.clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
    });
    this.expectedLoads += 1;
    this.frame.src = target;
    return loaded;
  }

  canRestore(): boolean {
    return !this.disposed && this.loadUse === "fresh" && !this.touchedSinceLoad;
  }

  url(): string | null {
    try {
      return this.frame.contentWindow?.location.href ?? null;
    } catch {
      return null;
    }
  }

  onChange(listener: (kind: LabChangeKind) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onAdapter(listener: (adapter: LabSessionAdapter | null) => void): () => void {
    this.adapterListeners.add(listener);
    return () => {
      this.adapterListeners.delete(listener);
    };
  }

  onDispose(listener: (labId: string) => void): () => void {
    this.disposeListeners.add(listener);
    return () => {
      this.disposeListeners.delete(listener);
    };
  }

  onLeave(listener: (event: LabLeaveEvent) => void): () => void {
    this.leaveListeners.add(listener);
    return () => {
      this.leaveListeners.delete(listener);
    };
  }

  busy(): false | string {
    for (const reason of this.holds.values()) return reason;
    const adapter = this.current;
    if (!adapter) return "loading";
    try {
      const reason = adapter.busy();
      if (reason) return String(reason);
    } catch {
      return "unavailable";
    }
    return isRecordingActive(this.frameDocument) ? "recording" : false;
  }

  hold(reason: string): () => void {
    const key = Symbol(reason);
    this.holds.set(key, reason);
    return () => {
      this.holds.delete(key);
    };
  }

  private requireAdapter(): LabSessionAdapter {
    if (this.disposed) throw new LabUnavailableError("The lab connection is closed.");
    if (!this.current) throw new LabUnavailableError("The lab has not registered a session.");
    return this.current;
  }

  private requireGeneration(generation: number): void {
    if (this.disposed || generation !== this.generation) {
      throw new LabUnavailableError("The lab reloaded during the operation.");
    }
  }

  async serialize(): Promise<LabSessionDocument> {
    const adapter = this.requireAdapter();
    const reason = this.busy();
    if (reason) throw new LabBusyError(reason);
    const generation = this.generation;
    const raw: unknown = await adapter.serialize();
    this.requireGeneration(generation);
    const document = await normalizeLabDocument(raw, this.blobCache);
    this.requireGeneration(generation);
    if (document.labId !== adapter.labId) {
      throw new LabDocumentError("labId", `is "${document.labId}" but the registered lab is "${adapter.labId}"`);
    }
    return document;
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        this.timers.clearTimeout(handle);
        reject(abortReason(signal));
      };
      const handle = this.timers.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** This document's adapter, waiting for one to register; rejects when the frame moves on to another document. */
  private adapterOf(generation: number, signal: AbortSignal): Promise<LabSessionAdapter> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.disposed || generation !== this.generation) return Promise.reject(new LabUnavailableError("The lab reloaded before the restore."));
    if (this.current) return Promise.resolve(this.current);
    return new Promise((resolve, reject) => {
      const stop = (): void => {
        off();
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        stop();
        reject(abortReason(signal));
      };
      const off = this.onAdapter((adapter) => {
        if (this.disposed || generation !== this.generation) {
          stop();
          reject(new LabUnavailableError("The lab reloaded before the restore."));
        } else if (adapter) {
          stop();
          resolve(adapter);
        }
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private intoFrameRealm<T>(value: T): T {
    const frameWindow = this.frame.contentWindow;
    try {
      if (frameWindow && typeof frameWindow.structuredClone === "function") return frameWindow.structuredClone(value);
    } catch {
      // not cloneable into that realm: the lab gets the platform's objects
    }
    return value;
  }

  /** The frame was opened with ?restore=pending: its lab waits for restore() or startFresh(). */
  private restorePendingUrl(): boolean {
    const href = this.url();
    if (href === null) return false;
    try {
      return new URL(href).searchParams.get(LAB_RESTORE_PENDING_PARAM) === "pending";
    } catch {
      return false;
    }
  }

  /** An AbortController that follows an outer signal and gives up after timeoutMs (cleanup() stops both). */
  private bounded(outer: AbortSignal | undefined, timeoutMs: number, what: string): { signal: AbortSignal; cleanup(): void } {
    const controller = new AbortController();
    const forward = (): void => controller.abort(outer ? abortReason(outer) : undefined);
    if (outer?.aborted) forward();
    else outer?.addEventListener("abort", forward, { once: true });
    const timer = this.timers.setTimeout(() => {
      controller.abort(new LabTimeoutError(`The lab did not ${what} within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => {
        this.timers.clearTimeout(timer);
        outer?.removeEventListener("abort", forward);
      },
    };
  }

  private frameAbortController(): AbortController {
    try {
      const FrameController = (this.frame.contentWindow as { AbortController?: typeof AbortController } | null)?.AbortController;
      if (typeof FrameController === "function") return new FrameController();
    } catch {
      // fall through
    }
    return new AbortController();
  }

  async restore(document: LabSessionDocument, options: LabRestoreOptions = {}): Promise<LabRestoreReport> {
    if (this.disposed) throw new LabUnavailableError("The lab connection is closed.");
    const pinned = this.options.labId;
    if (pinned !== undefined && document.labId !== pinned) {
      throw new LabDocumentError("labId", `is "${document.labId}" but this connection serves "${pinned}"`);
    }
    // the contract promises restore() only to a lab nobody used since it loaded
    if (this.loadUse === "started") {
      throw new LabUnavailableError("The lab already started fresh; reload it before restoring a document.");
    }
    if (this.loadUse !== "fresh") {
      throw new LabUnavailableError("The lab already received a document; reload it before restoring another.");
    }
    if (this.touchedSinceLoad) {
      throw new LabUnavailableError("The lab was used since it loaded; reload it before restoring a document.");
    }
    if (this.current && document.labId !== this.current.labId) {
      throw new LabDocumentError("labId", `is "${document.labId}" but the registered lab is "${this.current.labId}"`);
    }
    // restore() is promised to a lab that has not been touched since it loaded; a failed attempt leaves it unknown
    this.loadUse = "restoring";
    const generation = this.generation;
    const context: LabRestoreContext = {
      missingLocal: (options.missingLocal ?? []).map((item) => ({ name: String(item.name), sha256: String(item.sha256) })),
    };
    const controller = this.bounded(options.signal, options.timeoutMs ?? this.restoreTimeoutMs, "restore");
    try {
      for (;;) {
        const adapter = await this.adapterOf(generation, controller.signal);
        // aborted while the adapter was being looked up
        if (controller.signal.aborted) throw abortReason(controller.signal);
        if (document.labId !== adapter.labId) {
          throw new LabDocumentError("labId", `is "${document.labId}" but the registered lab is "${adapter.labId}"`);
        }
        while (this.busy() && this.current === adapter) await this.wait(100, controller.signal);
        // it went away while it was busy: wait for the next registration
        if (this.current !== adapter) continue;
        const attempt = this.frameAbortController();
        const cancel = (): void => attempt.abort(abortReason(controller.signal));
        const follow = this.onAdapter((next) => {
          if (next !== adapter) attempt.abort(new LabUnavailableError("The lab disposed its session during the restore."));
        });
        controller.signal.addEventListener("abort", cancel, { once: true });
        // an abort event that fired before this attempt existed is not delivered again
        if (controller.signal.aborted) cancel();
        const release = this.hold("restoring");
        try {
          const pending = Promise.resolve(adapter.restore(this.intoFrameRealm(document), attempt.signal, this.intoFrameRealm(context)));
          const report = await settleOrAbort<unknown>(pending, attempt.signal);
          this.requireGeneration(generation);
          this.loadUse = "restored";
          return copyRestoreReport(report);
        } catch (error) {
          // the lab disposed its session meanwhile (a React StrictMode remount, a remounted view): retry on the next
          // registration of the same document (DESIGN.md §15.6)
          if (!controller.signal.aborted && !this.disposed && generation === this.generation && this.current !== adapter) continue;
          throw error;
        } finally {
          release();
          follow();
          controller.signal.removeEventListener("abort", cancel);
        }
      }
    } catch (error) {
      if (generation === this.generation && this.loadUse === "restoring") this.loadUse = "restore-failed";
      throw error;
    } finally {
      controller.cleanup();
    }
  }

  async startFresh(options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {}): Promise<boolean> {
    if (this.disposed) throw new LabUnavailableError("The lab connection is closed.");
    const startable = (): boolean => this.loadUse === "fresh" || this.loadUse === "restore-failed";
    if (!startable()) return false;
    const generation = this.generation;
    const bounded = this.bounded(options.signal, options.timeoutMs ?? this.timeoutMs, "register a session");
    try {
      const adapter = await this.adapterOf(generation, bounded.signal);
      if (!startable()) return false;
      this.loadUse = "started";
      // a lab opened without ?restore=pending ran its own start-up when it loaded
      if (!this.restorePendingUrl() || typeof adapter.startFresh !== "function") return false;
      adapter.startFresh();
      return true;
    } finally {
      bounded.cleanup();
    }
  }

  async thumbnail(width: number, height: number): Promise<Blob | null> {
    if (this.disposed || this.busy()) return null;
    const release = this.hold("thumbnail");
    const generation = this.generation;
    try {
      const adapter = this.current;
      if (adapter?.thumbnail) {
        const blob: unknown = await adapter.thumbnail(width, height);
        if (generation !== this.generation || blob === null || blob === undefined) return null;
        return await toHostBlob(blob, "thumbnail", this.blobCache);
      }
      const frameDocument = this.frameDocument;
      if (!frameDocument) return null;
      return await genericThumbnail(frameDocument, { width, height, background: this.options.thumbnailBackground });
    } catch {
      // a thumbnail is optional: a failing capture never blocks a save
      return null;
    } finally {
      release();
    }
  }

  recordingCanvas(): HTMLCanvasElement | null {
    try {
      const chosen = this.current?.recordingCanvas?.();
      if (chosen) return chosen;
    } catch {
      // fall back to the largest canvas
    }
    return this.frameDocument ? largestVisibleCanvas(this.frameDocument) : null;
  }

  exportActions(): LabExportInfo[] {
    try {
      return (this.current?.exports?.() ?? []).map((action) => ({ id: String(action.id), label: String(action.label), kind: action.kind }));
    } catch {
      return [];
    }
  }

  exports(): LabHostExport[] {
    return this.exportActions().map((action) => ({ ...action, run: (options) => this.runExport(action.id, options) }));
  }

  async runExport(id: string, options: { signal?: AbortSignal | undefined } = {}): Promise<LabLibraryExport> {
    const adapter = this.requireAdapter();
    const action = (adapter.exports?.() ?? []).find((candidate) => candidate.id === id);
    if (!action) throw new LabUnavailableError(`The lab has no export "${id}".`);
    const reason = this.busy();
    if (reason) throw new LabBusyError(reason);
    const generation = this.generation;
    const release = this.hold("exporting");
    try {
      const raw: unknown = await action.run(options.signal ?? new AbortController().signal);
      this.requireGeneration(generation);
      const result = await normalizeLibraryExport(raw, this.blobCache);
      if (isResearchOnly(result.claims)) {
        throw new LabRightsError(`"${result.title}" is research-only (${result.claims.rights ?? ""}): it cannot be added to the Library.`);
      }
      return result;
    } finally {
      release();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.removeEventListener("message", this.onMessage);
    this.frame.removeEventListener("load", this.onLoad);
    this.detachDocument?.();
    this.detachDocument = null;
    this.detachRegistry();
    this.clearReadyTimer();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(new LabUnavailableError("The lab connection is closed."));
    this.current = null;
    this.frameDocument = null;
    this.holds.clear();
    this.changeListeners.clear();
    this.adapterListeners.clear();
    this.disposeListeners.clear();
    this.leaveListeners.clear();
  }
}

/**
 * Connects to the lab in a same-origin iframe. The connection lives as long as the iframe element: it follows
 * reloads and navigations until dispose(). Safe to create and dispose repeatedly (React StrictMode).
 */
export function connectLab(frame: LabFrame, options: LabConnectionOptions = {}): LabConnection {
  return new LabHostConnection(frame, options);
}

/** What a project session hands its reloadLab (versioning.ts LabReloadRequest satisfies it). */
export interface LabReloadInput {
  document: LabSessionDocument;
  signal: AbortSignal;
  missingLocal?: ReadonlyArray<{ readonly name: string; readonly sha256: string }> | undefined;
}

export interface LabReloaderOptions {
  /** The lab URL to load when the frame is not fresh: registry.ts labUrl(lab, { restorePending: true }). */
  url: string | (() => string);
  /** Upper bound for each restore (defaults to the connection's restoreTimeoutMs). */
  restoreTimeoutMs?: number | undefined;
}

/**
 * The project session's reloadLab on a connection (DESIGN.md §15.6): a lab that is no longer fresh (it was restored,
 * started, changed or touched since it loaded) is reloaded from the pending URL first; the document then goes to
 * restore() with the lab's restore context. When the restore fails, a lab still waiting gets startFresh(), so it is not
 * left blank (the session shows that the lab no longer shows the project).
 */
export function labReloader(
  connection: Pick<LabConnection, "canRestore" | "reload" | "restore" | "startFresh">,
  options: LabReloaderOptions,
): (request: LabReloadInput) => Promise<LabRestoreReport> {
  return async (request) => {
    if (!connection.canRestore()) {
      const url = typeof options.url === "function" ? options.url() : options.url;
      await settleOrAbort(connection.reload(url), request.signal);
    }
    try {
      return await connection.restore(request.document, {
        signal: request.signal,
        timeoutMs: options.restoreTimeoutMs,
        missingLocal: request.missingLocal,
      });
    } catch (error) {
      if (!request.signal.aborted) void connection.startFresh().catch(() => undefined);
      throw error;
    }
  };
}
