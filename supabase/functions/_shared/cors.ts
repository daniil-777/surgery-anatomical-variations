// CORS for the browser-facing functions: an allow-list of exact origins (APP_ORIGINS), never "*". A request whose
// Origin is not on the list is refused before any work is done; callers without an Origin (curl, servers) pass, since
// CORS only ever protects browsers.
import { errorResponse } from "./http.ts";

/**
 * Request headers supabase-js sends (the list in @supabase/supabase-js/cors, 2.118.0) plus `x-region`, which
 * functions.invoke adds when a region is chosen.
 */
export const CORS_ALLOWED_HEADERS: readonly string[] = [
  "authorization",
  "x-client-info",
  "apikey",
  "content-type",
  "x-region",
  "x-retry-count",
  "traceparent",
  "tracestate",
  "baggage",
];

const PREFLIGHT_MAX_AGE_SECONDS = 600;

/** Comma-separated origins → normalised `scheme://host[:port]` values; anything else ("*", paths only, junk) is dropped. */
export function parseOrigins(value: string | undefined): string[] {
  const origins = new Set<string>();
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    try {
      const url = new URL(entry);
      if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
    } catch {
      // not a URL: ignored
    }
  }
  return [...origins];
}

export interface CorsContext {
  /** The request's Origin header, or null for non-browser callers. */
  origin: string | null;
  /** False when the request carries an Origin that is not on the allow-list. */
  allowed: boolean;
  /** Headers every response to this request carries. */
  headers: Record<string, string>;
}

export function corsContext(request: Request, allowedOrigins: readonly string[]): CorsContext {
  const origin = request.headers.get("origin");
  if (origin === null) return { origin: null, allowed: true, headers: { vary: "Origin" } };
  if (!allowedOrigins.includes(origin)) return { origin, allowed: false, headers: { vary: "Origin" } };
  return {
    origin,
    allowed: true,
    headers: {
      vary: "Origin",
      "access-control-allow-origin": origin,
      "access-control-expose-headers": "retry-after",
    },
  };
}

/** Answers an OPTIONS request: 204 with the CORS grant for an allowed origin, 403 otherwise. */
export function preflightResponse(cors: CorsContext, methods: readonly string[]): Response {
  if (cors.origin === null || !cors.allowed) return errorResponse(403, "origin_not_allowed", cors.headers);
  return new Response(null, {
    status: 204,
    headers: {
      ...cors.headers,
      "access-control-allow-methods": methods.join(", "),
      "access-control-allow-headers": CORS_ALLOWED_HEADERS.join(", "),
      "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
    },
  });
}
