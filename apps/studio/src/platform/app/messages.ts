// Friendly text for PlatformError codes, shared by every shell page (APPLE_STYLE_SPEC §4.5): say what happened, then
// what to do; sentence case, no "Error:" prefix, no blame, codes never shown. A context picks the wording that fits
// the action ("signin", "upload", …); anything without a context-specific sentence falls back to the general one.
// Errors are recognised by shape (isPlatformError), so errors from lab iframes and duplicated chunks work too.

import { isPlatformError, type PlatformError, type PlatformErrorCode } from "../core/types";

export type MessageContext =
  | "general"
  /** Email or username + password. */
  | "signin"
  | "signup"
  /** Signing in with an emailed 6-digit code. */
  | "code"
  /** Password reset by emailed code. */
  | "recovery"
  /** Setting a new password (reset or change). */
  | "new-password"
  /** Confirming the current password before a sensitive change. */
  | "reauthenticate"
  | "profile"
  /** Connecting or disconnecting Apple, Google, GitHub or Microsoft. */
  | "identity"
  | "upload"
  | "load"
  | "save"
  /** Recovering items from the Trash. */
  | "recover"
  | "delete"
  | "delete-account";

const GENERAL: Record<PlatformErrorCode, string> = {
  not_authenticated: "Your session has ended. Sign in again to continue.",
  not_found: "This item no longer exists. It may have been deleted in another window or on another device.",
  invalid_input: "Some of the information isn’t valid. Check it and try again.",
  quota_exceeded: "Your storage is full. Delete items you no longer need or empty the Trash, then try again.",
  file_too_large: "This file is larger than your plan allows.",
  version_conflict: "This project changed in another window or on another device. Reload it to see the latest version.",
  draft_conflict: "This project has newer changes from another window or device. Reload it to see them.",
  asset_not_ready: "A file hasn’t finished uploading. Wait a moment and try again.",
  asset_busy: "A file is being tidied up on the server right now. Try again in a moment.",
  upload_missing: "A file didn’t finish uploading. Try again.",
  size_mismatch: "A file changed while it was uploading. Try again.",
  limit_reached: "You’ve reached a limit of your plan. Delete items you no longer need, then try again.",
  project_trashed: "This project is in the Trash. Recover it to keep working on it.",
  invalid_credentials: "Your email, username or password is incorrect.",
  email_not_confirmed: "Confirm your email address first. Open the link in the email we sent you.",
  user_exists: "An account with this email address already exists. Sign in instead.",
  weak_password: "Use at least 8 characters for your password.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  provider_disabled: "This way of signing in isn’t available on this site.",
  accounts_disabled: "Accounts aren’t available on this site right now.",
  network: "VISCERA can’t reach the server. Check your internet connection and try again.",
  aborted: "Cancelled.",
  unknown: "Something went wrong. Try again.",
};

const TITLES: Record<PlatformErrorCode, string> = {
  not_authenticated: "Sign In Again",
  not_found: "Item Not Found",
  invalid_input: "Check the Details",
  quota_exceeded: "Storage Full",
  file_too_large: "File Too Large",
  version_conflict: "Changed Elsewhere",
  draft_conflict: "Changed Elsewhere",
  asset_not_ready: "Upload Not Finished",
  asset_busy: "Try Again Shortly",
  upload_missing: "Upload Not Finished",
  size_mismatch: "Upload Interrupted",
  limit_reached: "Plan Limit Reached",
  project_trashed: "Project in Trash",
  invalid_credentials: "Couldn’t Sign In",
  email_not_confirmed: "Confirm Your Email",
  user_exists: "Account Already Exists",
  weak_password: "Choose a Longer Password",
  rate_limited: "Too Many Attempts",
  provider_disabled: "Not Available",
  accounts_disabled: "Accounts Unavailable",
  network: "Can’t Connect",
  aborted: "Cancelled",
  unknown: "Something Went Wrong",
};

const CODE_EXPIRED = "That code isn’t right or has expired. Check the latest email or send a new code.";
const CODE_TOO_SOON = "A code was sent a moment ago. Wait a minute before asking for another.";
const IDENTITY_TAKEN = "That account is already connected to another VISCERA account.";

// What the backends put in `detail` (GoTrue error codes and database column names, core/memory and core/supabase),
// per code: the same detail means different things under different codes ("username" taken vs. malformed).
const DETAILS: Partial<Record<PlatformErrorCode, Readonly<Record<string, string>>>> = {
  not_authenticated: {
    reauthentication_needed: "For your security, confirm your password again to continue.",
  },
  invalid_input: {
    same_password: "Choose a password that’s different from your current one.",
    email_address_invalid: "Enter a valid email address.",
    username: "Usernames have 3 to 30 lowercase letters, numbers, dots, hyphens or underscores.",
    display_name: "Use a name of at most 80 characters.",
    single_identity_not_deletable: "You can’t disconnect your only way to sign in.",
    email_conflict_identity_not_deletable: "This sign-in method uses your account’s email address, so it can’t be disconnected.",
  },
  user_exists: {
    username: "That username is taken. Choose another one.",
    identity_already_exists: IDENTITY_TAKEN,
  },
  provider_disabled: {
    username: "Signing in with a username isn’t available. Use your email address instead.",
    email_code: "Signing in with a code isn’t available on this site.",
    email_delivery: "Email isn’t set up on this site yet, so codes and reset emails can’t be sent.",
  },
};

function detailKey(error: PlatformError): string {
  const detail = error.detail ?? "";
  // "asset_busy: …" style details carry the server code first
  const colon = detail.indexOf(":");
  return (colon > 0 ? detail.slice(0, colon) : detail).trim();
}

function detailMessage(error: PlatformError): string | null {
  return DETAILS[error.code]?.[detailKey(error)] ?? null;
}

/** A context sentence, or a function of the error (its detail) that may decline with null. */
type Override = string | ((error: PlatformError) => string | null);
type Overrides = Partial<Record<PlatformErrorCode, Override>>;

const CONTEXTS: Record<Exclude<MessageContext, "general">, Overrides> = {
  signin: {
    not_found: GENERAL.invalid_credentials,
    rate_limited: "Too many sign-in attempts. Wait a few minutes and try again.",
  },
  signup: {
    user_exists: (error) =>
      detailKey(error) === "username" ? null : "An account with this email address already exists. Sign in instead, or reset your password.",
    invalid_input: (error) => detailMessage(error) ?? "Check your email address and username, then try again.",
    rate_limited: "Too many accounts were created from this network recently. Wait a few minutes and try again.",
    provider_disabled: "Creating accounts isn’t available on this site right now.",
  },
  code: {
    invalid_credentials: CODE_EXPIRED,
    not_found: CODE_EXPIRED,
    rate_limited: CODE_TOO_SOON,
  },
  recovery: {
    invalid_credentials: CODE_EXPIRED,
    not_found: CODE_EXPIRED,
    rate_limited: CODE_TOO_SOON,
  },
  "new-password": {
    not_authenticated: "This reset session has ended. Request a new code to choose your password.",
    weak_password: "Use at least 8 characters for your new password.",
  },
  reauthenticate: {
    invalid_credentials: "Your current password is incorrect.",
    not_found: "Your current password is incorrect.",
  },
  profile: {
    user_exists: "That username is taken. Choose another one.",
  },
  identity: {
    user_exists: IDENTITY_TAKEN,
    not_found: "That sign-in method is no longer connected.",
    provider_disabled: "That sign-in method isn’t available on this site.",
  },
  upload: {
    quota_exceeded: "There isn’t enough storage left for this file. Delete items you no longer need or empty the Trash.",
    invalid_input: "This kind of file can’t be uploaded.",
  },
  load: {
    not_found: "This item no longer exists.",
  },
  save: {
    quota_exceeded: "Your storage is full, so changes can’t be saved. Free up space, then try again.",
  },
  recover: {
    limit_reached: "Your plan’s project limit is reached. Delete a project, then recover this one.",
    not_found: "This item was already deleted.",
  },
  delete: {
    not_found: "This item was already deleted.",
  },
  "delete-account": {
    invalid_credentials: "Your password is incorrect.",
    not_authenticated: (error) =>
      detailKey(error) === "reauthentication_needed"
        ? "For your security, sign out and sign in again, then delete your account within 10 minutes."
        : null,
  },
};

const KNOWN_CODES = new Set<string>(Object.keys(GENERAL));

function isAbortLike(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "AbortError";
}

function isFetchFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "NetworkError" || name === "TimeoutError") return true;
  return name === "TypeError" && typeof message === "string" && /fetch|network|load failed/i.test(message);
}

function knownPlatformError(error: unknown): error is PlatformError {
  return isPlatformError(error) && KNOWN_CODES.has(error.code);
}

/** The PlatformErrorCode an unknown failure stands for ("unknown" when it is not one of ours). */
export function errorCode(error: unknown): PlatformErrorCode {
  if (knownPlatformError(error)) return error.code;
  if (isPlatformError(error)) return "unknown";
  if (isAbortLike(error)) return "aborted";
  if (isFetchFailure(error)) return "network";
  return "unknown";
}

/** One friendly sentence for any failure, worded for the action in `context`. */
export function errorMessage(error: unknown, context: MessageContext = "general"): string {
  const code = errorCode(error);
  if (knownPlatformError(error)) {
    if (context !== "general") {
      const override = CONTEXTS[context][code];
      const text = typeof override === "function" ? override(error) : override;
      if (text) return text;
    }
    const specific = detailMessage(error);
    if (specific) return specific;
  }
  return GENERAL[code];
}

/** A Title Case heading for alerts, sheets and empty states ("Storage Full", "Can’t Connect"). */
export function errorTitle(error: unknown): string {
  return TITLES[errorCode(error)];
}

/** The general sentence for a code (places that only know the code). */
export function messageForCode(code: PlatformErrorCode): string {
  return GENERAL[code];
}

/** Cancellations are not failures: callers show nothing for them. */
export function isSilentError(error: unknown): boolean {
  return errorCode(error) === "aborted";
}

/** The backend refused a sensitive change because the sign-in is older than ten minutes (DESIGN.md §15.9). */
export function isReauthenticationNeeded(error: unknown): boolean {
  return isPlatformError(error, "not_authenticated") && detailKey(error) === "reauthentication_needed";
}

/** The sign-in details were wrong (password, code): forms clear the secret and focus it again. */
export function isCredentialError(error: unknown): boolean {
  return isPlatformError(error, "invalid_credentials");
}
