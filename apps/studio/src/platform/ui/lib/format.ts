// Display formatting for sizes, counts, durations and names. Everything user-visible goes through Intl
// (APPLE_STYLE_SPEC §4.3); sizes use decimal units like Finder (1 KB = 1000 bytes).

const DEFAULT_LOCALE = "en-US";

const UNITS = ["KB", "MB", "GB", "TB", "PB"] as const;

interface ScaledBytes {
  value: number;
  /** null for plain bytes. */
  unit: (typeof UNITS)[number] | null;
  fractionDigits: number;
}

function scaleBytes(bytes: number): ScaledBytes {
  if (bytes < 1000) return { value: Math.round(bytes), unit: null, fractionDigits: 0 };
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1000 && unitIndex < UNITS.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  let fractionDigits = value < 100 ? 1 : 0;
  // 999.96 KB rounds to "1,000 KB": carry into the next unit instead
  const rounded = Number(value.toFixed(fractionDigits));
  if (rounded >= 1000 && unitIndex < UNITS.length - 1) {
    value = rounded / 1000;
    unitIndex += 1;
    fractionDigits = 1;
  }
  return { value, unit: UNITS[unitIndex] ?? null, fractionDigits };
}

function formatNumber(value: number, fractionDigits: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: fractionDigits }).format(value);
}

/** "0 bytes", "1 byte", "512 KB", "3.2 GB". Unknown or negative sizes read "—". */
export function formatBytes(bytes: number, locale: string = DEFAULT_LOCALE): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const scaled = scaleBytes(bytes);
  if (scaled.unit === null) return `${formatNumber(scaled.value, 0, locale)} ${scaled.value === 1 ? "byte" : "bytes"}`;
  return `${formatNumber(scaled.value, scaled.fractionDigits, locale)} ${scaled.unit}`;
}

/** "3.2 of 50 GB" when both share a unit, "312 MB of 50 GB" otherwise (sidebar footer, storage meter). */
export function formatUsage(usedBytes: number, quotaBytes: number, locale: string = DEFAULT_LOCALE): string {
  const used = scaleBytes(Math.max(0, usedBytes));
  const quota = scaleBytes(Math.max(0, quotaBytes));
  if (used.unit !== null && used.unit === quota.unit) {
    return `${formatNumber(used.value, used.fractionDigits, locale)} of ${formatBytes(quotaBytes, locale)}`;
  }
  return `${formatBytes(Math.max(0, usedBytes), locale)} of ${formatBytes(quotaBytes, locale)}`;
}

export type StorageLevel = "normal" | "warning" | "full";

export function storageFraction(usedBytes: number, quotaBytes: number): number {
  if (!(quotaBytes > 0) || !Number.isFinite(usedBytes)) return 0;
  return Math.min(1, Math.max(0, usedBytes / quotaBytes));
}

/** ≥ 90 % warns (orange), 100 % is full (red) — §2.16 and §3.7. */
export function storageLevel(usedBytes: number, quotaBytes: number): StorageLevel {
  if (!(quotaBytes > 0)) return "normal";
  const fraction = usedBytes / quotaBytes;
  if (fraction >= 1) return "full";
  if (fraction >= 0.9) return "warning";
  return "normal";
}

/** "1 Item", "1,284 Items" (Title Case nouns, as in toolbar subtitles). */
export function formatCount(count: number, singular: string, plural: string = `${singular}s`, locale: string = DEFAULT_LOCALE): string {
  const safe = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  return `${new Intl.NumberFormat(locale).format(safe)} ${safe === 1 ? singular : plural}`;
}

/** "0:42", "12:05", "1:02:03" (duration chips). */
export function formatDuration(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export function formatPercent(fraction: number, locale: string = DEFAULT_LOCALE): string {
  const safe = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(safe);
}

/** Avatar fallback: "Daniil Emtsev" → "DE", "daniil@example.com" → "D", nothing → "?". */
export function initials(name: string | null | undefined): string {
  const text = (name ?? "").trim();
  if (text === "") return "?";
  const local = text.includes("@") ? text.slice(0, text.indexOf("@")) : text;
  const words = local.split(/[\s._-]+/).filter((word) => word !== "");
  if (words.length === 0) return text.charAt(0).toLocaleUpperCase();
  if (text.includes("@") || words.length === 1) return (words[0] ?? "").charAt(0).toLocaleUpperCase();
  const first = words[0] ?? "";
  const last = words[words.length - 1] ?? "";
  return `${first.charAt(0)}${last.charAt(0)}`.toLocaleUpperCase();
}

/** Lucide stroke widths from §0.8: 1.75 at text sizes, 1.5 from 20 px up. */
export function iconStrokeWidth(size: number): number {
  return size < 20 ? 1.75 : 1.5;
}
