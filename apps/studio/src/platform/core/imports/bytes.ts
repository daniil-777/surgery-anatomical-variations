// Byte and text helpers shared by sniffing, header readers and zip handling. DOM-free and three-free.

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

/** Bytes as single-byte characters (lossless for ASCII signatures; never throws). */
export function latin1Text(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return latin1.decode(bytes.subarray(Math.max(0, start), Math.min(bytes.length, end)));
}

/** UTF-8 text without a byte-order mark; invalid sequences become U+FFFD instead of throwing. */
export function utf8Text(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let from = Math.max(0, start);
  if (bytes[from] === 0xef && bytes[from + 1] === 0xbb && bytes[from + 2] === 0xbf) from += 3;
  return utf8.decode(bytes.subarray(from, Math.min(bytes.length, end)));
}

export function startsWithAscii(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

export function indexOfAscii(bytes: Uint8Array, text: string, from = 0, to = bytes.length): number {
  const first = text.charCodeAt(0);
  const last = Math.min(bytes.length, to) - text.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    if (bytes[i] === first && startsWithAscii(bytes, text, i)) return i;
  }
  return -1;
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)) + (bytes[offset + 3] ?? 0) * 0x1000000;
}

/** Unsigned 64-bit little-endian as a number; values above 2^53 come back as Infinity so callers treat them as corrupt. */
export function readU64(bytes: Uint8Array, offset: number): number {
  const low = readU32(bytes, offset);
  const high = readU32(bytes, offset + 4);
  if (high >= 0x200000) return Number.POSITIVE_INFINITY;
  return high * 0x100000000 + low;
}

export function readU32BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) * 0x1000000 + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
}

export function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

/** The exact bytes as a standalone ArrayBuffer (three.js loaders take ArrayBuffers, not views). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** The bytes as a Blob part: views over a plain ArrayBuffer as they are, anything else (a shared buffer) copied. */
export function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/**
 * True when the sample looks like text: at most 1 % control characters (NUL included — some exporters pad text files
 * with a trailing NUL, while binary model formats are full of them).
 */
export function looksLikeText(bytes: Uint8Array, sample = 4096): boolean {
  const end = Math.min(bytes.length, sample);
  let control = 0;
  for (let i = 0; i < end; i++) {
    const value = bytes[i]!;
    if (value < 9 || (value > 13 && value < 32)) control++;
  }
  return control <= end / 100;
}

/** Collapses whitespace and control characters and caps the length (for evidence and detail strings). */
export function cleanLabel(value: string, max = 200): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}
