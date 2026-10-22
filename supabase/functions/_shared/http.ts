// JSON responses, bounded JSON request bodies, bearer tokens and fetch time limits for the platform's Edge Functions.
// Web-standard APIs only: the same code runs in the Supabase Edge Runtime (Deno) and under Node in
// supabase/tests/functions.

/** The subset of fetch the handlers call (the global fetch satisfies it; tests pass fakes). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  // responses carry sessions and account state: no cache may keep them
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** `{ error: <code>, ...details }` — the error code is what clients branch on. */
export function errorResponse(
  status: number,
  error: string,
  headers: Record<string, string> = {},
  details: Record<string, unknown> = {},
): Response {
  return jsonResponse(status, { ...details, error }, headers);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400; error: "invalid_input" }
  | { ok: false; status: 413; error: "payload_too_large" }
  | { ok: false; status: 415; error: "unsupported_media_type" };

/**
 * Reads a JSON body of at most `maxBytes`. The media type must be application/json: browsers cannot send that
 * cross-origin without a CORS preflight, so a foreign page cannot fire requests at the functions with a plain form.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return { ok: false, status: 415, error: "unsupported_media_type" };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413, error: "payload_too_large" };
  const bytes = await readCapped(request, maxBytes);
  if (bytes === null) return { ok: false, status: 413, error: "payload_too_large" };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, status: 400, error: "invalid_input" };
  }
}

// Content-Length can be absent (chunked bodies), so the cap is enforced while reading.
async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null): string | null {
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

/** fetch with a per-request time limit; a signal the caller passes still applies. */
export function withTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchImpl(input, { ...init, signal });
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
