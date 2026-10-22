import { describe, expect, it } from "vitest";
import { bytesToHex, EMPTY_SHA256, isBlobLike, isSha256Hex, sha256Hex, sha256OfBlob } from "./hash";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
// FIPS 180-2 two-block message
const LONG_MESSAGE = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
const LONG = "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1";

describe("sha256Hex", () => {
  it("matches the FIPS 180-2 vectors for strings", async () => {
    expect(await sha256Hex("")).toBe(EMPTY_SHA256);
    expect(await sha256Hex("abc")).toBe(ABC);
    expect(await sha256Hex(LONG_MESSAGE)).toBe(LONG);
  });

  it("hashes UTF-8 for strings and gives the same digest for every input form", async () => {
    const text = "Leber · Gefäß 😀";
    const bytes = new TextEncoder().encode(text);
    const expected = await sha256Hex(text);
    expect(await sha256Hex(bytes)).toBe(expected);
    expect(await sha256Hex(bytes.buffer)).toBe(expected);
    expect(await sha256Hex(new Blob([bytes]))).toBe(expected);
    expect(await sha256Hex(new DataView(bytes.buffer))).toBe(expected);
  });

  it("respects the view's offset and length", async () => {
    const padded = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]);
    expect(await sha256Hex(padded.subarray(1, 4))).toBe(ABC);
    expect(await sha256Hex(new DataView(padded.buffer, 1, 3))).toBe(ABC);
  });

  it("copies SharedArrayBuffer-backed views (Web Crypto refuses them)", async () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set([0x61, 0x62, 0x63]);
    expect(await sha256Hex(shared)).toBe(ABC);
  });

  it("hashes a large Blob", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).map((_, index) => index % 251);
    expect(await sha256Hex(new Blob([big]))).toBe(await sha256Hex(big));
  });

  it("remembers the digest per Blob object", async () => {
    const blob = new Blob(["abc"]);
    const first = sha256OfBlob(blob);
    expect(sha256OfBlob(blob)).toBe(first);
    expect(await first).toBe(ABC);
  });
});

describe("hash helpers", () => {
  it("validates hex digests", () => {
    expect(isSha256Hex(ABC)).toBe(true);
    expect(isSha256Hex(ABC.toUpperCase())).toBe(false);
    expect(isSha256Hex(ABC.slice(1))).toBe(false);
    expect(isSha256Hex(null)).toBe(false);
  });

  it("formats bytes as lower-case hex and recognises Blobs by shape", () => {
    expect(bytesToHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
    expect(isBlobLike(new Blob(["x"]))).toBe(true);
    expect(isBlobLike({ size: 1, arrayBuffer: () => null, slice: () => null })).toBe(true);
    expect(isBlobLike({ size: 1 })).toBe(false);
    expect(isBlobLike(null)).toBe(false);
  });
});
