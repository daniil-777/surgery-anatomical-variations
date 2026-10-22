// SupabaseBackend over the real supabase-js 2.118 client, talking to a scripted fake of the Supabase HTTP APIs
// (GoTrue, PostgREST, Storage, Edge Functions). The tests pin the requests the adapter makes — RPC names and p_*
// parameters, filters, patches, headers — and how answers and errors are mapped.
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryBlobCache } from "../blobCache";
import { parsePlatformConfig, type SupabasePlatformConfig } from "../config";
import { conflictDetail } from "../errors";
import { sha256Hex } from "../hash";
import { PlatformError, type AuthEvent, type PlatformErrorCode, type SnapshotRef } from "../types";
import { AUTH_STORAGE_KEY } from "./auth";
import { normalizeTimestamp } from "./mappers";
import { SupabaseBackend, type SupabaseBackendDeps } from "./supabaseBackend";
import { SupabaseTransport } from "./transport";

const BASE = "https://abcdefghijklmnop.supabase.co";
const KEY = "sb_publishable_test_key";
const SITE = "https://daniil-777.github.io/surgery-anatomical-variations/";
const PASSWORD = "correct horse battery";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const SHA = "a".repeat(64);

function config(providers: Record<string, boolean> = {}): SupabasePlatformConfig {
  const parsed = parsePlatformConfig({
    schema: "viscera.platform/v1",
    supabaseUrl: BASE,
    supabaseKey: KEY,
    providers: { password: true, username: true, emailCode: true, google: true, apple: false, github: true, azure: true, ...providers },
    emailDelivery: true,
    siteUrl: SITE,
  });
  if (!parsed.enabled || parsed.backend !== "supabase") throw new Error("test config is invalid");
  return parsed;
}

interface Recorded {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  json: unknown;
  body: unknown;
}

type Handler = (request: Recorded) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function gotrueUser(email: string, providers: string[] = ["email"]) {
  return {
    id: USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: "2026-10-21T10:00:00.123456+00:00",
    confirmed_at: "2026-10-21T10:00:00.123456+00:00",
    last_sign_in_at: "2026-10-21T11:00:00.5+00:00",
    app_metadata: { provider: providers[0], providers },
    user_metadata: {},
    identities: providers.map((provider, index) => ({
      identity_id: `identity-${provider}`,
      id: `${provider}-subject-${index}`,
      user_id: USER_ID,
      identity_data: {},
      provider,
      created_at: "2026-10-21T10:00:00+00:00",
    })),
    created_at: "2026-10-21T10:00:00.123456+00:00",
    updated_at: "2026-10-21T11:00:00+00:00",
  };
}

function sessionBody(user: ReturnType<typeof gotrueUser>, refresh = "refresh-1", signedInSecondsAgo = 0) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;
  // a refreshed token gets a new iat but keeps the sign-in time in amr, which is what freshness is judged by
  const claims = { sub: user.id, exp, iat: now, role: "authenticated", amr: [{ method: "password", timestamp: now - signedInSecondsAgo }] };
  return {
    access_token: `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(claims)}.c2ln`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: exp,
    refresh_token: refresh,
    user,
  };
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    owner_id: USER_ID,
    lab_id: "organ",
    title: "Liver",
    description: "",
    head_version_id: VERSION_ID,
    head_seq: 1,
    draft_asset_id: null,
    draft_state_sha256: null,
    draft_thumbnail_asset_id: null,
    draft_rev: "0",
    draft_saved_at: null,
    thumbnail_asset_id: null,
    favorite: false,
    created_at: "2026-10-21T10:00:00.123456+00:00",
    updated_at: "2026-10-21T10:00:00.123456+00:00",
    opened_at: null,
    trashed_at: null,
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    project_id: PROJECT_ID,
    owner_id: USER_ID,
    seq: 2,
    parent_version_id: null,
    kind: "manual",
    label: null,
    snapshot_asset_id: ASSET_ID,
    state_sha256: SHA,
    thumbnail_asset_id: null,
    restored_from_version_id: null,
    lab_schema_version: 1,
    app_build: null,
    byte_size: 1234,
    created_at: "2026-10-21T10:00:00+00:00",
    ...overrides,
  };
}

/** A scripted stand-in for the Supabase APIs; unknown routes answer 404. */
class FakeSupabase {
  readonly requests: Recorded[] = [];
  private readonly routes: Array<{ method: string; path: string | RegExp; handler: Handler }> = [];
  password = PASSWORD;
  user = gotrueUser("ada@example.test");
  /** How long ago the sessions this server issues were signed in (amr timestamps, for the fresh sign-in rule). */
  tokenAgeSeconds = 0;

  constructor() {
    this.on("POST", "/auth/v1/token", (request) => {
      if (request.query.get("grant_type") === "refresh_token") return json(sessionBody(this.user, "refresh-2", this.tokenAgeSeconds));
      const body = request.json as { email?: string; password?: string };
      if (body.password !== this.password) return json({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400);
      return json(sessionBody(this.user, "refresh-1", this.tokenAgeSeconds));
    });
    this.on("GET", "/auth/v1/user", () => json(this.user));
    this.on("POST", "/auth/v1/logout", () => new Response(null, { status: 204 }));
  }

  on(method: string, path: string | RegExp, handler: Handler): void {
    this.routes.unshift({ method, path, handler });
  }

  /** Requests other than auth housekeeping (token refresh, user lookups). */
  data(): Recorded[] {
    return this.requests.filter((request) => !request.path.startsWith("/auth/v1/"));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let parsed: unknown;
    if (typeof init?.body === "string") {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = undefined;
      }
    }
    const request: Recorded = { method, url: `${url.origin}${url.pathname}`, path: url.pathname, query: url.searchParams, headers, json: parsed, body: init?.body };
    this.requests.push(request);
    const route = this.routes.find((candidate) => candidate.method === method && (typeof candidate.path === "string" ? candidate.path === url.pathname : candidate.path.test(url.pathname)));
    if (!route) return json({ message: `no route for ${method} ${url.pathname}` }, 404);
    return route.handler(request);
  };
}

class MapStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const created: SupabaseBackend[] = [];
afterEach(async () => {
  for (const backend of created.splice(0)) await backend.client.auth.stopAutoRefresh();
});

function makeBackend(server: FakeSupabase, deps: Partial<SupabaseBackendDeps> = {}, settings: SupabasePlatformConfig = config()) {
  const storage = new MapStorage();
  const navigate = vi.fn<(url: string) => void>();
  const backend = new SupabaseBackend(settings, {
    fetch: server.fetch,
    authStorage: storage,
    location: { search: "" },
    navigate,
    blobCache: createMemoryBlobCache(),
    assetOptions: { retryDelaysMs: [], sleep: async () => {} },
    ...deps,
  });
  created.push(backend);
  return { backend, storage, navigate };
}

async function signedIn(server: FakeSupabase, deps: Partial<SupabaseBackendDeps> = {}) {
  const made = makeBackend(server, deps);
  await made.backend.auth.signInWithPassword("ada@example.test", PASSWORD);
  server.requests.length = 0;
  return made;
}

async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError);
    return error as PlatformError;
  }
  throw new Error("expected a failure");
}

async function codeOf(promise: Promise<unknown>): Promise<PlatformErrorCode> {
  return (await failure(promise)).code;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const SNAPSHOT: SnapshotRef = {
  snapshotAssetId: ASSET_ID,
  stateSha256: SHA,
  thumbnailAssetId: null,
  attachments: [{ name: "mesh.bin", assetId: ASSET_ID }],
  labSchemaVersion: 3,
  appBuild: "build-9",
};

describe("SupabaseBackend client and session", () => {
  it("creates the client with PKCE, its own storage key, and URL detection only for ?code=", () => {
    const server = new FakeSupabase();
    const factory = vi.fn(createClient);
    makeBackend(server, { createClient: factory, location: { search: "?auth=callback" } });
    makeBackend(server, { createClient: factory, location: { search: "?auth=callback&code=abc" } });
    const [first, second] = factory.mock.calls;
    expect(first?.[0]).toBe(BASE);
    expect(first?.[1]).toBe(KEY);
    expect(first?.[2]?.auth).toMatchObject({ flowType: "pkce", storageKey: AUTH_STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false });
    expect(second?.[2]?.auth?.detectSessionInUrl).toBe(true);
  });

  it("makes no request while signed out, except username_available", async () => {
    const server = new FakeSupabase();
    server.on("POST", "/rest/v1/rpc/username_available", (request) => json((request.json as { p_username: string }).p_username === "free-name"));
    const { backend } = makeBackend(server);
    expect(await backend.auth.ready()).toBeNull();
    const id = PROJECT_ID;
    const calls: Array<() => Promise<unknown>> = [
      () => backend.projects.list(),
      () => backend.projects.get(id),
      () => backend.projects.versions(id),
      () => backend.projects.saveDraft(id, { headVersionId: null, draftRev: 0 }, SNAPSHOT),
      () => backend.library.list(),
      () => backend.library.get(id),
      () => backend.imports.list(),
      () => backend.account.profile(),
      () => backend.account.usage(),
      () => backend.account.deleteAccount("DELETE"),
      () => backend.assets.put(new Blob(["x"])),
      () => backend.assets.describe([id]),
      () => backend.assets.url(id),
      () => backend.assets.get(id),
      () => backend.auth.updatePassword("long enough password"),
      () => backend.auth.linkIdentity("google"),
    ];
    for (const call of calls) expect(await codeOf(call())).toBe("not_authenticated");
    await backend.auth.signOut();
    expect(server.requests).toEqual([]);

    expect(await backend.auth.usernameAvailable("ab")).toBe(false);
    expect(server.requests).toEqual([]);
    expect(await backend.auth.usernameAvailable("  Free-Name ")).toBe(true);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: "POST", path: "/rest/v1/rpc/username_available", json: { p_username: "free-name" } });
    expect(server.requests[0]?.headers.apikey).toBe(KEY);
  });

  it("signs in with a password and maps the session", async () => {
    const server = new FakeSupabase();
    const { backend, storage } = makeBackend(server);
    const events: AuthEvent[] = [];
    backend.auth.onChange((event) => events.push(event));
    const session = await backend.auth.signInWithPassword(" ada@example.test ", PASSWORD);
    const request = server.requests.find((candidate) => candidate.path === "/auth/v1/token");
    expect(request?.query.get("grant_type")).toBe("password");
    expect(request?.json).toMatchObject({ email: "ada@example.test", password: PASSWORD });
    expect(session.user).toEqual({
      id: USER_ID,
      email: "ada@example.test",
      emailConfirmed: true,
      providers: ["email"],
      createdAt: "2026-10-21T10:00:00.123Z",
      lastSignInAt: "2026-10-21T11:00:00.500Z",
    });
    expect(session.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(backend.auth.current()).toEqual(session);
    expect(storage.items.has(AUTH_STORAGE_KEY)).toBe(true);
    await settle();
    expect(events).toEqual(["signed_in"]);

    // a stored session is restored by the next page load
    const reloaded = new SupabaseBackend(config(), { fetch: server.fetch, authStorage: storage, location: { search: "" }, blobCache: null });
    created.push(reloaded);
    expect((await reloaded.auth.ready())?.user.id).toBe(USER_ID);
  });

  it("maps GoTrue failures", async () => {
    const server = new FakeSupabase();
    const { backend } = makeBackend(server);
    expect(await codeOf(backend.auth.signInWithPassword("ada@example.test", "wrong password"))).toBe("invalid_credentials");
    server.on("POST", "/auth/v1/token", () => json({ code: 429, error_code: "over_request_rate_limit", msg: "Request rate limit reached" }, 429));
    expect(await codeOf(backend.auth.signInWithPassword("ada@example.test", PASSWORD))).toBe("rate_limited");
    server.on("POST", "/auth/v1/token", () => {
      throw new TypeError("fetch failed");
    });
    expect(await codeOf(backend.auth.signInWithPassword("ada@example.test", PASSWORD))).toBe("network");
  });

  it("signs in with a username through the auth-username function", async () => {
    const server = new FakeSupabase();
    server.on("POST", "/functions/v1/auth-username", (request) => {
      const body = request.json as { username: string; password: string };
      if (body.username !== "daniil" || body.password !== PASSWORD) return json({ code: "invalid_credentials", message: "Invalid login" }, 400);
      return json({ session: sessionBody(server.user) });
    });
    const { backend } = makeBackend(server);
    expect(await codeOf(backend.auth.signInWithUsername("x", PASSWORD))).toBe("invalid_credentials");
    expect(server.requests).toEqual([]);
    expect(await codeOf(backend.auth.signInWithUsername("daniil", "wrong password"))).toBe("invalid_credentials");
    const session = await backend.auth.signInWithUsername(" Daniil ", PASSWORD);
    expect(session.user.id).toBe(USER_ID);
    const call = server.requests.filter((request) => request.path === "/functions/v1/auth-username").at(-1);
    expect(call?.json).toEqual({ username: "daniil", password: PASSWORD });
    // setSession validates the tokens against GoTrue
    expect(server.requests.some((request) => request.method === "GET" && request.path === "/auth/v1/user")).toBe(true);

    const disabled = makeBackend(server, {}, config({ username: false })).backend;
    expect(await codeOf(disabled.auth.signInWithUsername("daniil", PASSWORD))).toBe("provider_disabled");
  });

  it("signs up with profile metadata and the callback redirect", async () => {
    const server = new FakeSupabase();
    server.on("POST", "/auth/v1/signup", () => json(sessionBody(server.user)));
    const { backend } = makeBackend(server);
    expect(await codeOf(backend.auth.signUp({ email: "ada@example.test", password: "short" }))).toBe("weak_password");
    expect(await codeOf(backend.auth.signUp({ email: "ada@example.test", password: PASSWORD, username: "Not Valid!" }))).toBe("invalid_input");
    expect(server.requests).toEqual([]);
    const result = await backend.auth.signUp({ email: " ada@example.test ", password: PASSWORD, username: " Ada ", displayName: "  Ada Lovelace " });
    expect(result.needsEmailConfirmation).toBe(false);
    expect(result.session?.user.email).toBe("ada@example.test");
    const request = server.requests.find((candidate) => candidate.path === "/auth/v1/signup");
    expect(request?.query.get("redirect_to")).toBe(`${SITE}?auth=callback`);
    expect(request?.json).toMatchObject({ email: "ada@example.test", password: PASSWORD, data: { username: "ada", display_name: "Ada Lovelace" }, code_challenge_method: "s256" });

    server.on("POST", "/auth/v1/signup", () => json(gotrueUser("new@example.test")));
    expect(await backend.auth.signUp({ email: "new@example.test", password: PASSWORD })).toEqual({ session: null, needsEmailConfirmation: true });
    server.on("POST", "/auth/v1/signup", () => json({ code: 422, error_code: "user_already_exists", msg: "User already registered" }, 422));
    expect(await codeOf(backend.auth.signUp({ email: "ada@example.test", password: PASSWORD }))).toBe("user_exists");
  });

  it("sends and verifies 6-digit email codes", async () => {
    const server = new FakeSupabase();
    server.on("POST", "/auth/v1/otp", () => json({}));
    server.on("POST", "/auth/v1/verify", () => json(sessionBody(server.user)));
    const { backend } = makeBackend(server);
    await backend.auth.sendEmailCode(" ada@example.test ");
    const otp = server.requests.find((request) => request.path === "/auth/v1/otp");
    expect(otp?.json).toMatchObject({ email: "ada@example.test", create_user: false });
    expect(otp?.query.get("redirect_to")).toBe(`${SITE}?auth=callback`);
    await backend.auth.sendEmailCode("new@example.test", { createUser: true });
    expect(server.requests.filter((request) => request.path === "/auth/v1/otp").at(-1)?.json).toMatchObject({ create_user: true });
    const session = await backend.auth.verifyEmailCode("ada@example.test", " 123456 ");
    expect(session.user.id).toBe(USER_ID);
    expect(server.requests.find((request) => request.path === "/auth/v1/verify")?.json).toMatchObject({ email: "ada@example.test", token: "123456", type: "email" });

    server.on("POST", "/auth/v1/otp", () => json({ code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" }, 422));
    expect(await failure(backend.auth.sendEmailCode("nobody@example.test"))).toMatchObject({ code: "invalid_credentials", detail: "no_account" });
    const off = makeBackend(server, {}, config({ emailCode: false })).backend;
    expect(await codeOf(off.auth.sendEmailCode("ada@example.test"))).toBe("provider_disabled");
  });

  it("recovers an account with the 6-digit code of the reset mail", async () => {
    const server = new FakeSupabase();
    server.on("POST", "/auth/v1/verify", (request) => {
      const body = request.json as { token: string; type: string };
      if (body.type !== "recovery" || body.token !== "654321") return json({ code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" }, 403);
      return json(sessionBody(server.user));
    });
    const { backend } = makeBackend(server);
    const events: AuthEvent[] = [];
    backend.auth.onChange((event) => events.push(event));
    expect(await codeOf(backend.auth.verifyRecoveryCode("ada@example.test", "000000"))).toBe("invalid_credentials");
    const session = await backend.auth.verifyRecoveryCode(" ada@example.test ", " 654321 ");
    expect(session.user.id).toBe(USER_ID);
    expect(server.requests.filter((request) => request.path === "/auth/v1/verify").at(-1)?.json).toMatchObject({ email: "ada@example.test", token: "654321", type: "recovery" });
    await settle();
    expect(events).toEqual(["password_recovery"]);
  });

  it("offers email codes and resets only while mail is delivered", async () => {
    const server = new FakeSupabase();
    const settings = config();
    const { backend } = makeBackend(server, {}, { ...settings, emailDelivery: false });
    expect(await codeOf(backend.auth.sendEmailCode("ada@example.test"))).toBe("provider_disabled");
    expect(await codeOf(backend.auth.sendPasswordReset("ada@example.test"))).toBe("provider_disabled");
    expect(server.requests).toEqual([]);
  });

  it("asks for a fresh sign-in before changing the password or deleting the account", async () => {
    const server = new FakeSupabase();
    server.on("PUT", "/auth/v1/user", () => json(server.user));
    server.on("POST", "/functions/v1/account-delete", () => json({ ok: true }));
    server.tokenAgeSeconds = 11 * 60;
    const { backend } = await signedIn(server);
    const stale = await failure(backend.auth.updatePassword("a new long password"));
    expect(stale).toMatchObject({ code: "not_authenticated", detail: "reauthentication_needed" });
    expect(await codeOf(backend.account.deleteAccount("DELETE"))).toBe("not_authenticated");
    expect(server.data()).toEqual([]);
    expect(server.requests.some((request) => request.method === "PUT")).toBe(false);
    server.tokenAgeSeconds = 0;
    await backend.auth.signInWithPassword("ada@example.test", PASSWORD);
    await backend.auth.updatePassword("a new long password");
    expect(server.requests.some((request) => request.method === "PUT" && request.path === "/auth/v1/user")).toBe(true);
  });

  it("re-authenticates with the account's email and ends the session it replaced", async () => {
    const server = new FakeSupabase();
    server.on("PUT", "/auth/v1/user", () => json(server.user));
    server.tokenAgeSeconds = 11 * 60;
    const { backend, storage } = await signedIn(server);
    const before = backend.auth.current();
    const oldToken = (JSON.parse(storage.items.get(AUTH_STORAGE_KEY) as string) as { access_token: string }).access_token;
    expect(await codeOf(backend.auth.updatePassword("a new long password"))).toBe("not_authenticated");
    const events: AuthEvent[] = [];
    backend.auth.onChange((event) => events.push(event));

    // a wrong password is refused and the session stays as it was
    expect(await codeOf(backend.auth.reauthenticate("wrong password"))).toBe("invalid_credentials");
    expect(backend.auth.current()).toEqual(before);
    expect(server.requests.some((request) => request.path === "/auth/v1/logout")).toBe(false);

    server.tokenAgeSeconds = 0;
    server.requests.length = 0;
    await backend.auth.reauthenticate(PASSWORD);
    const signIn = server.requests.find((request) => request.path === "/auth/v1/token");
    expect(signIn?.query.get("grant_type")).toBe("password");
    expect(signIn?.json).toMatchObject({ email: "ada@example.test", password: PASSWORD });
    // the replaced session is ended with its own token, only that one
    const logout = server.requests.find((request) => request.path === "/auth/v1/logout");
    expect(logout?.query.get("scope")).toBe("local");
    expect(logout?.headers.authorization).toBe(`Bearer ${oldToken}`);
    expect(backend.auth.current()?.user.id).toBe(USER_ID);
    await settle();
    // the same user signing in again is not news
    expect(events).toEqual([]);
    await backend.auth.updatePassword("a new long password");
    expect(server.requests.some((request) => request.method === "PUT" && request.path === "/auth/v1/user")).toBe(true);

    await backend.auth.signOut();
    server.requests.length = 0;
    expect(await codeOf(backend.auth.reauthenticate(PASSWORD))).toBe("not_authenticated");
    expect(server.requests).toEqual([]);
  });

  it("judges the sign-in time by amr, as account-delete does, not by the token's iat", async () => {
    const { lastSignInAt } = await import("./auth");
    expect(lastSignInAt({ iat: 2000, amr: [{ method: "password", timestamp: 1000 }, { method: "otp", timestamp: 1500 }] })).toBe(1500);
    expect(lastSignInAt({ iat: 2000 })).toBeNull();
    expect(lastSignInAt(null)).toBeNull();
  });

  it("navigates to OAuth providers with the PKCE callback", async () => {
    const server = new FakeSupabase();
    const { backend, navigate, storage } = makeBackend(server);
    await backend.auth.signInWithOAuth("google");
    expect(server.requests).toEqual([]);
    const target = new URL(navigate.mock.calls[0]?.[0] as string);
    expect(`${target.origin}${target.pathname}`).toBe(`${BASE}/auth/v1/authorize`);
    expect(target.searchParams.get("provider")).toBe("google");
    expect(target.searchParams.get("redirect_to")).toBe(`${SITE}?auth=callback`);
    expect(target.searchParams.get("code_challenge_method")).toBe("s256");
    expect(storage.items.has(`${AUTH_STORAGE_KEY}-code-verifier`)).toBe(true);
    await backend.auth.signInWithOAuth("azure");
    expect(new URL(navigate.mock.calls[1]?.[0] as string).searchParams.get("scopes")).toBe("email");
    expect(await codeOf(backend.auth.signInWithOAuth("apple"))).toBe("provider_disabled");
  });

  it("resets and updates passwords and signs out", async () => {
    const server = new FakeSupabase();
    server.on("POST", "/auth/v1/recover", () => json({}));
    server.on("PUT", "/auth/v1/user", () => json(server.user));
    const { backend } = makeBackend(server);
    await backend.auth.sendPasswordReset("ada@example.test");
    expect(server.requests.find((request) => request.path === "/auth/v1/recover")?.query.get("redirect_to")).toBe(`${SITE}?auth=recovery`);
    expect(await codeOf(backend.auth.updatePassword("long enough password"))).toBe("not_authenticated");
    await backend.auth.signInWithPassword("ada@example.test", PASSWORD);
    expect(await codeOf(backend.auth.updatePassword("short"))).toBe("weak_password");
    await backend.auth.updatePassword("a new long password");
    expect(server.requests.find((request) => request.method === "PUT" && request.path === "/auth/v1/user")?.json).toMatchObject({ password: "a new long password" });

    const events: AuthEvent[] = [];
    backend.auth.onChange((event) => events.push(event));
    await backend.auth.signOut("global");
    expect(server.requests.find((request) => request.path === "/auth/v1/logout")?.query.get("scope")).toBe("global");
    expect(backend.auth.current()).toBeNull();
    await settle();
    expect(events).toContain("signed_out");
  });

  it("links and unlinks identities", async () => {
    const server = new FakeSupabase();
    server.user = gotrueUser("ada@example.test", ["email", "github"]);
    server.on("GET", "/auth/v1/user/identities/authorize", (request) => json({ url: `https://github.com/login/oauth/authorize?state=${request.query.get("provider")}` }));
    server.on("DELETE", /^\/auth\/v1\/user\/identities\//, () => {
      server.user = gotrueUser("ada@example.test", ["email"]);
      return json({});
    });
    const { backend, navigate } = await signedIn(server);
    expect(backend.auth.current()?.user.providers).toEqual(["email", "github"]);
    await backend.auth.linkIdentity("google");
    const authorize = server.requests.find((request) => request.path === "/auth/v1/user/identities/authorize");
    expect(authorize?.query.get("provider")).toBe("google");
    expect(authorize?.query.get("redirect_to")).toBe(`${SITE}?auth=callback`);
    expect(navigate).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=google");
    await backend.auth.unlinkIdentity("github");
    expect(server.requests.some((request) => request.method === "DELETE" && request.path === "/auth/v1/user/identities/identity-github")).toBe(true);
    expect(backend.auth.current()?.user.providers).toEqual(["email"]);
    expect(await codeOf(backend.auth.unlinkIdentity("apple"))).toBe("not_found");
  });

  it("reports why a callback in the URL failed", async () => {
    const server = new FakeSupabase();
    const { backend } = makeBackend(server, { location: { search: "?auth=callback&error=access_denied&error_code=bad_oauth_state&error_description=The+link+expired" } });
    await backend.auth.ready();
    expect(backend.auth.callbackError()).toMatchObject({ code: "invalid_credentials", message: "The link expired" });
    const plain = makeBackend(server).backend;
    await plain.auth.ready();
    expect(plain.auth.callbackError()).toBeNull();
  });
});

describe("SupabaseBackend projects", () => {
  it("lists with filters, escaped search, ordering and limit", async () => {
    const server = new FakeSupabase();
    server.on("GET", "/rest/v1/projects", () => json([projectRow()]));
    const { backend } = await signedIn(server);
    const [project] = await backend.projects.list({ labId: "organ", favorite: true, search: " 50%_off ", orderBy: "opened", limit: 5 });
    expect(project).toMatchObject({ id: PROJECT_ID, draftRev: 0, createdAt: "2026-10-21T10:00:00.123Z", headSeq: 1 });
    const query = server.data()[0]?.query as URLSearchParams;
    expect(query.get("select")).toBe("*");
    expect(query.get("trashed_at")).toBe("is.null");
    expect(query.get("lab_id")).toBe("eq.organ");
    expect(query.get("favorite")).toBe("eq.true");
    expect(query.get("title")).toBe("ilike.%50\\%\\_off%");
    expect(query.get("order")).toBe("opened_at.desc.nullslast,id.asc");
    expect(query.get("limit")).toBe("5");

    await backend.projects.list({ trashed: true, orderBy: "title" });
    const trashed = server.data()[1]?.query as URLSearchParams;
    expect(trashed.get("trashed_at")).toBe("not.is.null");
    expect(trashed.get("order")).toBe("title.asc.nullslast,id.asc");
    await backend.projects.list();
    expect(server.data()[2]?.query.get("order")).toBe("updated_at.desc.nullslast,id.asc");
  });

  it("gets one project and answers not_found without asking for malformed ids", async () => {
    const server = new FakeSupabase();
    server.on("GET", "/rest/v1/projects", (request) => json(request.query.get("id") === `eq.${PROJECT_ID}` ? [projectRow()] : []));
    const { backend } = await signedIn(server);
    expect((await backend.projects.get(PROJECT_ID)).title).toBe("Liver");
    expect(await codeOf(backend.projects.get(VERSION_ID))).toBe("not_found");
    expect(await codeOf(backend.projects.get("../etc"))).toBe("not_found");
    expect(server.data()).toHaveLength(2);
  });

  it("calls the project RPCs with their p_* parameters", async () => {
    const server = new FakeSupabase();
    const bodies = new Map<string, unknown>();
    for (const name of ["create_project", "save_draft", "discard_draft", "duplicate_project"]) {
      server.on("POST", `/rest/v1/rpc/${name}`, (request) => {
        bodies.set(name, request.json);
        return json(projectRow());
      });
    }
    server.on("POST", "/rest/v1/rpc/label_version", (request) => {
      bodies.set("label_version", request.json);
      return json(versionRow({ label: "Final" }));
    });
    for (const name of ["commit_version", "restore_version"]) {
      server.on("POST", `/rest/v1/rpc/${name}`, (request) => {
        bodies.set(name, request.json);
        return json({ project: projectRow({ head_seq: 2, draft_rev: 7 }), version: versionRow() });
      });
    }
    server.on("POST", "/rest/v1/rpc/delete_version", (request) => {
      bodies.set("delete_version", request.json);
      return new Response(null, { status: 204 });
    });
    const { backend } = await signedIn(server);
    await backend.projects.create({ labId: "organ", title: "  Liver ", ...SNAPSHOT });
    await backend.projects.saveDraft(PROJECT_ID, { headVersionId: VERSION_ID, draftRev: 4 }, SNAPSHOT);
    await backend.projects.discardDraft(PROJECT_ID, 5);
    const committed = await backend.projects.commit(PROJECT_ID, { headVersionId: VERSION_ID, draftRev: 6 }, "named", SNAPSHOT, " Final ");
    expect(committed.version).toMatchObject({ seq: 2, kind: "manual", byteSize: 1234 });
    expect(committed.project).toMatchObject({ id: PROJECT_ID, headSeq: 2, draftRev: 7 });
    await backend.projects.restore(PROJECT_ID, VERSION_ID, { headVersionId: null, draftRev: 7 });
    expect((await backend.projects.label(VERSION_ID, " Final ")).label).toBe("Final");
    await backend.projects.deleteVersion(VERSION_ID);
    await backend.projects.duplicate(PROJECT_ID, " Copy ");
    const attachments = [{ name: "mesh.bin", asset_id: ASSET_ID }];
    expect(bodies.get("create_project")).toEqual({
      p_lab_id: "organ",
      p_title: "Liver",
      p_snapshot_asset_id: ASSET_ID,
      p_state_sha256: SHA,
      p_thumbnail_asset_id: null,
      p_lab_schema_version: 3,
      p_app_build: "build-9",
      p_attachments: attachments,
      p_description: "",
    });
    expect(bodies.get("save_draft")).toEqual({
      p_project_id: PROJECT_ID,
      p_expected_head_version_id: VERSION_ID,
      p_expected_draft_rev: 4,
      p_snapshot_asset_id: ASSET_ID,
      p_state_sha256: SHA,
      p_thumbnail_asset_id: null,
      p_attachments: attachments,
      p_lab_schema_version: 3,
      p_app_build: "build-9",
    });
    expect(bodies.get("discard_draft")).toEqual({ p_project_id: PROJECT_ID, p_expected_draft_rev: 5 });
    expect(bodies.get("commit_version")).toEqual({
      p_project_id: PROJECT_ID,
      p_expected_head_version_id: VERSION_ID,
      p_expected_draft_rev: 6,
      p_kind: "named",
      p_snapshot_asset_id: ASSET_ID,
      p_state_sha256: SHA,
      p_label: "Final",
      p_thumbnail_asset_id: null,
      p_lab_schema_version: 3,
      p_app_build: "build-9",
      p_attachments: attachments,
    });
    expect(bodies.get("restore_version")).toEqual({ p_project_id: PROJECT_ID, p_version_id: VERSION_ID, p_expected_head_version_id: null, p_expected_draft_rev: 7 });
    expect(bodies.get("label_version")).toEqual({ p_version_id: VERSION_ID, p_label: "Final" });
    expect(bodies.get("delete_version")).toEqual({ p_version_id: VERSION_ID });
    expect(bodies.get("duplicate_project")).toEqual({ p_project_id: PROJECT_ID, p_title: "Copy", p_version_id: null });
  });

  it("maps the jsonb { project, version } of commit and restore, and refuses any other shape", async () => {
    const server = new FakeSupabase();
    // to_jsonb() writes timestamptz with a T and microseconds, and bigint as a number
    server.on("POST", "/rest/v1/rpc/commit_version", () =>
      json({ project: projectRow({ head_seq: 3, draft_rev: 9, updated_at: "2026-10-22T08:00:00.123456+00:00" }), version: versionRow({ seq: 3 }) }),
    );
    server.on("POST", "/rest/v1/rpc/restore_version", () => json({ project: projectRow({ head_seq: 4 }), version: versionRow({ seq: 4, kind: "restore" }) }));
    const { backend } = await signedIn(server);
    const committed = await backend.projects.commit(PROJECT_ID, { headVersionId: VERSION_ID, draftRev: 8 }, "manual", SNAPSHOT);
    expect(committed.version.seq).toBe(3);
    expect(committed.project).toMatchObject({ headSeq: 3, draftRev: 9, updatedAt: "2026-10-22T08:00:00.123Z" });
    expect((await backend.projects.restore(PROJECT_ID, VERSION_ID, { headVersionId: VERSION_ID, draftRev: 9 })).version).toMatchObject({ seq: 4, kind: "restore" });

    // the version row alone (the function before DESIGN.md §15.2) is not enough to go on
    server.on("POST", "/rest/v1/rpc/commit_version", () => json(versionRow({ seq: 3 })));
    expect(await failure(backend.projects.commit(PROJECT_ID, { headVersionId: VERSION_ID, draftRev: 8 }, "manual", SNAPSHOT))).toMatchObject({
      code: "unknown",
      detail: "unexpected commit_version.project from the server",
    });
    server.on("POST", "/rest/v1/rpc/restore_version", () => json({ project: projectRow(), version: null }));
    expect(await codeOf(backend.projects.restore(PROJECT_ID, VERSION_ID, { headVersionId: VERSION_ID, draftRev: 9 }))).toBe("unknown");
  });

  it("maps a stale draft revision on commit and restore to draft_conflict", async () => {
    const server = new FakeSupabase();
    for (const name of ["commit_version", "restore_version"]) {
      server.on("POST", `/rest/v1/rpc/${name}`, () => json({ code: "PT409", message: "draft_conflict", details: '{"draft_rev" : 5}', hint: null }, 409));
    }
    const { backend } = await signedIn(server);
    const commit = await failure(backend.projects.commit(PROJECT_ID, { headVersionId: VERSION_ID, draftRev: 4 }, "manual", SNAPSHOT));
    expect(commit).toMatchObject({ code: "draft_conflict", status: 409 });
    expect(conflictDetail(commit)?.draftRev).toBe(5);
    expect(conflictDetail(await failure(backend.projects.restore(PROJECT_ID, VERSION_ID, { headVersionId: VERSION_ID, draftRev: 4 })))?.draftRev).toBe(5);
  });

  it("maps database errors, including conflict details", async () => {
    const server = new FakeSupabase();
    server.on("POST", "/rest/v1/rpc/commit_version", () =>
      json({ code: "PT409", message: "version_conflict", details: `{"head_version_id" : "${VERSION_ID}", "head_seq" : 7}`, hint: null }, 409),
    );
    server.on("POST", "/rest/v1/rpc/save_draft", () => json({ code: "PT409", message: "draft_conflict", details: '{"draft_rev" : 12}', hint: null }, 409));
    server.on("POST", "/rest/v1/rpc/create_project", () => json({ code: "PT403", message: "limit_reached", details: "at most 100 projects on this plan", hint: null }, 403));
    const { backend } = await signedIn(server);
    const conflict = await failure(backend.projects.commit(PROJECT_ID, { headVersionId: null, draftRev: 0 }, "manual", SNAPSHOT));
    expect(conflict).toMatchObject({ code: "version_conflict", status: 409 });
    expect(conflictDetail(conflict)).toEqual({ headVersionId: VERSION_ID, headSeq: 7, draftRev: null });
    expect(conflictDetail(await failure(backend.projects.saveDraft(PROJECT_ID, { headVersionId: null, draftRev: 0 }, SNAPSHOT)))?.draftRev).toBe(12);
    expect(await failure(backend.projects.create({ labId: "organ", title: "x", ...SNAPSHOT }))).toMatchObject({ code: "limit_reached", detail: "at most 100 projects on this plan" });
  });

  it("patches only granted columns, stamping trash and opened times", async () => {
    const server = new FakeSupabase();
    let patch: unknown;
    server.on("PATCH", "/rest/v1/projects", (request) => {
      patch = request.json;
      return json([projectRow({ title: "Renamed", trashed_at: "2026-10-21T12:00:00+00:00" })]);
    });
    server.on("GET", "/rest/v1/projects", () => json([projectRow()]));
    const { backend } = await signedIn(server);
    const before = Date.now();
    const updated = await backend.projects.update(PROJECT_ID, { title: " Renamed ", favorite: true, opened: true, trashed: true });
    expect(updated).toMatchObject({ title: "Renamed", trashedAt: "2026-10-21T12:00:00.000Z" });
    const sent = patch as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["favorite", "opened_at", "title", "trashed_at"]);
    expect(sent.title).toBe("Renamed");
    expect(Date.parse(sent.trashed_at as string)).toBeGreaterThanOrEqual(before - 1000);
    const request = server.data().find((candidate) => candidate.method === "PATCH");
    expect(request?.query.get("id")).toBe(`eq.${PROJECT_ID}`);
    expect(request?.headers.prefer).toContain("return=representation");
    await backend.projects.update(PROJECT_ID, { trashed: false });
    expect(patch).toEqual({ trashed_at: null });
    server.requests.length = 0;
    await backend.projects.update(PROJECT_ID, {});
    expect(server.data().map((candidate) => candidate.method)).toEqual(["GET"]);
  });

  it("deletes only trashed projects and tells missing from not-in-trash", async () => {
    const server = new FakeSupabase();
    let deleted: unknown[] = [];
    let existing: unknown[] = [];
    server.on("DELETE", "/rest/v1/projects", () => json(deleted));
    server.on("GET", "/rest/v1/projects", () => json(existing));
    const { backend } = await signedIn(server);
    deleted = [{ id: PROJECT_ID }];
    await backend.projects.deleteForever(PROJECT_ID);
    deleted = [];
    existing = [{ id: PROJECT_ID }];
    expect(await failure(backend.projects.deleteForever(PROJECT_ID))).toMatchObject({ code: "invalid_input", status: 409 });
    existing = [];
    expect(await codeOf(backend.projects.deleteForever(PROJECT_ID))).toBe("not_found");
  });

  it("reads versions newest first and attachments sorted by name", async () => {
    const server = new FakeSupabase();
    server.on("GET", "/rest/v1/project_versions", () => json([versionRow({ seq: 2 }), versionRow({ id: "55555555-5555-4555-8555-555555555555", seq: "1", kind: "initial" })]));
    server.on("GET", "/rest/v1/project_version_assets", () => json([{ name: "b.bin", asset_id: ASSET_ID }, { name: "A.bin", asset_id: ASSET_ID }]));
    server.on("GET", "/rest/v1/project_draft_assets", () => json([]));
    const { backend } = await signedIn(server);
    expect((await backend.projects.versions(PROJECT_ID)).map((version) => version.seq)).toEqual([2, 1]);
    expect(server.data()[0]?.query.get("order")).toBe("seq.desc");
    expect(server.data()[0]?.query.get("project_id")).toBe(`eq.${PROJECT_ID}`);
    expect((await backend.projects.versionAttachments(VERSION_ID)).map((attachment) => attachment.name)).toEqual(["A.bin", "b.bin"]);
    expect(await backend.projects.draftAttachments(PROJECT_ID)).toEqual([]);
    expect(await backend.projects.versions("nope")).toEqual([]);
  });
});

describe("SupabaseBackend library, imports and account", () => {
  const itemRow = (overrides: Record<string, unknown> = {}) => ({
    id: PROJECT_ID,
    owner_id: USER_ID,
    kind: "shape",
    title: "Liver 42",
    description: "",
    tags: ["liver"],
    lab_id: "organ",
    source_project_id: null,
    source_version_id: null,
    metadata: { claims: { evidence: "procedural" } },
    thumbnail_asset_id: null,
    favorite: false,
    byte_size: 300,
    created_at: "2026-10-21T10:00:00+00:00",
    updated_at: "2026-10-21T10:00:00+00:00",
    trashed_at: null,
    ...overrides,
  });

  it("creates library items through the RPC and re-reads them with their files", async () => {
    const server = new FakeSupabase();
    let rpcBody: unknown;
    server.on("POST", "/rest/v1/rpc/create_library_item", (request) => {
      rpcBody = request.json;
      return json(itemRow());
    });
    server.on("GET", "/rest/v1/library_items", () =>
      json([
        itemRow({
          library_item_files: [
            { filename: "spec.json", asset_id: ASSET_ID, role: "spec", position: 1, assets: { byte_size: 20, mime_type: "application/json" } },
            { filename: "liver.glb", asset_id: ASSET_ID, role: "mesh", position: 0, assets: { byte_size: "280", mime_type: "model/gltf-binary" } },
          ],
        }),
      ]),
    );
    const { backend } = await signedIn(server);
    const item = await backend.library.create({
      kind: "shape",
      title: " Liver 42 ",
      tags: [" liver ", "LIVER"],
      labId: "organ",
      metadata: { claims: { evidence: "procedural" } },
      files: [
        { filename: "liver.glb", assetId: ASSET_ID, role: "mesh", position: 0 },
        { filename: "spec.json", assetId: ASSET_ID, role: "spec" },
      ],
    });
    expect(rpcBody).toEqual({
      p_kind: "shape",
      p_title: "Liver 42",
      p_files: [
        { filename: "liver.glb", asset_id: ASSET_ID, role: "mesh", position: 0 },
        { filename: "spec.json", asset_id: ASSET_ID, role: "spec" },
      ],
      p_description: "",
      p_tags: ["liver"],
      p_lab_id: "organ",
      p_source_project_id: null,
      p_source_version_id: null,
      p_metadata: { claims: { evidence: "procedural" } },
      p_thumbnail_asset_id: null,
    });
    expect(item.files?.map((file) => [file.filename, file.byteSize, file.mimeType])).toEqual([
      ["liver.glb", 280, "model/gltf-binary"],
      ["spec.json", 20, "application/json"],
    ]);
    const select = server.data().find((request) => request.method === "GET")?.query.get("select");
    // postgrest-js drops the whitespace of the select list
    expect(select).toBe("*,library_item_files(filename,asset_id,role,position,assets(byte_size,mime_type))");
  });

  it("lists library items by kind, tag and search, and patches them", async () => {
    const server = new FakeSupabase();
    let patch: unknown;
    server.on("GET", "/rest/v1/library_items", () => json([itemRow()]));
    server.on("PATCH", "/rest/v1/library_items", (request) => {
      patch = request.json;
      return json([itemRow({ favorite: true, library_item_files: [] })]);
    });
    const { backend } = await signedIn(server);
    await backend.library.list({ kind: "recording", tag: "physics", search: "run", favorite: false });
    const query = server.data()[0]?.query as URLSearchParams;
    expect(query.get("kind")).toBe("eq.recording");
    expect(query.get("tags")).toBe("cs.{physics}");
    expect(query.get("title")).toBe("ilike.%run%");
    expect(query.get("favorite")).toBe("eq.false");
    expect(query.get("order")).toBe("created_at.desc,id.asc");
    const updated = await backend.library.update(PROJECT_ID, { favorite: true, tags: ["a", " b "], trashed: false });
    expect(patch).toEqual({ favorite: true, tags: ["a", "b"], trashed_at: null });
    expect(updated.files).toEqual([]);
  });

  it("creates and corrects imported objects", async () => {
    const server = new FakeSupabase();
    let rpcBody: unknown;
    let patch: unknown;
    const importRow = (overrides: Record<string, unknown> = {}) => ({
      id: PROJECT_ID,
      owner_id: USER_ID,
      title: "Heart",
      source_app: "blender",
      source_detail: "Blender 4.2",
      detected_by: "metadata",
      format: "fbx",
      original_asset_id: ASSET_ID,
      display_asset_id: null,
      thumbnail_asset_id: null,
      stats: { meshes: 2, vertices: 10, triangles: 4, materials: 1, textures: 0, animations: 0, skinned: false, bbox: { x: 1, y: 2, z: 3 } },
      tags: [],
      favorite: false,
      byte_size: 128,
      created_at: "2026-10-21T10:00:00+00:00",
      updated_at: "2026-10-21T10:00:00+00:00",
      trashed_at: null,
      ...overrides,
    });
    server.on("POST", "/rest/v1/rpc/create_imported_object", (request) => {
      rpcBody = request.json;
      return json(importRow());
    });
    server.on("PATCH", "/rest/v1/imported_objects", (request) => {
      patch = request.json;
      return json([importRow({ source_app: "unity", detected_by: "user" })]);
    });
    const { backend } = await signedIn(server);
    const stats = { meshes: 2, vertices: 10, triangles: 4, materials: 1, textures: 0, animations: 0, skinned: false, bbox: { x: 1, y: 2, z: 3 } };
    const object = await backend.imports.create({
      title: " Heart ",
      format: "fbx",
      originalAssetId: ASSET_ID,
      sourceApp: "blender",
      sourceDetail: "  ",
      detectedBy: "metadata",
      displayAssetId: null,
      thumbnailAssetId: null,
      stats,
    });
    expect(rpcBody).toEqual({
      p_title: "Heart",
      p_format: "fbx",
      p_original_asset_id: ASSET_ID,
      p_source_app: "blender",
      p_source_detail: null,
      p_detected_by: "metadata",
      p_display_asset_id: null,
      p_thumbnail_asset_id: null,
      p_stats: stats,
      p_tags: [],
    });
    expect(object.stats).toEqual(stats);
    const corrected = await backend.imports.update(PROJECT_ID, { sourceApp: "unity" });
    expect(patch).toEqual({ source_app: "unity", detected_by: "user" });
    expect(corrected).toMatchObject({ sourceApp: "unity", detectedBy: "user" });
  });

  it("reads and updates the profile, maps a taken username, and reads usage", async () => {
    const server = new FakeSupabase();
    const profile = { id: USER_ID, username: "ada", display_name: "Ada", avatar_asset_id: null, plan_id: "free", appearance: "system", created_at: "2026-10-21T10:00:00+00:00", updated_at: "2026-10-21T10:00:00+00:00" };
    server.on("GET", "/rest/v1/profiles", () => json([profile]));
    server.on("PATCH", "/rest/v1/profiles", (request) => {
      if ((request.json as { username?: string }).username === "taken") {
        return json({ code: "23505", message: 'duplicate key value violates unique constraint "profiles_username_key"', details: "Key (username)=(taken) already exists.", hint: null }, 409);
      }
      return json([{ ...profile, ...(request.json as object) }]);
    });
    server.on("POST", "/rest/v1/rpc/my_usage", () =>
      json({
        plan_id: "free",
        plan_title: "Free",
        storage_quota_bytes: 524288000,
        max_file_bytes: 52428800,
        version_retention_days: 30,
        max_projects: 100,
        used_bytes: "1048576",
        pending_bytes: 0,
        project_count: 2,
        version_count: 5,
        library_count: 1,
        import_count: 0,
        trash_count: 1,
      }),
    );
    const { backend } = await signedIn(server);
    expect(await backend.account.profile()).toMatchObject({ username: "ada", planId: "free", appearance: "system" });
    expect(server.data()[0]?.query.get("id")).toBe(`eq.${USER_ID}`);
    expect(await backend.account.updateProfile({ displayName: "  Ada L. ", appearance: "dark" })).toMatchObject({ displayName: "Ada L.", appearance: "dark" });
    expect(await failure(backend.account.updateProfile({ username: " Taken " }))).toMatchObject({ code: "user_exists", detail: "username" });
    expect(await codeOf(backend.account.updateProfile({ username: "no spaces" }))).toBe("invalid_input");
    expect(await backend.account.usage()).toMatchObject({ usedBytes: 1048576, projectCount: 2, trashCount: 1, maxFileBytes: 52428800 });
  });

  it("deletes the account through its function, then forgets the local session", async () => {
    const server = new FakeSupabase();
    server.on("POST", "/functions/v1/account-delete", () => json({ ok: true }));
    const { backend } = await signedIn(server);
    expect(await codeOf(backend.account.deleteAccount("delete" as "DELETE"))).toBe("invalid_input");
    expect(server.requests).toEqual([]);
    await backend.account.deleteAccount("DELETE");
    const call = server.requests.find((request) => request.path === "/functions/v1/account-delete");
    expect(call?.json).toEqual({ confirmation: "DELETE" });
    expect(call?.headers.authorization).toMatch(/^Bearer /);
    expect(server.requests.find((request) => request.path === "/auth/v1/logout")?.query.get("scope")).toBe("local");
    expect(backend.auth.current()).toBeNull();

    const failing = new FakeSupabase();
    failing.on("POST", "/functions/v1/account-delete", () => json({ error: { code: "invalid_input", message: "confirmation" } }, 400));
    expect(await codeOf((await signedIn(failing)).backend.account.deleteAccount("DELETE"))).toBe("invalid_input");
  });
});

describe("SupabaseBackend assets", () => {
  function storageServer() {
    const server = new FakeSupabase();
    const objects = new Map<string, Blob>();
    const rows = new Map<string, { id: string; sha256: string; byte_size: number; mime_type: string; object_path: string; status: string; created_at: string }>();
    /** Answers the next reserve_asset calls give instead of reserving. */
    const reserveFailures: Response[] = [];
    const flags = { truncateNextUpload: false };
    server.on("POST", "/rest/v1/rpc/reserve_asset", (request) => {
      const failure = reserveFailures.shift();
      if (failure) return failure;
      const body = request.json as { p_sha256: string; p_byte_size: number; p_mime_type: string };
      const existing = [...rows.values()].find((row) => row.sha256 === body.p_sha256);
      // a rejected reservation is opened again for one more upload
      if (existing?.status === "rejected") existing.status = "pending";
      if (existing) return json([{ asset_id: existing.id, object_path: existing.object_path, status: existing.status }]);
      const id = `00000000-0000-4000-8000-${String(rows.size + 1).padStart(12, "0")}`;
      const row = { id, sha256: body.p_sha256, byte_size: body.p_byte_size, mime_type: body.p_mime_type, object_path: `${USER_ID}/${body.p_sha256.slice(0, 2)}/${body.p_sha256}`, status: "pending", created_at: "2026-10-21T10:00:00+00:00" };
      rows.set(id, row);
      return json([{ asset_id: id, object_path: row.object_path, status: "pending" }]);
    });
    server.on("POST", "/rest/v1/rpc/confirm_asset", (request) => {
      const row = rows.get((request.json as { p_asset_id: string }).p_asset_id);
      if (!row) return json({ code: "PT404", message: "not_found", details: "asset", hint: null }, 404);
      if (row.status === "rejected") return json({ code: "PT409", message: "size_mismatch", details: "rejected: reserve the file again and upload it once more", hint: null }, 409);
      const stored = objects.get(row.object_path);
      if (!stored) return json({ code: "PT409", message: "upload_missing", details: row.object_path, hint: null }, 409);
      if (stored.size !== row.byte_size) {
        // private.error_response: the rejected mark is committed and the answer is still PostgREST's 409 error body
        row.status = "rejected";
        return json({ code: "PT409", message: "size_mismatch", details: `stored ${stored.size} bytes, reserved ${row.byte_size}`, hint: null }, 409);
      }
      row.status = "ready";
      // to_jsonb(row): the whole row, timestamps with a T
      return json({ ...row, owner_id: USER_ID, last_used_at: row.created_at, ready_at: row.created_at });
    });
    server.on("GET", "/rest/v1/assets", (request) => {
      const ids = (request.query.get("id") ?? "").replace(/^in\.\(|\)$/g, "").split(",");
      return json([...rows.values()].filter((row) => ids.includes(row.id)));
    });
    server.on("POST", /^\/storage\/v1\/object\/user-content\//, async (request) => {
      const path = request.path.replace("/storage/v1/object/user-content/", "");
      const body = request.body as Blob;
      objects.set(path, flags.truncateNextUpload ? body.slice(0, 1) : body);
      flags.truncateNextUpload = false;
      return json({ Key: `user-content/${path}`, Id: "object-id" });
    });
    server.on("GET", /^\/storage\/v1\/object\/user-content\//, (request) => {
      const blob = objects.get(request.path.replace("/storage/v1/object/user-content/", ""));
      return blob ? new Response(blob, { status: 200 }) : json({ statusCode: "404", error: "not_found", message: "Object not found" }, 400);
    });
    server.on("POST", "/storage/v1/object/sign/user-content", (request) => {
      const body = request.json as { expiresIn: number; paths: string[] };
      return json(body.paths.map((path) => ({ path, signedURL: `/object/sign/user-content/${path}?token=t${body.expiresIn}`, error: null })));
    });
    const uploads = new Map<string, { length: number; offset: number; parts: Blob[]; objectName: string }>();
    server.on("POST", "/storage/v1/upload/resumable", (request) => {
      const metadata = Object.fromEntries(
        (request.headers["upload-metadata"] ?? "").split(",").map((pair) => {
          const [key, value] = pair.split(" ");
          return [key, new TextDecoder().decode(Uint8Array.from(atob(value ?? ""), (char) => char.charCodeAt(0)))];
        }),
      );
      const id = `upload-${uploads.size + 1}`;
      uploads.set(id, { length: Number(request.headers["upload-length"]), offset: 0, parts: [], objectName: metadata.objectName as string });
      return new Response(null, { status: 201, headers: { location: `${BASE}/storage/v1/upload/resumable/${id}` } });
    });
    server.on("PATCH", /^\/storage\/v1\/upload\/resumable\//, (request) => {
      const upload = uploads.get(request.path.split("/").pop() as string);
      if (!upload) return new Response(null, { status: 404 });
      const chunk = request.body as Blob;
      upload.parts.push(chunk);
      upload.offset += chunk.size;
      if (upload.offset === upload.length) objects.set(upload.objectName, new Blob(upload.parts));
      return new Response(null, { status: 204, headers: { "upload-offset": String(upload.offset) } });
    });
    return { server, objects, rows, uploads, reserveFailures, flags };
  }

  const assetPath = (request: Recorded): string =>
    request.path.startsWith("/storage/v1/object/user-content/") ? "upload" : request.path.replace("/rest/v1/rpc/", "").replace("/rest/v1/", "");

  it("starts a put over when reserve answers asset_busy", async () => {
    const { server, reserveFailures } = storageServer();
    const { backend } = await signedIn(server);
    reserveFailures.push(json({ code: "PT409", message: "asset_busy", details: "being collected", hint: null }, 409));
    const asset = await backend.assets.put(new Blob(["collected bytes"], { type: "text/plain" }));
    expect(asset.status).toBe("ready");
    expect(server.data().map(assetPath)).toEqual(["reserve_asset", "reserve_asset", "upload", "confirm_asset"]);

    // a collection that does not end: put() gives up with the error after its four pauses
    server.requests.length = 0;
    for (let index = 0; index < 5; index += 1) reserveFailures.push(json({ code: "PT409", message: "asset_busy", details: "", hint: null }, 409));
    expect(await failure(backend.assets.put(new Blob(["stuck"])))).toMatchObject({ code: "asset_busy", status: 409 });
    expect(server.data().map(assetPath)).toEqual(["reserve_asset", "reserve_asset", "reserve_asset", "reserve_asset", "reserve_asset"]);
  });

  it("reserves and uploads again when confirm rejects a wrong stored size", async () => {
    const { server, flags, rows } = storageServer();
    const { backend } = await signedIn(server);
    flags.truncateNextUpload = true;
    const asset = await backend.assets.put(new Blob(["exact bytes"], { type: "text/plain" }));
    expect(asset).toMatchObject({ status: "ready", byteSize: 11 });
    expect(server.data().map(assetPath)).toEqual(["reserve_asset", "upload", "confirm_asset", "reserve_asset", "upload", "confirm_asset"]);
    expect(rows.get(asset.id)?.status).toBe("ready");
  });

  it("leaves rows being collected or rejected out of describe()", async () => {
    const { server, rows } = storageServer();
    const writer = (await signedIn(server)).backend;
    const kept = await writer.assets.put(new Blob(["kept"], { type: "text/plain" }));
    const collected = await writer.assets.put(new Blob(["collected"], { type: "text/plain" }));
    const rejected = await writer.assets.put(new Blob(["rejected"], { type: "text/plain" }));
    (rows.get(collected.id) as { status: string }).status = "deleting";
    (rows.get(rejected.id) as { status: string }).status = "rejected";
    const { backend } = await signedIn(server);
    expect(await backend.assets.describe([kept.id, collected.id, rejected.id])).toEqual([kept]);
    expect(await codeOf(backend.assets.get(collected.id))).toBe("not_found");
  });

  it("reserves, uploads with the session token, confirms, then deduplicates", async () => {
    const { server, objects } = storageServer();
    const { backend } = await signedIn(server);
    const blob = new Blob(['{"a":1}'], { type: "application/json" });
    const asset = await backend.assets.put(blob);
    const sha = await sha256Hex(blob);
    expect(asset).toMatchObject({ sha256: sha, byteSize: 7, mimeType: "application/json", status: "ready" });
    const [reserve, upload, confirm] = server.data();
    expect(reserve).toMatchObject({ path: "/rest/v1/rpc/reserve_asset", json: { p_sha256: sha, p_byte_size: 7, p_mime_type: "application/json" } });
    expect(upload?.path).toBe(`/storage/v1/object/user-content/${USER_ID}/${sha.slice(0, 2)}/${sha}`);
    expect(upload?.headers).toMatchObject({ apikey: KEY, "content-type": "application/json", "x-upsert": "true", "cache-control": "max-age=31536000" });
    expect(upload?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(confirm?.json).toEqual({ p_asset_id: asset.id });
    expect(objects.size).toBe(1);

    server.requests.length = 0;
    expect((await backend.assets.put(new Blob(['{"a":1}']))).id).toBe(asset.id);
    expect(server.data().map((request) => request.path)).toEqual(["/rest/v1/rpc/reserve_asset", "/rest/v1/rpc/confirm_asset"]);
  });

  it("uploads files above 6 MB with TUS in 6 MB chunks", async () => {
    const { server, objects } = storageServer();
    const { backend } = await signedIn(server);
    const size = 6 * 1024 * 1024 + 10;
    const asset = await backend.assets.put(new Blob([new Uint8Array(size).fill(1)], { type: "video/webm" }));
    expect(asset.byteSize).toBe(size);
    const tus = server.data().filter((request) => request.path.startsWith("/storage/v1/upload/resumable"));
    expect(tus.map((request) => request.method)).toEqual(["POST", "PATCH", "PATCH"]);
    expect(tus[0]?.url).toBe("https://abcdefghijklmnop.storage.supabase.co/storage/v1/upload/resumable");
    expect(tus[0]?.headers).toMatchObject({ "upload-length": String(size), "x-upsert": "true", apikey: KEY, "tus-resumable": "1.0.0" });
    expect(tus[0]?.headers.authorization).toMatch(/^Bearer /);
    expect((tus[1]?.body as Blob).size).toBe(6 * 1024 * 1024);
    expect([...objects.values()][0]?.size).toBe(size);
  });

  it("signs URLs in batches and downloads verified bytes", async () => {
    const { server } = storageServer();
    const writer = (await signedIn(server)).backend;
    const first = await writer.assets.put(new Blob(["first"], { type: "text/plain" }));
    const second = await writer.assets.put(new Blob(["second"], { type: "text/plain" }));
    const { backend } = await signedIn(server);
    const [a, b] = await Promise.all([backend.assets.url(first.id), backend.assets.url(second.id, { expiresInSeconds: 3600 })]);
    expect(a).toBe(`${BASE}/storage/v1/object/sign/user-content/${first.objectPath}?token=t3600`);
    expect(b).toContain(second.objectPath);
    const requests = server.data();
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /rest/v1/assets", "POST /storage/v1/object/sign/user-content"]);
    expect(requests[1]?.json).toEqual({ expiresIn: 3600, paths: [first.objectPath, second.objectPath] });
    expect(await (await backend.assets.get(first.id)).text()).toBe("first");
    expect(server.data().at(-1)?.path).toBe(`/storage/v1/object/user-content/${first.objectPath}`);
  });

  it("maps a refused upload to the platform error", async () => {
    const { server } = storageServer();
    server.on("POST", /^\/storage\/v1\/object\/user-content\//, () => json({ statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" }, 413));
    const { backend } = await signedIn(server);
    expect(await codeOf(backend.assets.put(new Blob(["big"])))).toBe("file_too_large");
  });

  it("sends resumable uploads to the direct storage host of a hosted project", async () => {
    const server = new FakeSupabase();
    const { backend } = makeBackend(server);
    const settings = config();
    const direct = new SupabaseTransport(backend.client, settings, backend.auth, { fetch: server.fetch });
    const viaApi = new SupabaseTransport(backend.client, settings, backend.auth, { fetch: server.fetch, directStorageHost: false });
    expect(direct.tusEndpoint()).toBe("https://abcdefghijklmnop.storage.supabase.co/storage/v1/upload/resumable");
    expect(viaApi.tusEndpoint()).toBe(`${BASE}/storage/v1/upload/resumable`);
    const local = parsePlatformConfig({ schema: "viscera.platform/v1", supabaseUrl: "http://127.0.0.1:54321", supabaseKey: KEY }, { allowLoopbackHttp: true });
    if (!local.enabled || local.backend !== "supabase") throw new Error("expected a local config");
    expect(new SupabaseTransport(backend.client, local, backend.auth, { fetch: server.fetch, directStorageHost: true }).tusEndpoint()).toBe(
      "http://127.0.0.1:54321/storage/v1/upload/resumable",
    );
  });
});

describe("timestamps", () => {
  it("normalises Postgres timestamptz text to ISO UTC", () => {
    expect(normalizeTimestamp("2026-10-21T18:00:00.123456+00:00")).toBe("2026-10-21T18:00:00.123Z");
    expect(normalizeTimestamp("2026-10-21 20:00:00+02")).toBe("2026-10-21T18:00:00.000Z");
    expect(normalizeTimestamp("2026-10-21T18:00:00Z")).toBe("2026-10-21T18:00:00.000Z");
    expect(normalizeTimestamp("2026-10-21T18:00:00.5-0130")).toBe("2026-10-21T19:30:00.500Z");
    expect(normalizeTimestamp("garbage")).toBe("garbage");
  });
});
