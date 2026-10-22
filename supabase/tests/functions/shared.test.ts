// Shared helpers of the Edge Functions (supabase/functions/_shared): environment, CORS, request bodies, client
// addresses, token claims, secrets, fetch time limits, RPC calls and logging. Runs under Node; the functions use the
// same Web APIs in Deno.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientAddress, parseAddress, parseIpv6 } from "../../functions/_shared/clientAddress.ts";
import { CORS_ALLOWED_HEADERS, corsContext, parseOrigins, preflightResponse } from "../../functions/_shared/cors.ts";
import { namedKey, parseServiceUrl, readPlatformEnv } from "../../functions/_shared/env.ts";
import { bearerToken, errorResponse, jsonResponse, readJsonBody, withTimeout } from "../../functions/_shared/http.ts";
import { decodeJwtClaims, lastSignInAt } from "../../functions/_shared/jwt.ts";
import { consoleLogger, errorName } from "../../functions/_shared/log.ts";
import { callRpc, type RpcClient, UpstreamError } from "../../functions/_shared/ports.ts";
import { secretsMatch, timingSafeEqual } from "../../functions/_shared/timingSafeEqual.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ORIGIN = "https://daniil-777.github.io";

function request(headers: Record<string, string>, init: RequestInit = {}): Request {
  return new Request("https://ref.supabase.co/functions/v1/test", { method: "POST", headers, ...init });
}

describe("parseOrigins", () => {
  it("normalises entries to origins, removes duplicates and drops anything that is not an http(s) origin", () => {
    const value =
      " https://Daniil-777.github.io/ , http://127.0.0.1:5180,https://daniil-777.github.io/surgery-anatomical-variations/," +
      " *, ftp://files.example.test, not a url,, ";
    expect(parseOrigins(value)).toEqual(["https://daniil-777.github.io", "http://127.0.0.1:5180"]);
  });

  it("is empty when the variable is unset or blank", () => {
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins("  ")).toEqual([]);
  });
});

describe("readPlatformEnv", () => {
  const injected = JSON.stringify({ default: "sb_secret_injected", billing: "sb_secret_other" });

  it("prefers PLATFORM_SECRET_KEY, then the injected SUPABASE_SECRET_KEYS default, then the legacy service key", () => {
    const pinned = readPlatformEnv((name) =>
      ({
        SUPABASE_URL: "https://ref.supabase.co/",
        PLATFORM_SECRET_KEY: " sb_secret_pinned ",
        SUPABASE_SECRET_KEYS: injected,
        SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
        APP_ORIGINS: `${ORIGIN},http://127.0.0.1:5180`,
        MAINTENANCE_SECRET: " 0123456789abcdef0123 ",
      })[name],
    );
    expect(pinned).toEqual({
      supabaseUrl: "https://ref.supabase.co",
      secretKey: "sb_secret_pinned",
      appOrigins: [ORIGIN, "http://127.0.0.1:5180"],
      maintenanceSecret: "0123456789abcdef0123",
    });

    const env = (values: Record<string, string>) => readPlatformEnv((name) => values[name]).secretKey;
    expect(env({ PLATFORM_SECRET_KEY: "  ", SUPABASE_SECRET_KEYS: injected, SUPABASE_SERVICE_ROLE_KEY: "legacy" })).toBe(
      "sb_secret_injected",
    );
    expect(env({ SUPABASE_SECRET_KEYS: "{not json", SUPABASE_SERVICE_ROLE_KEY: "legacy" })).toBe("legacy");
    expect(env({ SUPABASE_SECRET_KEYS: JSON.stringify({ billing: "sb_secret_other" }), SUPABASE_SERVICE_ROLE_KEY: "legacy" })).toBe(
      "legacy",
    );
    expect(env({ SUPABASE_URL: "http://kong:8000" })).toBeNull();
  });

  it("reads one named entry of an injected key dictionary", () => {
    expect(namedKey(injected)).toBe("sb_secret_injected");
    expect(namedKey(injected, "billing")).toBe("sb_secret_other");
    for (const value of [undefined, "", "  ", "null", "[]", '"sb_secret_x"', JSON.stringify({ default: 7 }), "{"]) {
      expect(namedKey(value), String(value)).toBeUndefined();
    }
  });

  it("reports what is missing as null", () => {
    expect(readPlatformEnv(() => undefined)).toEqual({
      supabaseUrl: null,
      secretKey: null,
      appOrigins: [],
      maintenanceSecret: null,
    });
  });

  it("accepts only http(s) project URLs", () => {
    expect(parseServiceUrl("https://ref.supabase.co///")).toBe("https://ref.supabase.co");
    expect(parseServiceUrl("https://proxy.example.test/supabase/")).toBe("https://proxy.example.test/supabase");
    expect(parseServiceUrl("ftp://ref.supabase.co")).toBeNull();
    expect(parseServiceUrl("ref.supabase.co")).toBeNull();
    expect(parseServiceUrl(undefined)).toBeNull();
  });
});

describe("CORS", () => {
  it("lets callers without an Origin through without a CORS grant", () => {
    expect(corsContext(request({}), [ORIGIN])).toEqual({ origin: null, allowed: true, headers: { vary: "Origin" } });
  });

  it("grants exactly the requesting origin when it is on the allow-list", () => {
    expect(corsContext(request({ origin: ORIGIN }), [ORIGIN])).toEqual({
      origin: ORIGIN,
      allowed: true,
      headers: {
        vary: "Origin",
        "access-control-allow-origin": ORIGIN,
        "access-control-expose-headers": "retry-after",
      },
    });
  });

  it("refuses other origins, including look-alikes and the opaque origin", () => {
    for (const origin of ["https://evil.example.test", "https://daniil-777.github.io.evil.test", "http://daniil-777.github.io", "null"]) {
      const cors = corsContext(request({ origin }), [ORIGIN]);
      expect(cors.allowed, origin).toBe(false);
      expect(cors.headers, origin).toEqual({ vary: "Origin" });
    }
  });

  it("answers a preflight from an allowed origin with methods, headers and a cache time", () => {
    const response = preflightResponse(corsContext(request({ origin: ORIGIN }), [ORIGIN]), ["POST", "OPTIONS"]);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(CORS_ALLOWED_HEADERS.join(", "));
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("refuses preflights from other origins and without an Origin", async () => {
    for (const headers of [{ origin: "https://evil.example.test" }, {}]) {
      const response = preflightResponse(corsContext(request(headers), [ORIGIN]), ["POST", "OPTIONS"]);
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    }
  });

  it("allows every header the installed supabase-js sends (its canonical CORS list)", () => {
    const require = createRequire(join(REPO_ROOT, "apps", "studio", "package.json"));
    const { corsHeaders } = require("@supabase/supabase-js/cors") as { corsHeaders: Record<string, string> };
    const sdkHeaders = (corsHeaders["Access-Control-Allow-Headers"] ?? "").split(",").map((header) => header.trim());
    expect(sdkHeaders.length).toBeGreaterThan(3);
    for (const header of sdkHeaders) expect(CORS_ALLOWED_HEADERS).toContain(header);
  });
});

describe("JSON responses", () => {
  it("are never cached or sniffed", async () => {
    const response = jsonResponse(200, { ok: true }, { vary: "Origin" });
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("put the error code last so details cannot replace it", async () => {
    const response = errorResponse(500, "storage_cleanup_failed", {}, { error: "spoofed", removed: 3 });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "storage_cleanup_failed", removed: 3 });
  });
});

describe("readJsonBody", () => {
  const json = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "application/json" }) =>
    request(headers, { body });

  it("parses a JSON body", async () => {
    expect(await readJsonBody(json('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
    const withCharset = json('{"a":"ü"}', { "content-type": "Application/JSON; charset=utf-8" });
    expect(await readJsonBody(withCharset, 100)).toEqual({ ok: true, value: { a: "ü" } });
  });

  it("requires the application/json media type (415)", async () => {
    for (const headers of [{}, { "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }]) {
      expect(await readJsonBody(json('{"a":1}', headers), 100)).toEqual({
        ok: false,
        status: 415,
        error: "unsupported_media_type",
      });
    }
  });

  it("refuses bodies above the limit, declared or streamed (413)", async () => {
    const tooLarge = { ok: false, status: 413, error: "payload_too_large" };
    expect(await readJsonBody(json(`{"a":"${"x".repeat(200)}"}`), 100)).toEqual(tooLarge);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 10; index += 1) controller.enqueue(encoder.encode('"0123456789"'));
        controller.close();
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    };
    const streamed = new Request("https://ref.supabase.co/functions/v1/test", init);
    expect(streamed.headers.get("content-length")).toBeNull();
    expect(await readJsonBody(streamed, 50)).toEqual(tooLarge);
  });

  it("refuses empty, malformed and non-UTF-8 bodies (400)", async () => {
    const invalid = { ok: false, status: 400, error: "invalid_input" };
    expect(await readJsonBody(json(null), 100)).toEqual(invalid);
    expect(await readJsonBody(json(""), 100)).toEqual(invalid);
    expect(await readJsonBody(json("{username:"), 100)).toEqual(invalid);
    expect(await readJsonBody(json(new Uint8Array([0x22, 0xff, 0xfe, 0x22])), 100)).toEqual(invalid);
  });
});

describe("bearerToken", () => {
  it("extracts the token of a Bearer header and nothing else", () => {
    expect(bearerToken("Bearer eyJhbGciOi.abc.def")).toBe("eyJhbGciOi.abc.def");
    expect(bearerToken("bearer   token-1  ")).toBe("token-1");
    for (const header of [null, "", "Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "Bearer two parts", "Token abc"]) {
      expect(bearerToken(header), String(header)).toBeNull();
    }
  });
});

describe("clientAddress", () => {
  const address = (headers: Record<string, string>) => clientAddress(new Headers(headers));

  it("prefers CF-Connecting-IP, then X-Real-IP, then the leftmost X-Forwarded-For entry", () => {
    const all = { "cf-connecting-ip": "198.51.100.1", "x-real-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3, 10.0.0.1" };
    expect(address(all)?.ip).toBe("198.51.100.1");
    expect(address({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3" })?.ip).toBe("198.51.100.2");
    // a hosted gateway's rebuilt header: the client (twice), then an internal hop on the right
    expect(address({ "x-forwarded-for": "203.0.113.7,203.0.113.7, 10.0.0.1" })?.ip).toBe("203.0.113.7");
  });

  it("skips values that are not addresses and answers null when nothing usable is left", () => {
    expect(address({ "cf-connecting-ip": "<script>", "x-forwarded-for": "203.0.113.7" })?.ip).toBe("203.0.113.7");
    expect(address({ "x-real-ip": "203.0.113.7:443", "x-forwarded-for": "unknown, 10.0.0.1" })).toBeNull();
    expect(address({})).toBeNull();
  });
});

describe("parseAddress", () => {
  it("accepts IPv4 dotted quads only", () => {
    expect(parseAddress(" 203.0.113.7 ")).toEqual({ ip: "203.0.113.7", network: "203.0.113.7" });
    expect(parseAddress("0.0.0.0")).toEqual({ ip: "0.0.0.0", network: "0.0.0.0" });
    for (const value of ["999.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.4:80", "1.2.3.-4", "", null, undefined]) {
      expect(parseAddress(value), String(value)).toBeNull();
    }
  });

  it("keeps an IPv6 caller's address for Auth and throttles its /64 network", () => {
    expect(parseAddress("2001:DB8:1:2::ABCD")).toEqual({ ip: "2001:db8:1:2::abcd", network: "2001:db8:1:2::/64" });
    expect(parseAddress("2001:db8:0001:0002:0003:0004:0005:0006")).toEqual({
      ip: "2001:db8:0001:0002:0003:0004:0005:0006",
      network: "2001:db8:1:2::/64",
    });
    expect(parseAddress("::1")).toEqual({ ip: "::1", network: "0:0:0:0::/64" });
    expect(parseAddress("64:ff9b::192.0.2.33")?.network).toBe("64:ff9b:0:0::/64");
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 address it carries", () => {
    expect(parseAddress("::ffff:198.51.100.9")).toEqual({ ip: "198.51.100.9", network: "198.51.100.9" });
    expect(parseAddress("::ffff:c633:6409")).toEqual({ ip: "198.51.100.9", network: "198.51.100.9" });
  });

  it("refuses malformed IPv6, zones, brackets, ports and oversized values", () => {
    for (const value of [
      ":::",
      "1::2::3",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7::8",
      "12345::1",
      "g::1",
      "fe80::1%eth0",
      "[2001:db8::1]",
      "1.2.3.4::",
      "::1.2.3.4:5",
      `${"1:".repeat(40)}1`,
      ":".repeat(100),
    ]) {
      expect(parseAddress(value), value).toBeNull();
    }
  });

  it("expands IPv6 into eight groups", () => {
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("JWT claims", () => {
  const encode = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const token = (payload: unknown) => `${encode({ alg: "ES256", typ: "JWT" })}.${encode(payload)}.c2ln`;

  it("decodes the payload of a compact JWT, base64url and UTF-8 included", () => {
    const claims = { sub: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", name: "Dañiil ✓", amr: [{ method: "otp", timestamp: 1 }] };
    expect(decodeJwtClaims(token(claims))).toEqual(claims);
    // a payload whose base64url form needs the "-" and "_" characters
    const awkward = { k: "?>?>?>~~~" };
    expect(encode(awkward)).toMatch(/[-_]/);
    expect(decodeJwtClaims(token(awkward))).toEqual(awkward);
  });

  it("answers null for anything that is not a JWT with an object payload", () => {
    for (const value of [
      "",
      "opaque",
      "a.b",
      "a.b.c.d",
      `${encode({})}..sig`,
      `${encode({})}.${encode("[1,2]")}.sig`,
      `${encode({})}.${encode("null")}.sig`,
      `${encode({})}.${encode("{")}.sig`,
      `${encode({})}.not+base64url.sig`,
      `${encode({})}.${Buffer.from([0x22, 0xff, 0x22]).toString("base64url")}.sig`,
    ]) {
      expect(decodeJwtClaims(value), value).toBeNull();
    }
  });

  it("takes the newest amr timestamp as the time of the last sign-in", () => {
    expect(lastSignInAt({ amr: [{ method: "password", timestamp: 100 }, { method: "otp", timestamp: 250 }, { method: "oauth", timestamp: 200 }] })).toBe(250);
    expect(lastSignInAt({ amr: [{ method: "password", timestamp: "250" }, null, 7, { method: "otp", timestamp: 90 }] })).toBe(90);
    expect(lastSignInAt({ amr: [] })).toBeNull();
    expect(lastSignInAt({ amr: "password" })).toBeNull();
    // iat is renewed by every refresh, so it never stands in for a sign-in
    expect(lastSignInAt({ iat: 1_000_000 })).toBeNull();
  });
});

describe("secrets", () => {
  it("compares bytes without stopping at the first difference", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(timingSafeEqual(bytes("same secret"), bytes("same secret"))).toBe(true);
    expect(timingSafeEqual(bytes("same secret"), bytes("same secreT"))).toBe(false);
    expect(timingSafeEqual(bytes("short"), bytes("short but longer"))).toBe(false);
    expect(timingSafeEqual(bytes(""), bytes(""))).toBe(true);
  });

  it("matches secrets through their digests", async () => {
    expect(await secretsMatch("0123456789abcdef-ü", "0123456789abcdef-ü")).toBe(true);
    expect(await secretsMatch("0123456789abcdef-u", "0123456789abcdef-ü")).toBe(false);
    expect(await secretsMatch("", "0123456789abcdef")).toBe(false);
  });
});

describe("withTimeout", () => {
  // resolves when the signal fires, like fetch does when it is aborted
  const hangingFetch = (seen: RequestInit[]) =>
    ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) seen.push(init);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as typeof fetch;

  it("aborts a request that takes longer than the limit", async () => {
    const seen: RequestInit[] = [];
    const limited = withTimeout(hangingFetch(seen), 20);
    await expect(limited("https://ref.supabase.co/rest/v1/rpc/x", { method: "POST", headers: { a: "b" } })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers).toEqual({ a: "b" });
  });

  it("keeps the caller's own abort signal working", async () => {
    const controller = new AbortController();
    const limited = withTimeout(hangingFetch([]), 60_000);
    const pending = limited("https://ref.supabase.co/x", { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });
});

describe("callRpc", () => {
  const client = (result: () => Promise<{ data: unknown; error: { message: string; status?: number } | null }>): RpcClient => ({
    rpc: () => result(),
  });

  it("returns the data of a successful call", async () => {
    await expect(callRpc(client(async () => ({ data: 7, error: null })), "login_failures")).resolves.toBe(7);
  });

  it("turns an error result into an UpstreamError named after the function", async () => {
    const failing = client(async () => ({ data: null, error: { message: "permission denied", status: 403 } }));
    const error = await callRpc(failing, "maintenance_run").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ step: "maintenance_run", status: 403, message: "permission denied" });
  });

  it("turns a thrown failure into an UpstreamError without its message", async () => {
    const throwing = client(async () => {
      throw new TypeError("fetch failed: secret-bearing detail");
    });
    const error = await callRpc(throwing, "resolve_login_email").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "UpstreamError", step: "resolve_login_email", message: "TypeError", status: null });
  });
});

describe("consoleLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one JSON line per event; the fixed keys win over fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = consoleLogger("auth-username");
    logger.info("throttled", { scope: "address", event: "spoofed" });
    logger.error("upstream_failed", { status: 502 });
    expect(info).toHaveBeenCalledWith('{"scope":"address","event":"throttled","fn":"auth-username","level":"info"}');
    expect(error).toHaveBeenCalledWith('{"status":502,"fn":"auth-username","level":"error","event":"upstream_failed"}');
  });

  it("names errors by class only", () => {
    expect(errorName(new TypeError("contains a password"))).toBe("TypeError");
    expect(errorName("text")).toBe("string");
  });
});
