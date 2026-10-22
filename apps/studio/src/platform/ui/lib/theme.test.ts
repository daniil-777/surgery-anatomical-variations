import { describe, expect, it } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  detectFont,
  mergeAppearance,
  parseAppearance,
  resolveColorScheme,
  resolveReducedTransparency,
  rootAttributes,
  sameAppearance,
  serializeAppearance,
} from "./theme";

describe("persisted appearance", () => {
  it("uses the documented storage key", () => {
    expect(APPEARANCE_STORAGE_KEY).toBe("viscera.px.appearance.v1");
  });

  it("round-trips through JSON", () => {
    const appearance = { theme: "dark", glass: "tinted", transparency: "reduce" } as const;
    expect(parseAppearance(serializeAppearance(appearance))).toEqual(appearance);
  });

  it("falls back per field on bad input", () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("not json")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("[1,2]")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{"theme":"sepia","glass":"clear"}')).toEqual({ theme: "system", glass: "clear", transparency: "system" });
  });

  it("drops unknown fields when serialising", () => {
    const stored = serializeAppearance({ ...DEFAULT_APPEARANCE, extra: 1 } as unknown as typeof DEFAULT_APPEARANCE);
    expect(JSON.parse(stored)).toEqual({ theme: "system", glass: "regular", transparency: "system" });
  });

  it("merges patches and compares", () => {
    const merged = mergeAppearance(DEFAULT_APPEARANCE, { theme: "light" });
    expect(merged.theme).toBe("light");
    expect(sameAppearance(merged, { theme: "light", glass: "regular", transparency: "system" })).toBe(true);
    expect(sameAppearance(merged, DEFAULT_APPEARANCE)).toBe(false);
    expect(mergeAppearance(DEFAULT_APPEARANCE, null)).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("resolution", () => {
  it("follows the system only for the system theme", () => {
    expect(resolveColorScheme("system", "app", true)).toBe("dark");
    expect(resolveColorScheme("system", "app", false)).toBe("light");
    expect(resolveColorScheme("light", "app", true)).toBe("light");
    expect(resolveColorScheme("dark", "auth", false)).toBe("dark");
  });

  it("forces dark in lab routes whatever the choice", () => {
    expect(resolveColorScheme("light", "lab", false)).toBe("dark");
    expect(resolveColorScheme("system", "lab", false)).toBe("dark");
  });

  it("reduces transparency manually or from the OS", () => {
    expect(resolveReducedTransparency("reduce", false)).toBe(true);
    expect(resolveReducedTransparency("system", true)).toBe(true);
    expect(resolveReducedTransparency("system", false)).toBe(false);
  });

  it("uses SF only on Apple platforms", () => {
    expect(detectFont("MacIntel")).toBe("sf");
    expect(detectFont("iPad")).toBe("sf");
    expect(detectFont("Win32")).toBe("inter");
    expect(detectFont("")).toBe("inter");
  });

  it("builds the <html> data attributes, compact by default in labs", () => {
    expect(rootAttributes({ theme: "dark", glass: "clear", transparency: "system" }, "app", undefined, "sf")).toEqual({
      "data-px-theme": "dark",
      "data-px-glass": "clear",
      "data-px-transparency": "system",
      "data-px-route": "app",
      "data-px-density": "regular",
      "data-px-font": "sf",
    });
    expect(rootAttributes(DEFAULT_APPEARANCE, "lab", undefined, "inter")["data-px-density"]).toBe("compact");
    expect(rootAttributes(DEFAULT_APPEARANCE, "lab", "regular", "inter")["data-px-density"]).toBe("regular");
  });
});
