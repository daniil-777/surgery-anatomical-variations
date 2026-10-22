// maintenance: hourly housekeeping (DESIGN.md §15.3, §15.4), called by the platform-maintenance cron (GitHub Actions)
// with a shared secret in the x-maintenance-secret header. One run:
//   1. maintenance_run(): version retention, 30-day trash purge, throttle-window cleanup (all in SQL);
//   2. rounds of two-phase asset collection: maintenance_orphan_assets lists collectable assets (unreferenced; ready
//      1 hour after last use, pending 6 hours, rejected at once, rows an interrupted run left 'deleting' first);
//      maintenance_forget_assets re-checks them under each owner's lock and marks them 'deleting' (from then on the
//      same bytes cannot be reserved: asset_busy); their objects are removed through the Storage API (one immediate
//      retry of a failed batch); maintenance_finish_assets drops the rows whose objects are gone. A row whose removal
//      failed stays 'deleting' and is the first thing the next run picks up;
//   3. objects without any asset row (deleted accounts) are removed.
// Storage objects can only be deleted through the Storage API. Time: no request starts once `budgetMs` has passed,
// except removing the objects of rows just marked and finishing those rows (that completes what marking began). With
// the entry point's 10 s cap per request a run ends within about a minute; whatever is left waits for the next run.
import { errorResponse, isRecord, jsonResponse } from "../_shared/http.ts";
import { errorName, type LogFields, type Logger, silentLogger } from "../_shared/log.ts";
import { callRpc, type RpcClient, type StorageClient, UpstreamError } from "../_shared/ports.ts";
import { removeObjects, USER_CONTENT_BUCKET } from "../_shared/storage.ts";
import { secretsMatch } from "../_shared/timingSafeEqual.ts";

/** Shorter secrets are treated as a configuration mistake (generate one with `openssl rand -hex 32`). */
export const MIN_SECRET_LENGTH = 16;
const DEFAULT_BUDGET_MS = 30_000;
const DEFAULT_MAX_ROUNDS = 20;
const DEFAULT_BATCH_LIMIT = 500;

export type StopReason = "drained" | "round_limit" | "time_budget";

export interface MaintenanceSummary {
  /** maintenance_run()'s counts (versions_pruned, projects_purged, …). */
  run: unknown;
  /** Asset rows marked 'deleting' (phase 1). */
  assetsMarked: number;
  /** Asset rows dropped after their objects were removed (phase 2). */
  assetsForgotten: number;
  /** Objects of collected assets that Storage deleted (a reservation that was never uploaded has none). */
  objectsRemoved: number;
  /** Objects without an asset row that Storage deleted. */
  orphanObjectsRemoved: number;
  rounds: number;
  durationMs: number;
  stoppedBy: StopReason;
  /** Objects whose removal failed, also on the retry (their asset rows stay 'deleting' for the next run). */
  failedRemovals: number;
}

export interface MaintenanceDeps {
  /** MAINTENANCE_SECRET; the function refuses to run without one of at least MIN_SECRET_LENGTH characters. */
  secret: string | null;
  client: (RpcClient & StorageClient) | null;
  logger?: Logger;
  now?: () => number;
  /** No request starts after this much time (see the header comment for the one exception). */
  budgetMs?: number;
  maxRounds?: number;
  /** p_limit of the orphan queries (the SQL caps it at 1000). */
  batchLimit?: number;
}

export function createMaintenanceHandler(deps: MaintenanceDeps): (request: Request) => Promise<Response> {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT;

  async function run(client: RpcClient & StorageClient): Promise<Response> {
    const startedAt = now();
    const deadline = startedAt + budgetMs;
    const bucket = client.storage.from(USER_CONTENT_BUCKET);
    let runResult: unknown = null;
    let assetsMarked = 0;
    let assetsForgotten = 0;
    let objectsRemoved = 0;
    let orphanObjectsRemoved = 0;
    let rounds = 0;
    let stoppedBy: StopReason = "drained";
    // paths whose removal failed, also on the retry; the next run tries them again
    const unresolved = new Set<string>();
    // each candidate is attempted once per run, so a stubborn one cannot keep the loop busy
    const triedAssets = new Set<string>();
    const triedObjects = new Set<string>();

    const summary = (): MaintenanceSummary => ({
      run: runResult,
      assetsMarked,
      assetsForgotten,
      objectsRemoved,
      orphanObjectsRemoved,
      rounds,
      durationMs: now() - startedAt,
      stoppedBy,
      failedRemovals: unresolved.size,
    });

    /** Removes `paths`, retrying failed batches once; answers what was deleted and which paths may still exist. */
    const remove = async (paths: string[]): Promise<{ removed: number; failed: Set<string> }> => {
      const first = await removeObjects(bucket, paths);
      let removed = first.removed;
      let failed = first.failed;
      if (failed.length > 0) {
        const retry = await removeObjects(bucket, failed);
        removed += retry.removed;
        failed = retry.failed;
      }
      for (const path of failed) unresolved.add(path);
      return { removed, failed: new Set(failed) };
    };

    const outOfTime = (): boolean => {
      if (now() < deadline) return false;
      stoppedBy = "time_budget";
      return true;
    };

    try {
      runResult = await callRpc(client, "maintenance_run");
      let assetsDrained = false;
      let objectsDrained = false;
      while (!assetsDrained || !objectsDrained) {
        if (rounds >= maxRounds) {
          stoppedBy = "round_limit";
          break;
        }
        if (outOfTime()) break;
        rounds += 1;

        if (!assetsDrained) {
          const candidates = column(
            await callRpc(client, "maintenance_orphan_assets", { p_limit: batchLimit }),
            "asset_id",
            "maintenance_orphan_assets",
          );
          const fresh = candidates.filter((id) => !triedAssets.has(id));
          for (const id of fresh) triedAssets.add(id);
          assetsDrained = candidates.length < batchLimit || fresh.length === 0;
          if (fresh.length > 0) {
            if (outOfTime()) break;
            const marked = markedAssets(await callRpc(client, "maintenance_forget_assets", { p_asset_ids: fresh }));
            assetsMarked += marked.length;
            // marked rows block their bytes until finished: complete the collection now, whatever the clock says
            if (marked.length > 0) {
              const removal = await remove(marked.map((asset) => asset.objectPath));
              objectsRemoved += removal.removed;
              const gone = marked.filter((asset) => !removal.failed.has(asset.objectPath)).map((asset) => asset.assetId);
              if (gone.length > 0) {
                assetsForgotten += column(
                  await callRpc(client, "maintenance_finish_assets", { p_asset_ids: gone }),
                  "asset_id",
                  "maintenance_finish_assets",
                ).length;
              }
            }
          }
        }

        if (!objectsDrained) {
          if (outOfTime()) break;
          const names = column(
            await callRpc(client, "maintenance_orphan_objects", { p_limit: batchLimit }),
            "object_name",
            "maintenance_orphan_objects",
          );
          const fresh = names.filter((name) => !triedObjects.has(name));
          for (const name of fresh) triedObjects.add(name);
          objectsDrained = names.length < batchLimit || fresh.length === 0;
          if (fresh.length > 0) {
            if (outOfTime()) break;
            orphanObjectsRemoved += (await remove(fresh)).removed;
          }
        }
      }
    } catch (error) {
      const result = summary();
      const step = error instanceof UpstreamError ? error.step : "internal";
      logger.error("maintenance_failed", { step, name: errorName(error), ...counts(result) });
      return error instanceof UpstreamError
        ? errorResponse(502, "upstream", {}, { step, ...result })
        : errorResponse(500, "internal", {}, { step, ...result });
    }

    const result = summary();
    if (unresolved.size > 0) {
      logger.error("maintenance_incomplete", counts(result));
      return errorResponse(502, "upstream", {}, { step: "storage.remove", ...result });
    }
    logger.info("maintenance_completed", counts(result));
    return jsonResponse(200, result);
  }

  return async (request) => {
    if (request.method !== "POST") return errorResponse(405, "method_not_allowed", { allow: "POST" });
    const { secret, client } = deps;
    if (secret === null || secret.length < MIN_SECRET_LENGTH) {
      logger.error("not_configured", { reason: secret === null ? "secret_missing" : "secret_too_short" });
      return errorResponse(503, "not_configured");
    }
    try {
      const presented = request.headers.get("x-maintenance-secret");
      if (presented === null || !(await secretsMatch(presented, secret))) {
        return errorResponse(401, "not_authenticated");
      }
      if (client === null) return errorResponse(503, "not_configured");
      return await run(client);
    } catch (error) {
      logger.error("internal_error", { name: errorName(error) });
      return errorResponse(500, "internal");
    }
  };
}

/** maintenance_forget_assets' rows: the marked assets and their object paths. */
function markedAssets(data: unknown): Array<{ assetId: string; objectPath: string }> {
  if (data === null) return [];
  if (!Array.isArray(data)) throw new UpstreamError("maintenance_forget_assets", "unexpected result");
  return data.map((row: unknown) => {
    const assetId = isRecord(row) ? row.asset_id : undefined;
    const objectPath = isRecord(row) ? row.object_path : undefined;
    if (typeof assetId !== "string" || assetId === "" || typeof objectPath !== "string" || objectPath === "") {
      throw new UpstreamError("maintenance_forget_assets", "unexpected row");
    }
    return { assetId, objectPath };
  });
}

/** One string column of a set-returning function's rows. */
function column(data: unknown, field: string, step: string): string[] {
  if (data === null) return [];
  if (!Array.isArray(data)) throw new UpstreamError(step, "unexpected result");
  return data.map((row: unknown) => {
    const value = isRecord(row) ? row[field] : undefined;
    if (typeof value !== "string" || value === "") throw new UpstreamError(step, "unexpected row");
    return value;
  });
}

function counts(summary: MaintenanceSummary): LogFields {
  return {
    assetsMarked: summary.assetsMarked,
    assetsForgotten: summary.assetsForgotten,
    objectsRemoved: summary.objectsRemoved,
    orphanObjectsRemoved: summary.orphanObjectsRemoved,
    rounds: summary.rounds,
    durationMs: summary.durationMs,
    stoppedBy: summary.stoppedBy,
    failedRemovals: summary.failedRemovals,
  };
}
