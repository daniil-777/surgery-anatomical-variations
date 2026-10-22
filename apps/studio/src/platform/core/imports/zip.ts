// Zip bundles (a model plus its textures, as Sketchfab and many asset stores ship them), USDZ packages and the zip
// that keeps a multi-file selection together as one original. The central directory is read first so that encrypted
// entries, unknown compression and zip bombs are refused before fflate allocates anything: fflate inflates each entry
// into a buffer of its declared size, so capping the declared sizes caps memory.

import { unzipSync, zipSync, type Zippable } from "fflate";
import { readU16, readU32, readU64 } from "./bytes";
import { importRefusal } from "./errors";
import { IMPORT_LIMITS, formatBytes } from "./limits";
import { extension, isJunkPath, normalizePath, type FileEntry } from "./paths";

export interface ZipEntryInfo {
  /** Name exactly as fflate reports it (UTF-8 when flagged, else one character per byte). */
  name: string;
  compressedSize: number;
  size: number;
  /** 0 stored, 8 deflate; anything else is refused. */
  method: number;
  encrypted: boolean;
  directory: boolean;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;

/** Already-compressed content is stored, everything else deflated, when building a zip. */
const STORED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "ktx2", "glb", "zip", "usdz", "mp4", "webm", "gz"]);

/** A date fflate accepts in every time zone, so identical selections produce identical (deduplicated) zips. */
const FIXED_MTIME = new Date(2000, 0, 1, 12, 0, 0);

const utf8 = new TextDecoder("utf-8");

const REZIP = "Create the zip again, or select the model's files directly.";
const FEWER_FILES = "Zip only the model and the textures it uses.";

function byteString(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
}

function entryName(bytes: Uint8Array, flags: number): string {
  return flags & 0x800 ? utf8.decode(bytes) : byteString(bytes);
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && readU32(bytes, 0) === LOCAL_HEADER;
}

export function isEmptyZip(bytes: Uint8Array): boolean {
  return bytes.length >= 22 && readU32(bytes, 0) === END_OF_CENTRAL;
}

/** Name of the first local entry: the root layer of a USDZ package. Works on the first bytes of a file alone. */
export function firstEntryName(bytes: Uint8Array): string | null {
  if (!isZip(bytes) || bytes.length < 30) return null;
  const flags = readU16(bytes, 6);
  const nameLength = readU16(bytes, 26);
  if (30 + nameLength > bytes.length) return null;
  return entryName(bytes.subarray(30, 30 + nameLength), flags);
}

function corrupt(name: string): never {
  throw importRefusal(`${name} is not a readable zip file (its directory is damaged or truncated).`, "zip-corrupt", { advice: REZIP });
}

/** The central directory, in archive order. */
export function listZip(bytes: Uint8Array, label = "The zip file", maxRecords: number = IMPORT_LIMITS.zipRecords): ZipEntryInfo[] {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (readU32(bytes, i) === END_OF_CENTRAL) {
      end = i;
      break;
    }
  }
  if (end < 0) corrupt(label);
  let count = readU16(bytes, end + 10);
  let offset = readU32(bytes, end + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || readU32(bytes, locator) !== ZIP64_LOCATOR) corrupt(label);
    const record = readU64(bytes, locator + 8);
    if (!Number.isSafeInteger(record) || record + 56 > bytes.length || readU32(bytes, record) !== ZIP64_END) corrupt(label);
    count = readU64(bytes, record + 32);
    offset = readU64(bytes, record + 48);
  }
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(offset)) corrupt(label);
  if (count > maxRecords) {
    throw importRefusal(`${label} lists ${count} entries; at most ${maxRecords} can be read.`, "zip-too-many-entries", { code: "limit_reached", advice: FEWER_FILES });
  }
  const entries: ZipEntryInfo[] = [];
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || readU32(bytes, at) !== CENTRAL_HEADER) corrupt(label);
    const flags = readU16(bytes, at + 8);
    const method = readU16(bytes, at + 10);
    let compressedSize = readU32(bytes, at + 20);
    let size = readU32(bytes, at + 24);
    const nameLength = readU16(bytes, at + 28);
    const extraLength = readU16(bytes, at + 30);
    const commentLength = readU16(bytes, at + 32);
    const nameStart = at + 46;
    if (nameStart + nameLength + extraLength > bytes.length) corrupt(label);
    const name = entryName(bytes.subarray(nameStart, nameStart + nameLength), flags);
    if (size === 0xffffffff || compressedSize === 0xffffffff) {
      // Zip64 extra field: uncompressed then compressed size, each present only when its 32-bit field is saturated.
      let extra = nameStart + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = readU16(bytes, extra);
        const length = readU16(bytes, extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (size === 0xffffffff) {
            size = readU64(bytes, field);
            field += 8;
          }
          if (compressedSize === 0xffffffff) compressedSize = readU64(bytes, field);
          break;
        }
        extra += 4 + length;
      }
      if (!Number.isSafeInteger(size) || !Number.isSafeInteger(compressedSize)) corrupt(label);
    }
    entries.push({ name, compressedSize, size, method, encrypted: (flags & 1) === 1, directory: name.endsWith("/") });
    at = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

export interface ZipBudget {
  /** Most uncompressed bytes the kept entries may declare in total. */
  analysisBytes: number;
  /** Most kept entries. */
  maxFiles?: number;
}

/**
 * Checks the entries that would be extracted against the budget and refuses encrypted entries, unsupported
 * compression and implausible compression ratios. Returns the entries that pass `keep`.
 */
export function checkZipEntries(entries: ZipEntryInfo[], budget: ZipBudget, label: string, keep: (entry: ZipEntryInfo) => boolean = () => true): ZipEntryInfo[] {
  const kept = entries.filter((entry) => !entry.directory && keep(entry));
  const maxFiles = budget.maxFiles ?? IMPORT_LIMITS.files;
  if (kept.length > maxFiles) {
    throw importRefusal(`${label} holds ${kept.length} files; an import can use at most ${maxFiles}.`, "zip-too-many-files", { code: "limit_reached", advice: FEWER_FILES });
  }
  let total = 0;
  for (const entry of kept) {
    if (entry.encrypted) {
      throw importRefusal(`${label} is password-protected (${entry.name}).`, "zip-encrypted", { advice: "Zip the files again without a password." });
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw importRefusal(`${label} uses a compression method this browser importer can't read (${entry.name}, method ${entry.method}).`, "zip-method", {
        advice: "Create the zip again with standard (deflate) compression.",
      });
    }
    if (entry.size >= IMPORT_LIMITS.zipRatioMinBytes && (entry.compressedSize === 0 || entry.size / entry.compressedSize > IMPORT_LIMITS.zipRatio)) {
      throw importRefusal(
        `${label} contains ${entry.name}, which expands ${entry.compressedSize === 0 ? "from nothing" : `${Math.round(entry.size / entry.compressedSize)}×`} — too much to be a normal 3D file.`,
        "zip-ratio",
        { code: "limit_reached" },
      );
    }
    total += entry.size;
  }
  if (total > budget.analysisBytes) {
    throw importRefusal(
      `${label} expands to ${formatBytes(total)}; an import can unpack at most ${formatBytes(budget.analysisBytes)}.`,
      "zip-too-large",
      { code: "file_too_large", advice: FEWER_FILES },
    );
  }
  return kept;
}

export interface ExtractedZip {
  entries: FileEntry[];
  /** Names left out: junk, folders, or names that escape the archive. */
  skipped: string[];
}

/** Extracts the useful entries of a zip bundle after the checks above. Junk (__MACOSX, .DS_Store …) is left out. */
export function extractZip(bytes: Uint8Array, budget: ZipBudget, label = "The zip file"): ExtractedZip {
  const listing = listZip(bytes, label);
  const skipped: string[] = [];
  const pathOf = new Map<string, string>();
  const kept = checkZipEntries(listing, budget, label, (entry) => {
    const path = normalizePath(entry.name);
    if (path === null || path === "" || isJunkPath(path)) {
      skipped.push(entry.name);
      return false;
    }
    pathOf.set(entry.name, path);
    return true;
  });
  const wanted = new Set(kept.map((entry) => entry.name));
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => wanted.has(file.name) });
  } catch (error) {
    throw importRefusal(`${label} could not be unpacked (${error instanceof Error ? error.message : "unknown error"}).`, "zip-corrupt", { advice: REZIP, cause: error });
  }
  const entries: FileEntry[] = [];
  const seen = new Set<string>();
  for (const entry of kept) {
    const data = files[entry.name];
    // fflate never writes past the declared size; a shorter result means a damaged stream.
    if (!data || data.length !== entry.size) corrupt(label);
    const path = pathOf.get(entry.name) ?? entry.name;
    if (seen.has(path.toLowerCase())) {
      skipped.push(entry.name);
      continue;
    }
    seen.add(path.toLowerCase());
    entries.push({ path, bytes: data });
  }
  return { entries, skipped };
}

/** One zip holding every file of a selection, paths kept, so the original can be stored as a single asset. */
export function zipFiles(files: FileEntry[]): Uint8Array {
  const input: Zippable = {};
  for (const file of files) {
    input[file.path] = [file.bytes, { level: STORED_EXTENSIONS.has(extension(file.path)) ? 0 : 6, mtime: FIXED_MTIME }];
  }
  return zipSync(input);
}

/** Rewrites a zip so that the given entries come first, with new names (used to lift a USDZ root layer to the top). */
export function rezip(entries: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
  const input: Zippable = {};
  for (const entry of entries) input[entry.name] = [entry.bytes, { level: 0, mtime: FIXED_MTIME }];
  return zipSync(input);
}
