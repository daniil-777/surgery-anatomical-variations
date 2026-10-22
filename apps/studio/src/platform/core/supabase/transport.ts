// The asset transport over Supabase: reserve_asset / confirm_asset RPCs, uploads into the private "user-content"
// bucket (one request up to 6 MB with x-upsert, TUS above), signed URLs and authenticated downloads. Uploads use fetch
// directly (not storage-js) so they can be aborted; every call needs a signed-in session and makes no request without.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssetReservation, AssetTransport, TransportUploadOptions } from "../assets";
import type { SupabasePlatformConfig } from "../config";
import { abortError, fromHttpFailure, fromPostgrestError, fromStorageError, isAbortError, platformError, throwIfAborted, toPlatformError } from "../errors";
import { tusUpload } from "../tus";
import type { AllowedMimeType, Asset, Uuid } from "../types";
import { isUuid } from "../memory/rules";
import type { SupabaseAuth } from "./auth";
import { asRows, isUsableAssetRow, mapAsset, mapReservation } from "./mappers";

export const USER_CONTENT_BUCKET = "user-content";
/** Content-addressed objects never change: browsers and the CDN may keep them for a year. */
const CACHE_SECONDS = "31536000";
const ASSET_COLUMNS = "id, sha256, byte_size, mime_type, object_path, status, created_at";
const DESCRIBE_CHUNK = 100;

export interface SupabaseTransportOptions {
  fetch: typeof fetch;
  /** Resumable uploads to <ref>.storage.supabase.co, Supabase's recommendation for large files (default true; the
   *  shell's Content-Security-Policy allows that host, DESIGN.md §15.12). Other hosts (local stacks) are unchanged. */
  directStorageHost?: boolean;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function bodyText(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export class SupabaseTransport implements AssetTransport {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly client: SupabaseClient,
    private readonly config: SupabasePlatformConfig,
    private readonly auth: SupabaseAuth,
    private readonly options: SupabaseTransportOptions,
  ) {
    this.fetch = options.fetch;
  }

  /** https://<ref>.supabase.co/storage/v1/upload/resumable (or the direct storage host). */
  tusEndpoint(): string {
    const url = new URL(this.config.supabaseUrl);
    if (this.options.directStorageHost ?? true) {
      const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
      if (match) url.hostname = `${match[1]}.storage.supabase.co`;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/storage/v1/upload/resumable`;
  }

  private async rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.auth.requireSession();
    throwIfAborted(signal);
    try {
      const request = this.client.rpc(name, args);
      const { data, error, status } = await (signal ? request.abortSignal(signal) : request);
      if (error) throw fromPostgrestError(error, status);
      return data as unknown;
    } catch (error) {
      if (signal?.aborted) throw abortError(error);
      throw toPlatformError(error);
    }
  }

  async reserve(input: { sha256: string; byteSize: number; mimeType: AllowedMimeType }, signal?: AbortSignal): Promise<AssetReservation> {
    return mapReservation(await this.rpc("reserve_asset", { p_sha256: input.sha256, p_byte_size: input.byteSize, p_mime_type: input.mimeType }, signal));
  }

  async uploadStandard(objectPath: string, blob: Blob, options: TransportUploadOptions): Promise<void> {
    const token = await this.auth.accessToken();
    throwIfAborted(options.signal);
    const url = `${this.config.supabaseUrl}/storage/v1/object/${USER_CONTENT_BUCKET}/${encodePath(objectPath)}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        apikey: this.config.supabaseKey,
        "content-type": options.mimeType,
        "cache-control": `max-age=${CACHE_SECONDS}`,
        // a pending reservation may already hold an earlier, interrupted copy of the same bytes
        "x-upsert": "true",
      },
      body: blob,
    };
    if (options.signal) init.signal = options.signal;
    let response: Response;
    try {
      response = await this.fetch(url, init);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw abortError(error);
      throw platformError("network", { status: 0, cause: error });
    }
    if (!response.ok) throw fromHttpFailure(response.status, await bodyText(response));
    options.onProgress?.(blob.size);
  }

  async uploadResumable(objectPath: string, blob: Blob, options: TransportUploadOptions): Promise<void> {
    await this.auth.requireSession();
    const upload: Parameters<typeof tusUpload>[0] = {
      endpoint: this.tusEndpoint(),
      file: blob,
      headers: async () => ({
        authorization: `Bearer ${await this.auth.accessToken()}`,
        apikey: this.config.supabaseKey,
        "x-upsert": "true",
      }),
      metadata: { bucketName: USER_CONTENT_BUCKET, objectName: objectPath, contentType: options.mimeType, cacheControl: CACHE_SECONDS },
      fetch: this.fetch,
      onProgress: (progress) => options.onProgress?.(progress.loaded),
    };
    if (options.signal) upload.signal = options.signal;
    await tusUpload(upload);
  }

  /**
   * The ready row as JSON. A wrong stored size answers 409 size_mismatch and leaves the reservation rejected (the
   * function commits that mark, DESIGN.md §15.4); the asset port then reserves and uploads once more.
   */
  async confirm(assetId: Uuid, signal?: AbortSignal): Promise<Asset> {
    return mapAsset(await this.rpc("confirm_asset", { p_asset_id: assetId }, signal));
  }

  async describe(assetIds: Uuid[]): Promise<Asset[]> {
    await this.auth.requireSession();
    const ids = [...new Set(assetIds.filter(isUuid).map((id) => id.toLowerCase()))];
    const result: Asset[] = [];
    for (let start = 0; start < ids.length; start += DESCRIBE_CHUNK) {
      const chunk = ids.slice(start, start + DESCRIBE_CHUNK);
      try {
        const { data, error, status } = await this.client.from("assets").select(ASSET_COLUMNS).in("id", chunk);
        if (error) throw fromPostgrestError(error, status);
        result.push(...asRows(data, "assets").filter(isUsableAssetRow).map(mapAsset));
      } catch (error) {
        throw toPlatformError(error);
      }
    }
    return result;
  }

  async signedUrls(objectPaths: string[], expiresInSeconds: number, options: { download?: string } = {}): Promise<Array<string | null>> {
    await this.auth.requireSession();
    if (objectPaths.length === 0) return [];
    try {
      const bucket = this.client.storage.from(USER_CONTENT_BUCKET);
      const { data, error } =
        options.download === undefined
          ? await bucket.createSignedUrls(objectPaths, expiresInSeconds)
          : await bucket.createSignedUrls(objectPaths, expiresInSeconds, { download: options.download });
      if (error) throw fromStorageError(error);
      const byPath = new Map<string, string>();
      for (const entry of data) if (entry.path && entry.signedUrl && !entry.error) byPath.set(entry.path, entry.signedUrl);
      return objectPaths.map((path) => byPath.get(path) ?? null);
    } catch (error) {
      throw toPlatformError(error);
    }
  }

  async download(objectPath: string, signal?: AbortSignal): Promise<Blob> {
    await this.auth.requireSession();
    throwIfAborted(signal);
    try {
      const { data, error } = await this.client.storage.from(USER_CONTENT_BUCKET).download(objectPath, {}, signal ? { signal } : {});
      if (error) throw fromStorageError(error);
      return data;
    } catch (error) {
      if (signal?.aborted) throw abortError(error);
      throw toPlatformError(error);
    }
  }
}
