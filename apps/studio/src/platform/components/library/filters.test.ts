import { describe, expect, it } from "vitest";
import type { LibraryItem, LibraryKind } from "../../core/types";
import { compareItems, foldText, inScope, matchesSearch, parseSort, scopeCounts, searchTerms, totalBytes, visibleItems } from "./filters";
import { emptyStateCopy, LIBRARY_SCOPES, scopeTitle, searchEmptyCopy } from "./kinds";

let counter = 0;
function item(fields: Partial<LibraryItem> & { kind?: LibraryKind } = {}): LibraryItem {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    kind: "shape",
    title: `Item ${counter}`,
    description: "",
    tags: [],
    labId: null,
    sourceProjectId: null,
    sourceVersionId: null,
    metadata: {},
    thumbnailAssetId: null,
    favorite: false,
    byteSize: 1000,
    createdAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
    trashedAt: null,
    ...fields,
  };
}

describe("scopes", () => {
  it("filters by kind and favourites across kinds", () => {
    const shape = item({ kind: "shape" });
    const video = item({ kind: "recording", favorite: true });
    expect(inScope(shape, "all")).toBe(true);
    expect(inScope(shape, "shape")).toBe(true);
    expect(inScope(shape, "recording")).toBe(false);
    expect(inScope(shape, "favorites")).toBe(false);
    expect(inScope(video, "favorites")).toBe(true);
  });

  it("counts every scope and skips trashed items", () => {
    const counts = scopeCounts([
      item({ kind: "shape", favorite: true }),
      item({ kind: "shape" }),
      item({ kind: "image" }),
      item({ kind: "model", trashedAt: "2026-10-21T11:00:00.000Z" }),
    ]);
    expect(counts.all).toBe(3);
    expect(counts.favorites).toBe(1);
    expect(counts.shape).toBe(2);
    expect(counts.image).toBe(1);
    expect(counts.model).toBe(0);
    expect(counts.recording).toBe(0);
  });

  it("titles every scope and has an empty state for each", () => {
    expect(scopeTitle("all")).toBe("Library");
    expect(scopeTitle("favorites")).toBe("Favorites");
    expect(scopeTitle("recording")).toBe("Recordings");
    for (const scope of LIBRARY_SCOPES) {
      const copy = emptyStateCopy(scope);
      expect(copy.title.length).toBeGreaterThan(3);
      expect(copy.description.endsWith(".")).toBe(true);
      // never claim more than the item is
      expect(copy.description).not.toMatch(/validated|measured|learned|realistic|approved/i);
    }
    expect(searchEmptyCopy("  liver capsule ").title).toBe("No Results for “liver capsule”");
  });
});

describe("search", () => {
  it("folds case and accents and needs every term", () => {
    expect(foldText("Rénal CAPSULE")).toBe("renal capsule");
    expect(searchTerms("  Liver   wet ")).toEqual(["liver", "wet"]);
    const liver = item({ title: "Liver capsule", tags: ["Wet", "4K"], description: "From the atlas" });
    expect(matchesSearch(liver, searchTerms("liver"))).toBe(true);
    expect(matchesSearch(liver, searchTerms("liver wet"))).toBe(true);
    expect(matchesSearch(liver, searchTerms("atlas"))).toBe(true);
    expect(matchesSearch(liver, searchTerms("liver kidney"))).toBe(false);
    expect(matchesSearch(liver, searchTerms("shapes"))).toBe(true);
    expect(matchesSearch(item({ title: "Rénal cortex" }), searchTerms("renal"))).toBe(true);
    expect(matchesSearch(liver, [])).toBe(true);
  });
});

describe("sorting", () => {
  it("sorts newest first with a stable tie-break", () => {
    const older = item({ createdAt: "2026-10-20T10:00:00.000Z" });
    const newer = item({ createdAt: "2026-10-21T10:00:00.000Z" });
    const twinA = item({ id: "00000000-0000-4000-8000-00000000000a", createdAt: "2026-10-19T10:00:00.000Z" });
    const twinB = item({ id: "00000000-0000-4000-8000-00000000000b", createdAt: "2026-10-19T10:00:00.000Z" });
    const sorted = visibleItems([twinB, older, newer, twinA], { scope: "all", search: "", sort: "newest" });
    expect(sorted.map((entry) => entry.id)).toEqual([newer.id, older.id, twinA.id, twinB.id]);
  });

  it("sorts names naturally and sizes largest first", () => {
    const ten = item({ title: "Variant 10", byteSize: 10 });
    const two = item({ title: "variant 2", byteSize: 30 });
    const alpha = item({ title: "Alpha", byteSize: 20 });
    expect(visibleItems([ten, two, alpha], { scope: "all", search: "", sort: "name" }).map((entry) => entry.title)).toEqual([
      "Alpha",
      "variant 2",
      "Variant 10",
    ]);
    expect(visibleItems([ten, two, alpha], { scope: "all", search: "", sort: "size" }).map((entry) => entry.byteSize)).toEqual([30, 20, 10]);
    expect(compareItems(ten, ten, "size")).toBe(0);
  });

  it("parses stored sort values defensively", () => {
    expect(parseSort("name")).toBe("name");
    expect(parseSort("size")).toBe("size");
    expect(parseSort("bogus")).toBe("newest");
    expect(parseSort(null)).toBe("newest");
  });

  it("combines scope, search and trash", () => {
    const items = [
      item({ kind: "image", title: "Kidney still" }),
      item({ kind: "image", title: "Liver still", favorite: true }),
      item({ kind: "shape", title: "Liver mesh", favorite: true }),
      item({ kind: "image", title: "Liver old", trashedAt: "2026-10-21T12:00:00.000Z" }),
    ];
    expect(visibleItems(items, { scope: "image", search: "liver", sort: "name" }).map((entry) => entry.title)).toEqual(["Liver still"]);
    expect(visibleItems(items, { scope: "favorites", search: "", sort: "name" }).map((entry) => entry.title)).toEqual(["Liver mesh", "Liver still"]);
    expect(items[0]?.title).toBe("Kidney still");
  });

  it("adds sizes and ignores nonsense", () => {
    expect(totalBytes([item({ byteSize: 100 }), item({ byteSize: 50 }), item({ byteSize: Number.NaN }), item({ byteSize: -4 })])).toBe(150);
  });
});
