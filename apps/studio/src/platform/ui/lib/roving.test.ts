import { describe, expect, it } from "vitest";
import {
  countGridColumns,
  firstEnabled,
  gridTargetIndex,
  lastEnabled,
  rangeSelection,
  rovingTargetIndex,
  selectWithGesture,
  stepIndex,
  toggleInSelection,
  typeaheadIndex,
} from "./roving";

const disabled = (...indexes: number[]) => (index: number) => indexes.includes(index);

describe("stepIndex", () => {
  it("skips disabled items and wraps", () => {
    expect(stepIndex(5, 0, 1, disabled(1, 2))).toBe(3);
    expect(stepIndex(5, 4, 1)).toBe(0);
    expect(stepIndex(5, 0, -1)).toBe(4);
    expect(stepIndex(5, 0, -1, undefined, false)).toBe(-1);
  });

  it("returns -1 when nothing is enabled", () => {
    expect(stepIndex(3, 0, 1, () => true)).toBe(-1);
    expect(stepIndex(0, 0, 1)).toBe(-1);
    expect(firstEnabled(3, disabled(0))).toBe(1);
    expect(lastEnabled(3, disabled(2))).toBe(1);
  });
});

describe("rovingTargetIndex", () => {
  it("moves along the orientation only", () => {
    expect(rovingTargetIndex("ArrowRight", 0, 3, { orientation: "horizontal" })).toBe(1);
    expect(rovingTargetIndex("ArrowDown", 0, 3, { orientation: "horizontal" })).toBeNull();
    expect(rovingTargetIndex("ArrowDown", 0, 3, { orientation: "vertical" })).toBe(1);
    expect(rovingTargetIndex("ArrowLeft", 0, 3, { orientation: "vertical" })).toBeNull();
    expect(rovingTargetIndex("Enter", 0, 3)).toBeNull();
  });

  it("wraps by default, stays at the edge without looping", () => {
    expect(rovingTargetIndex("ArrowRight", 2, 3)).toBe(0);
    expect(rovingTargetIndex("ArrowRight", 2, 3, { loop: false })).toBe(2);
    expect(rovingTargetIndex("ArrowLeft", 0, 3, { loop: false })).toBe(0);
  });

  it("jumps with Home/End over disabled ends", () => {
    expect(rovingTargetIndex("Home", 2, 4, { isDisabled: disabled(0) })).toBe(1);
    expect(rovingTargetIndex("End", 0, 4, { isDisabled: disabled(3) })).toBe(2);
  });

  it("mirrors arrows right-to-left", () => {
    expect(rovingTargetIndex("ArrowLeft", 0, 3, { orientation: "horizontal", rtl: true })).toBe(1);
  });

  it("enters from nothing focused", () => {
    expect(rovingTargetIndex("ArrowDown", -1, 3)).toBe(0);
    expect(rovingTargetIndex("ArrowUp", -1, 3)).toBe(2);
  });
});

describe("grids", () => {
  it("counts computed grid tracks", () => {
    expect(countGridColumns("168px 168px 168px")).toBe(3);
    expect(countGridColumns("172.5px 172.5px")).toBe(2);
    expect(countGridColumns("[a] 100px [b] 100px")).toBe(2);
    expect(countGridColumns("none")).toBe(1);
    expect(countGridColumns("")).toBe(1);
  });

  it("moves in two dimensions", () => {
    // 10 items, 4 columns: rows [0..3] [4..7] [8, 9]
    expect(gridTargetIndex("ArrowRight", 3, 10, 4)).toBe(4);
    expect(gridTargetIndex("ArrowLeft", 0, 10, 4)).toBe(0);
    expect(gridTargetIndex("ArrowDown", 1, 10, 4)).toBe(5);
    expect(gridTargetIndex("ArrowDown", 6, 10, 4)).toBe(9);
    expect(gridTargetIndex("ArrowDown", 9, 10, 4)).toBe(9);
    expect(gridTargetIndex("ArrowUp", 9, 10, 4)).toBe(5);
    expect(gridTargetIndex("ArrowUp", 2, 10, 4)).toBe(2);
    expect(gridTargetIndex("Home", 7, 10, 4)).toBe(0);
    expect(gridTargetIndex("End", 0, 10, 4)).toBe(9);
    expect(gridTargetIndex("a", 0, 10, 4)).toBeNull();
    expect(gridTargetIndex("ArrowDown", -1, 10, 4)).toBe(0);
    expect(gridTargetIndex("ArrowRight", 0, 0, 4)).toBeNull();
  });
});

describe("typeahead", () => {
  const labels = ["Open", "Open in Tissue Lab", "Quick Look", "Rename", "Remove", "Move to Trash"];

  it("finds the next item with the prefix", () => {
    expect(typeaheadIndex(labels, "r", 0)).toBe(3);
    expect(typeaheadIndex(labels, "re", 3)).toBe(3);
    expect(typeaheadIndex(labels, "rem", 3)).toBe(4);
    expect(typeaheadIndex(labels, "zzz", 0)).toBe(-1);
  });

  it("cycles on a repeated letter and skips disabled items", () => {
    expect(typeaheadIndex(labels, "o", 0)).toBe(1);
    expect(typeaheadIndex(labels, "oo", 1)).toBe(0);
    expect(typeaheadIndex(labels, "r", 2, disabled(3))).toBe(4);
  });

  it("is case-insensitive", () => {
    expect(typeaheadIndex(labels, "QUICK", -1)).toBe(2);
  });
});

describe("selection", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("toggles and ranges", () => {
    expect([...toggleInSelection(new Set(["a"]), "b")]).toEqual(["a", "b"]);
    expect([...toggleInSelection(new Set(["a", "b"]), "a")]).toEqual(["b"]);
    expect([...rangeSelection(ids, "d", "b")]).toEqual(["b", "c", "d"]);
    expect([...rangeSelection(ids, "zz", "b")]).toEqual(["b"]);
    expect(rangeSelection(ids, "a", "zz").size).toBe(0);
  });

  it("follows Finder gestures", () => {
    const none = new Set<string>();
    const plain = { toggle: false, extend: false };
    expect([...selectWithGesture(ids, none, null, "c", plain, true).selected]).toEqual(["c"]);
    const toggled = selectWithGesture(ids, new Set(["a"]), "a", "c", { toggle: true, extend: false }, true);
    expect([...toggled.selected]).toEqual(["a", "c"]);
    expect(toggled.anchorId).toBe("c");
    const extended = selectWithGesture(ids, new Set(["b"]), "b", "d", { toggle: false, extend: true }, true);
    expect([...extended.selected]).toEqual(["b", "c", "d"]);
    expect(extended.anchorId).toBe("b");
    const added = selectWithGesture(ids, new Set(["e"]), "a", "b", { toggle: true, extend: true }, true);
    expect([...added.selected].sort()).toEqual(["a", "b", "e"]);
    expect([...selectWithGesture(ids, new Set(["a"]), "a", "c", { toggle: true, extend: false }, false).selected]).toEqual(["c"]);
  });
});
