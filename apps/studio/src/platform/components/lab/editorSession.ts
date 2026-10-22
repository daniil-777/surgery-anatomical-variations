// Wiring between the editor pages and core/versioning: the snapshot store (content-addressed assets, local-only
// attachments kept on the device), the lab reload used for open/restore, and one lifetime per project at a time in this
// tab — React may mount an editor twice (StrictMode) or remount it at once, and the editing lock must pass cleanly.

import type { LabRestoreReport } from "../../bridge/labSession";
import type { LabConnection } from "../../core/labs/host";
import { labUrl } from "../../core/labs/registry";
import { createSnapshotStore, snapshotStateSha256 } from "../../core/snapshot";
import type { AssetPort } from "../../core/types";
import type { LabReloadRequest, ProjectLock, SnapshotStore } from "../../core/versioning";

/** The state hash the server stores (draft_state_sha256), so no-op detection agrees across devices. */
export const editorFingerprint = snapshotStateSha256;

/** createSnapshotStore with the document's local-only attachments passed through (DESIGN.md §15.7). */
export function editorSnapshots(assets: AssetPort, maxFileBytes: () => number): SnapshotStore {
  const store = createSnapshotStore(assets, { maxFileBytes, appBuild: null });
  return {
    save(document, options) {
      const localOnly = document.localOnly?.filter((name) => typeof name === "string") ?? [];
      return store.save(document, localOnly.length > 0 ? { ...options, localOnly } : options);
    },
    load(snapshot, options) {
      return store.load(snapshot, options);
    },
  };
}

/**
 * Shows a stored document in the lab: a lab that was used (or already received a document) is reloaded with
 * restore=pending first, so restore() only ever reaches a fresh lab (labSession.ts guarantees).
 */
export function labReloader(connection: LabConnection, labId: string): (request: LabReloadRequest) => Promise<LabRestoreReport> {
  return async ({ document, signal }) => {
    if (connection.canRestore()) await connection.ready();
    else await connection.reload(labUrl(labId, { restorePending: true }));
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
    return connection.restore(document, { signal });
  };
}

const turns = new Map<string, Promise<void>>();

export interface ProjectTurn {
  /** Resolves once every earlier editor of this project in this tab has finished closing. */
  ready: Promise<void>;
  /** Hands the project on once `after` settles (the session's last flush). */
  release(after?: Promise<unknown>): void;
}

/** One editor lifetime per project at a time in this tab (StrictMode double mounts, quick back-and-forth). */
export function takeProjectTurn(projectId: string): ProjectTurn {
  const previous = turns.get(projectId) ?? Promise.resolve();
  let finish: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const tail = previous.then(() => mine);
  turns.set(projectId, tail);
  void tail.then(() => {
    if (turns.get(projectId) === tail) turns.delete(projectId);
  });
  let released = false;
  return {
    ready: previous,
    release(after) {
      if (released) return;
      released = true;
      void Promise.resolve(after)
        .catch(() => undefined)
        .finally(finish);
    },
  };
}

/** Web Locks release asynchronously: a lock another editor of this tab just let go may need a moment. */
export async function acquireLockPatiently(lock: ProjectLock, attempts = 5, delayMs = 120): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await lock.acquire()) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}
