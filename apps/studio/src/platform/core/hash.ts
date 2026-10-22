// SHA-256 through Web Crypto (globalThis.crypto.subtle: browsers in a secure context and Node 24). Inputs may come
// from a lab iframe, so Blobs and buffers are recognised by shape, not with instanceof.

import { PlatformError } from "./types";

export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** SHA-256 of zero bytes. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type HashInput = Blob | ArrayBuffer | ArrayBufferView | string;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte];
  return out;
}

const tagOf = (value: object): string => Object.prototype.toString.call(value);

/** A Blob or File from any realm. */
export function isBlobLike(value: unknown): value is Blob {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<Blob>;
  return typeof candidate.arrayBuffer === "function" && typeof candidate.size === "number" && typeof candidate.slice === "function";
}

function subtle(): SubtleCrypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) {
    throw new PlatformError("unknown", "Hashing needs a secure context (https or localhost).", { detail: "crypto.subtle" });
  }
  return crypto.subtle;
}

/** The bytes as an ArrayBuffer-backed view (Web Crypto refuses SharedArrayBuffer-backed views). */
async function toBytes(input: HashInput): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (isBlobLike(input)) return new Uint8Array(await input.arrayBuffer());
  if (ArrayBuffer.isView(input)) {
    if (tagOf(input.buffer) === "[object ArrayBuffer]") {
      return new Uint8Array(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength);
    }
    const copy = new Uint8Array(input.byteLength);
    copy.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    return copy;
  }
  if (tagOf(input) === "[object ArrayBuffer]") return new Uint8Array(input);
  throw new PlatformError("invalid_input", "Only Blobs, buffers and strings can be hashed.", { status: 422 });
}

/** Lower-case hex SHA-256 of a Blob, ArrayBuffer, typed array / DataView or string (UTF-8). */
export async function sha256Hex(input: HashInput): Promise<string> {
  const digest = await subtle().digest("SHA-256", await toBytes(input));
  return bytesToHex(new Uint8Array(digest));
}

const blobHashes = new WeakMap<Blob, Promise<string>>();

/** sha256Hex for Blobs, remembered per Blob object (Blobs are immutable): repeated saves of an unchanged attachment
 *  do not hash it again. */
export function sha256OfBlob(blob: Blob): Promise<string> {
  let pending = blobHashes.get(blob);
  if (!pending) {
    pending = sha256Hex(blob);
    blobHashes.set(blob, pending);
    pending.catch(() => blobHashes.delete(blob));
  }
  return pending;
}
