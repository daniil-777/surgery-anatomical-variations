// auth-username handler (supabase/functions/auth-username/handler.ts) with a fake database that mirrors the SQL of
// login_failures / claim_login_attempt / note_login_attempt / resolve_login_email, a fake Auth token endpoint and a
// fake clock.
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../functions/_shared/http.ts";
import type { LogFields } from "../../functions/_shared/log.ts";
import type { RpcClient, ServiceResult } from "../../functions/_shared/ports.ts";
import {
  ADDRESS_FAILURE_LIMIT,
  type AuthUsernameDeps,
  createAuthUsernameHandler,
  MAX_PASSWORD_LENGTH,
  normalizeUsername,
  secondsUntilWindowEnds,
  USERNAME_FAILURE_LIMIT,
} from "../../functions/auth-username/handler.ts";

const SUPABASE_URL = "https://ref.supabase.co";
const SECRET_KEY = "sb_secret_test_0123456789";
const ORIGIN = "https://daniil-777.github.io";
const USERNAME = "daniil";
const EMAIL = "owner@example.test";
const PASSWORD = "correct horse battery staple";
const USER_ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
/** 2026-10-21 12:03:20 UTC: 700 s before the 15-minute throttle window closes. */
const NOW = Date.UTC(2026, 9, 21, 12, 3, 20);
const CLIENT_IP = "203.0.113.7";
/** What a hosted project's gateway hands a function (probed 2026-10-08): the client twice, then an internal hop. */
const HOSTED_XFF = `${CLIENT_IP},${CLIENT_IP}, 10.0.0.1`;
/** 800 ms floor + 0.5 × 200 ms jitter (random() is pinned to 0.5). */
const FAILURE_ANSWER_MS = 900;
/** Simulated Auth latency: the password hash is only checked when the address belongs to an account. */
const AUTH_MS_KNOWN = 80;
const AUTH_MS_UNKNOWN = 5;

type RpcFailure = "error" | "throw" | undefined;
type FailRpc = (fn: string, args: Record<string, unknown>) => RpcFailure;

interface Options {
  accounts?: Record<string, unknown>;
  counters?: Record<string, number>;
  failRpc?: FailRpc;
  /** Answers a call instead of the fake SQL (undefined: the fake SQL answers). */
  answer?: (fn: string, args: Record<string, unknown>) => ServiceResult<unknown> | undefined;
  auth?: (body: Record<string, unknown>) => Response | Promise<Response>;
  deps?: Partial<AuthUsernameDeps>;
}

interface LogEntry {
  level: "info" | "error";
  event: string;
  fields: LogFields | undefined;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "header.payload.signature",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: NOW / 1000 + 3600,
    refresh_token: "refresh-token-1",
    user: { id: USER_ID, aud: "authenticated", email: EMAIL },
    weak_password: null,
    ...overrides,
  };
}

const rejection = () => json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });

function defaultAuth(body: Record<string, unknown>): Response {
  return body.email === EMAIL && body.password === PASSWORD ? json(200, session()) : rejection();
}

// The SQL semantics: login_failures = the largest counter among the keys in the current window; claim_login_attempt
// increments every distinct key in one statement and allows the attempt while the largest counter is within p_limit
// (retry_after_seconds = the rest of the window when refused); a failure note increments every key; a success note
// deletes only the u: keys.
function answerRpc(
  fn: string,
  args: Record<string, unknown>,
  counters: Map<string, number>,
  accounts: Record<string, unknown>,
  nowMs: number,
): ServiceResult<unknown> {
  const keys = Array.isArray(args.p_keys) ? args.p_keys.map(String) : [];
  switch (fn) {
    case "login_failures":
      return { data: Math.max(0, ...keys.map((key) => counters.get(key) ?? 0)), error: null };
    case "claim_login_attempt": {
      const limit = Number(args.p_limit);
      if (!Number.isInteger(limit) || limit < 1) return { data: null, error: { message: "invalid_input", status: 422 } };
      let attempts = 0;
      for (const key of new Set(keys.filter((key) => key.length >= 1 && key.length <= 200))) {
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        attempts = Math.max(attempts, count);
      }
      const allowed = attempts <= limit;
      return { data: { allowed, attempts, retry_after_seconds: allowed ? 0 : secondsUntilWindowEnds(nowMs) }, error: null };
    }
    case "note_login_attempt":
      for (const key of keys) {
        if (args.p_success === true) {
          if (key.startsWith("u:")) counters.delete(key);
        } else {
          counters.set(key, (counters.get(key) ?? 0) + 1);
        }
      }
      return { data: null, error: null };
    case "resolve_login_email":
      return { data: accounts[String(args.p_username)] ?? null, error: null };
    default:
      return { data: null, error: { message: `unexpected function ${fn}` } };
  }
}

function setup(options: Options = {}) {
  const counters = new Map<string, number>(Object.entries(options.counters ?? {}));
  const accounts = options.accounts ?? { [USERNAME]: EMAIL };
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const authCalls: Array<{ url: string; method: string | undefined; headers: Headers; body: Record<string, unknown> }> = [];
  const sleeps: number[] = [];
  const logs: LogEntry[] = [];
  const clock = { now: NOW };

  const db: RpcClient = {
    async rpc(fn, args = {}) {
      rpcCalls.push({ fn, args });
      const answer = options.answer?.(fn, args);
      if (answer !== undefined) return answer;
      const failure = options.failRpc?.(fn, args);
      if (failure === "throw") throw new TypeError("fetch failed");
      if (failure === "error") return { data: null, error: { message: "database unavailable", status: 503 } };
      return answerRpc(fn, args, counters, accounts, clock.now);
    },
  };
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    authCalls.push({ url, method: init.method, headers: new Headers(init.headers), body });
    clock.now += Object.values(accounts).includes(body.email) ? AUTH_MS_KNOWN : AUTH_MS_UNKNOWN;
    return (options.auth ?? defaultAuth)(body);
  };

  const handler = createAuthUsernameHandler({
    appOrigins: [ORIGIN],
    supabaseUrl: SUPABASE_URL,
    secretKey: SECRET_KEY,
    db,
    fetch,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    random: () => 0.5,
    randomId: () => "5f0c6a1e-0000-4000-8000-000000000000",
    logger: {
      info: (event, fields) => logs.push({ level: "info", event, fields }),
      error: (event, fields) => logs.push({ level: "error", event, fields }),
    },
    ...options.deps,
  });
  return { handler, rpcCalls, authCalls, counters, sleeps, logs, clock };
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  omit?: string[];
}

function signIn(body: unknown, options: RequestOptions = {}): Request {
  const headers = new Headers({
    origin: ORIGIN,
    "content-type": "application/json",
    "cf-connecting-ip": CLIENT_IP,
    "x-forwarded-for": HOSTED_XFF,
    ...options.headers,
  });
  for (const name of options.omit ?? []) headers.delete(name);
  const method = options.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  return new Request(`${SUPABASE_URL}/functions/v1/auth-username`, {
    method,
    headers,
    body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : null,
  });
}

/** A request from `address` only (as a client of a single-proxy stack would arrive). */
function from(address: string): RequestOptions {
  return { omit: ["x-forwarded-for"], headers: { "cf-connecting-ip": address } };
}

const correct = { username: USERNAME, password: PASSWORD };
const wrong = { username: USERNAME, password: "wrong password" };
const ADDRESS_KEY = `ip:${CLIENT_IP}`;

describe("auth-username: CORS and methods", () => {
  it("answers a preflight from an allowed origin without doing any work", async () => {
    const { handler, rpcCalls, authCalls } = setup();
    const response = await handler(signIn(null, { method: "OPTIONS", headers: { "access-control-request-method": "POST" } }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("apikey");
    expect(rpcCalls).toEqual([]);
    expect(authCalls).toEqual([]);
  });

  it("refuses preflights and posts from other origins before reading them", async () => {
    const { handler, rpcCalls, authCalls } = setup();
    for (const method of ["OPTIONS", "POST"]) {
      const response = await handler(signIn(correct, { method, headers: { origin: "https://evil.example.test" } }));
      expect(response.status, method).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    }
    expect(rpcCalls).toEqual([]);
    expect(authCalls).toEqual([]);
  });

  it("serves callers without an Origin (servers, curl) without a CORS grant", async () => {
    const { handler } = setup();
    const response = await handler(signIn(correct, { omit: ["origin"] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects other methods with 405 and an Allow header", async () => {
    const { handler, rpcCalls } = setup();
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const response = await handler(signIn(correct, { method }));
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST, OPTIONS");
      expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
    }
    expect(rpcCalls).toEqual([]);
  });

  it("answers 503 when the project URL, the secret key or the service client is missing", async () => {
    for (const deps of [{ supabaseUrl: null }, { secretKey: null }, { db: null }]) {
      const { handler, authCalls } = setup({ deps });
      const response = await handler(signIn(correct));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "not_configured" });
      expect(authCalls).toEqual([]);
    }
  });
});

describe("auth-username: input", () => {
  it("requires a JSON body of reasonable size", async () => {
    const { handler, rpcCalls } = setup();
    expect((await handler(signIn(correct, { headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await handler(signIn("{username:"))).status).toBe(400);
    expect((await handler(signIn("[1,2]"))).status).toBe(400);
    expect((await handler(signIn({ username: USERNAME, password: "x".repeat(10_000) }))).status).toBe(413);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    "",
    "ab",
    "a".repeat(31),
    "-daniil",
    "daniil-",
    ".daniil",
    "dan..iil",
    "dan._iil",
    "dan iil",
    "dañiil",
    "owner@example.test",
    42,
    null,
    undefined,
    [USERNAME],
  ])("rejects the username %j without touching the database", async (username) => {
    const { handler, rpcCalls, authCalls } = setup();
    const response = await handler(signIn({ username, password: PASSWORD }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_input" });
    expect(rpcCalls).toEqual([]);
    expect(authCalls).toEqual([]);
  });

  it("normalises usernames like the database: trimmed, lower case, 3 to 30 characters", async () => {
    expect(normalizeUsername("  Daniil ")).toBe("daniil");
    expect(normalizeUsername("a.b-c_d")).toBe("a.b-c_d");
    expect(normalizeUsername("abc")).toBe("abc");
    expect(normalizeUsername("a".repeat(30))).toBe("a".repeat(30));

    const { handler, rpcCalls } = setup();
    const response = await handler(signIn({ username: "  DaNiil ", password: PASSWORD }));
    expect(response.status).toBe(200);
    expect(rpcCalls.find((call) => call.fn === "resolve_login_email")?.args).toEqual({ p_username: "daniil" });
    expect(rpcCalls.find((call) => call.fn === "claim_login_attempt")?.args.p_keys).toEqual(["u:daniil"]);
  });

  it(`accepts passwords of 1 to ${MAX_PASSWORD_LENGTH} characters`, async () => {
    const { handler, authCalls } = setup();
    for (const password of ["", "x".repeat(MAX_PASSWORD_LENGTH + 1), 12345678, null]) {
      expect((await handler(signIn({ username: USERNAME, password }))).status, String(password)).toBe(400);
    }
    expect(authCalls).toEqual([]);
    for (const password of ["x", "x".repeat(MAX_PASSWORD_LENGTH)]) {
      expect((await handler(signIn({ username: USERNAME, password }))).status).toBe(401);
    }
    expect(authCalls.map((call) => call.body.password)).toEqual(["x", "x".repeat(MAX_PASSWORD_LENGTH)]);
  });

  it("sends Auth only the email and password, whatever else the body carries", async () => {
    const { handler, authCalls } = setup();
    const response = await handler(signIn({ ...correct, captchaToken: "token", email: "someone-else@example.test" }));
    expect(response.status).toBe(200);
    expect(authCalls[0]?.body).toEqual({ email: EMAIL, password: PASSWORD });
  });
});

describe("auth-username: sign-in", () => {
  it("returns the session fields and clears the username's failures", async () => {
    const { handler, rpcCalls, authCalls, counters, sleeps } = setup({
      counters: { "u:daniil": 3, [ADDRESS_KEY]: 4 },
    });
    const response = await handler(signIn(correct));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await response.json()).toEqual({
      access_token: "header.payload.signature",
      refresh_token: "refresh-token-1",
      expires_in: 3600,
      expires_at: NOW / 1000 + 3600,
      token_type: "bearer",
      user: { id: USER_ID, aud: "authenticated", email: EMAIL },
    });

    expect(authCalls).toHaveLength(1);
    const call = authCalls[0];
    expect(call?.url).toBe(`${SUPABASE_URL}/auth/v1/token?grant_type=password`);
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ email: EMAIL, password: PASSWORD });
    // the secret key in apikey only, and the caller's address for Auth's own per-address limits
    expect([...(call?.headers.entries() ?? [])].sort()).toEqual([
      ["apikey", SECRET_KEY],
      ["content-type", "application/json"],
      ["sb-forwarded-for", CLIENT_IP],
    ]);

    expect(rpcCalls).toEqual([
      { fn: "login_failures", args: { p_keys: [ADDRESS_KEY] } },
      { fn: "claim_login_attempt", args: { p_keys: ["u:daniil"], p_limit: USERNAME_FAILURE_LIMIT } },
      { fn: "resolve_login_email", args: { p_username: "daniil" } },
      { fn: "note_login_attempt", args: { p_keys: ["u:daniil", ADDRESS_KEY], p_success: true } },
    ]);
    expect(Object.fromEntries(counters)).toEqual({ [ADDRESS_KEY]: 4 });
    expect(sleeps).toEqual([]);
  });

  it("fills in expires_at from expires_in when Auth leaves it out", async () => {
    const { handler } = setup({ auth: () => json(200, session({ expires_at: undefined })) });
    const body = (await (await handler(signIn(correct))).json()) as { expires_at: number };
    expect(body.expires_at).toBe(Math.floor((NOW + AUTH_MS_KNOWN) / 1000) + 3600);
  });

  it("still returns the session when recording the success fails", async () => {
    const { handler, logs } = setup({
      failRpc: (fn, args) => (fn === "note_login_attempt" && args.p_success === true ? "error" : undefined),
    });
    expect((await handler(signIn(correct))).status).toBe(200);
    expect(logs).toContainEqual({ level: "error", event: "note_login_attempt_failed", fields: { success: true, name: "UpstreamError" } });
  });

  it("says so when the password is right but the email is not confirmed yet (no delay, not a failure)", async () => {
    const { handler, counters, sleeps } = setup({
      counters: { "u:daniil": 2 },
      auth: (body) =>
        body.password === PASSWORD
          ? json(400, { code: 400, error_code: "email_not_confirmed", msg: "Email not confirmed" })
          : rejection(),
    });
    const response = await handler(signIn(correct));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "email_not_confirmed" });
    expect(counters.has("u:daniil")).toBe(false);
    expect(counters.has(ADDRESS_KEY)).toBe(false);
    expect(sleeps).toEqual([]);
  });
});

describe("auth-username: wrong passwords and unknown usernames", () => {
  it("answers a wrong password with 401 after the minimum delay and counts the failure", async () => {
    const { handler, counters, sleeps, clock } = setup();
    const response = await handler(signIn(wrong));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_credentials" });
    expect(Object.fromEntries(counters)).toEqual({ "u:daniil": 1, [ADDRESS_KEY]: 1 });
    expect(sleeps).toEqual([FAILURE_ANSWER_MS - AUTH_MS_KNOWN]);
    expect(clock.now).toBe(NOW + FAILURE_ANSWER_MS);
  });

  it("answers an unknown username exactly like a wrong password, at the same time", async () => {
    const known = setup();
    const unknown = setup();
    const wrongPassword = await known.handler(signIn(wrong));
    const unknownUser = await unknown.handler(signIn({ username: "nobody", password: "wrong password" }));

    expect(unknownUser.status).toBe(wrongPassword.status);
    expect([...unknownUser.headers]).toEqual([...wrongPassword.headers]);
    expect(await unknownUser.text()).toBe(await wrongPassword.text());
    expect(unknown.clock.now).toBe(known.clock.now);

    // same steps, including a password grant, against an address that cannot exist
    expect(unknown.rpcCalls.map((call) => call.fn)).toEqual(known.rpcCalls.map((call) => call.fn));
    expect(unknown.authCalls).toHaveLength(1);
    const standIn = String(unknown.authCalls[0]?.body.email);
    expect(standIn).toMatch(/^[0-9a-f-]{36}@unknown\.invalid$/);
    expect([...(unknown.authCalls[0]?.headers.entries() ?? [])].sort()).toEqual(
      [...(known.authCalls[0]?.headers.entries() ?? [])].sort(),
    );
    expect(Object.fromEntries(unknown.counters)).toEqual({ "u:nobody": 1, [ADDRESS_KEY]: 1 });
  });

  it("treats reserved names like any unknown username", async () => {
    expect(normalizeUsername("admin")).toBe("admin");
    const { handler, authCalls } = setup();
    const response = await handler(signIn({ username: "admin", password: PASSWORD }));
    expect(response.status).toBe(401);
    expect(authCalls).toHaveLength(1);
  });

  it("never returns a session or a confirmation hint for the stand-in address", async () => {
    const answers = [
      () => json(200, session()),
      () => json(400, { code: 400, error_code: "email_not_confirmed", msg: "Email not confirmed" }),
    ];
    for (const auth of answers) {
      const { handler } = setup({ auth });
      const response = await handler(signIn({ username: "nobody", password: PASSWORD }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid_credentials" });
    }
  });

  it("recognises Auth's other ways of rejecting a password", async () => {
    const answers = [
      () => json(400, { error: "invalid_grant", error_description: "Invalid login credentials" }),
      () => json(400, { code: "invalid_credentials", message: "Invalid login credentials" }),
      () => json(400, { code: 400, error_code: "user_banned", msg: "User is banned" }),
      () => json(401, { code: 401, error_code: "invalid_credentials", msg: "Invalid login credentials" }),
    ];
    for (const auth of answers) {
      const { handler } = setup({ auth });
      expect((await handler(signIn(correct))).status).toBe(401);
    }
  });
});

describe("auth-username: throttling", () => {
  it(`refuses attempt ${USERNAME_FAILURE_LIMIT + 1} in a window, even with the right password`, async () => {
    const { handler, authCalls, clock } = setup();
    for (let attempt = 0; attempt < USERNAME_FAILURE_LIMIT; attempt += 1) {
      expect((await handler(signIn(wrong, from(`198.51.100.${attempt + 1}`)))).status).toBe(401);
    }
    const response = await handler(signIn(correct));
    expect(response.status).toBe(429);
    const expected = secondsUntilWindowEnds(clock.now);
    expect(await response.json()).toEqual({ error: "rate_limited", retry_after_seconds: expected });
    expect(response.headers.get("retry-after")).toBe(String(expected));
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(authCalls).toHaveLength(USERNAME_FAILURE_LIMIT);
  });

  it(`refuses an address with ${ADDRESS_FAILURE_LIMIT} failures before counting anything against the username`, async () => {
    const { handler, rpcCalls, authCalls, counters } = setup({ counters: { [ADDRESS_KEY]: ADDRESS_FAILURE_LIMIT } });
    const response = await handler(signIn(correct));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited", retry_after_seconds: 700 });
    expect(rpcCalls).toEqual([{ fn: "login_failures", args: { p_keys: [ADDRESS_KEY] } }]);
    expect(counters.has("u:daniil")).toBe(false);
    expect(authCalls).toEqual([]);
  });

  it("lets an address just under its limit and a username just under its limit through", async () => {
    const { handler } = setup({
      counters: { [ADDRESS_KEY]: ADDRESS_FAILURE_LIMIT - 1, "u:daniil": USERNAME_FAILURE_LIMIT - 1 },
    });
    expect((await handler(signIn(correct))).status).toBe(200);
  });

  it("claims parallel guesses atomically before checking them: exactly the limit reach Auth", async () => {
    const { handler, authCalls, counters, rpcCalls } = setup();
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, index) => handler(signIn(wrong, from(`198.51.100.${index + 1}`)))),
    );
    const statuses = responses.map((response) => response.status);
    expect(authCalls).toHaveLength(USERNAME_FAILURE_LIMIT);
    expect(statuses.filter((status) => status === 401)).toHaveLength(USERNAME_FAILURE_LIMIT);
    expect(statuses.filter((status) => status === 429)).toHaveLength(25 - USERNAME_FAILURE_LIMIT);
    // one claim per request, and no read-then-write of the username's counter
    expect(rpcCalls.filter((call) => call.fn === "claim_login_attempt")).toHaveLength(25);
    expect(rpcCalls.filter((call) => call.fn === "login_failures").every((call) => call.args.p_keys !== undefined && String(call.args.p_keys).startsWith("ip:"))).toBe(true);
    expect(rpcCalls.some((call) => call.fn === "note_login_attempt" && call.args.p_success === false && String(call.args.p_keys).startsWith("u:"))).toBe(false);
    expect(counters.get("u:daniil")).toBe(25);
    // the right password waits for the window like everyone else
    expect((await handler(signIn(correct, from("198.51.100.99")))).status).toBe(429);
  });

  it("answers the database's own Retry-After when it refuses a claim, and counts nothing against the address", async () => {
    const { handler, authCalls, counters, logs } = setup({
      answer: (fn) =>
        fn === "claim_login_attempt" ? { data: { allowed: false, attempts: 11, retry_after_seconds: 42 }, error: null } : undefined,
    });
    const response = await handler(signIn(correct));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited", retry_after_seconds: 42 });
    expect(response.headers.get("retry-after")).toBe("42");
    expect(authCalls).toEqual([]);
    expect(counters.has(ADDRESS_KEY)).toBe(false);
    expect(logs).toContainEqual({ level: "info", event: "throttled", fields: { scope: "username" } });
  });

  it("falls back to its own clock when the database's Retry-After is unusable", async () => {
    for (const retry of [0, 901, 1.5, "60", null]) {
      const { handler, clock } = setup({
        answer: (fn) =>
          fn === "claim_login_attempt" ? { data: { allowed: false, attempts: 11, retry_after_seconds: retry }, error: null } : undefined,
      });
      const response = await handler(signIn(correct));
      expect(response.status, String(retry)).toBe(429);
      expect(await response.json()).toEqual({ error: "rate_limited", retry_after_seconds: secondsUntilWindowEnds(clock.now) });
    }
  });

  it("counts every address of an IPv6 /64 network together", async () => {
    const { handler, counters } = setup({ accounts: {} });
    for (let host = 1; host <= ADDRESS_FAILURE_LIMIT; host += 1) {
      const username = `guess${host}`;
      const response = await handler(signIn({ username, password: "x" }, from(`2001:db8:1:2::${host.toString(16)}`)));
      expect(response.status).toBe(401);
    }
    expect(counters.get("ip:2001:db8:1:2::/64")).toBe(ADDRESS_FAILURE_LIMIT);
    const blocked = await handler(signIn({ username: "another", password: "x" }, from("2001:db8:1:2:ffff:ffff:ffff:ffff")));
    expect(blocked.status).toBe(429);
    const neighbour = await handler(signIn({ username: "another", password: "x" }, from("2001:db8:1:3::1")));
    expect(neighbour.status).toBe(401);
  });

  it("computes Retry-After to the end of the 15-minute window", () => {
    expect(secondsUntilWindowEnds(Date.UTC(2026, 9, 21, 12, 0, 0))).toBe(900);
    expect(secondsUntilWindowEnds(NOW)).toBe(700);
    expect(secondsUntilWindowEnds(Date.UTC(2026, 9, 21, 12, 14, 58, 999))).toBe(2);
    expect(secondsUntilWindowEnds(Date.UTC(2026, 9, 21, 12, 14, 59, 500))).toBe(1);
  });
});

describe("auth-username: client address", () => {
  it("prefers CF-Connecting-IP, then X-Real-IP, then the leftmost X-Forwarded-For entry", async () => {
    const cases: Array<[Record<string, string>, string[], string]> = [
      [{ "cf-connecting-ip": "198.51.100.1", "x-real-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3, 10.0.0.1" }, [], "198.51.100.1"],
      [{ "x-real-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3, 10.0.0.1" }, ["cf-connecting-ip"], "198.51.100.2"],
      [{ "x-forwarded-for": "198.51.100.3, 198.51.100.3, 10.0.0.1" }, ["cf-connecting-ip"], "198.51.100.3"],
      [{ "cf-connecting-ip": "not-an-address", "x-forwarded-for": "198.51.100.3" }, [], "198.51.100.3"],
    ];
    for (const [headers, omit, expected] of cases) {
      const { handler, counters, authCalls } = setup();
      await handler(signIn(wrong, { headers, omit }));
      expect(counters.get(`ip:${expected}`), expected).toBe(1);
      expect(authCalls[0]?.headers.get("sb-forwarded-for")).toBe(expected);
    }
  });

  it("forwards an IPv6 caller's own address but throttles its /64; IPv4-mapped addresses count as IPv4", async () => {
    const six = setup();
    await six.handler(signIn(wrong, from("2001:DB8:1:2::ABCD")));
    expect(six.counters.get("ip:2001:db8:1:2::/64")).toBe(1);
    expect(six.authCalls[0]?.headers.get("sb-forwarded-for")).toBe("2001:db8:1:2::abcd");

    const mapped = setup();
    await mapped.handler(signIn(wrong, from("::ffff:198.51.100.9")));
    expect(mapped.counters.get("ip:198.51.100.9")).toBe(1);
    expect(mapped.authCalls[0]?.headers.get("sb-forwarded-for")).toBe("198.51.100.9");
  });

  it("puts callers without a usable address under one shared key and forwards nothing", async () => {
    const { handler, counters, authCalls } = setup();
    await handler(signIn(wrong, { omit: ["cf-connecting-ip"], headers: { "x-forwarded-for": "<script>, 10.0.0.1" } }));
    expect(counters.get("ip:unknown")).toBe(1);
    expect(authCalls[0]?.headers.has("sb-forwarded-for")).toBe(false);
  });
});

describe("auth-username: upstream failures", () => {
  it("passes Auth's own rate limit through as 429 with its Retry-After", async () => {
    const limited = setup({ auth: () => json(429, { code: 429, error_code: "over_request_rate_limit" }, { "retry-after": "120" }) });
    const response = await limited.handler(signIn(correct));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited", retry_after_seconds: 120 });
    expect(response.headers.get("retry-after")).toBe("120");
    expect(limited.counters.get(ADDRESS_KEY)).toBeUndefined();

    const vague = setup({ auth: () => json(429, {}, { "retry-after": "Wed, 21 Oct 2026 12:10:00 GMT" }) });
    expect(await (await vague.handler(signIn(correct))).json()).toEqual({ error: "rate_limited", retry_after_seconds: 60 });
  });

  it("answers 502, never 'wrong password', when Auth or the gateway fails or answers something unusable", async () => {
    const answers: Array<[() => Response, number | null, string | null]> = [
      [() => json(500, { msg: "internal" }), 500, null],
      [() => json(503, { msg: "unavailable" }), 503, null],
      [() => json(403, { msg: "forbidden" }), 403, null],
      // the gateway's answer to a wrong or revoked key carries no Auth error code
      [() => json(401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." }), 401, null],
      [() => json(400, { code: 400, error_code: "captcha_failed", msg: "captcha protection: request disallowed" }), 400, "captcha_failed"],
      [() => json(422, { code: 422, error_code: "validation_failed", msg: "invalid email" }), 422, "validation_failed"],
      [() => new Response("<html>bad gateway</html>", { status: 400 }), 400, null],
      [() => new Response("<html>bad gateway</html>", { status: 200 }), 200, "unusable_session"],
      [() => json(200, session({ access_token: "" })), 200, "unusable_session"],
      [() => json(200, session({ user: { email: EMAIL } })), 200, "unusable_session"],
    ];
    for (const [answer, status, code] of answers) {
      const { handler, counters, sleeps, logs } = setup({ auth: answer });
      const response = await handler(signIn(correct));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "upstream" });
      expect(counters.get(ADDRESS_KEY)).toBeUndefined();
      expect(sleeps).toEqual([]);
      expect(logs).toContainEqual({ level: "error", event: "upstream_failed", fields: { step: "auth.token", status, code } });
    }
  });

  it("answers 502 when Auth cannot be reached", async () => {
    const { handler, logs } = setup({
      auth: () => {
        throw new TypeError("fetch failed");
      },
    });
    const response = await handler(signIn(correct));
    expect(response.status).toBe(502);
    expect(logs).toContainEqual({ level: "error", event: "auth_unreachable", fields: { name: "TypeError" } });
  });

  it("answers 502 without asking Auth when the throttle or lookup functions fail", async () => {
    const failures: FailRpc[] = [
      (fn) => (fn === "login_failures" ? "error" : undefined),
      (fn) => (fn === "login_failures" ? "throw" : undefined),
      (fn) => (fn === "claim_login_attempt" ? "error" : undefined),
      (fn) => (fn === "claim_login_attempt" ? "throw" : undefined),
      (fn) => (fn === "resolve_login_email" ? "error" : undefined),
    ];
    for (const failRpc of failures) {
      const { handler, authCalls } = setup({ failRpc });
      const response = await handler(signIn(correct));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "upstream" });
      expect(authCalls).toEqual([]);
    }
    // a claim answer without a decision is a database problem, never a reason to let the attempt through
    for (const data of [null, 7, "allowed", { attempts: 1 }, { allowed: "true" }]) {
      const { handler, authCalls, logs } = setup({ answer: (fn) => (fn === "claim_login_attempt" ? { data, error: null } : undefined) });
      expect((await handler(signIn(correct))).status, JSON.stringify(data)).toBe(502);
      expect(authCalls).toEqual([]);
      expect(logs).toContainEqual({ level: "error", event: "upstream_failed", fields: { step: "claim_login_attempt", status: null } });
    }
    const odd = setup({ accounts: { [USERNAME]: 42 } });
    expect((await odd.handler(signIn(correct))).status).toBe(502);
    expect(odd.authCalls).toEqual([]);
    // a counter that is not a finite number is a database problem, not a reason to let the attempt through
    const oddCount = setup();
    oddCount.counters.set(ADDRESS_KEY, Number.NaN);
    expect((await oddCount.handler(signIn(correct))).status).toBe(502);
  });

  it("still answers 401 when recording a failure fails", async () => {
    const { handler, logs } = setup({
      failRpc: (fn, args) =>
        fn === "note_login_attempt" && args.p_success === false && Array.isArray(args.p_keys) && args.p_keys[0] === ADDRESS_KEY
          ? "error"
          : undefined,
    });
    expect((await handler(signIn(wrong))).status).toBe(401);
    expect(logs.some((entry) => entry.event === "note_login_attempt_failed")).toBe(true);
  });

  it("answers 500 for an unexpected error", async () => {
    const { handler } = setup({
      deps: {
        randomId: () => {
          throw new RangeError("no entropy");
        },
      },
    });
    const response = await handler(signIn({ username: "nobody", password: PASSWORD }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
  });
});

describe("auth-username: secrets stay put", () => {
  it("logs never contain passwords, emails, usernames, addresses or the key; answers never contain the key", async () => {
    const scenarios: Options[] = [
      {},
      { auth: () => json(500, {}) },
      { auth: () => json(400, { code: 400, error_code: "captcha_failed" }) },
      { counters: { [ADDRESS_KEY]: ADDRESS_FAILURE_LIMIT } },
      { counters: { "u:daniil": USERNAME_FAILURE_LIMIT } },
      { failRpc: (fn) => (fn === "resolve_login_email" ? "error" : undefined) },
      { failRpc: (fn, args) => (fn === "note_login_attempt" && args.p_success === true ? "throw" : undefined) },
    ];
    const entries: LogEntry[] = [];
    const answers: string[] = [];
    for (const scenario of scenarios) {
      const { handler, logs } = setup(scenario);
      for (const body of [correct, wrong, { username: "nobody", password: PASSWORD }]) {
        const response = await handler(signIn(body));
        answers.push(JSON.stringify([...response.headers]), await response.text());
      }
      entries.push(...logs);
    }
    expect(entries.length).toBeGreaterThan(5);
    const serialized = JSON.stringify(entries);
    for (const secret of [PASSWORD, "wrong password", EMAIL, "daniil", "nobody", "unknown.invalid", CLIENT_IP, SECRET_KEY]) {
      expect(serialized).not.toContain(secret);
    }
    expect(answers.join("\n")).not.toContain(SECRET_KEY);
  });
});
