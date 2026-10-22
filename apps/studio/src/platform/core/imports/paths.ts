// Paths inside a selection (webkitRelativePath or file name) or a zip, and resolution of the references models make to
// their sidecars (glTF URIs, MTL texture paths, FBX file names). Resolution never leaves the selection: remote URLs are
// refused, absolute paths fall back to the file name, and ".." cannot climb above the selection root.

export interface FileEntry {
  /** Normalised path: forward slashes, no leading slash, no "." or ".." segments. */
  path: string;
  bytes: Uint8Array;
}

const JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", ".localized", "icon\r"]);

/** Forward slashes, no drive letter or leading slash, "." and ".." resolved; null when ".." escapes the root. */
export function normalizePath(raw: string): string | null {
  const parts: string[] = [];
  const withoutDrive = raw.replace(/\\/g, "/").replace(/^[A-Za-z]:(?=\/|$)/, "");
  for (const part of withoutDrive.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Directory of a normalised path, "" at the root (no trailing slash). */
export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

/** Lower-case extension without the dot ("" when there is none). Dot files have no extension. */
export function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function joinPath(dir: string, relative: string): string | null {
  return normalizePath(dir ? `${dir}/${relative}` : relative);
}

/** OS and archive clutter that is never part of a model (Finder metadata, AppleDouble files, thumbnails caches). */
export function isJunkPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.startsWith("__macosx/") || lower.includes("/__macosx/")) return true;
  if (lower.split("/").some((part) => part === ".git" || part === ".svn")) return true;
  const name = basename(lower);
  return JUNK_NAMES.has(name) || name.startsWith("._");
}

/** A reference that points off the device (http:, https:, ftp:, //host …). Such references are never followed. */
export function isRemoteReference(reference: string): boolean {
  const value = reference.trim();
  if (value.startsWith("//")) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  // One letter is a Windows drive ("C:"); file:, data: and blob: stay on this device.
  if (!scheme || scheme.length === 1) return false;
  return scheme !== "file" && scheme !== "data" && scheme !== "blob";
}

/** data: and blob: URLs: local to this document, safe to hand to a loader as they are. */
export function isLocalUrl(reference: string): boolean {
  return /^(data|blob):/i.test(reference.trim());
}

/** Strips query/fragment, decodes %xx where valid, and turns file:// URLs into paths. */
function cleanReference(reference: string): string {
  let value = reference.trim().replace(/[?#].*$/, "");
  if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\/(localhost)?/i, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep the raw text: "100%.png" is a valid file name
  }
  return value;
}

function isAbsoluteReference(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/** The selected files of one import, looked up case-insensitively. */
export class FileSet {
  private readonly byPath = new Map<string, FileEntry>();
  private readonly byName = new Map<string, FileEntry[]>();

  constructor(entries: Iterable<FileEntry>) {
    for (const entry of entries) {
      const key = entry.path.toLowerCase();
      if (this.byPath.has(key)) continue;
      this.byPath.set(key, entry);
      const name = basename(key);
      const list = this.byName.get(name);
      if (list) list.push(entry);
      else this.byName.set(name, [entry]);
    }
  }

  get size(): number {
    return this.byPath.size;
  }

  entries(): FileEntry[] {
    return [...this.byPath.values()];
  }

  get(path: string): FileEntry | undefined {
    return this.byPath.get(path.toLowerCase());
  }

  /**
   * Resolves a reference made by a file in `fromDir`: the relative path first, then (for absolute paths, Windows paths
   * and folders the person did not select) a unique file of the same name. Remote URLs never resolve.
   */
  resolve(reference: string, fromDir: string): FileEntry | undefined {
    if (!reference || isRemoteReference(reference) || isLocalUrl(reference)) return undefined;
    const value = cleanReference(reference);
    if (!value) return undefined;
    if (value.startsWith("/")) {
      // Selection-root-relative (how the importer anchors MTL references), or an absolute path from the author's disk.
      const rooted = normalizePath(value);
      const exact = rooted ? this.get(rooted) : undefined;
      if (exact) return exact;
    } else if (!isAbsoluteReference(value)) {
      const joined = joinPath(fromDir, value);
      const exact = joined === null ? undefined : this.get(joined);
      if (exact) return exact;
    }
    const normalised = normalizePath(value) ?? value.replace(/\\/g, "/");
    const name = basename(normalised).toLowerCase();
    const candidates = this.byName.get(name) ?? [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      // Prefer the candidate whose path ends with the most referenced folders ("…/textures/a.png"), then one next to
      // the referring file; otherwise the reference is ambiguous and stays unresolved.
      const segments = normalised.toLowerCase().split("/");
      for (let keep = segments.length; keep >= 2; keep--) {
        const suffix = segments.slice(segments.length - keep).join("/");
        const bySuffix = candidates.filter((entry) => {
          const path = entry.path.toLowerCase();
          return path === suffix || path.endsWith(`/${suffix}`);
        });
        if (bySuffix.length === 1) return bySuffix[0];
        if (bySuffix.length > 1) break;
      }
      const sibling = candidates.filter((entry) => dirname(entry.path).toLowerCase() === fromDir.toLowerCase());
      if (sibling.length === 1) return sibling[0];
    }
    return undefined;
  }
}
