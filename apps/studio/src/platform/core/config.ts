// platform.json: the runtime switch for accounts (DESIGN.md D3). The committed file is disabled; the Pages workflow
// writes the production copy from repository variables. The loader mirrors api.ts → loadRuntimeApiConfig: no-store,
// a 4 s timeout, a typeof-window guard for node tests. A missing, unreadable or invalid file means guest mode and is
// completely silent: no console output, no reportError, no further requests (the deploy smoke fails on any console
// error, and the dev server answers a missing file with index.html).
//
// {
//   "schema": "viscera.platform/v1",
//   "supabaseUrl": "https://<ref>.supabase.co",            null = accounts off
//   "supabaseKey": "sb_publishable_…",                     or the legacy anon key ("supabaseAnonKey" is accepted too)
//   "providers": { "password": true, "username": true, "emailCode": false,
//                  "google": false, "apple": false, "github": false, "azure": false },
//   "emailDelivery": false,
//   "siteUrl": "https://daniil-777.github.io/surgery-anatomical-variations/"
// }
// The offline UI suite uses { "schema": "viscera.platform/v1", "backend": "memory" } instead (MemoryBackend).

import type { PlatformBackend } from "./types";

export const PLATFORM_CONFIG_SCHEMA = "viscera.platform/v1";
export const PLATFORM_CONFIG_FILE = "platform.json";
export const PLATFORM_CONFIG_TIMEOUT_MS = 4000;

export interface PlatformProviders {
  password: boolean;
  username: boolean;
  /** 6-digit email codes (shown only when emailDelivery is true as well). */
  emailCode: boolean;
  google: boolean;
  apple: boolean;
  github: boolean;
  /** Microsoft (Supabase calls the provider "azure"). */
  azure: boolean;
}

export type PlatformProviderId = keyof PlatformProviders;

export const PROVIDER_IDS: readonly PlatformProviderId[] = ["password", "username", "emailCode", "google", "apple", "github", "azure"];

export const DEFAULT_PROVIDERS: Readonly<PlatformProviders> = Object.freeze({
  password: true,
  username: true,
  emailCode: false,
  google: false,
  apple: false,
  github: false,
  azure: false,
});

interface EnabledPlatformConfigBase {
  enabled: true;
  providers: PlatformProviders;
  /** True once custom SMTP delivers mail to anyone (codes, resets, confirmations). */
  emailDelivery: boolean;
  /** Where auth redirects return (…/?auth=callback, …/?auth=recovery); null = the current page. */
  siteUrl: string | null;
}

export interface SupabasePlatformConfig extends EnabledPlatformConfigBase {
  backend: "supabase";
  supabaseUrl: string;
  supabaseKey: string;
}

export interface MemoryPlatformConfig extends EnabledPlatformConfigBase {
  backend: "memory";
  /** Keep accounts and data in this browser across reloads (localStorage + IndexedDB). */
  persist: boolean;
}

export type EnabledPlatformConfig = SupabasePlatformConfig | MemoryPlatformConfig;

export type DisabledReason = "missing" | "disabled" | "invalid" | "unavailable";

export interface DisabledPlatformConfig {
  enabled: false;
  /** For diagnostics only; never logged. */
  reason: DisabledReason;
}

export type PlatformConfig = EnabledPlatformConfig | DisabledPlatformConfig;

export interface ParsePlatformConfigOptions {
  /** Accept http:// URLs on 127.0.0.1 / localhost / [::1] (default: in development builds or on a loopback page). */
  allowLoopbackHttp?: boolean;
}

const disabled = (reason: DisabledReason): DisabledPlatformConfig => ({ enabled: false, reason });

const tagOf = (value: unknown): string => Object.prototype.toString.call(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && tagOf(value) === "[object Object]";
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
}

function defaultAllowLoopbackHttp(): boolean {
  let development = false;
  try {
    development = import.meta.env.DEV === true;
  } catch {
    development = false;
  }
  if (development) return true;
  return typeof location !== "undefined" && isLoopbackHost(location.hostname);
}

/** An http(s) URL that is safe to talk to: https anywhere, http only on loopback when allowed; no credentials. */
function parseServiceUrl(value: unknown, allowLoopbackHttp: boolean): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && allowLoopbackHttp && isLoopbackHost(url.hostname)) return url;
  return null;
}

function parseProviders(value: unknown): PlatformProviders | null {
  if (value === undefined || value === null) return { ...DEFAULT_PROVIDERS };
  if (Array.isArray(value)) {
    // ["password", "username", "google"]: listed = on, everything else off
    const providers: PlatformProviders = { password: false, username: false, emailCode: false, google: false, apple: false, github: false, azure: false };
    for (const entry of value) {
      if (typeof entry !== "string") return null;
      const id = PROVIDER_IDS.find((candidate) => candidate === entry.trim());
      if (id) providers[id] = true;
    }
    return providers;
  }
  if (!isRecord(value)) return null;
  const providers: PlatformProviders = { ...DEFAULT_PROVIDERS };
  for (const id of PROVIDER_IDS) {
    const flag = value[id];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") return null;
    providers[id] = flag;
  }
  return providers;
}

/** Normalises the site URL so "?auth=…" can be appended: no query or hash, a directory path ends with "/". */
function parseSiteUrl(value: unknown, allowLoopbackHttp: boolean): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const url = parseServiceUrl(value, allowLoopbackHttp);
  if (!url) return undefined;
  url.search = "";
  url.hash = "";
  const last = url.pathname.split("/").pop() ?? "";
  if (!url.pathname.endsWith("/") && !last.includes(".")) url.pathname = `${url.pathname}/`;
  return url.href;
}

/** Validates a parsed platform.json. Anything unusable yields { enabled: false } (never throws, never logs). */
export function parsePlatformConfig(raw: unknown, options: ParsePlatformConfigOptions = {}): PlatformConfig {
  if (raw === null || raw === undefined) return disabled("missing");
  if (!isRecord(raw) || raw.schema !== PLATFORM_CONFIG_SCHEMA) return disabled("invalid");
  const allowLoopbackHttp = options.allowLoopbackHttp ?? defaultAllowLoopbackHttp();

  const providers = parseProviders(raw.providers);
  if (!providers) return disabled("invalid");
  const emailDelivery = raw.emailDelivery ?? false;
  if (typeof emailDelivery !== "boolean") return disabled("invalid");
  const siteUrl = parseSiteUrl(raw.siteUrl, allowLoopbackHttp);
  if (siteUrl === undefined) return disabled("invalid");

  const backend = raw.backend ?? "supabase";
  if (backend === "memory") {
    const persist = raw.persist ?? true;
    if (typeof persist !== "boolean") return disabled("invalid");
    return { enabled: true, backend: "memory", persist, providers, emailDelivery, siteUrl };
  }
  if (backend !== "supabase") return disabled("invalid");

  if (raw.supabaseUrl === null || raw.supabaseUrl === undefined || raw.supabaseUrl === "") return disabled("disabled");
  const url = parseServiceUrl(raw.supabaseUrl, allowLoopbackHttp);
  if (!url || url.search || url.hash) return disabled("invalid");
  const keyValue = raw.supabaseKey ?? raw.supabaseAnonKey;
  if (typeof keyValue !== "string") return disabled("invalid");
  const supabaseKey = keyValue.trim();
  // a secret key must never reach a browser (Supabase also rejects it there)
  if (supabaseKey.length === 0 || /\s/.test(supabaseKey) || supabaseKey.startsWith("sb_secret_")) return disabled("invalid");
  const supabaseUrl = url.href.replace(/\/+$/, "");
  return { enabled: true, backend: "supabase", supabaseUrl, supabaseKey, providers, emailDelivery, siteUrl };
}

// loading ------------------------------------------------------------------------------------------------------------

export interface LoadPlatformConfigOptions extends ParsePlatformConfigOptions {
  /** Defaults to platform.json next to the page (import.meta.env.BASE_URL), or VITE_PLATFORM_CONFIG. */
  url?: string;
  /** Defaults to the global fetch in a browser; outside a browser nothing is fetched unless one is given. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

let override: PlatformConfig | null = null;
let shared: Promise<PlatformConfig> | null = null;
let latest: PlatformConfig | null = null;
const listeners = new Set<(config: PlatformConfig) => void>();

function publish(config: PlatformConfig): PlatformConfig {
  latest = config;
  for (const listener of [...listeners]) {
    try {
      listener(config);
    } catch {
      // a broken listener must not break configuration loading
    }
  }
  return config;
}

/** The URL platform.json is read from. */
export function platformConfigUrl(): string {
  let base = "/";
  let file = PLATFORM_CONFIG_FILE;
  try {
    base = typeof import.meta.env.BASE_URL === "string" ? import.meta.env.BASE_URL : "/";
    const custom: unknown = import.meta.env.VITE_PLATFORM_CONFIG;
    if (typeof custom === "string" && /^[A-Za-z0-9._/-]+\.json$/.test(custom) && !custom.includes("..")) file = custom.replace(/^\/+/, "");
  } catch {
    base = "/";
  }
  return `${base}${file}`;
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function fetchPlatformConfig(options: LoadPlatformConfigOptions): Promise<PlatformConfig> {
  const fetchImpl =
    options.fetch ?? (typeof window !== "undefined" && typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  if (!fetchImpl) return disabled("unavailable");
  try {
    const response = await fetchImpl(options.url ?? platformConfigUrl(), {
      cache: "no-store",
      signal: timeoutSignal(options.timeoutMs ?? PLATFORM_CONFIG_TIMEOUT_MS),
    });
    if (!response.ok) return disabled("missing");
    const body = await response.text();
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return disabled("invalid");
    }
    const parseOptions: ParsePlatformConfigOptions = {};
    if (options.allowLoopbackHttp !== undefined) parseOptions.allowLoopbackHttp = options.allowLoopbackHttp;
    return parsePlatformConfig(raw, parseOptions);
  } catch {
    return disabled("unavailable");
  }
}

/**
 * Reads platform.json once per page (later calls share the first answer) unless a test override is set or custom
 * options are passed. Never rejects.
 */
export function loadPlatformConfig(options: LoadPlatformConfigOptions = {}): Promise<PlatformConfig> {
  if (override) return Promise.resolve(override);
  const custom = Object.keys(options).length > 0;
  if (!custom && shared) return shared;
  const pending = fetchPlatformConfig(options).then(publish);
  if (!custom) shared = pending;
  return pending;
}

/**
 * Test and e2e override: a parsed config, a raw platform.json object (validated here), or null to go back to the
 * file. Also forgets the cached answer.
 */
export function configurePlatform(config: PlatformConfig | Record<string, unknown> | null, options: ParsePlatformConfigOptions = {}): void {
  shared = null;
  if (config === null) {
    override = null;
    latest = null;
    return;
  }
  const parsed = "enabled" in config && typeof config.enabled === "boolean" ? (config as PlatformConfig) : parsePlatformConfig(config, options);
  override = parsed;
  publish(parsed);
}

/** The last loaded or overridden config (null before the first load). */
export function currentPlatformConfig(): PlatformConfig | null {
  return override ?? latest;
}

/** Called with every config loaded or overridden from now on. */
export function onPlatformConfig(listener: (config: PlatformConfig) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The redirect target for auth flows: the configured site URL, else the current page without query and hash. */
export function authRedirectUrl(config: EnabledPlatformConfig, purpose: "callback" | "recovery"): string {
  let base = config.siteUrl;
  if (!base && typeof location !== "undefined") base = `${location.origin}${location.pathname}`;
  const url = new URL(base ?? "http://localhost/");
  url.search = "";
  url.hash = "";
  url.searchParams.set("auth", purpose);
  return url.href;
}

/**
 * The backend an enabled config names. Both backends are loaded with import(), so supabase-js (and the memory twin)
 * land in their own chunks and pages that never sign in do not download them.
 */
export async function createPlatformBackend(config: EnabledPlatformConfig): Promise<PlatformBackend> {
  if (config.backend === "memory") {
    const { MemoryBackend } = await import("./memory/memoryBackend");
    return MemoryBackend.fromConfig(config);
  }
  const { SupabaseBackend } = await import("./supabase/supabaseBackend");
  return new SupabaseBackend(config);
}
