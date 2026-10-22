// The Deno entry points (supabase/functions/*/index.ts) under Node: Deno.serve and Deno.env are stubbed, supabase-js is
// replaced through its npm: specifier, and each index module is evaluated afresh per scenario. This covers the wiring
// the handler tests cannot see: which environment variables are read, how the service client is created, and that the
// served handler answers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("npm:@supabase/supabase-js@2.118.0", () => ({ createClient: mocks.createClient }));

type Handler = (request: Request) => Promise<Response>;

const ENTRIES = {
  "auth-username": () => import("../../functions/auth-username/index.ts"),
  "account-delete": () => import("../../functions/account-delete/index.ts"),
  maintenance: () => import("../../functions/maintenance/index.ts"),
};

const SUPABASE_URL = "https://ref.supabase.co";
const ORIGIN = "https://daniil-777.github.io";
const USER = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const MAINTENANCE_SECRET = "4f6c1b0e9a7d3c2b18e5f4a6d9c0b7a3";
const SERVICE_CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: expect.any(Function) },
};

/** Evaluates an entry point with `env` and returns the handler it passed to Deno.serve. */
async function boot(entry: keyof typeof ENTRIES, env: Record<string, string>): Promise<Handler> {
  const served: Handler[] = [];
  vi.stubGlobal("Deno", {
    env: { get: (name: string) => env[name] },
    serve: (handler: Handler) => {
      served.push(handler);
      return {};
    },
  });
  vi.resetModules();
  await ENTRIES[entry]();
  expect(served).toHaveLength(1);
  const [handler] = served;
  if (handler === undefined) throw new Error(`${entry} served nothing`);
  return handler;
}

function rpcClient(answers: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    rpc: async (fn: string) => {
      calls.push(fn);
      return fn in answers ? { data: answers[fn], error: null } : { data: null, error: { message: `unexpected ${fn}` } };
    },
  };
}

function emptyBucket() {
  return {
    list: async () => ({ data: [], error: null }),
    remove: async () => ({ data: [], error: null }),
  };
}

function freshToken(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ sub: USER, iat: now, amr: [{ method: "password", timestamp: now - 10 }] })}.c2ln`;
}

let consoleLines: string[];

beforeEach(() => {
  mocks.createClient.mockReset();
  consoleLines = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    consoleLines.push(String(line));
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    consoleLines.push(String(line));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("auth-username/index.ts", () => {
  it("serves the handler with the injected secret key, a session-less service client and a time-limited fetch", async () => {
    const db = rpcClient({
      login_failures: 0,
      claim_login_attempt: { allowed: true, attempts: 1, retry_after_seconds: 0 },
      note_login_attempt: null,
      resolve_login_email: "owner@example.test",
    });
    mocks.createClient.mockReturnValue(db);
    const authCalls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      authCalls.push({ url, init });
      return new Response(
        JSON.stringify({
          access_token: "a.b.c",
          refresh_token: "r",
          expires_in: 3600,
          expires_at: 1,
          token_type: "bearer",
          user: { id: USER },
        }),
        { status: 200 },
      );
    });
    const handler = await boot("auth-username", {
      SUPABASE_URL: `${SUPABASE_URL}/`,
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_injected" }),
      SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
      APP_ORIGINS: ORIGIN,
    });
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).toHaveBeenCalledWith(SUPABASE_URL, "sb_secret_injected", SERVICE_CLIENT_OPTIONS);

    const response = await handler(
      new Request(`${SUPABASE_URL}/functions/v1/auth-username`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ username: "daniil", password: "secret password" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(db.calls).toEqual(["login_failures", "claim_login_attempt", "resolve_login_email", "note_login_attempt"]);
    expect(authCalls).toHaveLength(1);
    expect(authCalls[0]?.url).toBe(`${SUPABASE_URL}/auth/v1/token?grant_type=password`);
    expect(new Headers(authCalls[0]?.init.headers).get("apikey")).toBe("sb_secret_injected");
    expect(new Headers(authCalls[0]?.init.headers).get("sb-forwarded-for")).toBe("203.0.113.7");
    expect(authCalls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers 503 and creates no client when the project is not configured", async () => {
    const handler = await boot("auth-username", { APP_ORIGINS: ORIGIN });
    expect(mocks.createClient).not.toHaveBeenCalled();
    const response = await handler(
      new Request(`${SUPABASE_URL}/functions/v1/auth-username`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ username: "daniil", password: "secret password" }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });
});

describe("account-delete/index.ts", () => {
  it("wires the pinned secret key into Auth, Storage and the asset pager", async () => {
    const tables: string[] = [];
    const deleted: string[] = [];
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      gt: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    mocks.createClient.mockReturnValue({
      auth: {
        getUser: async () => ({ data: { user: { id: USER } }, error: null }),
        admin: {
          deleteUser: async (id: string) => {
            deleted.push(id);
            return { error: null };
          },
        },
      },
      storage: { from: () => emptyBucket() },
      from: (table: string) => {
        tables.push(table);
        return query;
      },
    });
    const handler = await boot("account-delete", {
      SUPABASE_URL,
      PLATFORM_SECRET_KEY: "sb_secret_pinned",
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_injected" }),
      APP_ORIGINS: ORIGIN,
    });
    expect(mocks.createClient).toHaveBeenCalledWith(SUPABASE_URL, "sb_secret_pinned", SERVICE_CLIENT_OPTIONS);

    const response = await handler(
      new Request(`${SUPABASE_URL}/functions/v1/account-delete`, {
        method: "POST",
        headers: { origin: ORIGIN, authorization: `Bearer ${freshToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, objectsRemoved: 0 });
    expect(tables).toEqual(["assets"]);
    expect(deleted).toEqual([USER]);
    expect(consoleLines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({
      objectsRemoved: 0,
      fn: "account-delete",
      level: "info",
      event: "account_deleted",
    });
  });

  it("answers 503 when the project is not configured", async () => {
    const handler = await boot("account-delete", { APP_ORIGINS: ORIGIN });
    expect(mocks.createClient).not.toHaveBeenCalled();
    const response = await handler(
      new Request(`${SUPABASE_URL}/functions/v1/account-delete`, {
        method: "POST",
        headers: { origin: ORIGIN, authorization: `Bearer ${freshToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      }),
    );
    expect(response.status).toBe(503);
  });
});

describe("maintenance/index.ts", () => {
  it("runs with the legacy service key when no new key exists, and only with MAINTENANCE_SECRET", async () => {
    const db = rpcClient({
      maintenance_run: { versions_pruned: 0 },
      maintenance_orphan_assets: [],
      maintenance_orphan_objects: [],
    });
    mocks.createClient.mockReturnValue({ ...db, storage: { from: () => emptyBucket() } });
    const handler = await boot("maintenance", {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
      MAINTENANCE_SECRET,
    });
    expect(mocks.createClient).toHaveBeenCalledWith(SUPABASE_URL, "legacy-service-role", SERVICE_CLIENT_OPTIONS);

    const call = (secret: string) =>
      handler(new Request(`${SUPABASE_URL}/functions/v1/maintenance`, { method: "POST", headers: { "x-maintenance-secret": secret } }));
    expect((await call("not-the-maintenance-secret")).status).toBe(401);
    expect(db.calls).toEqual([]);

    const response = await call(MAINTENANCE_SECRET);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { versions_pruned: 0 }, rounds: 1, stoppedBy: "drained" });
    expect(db.calls).toEqual(["maintenance_run", "maintenance_orphan_assets", "maintenance_orphan_objects"]);
    expect(consoleLines.some((line) => line.includes('"fn":"maintenance"') && line.includes('"event":"maintenance_completed"'))).toBe(true);
  });

  it("refuses to run without MAINTENANCE_SECRET", async () => {
    mocks.createClient.mockReturnValue({ ...rpcClient({}), storage: { from: () => emptyBucket() } });
    const handler = await boot("maintenance", { SUPABASE_URL, PLATFORM_SECRET_KEY: "sb_secret_pinned" });
    const response = await handler(
      new Request(`${SUPABASE_URL}/functions/v1/maintenance`, { method: "POST", headers: { "x-maintenance-secret": "anything-at-all-here" } }),
    );
    expect(response.status).toBe(503);
  });
});
