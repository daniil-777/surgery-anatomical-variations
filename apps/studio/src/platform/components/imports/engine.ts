// One import, start to finish: the files of one group → analysis (core/imports) → the original, the preview GLB and the
// thumbnail uploaded as assets → the imported object. React-free; the analyser is injectable so the pipeline is
// unit-tested in node against the in-memory backend.

import { errorCode, errorMessage } from "../../app/messages";
import {
  analyzeFiles,
  importedObjectInput,
  sniffFile,
  sniffRefusal,
  type AnalyzeOptions,
  type ImportAnalysis,
} from "../../core/imports";
import { PlatformError, type AllowedMimeType, type Asset, type ImportedObject, type PlatformBackend, type PlatformErrorCode } from "../../core/types";
import type { JobState } from "./model";

export type Analyze = (files: File[], options: AnalyzeOptions) => Promise<ImportAnalysis>;

export interface RunImportOptions {
  backend: Pick<PlatformBackend, "assets" | "imports">;
  /** The plan's per-file limit (Usage.maxFileBytes). */
  maxBytes: number;
  signal: AbortSignal;
  onState: (state: JobState) => void;
  /** The file's name says it is not importable (a .blend …): read only its first bytes to explain why. */
  sniffFirst?: boolean | undefined;
  /** Defaults to core/imports analyzeFiles. */
  analyze?: Analyze | undefined;
}

export interface ImportFailure {
  reason: string;
  advice: string | null;
  /** Worth another attempt as it is (connection, server busy); refusals of the file itself are not. */
  retryable: boolean;
}

function aborted(): PlatformError {
  return new PlatformError("aborted", "The import was cancelled.", { detail: "aborted" });
}

export async function runImport(files: File[], options: RunImportOptions): Promise<ImportedObject> {
  const { backend, signal, onState } = options;
  const analyze = options.analyze ?? analyzeFiles;
  if (signal.aborted) throw aborted();

  const single = files.length === 1 ? files[0] : undefined;
  if (options.sniffFirst && single) {
    const sniffed = await sniffFile(single);
    if (sniffed.kind === "unsupported") throw sniffRefusal(sniffed);
  }

  onState({ status: "analyzing", stage: "reading", fraction: 0 });
  const analysis = await analyze(files, {
    signal,
    maxBytes: options.maxBytes,
    onProgress: (progress) => onState({ status: "analyzing", stage: progress.stage, fraction: progress.fraction }),
  });
  if (signal.aborted) throw aborted();

  const total = analysis.original.size + (analysis.displayGlb?.size ?? 0) + (analysis.thumbnail?.size ?? 0);
  let uploaded = 0;
  onState({ status: "uploading", loaded: 0, total });
  const upload = async (blob: Blob, mimeType: AllowedMimeType | undefined): Promise<Asset> => {
    const asset = await backend.assets.put(blob, {
      ...(mimeType ? { mimeType } : {}),
      signal,
      onProgress: (progress) => onState({ status: "uploading", loaded: uploaded + Math.min(progress.loaded, blob.size), total }),
    });
    uploaded += blob.size;
    onState({ status: "uploading", loaded: uploaded, total });
    return asset;
  };
  const original = await upload(analysis.original, analysis.originalMime);
  const display = analysis.displayGlb ? await upload(analysis.displayGlb, "model/gltf-binary") : null;
  // the thumbnail keeps its own type (WebP, or PNG where the browser cannot encode WebP)
  const thumbnail = analysis.thumbnail ? await upload(analysis.thumbnail, undefined) : null;
  if (signal.aborted) throw aborted();

  onState({ status: "saving" });
  return backend.imports.create(
    importedObjectInput(analysis, {
      originalAssetId: original.id,
      displayAssetId: display?.id ?? null,
      thumbnailAssetId: thumbnail?.id ?? null,
    }),
  );
}

/** ImportRejectedError (and ImportChoiceError) by shape: errors are never matched with instanceof in the platform. */
function isRejection(error: unknown): error is { reason: string; advice: string | null } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { reason?: unknown; advice?: unknown };
  return typeof candidate.reason === "string" && (candidate.advice === null || typeof candidate.advice === "string");
}

const RETRYABLE: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "network",
  "unknown",
  "asset_busy",
  "asset_not_ready",
  "upload_missing",
  "size_mismatch",
  "rate_limited",
]);

/** What an import row says when it fails: the importer's own reason and advice, or a friendly upload message. */
export function describeFailure(error: unknown): ImportFailure {
  if (isRejection(error)) return { reason: error.reason, advice: error.advice, retryable: false };
  return { reason: errorMessage(error, "upload"), advice: null, retryable: RETRYABLE.has(errorCode(error)) };
}

export function isCancellation(error: unknown): boolean {
  return errorCode(error) === "aborted";
}
