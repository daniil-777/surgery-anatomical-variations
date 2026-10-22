import {
  AuthApiError,
  AuthInvalidCredentialsError,
  AuthPKCECodeVerifierMissingError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
  AuthWeakPasswordError,
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
  PostgrestError,
  StorageApiError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  abortError,
  codeForStatus,
  conflictDetail,
  defaultMessage,
  fromAuthError,
  fromFunctionBody,
  fromFunctionsError,
  fromHttpFailure,
  fromPostgrestError,
  fromStorageError,
  isAbortError,
  isAssetBusy,
  isPlatformErrorCode,
  isRetryable,
  isStorageDuplicate,
  PLATFORM_ERROR_CODES,
  platformError,
  throwIfAborted,
  toPlatformError,
} from "./errors";
import { PlatformError } from "./types";

describe("PostgREST errors", () => {
  it("maps PT<status> raised by the database functions to the platform code in the message", () => {
    const conflict = fromPostgrestError({ code: "PT409", message: "version_conflict", details: '{"head_version_id" : "v2", "head_seq" : 2}', hint: null }, 409);
    expect(conflict).toBeInstanceOf(PlatformError);
    expect(conflict.code).toBe("version_conflict");
    expect(conflict.status).toBe(409);
    expect(conflict.message).toBe(defaultMessage("version_conflict"));
    expect(conflictDetail(conflict)).toEqual({ headVersionId: "v2", headSeq: 2, draftRev: null });

    expect(fromPostgrestError({ code: "PT413", message: "quota_exceeded", details: "1 of 2 bytes used" }).code).toBe("quota_exceeded");
    expect(fromPostgrestError({ code: "PT404", message: "not_found", details: "project" }).detail).toBe("project");
    expect(fromPostgrestError({ code: "PT401", message: "not_authenticated", details: "" }).detail).toBeNull();
    expect(fromPostgrestError({ code: "PT403", message: "limit_reached", details: "at most 100 projects" }).code).toBe("limit_reached");
    // an unknown message falls back to the status and stays readable at the front of the detail
    expect(fromPostgrestError({ code: "PT422", message: "something_new", details: "" })).toMatchObject({ code: "invalid_input", detail: "something_new" });
    const busy = fromPostgrestError({ code: "PT409", message: "asset_busy", details: "being collected" }, 409);
    expect(busy).toMatchObject({ code: "asset_busy", status: 409, detail: "being collected", message: defaultMessage("asset_busy") });
    expect(isAssetBusy(busy)).toBe(true);
    expect(isAssetBusy(fromPostgrestError({ code: "PT409", message: "asset_busy", details: "" }))).toBe(true);
    expect(isAssetBusy(fromPostgrestError({ code: "PT409", message: "version_conflict", details: "{}" }))).toBe(false);
    // recognised by shape: an error from another bundle copy or a lab iframe
    expect(isAssetBusy({ name: "PlatformError", code: "asset_busy", status: 409 })).toBe(true);
    expect(isAssetBusy(new Error("asset_busy"))).toBe(false);
    // put() retries it on its own schedule, not as a transient failure
    expect(isRetryable(busy)).toBe(false);
  });

  it("maps supabase-js PostgrestError instances and Postgres SQLSTATEs", () => {
    const draft = new PostgrestError({ code: "PT409", message: "draft_conflict", details: '{"draft_rev" : 7}', hint: "" });
    expect(toPlatformError(draft).code).toBe("draft_conflict");
    expect(conflictDetail(toPlatformError(draft))?.draftRev).toBe(7);
    expect(fromPostgrestError({ code: "23505", message: "duplicate key", details: "Key (username)=(x) already exists." }, 409)).toMatchObject({
      code: "invalid_input",
      status: 409,
    });
    expect(fromPostgrestError({ code: "23514", message: "violates check constraint" }, 400).code).toBe("invalid_input");
    expect(fromPostgrestError({ code: "22P02", message: "invalid input syntax for type uuid" }, 400).code).toBe("invalid_input");
    expect(fromPostgrestError({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, 406).code).toBe("not_found");
    expect(fromPostgrestError({ code: "PGRST301", message: "JWT expired" }, 401).code).toBe("not_authenticated");
    expect(fromPostgrestError({ code: "42501", message: "permission denied" }, 401).code).toBe("not_authenticated");
    expect(fromPostgrestError({ code: "42501", message: "permission denied" }, 403)).toMatchObject({ code: "unknown", status: 403 });
  });

  it("reads supabase-js network failures (status 0) as network or aborted", () => {
    expect(fromPostgrestError({ code: "", message: "TypeError: fetch failed", details: "", hint: "" }, 0).code).toBe("network");
    expect(fromPostgrestError({ code: "", message: "AbortError: This operation was aborted", details: "", hint: "" }, 0).code).toBe("aborted");
    expect(fromPostgrestError({ code: "", message: "Service Unavailable" }, 503).code).toBe("network");
  });
});

describe("Storage errors", () => {
  it("uses the status from the body (Storage answers 400 with statusCode 409/413)", () => {
    const duplicate = new StorageApiError("The resource already exists", 400, "409");
    expect(isStorageDuplicate(duplicate)).toBe(true);
    const mapped = fromStorageError(duplicate);
    expect(mapped).toMatchObject({ code: "unknown", status: 409, detail: "duplicate" });
    expect(isStorageDuplicate(mapped)).toBe(true);

    expect(fromStorageError(new StorageApiError("The object exceeded the maximum allowed size", 400, "413")).code).toBe("file_too_large");
    expect(fromStorageError(new StorageApiError("Payload too large", 413, "413")).code).toBe("file_too_large");
    expect(fromStorageError(new StorageApiError("Object not found", 400, "404")).code).toBe("not_found");
    expect(fromStorageError(new StorageApiError("mime type text/html is not supported", 400, "415")).code).toBe("invalid_input");
    expect(fromStorageError(new StorageApiError("jwt expired", 400, "400"))).toMatchObject({ code: "not_authenticated", status: 401 });
    expect(fromStorageError(new StorageApiError("new row violates row-level security policy", 400, "403"))).toMatchObject({
      code: "unknown",
      status: 403,
    });
  });

  it("treats StorageUnknownError (failed fetch) as network, or aborted", () => {
    const network = { name: "StorageUnknownError", __isStorageError: true, message: "fetch failed", originalError: new TypeError("fetch failed") };
    expect(toPlatformError(network).code).toBe("network");
    const aborted = { name: "StorageUnknownError", __isStorageError: true, message: "aborted", originalError: new DOMException("x", "AbortError") };
    expect(toPlatformError(aborted).code).toBe("aborted");
  });

  it("parses raw HTTP failures (TUS, direct uploads)", () => {
    expect(fromHttpFailure(413, '{"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size"}').code).toBe(
      "file_too_large",
    );
    expect(fromHttpFailure(400, '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}').status).toBe(409);
    expect(fromHttpFailure(403, "new row violates row-level security policy").status).toBe(403);
    expect(fromHttpFailure(503, null).code).toBe("network");
    expect(fromHttpFailure(401, null).code).toBe("not_authenticated");
  });
});

describe("GoTrue errors", () => {
  it("maps error codes", () => {
    expect(fromAuthError(new AuthApiError("Invalid login credentials", 400, "invalid_credentials")).code).toBe("invalid_credentials");
    expect(fromAuthError(new AuthApiError("Email not confirmed", 400, "email_not_confirmed")).code).toBe("email_not_confirmed");
    expect(fromAuthError(new AuthApiError("User already registered", 422, "user_already_exists")).code).toBe("user_exists");
    expect(fromAuthError(new AuthApiError("Email exists", 422, "email_exists")).code).toBe("user_exists");
    expect(fromAuthError(new AuthApiError("Too many", 429, "over_request_rate_limit")).code).toBe("rate_limited");
    expect(fromAuthError(new AuthApiError("Email rate limit exceeded", 429, "over_email_send_rate_limit")).code).toBe("rate_limited");
    expect(fromAuthError(new AuthApiError("Unsupported provider", 400, "provider_disabled")).code).toBe("provider_disabled");
    expect(fromAuthError(new AuthApiError("Token has expired or is invalid", 403, "otp_expired")).code).toBe("invalid_credentials");
    expect(fromAuthError(new AuthApiError("New password should be different", 422, "same_password")).code).toBe("invalid_input");
    expect(fromAuthError(new AuthApiError("Identity is already linked", 422, "identity_already_exists")).code).toBe("user_exists");
    expect(fromAuthError(new AuthApiError("Session not found", 403, "session_not_found")).code).toBe("not_authenticated");
  });

  it("tells a missing account from disabled codes when shouldCreateUser is false", () => {
    expect(fromAuthError(new AuthApiError("Signups not allowed for otp", 422, "otp_disabled"))).toMatchObject({
      code: "invalid_credentials",
      detail: "no_account",
    });
    expect(fromAuthError(new AuthApiError("Email logins are disabled", 422, "otp_disabled")).code).toBe("provider_disabled");
  });

  it("maps error classes and legacy messages without codes", () => {
    const weak = new AuthWeakPasswordError("Password should be at least 8 characters", 422, ["length", "pwned"]);
    expect(fromAuthError(weak)).toMatchObject({ code: "weak_password", detail: "length,pwned" });
    expect(fromAuthError(new AuthRetryableFetchError("Failed to fetch", 0)).code).toBe("network");
    expect(fromAuthError(new AuthRetryableFetchError("Bad gateway", 502)).code).toBe("network");
    expect(fromAuthError(new AuthSessionMissingError()).code).toBe("not_authenticated");
    expect(fromAuthError(new AuthInvalidCredentialsError("You must provide either an email or phone number")).code).toBe("invalid_input");
    expect(fromAuthError(new AuthPKCECodeVerifierMissingError()).code).toBe("invalid_credentials");
    expect(fromAuthError(new AuthUnknownError("x", new TypeError("Failed to fetch"))).code).toBe("network");
    expect(fromAuthError(new AuthUnknownError("x", new DOMException("x", "AbortError"))).code).toBe("aborted");
    expect(fromAuthError(new AuthApiError("Invalid login credentials", 400, undefined)).code).toBe("invalid_credentials");
    expect(fromAuthError(new AuthApiError("User already registered", 400, undefined)).code).toBe("user_exists");
    expect(toPlatformError(new AuthApiError("Invalid login credentials", 400, "invalid_credentials")).code).toBe("invalid_credentials");
  });
});

describe("Edge Function errors", () => {
  function httpError(status: number, body: unknown): FunctionsHttpError {
    return new FunctionsHttpError(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }

  it("reads platform and GoTrue codes from the body", async () => {
    expect((await fromFunctionsError(httpError(400, { code: "invalid_credentials", message: "nope" }))).code).toBe("invalid_credentials");
    expect((await fromFunctionsError(httpError(429, { error: "rate_limited" }))).code).toBe("rate_limited");
    expect((await fromFunctionsError(httpError(400, { error: { code: "invalid_input", message: "confirmation" } }))).code).toBe("invalid_input");
    expect((await fromFunctionsError(httpError(422, { error_code: "weak_password" }))).code).toBe("weak_password");
    const unknownBody = await fromFunctionsError(httpError(401, { message: "Invalid JWT" }));
    expect(unknownBody).toMatchObject({ code: "not_authenticated", status: 401, detail: "Invalid JWT" });
    const plain = await fromFunctionsError(new FunctionsHttpError(new Response("boom", { status: 500 })));
    expect(plain).toMatchObject({ code: "unknown", status: 500 });
  });

  it("maps relay and fetch failures", async () => {
    expect((await fromFunctionsError(new FunctionsRelayError(new Response("", { status: 502 })))).code).toBe("network");
    expect((await fromFunctionsError(new FunctionsFetchError(new TypeError("fetch failed")))).code).toBe("network");
    expect((await fromFunctionsError(new FunctionsFetchError(new DOMException("x", "AbortError")))).code).toBe("aborted");
    expect(fromFunctionBody(403, { code: "limit_reached", detail: "x" })).toMatchObject({ code: "limit_reached", detail: "x" });
    expect(fromFunctionBody(429, { code: "rate_limited", retry_after_seconds: 412.6 })).toMatchObject({ code: "rate_limited", detail: "retry_after_seconds=413" });
  });
});

describe("generic failures", () => {
  it("passes PlatformErrors through and revives ones from another bundle", () => {
    const original = platformError("quota_exceeded", { status: 413 });
    expect(toPlatformError(original)).toBe(original);
    const foreign = { name: "PlatformError", code: "draft_conflict", status: 409, detail: '{"draft_rev":3}', message: "x" };
    expect(toPlatformError(foreign)).toMatchObject({ code: "draft_conflict", status: 409 });
  });

  it("recognises aborts and network failures", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError(abortError())).toBe(true);
    expect(isAbortError(new DOMException("x", "TimeoutError"))).toBe(false);
    expect(toPlatformError(new DOMException("x", "TimeoutError")).code).toBe("network");
    expect(toPlatformError(new TypeError("Failed to fetch")).code).toBe("network");
    expect(toPlatformError(new TypeError("Load failed")).code).toBe("network");
    expect(toPlatformError(new Error("other")).code).toBe("unknown");
    expect(toPlatformError("text").code).toBe("unknown");
  });

  it("throwIfAborted distinguishes cancellation from timeouts", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(expect.objectContaining({ code: "aborted" }));
    const timeout = new AbortController();
    timeout.abort(new DOMException("timed out", "TimeoutError"));
    expect(() => throwIfAborted(timeout.signal)).toThrow(expect.objectContaining({ code: "network" }));
  });

  it("decides what is worth retrying", () => {
    expect(isRetryable(platformError("network"))).toBe(true);
    expect(isRetryable(platformError("rate_limited", { status: 429 }))).toBe(true);
    expect(isRetryable(platformError("unknown", { status: 500 }))).toBe(true);
    expect(isRetryable(platformError("unknown", { status: 403 }))).toBe(false);
    expect(isRetryable(platformError("version_conflict", { status: 409 }))).toBe(false);
    expect(isRetryable(platformError("aborted"))).toBe(false);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });

  it("knows every code and a message for each", () => {
    for (const code of PLATFORM_ERROR_CODES) {
      expect(isPlatformErrorCode(code)).toBe(true);
      expect(defaultMessage(code).length).toBeGreaterThan(3);
    }
    expect(isPlatformErrorCode("nope")).toBe(false);
    expect(codeForStatus(0)).toBe("network");
    expect(codeForStatus(404)).toBe("not_found");
    expect(codeForStatus(413)).toBe("file_too_large");
    expect(codeForStatus(418)).toBe("unknown");
  });

  it("conflictDetail ignores other errors and malformed details", () => {
    expect(conflictDetail(platformError("not_found"))).toBeNull();
    expect(conflictDetail(new Error("x"))).toBeNull();
    expect(conflictDetail(platformError("version_conflict", { detail: "not json" }))).toEqual({ headVersionId: null, headSeq: null, draftRev: null });
  });
});
