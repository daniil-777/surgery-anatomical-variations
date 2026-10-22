// Library wording on top of the shell's shared messages (app/messages.ts, APPLE_STYLE_SPEC §4.5): say what happened to
// which file, then the shared sentence for why and what to do. The plan's per-file limit is named when it is known.
import { errorCode, errorMessage, isSilentError } from "../../app/messages";
import { formatBytes } from "../../ui/lib/format";

export type LibraryAction = "load" | "upload" | "update" | "trash" | "restore" | "download" | "preview";

export interface MessageContext {
  /** The file or item the action was about ("Liver.glb"). */
  name?: string | undefined;
  /** The plan's per-file limit, when known. */
  maxFileBytes?: number | undefined;
}

export { errorCode, isSilentError };

function quoted(name: string | undefined, fallback: string): string {
  return name ? `“${name}”` : fallback;
}

/** The sentence shown in a toast or inline for a failed library action. */
export function libraryErrorMessage(error: unknown, action: LibraryAction, context: MessageContext = {}): string {
  const code = errorCode(error);
  const { name } = context;
  switch (action) {
    case "upload":
      if (code === "file_too_large") {
        const limit = context.maxFileBytes ? ` (${formatBytes(context.maxFileBytes)} per file)` : "";
        return `${quoted(name, "This file")} is larger than your plan allows${limit}.`;
      }
      if (code === "quota_exceeded") {
        return `There isn’t enough storage left for ${quoted(name, "this file")}. Delete items you no longer need or empty the Trash.`;
      }
      if (code === "aborted") return `The upload of ${quoted(name, "the file")} was cancelled.`;
      return `Couldn’t upload ${quoted(name, "the file")}. ${errorMessage(error, "upload")}`;
    case "update":
      return `Couldn’t save the change. ${errorMessage(error, "general")}`;
    case "trash":
      return `Couldn’t move ${quoted(name, "the item")} to the Trash. ${errorMessage(error, "delete")}`;
    case "restore":
      return `Couldn’t put ${quoted(name, "the item")} back. ${errorMessage(error, "recover")}`;
    case "download":
      return `Couldn’t download ${quoted(name, "the file")}. ${errorMessage(error, "load")}`;
    case "preview":
      return `The preview couldn’t be shown. ${errorMessage(error, "load")}`;
    case "load":
      return errorMessage(error, "load");
  }
}

/** Client-side check of a title before it reaches the server (the database rule: 1-120 characters). */
export function titleProblem(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed === "") return "Enter a name.";
  if ([...trimmed].length > 120) return "Use 120 characters or fewer.";
  return null;
}

/** Client-side check of one new tag against the tags already on the item (the database rule: ≤ 20 tags of 1-32 chars). */
export function tagProblem(tag: string, existing: readonly string[]): string | null {
  const trimmed = tag.trim();
  if (trimmed === "") return null;
  if (/\p{Cc}/u.test(trimmed)) return "Tags can’t contain control characters.";
  if ([...trimmed].length > 32) return "Tags can have at most 32 characters.";
  if (existing.some((candidate) => candidate.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) return `“${trimmed}” is already a tag.`;
  if (existing.length >= 20) return "An item can have at most 20 tags.";
  return null;
}
