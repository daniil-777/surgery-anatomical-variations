// Texture images recognised from their first bytes, with their pixel size read from the header, so that oversized or
// undecodable textures are refused before a browser decoder allocates them. TGA has no signature and is recognised
// from its file name.

import { readU16, readU16BE, readU32, readU32BE, startsWithAscii, indexOfAscii } from "./bytes";

export type ImageKind =
  | "png"
  | "jpeg"
  | "webp"
  | "gif"
  | "bmp"
  | "avif"
  | "tga"
  | "tiff"
  | "ktx2"
  | "ktx"
  | "dds"
  | "psd"
  | "exr"
  | "hdr"
  | "unknown";

/** Decoded by the browser's <img> (png … avif) or by three.js loaders (tga, tiff). */
export const DECODABLE_IMAGES: ReadonlySet<ImageKind> = new Set<ImageKind>(["png", "jpeg", "webp", "gif", "bmp", "avif", "tga", "tiff"]);

const IMAGE_EXTENSIONS: Record<string, ImageKind> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  jpe: "jpeg",
  webp: "webp",
  gif: "gif",
  bmp: "bmp",
  avif: "avif",
  tga: "tga",
  tif: "tiff",
  tiff: "tiff",
  ktx2: "ktx2",
  ktx: "ktx",
  dds: "dds",
  psd: "psd",
  exr: "exr",
  hdr: "hdr",
};

export function imageKindFromExtension(ext: string): ImageKind | null {
  return IMAGE_EXTENSIONS[ext.toLowerCase()] ?? null;
}

const MIME: Partial<Record<ImageKind, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  avif: "image/avif",
};

export function imageMime(kind: ImageKind): string | null {
  return MIME[kind] ?? null;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KTX2 = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];
const KTX1 = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb];

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/** The image format from its signature; `extensionHint` only decides formats without one (TGA). */
export function imageKind(bytes: Uint8Array, extensionHint = ""): ImageKind {
  if (startsWithBytes(bytes, PNG)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (startsWithAscii(bytes, "RIFF") && startsWithAscii(bytes, "WEBP", 8)) return "webp";
  if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) return "gif";
  if (startsWithAscii(bytes, "ftyp", 4) && (startsWithAscii(bytes, "avif", 8) || startsWithAscii(bytes, "avis", 8))) return "avif";
  if (startsWithAscii(bytes, "II*\0") || startsWithAscii(bytes, "MM\0*")) return "tiff";
  if (startsWithBytes(bytes, KTX2)) return "ktx2";
  if (startsWithBytes(bytes, KTX1)) return "ktx";
  if (startsWithAscii(bytes, "DDS ")) return "dds";
  if (startsWithAscii(bytes, "8BPS")) return "psd";
  if (bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) return "exr";
  if (startsWithAscii(bytes, "#?RADIANCE") || startsWithAscii(bytes, "#?RGBE")) return "hdr";
  if (startsWithAscii(bytes, "BM") && bytes.length >= 26 && [12, 40, 52, 56, 108, 124].includes(readU32(bytes, 14))) return "bmp";
  if (extensionHint.toLowerCase() === "tga" && looksLikeTga(bytes)) return "tga";
  return "unknown";
}

function looksLikeTga(bytes: Uint8Array): boolean {
  if (bytes.length < 18) return false;
  const colorMapType = bytes[1]!;
  const imageType = bytes[2]!;
  const depth = bytes[16]!;
  return colorMapType <= 1 && [1, 2, 3, 9, 10, 11].includes(imageType) && [8, 15, 16, 24, 32].includes(depth);
}

export interface ImageSize {
  width: number;
  height: number;
}

/** Pixel size from the header, or null when the header does not say (or the format is not recognised). */
export function imageSize(bytes: Uint8Array, kind: ImageKind = imageKind(bytes)): ImageSize | null {
  const size = (width: number, height: number): ImageSize | null => (width > 0 && height > 0 ? { width, height } : null);
  switch (kind) {
    case "png":
      return bytes.length >= 24 && startsWithAscii(bytes, "IHDR", 12) ? size(readU32BE(bytes, 16), readU32BE(bytes, 20)) : null;
    case "jpeg":
      return jpegSize(bytes);
    case "gif":
      return bytes.length >= 10 ? size(readU16(bytes, 6), readU16(bytes, 8)) : null;
    case "webp":
      return webpSize(bytes);
    case "bmp": {
      if (bytes.length < 26) return null;
      if (readU32(bytes, 14) === 12) return size(readU16(bytes, 18), readU16(bytes, 20));
      const height = readU32(bytes, 22);
      return size(readU32(bytes, 18) | 0, Math.abs(height | 0));
    }
    case "tga":
      return bytes.length >= 18 ? size(readU16(bytes, 12), readU16(bytes, 14)) : null;
    case "tiff":
      return tiffSize(bytes);
    case "avif": {
      const at = indexOfAscii(bytes, "ispe", 0, Math.min(bytes.length, 65536));
      return at >= 0 && at + 16 <= bytes.length ? size(readU32BE(bytes, at + 8), readU32BE(bytes, at + 12)) : null;
    }
    case "ktx2":
      return bytes.length >= 28 ? size(readU32(bytes, 20), readU32(bytes, 24)) : null;
    case "dds":
      return bytes.length >= 20 ? size(readU32(bytes, 16), readU32(bytes, 12)) : null;
    case "psd":
      return bytes.length >= 22 ? size(readU32BE(bytes, 18), readU32BE(bytes, 14)) : null;
    default:
      return null;
  }
}

const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = readU16BE(bytes, at);
    if (length < 2) return null;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (at + 7 > bytes.length) return null;
      const height = readU16BE(bytes, at + 3);
      const width = readU16BE(bytes, at + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  if (startsWithAscii(bytes, "VP8X", 12)) {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { width, height };
  }
  if (startsWithAscii(bytes, "VP8L", 12)) {
    const bits = readU32(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (startsWithAscii(bytes, "VP8 ", 12)) {
    const width = readU16(bytes, 26) & 0x3fff;
    const height = readU16(bytes, 28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

function tiffSize(bytes: Uint8Array): ImageSize | null {
  const little = bytes[0] === 0x49;
  const u16 = (at: number) => (little ? readU16(bytes, at) : readU16BE(bytes, at));
  const u32 = (at: number) => (little ? readU32(bytes, at) : readU32BE(bytes, at));
  const ifd = u32(4);
  if (ifd + 2 > bytes.length) return null;
  const count = u16(ifd);
  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > bytes.length) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  return width > 0 && height > 0 ? { width, height } : null;
}
