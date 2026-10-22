// A local cache of immutable bytes keyed by SHA-256 (content-addressed assets never change, so a hit never needs
// revalidation). IndexedDB store "viscera-platform-blobs" with a least-recently-used size cap (256 MB by default);
// where IndexedDB is missing or refuses (node tests, some private modes) an in-memory map with the same policy takes
// over. Blobs are stored as Blobs (disk-backed); where IndexedDB refuses Blobs (WebKit private browsing) the bytes are
// stored as an ArrayBuffer instead. The cache is best effort: failures are swallowed and look like misses.

import { isBlobLike } from "./hash";

export const BLOB_CACHE_DB = "viscera-platform-blobs";
export const DEFAULT_BLOB_CACHE_BYTES = 256 * 1024 * 1024;

const STORE = "blobs";

export interface BlobCacheUsage {
  entries: number;
  bytes: number;
}

export interface BlobCache {
  get(key: string): Promise<Blob | null>;
  /** Entries larger than the cap are not kept. */
  put(key: string, blob: Blob): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  usage(): Promise<BlobCacheUsage>;
  /** Where entries live now ("memory" also after IndexedDB failed to open). */
  backing(): Promise<"indexeddb" | "memory">;
}

export interface BlobCacheOptions {
  /** IndexedDB database name. */
  name?: string;
  /** Size cap in bytes; Infinity never evicts. */
  maxBytes?: number;
  /** Injected for tests; null forces the in-memory cache. Defaults to globalThis.indexedDB. */
  indexedDB?: IDBFactory | null;
  now?: () => number;
}

export interface CacheEntryInfo {
  key: string;
  size: number;
  usedAt: number;
}

/** Keys to evict, least recently used first, until the total fits maxBytes; `keep` (the entry just written) stays. */
export function planEviction(entries: readonly CacheEntryInfo[], maxBytes: number, keep?: string): string[] {
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxBytes) return [];
  const victims: string[] = [];
  const ordered = [...entries].sort((a, b) => a.usedAt - b.usedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const entry of ordered) {
    if (total <= maxBytes) break;
    if (entry.key === keep) continue;
    victims.push(entry.key);
    total -= entry.size;
  }
  return victims;
}

interface MemoryEntry {
  blob: Blob;
  size: number;
}

class MemoryBlobCache implements BlobCache {
  // Map iteration order is insertion order; a hit re-inserts, so the first entry is always the least recently used
  private readonly entries = new Map<string, MemoryEntry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  async get(key: string): Promise<Blob | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.blob;
  }

  async put(key: string, blob: Blob): Promise<void> {
    await this.delete(key);
    if (blob.size > this.maxBytes) return;
    this.entries.set(key, { blob, size: blob.size });
    this.bytes += blob.size;
    for (const [victim, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      if (victim === key) continue;
      this.entries.delete(victim);
      this.bytes -= entry.size;
    }
  }

  async delete(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.size;
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.bytes = 0;
  }

  async usage(): Promise<BlobCacheUsage> {
    return { entries: this.entries.size, bytes: this.bytes };
  }

  async backing(): Promise<"memory"> {
    return "memory";
  }
}

interface StoredEntry {
  key: string;
  /** The bytes as a Blob, or … */
  blob?: Blob;
  /** … as an ArrayBuffer where the browser refuses Blobs in IndexedDB. */
  data?: ArrayBuffer;
  size: number;
  type: string;
  usedAt: number;
}

const isArrayBuffer = (value: unknown): value is ArrayBuffer => Object.prototype.toString.call(value) === "[object ArrayBuffer]";

function isStoredEntry(value: unknown): value is StoredEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<StoredEntry>;
  return typeof entry.key === "string" && typeof entry.size === "number" && typeof entry.usedAt === "number" && (isBlobLike(entry.blob) || isArrayBuffer(entry.data));
}

function entryBlob(entry: StoredEntry): Blob {
  return entry.blob ?? new Blob([entry.data as ArrayBuffer], { type: entry.type });
}

function settle(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

class IndexedDbBlobCache implements BlobCache {
  private database: Promise<IDBDatabase | null> | null = null;
  private readonly fallback: MemoryBlobCache;
  /** Set once IndexedDB refused a Blob: later writes go straight to ArrayBuffers. */
  private blobsRefused = false;

  constructor(
    private readonly factory: IDBFactory,
    private readonly name: string,
    private readonly maxBytes: number,
    private readonly now: () => number,
  ) {
    this.fallback = new MemoryBlobCache(maxBytes);
  }

  private open(): Promise<IDBDatabase | null> {
    this.database ??= new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(this.name, 1);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" }).createIndex("usedAt", "usedAt");
      };
      request.onsuccess = () => {
        const db = request.result;
        // another tab upgrading the schema must not be blocked by this connection
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return this.database;
  }

  async get(key: string): Promise<Blob | null> {
    const db = await this.open();
    if (!db) return this.fallback.get(key);
    try {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      let found: Blob | null = null;
      const request = store.get(key);
      request.onsuccess = () => {
        const entry: unknown = request.result;
        if (!isStoredEntry(entry)) return;
        found = entryBlob(entry);
        store.put({ ...entry, usedAt: this.now() });
      };
      await settle(transaction);
      return found;
    } catch {
      return null;
    }
  }

  async put(key: string, blob: Blob): Promise<void> {
    if (blob.size > this.maxBytes) return;
    const db = await this.open();
    if (!db) return this.fallback.put(key, blob);
    const base = { key, size: blob.size, type: blob.type, usedAt: this.now() };
    if (!this.blobsRefused && (await this.write(db, { ...base, blob }))) return;
    this.blobsRefused = true;
    try {
      await this.write(db, { ...base, data: await blob.arrayBuffer() });
    } catch {
      // best effort: quota errors and private modes simply do not cache
    }
  }

  /** Stores one entry and evicts beyond the cap in the same transaction; false when IndexedDB refused it. */
  private async write(db: IDBDatabase, entry: StoredEntry): Promise<boolean> {
    try {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      store.put(entry);
      if (Number.isFinite(this.maxBytes)) {
        const entries: CacheEntryInfo[] = [];
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current) {
            const value: unknown = current.value;
            if (isStoredEntry(value)) entries.push({ key: value.key, size: value.size, usedAt: value.usedAt });
            current.continue();
            return;
          }
          for (const victim of planEviction(entries, this.maxBytes, entry.key)) store.delete(victim);
        };
      }
      await settle(transaction);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const db = await this.open();
    if (!db) return this.fallback.delete(key);
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(key);
      await settle(transaction);
    } catch {
      // nothing to do
    }
  }

  async clear(): Promise<void> {
    const db = await this.open();
    if (!db) return this.fallback.clear();
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).clear();
      await settle(transaction);
    } catch {
      // nothing to do
    }
  }

  async usage(): Promise<BlobCacheUsage> {
    const db = await this.open();
    if (!db) return this.fallback.usage();
    try {
      const transaction = db.transaction(STORE, "readonly");
      const usage: BlobCacheUsage = { entries: 0, bytes: 0 };
      const cursor = transaction.objectStore(STORE).openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        const value: unknown = current.value;
        if (isStoredEntry(value)) {
          usage.entries += 1;
          usage.bytes += value.size;
        }
        current.continue();
      };
      await settle(transaction);
      return usage;
    } catch {
      return { entries: 0, bytes: 0 };
    }
  }

  async backing(): Promise<"indexeddb" | "memory"> {
    return (await this.open()) ? "indexeddb" : "memory";
  }
}

function defaultIndexedDb(): IDBFactory | null {
  try {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    return factory && typeof factory.open === "function" ? factory : null;
  } catch {
    // some sandboxed frames throw on access
    return null;
  }
}

/** In-memory only (tests, or callers that must not touch IndexedDB). */
export function createMemoryBlobCache(options: { maxBytes?: number } = {}): BlobCache {
  return new MemoryBlobCache(options.maxBytes ?? DEFAULT_BLOB_CACHE_BYTES);
}

/** IndexedDB-backed when available, in memory otherwise. */
export function createBlobCache(options: BlobCacheOptions = {}): BlobCache {
  const maxBytes = options.maxBytes ?? DEFAULT_BLOB_CACHE_BYTES;
  const factory = options.indexedDB === undefined ? defaultIndexedDb() : options.indexedDB;
  if (!factory) return new MemoryBlobCache(maxBytes);
  return new IndexedDbBlobCache(factory, options.name ?? BLOB_CACHE_DB, maxBytes, options.now ?? Date.now);
}
