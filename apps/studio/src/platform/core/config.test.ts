import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authRedirectUrl,
  configurePlatform,
  createPlatformBackend,
  currentPlatformConfig,
  DEFAULT_PROVIDERS,
  isLoopbackHost,
  loadPlatformConfig,
  onPlatformConfig,
  parsePlatformConfig,
  PLATFORM_CONFIG_SCHEMA,
  platformConfigUrl,
  type EnabledPlatformConfig,
} from "./config";

const PRODUCTION = {
  schema: PLATFORM_CONFIG_SCHEMA,
  supabaseUrl: "https://abcdefghijklmnop.supabase.co/",
  supabaseKey: "sb_publishable_abc123",
  providers: { password: true, username: true, emailCode: false, google: true, apple: false, github: false, azure: false },
  emailDelivery: false,
  siteUrl: "https://daniil-777.github.io/surgery-anatomical-variations/",
};

function enabled(config: ReturnType<typeof parsePlatformConfig>): EnabledPlatformConfig {
  if (!config.enabled) throw new Error(`expected an enabled config, got ${config.reason}`);
  return config;
}

describe("parsePlatformConfig", () => {
  it("accepts the production shape", () => {
    const config = enabled(parsePlatformConfig(PRODUCTION, { allowLoopbackHttp: false }));
    expect(config).toEqual({
      enabled: true,
      backend: "supabase",
      supabaseUrl: "https://abcdefghijklmnop.supabase.co",
      supabaseKey: "sb_publishable_abc123",
      providers: PRODUCTION.providers,
      emailDelivery: false,
      siteUrl: "https://daniil-777.github.io/surgery-anatomical-variations/",
    });
  });

  it("is disabled for the committed default, missing files and other schemas", () => {
    expect(parsePlatformConfig({ ...PRODUCTION, supabaseUrl: null })).toEqual({ enabled: false, reason: "disabled" });
    expect(parsePlatformConfig(null)).toEqual({ enabled: false, reason: "missing" });
    expect(parsePlatformConfig(undefined)).toEqual({ enabled: false, reason: "missing" });
    expect(parsePlatformConfig({ ...PRODUCTION, schema: "viscera.platform/v2" })).toEqual({ enabled: false, reason: "invalid" });
    expect(parsePlatformConfig("<!doctype html>")).toEqual({ enabled: false, reason: "invalid" });
    expect(parsePlatformConfig([PRODUCTION])).toEqual({ enabled: false, reason: "invalid" });
  });

  it("accepts the legacy anon key under either name and refuses secret keys", () => {
    const { supabaseKey: _key, ...withoutKey } = PRODUCTION;
    expect(enabled(parsePlatformConfig({ ...withoutKey, supabaseAnonKey: "eyJhbGciOiJIUzI1NiJ9.e30.sig" })).backend).toBe("supabase");
    expect(parsePlatformConfig(withoutKey).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, supabaseKey: "   " }).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, supabaseKey: "sb_secret_abc" }).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, supabaseKey: 42 }).enabled).toBe(false);
  });

  it("requires https, allowing http only on loopback hosts when asked", () => {
    const local = { ...PRODUCTION, supabaseUrl: "http://127.0.0.1:54321", siteUrl: "http://localhost:5180/" };
    expect(parsePlatformConfig(local, { allowLoopbackHttp: false }).enabled).toBe(false);
    expect(enabled(parsePlatformConfig(local, { allowLoopbackHttp: true }))).toMatchObject({ backend: "supabase", supabaseUrl: "http://127.0.0.1:54321" });
    expect(parsePlatformConfig({ ...PRODUCTION, supabaseUrl: "http://example.com" }, { allowLoopbackHttp: true }).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, supabaseUrl: "ftp://example.com" }).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, supabaseUrl: "https://user:pw@example.com" }).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, supabaseUrl: "https://example.com/?x=1" }).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, supabaseUrl: "not a url" }).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, siteUrl: "javascript:alert(1)" }).enabled).toBe(false);
  });

  it("validates provider flags and fills defaults", () => {
    const { providers: _providers, ...withoutProviders } = PRODUCTION;
    expect(enabled(parsePlatformConfig(withoutProviders)).providers).toEqual(DEFAULT_PROVIDERS);
    expect(enabled(parsePlatformConfig({ ...PRODUCTION, providers: { apple: true } })).providers).toEqual({ ...DEFAULT_PROVIDERS, apple: true });
    expect(parsePlatformConfig({ ...PRODUCTION, providers: { google: "yes" } }).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, providers: "password" }).enabled).toBe(false);
    expect(enabled(parsePlatformConfig({ ...PRODUCTION, providers: ["password", "github", "unknown"] })).providers).toEqual({
      password: true,
      username: false,
      emailCode: false,
      google: false,
      apple: false,
      github: true,
      azure: false,
    });
    expect(parsePlatformConfig({ ...PRODUCTION, providers: ["password", 3] }).enabled).toBe(false);
    expect(parsePlatformConfig({ ...PRODUCTION, emailDelivery: "true" }).enabled).toBe(false);
  });

  it("normalises the site URL so ?auth=… can be appended", () => {
    expect(enabled(parsePlatformConfig({ ...PRODUCTION, siteUrl: "https://x.github.io/repo" })).siteUrl).toBe("https://x.github.io/repo/");
    expect(enabled(parsePlatformConfig({ ...PRODUCTION, siteUrl: "https://x.github.io/repo/index.html?a=1#b" })).siteUrl).toBe(
      "https://x.github.io/repo/index.html",
    );
    expect(enabled(parsePlatformConfig({ ...PRODUCTION, siteUrl: null })).siteUrl).toBeNull();
  });

  it("selects the memory backend for the offline UI suite", () => {
    expect(parsePlatformConfig({ schema: PLATFORM_CONFIG_SCHEMA, backend: "memory" })).toEqual({
      enabled: true,
      backend: "memory",
      persist: true,
      providers: DEFAULT_PROVIDERS,
      emailDelivery: false,
      siteUrl: null,
    });
    expect(enabled(parsePlatformConfig({ schema: PLATFORM_CONFIG_SCHEMA, backend: "memory", persist: false, emailDelivery: true }))).toMatchObject({
      persist: false,
      emailDelivery: true,
    });
    expect(parsePlatformConfig({ schema: PLATFORM_CONFIG_SCHEMA, backend: "firebase" }).enabled).toBe(false);
    expect(parsePlatformConfig({ schema: PLATFORM_CONFIG_SCHEMA, backend: "memory", persist: 1 }).enabled).toBe(false);
  });

  it("builds auth redirect URLs on the site URL", () => {
    const config = enabled(parsePlatformConfig(PRODUCTION));
    expect(authRedirectUrl(config, "callback")).toBe("https://daniil-777.github.io/surgery-anatomical-variations/?auth=callback");
    expect(authRedirectUrl(config, "recovery")).toBe("https://daniil-777.github.io/surgery-anatomical-variations/?auth=recovery");
  });

  it("recognises loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("app.localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1.example.com")).toBe(false);
  });
});

describe("loadPlatformConfig", () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    configurePlatform(null);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) consoleSpies.push(vi.spyOn(console, method));
  });

  afterEach(() => {
    // a disabled or broken configuration must never produce console output (the deploy smoke fails on errors)
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    consoleSpies.length = 0;
    configurePlatform(null);
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("fetches platform.json with no-store and a timeout signal", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(PRODUCTION));
    const config = await loadPlatformConfig({ fetch, url: "/platform.json", allowLoopbackHttp: false });
    expect(config.enabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/platform.json");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("is silently disabled for 404, HTML (the dev server's fallback), bad JSON and failed fetches", async () => {
    expect(await loadPlatformConfig({ fetch: async () => jsonResponse("", 404) })).toEqual({ enabled: false, reason: "missing" });
    expect(await loadPlatformConfig({ fetch: async () => new Response("<!doctype html><html></html>", { status: 200 }) })).toEqual({
      enabled: false,
      reason: "invalid",
    });
    expect(await loadPlatformConfig({ fetch: async () => jsonResponse({ schema: "other" }) })).toEqual({ enabled: false, reason: "invalid" });
    expect(
      await loadPlatformConfig({
        fetch: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    ).toEqual({ enabled: false, reason: "unavailable" });
  });

  it("gives up after the timeout", async () => {
    const fetch = (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
      });
    const started = Date.now();
    expect(await loadPlatformConfig({ fetch, timeoutMs: 30 })).toEqual({ enabled: false, reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not fetch outside a browser unless a fetch is given", async () => {
    const global = vi.spyOn(globalThis, "fetch");
    expect(await loadPlatformConfig()).toEqual({ enabled: false, reason: "unavailable" });
    expect(global).not.toHaveBeenCalled();
    global.mockRestore();
  });

  it("shares one load per page and notifies listeners", async () => {
    const seen: boolean[] = [];
    const stop = onPlatformConfig((config) => seen.push(config.enabled));
    const first = loadPlatformConfig();
    expect(loadPlatformConfig()).toBe(first);
    await first;
    expect(seen).toEqual([false]);
    stop();
  });

  it("honours a test override (parsed or raw) until it is cleared", async () => {
    configurePlatform({ schema: PLATFORM_CONFIG_SCHEMA, backend: "memory", persist: false });
    const fetch = vi.fn(async () => jsonResponse(PRODUCTION));
    const config = await loadPlatformConfig({ fetch });
    expect(config).toMatchObject({ enabled: true, backend: "memory", persist: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(currentPlatformConfig()).toEqual(config);
    configurePlatform({ enabled: false, reason: "disabled" });
    expect(await loadPlatformConfig()).toEqual({ enabled: false, reason: "disabled" });
    configurePlatform(null);
    expect(currentPlatformConfig()).toBeNull();
  });

  it("reads the file next to the page", () => {
    expect(platformConfigUrl()).toMatch(/platform\.json$/);
  });

  it("is silently disabled by the committed platform.json (no project URL, a note for operators)", async () => {
    const committed: unknown = JSON.parse(readFileSync(new URL("../../../public/platform.json", import.meta.url), "utf8"));
    expect(committed).toMatchObject({ schema: PLATFORM_CONFIG_SCHEMA, supabaseUrl: null });
    expect(parsePlatformConfig(committed)).toEqual({ enabled: false, reason: "disabled" });
    expect(await loadPlatformConfig({ fetch: async () => jsonResponse(committed) })).toEqual({ enabled: false, reason: "disabled" });
  });

  it("runs the in-memory backend the offline and browser suites serve as platform.json", async () => {
    const providers = { password: true, username: true, emailCode: true, google: true, apple: true, github: false, azure: false };
    const served = { schema: PLATFORM_CONFIG_SCHEMA, backend: "memory", persist: false, providers, emailDelivery: true };
    const config = enabled(await loadPlatformConfig({ fetch: async () => jsonResponse(served) }));
    expect(config).toEqual({ enabled: true, backend: "memory", persist: false, providers, emailDelivery: true, siteUrl: null });
    const backend = await createPlatformBackend(config);
    expect(backend.kind).toBe("memory");
    // the providers and mail delivery reach the backend
    await expect(backend.auth.signInWithOAuth("github")).rejects.toMatchObject({ code: "provider_disabled" });
    await backend.auth.signInWithOAuth("apple");
    expect(backend.auth.current()?.user.providers).toEqual(["apple"]);
    await backend.auth.signOut();
    await backend.auth.sendEmailCode("code@example.test", { createUser: true });
    await backend.auth.sendPasswordReset("code@example.test");
  });
});

describe("createPlatformBackend", () => {
  it("loads the backend the config names, without a request while signed out", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const memoryConfig = enabled(parsePlatformConfig({ schema: PLATFORM_CONFIG_SCHEMA, backend: "memory", persist: false }));
    const memory = await createPlatformBackend(memoryConfig);
    expect(memory.kind).toBe("memory");
    const supabase = await createPlatformBackend(enabled(parsePlatformConfig(PRODUCTION, { allowLoopbackHttp: false })));
    expect(supabase.kind).toBe("supabase");
    expect(await supabase.auth.ready()).toBeNull();
    expect(await supabase.projects.list().catch((error: unknown) => (error as { code?: string }).code)).toBe("not_authenticated");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
    await (supabase as unknown as { client: { auth: { stopAutoRefresh(): Promise<void> } } }).client.auth.stopAutoRefresh();
  });
});
