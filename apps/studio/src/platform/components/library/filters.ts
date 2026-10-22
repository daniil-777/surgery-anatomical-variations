// What the Library grid shows and in which order: scope (all, favourites, one kind), search across the visible text of
// an item and the three sorts of the View menu. Pure, so the rules are unit-tested in node.
import type { LibraryItem } from "../../core/types";
import { KIND_INFO, LIBRARY_KIND_ORDER, type LibraryScope } from "./kinds";

export type LibrarySort = "newest" | "name" | "size";

export const LIBRARY_SORTS: readonly LibrarySort[] = ["newest", "name", "size"];

export const SORT_LABEL: Readonly<Record<LibrarySort, string>> = { newest: "Date Added", name: "Name", size: "Size" };

export function parseSort(value: unknown): LibrarySort {
  return typeof value === "string" && (LIBRARY_SORTS as readonly string[]).includes(value) ? (value as LibrarySort) : "newest";
}

type ScopedFields = Pick<LibraryItem, "kind" | "favorite">;
type SearchFields = Pick<LibraryItem, "title" | "description" | "tags" | "kind">;
type SortFields = Pick<LibraryItem, "id" | "title" | "byteSize" | "createdAt">;

export function inScope(item: ScopedFields, scope: LibraryScope): boolean {
  if (scope === "all") return true;
  if (scope === "favorites") return item.favorite;
  return item.kind === scope;
}

/** Case- and accent-insensitive form used for matching ("Rénal" finds "renal"). */
export function foldText(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en");
}

export function searchTerms(search: string): string[] {
  return foldText(search).split(/\s+/).filter((term) => term !== "");
}

/** Every term must appear in the title, description, a tag or the kind's name. */
export function matchesSearch(item: SearchFields, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const kind = KIND_INFO[item.kind];
  const haystack = foldText([item.title, item.description, ...item.tags, kind.singular, kind.plural].join("\n"));
  return terms.every((term) => haystack.includes(term));
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Newest first; equal timestamps fall back to the id so the order never flickers between loads. */
function byNewest(a: SortFields, b: SortFields): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function compareItems(a: SortFields, b: SortFields, sort: LibrarySort): number {
  switch (sort) {
    case "name":
      return collator.compare(a.title, b.title) || byNewest(a, b);
    case "size":
      return b.byteSize - a.byteSize || collator.compare(a.title, b.title) || byNewest(a, b);
    case "newest":
      return byNewest(a, b);
  }
}

export interface LibraryView {
  scope: LibraryScope;
  search: string;
  sort: LibrarySort;
}

/** The items of `scope` that match `search`, sorted; the input is not modified. */
export function visibleItems<T extends LibraryItem>(items: readonly T[], view: LibraryView): T[] {
  const terms = searchTerms(view.search);
  return items
    .filter((item) => item.trashedAt === null && inScope(item, view.scope) && matchesSearch(item, terms))
    .sort((a, b) => compareItems(a, b, view.sort));
}

export type ScopeCounts = Record<LibraryScope, number>;

/** Items per scope (trashed items excluded), for the filter menu. */
export function scopeCounts(items: readonly Pick<LibraryItem, "kind" | "favorite" | "trashedAt">[]): ScopeCounts {
  const counts = { all: 0, favorites: 0 } as ScopeCounts;
  for (const kind of LIBRARY_KIND_ORDER) counts[kind] = 0;
  for (const item of items) {
    if (item.trashedAt !== null) continue;
    counts.all += 1;
    if (item.favorite) counts.favorites += 1;
    counts[item.kind] += 1;
  }
  return counts;
}

/** Sum of the items' sizes (an upper bound: items that share a file count it once each). */
export function totalBytes(items: readonly Pick<LibraryItem, "byteSize">[]): number {
  return items.reduce((sum, item) => sum + (Number.isFinite(item.byteSize) && item.byteSize > 0 ? item.byteSize : 0), 0);
}
