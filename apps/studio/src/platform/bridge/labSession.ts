// The lab ⇄ platform contract. Dependency-free on purpose (no React, three.js or supabase-js): any lab can import it
// without pulling platform code into its bundle or typecheck graph.
//
// A lab registers one adapter while it is mounted. When the lab runs inside the account platform (a same-origin
// iframe opened with ?embed=1), the platform shell in the parent document finds the registry on the lab's window,
// subscribes to changes and saves, restores, thumbnails and exports through the adapter. Standalone (?mode=…, the
// public copy, the e2e suites) nobody listens and registering costs nothing.
//
// Guarantees the platform gives a lab:
//   * restore() is only ever called on a freshly loaded lab, before the user interacts (the platform reloads the
//     lab iframe before applying a version), so an adapter never has to cancel half-finished work;
//   * serialize()/thumbnail() are never called while busy() is truthy or while a scene recording is active;
//   * attachments are stored byte-exact, content-addressed by SHA-256, and handed back unchanged.
// What a lab promises the platform:
//   * serialize() returns JSON-safe state; integers above 2^53 (uint64 seeds) are decimal strings;
//   * honesty and limitation strings in exports are copied verbatim from the lab (never upgraded to claims such as
//     "validated", "measured" or "learned" that the lab itself does not make).

import type { JsonValue, LibraryFileRole, LibraryKind } from "../core/types";

export const LAB_SESSION_PROTOCOL = 1;

/** Attachment names: ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ (the database enforces the same rule). */
export const LAB_ATTACHMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface LabSessionDocument<S extends JsonValue = JsonValue> {
  /** Lab-owned, versioned schema id, e.g. "viscera.atlas-session/1". */
  schema: string;
  /** Registry id of the lab, e.g. "organ". */
  labId: string;
  /** JSON-safe state. Integers above 2^53 (uint64 seeds) must be decimal strings. */
  state: S;
  /** Binary parts by name, stored content-addressed and returned byte-exact. */
  attachments?: Record<string, Blob>;
  /** Generator/material/solver revisions in use; a restore warns when they differ. */
  versions?: Record<string, string>;
}

export interface LabRestoreReport {
  /** True when the lab now shows exactly what was saved. */
  exact: boolean;
  /** User-facing sentences ("The simulation restarted from rest."). */
  warnings: string[];
}

export type LabBusyReason = "loading" | "recording" | "running" | "baking" | "importing" | "exporting" | (string & {});

export interface LabLibraryFile {
  filename: string;
  role: LibraryFileRole;
  blob: Blob;
}

export interface LabLibraryExport {
  kind: LibraryKind;
  title: string;
  description?: string;
  tags?: string[];
  files: LabLibraryFile[];
  thumbnail?: Blob | null;
  metadata?: { [key: string]: JsonValue };
  /** Copied verbatim from the lab: what the item is, what it is not, and any rights limits. */
  claims: { evidence: string; limitations: string[]; rights?: string };
}

export interface LabExportAction {
  id: string;
  /** Menu label, e.g. "Add shape to Library". */
  label: string;
  kind: LibraryKind;
  run(signal: AbortSignal): Promise<LabLibraryExport>;
}

export interface LabSessionAdapter<S extends JsonValue = JsonValue> {
  labId: string;
  /** Human-readable lab name, e.g. "Organ Design". */
  title: string;
  serialize(): LabSessionDocument<S> | Promise<LabSessionDocument<S>>;
  /** Applies a saved document to a freshly loaded lab (see the guarantees above). */
  restore(document: LabSessionDocument<S>, signal: AbortSignal): Promise<LabRestoreReport>;
  /** Truthy while saving, restoring or capturing would be unsafe; the platform waits for false. */
  busy(): false | LabBusyReason;
  /** A cover-cropped still of the current view; null when nothing is drawn yet. */
  thumbnail?(width: number, height: number): Promise<Blob | null>;
  /** The canvas to record for "Record" (defaults to the largest visible canvas). */
  recordingCanvas?(): HTMLCanvasElement | null;
  /** Lab-specific "Add to Library" actions. */
  exports?(): LabExportAction[];
  /** A suggested project title for the current state. */
  describe?(): { title?: string; subtitle?: string };
}

export interface LabSessionHandle {
  /** Tell the platform something changed: "document" may create a version; "view" (camera, panels) only autosaves. */
  changed(kind?: "document" | "view"): void;
  dispose(): void;
}

export type LabSessionEvent =
  | { type: "register"; labId: string; adapter: LabSessionAdapter }
  | { type: "change"; labId: string; kind: "document" | "view" }
  | { type: "dispose"; labId: string };

/** The object the platform host reads from the lab iframe's window. */
export interface LabSessionRegistry {
  readonly protocol: number;
  current(): LabSessionAdapter | null;
  subscribe(listener: (event: LabSessionEvent) => void): () => void;
}

declare global {
  interface Window {
    __visceraLabSessions?: LabSessionRegistry;
  }
}

export const LAB_READY_MESSAGE = "viscera:lab-session";

interface RegistryState {
  adapters: LabSessionAdapter[];
  listeners: Set<(event: LabSessionEvent) => void>;
}

const state: RegistryState = { adapters: [], listeners: new Set() };

function emit(event: LabSessionEvent): void {
  for (const listener of [...state.listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error("lab session listener failed", error);
    }
  }
}

function registry(): LabSessionRegistry {
  return {
    protocol: LAB_SESSION_PROTOCOL,
    current: () => state.adapters[state.adapters.length - 1] ?? null,
    subscribe(listener) {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
  };
}

function installRegistry(): void {
  if (typeof window === "undefined" || window.__visceraLabSessions) return;
  window.__visceraLabSessions = registry();
}

function notifyParent(labId: string): void {
  if (typeof window === "undefined" || window.parent === window) return;
  try {
    window.parent.postMessage({ type: LAB_READY_MESSAGE, protocol: LAB_SESSION_PROTOCOL, labId }, window.location.origin);
  } catch {
    // a cross-origin parent cannot receive it; standalone use is unaffected
  }
}

/** Registers the mounted lab's adapter. The most recently registered adapter is the current one. */
export function registerLabSession<S extends JsonValue>(adapter: LabSessionAdapter<S>): LabSessionHandle {
  installRegistry();
  const entry = adapter as unknown as LabSessionAdapter;
  state.adapters.push(entry);
  emit({ type: "register", labId: adapter.labId, adapter: entry });
  notifyParent(adapter.labId);
  let disposed = false;
  return {
    changed(kind = "document") {
      if (!disposed) emit({ type: "change", labId: adapter.labId, kind });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state.adapters = state.adapters.filter((candidate) => candidate !== entry);
      emit({ type: "dispose", labId: adapter.labId });
    },
  };
}

/** For code running in the same document as the lab (tests, standalone tools). The platform host uses the window registry. */
export function onLabSessions(listener: (event: LabSessionEvent) => void): () => void {
  installRegistry();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function currentLabSession(): LabSessionAdapter | null {
  return state.adapters[state.adapters.length - 1] ?? null;
}

/** True when this document is a lab opened by the account platform (?embed=1 inside a same-origin parent). */
export function isEmbeddedInPlatform(): boolean {
  if (typeof window === "undefined" || window.parent === window) return false;
  if (!new URLSearchParams(window.location.search).has("embed")) return false;
  try {
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

installRegistry();
