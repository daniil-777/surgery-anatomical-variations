// What an uploaded file becomes in the Library, decided from its first bytes (the name and the browser's type only break
// ties): images → "image", binary glTF → "model", MP4/WebM video → "recording". Everything else is refused with a sentence
// that says what to do instead. Pure: the page reads the first bytes and passes them in.
import type { AllowedMimeType, LibraryFileRole, LibraryKind } from "../../core/types";

export type UploadKind = Extract<LibraryKind, "image" | "model" | "recording">;

export interface UploadPlan {
  kind: UploadKind;
  /** The MIME type the asset is stored under (one of the bucket's allowed types). */
  mimeType: AllowedMimeType;
  /** The role of the file in the library item. */
  role: LibraryFileRole;
  /** Display name of the format ("PNG", "GLB", "WebM"). */
  format: string;
}

export type UploadDecision = { ok: true; plan: UploadPlan } | { ok: false; reason: string };

/** Bytes to read from the start of a file before deciding (enough for every signature below). */
export const UPLOAD_SNIFF_BYTES = 64;

/** For the file picker: what the Library accepts (validated again on drop and on pick). */
export const UPLOAD_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "model/gltf-binary",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".mp4",
  ".m4v",
  ".webm",
  ".glb",
].join(",");

export const UPLOAD_SUMMARY = "PNG, JPEG, WebP or AVIF images, GLB models, and MP4 or WebM videos";

const PLANS = {
  png: { kind: "image", mimeType: "image/png", role: "primary", format: "PNG" },
  jpeg: { kind: "image", mimeType: "image/jpeg", role: "primary", format: "JPEG" },
  webp: { kind: "image", mimeType: "image/webp", role: "primary", format: "WebP" },
  avif: { kind: "image", mimeType: "image/avif", role: "primary", format: "AVIF" },
  glb: { kind: "model", mimeType: "model/gltf-binary", role: "mesh", format: "GLB" },
  mp4: { kind: "recording", mimeType: "video/mp4", role: "video", format: "MP4" },
  webm: { kind: "recording", mimeType: "video/webm", role: "video", format: "WebM" },
} as const satisfies Record<string, UploadPlan>;

type PlanKey = keyof typeof PLANS;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = "";
  for (let index = start; index < Math.min(bytes.length, start + length); index += 1) text += String.fromCharCode(bytes[index] ?? 0);
  return text;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

type Sniffed = PlanKey | "gif" | "heic" | "quicktime" | "matroska" | "gltf-json" | "svg" | "bmp" | "tiff" | "pdf" | "zip" | null;

/** The format from the first bytes, or null when no signature matched. */
export function sniffUpload(bytes: Uint8Array): Sniffed {
  if (bytes.length < 4) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (ascii(bytes, 0, 4) === "glTF") return "glb";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 0, 2) === "BM") return "bmp";
  if (ascii(bytes, 0, 4) === "II*\0" || ascii(bytes, 0, 4) === "MM\0*") return "tiff";
  if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML: WebM declares the doctype "webm"; anything else is a Matroska file the bucket does not take
    return ascii(bytes, 0, bytes.length).includes("webm") ? "webm" : "matroska";
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
    if (brand === "qt  ") return "quicktime";
    return "mp4";
  }
  const text = ascii(bytes, 0, bytes.length).replace(/^﻿/, "").trimStart();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return "svg";
  if (text.startsWith("{") && /"asset"|"scenes"|"meshes"|"buffers"/.test(text)) return "gltf-json";
  return null;
}

export function fileExtension(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const EXTENSION_GUESS: Record<string, Sniffed> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  jpe: "jpeg",
  webp: "webp",
  avif: "avif",
  glb: "glb",
  mp4: "mp4",
  m4v: "mp4",
  webm: "webm",
  gif: "gif",
  heic: "heic",
  heif: "heic",
  mov: "quicktime",
  qt: "quicktime",
  mkv: "matroska",
  gltf: "gltf-json",
  svg: "svg",
  bmp: "bmp",
  tif: "tiff",
  tiff: "tiff",
  pdf: "pdf",
  zip: "zip",
};

const IMPORT_FORMATS = new Set(["obj", "fbx", "stl", "ply", "usdz", "dae", "blend", "unitypackage", "3ds", "max", "c4d", "ma", "mb"]);

function refusal(sniffed: Exclude<Sniffed, PlanKey | null>, name: string): string {
  switch (sniffed) {
    case "gif":
      return `“${name}” is a GIF. Upload PNG, JPEG, WebP or AVIF images instead.`;
    case "heic":
      return `“${name}” is a HEIC photo. Export it as JPEG or PNG, then upload it.`;
    case "quicktime":
      return `“${name}” is a QuickTime movie. Export it as MP4 (H.264) or WebM, then upload it.`;
    case "matroska":
      return `“${name}” is a Matroska video. Convert it to MP4 or WebM, then upload it.`;
    case "gltf-json":
      return `“${name}” is a glTF text file. Upload a binary .glb, or bring the .gltf with its files in through Imports.`;
    case "svg":
      return `“${name}” is an SVG drawing, which the Library can’t store. Export it as PNG.`;
    case "bmp":
    case "tiff":
      return `“${name}” can’t be stored as an image. Convert it to PNG or JPEG, then upload it.`;
    case "pdf":
      return `“${name}” is a PDF, which the Library can’t store.`;
    case "zip":
      return `“${name}” is a ZIP archive. Bring 3D files from Unity or Blender in through Imports.`;
  }
}

/**
 * Decides what `file` becomes. `head` is the start of the file (UPLOAD_SNIFF_BYTES); without it, the name and type
 * decide. A signature always wins over the name, so a renamed file is stored as what it really is.
 */
export function inferUpload(file: { name: string; type: string; size: number }, head?: Uint8Array): UploadDecision {
  const name = displayName(file.name);
  if (!(file.size > 0)) return { ok: false, reason: `“${name}” is empty.` };
  const extension = fileExtension(file.name);
  const sniffed = head && head.length > 0 ? sniffUpload(head) : null;
  const typeGuess = mimeGuess(file.type);
  const guess = sniffed ?? EXTENSION_GUESS[extension] ?? typeGuess;
  if (guess && guess in PLANS) return { ok: true, plan: { ...PLANS[guess as PlanKey] } };
  if (guess) return { ok: false, reason: refusal(guess as Exclude<Sniffed, PlanKey | null>, name) };
  if (IMPORT_FORMATS.has(extension)) {
    return { ok: false, reason: `“${name}” is a ${extension.toUpperCase()} file. Bring 3D files from other apps in through Imports.` };
  }
  return { ok: false, reason: `“${name}” isn’t a file the Library can store. You can upload ${UPLOAD_SUMMARY}.` };
}

function mimeGuess(type: string): Sniffed {
  const base = type.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpeg";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "model/gltf-binary":
      return "glb";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "image/gif":
      return "gif";
    case "image/heic":
    case "image/heif":
      return "heic";
    case "video/quicktime":
      return "quicktime";
    case "image/svg+xml":
      return "svg";
    default:
      return null;
  }
}

function lastSegment(name: string): string {
  return name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).trim();
}

/** The last path segment, for messages. */
export function displayName(name: string): string {
  const base = lastSegment(name);
  return base === "" ? "Untitled" : base;
}

// library_item_files.filename: 1-180 characters, no slash, backslash or control character, no leading "." and no
// leading or trailing spaces (memory/rules.ts restates the database rule).
const FILENAME_LIMIT = 180;
const TITLE_LIMIT = 120;

function codePoints(text: string): string[] {
  return [...text];
}

function clip(text: string, limit: number): string {
  const points = codePoints(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

/** A filename the database accepts, keeping the extension when the name has to be shortened. */
export function libraryFilename(name: string, fallbackExtension = ""): string {
  let base = lastSegment(name)
    .replace(/[\p{Cc}/\\]/gu, "")
    .replace(/^[ .]+/, "")
    .replace(/ +$/, "");
  if (base === "") base = fallbackExtension ? `file.${fallbackExtension}` : "file";
  if (codePoints(base).length <= FILENAME_LIMIT) return base;
  const extension = fileExtension(base);
  const suffix = extension && extension.length <= 10 ? `.${extension}` : "";
  const stem = clip(base.slice(0, base.length - suffix.length), FILENAME_LIMIT - codePoints(suffix).length).replace(/ +$/, "");
  return `${stem}${suffix}`;
}

/** The item title for an uploaded file: its name without the extension, tidied and within 120 characters. */
export function titleFromFilename(name: string): string {
  const base = displayName(name);
  const extension = fileExtension(base);
  const stem = extension ? base.slice(0, base.length - extension.length - 1) : base;
  const tidy = stem.replace(/[\p{Cc}]/gu, " ").replace(/\s+/g, " ").trim();
  const title = clip(tidy, TITLE_LIMIT).trim();
  return title === "" ? "Untitled" : title;
}
