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

export interface TestDb {
  readonly db: PGlite;
  /** Runs one statement in its own transaction as the given API role (RLS and grants apply). */
  as<T extends Row = Row>(actor: Actor, sql: string, params?: unknown[]): Promise<T[]>;
  /** Inserts an auth user (the profile trigger runs) and returns its id. */
  createUser(options?: { email?: string; metadata?: Record<string, unknown> }): Promise<string>;
  /** Full upload protocol for `owner`: reserve, storage row, confirm. Returns the ready asset id. */
  upload(owner: string, content: string | Uint8Array, mime?: string): Promise<string>;
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

let userCounter = 0;

export async function createTestDb(): Promise<TestDb> {
  const db = await PGlite.create();
  await db.exec(readFileSync(join(SUPABASE_DIR, "tests", "support", "shim.sql"), "utf8"));
  for (const name of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    } catch (error) {
      throw new Error(`migration ${name} failed: ${(error as Error).message}`);
    }
  }

  async function as<T extends Row = Row>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
    await db.exec("begin");
    try {
      if (actor.kind === "user") {
        await db.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: actor.id, role: "authenticated" }),
        ]);
        await db.exec("set local role authenticated");
      } else if (actor.kind === "service") {
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
        await db.exec("set local role service_role");
      } else {
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
        await db.exec("set local role anon");
      }
      const result = await db.query<T>(sql, params);
      await db.exec("commit");
      return result.rows;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
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

  async function upload(owner: string, content: string | Uint8Array, mime = "application/gzip"): Promise<string> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const [reservation] = await as<{ asset_id: string; object_path: string; status: string }>(
      user(owner),
      "select * from public.reserve_asset($1, $2, $3)",
      [sha256(bytes), bytes.byteLength, mime],
    );
    if (!reservation) throw new Error("reserve_asset returned nothing");
    if (reservation.status === "pending") {
      await as(
        user(owner),
        "insert into storage.objects (bucket_id, name, owner, metadata) values ('user-content', $1, $2, $3)",
        [reservation.object_path, owner, JSON.stringify({ size: bytes.byteLength, mimetype: mime })],
      );
      await as(user(owner), "select * from public.confirm_asset($1)", [reservation.asset_id]);
    }
    return reservation.asset_id;
  }

  return { db, as, admin, createUser, upload, close: () => db.close() };
}

/** Asserts that `promise` fails with the platform error `code` (MESSAGE) and, optionally, HTTP status (PTxxx). */
export async function expectPlatformError(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected the platform error ${code}`).toBeDefined();
  const error = caught as { message?: string; code?: string };
  expect(error.message).toBe(code);
  if (status !== undefined) expect(error.code).toBe(`PT${String(status).padStart(3, "0")}`);
}

/** Asserts a Postgres permission/RLS failure (not a platform error). */
export async function expectDenied(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected a permission or row-level security error").toBeDefined();
  expect((caught as Error).message).toMatch(/permission denied|row-level security/);
}
