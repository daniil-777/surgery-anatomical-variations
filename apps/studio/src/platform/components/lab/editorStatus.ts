// What the project bar says about saving (APPLE_STYLE_SPEC §3.6.1): one short status with an icon (never colour alone),
// a longer sentence for its tooltip, and the one action that resolves it. Pure: the session state goes in, words come out.

import { formatSavedAt } from "./versionHistory";

export type EditorStatusTone = "neutral" | "success" | "progress" | "warning" | "danger";
export type EditorStatusIcon = "check" | "spinner" | "edited" | "offline" | "alert" | "lock" | "pause" | "none";
export type EditorStatusAction = "edit-here" | "retry" | "resolve" | "reload-lab" | "review-restore" | "put-back" | null;

export interface EditorStatusView {
  text: string;
  tone: EditorStatusTone;
  icon: EditorStatusIcon;
  /** Tooltip / popover sentence. */
  detail: string | null;
  action: EditorStatusAction;
}

/**
 * The parts of core/versioning SessionState this reads. Both the original field names and the aliases agreed for the
 * editor (busyReason, labLeft, awaitingAck, failure) are accepted, so either spelling of the engine works.
 */
export interface EditorStatusInput {
  status: "clean" | "dirty" | "saving" | "saved" | "offline" | "conflict" | "error" | "readonly";
  activity?: string | undefined;
  waitingFor?: string | null | undefined;
  busyReason?: string | false | null | undefined;
  readonlyReason?: "trashed" | "locked" | "option" | null | undefined;
  detached?: boolean | undefined;
  labLeft?: boolean | undefined;
  acknowledgementNeeded?: boolean | undefined;
  awaitingAck?: boolean | undefined;
  lastSavedAt?: string | null | undefined;
  localCopy?: "off" | "pending" | "saved" | "failed" | undefined;
  error?: { code: string; message: string } | null | undefined;
  failure?: { code: string; message: string } | null | undefined;
}

export interface EditorStatusOptions {
  /** "Saving…" only once a write has been in flight for 400 ms (faster saves go straight to "Saved"). */
  savingVisible: boolean;
  now?: Date | undefined;
  locale?: string | undefined;
}

const BUSY_WORDS: Readonly<Record<string, string>> = {
  loading: "the lab is loading",
  recording: "recording",
  running: "a simulation is running",
  baking: "baking",
  importing: "importing",
  exporting: "adding to the Library",
  restoring: "restoring",
  thumbnail: "capturing a preview",
  busy: "the lab is busy",
  unavailable: "the lab is not responding",
};

/** "recording", "a simulation is running", or the lab's own short reason. */
export function busyReasonText(reason: string): string {
  const key = reason.trim().toLowerCase();
  if (key === "") return "the lab is busy";
  return BUSY_WORDS[key] ?? key;
}

function savedDetail(input: EditorStatusInput, options: EditorStatusOptions): string | null {
  if (!input.lastSavedAt) return null;
  const when = formatSavedAt(input.lastSavedAt, options.now ?? new Date(), options.locale);
  return when ? `Saved to your account ${when.charAt(0).toLowerCase()}${when.slice(1)}.` : null;
}

export function editorStatus(input: EditorStatusInput, options: EditorStatusOptions): EditorStatusView {
  const failure = input.failure ?? input.error ?? null;
  const left = input.labLeft ?? input.detached ?? false;
  const awaiting = input.awaitingAck ?? input.acknowledgementNeeded ?? false;
  const busy = input.busyReason || input.waitingFor || null;
  const activity = input.activity ?? "idle";

  if (input.status === "readonly") {
    if (input.readonlyReason === "locked") {
      return {
        text: "Read-only — open in another tab",
        tone: "warning",
        icon: "lock",
        detail: "This project is being edited in another tab or window. Choose Edit Here to edit it in this one.",
        action: "edit-here",
      };
    }
    if (input.readonlyReason === "trashed") {
      return { text: "Read-only — in the Trash", tone: "warning", icon: "lock", detail: "Put the project back to edit it.", action: "put-back" };
    }
    return { text: "Read-only", tone: "neutral", icon: "lock", detail: null, action: null };
  }
  if (activity === "reloading" || activity === "restoring" || activity === "recovering") {
    const text = activity === "restoring" ? "Restoring…" : activity === "recovering" ? "Recovering…" : "Opening…";
    return { text, tone: "progress", icon: "spinner", detail: null, action: null };
  }
  if (input.status === "conflict") {
    return {
      text: "Changed elsewhere",
      tone: "danger",
      icon: "alert",
      detail: "Another tab or device saved this project while you were editing. Choose which version to keep.",
      action: "resolve",
    };
  }
  if (left) {
    return {
      text: "Not saving — the lab reloaded",
      tone: "warning",
      icon: "alert",
      detail: "The lab reloaded on its own, so changes made in it now are not part of this project. Reload the lab to keep editing.",
      action: "reload-lab",
    };
  }
  if (awaiting) {
    return {
      text: "Autosave paused: review the restore",
      tone: "warning",
      icon: "pause",
      detail: "The lab could not show this version exactly. Review what differs; autosave resumes when you continue.",
      action: "review-restore",
    };
  }
  if (input.status === "offline") {
    const kept = input.localCopy === "saved";
    return {
      text: kept ? "Offline — your changes are kept on this device" : "Offline — waiting to save",
      tone: "warning",
      icon: "offline",
      detail: kept
        ? "Your account can't be reached. Changes are kept on this device and saved when the connection returns."
        : "Your account can't be reached. Saving resumes when the connection returns.",
      action: "retry",
    };
  }
  if (input.status === "error") {
    return {
      text: "Couldn't save",
      tone: "danger",
      icon: "alert",
      detail: failure?.message ? failure.message : "The last save did not complete.",
      action: "retry",
    };
  }
  if (busy && (input.status === "dirty" || activity === "waiting-for-lab")) {
    return { text: `Autosave paused: ${busyReasonText(busy)}`, tone: "neutral", icon: "pause", detail: "Saving resumes when the lab is free.", action: null };
  }
  if (input.status === "saving") {
    if (options.savingVisible) return { text: "Saving…", tone: "progress", icon: "spinner", detail: null, action: null };
    return { text: "Edited", tone: "neutral", icon: "edited", detail: "Changes are being saved.", action: null };
  }
  if (input.status === "dirty") {
    return { text: "Edited", tone: "neutral", icon: "edited", detail: "Changes are saved automatically.", action: null };
  }
  return { text: "Saved", tone: input.status === "saved" ? "success" : "neutral", icon: "check", detail: savedDetail(input, options), action: null };
}

/** Which transitions are announced to assistive technology (§3.6.1: explicit saves, offline, couldn't save). */
export function shouldAnnounce(previous: EditorStatusView | null, next: EditorStatusView): boolean {
  if (previous && previous.text === next.text) return false;
  return next.icon === "offline" || next.text === "Couldn't save" || next.action === "resolve" || next.icon === "lock";
}
