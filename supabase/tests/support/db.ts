// PGlite (Postgres in WebAssembly) harness for the platform migrations: a Supabase-like database per test file,
// without Docker. shim.sql stands in for the auth/storage schemas and API roles; every migration in
// supabase/migrations is applied in file order, exactly as `supabase db reset` would.
import { PGlite } from "@electric-sql/pglite";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const SUPABASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_DIR = join(SUPABASE_DIR, "migrations");

export type Actor = { kind: "anon" } | { kind: "user"; id: string } | { kind: "service" };
export const anon: Actor = { kind: "anon" };
export const service: Actor = { kind: "service" };
export const user = (id: string): Actor => ({ kind: "user", id });

export type Row = Record<string, unknown>;
export type ApiRole = "anon" | "authenticated" | "service_role";

export interface RunResult<T extends Row = Row> {
  rows: T[];
  /** Rows inserted, updated or deleted by the statement (0 for a plain select). */
  affectedRows: number;
}

export interface Reservation extends Row {
  asset_id: string;
  object_path: string;
  status: "pending" | "ready";
}

/** An asset row as confirm_asset answers it (JSON: timestamps are ISO strings). */
export interface AssetJson extends Row {
  id: string;
  owner_id: string;
  sha256: string;
  byte_size: number;
  mime_type: string;
  object_path: string;
  status: "pending" | "ready" | "rejected" | "deleting";
  created_at: string;
  last_used_at: string;
  ready_at: string | null;
}

/**
 * What PostgREST makes of a function that answers through private.error_response: the transaction commits, the HTTP
 * status comes from response.status and the returned body is its error body. Thrown by TestDb.respond(), with the
 * fields a raised platform error has (message = code, code = PTxxx, detail).
 */
export class ResponseError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly status: number;

  constructor(status: number, body: { code?: unknown; message?: unknown; details?: unknown }) {
    super(typeof body.message === "string" ? body.message : `HTTP ${status}`);
    this.name = "ResponseError";
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : "";
    this.detail = typeof body.details === "string" ? body.details : "";
  }
}

export interface PlanLimits {
  storageQuotaBytes: number;
  maxFileBytes: number;
  versionRetentionDays: number;
  maxProjects: number;
}

export interface TestDbOptions {
  /**
   * false (default): nothing is granted on new public objects implicitly, as on new Supabase projects, so only the
   * migrations' explicit grants count. true: Supabase's legacy default privileges (every new public table and function
   * granted to anon, authenticated and service_role), so the migrations' own revokes are exercised too.
   */
  autoExpose?: boolean;
}

export interface TestDb {
  readonly db: PGlite;
  /** Runs one statement in its own transaction as the given API role (RLS and grants apply). */
  as<T extends Row = Row>(actor: Actor, sql: string, params?: unknown[]): Promise<T[]>;
  /** Like as(), but also reports how many rows an insert/update/delete touched. */
  run<T extends Row = Row>(actor: Actor, sql: string, params?: unknown[]): Promise<RunResult<T>>;
  /**
   * Evaluates one JSON-returning call (`expression`, e.g. "public.confirm_asset($1)") as `actor` the way PostgREST
   * serves it: an answer whose transaction set response.status >= 400 is thrown as a ResponseError (after commit).
   */
  respond<T = unknown>(actor: Actor, expression: string, params?: unknown[]): Promise<T>;
  /** confirm_asset as the owner, through respond(): the ready asset row, or the error PostgREST would answer. */
  confirm(owner: string, assetId: string | null): Promise<AssetJson>;
  /** The Storage API's removal of objects (SQL deletes are blocked, as on Supabase; the API allows its own). */
  removeObjects(objectPaths: string[]): Promise<number>;
  /** Runs one statement as `role` with arbitrary JWT claims (e.g. a token without `sub`). */
  asClaims<T extends Row = Row>(role: ApiRole, claims: Record<string, unknown>, sql: string, params?: unknown[]): Promise<T[]>;
  /** Inserts an auth user (the profile trigger runs) and returns its id. */
  createUser(options?: { email?: string; metadata?: Record<string, unknown> }): Promise<string>;
  /** Full upload protocol for `owner`: reserve, storage row, confirm. Returns the ready asset id. */
  upload(owner: string, content: string | Uint8Array, mime?: string): Promise<string>;
  /** Step 1 of the upload protocol only. */
  reserve(owner: string, content: string | Uint8Array, mime?: string): Promise<Reservation>;
  /** Step 2 only: the Storage API's insert into storage.objects, as `owner` (the bucket policies apply). */
  putObject(owner: string, objectPath: string, byteSize: number, mime?: string): Promise<void>;
  /** Moves `userId` onto a new plan with the given limits (the rest as on the free plan). Returns the plan id. */
  setPlan(userId: string, limits: Partial<PlanLimits>): Promise<string>;
  /** Superuser access for arranging fixtures (bypasses RLS). */
  admin<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

// Supabase's legacy default privileges, applied before the migrations when TestDbOptions.autoExpose is true.
const LEGACY_DEFAULT_PRIVILEGES = `
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

const FREE_PLAN: PlanLimits = {
  storageQuotaBytes: 524288000,
  maxFileBytes: 52428800,
  versionRetentionDays: 30,
  maxProjects: 100,
};

let userCounter = 0;
let planCounter = 0;

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

// A fresh PGlite cluster costs seconds (initdb); loading a dumped data directory costs a fraction of that. Each test
// worker therefore migrates once per privilege model and starts every further database from that dump.
const templates = new Map<boolean, Promise<Blob>>();

async function buildTemplate(autoExpose: boolean): Promise<Blob> {
  const db = await PGlite.create();
  try {
    await db.exec(readFileSync(join(SUPABASE_DIR, "tests", "support", "shim.sql"), "utf8"));
    if (autoExpose) await db.exec(LEGACY_DEFAULT_PRIVILEGES);
    for (const name of migrationFiles()) {
      try {
        await db.exec(readMigration(name));
      } catch (error) {
        throw new Error(`migration ${name} failed: ${(error as Error).message}`);
      }
    }
    return await db.dumpDataDir("none");
  } finally {
    await db.close();
  }
}

export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  const autoExpose = options.autoExpose === true;
  let template = templates.get(autoExpose);
  if (!template) {
    template = buildTemplate(autoExpose);
    templates.set(autoExpose, template);
  }
  const db = await PGlite.create({ loadDataDir: await template });

  async function runWithClaims<T extends Row>(
    role: ApiRole,
    claims: Record<string, unknown>,
    sql: string,
    params: unknown[],
  ): Promise<RunResult<T>> {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      // role is one of three literals (ApiRole), never caller text
      await db.exec(`set local role ${role}`);
      const result = await db.query<T>(sql, params);
      await db.exec("commit");
      return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  }

  function run<T extends Row = Row>(actor: Actor, sql: string, params: unknown[] = []): Promise<RunResult<T>> {
    if (actor.kind === "user") {
      return runWithClaims<T>("authenticated", { sub: actor.id, role: "authenticated" }, sql, params);
    }
    if (actor.kind === "service") return runWithClaims<T>("service_role", { role: "service_role" }, sql, params);
    return runWithClaims<T>("anon", { role: "anon" }, sql, params);
  }

  async function as<T extends Row = Row>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
    return (await run<T>(actor, sql, params)).rows;
  }

  async function asClaims<T extends Row = Row>(
    role: ApiRole,
    claims: Record<string, unknown>,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await runWithClaims<T>(role, claims, sql, params)).rows;
  }

  async function admin<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await db.query<T>(sql, params);
    return result.rows;
  }

  async function createUser(options: { email?: string; metadata?: Record<string, unknown> } = {}): Promise<string> {
    const id = randomUUID();
    userCounter += 1;
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [
      id,
      options.email ?? `user${userCounter}-${id.slice(0, 8)}@example.test`,
      JSON.stringify(options.metadata ?? {}),
    ]);
    return id;
  }

  async function reserve(owner: string, content: string | Uint8Array, mime = "application/gzip"): Promise<Reservation> {
    const bytes = bytesOf(content);
    const [reservation] = await as<Reservation>(user(owner), "select * from public.reserve_asset($1, $2, $3)", [
      sha256(bytes),
      bytes.byteLength,
      mime,
    ]);
    if (!reservation) throw new Error("reserve_asset returned nothing");
    return reservation;
  }

  async function putObject(owner: string, objectPath: string, byteSize: number, mime = "application/gzip"): Promise<void> {
    await as(
      user(owner),
      "insert into storage.objects (bucket_id, name, owner, metadata) values ('user-content', $1, $2, $3)",
      [objectPath, owner, JSON.stringify({ size: byteSize, mimetype: mime })],
    );
  }

  async function respond<T = unknown>(actor: Actor, expression: string, params: unknown[] = []): Promise<T> {
    // materialized: the call runs before response.status is read
    const [row] = await as<{ body: T; status: string | null } & Row>(
      actor,
      `with answer as materialized (select ${expression} as body)
       select body, current_setting('response.status', true) as status from answer`,
      params,
    );
    if (!row) throw new Error(`${expression} answered no row`);
    const status = Number(row.status || "200");
    if (status >= 400) throw new ResponseError(status, (row.body ?? {}) as Record<string, unknown>);
    return row.body;
  }

  function confirm(owner: string, assetId: string | null): Promise<AssetJson> {
    return respond<AssetJson>(user(owner), "public.confirm_asset($1)", [assetId]);
  }

  async function removeObjects(objectPaths: string[]): Promise<number> {
    await db.exec("begin");
    try {
      await db.exec("set local storage.allow_delete_query = 'true'");
      const result = await db.query("delete from storage.objects where bucket_id = 'user-content' and name = any($1::text[])", [
        objectPaths,
      ]);
      await db.exec("commit");
      return result.affectedRows ?? 0;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  }

  async function upload(owner: string, content: string | Uint8Array, mime = "application/gzip"): Promise<string> {
    const bytes = bytesOf(content);
    const reservation = await reserve(owner, bytes, mime);
    if (reservation.status === "pending") {
      await putObject(owner, reservation.object_path, bytes.byteLength, mime);
      await confirm(owner, reservation.asset_id);
    }
    return reservation.asset_id;
  }

  async function setPlan(userId: string, limits: Partial<PlanLimits>): Promise<string> {
    planCounter += 1;
    const plan = { ...FREE_PLAN, ...limits };
    const id = `test_plan_${planCounter}`;
    await db.query(
      `insert into public.plans (id, title, storage_quota_bytes, max_file_bytes, version_retention_days, max_projects)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, `Test plan ${planCounter}`, plan.storageQuotaBytes, plan.maxFileBytes, plan.versionRetentionDays, plan.maxProjects],
    );
    await db.query("update public.profiles set plan_id = $1 where id = $2", [id, userId]);
    return id;
  }

  return {
    db,
    as,
    run,
    respond,
    confirm,
    removeObjects,
    asClaims,
    admin,
    createUser,
    upload,
    reserve,
    putObject,
    setPlan,
    close: () => db.close(),
  };
}

async function caughtError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Asserts that `promise` fails with the platform error `code` (MESSAGE) and, optionally, HTTP status (PTxxx) and a
 * DETAIL matching `detail` (the field or reason the database names).
 */
export async function expectPlatformError(
  promise: Promise<unknown>,
  code: string,
  status?: number,
  detail?: string | RegExp,
): Promise<void> {
  const caught = await caughtError(promise);
  expect(caught, `expected the platform error ${code}`).toBeDefined();
  const error = caught as { message?: string; code?: string; detail?: string };
  expect(error.message).toBe(code);
  if (status !== undefined) expect(error.code).toBe(`PT${String(status).padStart(3, "0")}`);
  if (detail !== undefined) {
    if (typeof detail === "string") expect(error.detail).toBe(detail);
    else expect(error.detail ?? "").toMatch(detail);
  }
}

/** Asserts a Postgres permission/RLS failure (not a platform error). */
export async function expectDenied(promise: Promise<unknown>): Promise<void> {
  const caught = await caughtError(promise);
  expect(caught, "expected a permission or row-level security error").toBeDefined();
  expect((caught as Error).message).toMatch(/permission denied|row-level security/);
}

/** Asserts a failure with the given SQLSTATE (e.g. 23514 check violation, 23505 unique violation). */
export async function expectSqlState(promise: Promise<unknown>, sqlstate: string): Promise<void> {
  const caught = await caughtError(promise);
  expect(caught, `expected SQLSTATE ${sqlstate}`).toBeDefined();
  const error = caught as { code?: string; message?: string };
  expect(`${error.code ?? "?"} ${error.message ?? ""}`).toMatch(new RegExp(`^${sqlstate} `));
}
