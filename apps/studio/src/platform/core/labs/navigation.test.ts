import { describe, expect, it } from "vitest";
import {
  classifyShortcut,
  decideLabNavigation,
  decideScriptedNavigation,
  detectShortcutPlatform,
  isRepeatSensitive,
  type AnchorClick,
  type KeyLike,
} from "./navigation";

function key(init: Partial<KeyLike> & { key: string; code: string }): KeyLike {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init };
}

describe("platform shortcuts inside a lab", () => {
  it("maps the Mac shortcuts", () => {
    expect(classifyShortcut(key({ key: "s", code: "KeyS", metaKey: true }), "mac")).toBe("save");
    expect(classifyShortcut(key({ key: "S", code: "KeyS", metaKey: true, shiftKey: true }), "mac")).toBe("save-version");
    // ⌥⇧S types "Í" and ⌥Y types "¥" on a US Mac layout: the physical key decides
    expect(classifyShortcut(key({ key: "Í", code: "KeyS", metaKey: true, shiftKey: true, altKey: true }), "mac")).toBe("save-copy");
    expect(classifyShortcut(key({ key: "¥", code: "KeyY", metaKey: true, altKey: true }), "mac")).toBe("version-history");
    expect(classifyShortcut(key({ key: "k", code: "KeyK", metaKey: true }), "mac")).toBe("command-palette");
    expect(classifyShortcut(key({ key: ",", code: "Comma", metaKey: true }), "mac")).toBe("settings");
    expect(classifyShortcut(key({ key: "/", code: "Slash", metaKey: true }), "mac")).toBe("shortcuts");
  });

  it("uses Ctrl elsewhere and never mixes the two", () => {
    expect(classifyShortcut(key({ key: "s", code: "KeyS", ctrlKey: true }), "other")).toBe("save");
    expect(classifyShortcut(key({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true }), "other")).toBe("save-version");
    expect(classifyShortcut(key({ key: "s", code: "KeyS", ctrlKey: true }), "mac")).toBeNull();
    expect(classifyShortcut(key({ key: "s", code: "KeyS", metaKey: true }), "other")).toBeNull();
    // ⌃⌘S is the sidebar toggle (app scope), not a save
    expect(classifyShortcut(key({ key: "s", code: "KeyS", metaKey: true, ctrlKey: true }), "mac")).toBeNull();
  });

  it("leaves the lab's own keys and IME composition alone", () => {
    expect(classifyShortcut(key({ key: "s", code: "KeyS" }), "mac")).toBeNull();
    expect(classifyShortcut(key({ key: "z", code: "KeyZ", metaKey: true }), "mac")).toBeNull();
    expect(classifyShortcut(key({ key: "ß", code: "KeyS", metaKey: true, altKey: true }), "mac")).toBeNull();
    expect(classifyShortcut(key({ key: "s", code: "KeyS", metaKey: true, isComposing: true }), "mac")).toBeNull();
    expect(classifyShortcut(key({ key: "Process", code: "KeyS", metaKey: true, keyCode: 229 }), "mac")).toBeNull();
  });

  it("matches the physical key on non-Latin layouts", () => {
    expect(classifyShortcut(key({ key: "ы", code: "KeyS", metaKey: true }), "mac")).toBe("save");
    expect(classifyShortcut(key({ key: "Ы", code: "KeyS", ctrlKey: true, shiftKey: true }), "other")).toBe("save-version");
  });

  it("detects the platform and swallows repeated saves", () => {
    expect(detectShortcutPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectShortcutPlatform({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" })).toBe("mac");
    expect(detectShortcutPlatform({ platform: "Win32", userAgent: "Windows NT 10.0" })).toBe("other");
    expect(detectShortcutPlatform(undefined)).toBe("other");
    expect(isRepeatSensitive("save")).toBe(true);
    expect(isRepeatSensitive("command-palette")).toBe(false);
  });
});

describe("links inside a lab", () => {
  const current = "https://example.test/anatomy/?mode=atlas&embed=1&lab=organ";
  const click = (href: string, init: Partial<AnchorClick> = {}): AnchorClick => ({
    href: new URL(href, current).href,
    target: "",
    download: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...init,
  });

  it("intercepts studio links that would replace the lab document", () => {
    expect(decideLabNavigation(click("?mode=textures"), current)).toEqual({
      action: "intercept",
      request: { url: "https://example.test/anatomy/?mode=textures", reason: "lab", labId: "texture-lab" },
    });
    expect(decideLabNavigation(click("?mode=atlas"), current)).toMatchObject({ request: { reason: "same-lab", labId: "organ" } });
    expect(decideLabNavigation(click("?mode=tissues"), current)).toMatchObject({ request: { reason: "lab", labId: "tissue" } });
    expect(decideLabNavigation(click("textures.html"), current)).toMatchObject({ request: { reason: "lab", labId: "texture-lab" } });
    // a bare "./" would boot the platform shell inside its own frame
    expect(decideLabNavigation(click("./"), current)).toMatchObject({ request: { reason: "page", labId: null } });
    expect(decideLabNavigation(click("?mode=legacy"), current)).toMatchObject({ request: { reason: "page", labId: null } });
    // the same URL without a fragment reloads the frame
    expect(decideLabNavigation(click(current), current)).toMatchObject({ request: { reason: "same-lab" } });
  });

  it("intercepts other origins and links aimed at the platform window", () => {
    expect(decideLabNavigation(click("https://doi.org/10.5281/zenodo.17598453"), current)).toMatchObject({
      request: { reason: "external", labId: null },
    });
    expect(decideLabNavigation(click("?mode=scene", { target: "_top" }), current)).toMatchObject({
      request: { reason: "top", labId: "scene" },
    });
    expect(decideLabNavigation(click("?mode=scene", { target: "_PARENT" }), current)).toMatchObject({ request: { reason: "top" } });
  });

  it("allows in-page links, new tabs, downloads and handled clicks", () => {
    expect(decideLabNavigation(click("#atlas-disease-panel"), current)).toEqual({ action: "allow" });
    expect(decideLabNavigation({ ...click(current), href: `${current}#` }, current)).toEqual({ action: "allow" });
    expect(decideLabNavigation(click("https://doi.org/x", { target: "_blank" }), current)).toEqual({ action: "allow" });
    expect(decideLabNavigation(click("?mode=textures", { target: "help" }), current)).toEqual({ action: "allow" });
    expect(decideLabNavigation(click("?mode=textures", { metaKey: true }), current)).toEqual({ action: "allow" });
    expect(decideLabNavigation(click("?mode=textures", { shiftKey: true }), current)).toEqual({ action: "allow" });
    expect(decideLabNavigation(click("?mode=textures", { button: 1 }), current)).toEqual({ action: "allow" });
    expect(decideLabNavigation(click("export.glb", { download: true }), current)).toEqual({ action: "allow" });
    expect(decideLabNavigation(click("?mode=textures", { defaultPrevented: true }), current)).toEqual({ action: "allow" });
    expect(decideLabNavigation({ ...click(current), href: "mailto:someone@example.test" }, current)).toEqual({ action: "allow" });
    expect(decideLabNavigation({ ...click(current), href: "javascript:void(0)" }, current)).toEqual({ action: "allow" });
    expect(decideLabNavigation(click("?mode=textures"), "not a url")).toEqual({ action: "allow" });
  });

  it("applies the same rules to navigations a lab starts by script", () => {
    expect(decideScriptedNavigation("https://example.test/anatomy/?mode=imports", current)).toMatchObject({
      request: { reason: "page", labId: null },
    });
    expect(decideScriptedNavigation("https://example.test/anatomy/fat.html", current)).toMatchObject({ request: { reason: "lab", labId: "fat" } });
    expect(decideScriptedNavigation(`${current}#top`, current)).toEqual({ action: "allow" });
  });
});
