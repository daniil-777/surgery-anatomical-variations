import { describe, expect, it } from "vitest";
import { PlatformError, type PlatformErrorCode } from "../../core/types";
import {
  errorCode,
  errorMessage,
  errorTitle,
  isCredentialError,
  isReauthenticationNeeded,
  isSilentError,
  messageForCode,
  type MessageContext,
} from "../messages";

// every code of core/types PlatformErrorCode; the Record type makes the compiler flag a code added there
const ALL_CODES: Record<PlatformErrorCode, true> = {
  not_authenticated: true,
  not_found: true,
  invalid_input: true,
  quota_exceeded: true,
  file_too_large: true,
  version_conflict: true,
  draft_conflict: true,
  asset_not_ready: true,
  asset_busy: true,
  upload_missing: true,
  size_mismatch: true,
  limit_reached: true,
  project_trashed: true,
  invalid_credentials: true,
  email_not_confirmed: true,
  user_exists: true,
  weak_password: true,
  rate_limited: true,
  provider_disabled: true,
  accounts_disabled: true,
  network: true,
  aborted: true,
  unknown: true,
};
const CODES = Object.keys(ALL_CODES) as PlatformErrorCode[];
const CONTEXTS: MessageContext[] = [
  "general", "signin", "signup", "code", "recovery", "new-password", "reauthenticate", "profile", "identity",
  "upload", "load", "save", "recover", "delete", "delete-account",
];
const BANNED = /\b(validated|measured|learned|realistic|approved)\b/i;

describe("error messages", () => {
  it("has a friendly sentence and a Title Case title for every code in every context", () => {
    for (const code of CODES) {
      for (const context of CONTEXTS) {
        const text = errorMessage(new PlatformError(code), context);
        expect(text.length, `${code}/${context}`).toBeGreaterThan(5);
        expect(text, `${code}/${context}`).toMatch(/[.]$/);
        expect(text, `${code}/${context}`).not.toMatch(/^error/i);
        expect(text, `${code}/${context}`).not.toContain(code.includes("_") ? code : "\u0000");
        expect(text).not.toMatch(BANNED);
      }
      const title = errorTitle(new PlatformError(code));
      expect(title).toMatch(/^[A-Z]/);
      expect(title).not.toMatch(/[.]$/);
      for (const word of title.split(" ")) {
        // Title Case, articles and short prepositions excepted
        if (!["a", "an", "the", "in", "to", "of", "for"].includes(word)) expect(word.charAt(0), title).toMatch(/[A-Z]/);
      }
    }
  });

  it("words sign-in failures for the screen they happen on", () => {
    const wrong = new PlatformError("invalid_credentials");
    expect(errorMessage(wrong, "signin")).toBe("Your email, username or password is incorrect.");
    expect(errorMessage(wrong, "code")).toMatch(/code isn’t right or has expired/);
    expect(errorMessage(wrong, "recovery")).toMatch(/code isn’t right or has expired/);
    expect(errorMessage(wrong, "reauthenticate")).toBe("Your current password is incorrect.");
    expect(errorMessage(wrong, "delete-account")).toBe("Your password is incorrect.");
    expect(errorMessage(new PlatformError("rate_limited"), "code")).toMatch(/Wait a minute/);
  });

  it("uses the backend's detail where it tells more than the code", () => {
    expect(errorMessage(new PlatformError("user_exists", undefined, { detail: "username" }), "profile")).toBe(
      "That username is taken. Choose another one.",
    );
    // the same detail under another code means something else
    expect(errorMessage(new PlatformError("invalid_input", undefined, { detail: "username" }))).toMatch(/3 to 30/);
    expect(errorMessage(new PlatformError("invalid_input", undefined, { detail: "same_password" }), "new-password")).toMatch(
      /different from your current one/,
    );
    expect(errorMessage(new PlatformError("invalid_input", undefined, { detail: "single_identity_not_deletable" }), "identity")).toBe(
      "You can’t disconnect your only way to sign in.",
    );
    expect(errorMessage(new PlatformError("provider_disabled", undefined, { detail: "username" }), "signin")).toMatch(
      /Use your email address/,
    );
    expect(errorMessage(new PlatformError("user_exists", undefined, { detail: "identity_already_exists" }), "identity")).toMatch(
      /already connected to another VISCERA account/,
    );
    // "code: more" details are keyed by the code before the colon
    expect(errorMessage(new PlatformError("not_authenticated", undefined, { detail: "reauthentication_needed: iat" }))).toMatch(
      /confirm your password again/,
    );
  });

  it("explains a stale sign-in for sensitive actions", () => {
    const stale = new PlatformError("not_authenticated", "For your security, sign in again to continue.", {
      status: 401,
      detail: "reauthentication_needed",
    });
    expect(isReauthenticationNeeded(stale)).toBe(true);
    expect(isReauthenticationNeeded(new PlatformError("not_authenticated"))).toBe(false);
    expect(errorMessage(stale, "delete-account")).toMatch(/within 10 minutes/);
    expect(errorMessage(new PlatformError("not_authenticated"), "delete-account")).toBe(messageForCode("not_authenticated"));
  });

  it("recognises errors by shape, across realms and duplicated chunks", () => {
    const foreign = { name: "PlatformError", code: "quota_exceeded", message: "x", status: 413, detail: null };
    expect(errorCode(foreign)).toBe("quota_exceeded");
    expect(errorMessage(foreign, "upload")).toMatch(/isn’t enough storage/);
    // a code this build does not know yet is shown as the generic failure, never as raw text
    expect(errorCode({ name: "PlatformError", code: "brand_new_code" })).toBe("unknown");
    expect(errorMessage({ name: "PlatformError", code: "brand_new_code" })).toBe("Something went wrong. Try again.");
  });

  it("maps plain failures: aborts are silent, failed fetches are network trouble", () => {
    const abort = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    expect(errorCode(abort)).toBe("aborted");
    expect(isSilentError(abort)).toBe(true);
    expect(isSilentError(new PlatformError("aborted"))).toBe(true);
    expect(isSilentError(new PlatformError("network"))).toBe(false);
    expect(errorCode(new TypeError("Failed to fetch"))).toBe("network");
    expect(errorCode(new TypeError("Load failed"))).toBe("network");
    expect(errorCode(new TypeError("x is not a function"))).toBe("unknown");
    for (const value of [undefined, null, "boom", 42, {}]) expect(errorMessage(value)).toBe("Something went wrong. Try again.");
  });

  it("flags credential errors so forms can clear the secret", () => {
    expect(isCredentialError(new PlatformError("invalid_credentials"))).toBe(true);
    expect(isCredentialError(new PlatformError("rate_limited"))).toBe(false);
    expect(isCredentialError(new Error("invalid_credentials"))).toBe(false);
  });
});
