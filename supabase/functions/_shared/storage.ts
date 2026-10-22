// Storage helpers for the service role. Storage blocks SQL deletes on storage.objects, so every removal goes through
// the Storage API (at most 1000 paths per call); listings follow pagination and folders until nothing is left.
import { errorName } from "./log.ts";
import { type StorageBucket, type StorageEntry, UpstreamError } from "./ports.ts";

export const USER_CONTENT_BUCKET = "user-content";
export const MAX_REMOVE_BATCH = 1000;

/** storage-js' default page size; a short page therefore always means the folder is exhausted. */
const LIST_PAGE_SIZE = 100;
/** user-content/<uid>/<sha[0:2]>/<sha>: two folder levels below the listed account folder; deeper is unexpected. */
const MAX_LIST_DEPTH = 4;
const MAX_PAGES_PER_FOLDER = 10_000;
const DEFAULT_LIST_CONCURRENCY = 6;

export interface ListOptions {
  pageSize?: number;
  /** Folders listed in parallel (a full account has up to 256 two-hex folders). */
  concurrency?: number;
  maxDepth?: number;
}

/** Every object path below `folder` (e.g. "<uid>"), sorted. Throws UpstreamError when a listing call fails. */
export async function listObjectPaths(bucket: StorageBucket, folder: string, options: ListOptions = {}): Promise<string[]> {
  const pageSize = options.pageSize ?? LIST_PAGE_SIZE;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_LIST_CONCURRENCY);
  const maxDepth = options.maxDepth ?? MAX_LIST_DEPTH;
  const files: string[] = [];
  let level: Array<{ path: string; depth: number }> = [{ path: folder.replace(/^\/+|\/+$/g, ""), depth: 1 }];
  while (level.length > 0) {
    const next: Array<{ path: string; depth: number }> = [];
    await forEachConcurrently(level, concurrency, async ({ path, depth }) => {
      for (const entry of await listFolder(bucket, path, pageSize)) {
        const child = path === "" ? entry.name : `${path}/${entry.name}`;
        if (entry.id !== null) {
          files.push(child);
        } else if (depth >= maxDepth) {
          throw new UpstreamError("storage.list", `folders nested deeper than ${maxDepth} levels`);
        } else {
          next.push({ path: child, depth: depth + 1 });
        }
      }
    });
    level = next;
  }
  return files.sort();
}

async function listFolder(bucket: StorageBucket, path: string, pageSize: number): Promise<StorageEntry[]> {
  const entries: StorageEntry[] = [];
  for (let page = 0; page < MAX_PAGES_PER_FOLDER; page += 1) {
    let result;
    try {
      result = await bucket.list(path, { limit: pageSize, offset: page * pageSize, sortBy: { column: "name", order: "asc" } });
    } catch (error) {
      throw new UpstreamError("storage.list", errorName(error));
    }
    if (result.error) throw new UpstreamError("storage.list", result.error.message, result.error.status ?? null);
    const rows = result.data ?? [];
    entries.push(...rows);
    if (rows.length < pageSize) return entries;
  }
  throw new UpstreamError("storage.list", "listing did not end");
}

async function forEachConcurrently<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      try {
        await run(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface RemovalReport {
  /** Objects Storage reports as deleted (a path without an object is not counted). */
  removed: number;
  /** Paths of batches that failed; they may still exist. */
  failed: string[];
  failedBatches: number;
}

/** Removes `paths` in batches of at most 1000. Never throws: failed batches are reported and the rest continue. */
export async function removeObjects(
  bucket: StorageBucket,
  paths: readonly string[],
  batchSize: number = MAX_REMOVE_BATCH,
): Promise<RemovalReport> {
  const size = Number.isFinite(batchSize) ? Math.max(1, Math.min(MAX_REMOVE_BATCH, Math.floor(batchSize))) : MAX_REMOVE_BATCH;
  const report: RemovalReport = { removed: 0, failed: [], failedBatches: 0 };
  for (let start = 0; start < paths.length; start += size) {
    const batch = paths.slice(start, start + size);
    try {
      const { data, error } = await bucket.remove(batch);
      if (!error) {
        report.removed += data?.length ?? 0;
        continue;
      }
    } catch {
      // a thrown failure counts like an error result
    }
    report.failedBatches += 1;
    report.failed.push(...batch);
  }
  return report;
}
