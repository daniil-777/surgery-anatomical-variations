// account-delete handler (supabase/functions/account-delete/handler.ts), the shared Storage helpers it relies on, and
// the PostgREST adapter that pages through the account's asset rows. Fakes: a Storage bucket with the v1 listing
// semantics (folders as entries with id null, offset pagination), Auth's getUser/deleteUser and the asset pager.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LogFields } from "../../functions/_shared/log.ts";
import {
  type AuthAdminClient,
  type ServiceError,
  type ServiceResult,
  type StorageBucket,
  type StorageClient,
  type StorageEntry,
  type StorageListOptions,
  UpstreamError,
} from "../../functions/_shared/ports.ts";
import { listObjectPaths, removeObjects } from "../../functions/_shared/storage.ts";
import { supabaseAssetPathPager } from "../../functions/account-delete/assetPaths.ts";
import {
  type AccountDeleteDeps,
  type AssetPathPager,
  createAccountDeleteHandler,
  MAX_SIGN_IN_AGE_SECONDS,
} from "../../functions/account-delete/handler.ts";

const ORIGIN = "https://daniil-777.github.io";
const USER = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const OTHER = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const NOW_SECONDS = NOW / 1000;

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An access token shaped like Supabase's (Auth itself is faked, so the signature is never checked here). */
function accessToken(claims: Record<string, unknown> = {}): string {
  const payload = {
    aud: "authenticated",
    role: "authenticated",
    sub: USER,
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3540,
    amr: [{ method: "password", timestamp: NOW_SECONDS - 120 }],
    session_id: "0b7c1d2e-0000-4000-8000-000000000000",
    ...claims,
  };
  return `${base64url({ alg: "ES256", typ: "JWT", kid: "k1" })}.${base64url(payload)}.c2lnbmF0dXJl`;
}

const TOKEN = accessToken();

function objectPath(owner: string, seed: string): string {
  const sha = createHash("sha256").update(seed).digest("hex");
  return `${owner}/${sha.slice(0, 2)}/${sha}`;
}

function account(count: number, owner = USER): string[] {
  return Array.from({ length: count }, (_, index) => objectPath(owner, `${owner}:${index}`));
}

type RemoveBehaviour = "ok" | "error" | "throw" | "ignore";

class FakeBucket implements StorageBucket {
  readonly objects: Set<string>;
  readonly listCalls: Array<{ path: string; offset: number; limit: number }> = [];
  readonly removeCalls: string[][] = [];
  failList: (path: string) => boolean = () => false;
  removeBehaviour: (batch: string[], call: number) => RemoveBehaviour = () => "ok";
  private inFlight = 0;
  maxInFlight = 0;

  constructor(paths: Iterable<string> = []) {
    this.objects = new Set(paths);
  }

  async list(path: string, options: StorageListOptions): Promise<ServiceResult<StorageEntry[]>> {
    this.listCalls.push({ path, offset: options.offset, limit: options.limit });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.inFlight -= 1;
    if (this.failList(path)) return { data: null, error: { message: "list failed", status: 500 } };
    const prefix = path === "" ? "" : `${path}/`;
    const entries = new Map<string, StorageEntry>();
    for (const name of this.objects) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) entries.set(rest, { name: rest, id: `id:${name}` });
      else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null });
    }
    const sorted = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { data: sorted.slice(options.offset, options.offset + options.limit), error: null };
  }

  async remove(paths: string[]): Promise<ServiceResult<Array<{ name: string }>>> {
    const call = this.removeCalls.push([...paths]);
    const behaviour = this.removeBehaviour(paths, call);
    if (behaviour === "throw") throw new TypeError("fetch failed");
    if (behaviour === "error") return { data: null, error: { message: "remove failed", status: 500 } };
    if (behaviour === "ignore") return { data: [], error: null };
    return { data: paths.filter((path) => this.objects.delete(path)).map((name) => ({ name })), error: null };
  }
}

type UserResult = { data: { user: { id: string } | null }; error: ServiceError | null };

interface ServicesOptions {
  getUser?: (jwt: string) => Promise<UserResult>;
  deleteUser?: (id: string) => Promise<{ error: ServiceError | null }>;
  storageFrom?: (bucket: string) => StorageBucket;
  assetPaths?: AssetPathPager;
}

/** Auth accepts any token that decodes to a payload whose `sub` is a known user, like a valid signature would. */
function fakeGetUser(jwt: string): UserResult {
  const payload = jwt.split(".")[1];
  try {
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as { sub?: unknown };
    if (claims.sub === USER || claims.sub === OTHER) return { data: { user: { id: claims.sub } }, error: null };
  } catch {
    // not a token at all
  }
  return { data: { user: null }, error: { message: "invalid JWT", status: 403, code: "bad_jwt" } };
}

function services(bucket: FakeBucket, assetRows: Record<string, string[]>, options: ServicesOptions = {}) {
  const getUserCalls: string[] = [];
  const deletedUsers: string[] = [];
  const pagerCalls: Array<{ owner: string; after: string | null; limit: number }> = [];
  const client: AuthAdminClient & StorageClient = {
    auth: {
      async getUser(jwt) {
        getUserCalls.push(jwt);
        return options.getUser ? options.getUser(jwt) : fakeGetUser(jwt);
      },
      admin: {
        async deleteUser(id) {
          deletedUsers.push(id);
          return options.deleteUser ? options.deleteUser(id) : { error: null };
        },
      },
    },
    storage: {
      from(name) {
        if (options.storageFrom) return options.storageFrom(name);
        if (name !== "user-content") throw new Error(`unexpected bucket ${name}`);
        return bucket;
      },
    },
  };
  const assetPaths: AssetPathPager =
    options.assetPaths ??
    (async (owner, after, limit) => {
      pagerCalls.push({ owner, after, limit });
      return [...(assetRows[owner] ?? [])]
        .sort()
        .filter((path) => after === null || path > after)
        .slice(0, limit);
    });
  return { client, assetPaths, getUserCalls, deletedUsers, pagerCalls };
}

interface LogEntry {
  level: "info" | "error";
  event: string;
  fields: LogFields | undefined;
}

function handlerFor(svc: ReturnType<typeof services>, deps: Partial<AccountDeleteDeps> = {}) {
  const logs: LogEntry[] = [];
  const handler = createAccountDeleteHandler({
    appOrigins: [ORIGIN],
    client: svc.client,
    assetPaths: svc.assetPaths,
    now: () => NOW,
    logger: {
      info: (event, fields) => logs.push({ level: "info", event, fields }),
      error: (event, fields) => logs.push({ level: "error", event, fields }),
    },
    ...deps,
  });
  return { handler, logs };
}

function deleteRequest(
  body: unknown = { confirm: "DELETE" },
  options: { method?: string; headers?: Record<string, string>; omit?: string[]; token?: string } = {},
): Request {
  const headers = new Headers({
    origin: ORIGIN,
    authorization: `Bearer ${options.token ?? TOKEN}`,
    "content-type": "application/json",
    ...options.headers,
  });
  for (const name of options.omit ?? []) headers.delete(name);
  const method = options.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  return new Request("https://ref.supabase.co/functions/v1/account-delete", {
    method,
    headers,
    body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : null,
  });
}

describe("account-delete: CORS, methods and configuration", () => {
  it("answers a preflight from an allowed origin and refuses other origins", async () => {
    const svc = services(new FakeBucket(), {});
    const { handler } = handlerFor(svc);
    const preflight = await handler(deleteRequest(null, { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    for (const method of ["OPTIONS", "POST"]) {
      const refused = await handler(deleteRequest(undefined, { method, headers: { origin: "https://evil.example.test" } }));
      expect(refused.status).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(svc.getUserCalls).toEqual([]);
  });

  it("rejects other methods with 405", async () => {
    const svc = services(new FakeBucket(), {});
    const { handler } = handlerFor(svc);
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await handler(deleteRequest(undefined, { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    }
    expect(svc.getUserCalls).toEqual([]);
  });

  it("answers 503 when the service client or the asset pager is missing", async () => {
    const svc = services(new FakeBucket(), {});
    for (const deps of [{ client: null }, { assetPaths: null }]) {
      const { handler } = handlerFor(svc, deps);
      const response = await handler(deleteRequest());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "not_configured" });
    }
  });
});

describe("account-delete: authentication and confirmation", () => {
  it("requires a bearer token before reading anything", async () => {
    const svc = services(new FakeBucket(), {});
    const { handler } = handlerFor(svc);
    for (const authorization of [undefined, "Basic dXNlcjpwYXNz", "Bearer", "Bearer two parts"]) {
      const request =
        authorization === undefined
          ? deleteRequest(undefined, { omit: ["authorization"] })
          : deleteRequest(undefined, { headers: { authorization } });
      const response = await handler(request);
      expect(response.status, String(authorization)).toBe(401);
      expect(await response.json()).toEqual({ error: "not_authenticated" });
    }
    expect(svc.getUserCalls).toEqual([]);
  });

  it('requires the JSON body {"confirm": "DELETE"} before asking Auth', async () => {
    const svc = services(new FakeBucket(), {});
    const { handler } = handlerFor(svc);
    expect((await handler(deleteRequest(undefined, { headers: { "content-type": "text/plain" } }))).status).toBe(415);
    const refused = [
      {},
      { confirm: "delete" },
      { confirm: "DELETE " },
      { confirm: true },
      { confirmation: "yes" },
      { confirm: "no", confirmation: "DELETE" },
      ["DELETE"],
      "DELETE",
      "{",
    ];
    for (const body of refused) {
      const response = await handler(deleteRequest(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_input" });
    }
    expect(svc.getUserCalls).toEqual([]);
  });

  it("also accepts the field name the AccountPort uses, {confirmation: \"DELETE\"}", async () => {
    const svc = services(new FakeBucket(account(2)), { [USER]: account(2) });
    const response = await handlerFor(svc).handler(deleteRequest({ confirmation: "DELETE" }));
    expect(response.status).toBe(200);
    expect(svc.deletedUsers).toEqual([USER]);
  });

  it("answers 401 when Auth rejects the token and 502 when Auth itself fails", async () => {
    const bucket = new FakeBucket(account(3));
    const rejected = services(bucket, {});
    const { handler } = handlerFor(rejected);
    const response = await handler(deleteRequest(undefined, { token: "expired.token.value" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not_authenticated" });
    expect(rejected.getUserCalls).toEqual(["expired.token.value"]);

    const outcomes: Array<[ServicesOptions["getUser"], number]> = [
      [async () => ({ data: { user: null }, error: { message: "unauthorized", status: 401 } }), 401],
      [async () => ({ data: { user: null }, error: null }), 401],
      [async () => ({ data: { user: null }, error: { message: "upstream", status: 500 } }), 502],
      [async () => ({ data: { user: null }, error: { message: "network", status: 0 } }), 502],
      [async () => ({ data: { user: null }, error: { message: "unknown" } }), 502],
      [async () => ({ data: { user: { id: "not-a-uuid" } }, error: null }), 502],
      [
        async () => {
          throw new TypeError("fetch failed");
        },
        502,
      ],
    ];
    for (const [getUser, status] of outcomes) {
      const svc = services(bucket, {}, getUser ? { getUser } : {});
      const result = await handlerFor(svc).handler(deleteRequest());
      expect(result.status).toBe(status);
      expect(svc.deletedUsers).toEqual([]);
    }
    expect(bucket.removeCalls).toEqual([]);
    expect(bucket.objects.size).toBe(3);
  });

  it("refuses a token whose subject is not the user Auth reports, or that is not a JWT", async () => {
    const bucket = new FakeBucket(account(3));
    const cases: Array<[string, ServicesOptions["getUser"]]> = [
      // Auth vouches for USER, but the token names someone else
      [accessToken({ sub: OTHER }), async () => ({ data: { user: { id: USER } }, error: null })],
      ["opaque-token-without-claims", async () => ({ data: { user: { id: USER } }, error: null })],
      [accessToken({ sub: 42 }), async () => ({ data: { user: { id: USER } }, error: null })],
    ];
    for (const [token, getUser] of cases) {
      const svc = services(bucket, {}, getUser ? { getUser } : {});
      const response = await handlerFor(svc).handler(deleteRequest(undefined, { token }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "not_authenticated" });
      expect(svc.deletedUsers).toEqual([]);
    }
    expect(bucket.removeCalls).toEqual([]);
  });
});

describe("account-delete: recent sign-in", () => {
  it(`needs a sign-in within the last ${MAX_SIGN_IN_AGE_SECONDS} seconds, by the token's amr time`, async () => {
    const cases: Array<[string, number]> = [
      [accessToken({ amr: [{ method: "password", timestamp: NOW_SECONDS - MAX_SIGN_IN_AGE_SECONDS }] }), 200],
      [accessToken({ amr: [{ method: "oauth", timestamp: NOW_SECONDS - 5 }] }), 200],
      // an old password sign-in, then a fresh one-time code on the same session
      [accessToken({ amr: [{ method: "password", timestamp: NOW_SECONDS - 86_400 }, { method: "otp", timestamp: NOW_SECONDS - 30 }] }), 200],
      [accessToken({ amr: [{ method: "password", timestamp: NOW_SECONDS - MAX_SIGN_IN_AGE_SECONDS - 1 }] }), 401],
      // refreshed a minute ago (new iat), signed in yesterday: not a recent sign-in
      [accessToken({ iat: NOW_SECONDS - 60, amr: [{ method: "password", timestamp: NOW_SECONDS - 86_400 }] }), 401],
      [accessToken({ amr: undefined }), 401],
      [accessToken({ amr: [] }), 401],
      [accessToken({ amr: [{ method: "password", timestamp: "recently" }] }), 401],
    ];
    for (const [token, status] of cases) {
      const bucket = new FakeBucket(account(2));
      const svc = services(bucket, { [USER]: account(2) });
      const response = await handlerFor(svc).handler(deleteRequest(undefined, { token }));
      expect(response.status).toBe(status);
      if (status === 401) {
        expect(await response.json()).toEqual({ error: "reauthentication_needed", max_age_seconds: MAX_SIGN_IN_AGE_SECONDS });
        expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
        expect(svc.deletedUsers).toEqual([]);
        expect(bucket.removeCalls).toEqual([]);
        expect(bucket.objects.size).toBe(2);
      } else {
        expect(svc.deletedUsers).toEqual([USER]);
      }
    }
  });
});

describe("account-delete: deletion", () => {
  it("removes every object of the account in batches of at most 1000, then deletes the user", async () => {
    const stored = account(2345);
    const stray = objectPath(USER, "an object whose asset row is gone");
    const pending = objectPath(USER, "a reservation that was never uploaded");
    const others = account(30, OTHER);
    const bucket = new FakeBucket([...stored, stray, ...others]);
    const svc = services(bucket, { [USER]: [...stored, pending], [OTHER]: others });
    const { handler, logs } = handlerFor(svc);

    const response = await handler(deleteRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ deleted: true, objectsRemoved: stored.length + 1 });
    expect(svc.deletedUsers).toEqual([USER]);
    expect([...bucket.objects].sort()).toEqual([...others].sort());

    expect(bucket.removeCalls.map((batch) => batch.length)).toEqual([1000, 1000, 347]);
    const removed = bucket.removeCalls.flat();
    expect(removed).toContain(stray);
    expect(removed).toContain(pending);
    expect(removed.every((path) => path.startsWith(`${USER}/`))).toBe(true);

    // asset rows in keyset pages until an empty page (2346 rows → 1000, 1000, 346, 0)
    expect(svc.pagerCalls.map((call) => call.limit)).toEqual([1000, 1000, 1000, 1000]);
    expect(svc.pagerCalls[0]?.after).toBeNull();
    expect(svc.pagerCalls.every((call) => call.owner === USER)).toBe(true);
    // the account folder holds over 200 two-hex folders: three pages of 100, then one empty check after removal
    expect(bucket.listCalls.filter((call) => call.path === USER).map((call) => call.offset)).toEqual([0, 100, 200, 0]);
    expect(bucket.listCalls.some((call) => call.path.startsWith(OTHER))).toBe(false);
    expect(logs).toContainEqual({ level: "info", event: "account_deleted", fields: { objectsRemoved: 2346 } });
  });

  it("deletes an account without any files", async () => {
    const svc = services(new FakeBucket(account(5, OTHER)), {});
    const response = await handlerFor(svc).handler(deleteRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, objectsRemoved: 0 });
    expect(svc.deletedUsers).toEqual([USER]);
  });

  it("never removes anything outside the account's folder, even when an asset row points there", async () => {
    const mine = account(4);
    const theirs = account(2, OTHER);
    const bucket = new FakeBucket([...mine, ...theirs]);
    const svc = services(bucket, { [USER]: [...mine, ...theirs, `${USER}x/aa/bb`] });
    const response = await handlerFor(svc).handler(deleteRequest());
    expect(response.status).toBe(200);
    expect([...bucket.objects].sort()).toEqual([...theirs].sort());
    expect(bucket.removeCalls.flat().some((path) => !path.startsWith(`${USER}/`))).toBe(false);
  });

  it("keeps the account when objects remain after removal; repeating the request finishes the job", async () => {
    const stored = account(1500);
    const bucket = new FakeBucket(stored);
    bucket.removeBehaviour = (_batch, call) => (call === 2 ? "error" : "ok");
    const svc = services(bucket, { [USER]: stored });
    const { handler, logs } = handlerFor(svc);

    const first = await handler(deleteRequest());
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: "storage_cleanup_failed", removed: 1000, remaining: 500 });
    expect(svc.deletedUsers).toEqual([]);
    expect(logs).toContainEqual({
      level: "error",
      event: "storage_cleanup_failed",
      fields: { removed: 1000, remaining: 500, failedBatches: 1 },
    });

    bucket.removeBehaviour = () => "ok";
    const retry = await handler(deleteRequest());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ deleted: true, objectsRemoved: 500 });
    expect(svc.deletedUsers).toEqual([USER]);
    expect(bucket.objects.size).toBe(0);
  });

  it("keeps the account when Storage claims success but the objects are still there, or the call throws", async () => {
    for (const behaviour of ["ignore", "throw"] as const) {
      const bucket = new FakeBucket(account(10));
      bucket.removeBehaviour = () => behaviour;
      const svc = services(bucket, { [USER]: account(10) });
      const response = await handlerFor(svc).handler(deleteRequest());
      expect(response.status, behaviour).toBe(500);
      expect(await response.json()).toEqual({ error: "storage_cleanup_failed", removed: 0, remaining: 10 });
      expect(svc.deletedUsers).toEqual([]);
    }
  });

  it("answers 502 and removes nothing when the listing or the asset query fails", async () => {
    const listing = new FakeBucket(account(10));
    listing.failList = (path) => path === USER;
    const failedList = services(listing, { [USER]: account(10) });
    expect((await handlerFor(failedList).handler(deleteRequest())).status).toBe(502);
    expect(listing.removeCalls).toEqual([]);
    expect(failedList.deletedUsers).toEqual([]);

    const pagers: AssetPathPager[] = [
      async () => {
        throw new UpstreamError("assets", "PGRST000");
      },
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => [objectPath(USER, "the same page again")],
    ];
    for (const assetPaths of pagers) {
      const bucket = new FakeBucket(account(10));
      const svc = services(bucket, {}, { assetPaths });
      const response = await handlerFor(svc).handler(deleteRequest());
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "upstream" });
      expect(bucket.removeCalls).toEqual([]);
      expect(svc.deletedUsers).toEqual([]);
    }
  });

  it("keeps the account when the check after removal cannot list the folder", async () => {
    const bucket = new FakeBucket(account(10));
    bucket.failList = () => bucket.removeCalls.length > 0;
    const svc = services(bucket, { [USER]: account(10) });
    const response = await handlerFor(svc).handler(deleteRequest());
    expect(response.status).toBe(502);
    expect(bucket.objects.size).toBe(0);
    expect(svc.deletedUsers).toEqual([]);
  });

  it("answers 502 when Auth cannot delete the user (files are already gone; a retry completes)", async () => {
    let failures = 1;
    const bucket = new FakeBucket(account(10));
    const svc = services(bucket, { [USER]: account(10) }, {
      deleteUser: async () => (failures-- > 0 ? { error: { message: "Database error deleting user", status: 500 } } : { error: null }),
    });
    const { handler } = handlerFor(svc);
    expect((await handler(deleteRequest())).status).toBe(502);
    expect(bucket.objects.size).toBe(0);
    const retry = await handler(deleteRequest());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ deleted: true, objectsRemoved: 0 });
    expect(svc.deletedUsers).toEqual([USER, USER]);

    const thrown = services(new FakeBucket(), {}, {
      deleteUser: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect((await handlerFor(thrown).handler(deleteRequest())).status).toBe(502);
  });

  it("treats a user that is already gone (404) as deleted", async () => {
    const svc = services(new FakeBucket(), {}, {
      deleteUser: async () => ({ error: { message: "User not found", status: 404, code: "user_not_found" } }),
    });
    const response = await handlerFor(svc).handler(deleteRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, objectsRemoved: 0 });
  });

  it("answers 500 for an unexpected error", async () => {
    const svc = services(new FakeBucket(), {}, {
      storageFrom: () => {
        throw new RangeError("unexpected");
      },
    });
    const { handler, logs } = handlerFor(svc);
    const response = await handler(deleteRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(logs).toContainEqual({ level: "error", event: "internal_error", fields: { name: "RangeError" } });
    expect(svc.deletedUsers).toEqual([]);
  });

  it("never logs the token or the user's id", async () => {
    const bucket = new FakeBucket(account(3));
    bucket.removeBehaviour = (_batch, call) => (call === 1 ? "error" : "ok");
    const svc = services(bucket, { [USER]: account(3) });
    const { handler, logs } = handlerFor(svc);
    await handler(deleteRequest());
    await handler(deleteRequest());
    const serialized = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(1);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(USER);
  });
});

describe("_shared/storage", () => {
  it("lists every object below a folder, following pages and folders", async () => {
    const crowded = Array.from({ length: 250 }, (_, index) => `${USER}/ab/${String(index).padStart(64, "0")}`);
    const elsewhere = [`${USER}/cd/${"f".repeat(64)}`, `${USER}/top-level-file`, `${OTHER}/ab/${"e".repeat(64)}`];
    const bucket = new FakeBucket([...crowded, ...elsewhere]);
    const paths = await listObjectPaths(bucket, `/${USER}/`);
    expect(paths).toEqual([...crowded, ...elsewhere.slice(0, 2)].sort());
    expect(bucket.listCalls.filter((call) => call.path === `${USER}/ab`).map((call) => call.offset)).toEqual([0, 100, 200]);
    expect(bucket.listCalls.every((call) => call.limit === 100)).toBe(true);
  });

  it("lists folders in parallel, up to the concurrency limit", async () => {
    const paths = Array.from({ length: 40 }, (_, index) => objectPath(USER, `folder-${index}`));
    const bucket = new FakeBucket(paths);
    expect(await listObjectPaths(bucket, USER, { concurrency: 4 })).toEqual([...paths].sort());
    expect(bucket.maxInFlight).toBe(4);
  });

  it("refuses unexpectedly deep folders and reports failed listings as UpstreamError", async () => {
    const deep = new FakeBucket([`${USER}/a/b/c/d/e`]);
    await expect(listObjectPaths(deep, USER)).rejects.toMatchObject({ name: "UpstreamError", step: "storage.list" });

    const failing = new FakeBucket(account(3));
    failing.failList = () => true;
    await expect(listObjectPaths(failing, USER)).rejects.toMatchObject({ step: "storage.list", status: 500 });

    const throwing: StorageBucket = {
      list: async () => {
        throw new TypeError("fetch failed");
      },
      remove: async () => ({ data: [], error: null }),
    };
    await expect(listObjectPaths(throwing, USER)).rejects.toMatchObject({ step: "storage.list", message: "TypeError" });
  });

  it("removes in batches of at most 1000 and reports failed batches without stopping", async () => {
    const paths = account(2500);
    const bucket = new FakeBucket(paths.slice(0, 2400));
    bucket.removeBehaviour = (_batch, call) => (call === 2 ? "error" : "ok");
    const report = await removeObjects(bucket, paths);
    expect(bucket.removeCalls.map((batch) => batch.length)).toEqual([1000, 1000, 500]);
    expect(report.removed).toBe(1400);
    expect(report.failedBatches).toBe(1);
    expect(report.failed).toEqual(paths.slice(1000, 2000));
  });

  it("clamps the batch size to 1…1000 and counts thrown calls as failures", async () => {
    const paths = account(3);
    const large = new FakeBucket(paths);
    await removeObjects(large, paths, 5000);
    await removeObjects(new FakeBucket(paths), paths, Number.NaN);
    expect(large.removeCalls.map((batch) => batch.length)).toEqual([3]);

    const tiny = new FakeBucket(paths);
    await removeObjects(tiny, paths, 0);
    expect(tiny.removeCalls.map((batch) => batch.length)).toEqual([1, 1, 1]);

    const throwing = new FakeBucket(paths);
    throwing.removeBehaviour = () => "throw";
    expect(await removeObjects(throwing, paths)).toEqual({ removed: 0, failed: paths, failedBatches: 1 });
    expect(await removeObjects(throwing, [])).toEqual({ removed: 0, failed: [], failedBatches: 0 });
  });
});

describe("supabaseAssetPathPager", () => {
  interface FakeQuery extends PromiseLike<unknown> {
    select(...args: unknown[]): FakeQuery;
    eq(...args: unknown[]): FakeQuery;
    order(...args: unknown[]): FakeQuery;
    limit(...args: unknown[]): FakeQuery;
    gt(...args: unknown[]): FakeQuery;
  }

  function fakeClient(result: { data: unknown; error: { message: string } | null }) {
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]): FakeQuery => {
        calls.push([name, ...args]);
        return query;
      };
    const query: FakeQuery = {
      select: record("select"),
      eq: record("eq"),
      order: record("order"),
      limit: record("limit"),
      gt: record("gt"),
      then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    const client = {
      from(table: string): FakeQuery {
        calls.push(["from", table]);
        return query;
      },
    };
    // a structural stand-in for the few query-builder methods the adapter calls
    return { client: client as unknown as Parameters<typeof supabaseAssetPathPager>[0], calls };
  }

  it("reads one keyset page of the owner's asset paths", async () => {
    const rows = [{ object_path: `${USER}/00/a` }, { object_path: `${USER}/01/b` }];
    const first = fakeClient({ data: rows, error: null });
    expect(await supabaseAssetPathPager(first.client)(USER, null, 1000)).toEqual([`${USER}/00/a`, `${USER}/01/b`]);
    expect(first.calls).toEqual([
      ["from", "assets"],
      ["select", "object_path"],
      ["eq", "owner_id", USER],
      ["order", "object_path", { ascending: true }],
      ["limit", 1000],
    ]);

    const next = fakeClient({ data: [], error: null });
    expect(await supabaseAssetPathPager(next.client)(USER, `${USER}/01/b`, 500)).toEqual([]);
    expect(next.calls.at(-1)).toEqual(["gt", "object_path", `${USER}/01/b`]);
  });

  it("turns errors and unexpected rows into UpstreamError", async () => {
    const failing = fakeClient({ data: null, error: { message: "permission denied for table assets" } });
    await expect(supabaseAssetPathPager(failing.client)(USER, null, 10)).rejects.toMatchObject({ step: "assets" });
    const odd = fakeClient({ data: [{ object_path: 7 }], error: null });
    await expect(supabaseAssetPathPager(odd.client)(USER, null, 10)).rejects.toBeInstanceOf(UpstreamError);
    const empty = fakeClient({ data: null, error: null });
    expect(await supabaseAssetPathPager(empty.client)(USER, null, 10)).toEqual([]);
  });
});
