import { describe, expect, it } from "vitest";
import { createBlobCache, createMemoryBlobCache, DEFAULT_BLOB_CACHE_BYTES, planEviction } from "./blobCache";

const blob = (bytes: number, fill = 1): Blob => new Blob([new Uint8Array(bytes).fill(fill)]);

describe("planEviction", () => {
  it("evicts least recently used entries until the total fits", () => {
    const entries = [
      { key: "a", size: 40, usedAt: 3 },
      { key: "b", size: 40, usedAt: 1 },
      { key: "c", size: 40, usedAt: 2 },
    ];
    expect(planEviction(entries, 120)).toEqual([]);
    expect(planEviction(entries, 100)).toEqual(["b"]);
    expect(planEviction(entries, 50)).toEqual(["b", "c"]);
  });

  it("never evicts the entry being written and breaks ties by key", () => {
    const entries = [
      { key: "new", size: 60, usedAt: 0 },
      { key: "y", size: 30, usedAt: 5 },
      { key: "x", size: 30, usedAt: 5 },
    ];
    expect(planEviction(entries, 60, "new")).toEqual(["x", "y"]);
  });
});

describe("memory blob cache", () => {
  it("stores and returns blobs by key", async () => {
    const cache = createMemoryBlobCache({ maxBytes: 1000 });
    expect(await cache.get("k")).toBeNull();
    const value = blob(10);
    await cache.put("k", value);
    expect(await cache.get("k")).toBe(value);
    expect(await cache.usage()).toEqual({ entries: 1, bytes: 10 });
    await cache.delete("k");
    expect(await cache.get("k")).toBeNull();
    expect(await cache.backing()).toBe("memory");
  });

  it("evicts the least recently used entries beyond the cap", async () => {
    const cache = createMemoryBlobCache({ maxBytes: 100 });
    await cache.put("a", blob(40));
    await cache.put("b", blob(40));
    await cache.get("a"); // a is now the most recent
    await cache.put("c", blob(40));
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("a")).not.toBeNull();
    expect(await cache.get("c")).not.toBeNull();
    expect(await cache.usage()).toEqual({ entries: 2, bytes: 80 });
  });

  it("skips entries larger than the cap and replaces existing keys", async () => {
    const cache = createMemoryBlobCache({ maxBytes: 50 });
    await cache.put("big", blob(51));
    expect(await cache.get("big")).toBeNull();
    await cache.put("k", blob(20, 1));
    await cache.put("k", blob(30, 2));
    expect(await cache.usage()).toEqual({ entries: 1, bytes: 30 });
    await cache.clear();
    expect(await cache.usage()).toEqual({ entries: 0, bytes: 0 });
  });

  it("never evicts with an infinite cap", async () => {
    const cache = createMemoryBlobCache({ maxBytes: Number.POSITIVE_INFINITY });
    for (let index = 0; index < 20; index += 1) await cache.put(`k${index}`, blob(1024));
    expect((await cache.usage()).entries).toBe(20);
  });
});

describe("createBlobCache", () => {
  it("falls back to memory without IndexedDB (node) and defaults to 256 MB", async () => {
    expect(DEFAULT_BLOB_CACHE_BYTES).toBe(256 * 1024 * 1024);
    const cache = createBlobCache();
    expect(await cache.backing()).toBe("memory");
    await cache.put("x", blob(3));
    expect(await cache.get("x")).not.toBeNull();
  });

  it("falls back to memory when IndexedDB refuses to open", async () => {
    const refusing = {
      open() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as IDBFactory;
    const cache = createBlobCache({ indexedDB: refusing, maxBytes: 100 });
    expect(await cache.backing()).toBe("memory");
    await cache.put("x", blob(3));
    expect((await cache.get("x"))?.size).toBe(3);
  });
});
