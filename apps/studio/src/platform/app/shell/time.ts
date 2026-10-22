// Dates as the shell shows them: "Edited 2 h ago", "29 days left", "Good evening, Daniil". Everything goes through
// Intl (APPLE_STYLE_SPEC §4.3) with an explicit `now`, so the wording is unit-tested in node.

const LOCALE = "en-US";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Items in the Trash are deleted after this many days (maintenance_run, …_auth_usage_maintenance.sql). */
export const TRASH_RETENTION_DAYS = 30;

function toTime(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "Oct 21" in the current year, "Oct 21, 2025" otherwise. */
export function formatShortDate(value: string | number | Date, now: number = Date.now()): string {
  const time = toTime(value);
  if (!Number.isFinite(time)) return "";
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(LOCALE, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(time);
}

/** "Oct 21, 2026 at 9:41 PM" (settings, details). */
export function formatDateTime(value: string | number | Date): string {
  const time = toTime(value);
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" }).format(time);
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", then a date. */
export function formatRelative(value: string | number | Date, now: number = Date.now()): string {
  const time = toTime(value);
  if (!Number.isFinite(time)) return "";
  const elapsed = now - time;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY);
  if (days <= 0) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return formatShortDate(time, now);
}

/** "Edited 2 h ago" (project cards). */
export function formatEdited(value: string | number | Date, now: number = Date.now()): string {
  const relative = formatRelative(value, now);
  return relative === "" ? "" : `Edited ${relative}`;
}

/** Whole days left before a trashed item is deleted for good: 29 right after it moved there, 0 on its last day. */
export function trashDaysLeft(trashedAt: string | number | Date, now: number = Date.now(), retentionDays = TRASH_RETENTION_DAYS): number {
  const time = toTime(trashedAt);
  if (!Number.isFinite(time)) return retentionDays;
  return Math.max(0, Math.floor((time + retentionDays * DAY - now) / DAY));
}

/** "29 days", "1 day", "Less than a day" (the Trash badge, as in Photos' Recently Deleted). */
export function formatDaysLeft(days: number): string {
  if (days <= 0) return "Less than a day";
  return days === 1 ? "1 day" : `${days} days`;
}

/** "Good morning", "Good afternoon" or "Good evening", with the first name when there is one. */
export function greeting(name: string | null | undefined, now: number = Date.now()): string {
  const hour = new Date(now).getHours();
  const part = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : "Good evening";
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? `${part}, ${first}` : part;
}
