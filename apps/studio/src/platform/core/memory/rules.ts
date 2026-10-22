// The database rules of supabase/migrations restated in TypeScript: the memory twin enforces them, and the Supabase
// client uses a few (usernames, search patterns) to answer without a round trip. When a migration changes a rule,
// change it here too; the backend contract suite (../backendContract.ts) runs the same scenarios against both.

import { ALLOWED_MIME_TYPES, type AllowedMimeType, type Appearance, type CommitKind, type DetectedBy, type ImportFormat, type JsonValue, type LibraryFileRole, type LibraryKind, type Plan, type SourceApp } from "../types";

export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const LAB_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const ATTACHMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** library_item_files.filename: 1-180 characters, no slash, backslash or control character, not starting with ".". */
export const LIBRARY_FILENAME_PATTERN = /^[^/\\\p{Cc}]{1,180}$/u;
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])$/;

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin", "administrator", "root", "support", "help", "viscera", "system", "api", "auth", "login", "logout",
  "signin", "signup", "sign-in", "sign-up", "account", "accounts", "settings", "security", "null", "undefined",
  "owner", "staff", "team", "official", "moderator", "mod", "info", "contact", "abuse", "postmaster", "webmaster",
  "noreply", "no-reply", "billing", "privacy", "terms", "library", "imports", "projects", "home", "trash",
]);

export const LIBRARY_KINDS: readonly LibraryKind[] = ["shape", "material", "texture", "recording", "scene", "image", "model"];
export const LIBRARY_FILE_ROLES: readonly LibraryFileRole[] = [
  "primary", "mesh", "albedo", "normal", "roughness", "metalness", "height", "ao", "emissive", "opacity",
  "thumbnail", "preview", "video", "data", "spec", "material", "other",
];
export const SOURCE_APPS: readonly SourceApp[] = [
  "unity", "blender", "maya", "3ds-max", "cinema-4d", "houdini", "sketchup", "substance", "zbrush",
  "reality-composer", "sketchfab", "other", "unknown",
];
export const DETECTED_BY_VALUES: readonly DetectedBy[] = ["metadata", "filename", "user", "none"];
export const IMPORT_FORMATS: readonly ImportFormat[] = ["glb", "gltf", "fbx", "obj", "stl", "ply", "usdz", "dae", "zip"];
export const COMMIT_KINDS: readonly CommitKind[] = ["autosave", "manual", "named"];
export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];

export const MAX_TITLE_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_DISPLAY_NAME_LENGTH = 80;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 32;
export const MAX_ATTACHMENTS = 64;
export const MAX_LIBRARY_FILES = 64;
export const MAX_JSON_METADATA_BYTES = 65536;
export const MAX_SOURCE_DETAIL_LENGTH = 200;
/** Bucket user-content file_size_limit (the Supabase free plan's global limit). */
export const BUCKET_FILE_SIZE_LIMIT = 52428800;

/** public.plans as seeded by the foundation migration (DESIGN.md §15.16: free 250 MB, the owner's account 800 MB). */
export const DEFAULT_PLANS: readonly Plan[] = [
  { id: "free", title: "Free", storageQuotaBytes: 262144000, maxFileBytes: 52428800, versionRetentionDays: 30, maxProjects: 100 },
  { id: "owner", title: "Owner", storageQuotaBytes: 838860800, maxFileBytes: 52428800, versionRetentionDays: 365, maxProjects: 1000 },
  { id: "pro", title: "Pro", storageQuotaBytes: 21474836480, maxFileBytes: 1073741824, versionRetentionDays: 180, maxProjects: 10000 },
];

/** private.require_version_room. */
export const MAX_VERSIONS_PER_PROJECT = 1000;
/** reserve_asset: unfinished uploads per account (DESIGN.md §15.4). */
export const MAX_PENDING_ASSETS = 8;
/** create_library_item: per account, trash included. */
export const MAX_LIBRARY_ITEMS = 5000;
/** create_imported_object: per account, trash included. */
export const MAX_IMPORTED_OBJECTS = 2000;

const ALLOWED = new Set<string>(ALLOWED_MIME_TYPES);

export function isAllowedMime(value: unknown): value is AllowedMimeType {
  return typeof value === "string" && ALLOWED.has(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Postgres btrim(text): removes leading and trailing spaces (only U+0020). */
export function btrim(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

/** Postgres char_length: code points, not UTF-16 units. */
export function charLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** What the client sends for a username: trimmed, lower case (the database stores and resolves lower case). */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** private.is_valid_username: 3-30 of a-z 0-9 . _ -, alphanumeric at both ends, no repeated separators, not reserved. */
export function isValidUsername(value: unknown): value is string {
  return typeof value === "string" && USERNAME_PATTERN.test(value) && !/[._-]{2}/.test(value) && !RESERVED_USERNAMES.has(value);
}

/** A title/label column: 1..max characters and no leading or trailing spaces. */
export function isValidTitle(value: unknown, max = MAX_TITLE_LENGTH): value is string {
  if (typeof value !== "string") return false;
  const length = charLength(value);
  return length >= 1 && length <= max && value === btrim(value);
}

const CONTROL = /\p{Cc}/u;

/** private.valid_tags: at most 20 distinct (case-insensitive) trimmed tags of 1-32 characters, no control characters. */
export function validTags(tags: unknown): tags is string[] {
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) return false;
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string") return false;
    const length = charLength(tag);
    if (length < 1 || length > MAX_TAG_LENGTH || tag !== btrim(tag) || CONTROL.test(tag)) return false;
    seen.add(tag.toLowerCase());
  }
  return seen.size === tags.length;
}

/** Client-side tidying both backends apply: trimmed tags, empty ones dropped, duplicates (any case) removed. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = typeof raw === "string" ? raw.trim() : "";
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
  }
  return result;
}

/** library_item_files.filename. */
export function isValidLibraryFilename(value: unknown): value is string {
  return typeof value === "string" && LIBRARY_FILENAME_PATTERN.test(value) && !value.startsWith(".") && value === btrim(value);
}

/** The length Postgres reports for octet_length(jsonb::text): ", " and ": " separators, UTF-8 bytes. */
export function jsonbTextLength(value: JsonValue): number {
  return new TextEncoder().encode(jsonbText(value)).byteLength;
}

function jsonbText(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  return `{${Object.entries(value).map(([key, member]) => `${JSON.stringify(key)}: ${jsonbText(member)}`).join(", ")}}`;
}

/** The ILIKE pattern for "title contains `search`": LIKE wildcards in the search are escaped. */
export function ilikeContainsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * Whether `text` matches an ILIKE pattern the way PostgREST evaluates it: PostgREST turns "*" into "%" first, then
 * Postgres applies LIKE with "\" as the escape character, case-insensitively.
 */
export function ilikeMatches(text: string, pattern: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += (pattern[index] as string).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (char === "%" || char === "*") {
      source += "[\\s\\S]*";
    } else if (char === "_") {
      source += "[\\s\\S]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "iu").test(text);
}
