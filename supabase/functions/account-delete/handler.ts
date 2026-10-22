// account-delete: permanently deletes the signed-in account. POST {confirm: "DELETE"} with the user's access token
// ({confirmation: "DELETE"}, the AccountPort's parameter name, is accepted too).
//
// Deleting needs a recent sign-in (DESIGN.md §15.9): the session must have been signed into within the last 10
// minutes, judged by the token's `amr` timestamps, which token refreshes keep (unlike `iat`). Older sessions get 401
// reauthentication_needed and the app asks for the password (or provider) again.
//
// Storage objects are outside the database cascade (and Storage blocks SQL deletes), so every object of the account
// is removed through the Storage API first: the paths of the user's asset rows plus a full listing of the user's
// folder. Only when a fresh listing shows the folder empty is the Auth user deleted; the profile, projects, versions,
// library, imports and asset rows then cascade. Any failure leaves the account in place, so the request can simply be
// repeated (removing an object twice is harmless).
import { corsContext, preflightResponse } from "../_shared/cors.ts";
import { bearerToken, errorResponse, isRecord, jsonResponse, readJsonBody } from "../_shared/http.ts";
import { decodeJwtClaims, lastSignInAt } from "../_shared/jwt.ts";
import { errorName, type Logger, silentLogger } from "../_shared/log.ts";
import { type AuthAdminClient, type StorageClient, UpstreamError } from "../_shared/ports.ts";
import { listObjectPaths, MAX_REMOVE_BATCH, removeObjects, USER_CONTENT_BUCKET } from "../_shared/storage.ts";

/** One keyset page of the user's asset object paths (ascending, strictly after `after`). */
export type AssetPathPager = (ownerId: string, after: string | null, limit: number) => Promise<string[]>;

/** How long after signing in an account may be deleted. */
export const MAX_SIGN_IN_AGE_SECONDS = 600;

export interface AccountDeleteDeps {
  /** Exact browser origins allowed by CORS. */
  appOrigins: readonly string[];
  /** Service-role client; null when the function is not configured. */
  client: (AuthAdminClient & StorageClient) | null;
  assetPaths: AssetPathPager | null;
  logger?: Logger;
  now?: () => number;
  /** Paths per Storage remove call (the API takes at most 1000). */
  removeBatchSize?: number;
  /** Rows per asset page (PostgREST may return fewer; paging stops on an empty page). */
  assetPageSize?: number;
  /** Folders listed in parallel. */
  listConcurrency?: number;
}

const MAX_BODY_BYTES = 1024;
const MAX_ASSET_PAGES = 10_000;
const DEFAULT_ASSET_PAGE_SIZE = 1000;
const METHODS = ["POST", "OPTIONS"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAccountDeleteHandler(deps: AccountDeleteDeps): (request: Request) => Promise<Response> {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? Date.now;
  const batchSize = deps.removeBatchSize ?? MAX_REMOVE_BATCH;
  const pageSize = deps.assetPageSize ?? DEFAULT_ASSET_PAGE_SIZE;
  const listOptions = deps.listConcurrency === undefined ? {} : { concurrency: deps.listConcurrency };

  return async (request) => {
    const cors = corsContext(request, deps.appOrigins);
    if (request.method === "OPTIONS") return preflightResponse(cors, METHODS);
    if (!cors.allowed) return errorResponse(403, "origin_not_allowed", cors.headers);
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", { ...cors.headers, allow: METHODS.join(", ") });
    }
    const { client, assetPaths } = deps;
    if (client === null || assetPaths === null) return errorResponse(503, "not_configured", cors.headers);

    try {
      const token = bearerToken(request.headers.get("authorization"));
      if (token === null) return errorResponse(401, "not_authenticated", cors.headers);
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (!body.ok) return errorResponse(body.status, body.error, cors.headers);
      if (!isRecord(body.value) || (body.value.confirm ?? body.value.confirmation) !== "DELETE") {
        return errorResponse(400, "invalid_input", cors.headers);
      }

      const userId = await verifyUser(client, token);
      if (userId === null) return errorResponse(401, "not_authenticated", cors.headers);
      // Auth has just accepted this token, so its claims are Auth's own
      const claims = decodeJwtClaims(token);
      if (claims === null || typeof claims.sub !== "string" || claims.sub.toLowerCase() !== userId) {
        return errorResponse(401, "not_authenticated", cors.headers);
      }
      const signedInAt = lastSignInAt(claims);
      if (signedInAt === null || Math.floor(now() / 1000) - signedInAt > MAX_SIGN_IN_AGE_SECONDS) {
        return errorResponse(401, "reauthentication_needed", cors.headers, { max_age_seconds: MAX_SIGN_IN_AGE_SECONDS });
      }

      const bucket = client.storage.from(USER_CONTENT_BUCKET);
      // objects live at <uid>/<sha[0:2]>/<sha>; nothing outside that folder is ever touched
      const prefix = `${userId}/`;
      const [rowPaths, storedPaths] = await Promise.all([
        collectAssetPaths(assetPaths, userId, pageSize),
        listObjectPaths(bucket, userId, listOptions),
      ]);
      const paths = [...new Set([...rowPaths, ...storedPaths])].filter((path) => path.startsWith(prefix)).sort();
      const removal = await removeObjects(bucket, paths, batchSize);

      const remaining = await listObjectPaths(bucket, userId, listOptions);
      if (remaining.length > 0) {
        logger.error("storage_cleanup_failed", {
          removed: removal.removed,
          remaining: remaining.length,
          failedBatches: removal.failedBatches,
        });
        return errorResponse(500, "storage_cleanup_failed", cors.headers, {
          removed: removal.removed,
          remaining: remaining.length,
        });
      }

      await deleteUser(client, userId);
      logger.info("account_deleted", { objectsRemoved: removal.removed });
      return jsonResponse(200, { deleted: true, objectsRemoved: removal.removed }, cors.headers);
    } catch (error) {
      if (error instanceof UpstreamError) {
        logger.error("upstream_failed", { step: error.step, status: error.status });
        return errorResponse(502, "upstream", cors.headers);
      }
      logger.error("internal_error", { name: errorName(error) });
      return errorResponse(500, "internal", cors.headers);
    }
  };
}

/** The id (lower case) of the user the access token belongs to; null when Auth rejects the token. */
async function verifyUser(client: AuthAdminClient, token: string): Promise<string | null> {
  let result: Awaited<ReturnType<AuthAdminClient["auth"]["getUser"]>>;
  try {
    result = await client.auth.getUser(token);
  } catch (error) {
    throw new UpstreamError("auth.getUser", errorName(error));
  }
  if (result.error) {
    const status = result.error.status;
    // 4xx: invalid, expired or revoked token; anything else (network, 5xx) is Auth's problem, not the caller's
    if (status !== undefined && status >= 400 && status < 500) return null;
    throw new UpstreamError("auth.getUser", result.error.message, status ?? null);
  }
  const id = result.data.user?.id;
  if (id === undefined) return null;
  if (!UUID.test(id)) throw new UpstreamError("auth.getUser", "unexpected user id");
  return id.toLowerCase();
}

async function collectAssetPaths(pager: AssetPathPager, ownerId: string, pageSize: number): Promise<string[]> {
  const paths: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_ASSET_PAGES; page += 1) {
    let rows: string[];
    try {
      rows = await pager(ownerId, after, pageSize);
    } catch (error) {
      throw error instanceof UpstreamError ? error : new UpstreamError("assets", errorName(error));
    }
    const last = rows.at(-1);
    if (last === undefined) return paths;
    if (last === after) throw new UpstreamError("assets", "asset pages did not advance");
    paths.push(...rows);
    after = last;
  }
  throw new UpstreamError("assets", "too many asset pages");
}

async function deleteUser(client: AuthAdminClient, userId: string): Promise<void> {
  let result: Awaited<ReturnType<AuthAdminClient["auth"]["admin"]["deleteUser"]>>;
  try {
    result = await client.auth.admin.deleteUser(userId);
  } catch (error) {
    throw new UpstreamError("auth.admin.deleteUser", errorName(error));
  }
  // 404: a concurrent request has already deleted the account
  if (result.error && result.error.status !== 404) {
    throw new UpstreamError("auth.admin.deleteUser", result.error.message, result.error.status ?? null);
  }
}
