// Environment of the platform's Edge Functions. Hosted Supabase injects SUPABASE_URL, the current API keys as JSON
// dictionaries keyed by name (SUPABASE_SECRET_KEYS = {"default": "sb_secret_…"}) and, while they still exist, the legacy
// SUPABASE_SERVICE_ROLE_KEY. A PLATFORM_SECRET_KEY secret wins over both (secret names may not start with SUPABASE_), so
// a dedicated or rotated key can be pinned without touching the injected defaults.
//
// Only the secret key is read: every function talks to the database, Storage and Auth as the server. The publishable
// key has no consumer here (auth-username calls Auth with the secret key so that Sb-Forwarded-For is honoured).
import { parseOrigins } from "./cors.ts";

export type EnvGetter = (name: string) => string | undefined;

export interface PlatformEnv {
  /** The project URL without a trailing slash; null when unset or not an http(s) URL. */
  supabaseUrl: string | null;
  /** Server-only key (bypasses row-level security); never leaves the function. */
  secretKey: string | null;
  /** Exact browser origins CORS admits (APP_ORIGINS, comma-separated). */
  appOrigins: readonly string[];
  /** Shared secret of the maintenance cron. */
  maintenanceSecret: string | null;
}

export function readPlatformEnv(get: EnvGetter): PlatformEnv {
  return {
    supabaseUrl: parseServiceUrl(get("SUPABASE_URL")),
    secretKey: firstValue(
      get("PLATFORM_SECRET_KEY"),
      namedKey(get("SUPABASE_SECRET_KEYS")),
      get("SUPABASE_SERVICE_ROLE_KEY"),
    ),
    appOrigins: parseOrigins(get("APP_ORIGINS")),
    maintenanceSecret: firstValue(get("MAINTENANCE_SECRET")),
  };
}

/** One entry of an injected key dictionary such as SUPABASE_SECRET_KEYS; undefined when absent or malformed. */
export function namedKey(json: string | undefined, name = "default"): string | undefined {
  if (json === undefined || json.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const key = (value as Record<string, unknown>)[name];
  return typeof key === "string" ? key : undefined;
}

function firstValue(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function parseServiceUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}
