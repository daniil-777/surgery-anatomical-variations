// Budgets for analysing a person's 3D files in the browser. Every selected file (or every extracted zip entry) is
// held in memory while three.js builds geometry several times larger, so the caps apply before anything is decoded.

export const MiB = 1024 * 1024;

export const IMPORT_LIMITS = Object.freeze({
  /** Files in a selection, or files kept from a zip bundle. */
  files: 256,
  /** Bytes held for analysis: the selection, or a zip's declared uncompressed contents. */
  analysisBytes: 128 * MiB,
  /** Largest stored file (original or preview) when the plan's per-file limit is not known. */
  defaultStorageBytes: 128 * MiB,
  vertices: 2_000_000,
  triangles: 2_000_000,
  /** Distinct images referenced by materials. */
  textures: 64,
  /** Longest image side in pixels. */
  imageSide: 8192,
  /** Central-directory records read from one zip (junk included). */
  zipRecords: 10_000,
  /** Declared uncompressed ÷ compressed size above which an entry is treated as a zip bomb. */
  zipRatio: 200,
  /** Entries smaller than this are exempt from the ratio rule (tiny text files compress extremely well). */
  zipRatioMinBytes: 1 * MiB,
  /** Bytes of a file inspected by sniffing and header detection. */
  sniffBytes: 64 * 1024,
  /** Thumbnail edge in pixels. */
  thumbnailSize: 512,
});

export interface ImportBudget {
  /** Largest original or preview file the account may store (the plan's per-file limit). */
  storageBytes: number;
  /** Largest amount of file data held in memory for one analysis. */
  analysisBytes: number;
}

/** maxBytes is the plan's per-file limit; without it the default applies. */
export function importBudget(maxBytes?: number): ImportBudget {
  const storageBytes =
    maxBytes !== undefined && Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : IMPORT_LIMITS.defaultStorageBytes;
  return { storageBytes, analysisBytes: IMPORT_LIMITS.analysisBytes };
}

/** "50 MB", "1.5 GB", "800 KB" (binary units, the way the plans are defined). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MiB) return `${trimNumber(bytes / (1024 * MiB))} GB`;
  if (bytes >= MiB) return `${trimNumber(bytes / MiB)} MB`;
  if (bytes >= 1024) return `${trimNumber(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function trimNumber(value: number): string {
  return value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

/** "1,234,567" without depending on the runtime locale. */
export function formatCount(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
