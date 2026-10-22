import { describe, expect, it } from "vitest";
import { contextMenuSelection, neighbourAfterRemoval, orderedSelection, pruneSelection, sameSelection } from "./selection";

describe("library selection", () => {
  it("keeps only visible ids and returns the same set when nothing changes", () => {
    const selected = new Set(["a", "b"]);
    expect(pruneSelection(selected, ["a", "b", "c"])).toBe(selected);
    expect([...pruneSelection(selected, ["b", "c"])]).toEqual(["b"]);
    const empty = new Set<string>();
    expect(pruneSelection(empty, [])).toBe(empty);
  });

  it("follows Finder's right-click rule", () => {
    const selected = new Set(["a", "b"]);
    expect(contextMenuSelection(selected, "a")).toBe(selected);
    expect([...contextMenuSelection(selected, "c")]).toEqual(["c"]);
  });

  it("orders the selection like the grid", () => {
    expect(orderedSelection(["c", "a", "b"], new Set(["b", "c"]))).toEqual(["c", "b"]);
  });

  it("picks the neighbour after a removal", () => {
    const ids = ["a", "b", "c", "d"];
    expect(neighbourAfterRemoval(ids, new Set(["b"]))).toBe("c");
    expect(neighbourAfterRemoval(ids, new Set(["b", "c"]))).toBe("d");
    expect(neighbourAfterRemoval(ids, new Set(["d"]))).toBe("c");
    expect(neighbourAfterRemoval(ids, new Set(["c", "d"]))).toBe("b");
    expect(neighbourAfterRemoval(ids, new Set(["a", "b", "c", "d"]))).toBeNull();
    expect(neighbourAfterRemoval(ids, new Set(["x"]))).toBeNull();
  });

  it("compares selections by members", () => {
    expect(sameSelection(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(sameSelection(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
    expect(sameSelection(new Set(["a", "c"]), new Set(["a", "b"]))).toBe(false);
  });
});
