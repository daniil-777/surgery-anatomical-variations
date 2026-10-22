// One error vocabulary for the whole platform. PostgREST, Storage, GoTrue (Auth), Edge Function and plain fetch/abort
// failures all become a PlatformError with a code from types.ts, so the UI and the versioning engine branch on one set
// of codes. Errors are recognised by shape and name, never by instanceof: supabase-js classes are not imported here
// (this module stays dependency-free) and lab code may hand us errors from another realm.
//
// Database rules raise MESSAGE = <platform code>, SQLSTATE = PT<http status> (supabase/migrations …_foundation.sql), so
// PostgREST answers { code: "PT409", message: "version_conflict", details: "{…}" } with HTTP 409.

import { isPlatformError, PlatformError, type PlatformErrorCode } from "./types";

export const PLATFORM_ERROR_CODES: readonly PlatformErrorCode[] = [
  "not_authenticated",
  "not_found",
  "invalid_input",
  "quota_exceeded",
  "file_too_large",
  "version_conflict",
  "draft_conflict",
  "asset_not_ready",
  "asset_busy",
  "upload_missing",
  "size_mismatch",
  "limit_reached",
  "project_trashed",
  "invalid_credentials",
  "email_not_confirmed",
  "user_exists",
  "weak_password",
  "rate_limited",
  "provider_disabled",
  "accounts_disabled",
  "network",
  "aborted",
  "unknown",
];

const CODES = new Set<string>(PLATFORM_ERROR_CODES);

export function isPlatformErrorCode(value: unknown): value is PlatformErrorCode {
  return typeof value === "string" && CODES.has(value);
}

const MESSAGES: Record<PlatformErrorCode, string> = {
  not_authenticated: "Sign in to continue.",
  not_found: "This item could not be found.",
  invalid_input: "Some of the information is not valid.",
  quota_exceeded: "Your storage is full.",
  file_too_large: "This file is larger than your plan allows.",
  version_conflict: "This project was changed in another window or on another device.",
  draft_conflict: "This project was changed in another window or on another device.",
  asset_not_ready: "A file has not finished uploading.",
  asset_busy: "An earlier copy of this file is still being cleared from your storage. Try again in a moment.",
  upload_missing: "A file did not finish uploading.",
  size_mismatch: "A file changed while it was uploading.",
  limit_reached: "You have reached the limit of your plan.",
  project_trashed: "This project is in the Trash.",
  invalid_credentials: "Those sign-in details are not correct.",
  email_not_confirmed: "Confirm your email address first.",
  user_exists: "An account with these details already exists.",
  weak_password: "Choose a longer password.",
  rate_limited: "Too many attempts. Try again in a few minutes.",
  provider_disabled: "This way of signing in is not available.",
  accounts_disabled: "Accounts are not available on this site.",
  network: "The server could not be reached.",
  aborted: "Cancelled.",
  unknown: "Something went wrong.",
};

export function defaultMessage(code: PlatformErrorCode): string {
  return MESSAGES[code];
}

export interface PlatformErrorInit {
  status?: number | null;
  detail?: string | null;
  cause?: unknown;
  message?: string;
}

/** A PlatformError with the standard message for its code. */
export function platformError(code: PlatformErrorCode, init: PlatformErrorInit = {}): PlatformError {
  const options: { status?: number | null; detail?: string | null; cause?: unknown } = {
    status: init.status ?? null,
    detail: init.detail ?? null,
  };
  if (init.cause !== undefined) options.cause = init.cause;
  return new PlatformError(code, init.message ?? MESSAGES[code], options);
}

/** The code an HTTP status means when the body names nothing more specific. */
export function codeForStatus(status: number | null | undefined): PlatformErrorCode {
  if (status === null || status === undefined || status === 0) return "network";
  switch (status) {
    case 400:
    case 422:
      return "invalid_input";
    case 401:
      return "not_authenticated";
    case 404:
    case 406:
    case 410:
      return "not_found";
    case 408:
      return "network";
    case 413:
      return "file_too_large";
    case 429:
      return "rate_limited";
    case 502:
    case 503:
    case 504:
      return "network";
    default:
      return "unknown";
  }
}

// helpers ------------------------------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function asRecord(value: unknown): Loose | null {
  return value !== null && typeof value === "object" ? (value as Loose) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return null;
}

function nameOf(error: unknown): string {
  const record = asRecord(error);
  return record && typeof record.name === "string" ? record.name : "";
}

function messageOf(error: unknown): string {
  const record = asRecord(error);
  return record && typeof record.message === "string" ? record.message : "";
}

// abort & network ----------------------------------------------------------------------------------------------------

/** True for user/caller cancellation (AbortController), not for timeouts. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof PlatformError) return error.code === "aborted";
  const record = asRecord(error);
  if (!record) return false;
  if (record.name === "AbortError" || record.code === "ABORT_ERR") return true;
  return record.name === "PlatformError" && record.code === "aborted";
}

export function abortError(cause?: unknown): PlatformError {
  return platformError("aborted", cause === undefined ? {} : { cause });
}

/** Throws a PlatformError("aborted") when the signal has fired (timeouts become "network"). */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (nameOf(reason) === "TimeoutError") throw platformError("network", { detail: "timeout", cause: reason });
  throw abortError(reason);
}

function isNetworkFailure(error: unknown): boolean {
  const name = nameOf(error);
  if (name === "TimeoutError" || name === "NetworkError") return true;
  if (name !== "TypeError") return false;
  return /fetch|network|load failed|connection|socket/i.test(messageOf(error));
}

// PostgREST ----------------------------------------------------------------------------------------------------------

export interface PostgrestErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

function isPostgrestErrorLike(error: unknown): error is PostgrestErrorLike {
  const record = asRecord(error);
  if (!record || typeof record.message !== "string") return false;
  return "code" in record && ("details" in record || "hint" in record);
}

const PT_STATUS = /^PT(\d{3})$/;

/** PostgREST error body (or supabase-js PostgrestError) → PlatformError. httpStatus is the response status, if known. */
export function fromPostgrestError(error: PostgrestErrorLike, httpStatus?: number | null): PlatformError {
  const code = error.code ?? "";
  const message = error.message ?? "";
  const detail = text(error.details) ?? text(error.hint);
  const pt = PT_STATUS.exec(code);
  if (pt) {
    const status = Number(pt[1]);
    if (isPlatformErrorCode(message)) return platformError(message, { status, detail });
    // a code this client does not know yet: keep it at the front of the detail
    const serverCode = /^[a-z][a-z0-9_]*$/.test(message) ? message : null;
    return platformError(codeForStatus(status), { status, detail: serverCode ? (detail ? `${serverCode}: ${detail}` : serverCode) : detail });
  }
  switch (code) {
    case "PGRST301":
    case "PGRST302":
    case "PGRST303":
      return platformError("not_authenticated", { status: 401, detail: message || detail });
    case "PGRST116":
      return platformError("not_found", { status: 404, detail: message || detail });
    case "23505":
      return platformError("invalid_input", { status: 409, detail: detail ?? message });
    case "23502":
    case "23503":
    case "23514":
    case "22001":
    case "22003":
    case "22007":
    case "22008":
    case "22023":
    case "22P02":
    case "P0001":
      return platformError("invalid_input", { status: httpStatus ?? 400, detail: detail ?? message });
    case "42501":
      return httpStatus === 401
        ? platformError("not_authenticated", { status: 401, detail: message })
        : platformError("unknown", { status: httpStatus ?? 403, detail: message || "permission denied" });
    default:
      break;
  }
  if (code === "" && (httpStatus === 0 || httpStatus === undefined || httpStatus === null)) {
    // supabase-js reports a failed fetch as { code: "", message: "<Name>: <message>" } with status 0
    if (/^AbortError\b/.test(message)) return abortError(error);
    if (/^TimeoutError\b/.test(message)) return platformError("network", { detail: "timeout", cause: error });
    return platformError("network", { status: 0, detail: message || null, cause: error });
  }
  return platformError(codeForStatus(httpStatus), { status: httpStatus ?? null, detail: message || detail });
}

// Storage ------------------------------------------------------------------------------------------------------------

function storageStatus(record: Loose): number | null {
  // Storage often answers HTTP 400 with the real status in the body: { statusCode: "409", error: "Duplicate", … }
  return numeric(record.statusCode) ?? numeric(record.status);
}

function storageText(record: Loose): string {
  return [record.error, record.code, record.message].filter((part) => typeof part === "string").join(" ").toLowerCase();
}

/** True when Storage refused an upload because the object already exists (409 / "Duplicate"). */
export function isStorageDuplicate(error: unknown): boolean {
  if (error instanceof PlatformError) return error.status === 409 && error.detail === "duplicate";
  const record = asRecord(error);
  if (!record) return false;
  return storageStatus(record) === 409 || /already exists|duplicate/.test(storageText(record));
}

/** Storage API error (StorageApiError / StorageUnknownError or a raw { statusCode, error, message } body). */
export function fromStorageError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  const record = asRecord(error);
  if (!record) return platformError("unknown", { cause: error });
  if (record.name === "StorageUnknownError" || (record.status === undefined && record.statusCode === undefined && "originalError" in record)) {
    const original = record.originalError;
    if (isAbortError(original)) return abortError(original);
    return platformError("network", { status: 0, detail: messageOf(original) || messageOf(error) || null, cause: error });
  }
  const status = storageStatus(record);
  const words = storageText(record);
  const detail = typeof record.message === "string" ? record.message : null;
  if (status === 413 || /payload too large|maximum allowed size|entitytoolarge|too large/.test(words)) {
    return platformError("file_too_large", { status: 413, detail, cause: error });
  }
  if (isStorageDuplicate(record)) return platformError("unknown", { status: 409, detail: "duplicate", cause: error });
  if (/jwt|invalid compact jws|exp claim|token.*expired/.test(words)) {
    return platformError("not_authenticated", { status: 401, detail, cause: error });
  }
  if (status === 401) return platformError("not_authenticated", { status: 401, detail, cause: error });
  if (status === 403 || /row-level security|unauthorized|access denied|accessdenied/.test(words)) {
    return platformError("unknown", { status: 403, detail: detail ?? "access denied", cause: error });
  }
  if (status === 404 || /not found|nosuchkey|no such key|nosuchbucket/.test(words)) {
    return platformError("not_found", { status: 404, detail, cause: error });
  }
  if (status === 415 || /mime type|invalid_mime|invalidmimetype|content type/.test(words)) {
    return platformError("invalid_input", { status: 415, detail, cause: error });
  }
  return platformError(codeForStatus(status ?? 0), { status, detail, cause: error });
}

/** reserve_asset's 409 asset_busy: the same bytes are being collected right now; put() again shortly (DESIGN.md §15.3). */
export function isAssetBusy(error: unknown): boolean {
  return isPlatformError(error, "asset_busy");
}

/** A raw HTTP failure (TUS, direct uploads, downloads): status plus the response body text, if any. */
export function fromHttpFailure(status: number, body: string | null): PlatformError {
  if (body) {
    try {
      const parsed: unknown = JSON.parse(body);
      const record = asRecord(parsed);
      if (record && ("statusCode" in record || "error" in record || "message" in record)) {
        return fromStorageError({ status, ...record });
      }
    } catch {
      // plain text bodies are common on the TUS endpoint
    }
    return fromStorageError({ status, statusCode: String(status), message: body.slice(0, 500) });
  }
  return platformError(codeForStatus(status), { status });
}

// Auth (GoTrue) ------------------------------------------------------------------------------------------------------

const AUTH_CODES: Record<string, PlatformErrorCode> = {
  invalid_credentials: "invalid_credentials",
  email_not_confirmed: "email_not_confirmed",
  phone_not_confirmed: "email_not_confirmed",
  user_already_exists: "user_exists",
  email_exists: "user_exists",
  phone_exists: "user_exists",
  identity_already_exists: "user_exists",
  weak_password: "weak_password",
  over_request_rate_limit: "rate_limited",
  over_email_send_rate_limit: "rate_limited",
  over_sms_send_rate_limit: "rate_limited",
  provider_disabled: "provider_disabled",
  email_provider_disabled: "provider_disabled",
  phone_provider_disabled: "provider_disabled",
  oauth_provider_not_supported: "provider_disabled",
  signup_disabled: "provider_disabled",
  manual_linking_disabled: "provider_disabled",
  anonymous_provider_disabled: "provider_disabled",
  otp_disabled: "provider_disabled",
  email_address_not_authorized: "provider_disabled",
  otp_expired: "invalid_credentials",
  bad_code_verifier: "invalid_credentials",
  flow_state_not_found: "invalid_credentials",
  flow_state_expired: "invalid_credentials",
  bad_oauth_state: "invalid_credentials",
  bad_oauth_callback: "invalid_credentials",
  user_banned: "invalid_credentials",
  reauthentication_not_valid: "invalid_credentials",
  user_not_found: "not_found",
  identity_not_found: "not_found",
  session_not_found: "not_authenticated",
  session_expired: "not_authenticated",
  refresh_token_not_found: "not_authenticated",
  refresh_token_already_used: "not_authenticated",
  bad_jwt: "not_authenticated",
  no_authorization: "not_authenticated",
  reauthentication_needed: "not_authenticated",
  insufficient_aal: "not_authenticated",
  validation_failed: "invalid_input",
  bad_json: "invalid_input",
  email_address_invalid: "invalid_input",
  same_password: "invalid_input",
  captcha_failed: "invalid_input",
  single_identity_not_deletable: "invalid_input",
  email_conflict_identity_not_deletable: "invalid_input",
  request_timeout: "network",
  hook_timeout: "network",
  hook_timeout_after_retry: "network",
};

const AUTH_NAMES: Record<string, PlatformErrorCode> = {
  AuthRetryableFetchError: "network",
  AuthSessionMissingError: "not_authenticated",
  AuthInvalidJwtError: "not_authenticated",
  AuthWeakPasswordError: "weak_password",
  AuthInvalidCredentialsError: "invalid_input",
  AuthPKCECodeVerifierMissingError: "invalid_credentials",
  AuthPKCEGrantCodeExchangeError: "invalid_credentials",
  AuthImplicitGrantRedirectError: "invalid_credentials",
};

const AUTH_MESSAGES: Array<[RegExp, PlatformErrorCode]> = [
  [/invalid login credentials|invalid credentials/i, "invalid_credentials"],
  [/email not confirmed/i, "email_not_confirmed"],
  [/user already registered|already been registered/i, "user_exists"],
  [/password should|weak password|password is too/i, "weak_password"],
  [/rate limit|too many requests/i, "rate_limited"],
  [/token has expired or is invalid/i, "invalid_credentials"],
  [/provider is not enabled|unsupported provider/i, "provider_disabled"],
];

function isAuthErrorLike(record: Loose): boolean {
  return record.__isAuthError === true || /^Auth[A-Z]/.test(nameOf(record));
}

/** GoTrue / supabase-js AuthError → PlatformError. */
export function fromAuthError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  const record = asRecord(error);
  if (!record) return platformError("unknown", { cause: error });
  const name = nameOf(record);
  const message = messageOf(record);
  const status = typeof record.status === "number" ? record.status : null;
  const authCode = typeof record.code === "string" ? record.code : null;

  if (name === "AuthUnknownError") {
    const original = record.originalError;
    if (isAbortError(original)) return abortError(original);
    if (isNetworkFailure(original)) return platformError("network", { status: 0, cause: error });
    return platformError("unknown", { status, detail: message || null, cause: error });
  }
  if (name === "AuthRetryableFetchError" && status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return platformError(codeForStatus(status), { status, detail: message || null, cause: error });
  }
  if (name === "AuthWeakPasswordError") {
    const reasons = Array.isArray(record.reasons) ? record.reasons.filter((r) => typeof r === "string").join(",") : "";
    return platformError("weak_password", { status: status ?? 422, detail: reasons || message || null, cause: error });
  }
  if (authCode === "otp_disabled" && /signups? not allowed/i.test(message)) {
    // shouldCreateUser: false and no account with this email
    return platformError("invalid_credentials", { status: status ?? 422, detail: "no_account", cause: error });
  }
  const redirectDetails = asRecord(record.details);
  const redirectCode = redirectDetails && typeof redirectDetails.code === "string" ? redirectDetails.code : null;
  const mapped =
    (authCode !== null ? AUTH_CODES[authCode] : undefined) ??
    (redirectCode !== null ? AUTH_CODES[redirectCode] : undefined) ??
    AUTH_NAMES[name] ??
    AUTH_MESSAGES.find(([pattern]) => pattern.test(message))?.[1];
  if (mapped) return platformError(mapped, { status, detail: authCode ?? (message || null), cause: error });
  if (status === 429) return platformError("rate_limited", { status, detail: authCode, cause: error });
  return platformError(status === null ? "unknown" : codeForStatus(status), {
    status,
    detail: authCode ?? (message || null),
    cause: error,
  });
}

// Edge Functions -----------------------------------------------------------------------------------------------------

/**
 * Error body of a platform Edge Function → PlatformError. Accepted shapes: { code, message?, detail? },
 * { error: "<code>" }, { error: { code, message } }, { error_code } — the code may be a platform code or a GoTrue code.
 */
export function fromFunctionBody(status: number, body: unknown): PlatformError {
  const record = asRecord(body);
  const nested = record ? asRecord(record.error) : null;
  const candidates = [
    record?.code,
    nested?.code,
    typeof record?.error === "string" ? record.error : undefined,
    record?.error_code,
  ];
  const detailValue = record?.detail ?? record?.details ?? nested?.detail ?? null;
  let detail = typeof detailValue === "string" ? detailValue : null;
  // auth-username lockouts answer 429 with the seconds to wait (DESIGN.md §15.10)
  const retryAfter = record?.retry_after_seconds;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) detail = `retry_after_seconds=${Math.max(0, Math.round(retryAfter))}`;
  for (const candidate of candidates) {
    if (isPlatformErrorCode(candidate)) return platformError(candidate, { status, detail });
    if (typeof candidate === "string" && AUTH_CODES[candidate]) {
      return platformError(AUTH_CODES[candidate], { status, detail: detail ?? candidate });
    }
  }
  const message = text(record?.message) ?? text(nested?.message) ?? text(record?.msg);
  return platformError(codeForStatus(status), { status, detail: detail ?? message });
}

function responseLike(value: unknown): { status: number; json?: () => Promise<unknown>; clone?: () => unknown } | null {
  const record = asRecord(value);
  if (!record || typeof record.status !== "number") return null;
  return record as unknown as { status: number; json?: () => Promise<unknown>; clone?: () => unknown };
}

/** supabase-js FunctionsHttpError / FunctionsRelayError / FunctionsFetchError → PlatformError (reads the body). */
export async function fromFunctionsError(error: unknown): Promise<PlatformError> {
  if (error instanceof PlatformError) return error;
  const name = nameOf(error);
  const context = asRecord(error)?.context;
  if (name === "FunctionsHttpError") {
    const response = responseLike(context);
    if (!response) return platformError("unknown", { cause: error });
    let body: unknown = null;
    try {
      const target = typeof response.clone === "function" ? responseLike(response.clone()) ?? response : response;
      if (typeof target.json === "function") body = await target.json();
    } catch {
      body = null;
    }
    return fromFunctionBody(response.status, body);
  }
  if (name === "FunctionsRelayError") {
    const response = responseLike(context);
    return platformError("network", { status: response?.status ?? 502, detail: "relay", cause: error });
  }
  if (name === "FunctionsFetchError") {
    if (isAbortError(context)) return abortError(context);
    return platformError("network", { status: 0, detail: messageOf(context) || null, cause: error });
  }
  return toPlatformError(error);
}

// any failure --------------------------------------------------------------------------------------------------------

/** Any thrown value → PlatformError (PlatformErrors pass through unchanged). */
export function toPlatformError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  const record = asRecord(error);
  if (record && record.name === "PlatformError" && isPlatformErrorCode(record.code)) {
    // a PlatformError from another bundle copy or realm
    return platformError(record.code, {
      status: typeof record.status === "number" ? record.status : null,
      detail: typeof record.detail === "string" ? record.detail : null,
      message: messageOf(record) || MESSAGES[record.code],
      cause: error,
    });
  }
  if (isAbortError(error)) return abortError(error);
  if (record) {
    if (isAuthErrorLike(record)) return fromAuthError(error);
    if (record.__isStorageError === true || /^Storage[A-Z]/.test(nameOf(record))) return fromStorageError(error);
    const name = nameOf(record);
    if (name === "FunctionsHttpError") {
      const response = responseLike(record.context);
      return platformError(codeForStatus(response?.status ?? 0), { status: response?.status ?? null, cause: error });
    }
    if (name === "FunctionsRelayError" || name === "FunctionsFetchError") {
      return platformError("network", { detail: name, cause: error });
    }
    if (isPostgrestErrorLike(record)) return fromPostgrestError(record, typeof record.status === "number" ? record.status : null);
  }
  if (isNetworkFailure(error)) {
    return platformError("network", { status: 0, detail: nameOf(error) === "TimeoutError" ? "timeout" : null, cause: error });
  }
  const message = messageOf(error);
  return platformError("unknown", { detail: message || null, cause: error });
}

/** Worth retrying after a pause: offline, timeouts, rate limits and server-side (5xx) failures. */
export function isRetryable(error: unknown): boolean {
  const platform = toPlatformError(error);
  if (platform.code === "aborted") return false;
  if (platform.code === "network" || platform.code === "rate_limited") return true;
  const status = platform.status;
  return status !== null && (status >= 500 || status === 408);
}

// conflicts ----------------------------------------------------------------------------------------------------------

export interface ConflictDetail {
  /** version_conflict: the head another tab or device committed. */
  headVersionId: string | null;
  headSeq: number | null;
  /** draft_conflict: the draft revision now stored. */
  draftRev: number | null;
}

/** The server state named by a version_conflict / draft_conflict error (null for other errors). */
export function conflictDetail(error: unknown): ConflictDetail | null {
  if (!(error instanceof PlatformError)) return null;
  if (error.code !== "version_conflict" && error.code !== "draft_conflict") return null;
  const result: ConflictDetail = { headVersionId: null, headSeq: null, draftRev: null };
  if (!error.detail) return result;
  try {
    const parsed = asRecord(JSON.parse(error.detail) as unknown);
    if (!parsed) return result;
    if (typeof parsed.head_version_id === "string") result.headVersionId = parsed.head_version_id;
    const headSeq = parsed.head_seq;
    if (typeof headSeq === "number") result.headSeq = headSeq;
    const draftRev = parsed.draft_rev;
    if (typeof draftRev === "number") result.draftRev = draftRev;
    else if (typeof draftRev === "string" && /^\d+$/.test(draftRev)) result.draftRev = Number(draftRev);
  } catch {
    // detail was not JSON; nothing more to report
  }
  return result;
}
