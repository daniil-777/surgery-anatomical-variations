// auth-username: password sign-in with a username, which Supabase Auth does not offer (it knows emails and phone
// numbers). POST {username, password} → Auth's session JSON; the client installs it with supabase.auth.setSession().
//
// The email behind a username never leaves the server, and an unknown username cannot be told apart from a wrong
// password: both run the same steps (a password grant included, against an address that cannot exist), both are
// counted, and both answer 401 invalid_credentials after the same minimum delay.
//
// Throttle (private.login_attempts: 15-minute windows aligned to the epoch). An address with 30 failures in the window
// is refused before anything else. Then claim_login_attempt counts the attempt against the username *before* the
// password is checked, in one atomic statement (DESIGN.md §15.10), so parallel guesses cannot pass the limit together:
// an 11th attempt in the window is refused until the window ends. A successful sign-in clears the username's counter;
// an address counts failures only and keeps its counter (it may be shared). Email sign-in is unaffected.
//
// Auth is called with the secret key and Sb-Forwarded-For, so Auth's own per-address limits apply to the caller and
// not to this function's address (the project must have "IP address forwarding" on; see README.md). Auth does not
// check CAPTCHA for service-role calls, so on this path the throttle is the protection against guessing.
import { clientAddress } from "../_shared/clientAddress.ts";
import { corsContext, preflightResponse } from "../_shared/cors.ts";
import { errorResponse, type FetchLike, isRecord, jsonResponse, readJsonBody, sleep as wait } from "../_shared/http.ts";
import { errorName, type Logger, silentLogger } from "../_shared/log.ts";
import { callRpc, type RpcClient, UpstreamError } from "../_shared/ports.ts";

export const USERNAME_FAILURE_LIMIT = 10;
export const ADDRESS_FAILURE_LIMIT = 30;
/** private.login_attempts windows: date_bin('15 minutes', now(), '2000-01-01Z'), i.e. aligned to the Unix epoch. */
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_PASSWORD_LENGTH = 512;
const MAX_BODY_BYTES = 8 * 1024;
const DEFAULT_FAILURE_DELAY_MS = 800;
const DEFAULT_FAILURE_JITTER_MS = 200;
const DEFAULT_AUTH_RETRY_AFTER_SECONDS = 60;
const METHODS = ["POST", "OPTIONS"];
/** Auth's answers to a wrong email/password pair (current, legacy OAuth-style, banned account). */
const REJECTION_CODES = new Set(["invalid_credentials", "invalid_grant", "user_banned"]);

/** The rule of private.is_valid_username; reserved names are left to the lookup, which never finds them. */
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])$/;
const REPEATED_SEPARATORS = /[._-]{2}/;

export interface AuthUsernameDeps {
  /** Exact browser origins allowed by CORS. */
  appOrigins: readonly string[];
  supabaseUrl: string | null;
  /** Sent as `apikey` to Auth: Auth honours Sb-Forwarded-For only on requests made with a secret key. */
  secretKey: string | null;
  /** Service-role client for the throttle and lookup functions (granted to service_role only). */
  db: RpcClient | null;
  fetch: FetchLike;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1): jitter of the failure delay. */
  random?: () => number;
  /** Local part of the address an unknown username is checked against. */
  randomId?: () => string;
  /** Minimum time before a 401 answer, plus up to `failureJitterMs`. */
  failureDelayMs?: number;
  failureJitterMs?: number;
}

/** The fields of Auth's token response the client needs for setSession(). */
export interface UsernameSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
  user: Record<string, unknown>;
}

interface Credentials {
  username: string;
  password: string;
}

type GrantOutcome =
  | { kind: "session"; session: UsernameSession }
  | { kind: "rejected" }
  | { kind: "unconfirmed" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "failed"; status: number | null; code: string | null };

/** The canonical (lower-case) username, or null when it can never name an account. */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(username) && !REPEATED_SEPARATORS.test(username) ? username : null;
}

function parseCredentials(value: unknown): Credentials | null {
  if (!isRecord(value)) return null;
  const username = normalizeUsername(value.username);
  const { password } = value;
  if (username === null || typeof password !== "string") return null;
  if (password.length < 1 || password.length > MAX_PASSWORD_LENGTH) return null;
  return { username, password };
}

/** Seconds until the current throttle window closes (1…900). */
export function secondsUntilWindowEnds(nowMs: number): number {
  return Math.max(1, Math.ceil((THROTTLE_WINDOW_MS - (nowMs % THROTTLE_WINDOW_MS)) / 1000));
}

export function createAuthUsernameHandler(deps: AuthUsernameDeps): (request: Request) => Promise<Response> {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? wait;
  const random = deps.random ?? Math.random;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());
  const failureDelayMs = deps.failureDelayMs ?? DEFAULT_FAILURE_DELAY_MS;
  const failureJitterMs = deps.failureJitterMs ?? DEFAULT_FAILURE_JITTER_MS;

  /** One atomic claim of an attempt against `key`: refused once the window holds more than `limit` attempts. */
  async function claimAttempt(db: RpcClient, key: string, limit: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const data = await callRpc(db, "claim_login_attempt", { p_keys: [key], p_limit: limit });
    if (!isRecord(data) || typeof data.allowed !== "boolean") {
      throw new UpstreamError("claim_login_attempt", "unexpected result");
    }
    if (data.allowed) return { allowed: true, retryAfterSeconds: 0 };
    // the database's clock defines the window; ours stands in when the answer is not usable
    const seconds = data.retry_after_seconds;
    const usable = typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 1 && seconds <= THROTTLE_WINDOW_MS / 1000;
    return { allowed: false, retryAfterSeconds: usable ? seconds : secondsUntilWindowEnds(now()) };
  }

  async function loginFailures(db: RpcClient, key: string): Promise<number> {
    const data = await callRpc(db, "login_failures", { p_keys: [key] });
    const count = typeof data === "string" ? Number(data) : data;
    if (typeof count !== "number" || !Number.isFinite(count)) {
      throw new UpstreamError("login_failures", "unexpected result");
    }
    return count;
  }

  async function noteAttempt(db: RpcClient, keys: string[], success: boolean): Promise<void> {
    await callRpc(db, "note_login_attempt", { p_keys: keys, p_success: success });
  }

  async function resolveEmail(db: RpcClient, username: string): Promise<string | null> {
    const data = await callRpc(db, "resolve_login_email", { p_username: username });
    if (data === null) return null;
    if (typeof data !== "string" || data === "") throw new UpstreamError("resolve_login_email", "unexpected result");
    return data;
  }

  // Bookkeeping after the outcome is known: a failure is logged, never turned into a different answer.
  async function noteBestEffort(db: RpcClient, keys: string[], success: boolean): Promise<void> {
    try {
      await noteAttempt(db, keys, success);
    } catch (error) {
      logger.error("note_login_attempt_failed", { success, name: errorName(error) });
    }
  }

  async function delayFailure(startedAt: number): Promise<void> {
    const target = failureDelayMs + Math.floor(random() * failureJitterMs);
    const remaining = target - (now() - startedAt);
    if (remaining > 0) await sleep(remaining);
  }

  async function passwordGrant(
    supabaseUrl: string,
    secretKey: string,
    email: string,
    password: string,
    ip: string | null,
  ): Promise<GrantOutcome> {
    // the key goes in apikey only: the gateway parses an Authorization value as a JWT, and secret keys are not JWTs
    const headers: Record<string, string> = { apikey: secretKey, "content-type": "application/json" };
    if (ip !== null) headers["sb-forwarded-for"] = ip;
    let response: Response;
    try {
      response = await deps.fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password }),
      });
    } catch (error) {
      logger.error("auth_unreachable", { name: errorName(error) });
      return { kind: "failed", status: null, code: null };
    }
    const payload = await readJson(response);
    const code = authErrorCode(payload);
    if (response.status === 200) {
      const session = parseSession(payload, now());
      return session === null ? { kind: "failed", status: 200, code: "unusable_session" } : { kind: "session", session };
    }
    // Only Auth's own codes count: the gateway's 401 for a bad API key has none, and must not read as a wrong password
    if ((response.status === 400 || response.status === 401) && code !== null) {
      // Auth checks the password before it reports an unconfirmed address, so this answer needs the right password
      if (code === "email_not_confirmed") return { kind: "unconfirmed" };
      if (REJECTION_CODES.has(code)) return { kind: "rejected" };
    }
    if (response.status === 429) {
      return { kind: "rate_limited", retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) };
    }
    // anything else (captcha_failed, validation_failed, 5xx …) is a configuration or service problem, not a guess
    return { kind: "failed", status: response.status, code };
  }

  return async (request) => {
    const startedAt = now();
    const cors = corsContext(request, deps.appOrigins);
    if (request.method === "OPTIONS") return preflightResponse(cors, METHODS);
    if (!cors.allowed) return errorResponse(403, "origin_not_allowed", cors.headers);
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", { ...cors.headers, allow: METHODS.join(", ") });
    }
    const { db, supabaseUrl, secretKey } = deps;
    if (db === null || supabaseUrl === null || secretKey === null) {
      return errorResponse(503, "not_configured", cors.headers);
    }

    try {
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (!body.ok) return errorResponse(body.status, body.error, cors.headers);
      const credentials = parseCredentials(body.value);
      if (credentials === null) return errorResponse(400, "invalid_input", cors.headers);

      const address = clientAddress(request.headers);
      const usernameKey = `u:${credentials.username}`;
      const addressKey = `ip:${address?.network ?? "unknown"}`;

      if ((await loginFailures(db, addressKey)) >= ADDRESS_FAILURE_LIMIT) {
        logger.info("throttled", { scope: "address" });
        return rateLimited(cors.headers, secondsUntilWindowEnds(now()));
      }
      // claimed before the password is checked; a successful sign-in clears the username's counter again
      const claim = await claimAttempt(db, usernameKey, USERNAME_FAILURE_LIMIT);
      if (!claim.allowed) {
        logger.info("throttled", { scope: "username" });
        return rateLimited(cors.headers, claim.retryAfterSeconds);
      }

      const email = await resolveEmail(db, credentials.username);
      // an unknown username still gets a password grant, against an address under the reserved .invalid TLD
      const grantEmail = email ?? `${randomId()}@unknown.invalid`;
      const outcome = await passwordGrant(supabaseUrl, secretKey, grantEmail, credentials.password, address?.ip ?? null);

      if (email !== null && outcome.kind === "session") {
        await noteBestEffort(db, [usernameKey, addressKey], true);
        return jsonResponse(200, outcome.session, cors.headers);
      }
      if (email !== null && outcome.kind === "unconfirmed") {
        // the password was right: not a failure, and saying so tells nothing to someone without it
        await noteBestEffort(db, [usernameKey, addressKey], true);
        return errorResponse(403, "email_not_confirmed", cors.headers);
      }
      if (outcome.kind === "session" || outcome.kind === "unconfirmed" || outcome.kind === "rejected") {
        await noteBestEffort(db, [addressKey], false);
        await delayFailure(startedAt);
        return errorResponse(401, "invalid_credentials", cors.headers);
      }
      if (outcome.kind === "rate_limited") {
        logger.info("throttled", { scope: "auth" });
        return rateLimited(cors.headers, outcome.retryAfterSeconds);
      }
      logger.error("upstream_failed", { step: "auth.token", status: outcome.status, code: outcome.code });
      return errorResponse(502, "upstream", cors.headers);
    } catch (error) {
      if (error instanceof UpstreamError) {
        logger.error("upstream_failed", { step: error.step, status: error.status });
        return errorResponse(502, "upstream", cors.headers);
      }
      logger.error("internal_error", { name: errorName(error) });
      return errorResponse(500, "internal", cors.headers);
    }
  };
}

function rateLimited(headers: Record<string, string>, retryAfterSeconds: number): Response {
  return errorResponse(
    429,
    "rate_limited",
    { ...headers, "retry-after": String(retryAfterSeconds) },
    { retry_after_seconds: retryAfterSeconds },
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

function parseSession(value: unknown, nowMs: number): UsernameSession | null {
  if (!isRecord(value)) return null;
  const { access_token, refresh_token, expires_in, expires_at, token_type, user } = value;
  if (typeof access_token !== "string" || access_token === "") return null;
  if (typeof refresh_token !== "string" || refresh_token === "") return null;
  if (typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0) return null;
  if (typeof token_type !== "string" || !isRecord(user) || typeof user.id !== "string") return null;
  const expiresAt =
    typeof expires_at === "number" && Number.isFinite(expires_at) ? expires_at : Math.floor(nowMs / 1000) + expires_in;
  return { access_token, refresh_token, expires_in, expires_at: expiresAt, token_type, user };
}

/**
 * Auth's machine-readable error code: `error_code` (a numeric `code` beside it is the HTTP status), `code` on the
 * 2024-01-01 API, `error` on legacy OAuth-style answers. Only plain identifiers count, so logging it is safe.
 */
function authErrorCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const field of ["error_code", "code", "error"]) {
    const value = payload[field];
    if (typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)) return value;
  }
  return null;
}

function parseRetryAfter(header: string | null): number {
  const seconds = Number(header);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : DEFAULT_AUTH_RETRY_AFTER_SECONDS;
}
