// Names for downloads: safe file names on every desktop OS, unique entry names inside a zip (case-insensitive, as macOS
// and Windows file systems are) and the name of the zip itself. Pure, so it is unit-tested in node.

// Windows forbids these in names; control characters are refused everywhere
const UNSAFE = /[\p{Cc}<>:"/\\|?*]/gu;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME = 120;

function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: "" };
  const extension = name.slice(dot);
  return extension.length > 12 ? { stem: name, extension: "" } : { stem: name.slice(0, dot), extension };
}

function clipPoints(text: string, limit: number): string {
  const points = [...text];
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

/** A file name that saves cleanly anywhere: no path separators or reserved characters, not hidden, at most 120 chars. */
export function safeFileName(name: string, fallback = "file"): string {
  let clean = name.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").replace(/[. ]+$/, "").trim();
  if (clean === "") clean = fallback;
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  if ([...clean].length <= MAX_NAME) return clean;
  const { stem, extension } = splitExtension(clean);
  return `${clipPoints(stem, MAX_NAME - [...extension].length).trimEnd()}${extension}`;
}

/** `name`, or "name 2.ext", "name 3.ext" … when the name (ignoring case) is taken; records the result in `used`. */
export function uniqueName(name: string, used: Set<string>): string {
  const { stem, extension } = splitExtension(name);
  let candidate = name;
  for (let index = 2; used.has(candidate.toLocaleLowerCase("en")); index += 1) candidate = `${stem} ${index}${extension}`;
  used.add(candidate.toLocaleLowerCase("en"));
  return candidate;
}

export interface ZipGroup {
  /** The item title: a folder when several items go into one zip, ignored for a single item. */
  title: string;
  filenames: readonly string[];
}

/**
 * Entry paths for a zip of one or more items: files of a single item sit at the top level; several items each get a
 * folder named after the item. Every path is unique; the result has one array of paths per group, in input order.
 */
export function zipEntryPaths(groups: readonly ZipGroup[]): string[][] {
  const single = groups.length === 1;
  const folders = new Set<string>();
  return groups.map((group) => {
    const folder = single ? "" : `${uniqueName(safeFileName(group.title, "Item"), folders)}/`;
    const used = new Set<string>();
    return group.filenames.map((filename) => `${folder}${uniqueName(safeFileName(filename), used)}`);
  });
}

/** "Liver v2.zip" for one item, "Library Items.zip" for several. */
export function zipFileName(titles: readonly string[]): string {
  if (titles.length === 1) return `${safeFileName(titles[0] ?? "", "Library Item")}.zip`;
  return "Library Items.zip";
}

/** Whether a file is worth compressing (text and JSON); images, video, GLB and archives are stored as they are. */
export function shouldCompress(filename: string, mimeType?: string | undefined): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("text/") || mime === "application/json") return true;
  return /\.(json|txt|csv|md|obj|mtl|gltf|ply|stl)$/i.test(filename);
}
