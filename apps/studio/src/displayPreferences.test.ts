import { describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY, parseDisplayPreferences, readDisplayPreferences } from "./displayPreferences";
import { scaleFontValue } from "../interfaceTypography";

describe("saved display preferences", () => {
  it("recovers from missing, malformed and unavailable storage", () => {
    expect(readDisplayPreferences()).toEqual(DEFAULT_DISPLAY);
    expect(readDisplayPreferences({ getItem: () => "{broken" })).toEqual(DEFAULT_DISPLAY);
    expect(readDisplayPreferences({ getItem: () => { throw new Error("Storage denied"); } })).toEqual(DEFAULT_DISPLAY);
  });
  it("rejects nonnumeric values and contains out-of-range persisted sizes", () => {
    expect(parseDisplayPreferences({ textPercent: "200", controlsWidth: Infinity, sceneHeight: -100 })).toEqual({ ...DEFAULT_DISPLAY, sceneHeight: 320 });
    expect(parseDisplayPreferences({ textPercent: 20000, controlsWidth: -1, sceneHeight: 1e9 })).toEqual({ textPercent: 200, controlsWidth: 240, sceneHeight: 1400 });
  });
  it("keeps automatic height distinct from a chosen height on reload", () => {
    const custom = { textPercent: 150, controlsWidth: 410, sceneHeight: 720 };
    expect(readDisplayPreferences({ getItem: () => JSON.stringify(custom) })).toEqual(custom);
    expect(parseDisplayPreferences({ ...custom, sceneHeight: null }).sceneHeight).toBeNull();
  });
});

describe("interface typography without canvas zoom", () => {
  it("scales fixed and responsive absolute text declarations", () => {
    expect(scaleFontValue("font-size", "10px")).toContain("--ui-text-scale");
    expect(scaleFontValue("font-size", "clamp(20px, 3vw, 42px)")).toContain("(clamp(20px, 3vw, 42px))");
  });
  it("keeps shorthand weight, line height and family intact", () => {
    expect(scaleFontValue("font", '600 12px/1.7 "Inter", sans-serif')).toBe('600 calc(12px * var(--ui-text-scale, 1))/1.7 "Inter", sans-serif');
  });
  it("does not compound inherited/root-relative sizes or modify geometry", () => {
    for (const value of ["inherit", "1em", "1.2rem", "90%", "0"]) expect(scaleFontValue("font-size", value)).toBe(value);
    expect(scaleFontValue("width", "640px")).toBe("640px");
    const once = scaleFontValue("font-size", "12px");
    expect(scaleFontValue("font-size", once)).toBe(once);
  });
});
