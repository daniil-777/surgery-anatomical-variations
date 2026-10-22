// Friendly sentences for the errors the editor, the lab host and the recorder raise. Errors are recognised by shape and
// name, never by instanceof: they can come from a lab iframe's realm or from a duplicated chunk.

import type { PlatformErrorCode } from "../../core/types";

const PLATFORM_MESSAGES: Readonly<Record<PlatformErrorCode, string>> = {
  not_authenticated: "Your session has ended. Sign in again to keep saving.",
  not_found: "This item no longer exists.",
  invalid_input: "Some of the information isn't valid.",
  quota_exceeded: "Your storage is full. Empty the Trash or remove items from the Library, then try again.",
  file_too_large: "This is larger than your plan allows for one file.",
  version_conflict: "This project changed in another tab or on another device.",
  draft_conflict: "This project changed in another tab or on another device.",
  asset_not_ready: "A file hasn't finished uploading. Try again in a moment.",
  asset_busy: "A file is being cleaned up. Try again in a moment.",
  upload_missing: "A file didn't finish uploading. Try again.",
  size_mismatch: "A file changed while it was uploading. Try again.",
  limit_reached: "You've reached a limit of your plan.",
  project_trashed: "This project is in the Trash. Put it back to change it.",
  invalid_credentials: "Those sign-in details aren't correct.",
  email_not_confirmed: "Confirm your email address first.",
  user_exists: "An account with these details already exists.",
  weak_password: "Choose a longer password.",
  rate_limited: "Too many requests. Try again in a minute.",
  provider_disabled: "This isn't available on this site.",
  accounts_disabled: "Accounts aren't available on this site.",
  network: "Your account can't be reached. Check the connection and try again.",
  aborted: "Cancelled.",
  unknown: "Something went wrong.",
};

const SESSION_MESSAGES: Readonly<Record<string, string>> = {
  lab_busy: "The lab is busy. Try again when it has finished.",
  lab_mismatch: "The lab shows a different kind of work than this project.",
  readonly: "This project is open for editing in another tab. Choose Edit Here first.",
  conflict: "This project changed elsewhere. Choose which version to keep first.",
  detached: "The lab no longer shows this project. Reload the lab to keep editing.",
  disposed: "The project was closed.",
  timeout: "The lab didn't respond in time. Try again.",
};

interface ErrorShape {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  reason?: unknown;
  detail?: unknown;
}

function shape(error: unknown): ErrorShape | null {
  return typeof error === "object" && error !== null ? (error as ErrorShape) : null;
}

/** True for cancellations (AbortError, PlatformError "aborted"): callers usually stay silent. */
export function isCancellation(error: unknown): boolean {
  const value = shape(error);
  return value !== null && (value.name === "AbortError" || (value.name === "PlatformError" && value.code === "aborted"));
}

/** A sentence for a toast or an alert. `fallback` names what failed ("The version couldn't be restored."). */
export function friendlyError(error: unknown, fallback = "Something went wrong."): string {
  const value = shape(error);
  if (value === null) return fallback;
  const name = typeof value.name === "string" ? value.name : "";
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (name === "PlatformError" && typeof value.code === "string") {
    const code = value.code as PlatformErrorCode;
    if (code === "invalid_input" && message !== "" && message !== code) return message;
    if (code === "limit_reached" && typeof value.detail === "string" && /projects/.test(value.detail)) {
      return "You've reached the number of projects your plan allows. Move a project to the Trash and empty it first.";
    }
    return PLATFORM_MESSAGES[code] ?? fallback;
  }
  if (name === "SessionError" && typeof value.code === "string") return SESSION_MESSAGES[value.code] ?? fallback;
  if (name === "TimeoutError") return "The lab didn't respond in time. Try again.";
  if (name === "AbortError") return "Cancelled.";
  // the lab host: these messages are written for people already
  if (name === "LabRightsError" && message !== "") return message;
  if (name === "LabBusyError") {
    const reason = typeof value.reason === "string" ? value.reason : "";
    return reason ? `The lab is busy (${reason}). Try again when it has finished.` : SESSION_MESSAGES.lab_busy ?? fallback;
  }
  if (name === "LabUnavailableError") return "The lab isn't ready. Wait until it has loaded, then try again.";
  if (name === "LabDocumentError") return `The lab handed over something that can't be saved (${message || "unknown field"}).`;
  if (name === "RecorderUnsupportedError" && message !== "") return message;
  return fallback;
}
