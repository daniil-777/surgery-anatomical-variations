import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fixture from "../../../../tests/fixtures/tissue-pbr/software-material.tissue-pbr.json";
import { importTissuePbrBundle } from "./pbrBundle";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const source = JSON.stringify(fixture);
const closed: Array<ReturnType<typeof vi.fn>> = [];
// Node checks parsing/ownership contracts only. The real PNG decoder is exercised
// by the browser suite with this explicitly labelled software fixture.
const decode = vi.fn(async (_blob: Blob) => {
  const close = vi.fn(); closed.push(close); return { width: 16, height: 16, close };
});
function changed(mutate: (bundle: typeof fixture) => void) {
  const copy = structuredClone(fixture); mutate(copy); return JSON.stringify(copy);
}
beforeEach(() => { closed.length = 0; decode.mockClear(); vi.stubGlobal("createImageBitmap", decode); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("data-only local PBR material bundles", () => {
  it("imports all declared software-fixture bytes with exact seed and source digest, closing temporary bitmap memory", async () => {
    const imported = await importTissuePbrBundle(source);
    expect(imported.digest).toBe(sha256(source));
    expect(imported.manifest.resolution).toEqual([16, 16]);
    expect(imported.manifest.recipe.seed).toBe("18446744073709551615");
    expect(JSON.parse(imported.manifestSource).recipe.seed).toBe("18446744073709551615");
    expect(imported.manifest.provenance).toMatchObject({ fixture: true, source_type: "deterministic-software-test-fixture", clinically_validated: false, patient_specific: false });
    expect(imported.files.size).toBe(7); expect(decode).toHaveBeenCalledTimes(7);
    for (const file of fixture.files) {
      const blob = imported.files.get(file.file)!;
      expect(blob.type).toBe("image/png");
      expect(Buffer.from(await blob.arrayBuffer())).toEqual(Buffer.from(file.pngBase64, "base64"));
    }
    closed.forEach(close => expect(close).toHaveBeenCalledTimes(1));
  });

  it.each(["{", "null", "[]", "{}", '{"schema":"other","files":[]}'])("rejects malformed or unsupported JSON %s", async value => {
    await expect(importTissuePbrBundle(value)).rejects.toThrow(); expect(decode).not.toHaveBeenCalled();
  });

  it("rejects oversized source text before parsing or allocating bitmaps", async () => {
    await expect(importTissuePbrBundle(" ".repeat(32 * 1024 * 1024 + 1))).rejects.toThrow(/32 MiB/);
    expect(decode).not.toHaveBeenCalled();
  });

  it.each([[0, 0], [15, 15], [16, 17], [2048, 2048], [16.5, 16.5]])("rejects unsupported dimensions %j", async (width, height) => {
    await expect(importTissuePbrBundle(changed(value => { value.manifest.resolution = [width, height]; }))).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it("requires executed provenance and matching native dimensions", async () => {
    for (const mutate of [
      (value: typeof fixture) => { value.manifest.provenance.executed = false; },
      (value: typeof fixture) => { value.manifest.provenance.native_resolution = [16, 32]; },
      (value: typeof fixture) => { value.manifest.provenance.native_resolution = [32, 32]; },
      (value: typeof fixture) => { value.manifest.provenance.native_resolution = []; },
    ]) await expect(importTissuePbrBundle(changed(mutate))).rejects.toThrow(/provenance|native/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(["042", "-1", "18446744073709551616", "1e3", 18446744073709551615])("rejects ambiguous or out-of-range uint64 seed %s", async seed => {
    await expect(importTissuePbrBundle(changed(value => { value.manifest.recipe.seed = seed as string; }))).rejects.toThrow(/uint64/);
  });

  it.each(["../source.png", "/tmp/source.png", "https://example.com/source.png", "source.png?token=x", "blob:source", "data:image/png;base64,AAAA"]) ("rejects unsafe declared or embedded file path %s before decoding", async file => {
    await expect(importTissuePbrBundle(changed(value => { value.manifest.channels.substrate.file = file; }))).rejects.toThrow(/path/);
    await expect(importTissuePbrBundle(changed(value => { value.files[0]!.file = file; }))).rejects.toThrow(/path/);
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects duplicate, missing, unreferenced and conflicting files", async () => {
    for (const mutate of [
      (value: typeof fixture) => { value.files.pop(); },
      (value: typeof fixture) => { value.files[1] = value.files[0]!; },
      (value: typeof fixture) => { value.files[0]!.file = "unreferenced.png"; },
      (value: typeof fixture) => { value.files.push({ ...value.files[0]!, file: "extra.png" }); },
      (value: typeof fixture) => { value.manifest.channels.normal.file = value.manifest.channels.substrate.file; },
    ]) await expect(importTissuePbrBundle(changed(mutate))).rejects.toThrow(/Unsupported|duplicate|unreferenced|Missing|Conflicting/);
  });

  it("rejects altered bytes, invalid hashes and inconsistent byte counts", async () => {
    await expect(importTissuePbrBundle(changed(value => {
      const bytes = Buffer.from(value.files[0]!.pngBase64, "base64"); bytes[bytes.length - 1]! ^= 1;
      value.files[0]!.pngBase64 = bytes.toString("base64");
    }))).rejects.toThrow(/checksum/);
    for (const bytes of [0, -1, 1.5, 8 * 1024 * 1024 + 1]) {
      await expect(importTissuePbrBundle(changed(value => { value.manifest.channels.substrate.bytes = bytes; }))).rejects.toThrow(/byte count/);
    }
    await expect(importTissuePbrBundle(changed(value => { value.manifest.channels.substrate.bytes++; }))).rejects.toThrow(/byte count mismatch/);
    await expect(importTissuePbrBundle(changed(value => { value.manifest.channels.substrate.sha256 = "bad"; }))).rejects.toThrow(/SHA-256/);
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(["%%%", "AAAA=", "AA==\n", "data:image/png;base64,AAAA"]) ("rejects malformed base64 %s", async encoded => {
    await expect(importTissuePbrBundle(changed(value => { value.files[0]!.pngBase64 = encoded; }))).rejects.toThrow(/Invalid/);
    expect(decode).not.toHaveBeenCalled();
  });

  it("checks PNG signature and IHDR dimensions even when their declared digest is updated", async () => {
    for (const mutate of [(bytes: Buffer) => { bytes[0] = 0; }, (bytes: Buffer) => { bytes.writeUInt32BE(17, 16); }]) {
      await expect(importTissuePbrBundle(changed(value => {
        const bytes = Buffer.from(value.files[0]!.pngBase64, "base64"); mutate(bytes);
        value.files[0]!.pngBase64 = bytes.toString("base64"); value.manifest.channels.substrate.sha256 = sha256(bytes);
      }))).rejects.toThrow(/dimensions\/header/);
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it("propagates real decoder rejection and closes bitmaps with inconsistent decoded dimensions", async () => {
    decode.mockRejectedValueOnce(new Error("PNG decoder rejected data"));
    await expect(importTissuePbrBundle(source)).rejects.toThrow(/decoder rejected/);
    const close = vi.fn(); decode.mockResolvedValueOnce({ width: 32, height: 16, close });
    await expect(importTissuePbrBundle(source)).rejects.toThrow(/Decoded.*dimensions/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects a pre-aborted import before parsing, allocating or hashing image data", async () => {
    const controller = new AbortController(); controller.abort();
    const hash = vi.spyOn(crypto.subtle, "digest"), base64 = vi.spyOn(globalThis, "atob");
    await expect(importTissuePbrBundle("invalid JSON", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(hash).not.toHaveBeenCalled(); expect(base64).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
  });

  it("cancels promptly while a non-abortable digest is pending and never starts decoding", async () => {
    const controller = new AbortController();
    let finish!: (value: ArrayBuffer) => void;
    const hash = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { finish = resolve; }));
    const importing = importTissuePbrBundle(source, controller.signal);
    expect(hash).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(importing).rejects.toMatchObject({ name: "AbortError" });
    finish(new ArrayBuffer(32));
    await Promise.resolve(); await Promise.resolve();
    expect(hash).toHaveBeenCalledTimes(1); expect(decode).not.toHaveBeenCalled();
  });

  it("cancels a pending PNG decoder and closes its late bitmap exactly once", async () => {
    const controller = new AbortController(), close = vi.fn();
    let finish!: (value: { width: number; height: number; close: typeof close }) => void;
    decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const importing = importTissuePbrBundle(source, controller.signal);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(importing).rejects.toMatchObject({ name: "AbortError" });
    expect(close).not.toHaveBeenCalled();
    finish({ width: 16, height: 16, close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("consumes a pending decoder rejection after cancellation without resuming the import", async () => {
    const controller = new AbortController();
    let fail!: (reason: Error) => void;
    decode.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const importing = importTissuePbrBundle(source, controller.signal);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(importing).rejects.toMatchObject({ name: "AbortError" });
    fail(new Error("Late decoder failure"));
    await Promise.resolve(); await Promise.resolve();
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("cancels the final source hash after all bitmaps have been released", async () => {
    const controller = new AbortController();
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let finish!: (value: ArrayBuffer) => void;
    const hash = vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
      if (hash.mock.calls.length === fixture.files.length + 1) return new Promise<ArrayBuffer>(resolve => { finish = resolve; });
      return original(algorithm, data);
    });
    const importing = importTissuePbrBundle(source, controller.signal);
    await vi.waitFor(() => expect(hash).toHaveBeenCalledTimes(fixture.files.length + 1));
    controller.abort();
    await expect(importing).rejects.toMatchObject({ name: "AbortError" });
    closed.forEach(close => expect(close).toHaveBeenCalledTimes(1));
    finish(new ArrayBuffer(32));
    await Promise.resolve(); await Promise.resolve();
    expect(decode).toHaveBeenCalledTimes(fixture.files.length);
  });

  it("keeps backward-compatible success and removes abort listeners after completion", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener"), remove = vi.spyOn(controller.signal, "removeEventListener");
    const imported = await importTissuePbrBundle(source, controller.signal);
    expect(imported.digest).toBe(sha256(source));
    expect(add).toHaveBeenCalledTimes(fixture.files.length * 2 + 1);
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
    controller.abort();
    closed.forEach(close => expect(close).toHaveBeenCalledTimes(1));
  });
});
