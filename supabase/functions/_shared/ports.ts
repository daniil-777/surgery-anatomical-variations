// Structural views of the service-role supabase-js client used by the handlers. Handlers depend on these narrow
// shapes instead of supabase-js, so they run under Node with fakes (supabase/tests/functions); the entry points pass
// the real client, and `tsc -p supabase/functions` checks that it satisfies them.
import { errorName } from "./log.ts";

export interface ServiceError {
  message: string;
  /** HTTP status when the SDK knows it (Auth, Storage). */
  status?: number | undefined;
  /** SQLSTATE/PGRST code (PostgREST) or error code (Auth). */
  code?: string | undefined;
}

export interface ServiceResult<T> {
  data: T | null;
  error: ServiceError | null;
}

export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<ServiceResult<unknown>>;
}

export interface StorageEntry {
  /** Name relative to the listed folder. */
  name: string;
  /** null for a folder (a common prefix) in a listing. */
  id: string | null;
}

export interface StorageListOptions {
  limit: number;
  offset: number;
  sortBy: { column: string; order: string };
}

export interface StorageBucket {
  list(path: string, options: StorageListOptions): Promise<ServiceResult<StorageEntry[]>>;
  /** At most 1000 paths per call; answers the objects it deleted. */
  remove(paths: string[]): Promise<ServiceResult<Array<{ name: string }>>>;
}

export interface StorageClient {
  storage: { from(bucket: string): StorageBucket };
}

export interface AuthAdminClient {
  auth: {
    getUser(jwt: string): Promise<{ data: { user: { id: string } | null }; error: ServiceError | null }>;
    admin: { deleteUser(id: string): Promise<{ error: ServiceError | null }> };
  };
}

/** A dependency (database, Auth, Storage) failed or answered something unexpected; handlers answer 502. */
export class UpstreamError extends Error {
  readonly step: string;
  readonly status: number | null;

  constructor(step: string, message: string, status: number | null = null) {
    super(message);
    this.name = "UpstreamError";
    this.step = step;
    this.status = status;
  }
}

/** Calls a database function and returns its data; an error result or a thrown failure becomes an UpstreamError. */
export async function callRpc(client: RpcClient, fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
  let result: ServiceResult<unknown>;
  try {
    result = await client.rpc(fn, args);
  } catch (error) {
    throw new UpstreamError(fn, errorName(error));
  }
  if (result.error) throw new UpstreamError(fn, result.error.message, result.error.status ?? null);
  return result.data;
}
