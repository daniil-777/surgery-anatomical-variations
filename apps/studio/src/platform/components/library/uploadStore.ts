// The Library's upload queue. It lives outside React, one per backend, so uploads carry on when the person moves to
// another page and are still listed when they come back. Files upload one at a time (kind to quotas and connections);
// each entry reports its phase and progress, a preview as soon as one exists, and ends either as a library item (the
// entry leaves the queue) or as a failure that stays listed until it is retried or dismissed.
import type { LibraryItem, PlatformBackend } from "../../core/types";
import { isSilentError } from "./messages";
import { uploadToLibrary, type ProbeFn, type UploadPhase } from "./upload";
import type { UploadPlan } from "./uploadKind";

export type UploadStatus = "queued" | UploadPhase | "failed";

export interface UploadEntry {
  /** Local id ("upload-3"); never a library item id. */
  id: string;
  name: string;
  size: number;
  plan: UploadPlan;
  status: UploadStatus;
  /** 0…1. */
  progress: number;
  /** An object URL of the file (images) or of its probed thumbnail; revoked when the entry leaves. */
  previewUrl: string | null;
  /** Why it failed (the raw error; pages word it with libraryErrorMessage). */
  error: unknown;
}

export type UploadEvent =
  | { type: "uploaded"; entry: UploadEntry; item: LibraryItem }
  | { type: "failed"; entry: UploadEntry; error: unknown }
  | { type: "cancelled"; entry: UploadEntry };

export interface UploadStoreOptions {
  backend: Pick<PlatformBackend, "assets" | "library">;
  probe: ProbeFn;
  /** Object URLs for previews (injectable for node tests). */
  createUrl?: ((blob: Blob) => string | null) | undefined;
  revokeUrl?: ((url: string) => void) | undefined;
}

type UploadableFile = Blob & { name: string };

let counter = 0;

export class UploadStore {
  private entries: readonly UploadEntry[] = [];
  private readonly files = new Map<string, UploadableFile>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: UploadEvent) => void>();
  private running: string | null = null;
  private readonly createUrl: (blob: Blob) => string | null;
  private readonly revokeUrl: (url: string) => void;

  constructor(private readonly options: UploadStoreOptions) {
    this.createUrl =
      options.createUrl ?? ((blob) => (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null));
    this.revokeUrl = options.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  /** For useSyncExternalStore: a new array whenever anything changed. */
  readonly snapshot = (): readonly UploadEntry[] => this.entries;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Completions, failures and cancellations, for whoever is on screen (toasts, selection). */
  onEvent(listener: (event: UploadEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Queues `file`; returns the entry id. */
  enqueue(file: UploadableFile, plan: UploadPlan): string {
    counter += 1;
    const id = `upload-${counter}`;
    this.files.set(id, file);
    const entry: UploadEntry = {
      id,
      name: file.name,
      size: file.size,
      plan,
      status: "queued",
      progress: 0,
      previewUrl: plan.kind === "image" ? this.createUrl(file) : null,
      error: null,
    };
    this.set([...this.entries, entry]);
    this.pump();
    return id;
  }

  /** Cancels a queued or running upload, or dismisses a failed one. */
  cancel(id: string): void {
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      return;
    }
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    this.remove(id);
    if (entry.status === "queued") this.emit({ type: "cancelled", entry });
  }

  /** Puts a failed upload back in the queue. */
  retry(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.status !== "failed") return;
    this.patch(id, { status: "queued", progress: 0, error: null });
    this.pump();
  }

  /** Cancels everything (sign-out, account switch) and forgets every entry. */
  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    for (const entry of this.entries) if (entry.previewUrl) this.revokeUrl(entry.previewUrl);
    this.files.clear();
    this.set([]);
  }

  get busy(): boolean {
    return this.running !== null || this.entries.some((entry) => entry.status === "queued");
  }

  private emit(event: UploadEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }

  private set(entries: readonly UploadEntry[]): void {
    this.entries = entries;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private patch(id: string, patch: Partial<UploadEntry>): void {
    if (!this.entries.some((entry) => entry.id === id)) return;
    this.set(this.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }

  private remove(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry?.previewUrl) this.revokeUrl(entry.previewUrl);
    this.files.delete(id);
    this.set(this.entries.filter((candidate) => candidate.id !== id));
  }

  private pump(): void {
    if (this.running !== null) return;
    const next = this.entries.find((entry) => entry.status === "queued");
    if (!next) return;
    this.running = next.id;
    void this.run(next.id).finally(() => {
      this.running = null;
      // `busy` changed even when the entries did not
      this.notify();
      this.pump();
    });
  }

  private async run(id: string): Promise<void> {
    const file = this.files.get(id);
    const start = this.entries.find((entry) => entry.id === id);
    if (!file || !start) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.patch(id, { status: "preparing", progress: 0 });
    try {
      const item = await uploadToLibrary(file, start.plan, {
        backend: this.options.backend,
        probe: this.options.probe,
        signal: controller.signal,
        onProgress: (progress, status) => this.patch(id, { progress, status }),
        onPreview: (thumbnail) => {
          const current = this.entries.find((entry) => entry.id === id);
          if (!current || current.previewUrl) return;
          this.patch(id, { previewUrl: this.createUrl(thumbnail) });
        },
      });
      const entry = this.entries.find((candidate) => candidate.id === id) ?? start;
      this.remove(id);
      this.emit({ type: "uploaded", entry, item });
    } catch (error) {
      const entry = this.entries.find((candidate) => candidate.id === id) ?? start;
      if (isSilentError(error)) {
        this.remove(id);
        this.emit({ type: "cancelled", entry });
      } else {
        this.patch(id, { status: "failed", error });
        this.emit({ type: "failed", entry: { ...entry, status: "failed", error }, error });
      }
    } finally {
      this.controllers.delete(id);
    }
  }
}

const stores = new WeakMap<object, UploadStore>();

/** The queue of `backend` (one per backend object, created on first use). */
export function uploadStoreFor(backend: Pick<PlatformBackend, "assets" | "library">, probe: ProbeFn): UploadStore {
  let store = stores.get(backend);
  if (!store) {
    store = new UploadStore({ backend, probe });
    stores.set(backend, store);
  }
  return store;
}
