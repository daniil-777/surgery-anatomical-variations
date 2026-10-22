import { describe, expect, it } from "vitest";
import { baseMimeType, createAssetPort, resolveMimeType, STANDARD_UPLOAD_LIMIT, type AssetReservation, type AssetTransport, type TransportUploadOptions } from "./assets";
import { createMemoryBlobCache } from "./blobCache";
import { platformError } from "./errors";
import { sha256Hex } from "./hash";
import { PlatformError, type AllowedMimeType, type Asset, type AssetStatus } from "./types";

interface Row extends Omit<Asset, "status"> {
  /** "rejected": confirm found the wrong size (the next reserve reopens it). */
  status: AssetStatus | "rejected";
  stored: Blob | null;
}

function publicRow(row: Row): Asset {
  const { stored: _stored, status, ...asset } = row;
  return { ...asset, status: status === "ready" ? "ready" : "pending" };
}

/** A transport over an in-memory "server", recording calls, with scriptable failures. */
class FakeTransport implements AssetTransport {
  readonly calls: string[] = [];
  readonly rows = new Map<string, Row>();
  /** Errors thrown by the next calls of a method, in order. */
  readonly failures = new Map<string, unknown[]>();
  /** Bytes the server pretends to have stored instead of the uploaded ones (a stale partial object). */
  corruptNextUpload = false;
  /** Make the next download return different bytes. */
  corruptDownloads = 0;
  private next = 1;

  private fail(method: string): void {
    const queue = this.failures.get(method);
    if (queue && queue.length > 0) throw queue.shift();
  }

  async reserve(input: { sha256: string; byteSize: number; mimeType: AllowedMimeType }): Promise<AssetReservation> {
    this.calls.push(`reserve ${input.byteSize} ${input.mimeType}`);
    this.fail("reserve");
    const existing = [...this.rows.values()].find((row) => row.sha256 === input.sha256);
    if (existing) {
      // reserve_asset reopens a rejected reservation for one more upload
      if (existing.status === "rejected") existing.status = "pending";
      return { assetId: existing.id, objectPath: existing.objectPath, status: existing.status === "ready" ? "ready" : "pending" };
    }
    const id = `00000000-0000-4000-8000-${String(this.next++).padStart(12, "0")}`;
    const row: Row = {
      id,
      sha256: input.sha256,
      byteSize: input.byteSize,
      mimeType: input.mimeType,
      objectPath: `u/${input.sha256.slice(0, 2)}/${input.sha256}`,
      status: "pending",
      createdAt: "2026-10-21T00:00:00.000Z",
      stored: null,
    };
    this.rows.set(id, row);
    return { assetId: id, objectPath: row.objectPath, status: "pending" };
  }

  private store(kind: string, objectPath: string, blob: Blob, options: TransportUploadOptions): void {
    this.calls.push(`${kind} ${blob.size}`);
    this.fail(kind);
    const row = [...this.rows.values()].find((candidate) => candidate.objectPath === objectPath);
    if (!row) throw platformError("unknown", { status: 403 });
    row.stored = this.corruptNextUpload ? blob.slice(0, Math.max(1, blob.size - 1)) : blob;
    this.corruptNextUpload = false;
    options.onProgress?.(blob.size);
  }

  async uploadStandard(objectPath: string, blob: Blob, options: TransportUploadOptions): Promise<void> {
    this.store("standard", objectPath, blob, options);
  }

  async uploadResumable(objectPath: string, blob: Blob, options: TransportUploadOptions): Promise<void> {
    this.store("resumable", objectPath, blob, options);
  }

  async confirm(assetId: string): Promise<Asset> {
    this.calls.push("confirm");
    this.fail("confirm");
    const row = this.rows.get(assetId);
    if (!row) throw platformError("not_found", { status: 404 });
    if (row.status === "rejected") throw platformError("size_mismatch", { status: 409 });
    if (row.status === "pending") {
      if (!row.stored) throw platformError("upload_missing", { status: 409 });
      if (row.stored.size !== row.byteSize) {
        row.status = "rejected";
        throw platformError("size_mismatch", { status: 409 });
      }
      row.status = "ready";
    }
    return publicRow(row);
  }

  async describe(assetIds: string[]): Promise<Asset[]> {
    this.calls.push(`describe ${assetIds.length}`);
    this.fail("describe");
    return assetIds.flatMap((id) => {
      const row = this.rows.get(id);
      return row && row.status !== "rejected" ? [publicRow(row)] : [];
    });
  }

  async signedUrls(objectPaths: string[], expiresInSeconds: number, options: { download?: string } = {}): Promise<Array<string | null>> {
    this.calls.push(`sign ${objectPaths.length} ${expiresInSeconds}${options.download ? ` ${options.download}` : ""}`);
    this.fail("sign");
    return objectPaths.map((path) => `https://signed.test/${path}?t=${expiresInSeconds}${options.download ? `&download=${options.download}` : ""}`);
  }

  async download(objectPath: string): Promise<Blob> {
    this.calls.push("download");
    this.fail("download");
    const row = [...this.rows.values()].find((candidate) => candidate.objectPath === objectPath);
    if (!row?.stored) throw platformError("not_found", { status: 404 });
    if (this.corruptDownloads > 0) {
      this.corruptDownloads -= 1;
      return new Blob([new Uint8Array(row.stored.size).fill(7)]);
    }
    return row.stored;
  }
}

const noSleep = async (): Promise<void> => {};

function port(transport: FakeTransport, now: () => number = Date.now) {
  return createAssetPort(transport, { cache: createMemoryBlobCache(), sleep: noSleep, now, retryDelaysMs: [1, 2, 3] });
}

describe("resolveMimeType", () => {
  it("prefers the explicit type, then the blob's accepted type, else octet-stream", () => {
    expect(resolveMimeType(new Blob(["x"], { type: "image/png" }))).toBe("image/png");
    expect(resolveMimeType(new Blob(["x"], { type: "text/plain;charset=utf-8" }))).toBe("text/plain");
    expect(resolveMimeType(new Blob(["x"], { type: "IMAGE/PNG" }))).toBe("image/png");
    expect(resolveMimeType(new Blob(["x"]))).toBe("application/octet-stream");
    expect(resolveMimeType(new Blob(["<html>"], { type: "text/html" }))).toBe("application/octet-stream");
    expect(resolveMimeType(new Blob(["x"], { type: "image/png" }), "model/gltf-binary")).toBe("model/gltf-binary");
    expect(() => resolveMimeType(new Blob(["x"]), "text/html" as AllowedMimeType)).toThrow(PlatformError);
  });

  it("drops MIME parameters before reserving, from the blob and from the explicit type", () => {
    // MediaRecorder hands out blobs typed with their codecs
    expect(resolveMimeType(new Blob(["x"], { type: "video/webm;codecs=vp9" }))).toBe("video/webm");
    expect(resolveMimeType(new Blob(["x"], { type: "video/mp4; codecs=\"avc1.42E01E\"" }))).toBe("video/mp4");
    expect(resolveMimeType(new Blob(["x"]), "video/webm;codecs=vp9,opus" as AllowedMimeType)).toBe("video/webm");
    expect(resolveMimeType(new Blob(["x"]), " Image/PNG ; charset=binary" as AllowedMimeType)).toBe("image/png");
    expect(() => resolveMimeType(new Blob(["x"]), "text/html; charset=utf-8" as AllowedMimeType)).toThrow(PlatformError);
    expect(baseMimeType("Model/GLTF-Binary;x=1")).toBe("model/gltf-binary");
    expect(baseMimeType("")).toBe("");
  });
});

describe("AssetPort.put", () => {
  it("hashes, reserves, uploads and confirms, reporting progress", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const progress: Array<[number, number]> = [];
    const blob = new Blob(["hello world"], { type: "text/plain" });
    const asset = await assets.put(blob, { onProgress: (p) => progress.push([p.loaded, p.total]) });
    expect(asset.status).toBe("ready");
    expect(asset.sha256).toBe(await sha256Hex("hello world"));
    expect(asset.mimeType).toBe("text/plain");
    expect(transport.calls).toEqual(["reserve 11 text/plain", "standard 11", "confirm"]);
    expect(progress[0]).toEqual([0, 11]);
    expect(progress.at(-1)).toEqual([11, 11]);
  });

  it("skips the upload when the bytes are already stored (dedup)", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const first = await assets.put(new Blob(["same bytes"]));
    transport.calls.length = 0;
    const second = await assets.put(new Blob(["same bytes"]));
    expect(second.id).toBe(first.id);
    expect(transport.calls).toEqual(["reserve 10 application/octet-stream", "confirm"]);
  });

  it("uses TUS above 6 MB and the standard upload up to 6 MB", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    await assets.put(new Blob([new Uint8Array(STANDARD_UPLOAD_LIMIT)]));
    await assets.put(new Blob([new Uint8Array(STANDARD_UPLOAD_LIMIT + 1)]));
    expect(transport.calls.filter((call) => call.startsWith("standard") || call.startsWith("resumable"))).toEqual([
      `standard ${STANDARD_UPLOAD_LIMIT}`,
      `resumable ${STANDARD_UPLOAD_LIMIT + 1}`,
    ]);
  });

  it("retries network and 5xx failures with backoff, but not refusals", async () => {
    const transport = new FakeTransport();
    const slept: number[] = [];
    const assets = createAssetPort(transport, { cache: null, retryDelaysMs: [10, 20, 30], sleep: async (ms) => void slept.push(ms) });
    transport.failures.set("reserve", [platformError("network", { status: 0 })]);
    transport.failures.set("standard", [platformError("unknown", { status: 503 }), platformError("network", { status: 0 })]);
    await assets.put(new Blob(["retry me"]));
    expect(slept).toEqual([10, 10, 20]);

    transport.failures.set("reserve", [platformError("quota_exceeded", { status: 413 })]);
    const error = await assets.put(new Blob(["no space"])).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "quota_exceeded" });
  });

  it("starts over after a pause while the same bytes are being collected (asset_busy)", async () => {
    const transport = new FakeTransport();
    const slept: number[] = [];
    const assets = createAssetPort(transport, { cache: null, retryDelaysMs: [7, 8], busyRetryDelaysMs: [30, 60], sleep: async (ms) => void slept.push(ms) });
    transport.failures.set("reserve", [platformError("asset_busy", { status: 409, detail: "being collected" })]);
    expect((await assets.put(new Blob(["collected"]))).status).toBe("ready");
    expect(slept).toEqual([30]);
    expect(transport.calls).toEqual(["reserve 9 application/octet-stream", "reserve 9 application/octet-stream", "standard 9", "confirm"]);
  });

  it("starts the whole put over when the reservation it reopens is being collected", async () => {
    const transport = new FakeTransport();
    const slept: number[] = [];
    const assets = createAssetPort(transport, { cache: null, retryDelaysMs: [], busyRetryDelaysMs: [5], sleep: async (ms) => void slept.push(ms) });
    // the upload is refused (the reservation expired), and the second reserve meets the collection of those bytes
    transport.failures.set("standard", [platformError("unknown", { status: 403, detail: "new row violates row-level security policy" })]);
    const originalReserve = transport.reserve.bind(transport);
    let reserveCalls = 0;
    transport.reserve = async (input) => {
      reserveCalls += 1;
      if (reserveCalls === 2) {
        transport.calls.push(`reserve ${input.byteSize} ${input.mimeType}`);
        transport.rows.clear();
        throw platformError("asset_busy", { status: 409 });
      }
      return originalReserve(input);
    };
    expect((await assets.put(new Blob(["late"]))).status).toBe("ready");
    expect(slept).toEqual([5]);
    expect(transport.calls).toEqual([
      "reserve 4 application/octet-stream",
      "standard 4",
      "reserve 4 application/octet-stream",
      "reserve 4 application/octet-stream",
      "standard 4",
      "confirm",
    ]);
  });

  it("gives up with asset_busy after the last pause", async () => {
    const transport = new FakeTransport();
    const slept: number[] = [];
    const assets = createAssetPort(transport, { cache: null, retryDelaysMs: [1], busyRetryDelaysMs: [10, 20, 40], sleep: async (ms) => void slept.push(ms) });
    transport.failures.set("reserve", Array.from({ length: 4 }, () => platformError("asset_busy", { status: 409 })));
    const error = (await assets.put(new Blob(["stuck"])).catch((caught: unknown) => caught)) as PlatformError;
    expect(error).toMatchObject({ code: "asset_busy", status: 409 });
    expect(slept).toEqual([10, 20, 40]);
    expect(transport.calls.filter((call) => call.startsWith("reserve"))).toHaveLength(4);
  });

  it("stops waiting for a collection when aborted", async () => {
    const transport = new FakeTransport();
    const controller = new AbortController();
    const assets = createAssetPort(transport, {
      cache: null,
      busyRetryDelaysMs: [10_000],
      sleep: async () => {
        controller.abort();
        throw platformError("aborted");
      },
    });
    transport.failures.set("reserve", [platformError("asset_busy", { status: 409 })]);
    expect(await assets.put(new Blob(["bye"]), { signal: controller.signal }).catch((caught: unknown) => caught)).toMatchObject({ code: "aborted" });
  });

  it("forgets the row of bytes that were collected and stored again under a new id", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const first = await assets.put(new Blob(["orphan"]));
    expect(await assets.describe([first.id])).toEqual([first]);
    // the maintenance job removed the unreferenced row; the same bytes come back as a new reservation
    transport.rows.clear();
    const second = await assets.put(new Blob(["orphan"]));
    expect(second.id).not.toBe(first.id);
    expect(await assets.describe([first.id, second.id])).toEqual([second]);
  });

  it("gives up after the last retry", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    transport.failures.set("standard", Array.from({ length: 5 }, () => platformError("network", { status: 0 })));
    const error = (await assets.put(new Blob(["offline"])).catch((caught: unknown) => caught)) as PlatformError;
    expect(error.code).toBe("network");
    expect(transport.calls.filter((call) => call.startsWith("standard"))).toHaveLength(4);
  });

  it("treats a refused upload of a reservation another tab finished as done", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const blob = new Blob(["raced"]);
    const sha = await sha256Hex(blob);
    // the other tab reserved, uploaded and confirmed between our reserve and our upload
    transport.failures.set("standard", [platformError("unknown", { status: 403, detail: "new row violates row-level security policy" })]);
    const originalReserve = transport.reserve.bind(transport);
    let reserveCalls = 0;
    transport.reserve = async (input) => {
      const result = await originalReserve(input);
      if (++reserveCalls === 2) {
        const row = transport.rows.get(result.assetId) as Row;
        row.status = "ready";
        row.stored = blob;
        return { ...result, status: "ready" };
      }
      return result;
    };
    const asset = await assets.put(blob);
    expect(asset.sha256).toBe(sha);
    expect(transport.calls).toEqual(["reserve 5 application/octet-stream", "standard 5", "reserve 5 application/octet-stream", "confirm"]);
  });

  it("uploads into a fresh reservation when the first one was collected meanwhile", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const blob = new Blob(["slow upload"]);
    // the pending reservation expired (collected after an hour) while the upload was on its way
    transport.failures.set("standard", [platformError("unknown", { status: 403, detail: "new row violates row-level security policy" })]);
    const originalReserve = transport.reserve.bind(transport);
    let reserveCalls = 0;
    transport.reserve = async (input) => {
      reserveCalls += 1;
      if (reserveCalls === 2) transport.rows.clear();
      return originalReserve(input);
    };
    const asset = await assets.put(blob);
    expect(asset.status).toBe("ready");
    expect(transport.calls).toEqual(["reserve 11 application/octet-stream", "standard 11", "reserve 11 application/octet-stream", "standard 11", "confirm"]);
  });

  it("accepts an object that already exists at the content address", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const blob = new Blob(["already there"]);
    await transport.reserve({ sha256: await sha256Hex(blob), byteSize: blob.size, mimeType: "application/octet-stream" });
    (transport.rows.values().next().value as Row).stored = blob;
    transport.failures.set("standard", [platformError("unknown", { status: 409, detail: "duplicate" })]);
    expect((await assets.put(blob)).status).toBe("ready");
  });

  it("reserves and uploads once more when confirm rejects a stale partial object", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    transport.corruptNextUpload = true;
    const asset = await assets.put(new Blob(["fresh bytes"]));
    expect(asset.status).toBe("ready");
    // confirm marked the reservation rejected; the second reserve reopened it
    expect(transport.calls).toEqual(["reserve 11 application/octet-stream", "standard 11", "confirm", "reserve 11 application/octet-stream", "standard 11", "confirm"]);
  });

  it("uploads again when the object vanished before confirm, and gives up after one more round", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    transport.failures.set("confirm", [platformError("upload_missing", { status: 409 })]);
    expect((await assets.put(new Blob(["vanished"]))).status).toBe("ready");
    expect(transport.calls).toEqual(["reserve 8 application/octet-stream", "standard 8", "confirm", "reserve 8 application/octet-stream", "standard 8", "confirm"]);

    transport.failures.set("confirm", [platformError("size_mismatch", { status: 409 }), platformError("size_mismatch", { status: 409 })]);
    expect(await assets.put(new Blob(["twice wrong"])).catch((caught: unknown) => caught)).toMatchObject({ code: "size_mismatch" });
  });

  it("validates input before any request", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    expect(await assets.put(new Blob([])).catch((error: unknown) => error)).toMatchObject({ code: "invalid_input", detail: "byte_size" });
    expect(await assets.put(new Blob(["x"]), { sha256: "nope" }).catch((error: unknown) => error)).toMatchObject({ code: "invalid_input", detail: "sha256" });
    expect(await assets.put("text" as unknown as Blob).catch((error: unknown) => error)).toMatchObject({ code: "invalid_input" });
    expect(transport.calls).toEqual([]);
  });

  it("trusts a precomputed SHA-256", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const blob = new Blob(["abc"]);
    const asset = await assets.put(blob, { sha256: await sha256Hex("abc") });
    expect(asset.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("stops when aborted, before or between steps", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const before = new AbortController();
    before.abort();
    expect(await assets.put(new Blob(["x"]), { signal: before.signal }).catch((error: unknown) => error)).toMatchObject({ code: "aborted" });
    expect(transport.calls).toEqual([]);

    const during = new AbortController();
    const originalReserve = transport.reserve.bind(transport);
    transport.reserve = async (input) => {
      const result = await originalReserve(input);
      during.abort();
      return result;
    };
    expect(await assets.put(new Blob(["y"]), { signal: during.signal }).catch((error: unknown) => error)).toMatchObject({ code: "aborted" });
    expect(transport.calls.some((call) => call.startsWith("standard"))).toBe(false);
  });
});

describe("AssetPort.describe / url / get", () => {
  it("remembers ready rows and omits unknown ids", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const a = await assets.put(new Blob(["a"]));
    transport.calls.length = 0;
    expect(await assets.describe([a.id, "00000000-0000-4000-8000-999999999999", a.id])).toEqual([a]);
    expect(transport.calls).toEqual(["describe 1"]);
  });

  it("batches url() calls made together into one describe and one signing request per expiry", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const ids = [];
    for (const text of ["one", "two", "three"]) ids.push((await assets.put(new Blob([text]))).id);
    assets.reset();
    transport.calls.length = 0;
    const urls = await Promise.all([...ids.map((id) => assets.url(id)), assets.url(ids[0] as string, { download: "one.txt" })]);
    expect(urls[0]).toMatch(/^https:\/\/signed\.test\/u\//);
    expect(urls[3]).toContain("download=one.txt");
    expect(transport.calls).toEqual(["describe 3", "sign 3 3600", "sign 1 3600 one.txt"]);
  });

  it("serves cached URLs until shortly before they expire", async () => {
    const transport = new FakeTransport();
    let clock = 1_000_000;
    const assets = port(transport, () => clock);
    const { id } = await assets.put(new Blob(["thumb"]));
    transport.calls.length = 0;
    const first = await assets.url(id, { expiresInSeconds: 600 });
    expect(await assets.url(id, { expiresInSeconds: 600 })).toBe(first);
    expect(transport.calls.filter((call) => call.startsWith("sign"))).toHaveLength(1);
    clock += (600 - 150) * 1000 + 1; // within the last quarter of the lifetime
    await assets.url(id, { expiresInSeconds: 600 });
    expect(transport.calls.filter((call) => call.startsWith("sign"))).toHaveLength(2);
  });

  it("rejects url() for unknown assets", async () => {
    const assets = port(new FakeTransport());
    expect(await assets.url("00000000-0000-4000-8000-000000000042").catch((error: unknown) => error)).toMatchObject({ code: "not_found" });
  });

  it("get() serves bytes from the local cache, typed as stored", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    const asset = await assets.put(new Blob(["cached"], { type: "application/json" }));
    transport.calls.length = 0;
    const blob = await assets.get(asset.id);
    expect(await blob.text()).toBe("cached");
    expect(blob.type).toBe("application/json");
    expect(transport.calls).toEqual([]);
  });

  it("get() downloads, verifies and caches when the cache is cold", async () => {
    const transport = new FakeTransport();
    const writer = port(transport);
    const asset = await writer.put(new Blob(["from server"], { type: "text/plain" }));
    const reader = port(transport);
    transport.calls.length = 0;
    expect(await (await reader.get(asset.id)).text()).toBe("from server");
    expect(transport.calls).toEqual(["describe 1", "download"]);
    transport.calls.length = 0;
    await reader.get(asset.id);
    expect(transport.calls).toEqual([]);
  });

  it("get() retries a corrupted download once, then fails loudly", async () => {
    const transport = new FakeTransport();
    const asset = await port(transport).put(new Blob(["integrity"]));
    transport.corruptDownloads = 1;
    expect(await (await port(transport).get(asset.id)).text()).toBe("integrity");
    transport.corruptDownloads = 2;
    const error = (await port(transport).get(asset.id).catch((caught: unknown) => caught)) as PlatformError;
    expect(error.code).toBe("unknown");
    expect(error.detail).toContain("checksum mismatch");
  });

  it("get() refuses unknown and pending assets", async () => {
    const transport = new FakeTransport();
    const assets = port(transport);
    expect(await assets.get("00000000-0000-4000-8000-000000000042").catch((error: unknown) => error)).toMatchObject({ code: "not_found" });
    const reservation = await transport.reserve({ sha256: await sha256Hex("p"), byteSize: 1, mimeType: "text/plain" });
    expect(await assets.get(reservation.assetId).catch((error: unknown) => error)).toMatchObject({ code: "asset_not_ready" });
  });
});
