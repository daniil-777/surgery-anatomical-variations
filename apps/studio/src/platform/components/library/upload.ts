// One upload into the Library, start to finish: a local probe (pixel size, duration, geometry counts and a thumbnail;
// optional — a file without a preview is still stored) → the file as an asset (hash, reserve, upload, confirm, with
// progress) → the thumbnail as an asset → the library item. React-free; the backend and the probe are injected, so the
// pipeline is unit-tested in node against the in-memory backend.
import type { JsonObject, LibraryItem, PlatformBackend } from "../../core/types";
import { PlatformError, isPlatformError } from "../../core/types";
import { fileExtension, libraryFilename, titleFromFilename, type UploadPlan } from "./uploadKind";

export interface ProbeResult {
  /** A small WebP (or PNG) still; null when none could be made. */
  thumbnail: Blob | null;
  /** Facts stored in metadata.media (only finite, positive numbers and a verbatim generator string). */
  media: {
    width?: number | undefined;
    height?: number | undefined;
    durationMs?: number | undefined;
    vertices?: number | undefined;
    triangles?: number | undefined;
    meshes?: number | undefined;
    generator?: string | undefined;
  };
}

export type ProbeFn = (file: Blob, plan: UploadPlan, signal: AbortSignal) => Promise<ProbeResult>;

export type UploadPhase = "preparing" | "uploading" | "finishing";

export interface UploadOptions {
  backend: Pick<PlatformBackend, "assets" | "library">;
  probe: ProbeFn;
  signal: AbortSignal;
  /** 0…1 across the whole upload, with the current phase. */
  onProgress?: ((fraction: number, phase: UploadPhase) => void) | undefined;
  /** The probe's thumbnail, as soon as it exists (the card shows it while the file uploads). */
  onPreview?: ((thumbnail: Blob) => void) | undefined;
}

export interface UploadFile {
  name: string;
  size: number;
}

const PREPARE_SHARE = 0.05;
const UPLOAD_SHARE = 0.85;

function cancelled(): PlatformError {
  return new PlatformError("aborted", "The upload was cancelled.");
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** metadata for an uploaded file: where it came from and what the browser measured (never more than that). */
export function uploadMetadata(file: UploadFile, plan: UploadPlan, probe: ProbeResult): JsonObject {
  const media: JsonObject = {};
  const width = finitePositive(probe.media.width);
  const height = finitePositive(probe.media.height);
  const durationMs = finitePositive(probe.media.durationMs);
  if (width !== undefined) media.width = Math.round(width);
  if (height !== undefined) media.height = Math.round(height);
  if (durationMs !== undefined) media.durationMs = Math.round(durationMs);
  for (const key of ["vertices", "triangles", "meshes"] as const) {
    const value = probe.media[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) media[key] = Math.round(value);
  }
  const generator = probe.media.generator?.trim();
  if (generator) media.generator = generator.slice(0, 200);
  const metadata: JsonObject = {
    source: { kind: "upload", filename: libraryFilename(file.name, fileExtension(file.name)), format: plan.format, mimeType: plan.mimeType },
  };
  if (Object.keys(media).length > 0) metadata.media = media;
  return metadata;
}

/** Uploads `file` as a new library item described by `plan`; rejects with PlatformError (code "aborted" when cancelled). */
export async function uploadToLibrary(file: Blob & UploadFile, plan: UploadPlan, options: UploadOptions): Promise<LibraryItem> {
  const { backend, probe, signal, onProgress, onPreview } = options;
  const check = () => {
    if (signal.aborted) throw cancelled();
  };
  check();
  onProgress?.(0, "preparing");
  let probed: ProbeResult = { thumbnail: null, media: {} };
  try {
    probed = await probe(file, plan, signal);
  } catch (error) {
    // a preview is a nicety: anything but a cancellation lets the upload go on without one
    if (signal.aborted || isPlatformError(error, "aborted")) throw cancelled();
  }
  check();
  if (probed.thumbnail) onPreview?.(probed.thumbnail);
  onProgress?.(PREPARE_SHARE, "uploading");

  const asset = await backend.assets.put(file, {
    mimeType: plan.mimeType,
    signal,
    onProgress: ({ loaded, total }) => onProgress?.(PREPARE_SHARE + UPLOAD_SHARE * (total > 0 ? Math.min(1, loaded / total) : 1), "uploading"),
  });
  check();
  onProgress?.(PREPARE_SHARE + UPLOAD_SHARE, "finishing");

  let thumbnailAssetId: string | null = null;
  if (probed.thumbnail && probed.thumbnail.size > 0) {
    try {
      const thumbnail = await backend.assets.put(probed.thumbnail, {
        mimeType: probed.thumbnail.type === "image/png" ? "image/png" : probed.thumbnail.type === "image/jpeg" ? "image/jpeg" : "image/webp",
        signal,
      });
      thumbnailAssetId = thumbnail.id;
    } catch (error) {
      // the item is still worth keeping without its thumbnail, unless the person cancelled
      if (signal.aborted || isPlatformError(error, "aborted")) throw cancelled();
    }
  }
  check();

  const item = await backend.library.create({
    kind: plan.kind,
    title: titleFromFilename(file.name),
    files: [{ filename: libraryFilename(file.name, fileExtension(file.name) || plan.format.toLowerCase()), assetId: asset.id, role: plan.role, position: 0 }],
    thumbnailAssetId,
    metadata: uploadMetadata(file, plan, probed),
  });
  onProgress?.(1, "finishing");
  return item;
}
