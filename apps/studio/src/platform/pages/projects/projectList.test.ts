import { describe, expect, it } from "vitest";
import type { Project } from "../../core/types";
import {
  cleanProjectTitle,
  copyTitle,
  defaultProjectTitle,
  editedAt,
  filterProjects,
  normalizeForSearch,
  projectSubtitle,
  relativeTime,
  sortProjects,
} from "./projectList";

function project(id: string, patch: Partial<Project> = {}): Project {
  return {
    id,
    labId: "organ",
    title: id,
    description: "",
    headVersionId: `${id}-v1`,
    headSeq: 1,
    draftAssetId: null,
    draftStateSha256: null,
    draftThumbnailAssetId: null,
    draftRev: 0,
    draftSavedAt: null,
    thumbnailAssetId: null,
    favorite: false,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    openedAt: null,
    trashedAt: null,
    ...patch,
  };
}

const NOW = new Date(2026, 9, 22, 15, 30);

describe("filtering", () => {
  const projects = [
    project("a", { title: "Liver baseline", favorite: true }),
    project("b", { title: "Kidney study", labId: "texture-lab" }),
    project("c", { title: "Rénal crème", description: "liver notes" }),
    project("d", { title: "Old", trashedAt: "2026-10-02T00:00:00.000Z" }),
  ];

  it("filters by lab, favourites and every search word, ignoring case and accents", () => {
    expect(filterProjects(projects, {}).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(filterProjects(projects, { labId: "texture-lab" }).map((item) => item.id)).toEqual(["b"]);
    expect(filterProjects(projects, { favoritesOnly: true }).map((item) => item.id)).toEqual(["a"]);
    expect(filterProjects(projects, { search: "LIVER" }).map((item) => item.id)).toEqual(["a", "c"]);
    expect(filterProjects(projects, { search: "renal creme" }).map((item) => item.id)).toEqual(["c"]);
    expect(filterProjects(projects, { search: "liver kidney" })).toEqual([]);
    expect(normalizeForSearch("  Crème Brûlée ")).toBe("creme brulee");
  });
});

describe("sorting", () => {
  const projects = [
    project("x", { title: "beta", createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z" }),
    project("y", { title: "Alpha 10", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", draftSavedAt: "2026-10-09T00:00:00.000Z" }),
    project("z", { title: "Alpha 9", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z" }),
  ];

  it("sorts by the newest edit, counting unsaved-to-version drafts", () => {
    expect(editedAt(projects[1]!)).toBe("2026-10-09T00:00:00.000Z");
    expect(sortProjects(projects, "recent").map((item) => item.id)).toEqual(["y", "z", "x"]);
  });

  it("sorts names naturally and creation dates newest first", () => {
    expect(sortProjects(projects, "name").map((item) => item.title)).toEqual(["Alpha 9", "Alpha 10", "beta"]);
    expect(sortProjects(projects, "created").map((item) => item.id)).toEqual(["x", "z", "y"]);
  });
});

describe("times and titles", () => {
  it("phrases edit times relative to now", () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(relativeTime(ago(20_000), NOW)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5 min ago");
    expect(relativeTime(ago(2 * 3_600_000), NOW)).toBe("2 hr ago");
    expect(relativeTime(new Date(2026, 9, 21, 22).toISOString(), NOW)).toBe("yesterday");
    expect(relativeTime(new Date(2026, 9, 19, 9).toISOString(), NOW)).toBe("Monday");
    expect(relativeTime(new Date(2026, 9, 2, 9).toISOString(), NOW)).toBe("Oct 2");
    expect(relativeTime(new Date(2025, 0, 2, 9).toISOString(), NOW)).toBe("Jan 2, 2025");
    expect(relativeTime("nope", NOW)).toBe("");
    expect(projectSubtitle({ updatedAt: ago(5 * 60_000), draftSavedAt: null }, "Organ Design", NOW)).toBe("Organ Design · Edited 5 min ago");
  });

  it("names copies uniquely", () => {
    expect(copyTitle("Liver")).toBe("Liver copy");
    expect(copyTitle("Liver", ["liver copy", "Liver copy 2"])).toBe("Liver copy 3");
    expect(copyTitle("   ")).toBe("Untitled copy");
    expect(copyTitle("x".repeat(130)).length).toBe(120);
  });

  it("cleans and suggests project titles", () => {
    expect(cleanProjectTitle("  a   b ")).toBe("a b");
    expect(cleanProjectTitle("   ")).toBeNull();
    expect(cleanProjectTitle("y".repeat(200))?.length).toBe(120);
    expect(defaultProjectTitle("Liver (seed 42)", "Organ Design")).toBe("Liver (seed 42)");
    expect(defaultProjectTitle(null, "Organ Design", ["organ design", "Organ Design 2"])).toBe("Organ Design 3");
    expect(defaultProjectTitle("  ", "Texture Lab")).toBe("Texture Lab");
  });
});
