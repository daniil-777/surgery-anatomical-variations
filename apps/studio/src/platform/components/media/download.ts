// Saving files from the shell: a signed URL (the storage server sets Content-Disposition when asked for a download
// name), a Blob the page already holds, or a zip of several files built in the browser. The zip is streamed: files are
// read one after another and their bytes pass straight through fflate (stored as they are — images, video and GLB do
// not compress — and deflated for text), so only the finished archive is held, never every file at once.
import { PlatformError } from "../../core/types";

/** Starts a download of `url` under `filename` (anchors honour `download` for same-origin and blob: URLs). */
export function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** Saves bytes the page holds; the object URL is released once the browser has taken the file. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface ZipSource {
  /** The entry path inside the archive (zipNames.ts makes them unique). */
  path: string;
  /** Expected size in bytes, for progress (0 when unknown). */
  size: number;
  /** Deflate (text, JSON) or store as is (media). */
  compress: boolean;
  modified?: Date | undefined;
  /** Reads the file when its turn comes. */
  open: (signal?: AbortSignal) => Promise<Blob>;
}

export interface ZipProgress {
  /** 1-based index of the file being added. */
  file: number;
  files: number;
  /** Bytes read so far across all files, of `total`. */
  loaded: number;
  total: number;
  path: string;
}

function aborted(): PlatformError {
  return new PlatformError("aborted", "Cancelled.");
}

/** Builds a zip of `sources`, reading them sequentially; rejects with PlatformError("aborted") when cancelled. */
export async function buildZip(
  sources: readonly ZipSource[],
  options: { signal?: AbortSignal | undefined; onProgress?: ((progress: ZipProgress) => void) | undefined } = {},
): Promise<Blob> {
  const { signal, onProgress } = options;
  const { Zip, ZipDeflate, ZipPassThrough } = await import("fflate");
  const chunks: Uint8Array[] = [];
  let failure: unknown = null;
  let finished = false;
  const zip = new Zip((error, data, final) => {
    if (error) {
      failure = error;
      return;
    }
    chunks.push(data);
    if (final) finished = true;
  });
  const total = sources.reduce((sum, source) => sum + Math.max(0, source.size), 0);
  let loaded = 0;
  try {
    for (const [index, source] of sources.entries()) {
      if (signal?.aborted) throw aborted();
      onProgress?.({ file: index + 1, files: sources.length, loaded, total, path: source.path });
      const blob = await source.open(signal);
      if (signal?.aborted) throw aborted();
      const entry = source.compress ? new ZipDeflate(source.path, { level: 6 }) : new ZipPassThrough(source.path);
      if (source.modified) entry.mtime = source.modified;
      zip.add(entry);
      const reader = blob.stream().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal?.aborted) throw aborted();
          entry.push(value, false);
          loaded += value.byteLength;
          onProgress?.({ file: index + 1, files: sources.length, loaded, total, path: source.path });
        }
      } finally {
        reader.releaseLock();
      }
      entry.push(new Uint8Array(0), true);
      if (failure) throw failure;
    }
    zip.end();
  } catch (error) {
    zip.terminate();
    throw error;
  }
  if (failure) throw failure;
  if (!finished) throw new PlatformError("unknown", "The archive could not be finished.");
  return new Blob(chunks as BlobPart[], { type: "application/zip" });
}
