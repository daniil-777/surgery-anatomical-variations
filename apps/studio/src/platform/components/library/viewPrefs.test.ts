import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW_PREFS, parseViewPrefs, serializeViewPrefs, tilePixels, TILE_SIZES } from "./viewPrefs";

describe("library view preferences", () => {
  it("round-trips and falls back to defaults", () => {
    expect(parseViewPrefs(serializeViewPrefs({ sort: "size", tile: "xlarge" }))).toEqual({ sort: "size", tile: "xlarge" });
    expect(parseViewPrefs(null)).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs("{not json")).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs("42")).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs(JSON.stringify({ sort: "random", tile: "huge" }))).toEqual(DEFAULT_VIEW_PREFS);
    expect(parseViewPrefs(JSON.stringify({ sort: "name" }))).toEqual({ sort: "name", tile: "medium" });
  });

  it("maps sizes to the spec's tile widths", () => {
    expect(TILE_SIZES.map((size) => size.px)).toEqual([136, 168, 208, 256]);
    expect(tilePixels("large")).toBe(208);
  });
});
