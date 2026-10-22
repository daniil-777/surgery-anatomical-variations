// The Projects page's list logic (APPLE_STYLE_SPEC §3.3): filtering by lab, favourites and search, the three sort
// orders, relative "Edited …" times and copy names. Pure and React-free (unit-tested in node).

import type { Project } from "../../core/types";

export type ProjectSort = "recent" | "name" | "created";
export type ProjectView = "grid" | "list";

export const PROJECT_SORTS: ReadonlyArray<{ value: ProjectSort; label: string }> = [
  { value: "recent", label: "Date Edited" },
  { value: "name", label: "Name" },
  { value: "created", label: "Date Created" },
];

export interface ProjectFilter {
  labId?: string | undefined;
  favoritesOnly?: boolean | undefined;
  search?: string | undefined;
}

/** Case- and accent-insensitive "contains" for titles (the search field). */
export function normalizeForSearch(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("en-US").trim();
}

export function filterProjects(projects: readonly Project[], filter: ProjectFilter): Project[] {
  const needle = normalizeForSearch(filter.search ?? "");
  const words = needle === "" ? [] : needle.split(/\s+/);
  return projects.filter((project) => {
    if (project.trashedAt !== null) return false;
    if (filter.labId && project.labId !== filter.labId) return false;
    if (filter.favoritesOnly && !project.favorite) return false;
    if (words.length === 0) return true;
    const haystack = normalizeForSearch(`${project.title} ${project.description}`);
    return words.every((word) => haystack.includes(word));
  });
}

const collator = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });

/** The time a project last changed for people: its draft or its newest version. */
export function editedAt(project: Pick<Project, "draftSavedAt" | "updatedAt">): string {
  const draft = project.draftSavedAt;
  if (draft && draft > project.updatedAt) return draft;
  return project.updatedAt;
}

export function sortProjects(projects: readonly Project[], sort: ProjectSort): Project[] {
  const list = [...projects];
  list.sort((a, b) => {
    let order = 0;
    if (sort === "name") order = collator.compare(a.title, b.title);
    else if (sort === "created") order = b.createdAt.localeCompare(a.createdAt);
    else order = editedAt(b).localeCompare(editedAt(a));
    return order !== 0 ? order : a.id.localeCompare(b.id);
  });
  return list;
}

/** "just now", "5 min ago", "2 hr ago", "yesterday", "Tuesday", "Oct 14", "Dec 3, 2025". */
export function relativeTime(iso: string, now: Date, locale = "en-US"): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, (now.getTime() - time) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const date = new Date(time);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // within the last hours of today; earlier days read as days ("yesterday", a weekday, a date)
  if (time >= startOfToday || hours < 3) return `${hours} hr ago`;
  const days = Math.round((startOfToday - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  if (days <= 1) return "yesterday";
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(date);
}

/** "Organ Design · Edited 2 hr ago" (card and row subtitles). */
export function projectSubtitle(project: Pick<Project, "draftSavedAt" | "updatedAt">, labTitle: string, now: Date, locale = "en-US"): string {
  const when = relativeTime(editedAt(project), now, locale);
  return when ? `${labTitle} · Edited ${when}` : labTitle;
}

/** "Liver baseline copy", then "Liver baseline copy 2" … — unique among the given titles, at most 120 characters. */
export function copyTitle(title: string, existing: Iterable<string> = []): string {
  const taken = new Set([...existing].map((value) => value.toLocaleLowerCase("en-US")));
  const base = title.trim() === "" ? "Untitled" : title.trim();
  const fit = (suffix: string) => `${base.slice(0, Math.max(1, 120 - suffix.length)).trimEnd()}${suffix}`;
  let candidate = fit(" copy");
  for (let copy = 2; taken.has(candidate.toLocaleLowerCase("en-US")) && copy < 1000; copy += 1) candidate = fit(` copy ${copy}`);
  return candidate;
}

/** A project title the database accepts, or null when it would be empty. */
export function cleanProjectTitle(title: string): string | null {
  const value = title.replace(/\s+/g, " ").trim();
  if (value === "") return null;
  return value.length > 120 ? value.slice(0, 120).trimEnd() : value;
}

/** The default name of a project saved from a lab ("Organ Design 3" when "Organ Design 2" exists). */
export function defaultProjectTitle(suggested: string | null | undefined, labTitle: string, existing: Iterable<string> = []): string {
  const base = cleanProjectTitle(suggested ?? "") ?? labTitle;
  const taken = new Set([...existing].map((value) => value.toLocaleLowerCase("en-US")));
  if (!taken.has(base.toLocaleLowerCase("en-US"))) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base.slice(0, 114)} ${index}`;
    if (!taken.has(candidate.toLocaleLowerCase("en-US"))) return candidate;
  }
  return base;
}
