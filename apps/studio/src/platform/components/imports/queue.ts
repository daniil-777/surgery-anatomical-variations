// The import queue of one backend. Jobs run one at a time (an analysis holds every file and the decoded model in
// memory), keep running while the person browses other pages, ask before the tab closes, and stop on sign-out.
// React reads it through useImportQueue; the store itself is plain TypeScript and unit-tested in node.

import { useSyncExternalStore } from "react";
import { invalidate } from "../../app/query";
import { ACCOUNT_KEY_PREFIX } from "../../app/shell/queries";
import type { ImportedObject, PlatformBackend } from "../../core/types";
import { describeFailure, isCancellation, runImport, type Analyze, type ImportFailure } from "./engine";
import { advanceJob, type JobState } from "./model";

export interface ImportJob {
  readonly id: string;
  /** The main file's name. */
  readonly label: string;
  readonly files: readonly File[];
  /** The name says the file cannot be imported: the importer reads its first bytes to explain why. */
  readonly sniffFirst: boolean;
  readonly state: JobState;
}

export interface EnqueueGroup {
  label: string;
  files: File[];
  sniffFirst?: boolean | undefined;
  /** Refused before reading (over the plan's per-file limit): shown as a failed row straight away. */
  failure?: ImportFailure | undefined;
}

export type QueueEvent =
  | { type: "imported"; jobId: string; object: ImportedObject }
  | { type: "failed"; jobId: string; label: string; failure: ImportFailure }
  /** The queue ran dry after it had work: how many imports finished and failed since it last was idle. */
  | { type: "idle"; imported: ImportedObject[]; failed: number };

export interface ImportQueueOptions {
  analyze?: Analyze | undefined;
  /** Refreshes cached lists after an import (default: the imports lists, and the account's usage for the sidebar). */
  onImported?: ((object: ImportedObject) => void) | undefined;
}

export class ImportQueue {
  private jobs: readonly ImportJob[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: QueueEvent) => void>();
  private readonly controllers = new Map<string, AbortController>();
  private running: string | null = null;
  private limit: number | null = null;
  private counter = 0;
  private sinceIdle: { imported: ImportedObject[]; failed: number } = { imported: [], failed: 0 };
  private unloadGuard: ((event: BeforeUnloadEvent) => void) | null = null;

  constructor(
    private readonly backend: Pick<PlatformBackend, "assets" | "imports">,
    private readonly options: ImportQueueOptions = {},
  ) {}

  readonly getSnapshot = (): readonly ImportJob[] => this.jobs;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onEvent(listener: (event: QueueEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Jobs wait until the plan's per-file limit is known. */
  setLimit(maxBytes: number): void {
    this.limit = maxBytes;
    this.pump();
  }

  /** True while a job runs or waits. */
  get busy(): boolean {
    return this.jobs.some((job) => job.state.status !== "failed" && job.state.status !== "done");
  }

  enqueue(groups: readonly EnqueueGroup[]): string[] {
    const added: ImportJob[] = groups.map((group) => {
      this.counter += 1;
      const state: JobState = group.failure ? { status: "failed", ...group.failure } : { status: "waiting" };
      return { id: `import-${this.counter}`, label: group.label, files: group.files, sniffFirst: group.sniffFirst ?? false, state };
    });
    this.jobs = [...this.jobs, ...added];
    this.changed();
    for (const job of added) {
      if (job.state.status === "failed") this.emit({ type: "failed", jobId: job.id, label: job.label, failure: job.state });
    }
    this.pump();
    return added.map((job) => job.id);
  }

  /**
   * Stops a running job or drops a waiting one; the row goes at once. Uploads already made are abandoned and collected
   * by the server; the next job starts when the cancelled one has unwound.
   */
  cancel(id: string): void {
    this.controllers.get(id)?.abort();
    this.remove(id);
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.jobs = this.jobs.filter((job) => job.state.status === "failed");
    this.changed();
  }

  /** Removes a failed row. */
  dismiss(id: string): void {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job && (job.state.status === "failed" || job.state.status === "done")) this.remove(id);
  }

  retry(id: string): void {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.state.status !== "failed") return;
    this.setState(id, { status: "waiting" }, true);
    this.pump();
  }

  /** Sign-out: everything stops and is forgotten. */
  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.running = null;
    this.jobs = [];
    this.sinceIdle = { imported: [], failed: 0 };
    this.changed();
  }

  private pump(): void {
    if (this.running !== null || this.limit === null) return;
    const next = this.jobs.find((job) => job.state.status === "waiting");
    if (!next) {
      if (this.sinceIdle.imported.length > 0 || this.sinceIdle.failed > 0) {
        const summary = this.sinceIdle;
        this.sinceIdle = { imported: [], failed: 0 };
        this.emit({ type: "idle", imported: summary.imported, failed: summary.failed });
      }
      return;
    }
    const controller = new AbortController();
    this.running = next.id;
    this.controllers.set(next.id, controller);
    const maxBytes = this.limit;
    void runImport([...next.files], {
      backend: this.backend,
      maxBytes,
      signal: controller.signal,
      sniffFirst: next.sniffFirst,
      analyze: this.options.analyze,
      onState: (state) => {
        if (!controller.signal.aborted) this.setState(next.id, state, false);
      },
    }).then(
      (object) => this.finish(next.id, controller, { object }),
      (error: unknown) => this.finish(next.id, controller, { error }),
    );
  }

  private finish(id: string, controller: AbortController, outcome: { object: ImportedObject } | { error: unknown }): void {
    if (this.controllers.get(id) !== controller) return; // cleared (sign-out) while it ran
    this.controllers.delete(id);
    this.running = null;
    if ("object" in outcome) {
      this.sinceIdle.imported.push(outcome.object);
      this.remove(id);
      (this.options.onImported ?? refreshQueries)(outcome.object);
      this.emit({ type: "imported", jobId: id, object: outcome.object });
    } else if (controller.signal.aborted || isCancellation(outcome.error)) {
      this.remove(id);
    } else {
      const failure = describeFailure(outcome.error);
      const job = this.jobs.find((candidate) => candidate.id === id);
      this.setState(id, { status: "failed", ...failure }, true);
      this.sinceIdle.failed += 1;
      this.emit({ type: "failed", jobId: id, label: job?.label ?? "", failure });
    }
    this.pump();
  }

  private setState(id: string, state: JobState, replace: boolean): void {
    let touched = false;
    this.jobs = this.jobs.map((job) => {
      if (job.id !== id) return job;
      touched = true;
      return { ...job, state: replace ? state : advanceJob(job.state, state) };
    });
    if (touched) this.changed();
  }

  private remove(id: string): void {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.id !== id);
    if (this.jobs.length !== before) this.changed();
  }

  private changed(): void {
    this.guardUnload();
    for (const listener of [...this.listeners]) listener();
  }

  private emit(event: QueueEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }

  /** Closing the tab mid-import loses it: the browser asks first (DESIGN.md §15.5 asks the same of unsaved work). */
  private guardUnload(): void {
    if (typeof window === "undefined") return;
    const busy = this.busy;
    if (busy && !this.unloadGuard) {
      this.unloadGuard = (event) => {
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", this.unloadGuard);
    } else if (!busy && this.unloadGuard) {
      window.removeEventListener("beforeunload", this.unloadGuard);
      this.unloadGuard = null;
    }
  }
}

export const IMPORTS_KEY_PREFIX = "imports:";

function refreshQueries(): void {
  invalidate(IMPORTS_KEY_PREFIX);
  invalidate(ACCOUNT_KEY_PREFIX);
}

const queues = new WeakMap<PlatformBackend, ImportQueue>();

/** The queue of a backend (one per signed-in shell); it empties itself on sign-out. */
export function importQueueFor(backend: PlatformBackend): ImportQueue {
  let queue = queues.get(backend);
  if (!queue) {
    const created = new ImportQueue(backend);
    backend.auth.onChange((event) => {
      if (event === "signed_out") created.clear();
    });
    queues.set(backend, created);
    queue = created;
  }
  return queue;
}

export function useImportQueue(backend: PlatformBackend): { queue: ImportQueue; jobs: readonly ImportJob[] } {
  const queue = importQueueFor(backend);
  const jobs = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return { queue, jobs };
}
