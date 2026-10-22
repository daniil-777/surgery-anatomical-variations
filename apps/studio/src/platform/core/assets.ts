// The asset pipeline shared by both backends (DESIGN.md D5, D11): hash → reserve (quota, per-file limit, dedup: a
// ready row needs no upload) → upload (standard request up to 6 MB, TUS above; progress, AbortSignal, retries with
// backoff on network/5xx) → confirm. Reads go through a short-lived signed URL cache (url) or the local blob cache
// keyed by SHA-256 (get; content-addressed bytes never change, and every download is verified against its hash).
// A backend supplies an AssetTransport; everything else — mime rules, retries, caching, batching — lives here once.
//
// Collection (DESIGN.md §15.3, §15.4): the maintenance job may be deleting an orphaned copy of the very bytes being
// stored (reserve_asset answers 409 asset_busy); put() then starts over after a pause, a bounded number of times.
// A size mismatch at confirm marks the reservation rejected; reserving again reopens it for one more upload.

import { createBlobCache, type BlobCache } from "./blobCache";
import { abortError, isAssetBusy, isRetryable, isStorageDuplicate, platformError, throwIfAborted, toPlatformError } from "./errors";
import { isBlobLike, isSha256Hex, sha256Hex, sha256OfBlob } from "./hash";
import { defaultSleep } from "./tus";
import { ALLOWED_MIME_TYPES, type AllowedMimeType, type Asset, type AssetPort, type AssetPutOptions, type AssetStatus, type Uuid } from "./types";

/** Supabase recommends standard uploads up to 6 MB and resumable (TUS) uploads above. */
export const STANDARD_UPLOAD_LIMIT = 6 * 1024 * 1024;
export const DEFAULT_URL_TTL_SECONDS = 3600;
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 4000];
/** Pauses before put() starts over while the same bytes are being collected (asset_busy); then it gives up. */
export const DEFAULT_BUSY_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

export interface AssetReservation {
  assetId: Uuid;
  objectPath: string;
  status: AssetStatus;
}

export interface TransportUploadOptions {
  mimeType: AllowedMimeType;
  sha256: string;
  signal?: AbortSignal;
  /** Bytes the server has acknowledged so far. */
  onProgress?: (loaded: number) => void;
}

/** What a backend provides to the asset pipeline. Errors may be thrown raw; the pipeline maps them. */
export interface AssetTransport {
  /** reserve_asset: quota and per-file checks, dedup by (owner, sha256). */
  reserve(input: { sha256: string; byteSize: number; mimeType: AllowedMimeType }, signal?: AbortSignal): Promise<AssetReservation>;
  /** One request; the object may already exist while the reservation is pending (upsert). */
  uploadStandard(objectPath: string, blob: Blob, options: TransportUploadOptions): Promise<void>;
  /** TUS (6 MB chunks), resumable. */
  uploadResumable(objectPath: string, blob: Blob, options: TransportUploadOptions): Promise<void>;
  /** confirm_asset: the stored object must exist with the reserved size; returns the (ready) row. */
  confirm(assetId: Uuid, signal?: AbortSignal): Promise<Asset>;
  /** Asset rows of the signed-in account; unknown ids are omitted. */
  describe(assetIds: Uuid[]): Promise<Asset[]>;
  /** Signed URLs in the order of `objectPaths` (null where the object is missing). */
  signedUrls(objectPaths: string[], expiresInSeconds: number, options?: { download?: string }): Promise<Array<string | null>>;
  download(objectPath: string, signal?: AbortSignal): Promise<Blob>;
}

export interface AssetPortOptions {
  /** Defaults to the IndexedDB cache ("viscera-platform-blobs", 256 MB); null disables caching. */
  cache?: BlobCache | null;
  standardUploadLimit?: number;
  /** Backoff for transient failures (network, 5xx, 429) of each request. */
  retryDelaysMs?: readonly number[];
  /** Pauses before put() starts over after asset_busy; their count bounds the attempts. */
  busyRetryDelaysMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Clock for signed-URL expiry (ms). */
  now?: () => number;
  defaultUrlTtlSeconds?: number;
}

export interface PlatformAssetPort extends AssetPort {
  /** Forget remembered rows and signed URLs (after sign-out or account switch). */
  reset(): void;
}

const ALLOWED = new Set<string>(ALLOWED_MIME_TYPES);

/** "Video/WebM; codecs=vp9" → "video/webm": parameters dropped, lower case (reserve_asset drops them too). */
export function baseMimeType(type: string): string {
  return (type.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The MIME type an upload is stored under: the explicit option, else the blob's own type when the bucket accepts it,
 * else application/octet-stream — always without parameters (a MediaRecorder blob is "video/webm;codecs=vp9"). A
 * browser type the bucket refuses (text/html, image/svg+xml, model/vnd.collada+xml …) is stored as octet-stream rather
 * than rejected: the bytes are kept and can never be served as markup.
 */
export function resolveMimeType(blob: Blob, explicit?: AllowedMimeType): AllowedMimeType {
  if (explicit !== undefined) {
    const base = typeof explicit === "string" ? baseMimeType(explicit) : "";
    if (!ALLOWED.has(base)) throw platformError("invalid_input", { status: 422, detail: "mime_type" });
    return base as AllowedMimeType;
  }
  const base = baseMimeType(blob.type ?? "");
  return ALLOWED.has(base) ? (base as AllowedMimeType) : "application/octet-stream";
}

interface UrlEntry {
  url: string;
  refreshAt: number;
}

interface UrlRequest {
  assetId: Uuid;
  ttl: number;
  download: string | null;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
}

function retype(blob: Blob, type: string): Blob {
  return blob.type === type ? blob : blob.slice(0, blob.size, type);
}

export function createAssetPort(transport: AssetTransport, options: AssetPortOptions = {}): PlatformAssetPort {
  const cache = options.cache === undefined ? createBlobCache() : options.cache;
  const limit = options.standardUploadLimit ?? STANDARD_UPLOAD_LIMIT;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const busyDelays = options.busyRetryDelaysMs ?? DEFAULT_BUSY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const defaultTtl = options.defaultUrlTtlSeconds ?? DEFAULT_URL_TTL_SECONDS;

  // ready rows never change (content-addressed, immutable), so they are remembered for the life of the port
  const rows = new Map<Uuid, Asset>();
  const idBySha = new Map<string, Uuid>();
  const urls = new Map<string, UrlEntry>();
  let queue: UrlRequest[] = [];
  let flushScheduled = false;

  const remember = (asset: Asset): Asset => {
    if (asset.status !== "ready") return asset;
    // one row per account and SHA-256: an older id for the same bytes was collected and is gone
    const previous = idBySha.get(asset.sha256);
    if (previous !== undefined && previous !== asset.id) rows.delete(previous);
    idBySha.set(asset.sha256, asset.id);
    rows.set(asset.id, asset);
    return asset;
  };

  /** Runs `task`, retrying retryable failures with backoff; aborts map to PlatformError("aborted"). */
  async function withRetry<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await task();
      } catch (error) {
        if (signal?.aborted) throw abortError(error);
        const mapped = toPlatformError(error);
        if (!isRetryable(mapped) || attempt >= delays.length) throw mapped;
        await sleep(delays[attempt] ?? 0, signal);
      }
    }
  }

  function reserve(blob: Blob, uploadOptions: TransportUploadOptions): Promise<AssetReservation> {
    const { sha256, mimeType, signal } = uploadOptions;
    return withRetry(() => transport.reserve({ sha256, byteSize: blob.size, mimeType }, signal), signal);
  }

  function confirm(target: AssetReservation, signal?: AbortSignal): Promise<Asset> {
    return withRetry(() => transport.confirm(target.assetId, signal), signal);
  }

  /**
   * Stores the bytes for a pending reservation. Returns the reservation to confirm: the same one, a fresh one when the
   * first was collected meanwhile (pending rows expire), or a ready one when another tab stored the same bytes first.
   */
  async function upload(reservation: AssetReservation, blob: Blob, uploadOptions: TransportUploadOptions): Promise<AssetReservation> {
    let target = reservation;
    for (let round = 0; ; round += 1) {
      try {
        await withRetry(
          () =>
            blob.size <= limit
              ? transport.uploadStandard(target.objectPath, blob, uploadOptions)
              : transport.uploadResumable(target.objectPath, blob, uploadOptions),
          uploadOptions.signal,
        );
        return target;
      } catch (error) {
        const mapped = toPlatformError(error);
        // the object is already stored at this content address (an earlier attempt or another tab): confirm decides
        if (isStorageDuplicate(mapped)) return target;
        // Storage accepts uploads only for pending reservations: ask again what the server holds
        if (mapped.status !== 403 || round > 0) throw mapped;
        target = await reserve(blob, uploadOptions);
        if (target.status === "ready") return target;
      }
    }
  }

  /** One pass of the protocol: reserve → upload unless the bytes are stored → confirm. */
  async function store(blob: Blob, uploadOptions: TransportUploadOptions): Promise<Asset> {
    const { signal } = uploadOptions;
    let target = await reserve(blob, uploadOptions);
    if (target.status === "ready") return confirm(target, signal);
    target = await upload(target, blob, uploadOptions);
    const uploaded = target.status !== "ready";
    try {
      return await confirm(target, signal);
    } catch (error) {
      const mapped = toPlatformError(error);
      if ((mapped.code !== "size_mismatch" && mapped.code !== "upload_missing") || !uploaded) throw mapped;
      // a stale or partial object from an earlier attempt (confirm rejected the reservation) or one that vanished:
      // reserve again, which reopens a rejected reservation, store the bytes once more and confirm again
      let again = await reserve(blob, uploadOptions);
      if (again.status !== "ready") again = await upload(again, blob, uploadOptions);
      return confirm(again, signal);
    }
  }

  async function put(blob: Blob, putOptions: AssetPutOptions = {}): Promise<Asset> {
    const { signal } = putOptions;
    throwIfAborted(signal);
    if (!isBlobLike(blob)) throw platformError("invalid_input", { status: 422, detail: "blob" });
    const mimeType = resolveMimeType(blob, putOptions.mimeType);
    const byteSize = blob.size;
    if (byteSize <= 0) throw platformError("invalid_input", { status: 422, detail: "byte_size", message: "Empty files cannot be stored." });
    let sha256: string;
    if (putOptions.sha256 !== undefined) {
      if (!isSha256Hex(putOptions.sha256)) throw platformError("invalid_input", { status: 422, detail: "sha256" });
      sha256 = putOptions.sha256;
    } else {
      sha256 = await sha256OfBlob(blob);
    }
    throwIfAborted(signal);
    const report = (loaded: number) => putOptions.onProgress?.({ loaded: Math.min(loaded, byteSize), total: byteSize });
    report(0);
    const uploadOptions: TransportUploadOptions = { mimeType, sha256, onProgress: report };
    if (signal) uploadOptions.signal = signal;

    let asset: Asset | null = null;
    for (let attempt = 0; asset === null; attempt += 1) {
      try {
        asset = await store(blob, uploadOptions);
      } catch (error) {
        if (signal?.aborted) throw abortError(error);
        const mapped = toPlatformError(error);
        // the maintenance job is deleting an orphaned copy of these bytes; once it is done, a reservation starts afresh
        if (!isAssetBusy(mapped) || attempt >= busyDelays.length) throw mapped;
        await sleep(busyDelays[attempt] ?? 0, signal);
      }
    }
    report(byteSize);
    remember(asset);
    if (cache && asset.sha256 === sha256) await cache.put(sha256, retype(blob, asset.mimeType));
    return asset;
  }

  async function describe(assetIds: Uuid[]): Promise<Asset[]> {
    const unique = [...new Set(assetIds)];
    const missing = unique.filter((id) => !rows.has(id));
    const fetched = new Map<Uuid, Asset>();
    if (missing.length > 0) {
      for (const asset of await withRetry(() => transport.describe(missing))) {
        fetched.set(asset.id, remember(asset));
      }
    }
    const result: Asset[] = [];
    for (const id of unique) {
      const asset = rows.get(id) ?? fetched.get(id);
      if (asset) result.push(asset);
    }
    return result;
  }

  async function flushUrls(): Promise<void> {
    flushScheduled = false;
    const batch = queue;
    queue = [];
    let known: Map<Uuid, Asset>;
    try {
      const described = await describe(batch.map((request) => request.assetId));
      known = new Map(described.map((asset) => [asset.id, asset]));
    } catch (error) {
      for (const request of batch) request.reject(toPlatformError(error));
      return;
    }
    const groups = new Map<string, UrlRequest[]>();
    for (const request of batch) {
      if (!known.has(request.assetId)) {
        request.reject(platformError("not_found", { status: 404, detail: "asset" }));
        continue;
      }
      const key = `${request.ttl}\u0000${request.download ?? ""}`;
      const group = groups.get(key) ?? [];
      group.push(request);
      groups.set(key, group);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const first = group[0] as UrlRequest;
        const paths = [...new Set(group.map((request) => (known.get(request.assetId) as Asset).objectPath))];
        try {
          const signOptions: { download?: string } = {};
          if (first.download !== null) signOptions.download = first.download;
          const issuedAt = now();
          const signed = await withRetry(() => transport.signedUrls(paths, first.ttl, signOptions));
          const byPath = new Map(paths.map((path, index) => [path, signed[index] ?? null]));
          // refresh well before expiry: a quarter of the lifetime, at most five minutes
          const margin = Math.min(300, first.ttl / 4) * 1000;
          for (const request of group) {
            const url = byPath.get((known.get(request.assetId) as Asset).objectPath) ?? null;
            if (!url) {
              request.reject(platformError("not_found", { status: 404, detail: "object" }));
              continue;
            }
            urls.set(`${request.assetId}\u0000${request.download ?? ""}\u0000${request.ttl}`, { url, refreshAt: issuedAt + request.ttl * 1000 - margin });
            request.resolve(url);
          }
        } catch (error) {
          for (const request of group) request.reject(toPlatformError(error));
        }
      }),
    );
  }

  function url(assetId: Uuid, urlOptions: { download?: string; expiresInSeconds?: number } = {}): Promise<string> {
    const ttl = Math.max(30, Math.min(Math.round(urlOptions.expiresInSeconds ?? defaultTtl), 7 * 24 * 3600));
    const download = urlOptions.download ?? null;
    const cached = urls.get(`${assetId}\u0000${download ?? ""}\u0000${ttl}`);
    if (cached && now() < cached.refreshAt) return Promise.resolve(cached.url);
    return new Promise<string>((resolve, reject) => {
      queue.push({ assetId, ttl, download, resolve, reject });
      if (!flushScheduled) {
        flushScheduled = true;
        // one describe + one signing request for every url() asked for in the same task (a grid of thumbnails)
        queueMicrotask(() => {
          void flushUrls();
        });
      }
    });
  }

  async function get(assetId: Uuid, getOptions: { signal?: AbortSignal } = {}): Promise<Blob> {
    const { signal } = getOptions;
    throwIfAborted(signal);
    const [asset] = await describe([assetId]);
    if (!asset) throw platformError("not_found", { status: 404, detail: "asset" });
    if (asset.status !== "ready") throw platformError("asset_not_ready", { status: 409, detail: "asset" });
    const cached = cache ? await cache.get(asset.sha256) : null;
    if (cached && cached.size === asset.byteSize) return retype(cached, asset.mimeType);
    for (let attempt = 0; ; attempt += 1) {
      const blob = await withRetry(() => transport.download(asset.objectPath, signal), signal);
      throwIfAborted(signal);
      if (blob.size === asset.byteSize && (await sha256Hex(blob)) === asset.sha256) {
        const typed = retype(blob, asset.mimeType);
        if (cache) await cache.put(asset.sha256, typed);
        return typed;
      }
      // a truncated or corrupted transfer: try once more, then give up loudly
      if (attempt >= 1) {
        throw platformError("unknown", { detail: `checksum mismatch for asset ${asset.id}`, message: "A downloaded file was damaged in transit." });
      }
    }
  }

  return {
    put,
    describe,
    url,
    get,
    reset() {
      rows.clear();
      idBySha.clear();
      urls.clear();
    },
  };
}
