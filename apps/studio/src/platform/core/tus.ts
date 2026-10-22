// A minimal TUS 1.0 client for Supabase Storage resumable uploads (files above 6 MB, DESIGN.md D11).
//   POST   <endpoint>      Upload-Length, Upload-Metadata (bucketName, objectName, contentType, cacheControl)
//                          → 201 Created, Location = the upload URL (valid 24 h)
//   PATCH  <upload URL>    Upload-Offset, application/offset+octet-stream, one chunk (Supabase requires exactly 6 MB
//                          per chunk except the last) → 204, Upload-Offset = bytes stored so far
//   HEAD   <upload URL>    → Upload-Offset, to resume after a failed PATCH
// Network failures, 5xx, 408/429, and on PATCH also 409 (offset mismatch, a second client) and 423 (locked) are
// retried with backoff after asking the server for its offset; 404/410 mean the upload expired and it starts again
// (once). Any other 4xx is final and mapped to a PlatformError.

import { abortError, fromHttpFailure, isAbortError, platformError, throwIfAborted, toPlatformError } from "./errors";
import { PlatformError, type UploadProgress } from "./types";

export const TUS_VERSION = "1.0.0";
/** Supabase accepts only 6 MB chunks on its resumable endpoint. */
export const TUS_CHUNK_SIZE = 6 * 1024 * 1024;
export const DEFAULT_TUS_RETRY_DELAYS_MS: readonly number[] = [0, 1000, 3000, 5000, 10000];

type HeaderSource = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export interface TusUploadOptions {
  /** e.g. https://<ref>.supabase.co/storage/v1/upload/resumable */
  endpoint: string;
  file: Blob;
  /** Sent with every request (authorization, apikey, x-upsert …); a function is called per request so a refreshed
   *  access token is picked up during long uploads. */
  headers?: HeaderSource;
  /** Upload-Metadata pairs (values are UTF-8, base64-encoded on the wire). */
  metadata?: Record<string, string>;
  chunkSize?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  retryDelaysMs?: readonly number[];
  /** Resume a known upload URL instead of creating one. */
  uploadUrl?: string | null;
  /** Called once the upload URL is known (to resume it later, e.g. after a reload). */
  onUploadUrl?: (url: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface TusUploadResult {
  uploadUrl: string;
  bytes: number;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** "key base64(value),key2 base64(value2)" as TUS 1.0 specifies. */
export function encodeTusMetadata(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => {
      if (!/^[^\s,]+$/.test(key)) throw platformError("invalid_input", { detail: `metadata key ${key}` });
      return `${key} ${base64Utf8(value)}`;
    })
    .join(",");
}

/** setTimeout as a promise that rejects with PlatformError("aborted") when the signal fires. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class TusStatusError extends Error {
  constructor(
    readonly method: "POST" | "HEAD" | "PATCH",
    readonly status: number,
    readonly body: string | null,
  ) {
    super(`TUS ${method} failed with HTTP ${status}`);
    this.name = "TusStatusError";
  }
}

function isTransient(error: unknown): boolean {
  if (error instanceof TusStatusError) {
    if (error.status >= 500 || error.status === 408 || error.status === 429) return true;
    return error.method !== "POST" && (error.status === 409 || error.status === 423);
  }
  return error instanceof PlatformError && error.code === "network";
}

function isExpired(error: unknown): boolean {
  return error instanceof TusStatusError && error.method !== "POST" && (error.status === 404 || error.status === 410);
}

function finalError(error: unknown, signal?: AbortSignal): PlatformError {
  if (signal?.aborted || isAbortError(error)) return abortError(error);
  if (error instanceof TusStatusError) return fromHttpFailure(error.status, error.body);
  return toPlatformError(error);
}

function readOffset(response: Response): number | null {
  const header = response.headers.get("upload-offset");
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  return Number(header.trim());
}

async function bodyText(response: Response): Promise<string | null> {
  try {
    const value = await response.text();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Uploads `file` with TUS 1.0, resuming after interruptions. Resolves when the server holds every byte. */
export async function tusUpload(options: TusUploadOptions): Promise<TusUploadResult> {
  const { file, signal } = options;
  const total = file.size;
  const chunkSize = options.chunkSize ?? TUS_CHUNK_SIZE;
  const delays = options.retryDelaysMs ?? DEFAULT_TUS_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw platformError("invalid_input", { detail: "chunkSize" });

  const headersFor = async (extra: Record<string, string>): Promise<Record<string, string>> => {
    const base = typeof options.headers === "function" ? await options.headers() : options.headers ?? {};
    return { ...base, "Tus-Resumable": TUS_VERSION, ...extra };
  };

  const send = async (url: string, method: "POST" | "HEAD" | "PATCH", headers: Record<string, string>, body?: Blob): Promise<Response> => {
    throwIfAborted(signal);
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    if (signal) init.signal = signal;
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw abortError(error);
      throw platformError("network", { status: 0, cause: error });
    }
  };

  const create = async (): Promise<string> => {
    const headers = await headersFor({ "Upload-Length": String(total) });
    if (options.metadata && Object.keys(options.metadata).length > 0) headers["Upload-Metadata"] = encodeTusMetadata(options.metadata);
    const response = await send(options.endpoint, "POST", headers);
    if (response.status !== 201 && response.status !== 200) throw new TusStatusError("POST", response.status, await bodyText(response));
    const location = response.headers.get("location");
    if (!location) throw platformError("unknown", { status: response.status, detail: "TUS create answered without a Location" });
    const url = new URL(location, options.endpoint).href;
    options.onUploadUrl?.(url);
    return url;
  };

  const head = async (url: string): Promise<number> => {
    const response = await send(url, "HEAD", await headersFor({}));
    if (response.status !== 200 && response.status !== 204) throw new TusStatusError("HEAD", response.status, null);
    const offset = readOffset(response);
    if (offset === null || offset > total) {
      throw platformError("unknown", { status: response.status, detail: "TUS HEAD without a valid Upload-Offset" });
    }
    return offset;
  };

  const patch = async (url: string, offset: number): Promise<number> => {
    const chunk = file.slice(offset, Math.min(offset + chunkSize, total));
    const headers = await headersFor({ "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" });
    const response = await send(url, "PATCH", headers, chunk);
    if (response.status !== 204 && response.status !== 200) throw new TusStatusError("PATCH", response.status, await bodyText(response));
    const next = readOffset(response);
    if (next === null || next <= offset || next > total) {
      throw platformError("unknown", { status: response.status, detail: `TUS PATCH answered Upload-Offset ${String(next)}` });
    }
    return next;
  };

  let url: string | null = options.uploadUrl ?? null;
  let offset = 0;
  let attempt = 0;
  let restarted = false;
  // true when the server's offset must be (re)read before the next PATCH: at the start and after every failure
  let sync = true;

  for (;;) {
    try {
      if (sync || url === null) {
        if (url === null) {
          url = await create();
          offset = 0;
        } else {
          offset = await head(url);
        }
        sync = false;
        options.onProgress?.({ loaded: offset, total });
      }
      if (offset >= total) return { uploadUrl: url, bytes: total };
      offset = await patch(url, offset);
      attempt = 0;
      options.onProgress?.({ loaded: offset, total });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw abortError(error);
      if (isExpired(error) && !restarted) {
        restarted = true;
        url = null;
        continue;
      }
      if (!isTransient(error) || attempt >= delays.length) throw finalError(error, signal);
      await sleep(delays[attempt] ?? 0, signal);
      attempt += 1;
      sync = true;
    }
  }
}
