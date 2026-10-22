// The Version History model (APPLE_STYLE_SPEC §3.6.3): kind labels, titles, local-day groups with named versions
// pinned on top, runs of autosaves folded into one row, and the retention hint. Pure and React-free (unit-tested in node).

import type { ProjectVersion, VersionKind } from "../../core/types";

export const VERSION_KIND_LABEL: Readonly<Record<VersionKind, string>> = {
  initial: "Created",
  autosave: "Autosave",
  manual: "Saved",
  named: "Named",
  restore: "Restored",
  duplicate: "Copy",
  import: "Imported",
};

export function versionKindLabel(kind: VersionKind): string {
  return VERSION_KIND_LABEL[kind] ?? "Version";
}

/** A version with a name is kept forever (DESIGN.md D6); whatever its kind, the name makes it "named". */
export function isNamedVersion(version: Pick<ProjectVersion, "label">): boolean {
  return version.label !== null && version.label.trim() !== "";
}

/** "Liver baseline" for a named version, else "Version 7". */
export function versionTitle(version: Pick<ProjectVersion, "label" | "seq">): string {
  return isNamedVersion(version) ? (version.label ?? "").trim() : `Version ${version.seq}`;
}

/** The database refuses to delete the current version and named ones (delete_version). */
export function canDeleteVersion(version: Pick<ProjectVersion, "id" | "label">, headVersionId: string | null): boolean {
  return !isNamedVersion(version) && version.id !== headVersionId;
}

/** The name a new named version gets by default ("Version 8" after head 7). */
export function nextVersionName(headSeq: number): string {
  return `Version ${Math.max(0, Math.floor(headSeq)) + 1}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Calendar days from `date` to `now` in local time (0 = today); robust across daylight-saving changes. */
export function localDaysAgo(date: Date, now: Date): number {
  const from = startOfLocalDay(date);
  const to = startOfLocalDay(now);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/** Local calendar day as YYYY-MM-DD (group keys). */
export function localDayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today, Yesterday, a weekday for 2–6 days ago, then "October 14" (this year) or "December 3, 2025". */
export function dayLabel(date: Date, now: Date, locale = "en-US"): string {
  const days = localDaysAgo(date, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "long", day: "numeric" } : { month: "long", day: "numeric", year: "numeric" }).format(date);
}

/** "2:32 PM" (or "14:32" where the locale uses 24 hours). */
export function formatVersionTime(iso: string, locale = "en-US"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
}

/** "Today at 2:32 PM", "Yesterday at 9:05 AM", "Oct 14 at 11:00 AM". */
export function formatSavedAt(iso: string, now: Date, locale = "en-US"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = localDaysAgo(date, now);
  const time = formatVersionTime(iso, locale);
  if (days <= 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = new Intl.DateTimeFormat(locale, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(date);
  return `${day} at ${time}`;
}

export type VersionRow =
  | { type: "version"; version: ProjectVersion }
  /** Consecutive autosaves folded into "6 Autosaves" (newest first inside). */
  | { type: "autosaves"; key: string; versions: ProjectVersion[] };

export interface VersionDayGroup {
  key: string;
  label: string;
  rows: VersionRow[];
}

export interface VersionHistoryModel {
  /** The current version (head), shown on top as "Current Version". */
  current: ProjectVersion | null;
  /** Named versions other than the head, newest first. */
  named: ProjectVersion[];
  /** Everything else by local day, newest first. */
  days: VersionDayGroup[];
  total: number;
}

export interface VersionHistoryOptions {
  now: Date;
  headVersionId: string | null;
  locale?: string | undefined;
  /** "named" keeps only named versions (and the head). */
  filter?: "all" | "named" | undefined;
  /** Runs of at least this many autosaves fold into one row (default 3; 0 never folds). */
  foldAutosavesFrom?: number | undefined;
}

function newestFirst(a: ProjectVersion, b: ProjectVersion): number {
  if (a.seq !== b.seq) return b.seq - a.seq;
  return b.createdAt.localeCompare(a.createdAt);
}

/** Folds runs of plain autosaves (unnamed) into one row; other versions stay rows of their own. */
export function foldAutosaves(versions: readonly ProjectVersion[], minimumRun = 3): VersionRow[] {
  const rows: VersionRow[] = [];
  let run: ProjectVersion[] = [];
  const flush = () => {
    if (minimumRun > 0 && run.length >= minimumRun) {
      rows.push({ type: "autosaves", key: `autosaves-${run[0]?.id ?? ""}`, versions: run });
    } else {
      for (const version of run) rows.push({ type: "version", version });
    }
    run = [];
  };
  for (const version of versions) {
    if (version.kind === "autosave" && !isNamedVersion(version)) {
      run.push(version);
      continue;
    }
    flush();
    rows.push({ type: "version", version });
  }
  flush();
  return rows;
}

export function buildVersionHistory(versions: readonly ProjectVersion[], options: VersionHistoryOptions): VersionHistoryModel {
  const locale = options.locale ?? "en-US";
  const sorted = [...versions].sort(newestFirst);
  const current = sorted.find((version) => version.id === options.headVersionId) ?? null;
  const rest = sorted.filter((version) => version !== current);
  const named = rest.filter(isNamedVersion);
  const timeline = options.filter === "named" ? [] : rest.filter((version) => !isNamedVersion(version));
  const days: VersionDayGroup[] = [];
  for (const version of timeline) {
    const date = new Date(version.createdAt);
    const key = Number.isNaN(date.getTime()) ? "unknown" : localDayKey(date);
    let group = days[days.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: key === "unknown" ? "Earlier" : dayLabel(date, options.now, locale), rows: [] };
      days.push(group);
    }
    group.rows.push({ type: "version", version });
  }
  const fold = options.foldAutosavesFrom ?? 3;
  for (const group of days) {
    const plain = group.rows.map((row) => (row.type === "version" ? row.version : null)).filter((row): row is ProjectVersion => row !== null);
    group.rows = foldAutosaves(plain, fold);
  }
  return { current, named, days, total: sorted.length };
}

/**
 * Days until maintenance may remove an unnamed, non-current version (the plan's retention window; the newest five
 * unnamed versions always stay), or null when it is kept. `rank` is the version's index among unnamed non-current
 * versions, newest first.
 */
export function daysUntilExpiry(createdAt: string, retentionDays: number, rank: number, now: Date): number | null {
  if (!(retentionDays > 0) || rank < 5) return null;
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return null;
  const expires = created + retentionDays * 86_400_000;
  return Math.max(0, Math.ceil((expires - now.getTime()) / 86_400_000));
}

/** The footer note under the panel, honest about the retention rule. */
export function retentionNote(retentionDays: number | null): string {
  if (retentionDays === null || !(retentionDays > 0)) return "Named versions are kept until you remove their name.";
  const days = Math.round(retentionDays);
  return `Unnamed versions are kept for ${days} ${days === 1 ? "day" : "days"} (the newest five always stay). Named versions are kept until you remove their name.`;
}
