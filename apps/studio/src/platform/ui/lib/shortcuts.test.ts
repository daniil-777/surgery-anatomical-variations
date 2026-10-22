import { describe, expect, it } from "vitest";
import {
  ariaKeyShortcut,
  codeForKey,
  describeChord,
  findShortcut,
  formatChord,
  formatShortcut,
  isEditableTarget,
  isMacPlatform,
  matchesChord,
  parseChord,
  parseShortcut,
  reservedChordReason,
  shortcutApplies,
  type KeyEventLike,
  type ShortcutContext,
} from "./shortcuts";

function key(init: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init };
}

const app: ShortcutContext = { mac: true, editable: false, inLab: false, modalOpen: false };

describe("platform detection", () => {
  it("treats Apple platforms (iPadOS reports MacIntel) as mac", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("macOS")).toBe(true);
    expect(isMacPlatform("iPhone")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });
});

describe("parseChord", () => {
  it("maps mod to ⌘ on mac and Ctrl elsewhere", () => {
    expect(parseChord("mod+s", true)).toEqual({ key: "s", meta: true, ctrl: false, alt: false, shift: false });
    expect(parseChord("mod+s", false)).toEqual({ key: "s", meta: false, ctrl: true, alt: false, shift: false });
  });

  it("accepts modifier synonyms, aliases and the plus key", () => {
    expect(parseChord("Option+Cmd+Y", true)).toMatchObject({ key: "y", meta: true, alt: true });
    expect(parseChord("shift+mod+Enter", true)).toMatchObject({ key: "enter", shift: true, meta: true });
    expect(parseChord("esc", true).key).toBe("escape");
    expect(parseChord("space", false).key).toBe(" ");
    expect(parseChord("mod++", true)).toMatchObject({ key: "+", meta: true });
    expect(parseChord(".", true)).toEqual({ key: ".", meta: false, ctrl: false, alt: false, shift: false });
  });

  it("rejects malformed shortcuts", () => {
    expect(() => parseChord("", true)).toThrow();
    expect(() => parseChord("hyper+s", true)).toThrow(/Unknown modifier/);
    expect(() => parseChord("mod+", true)).not.toThrow();
  });

  it("resolves per-platform specs", () => {
    const sidebar = { mac: "ctrl+meta+s", other: "ctrl+alt+s" };
    expect(parseShortcut(sidebar, true)).toMatchObject({ key: "s", ctrl: true, meta: true, alt: false });
    expect(parseShortcut(sidebar, false)).toMatchObject({ key: "s", ctrl: true, alt: true, meta: false });
  });
});

describe("matchesChord", () => {
  it("requires exact modifiers", () => {
    const save = parseChord("mod+s", true);
    expect(matchesChord(key({ key: "s", metaKey: true }), save)).toBe(true);
    expect(matchesChord(key({ key: "s" }), save)).toBe(false);
    expect(matchesChord(key({ key: "s", metaKey: true, shiftKey: true }), save)).toBe(false);
    expect(matchesChord(key({ key: "S", metaKey: true, shiftKey: true }), parseChord("shift+mod+s", true))).toBe(true);
  });

  it("matches the physical key while Alt is held (⌥Y types ¥ on macOS)", () => {
    const history = parseChord("alt+mod+y", true);
    expect(matchesChord(key({ key: "¥", code: "KeyY", altKey: true, metaKey: true }), history)).toBe(true);
    expect(matchesChord(key({ key: "y", code: "KeyZ", altKey: true, metaKey: true }), history)).toBe(false);
  });

  it("ignores IME composition", () => {
    const chord = parseChord("mod+k", true);
    expect(matchesChord(key({ key: "k", metaKey: true, isComposing: true }), chord)).toBe(false);
    expect(matchesChord(key({ key: "Process", metaKey: true, keyCode: 229 }), chord)).toBe(false);
  });

  it("lets symbols that need Shift match without declaring it", () => {
    expect(matchesChord(key({ key: "?", shiftKey: true }), parseChord("?", true))).toBe(true);
    expect(matchesChord(key({ key: ".", shiftKey: true }), parseChord(".", true))).toBe(true);
    expect(matchesChord(key({ key: "A", shiftKey: true }), parseChord("a", true))).toBe(false);
  });

  it("falls back to the physical key on non-Latin layouts", () => {
    expect(matchesChord(key({ key: "ы", code: "KeyS", metaKey: true }), parseChord("mod+s", true))).toBe(true);
    expect(matchesChord(key({ key: "ы", code: "KeyA", metaKey: true }), parseChord("mod+s", true))).toBe(false);
  });

  it("knows the US physical keys", () => {
    expect(codeForKey("s")).toBe("KeyS");
    expect(codeForKey("7")).toBe("Digit7");
    expect(codeForKey(",")).toBe("Comma");
    expect(codeForKey("enter")).toBeNull();
  });
});

describe("display", () => {
  it("formats Apple glyphs in ⌃⌥⇧⌘ order", () => {
    expect(formatShortcut("shift+alt+ctrl+mod+k", true)).toBe("⌃⌥⇧⌘K");
    expect(formatShortcut("alt+mod+y", true)).toBe("⌥⌘Y");
    expect(formatShortcut("mod+enter", true)).toBe("⌘↩");
    expect(formatShortcut("mod+backspace", true)).toBe("⌘⌫");
    expect(formatShortcut("mod+,", true)).toBe("⌘,");
  });

  it("formats Ctrl+Alt+Shift+K elsewhere", () => {
    expect(formatShortcut("shift+alt+mod+k", false)).toBe("Ctrl+Alt+Shift+K");
    expect(formatShortcut({ mac: "ctrl+meta+s", other: "ctrl+alt+s" }, false)).toBe("Ctrl+Alt+S");
    expect(formatShortcut("escape", false)).toBe("Esc");
    expect(formatChord(parseChord("mod+arrowdown", false), false)).toBe("Ctrl+Down");
  });

  it("spells shortcuts for screen readers and aria-keyshortcuts", () => {
    expect(describeChord(parseChord("alt+mod+y", true), true)).toBe("Option Command Y");
    expect(describeChord(parseChord("mod+,", false), false)).toBe("Ctrl Comma");
    expect(ariaKeyShortcut(parseChord("alt+mod+y", true))).toBe("Alt+Meta+Y");
    expect(ariaKeyShortcut(parseChord("mod+enter", false))).toBe("Control+Enter");
  });
});

describe("reserved chords", () => {
  it("refuses browser and accessibility shortcuts", () => {
    expect(reservedChordReason(parseChord("mod+n", true), true)).toMatch(/browser/);
    expect(reservedChordReason(parseChord("mod+w", false), false)).toMatch(/browser/);
    expect(reservedChordReason(parseChord("mod+=", true), true)).toMatch(/zoom/);
    expect(reservedChordReason(parseChord("alt+mod+i", true), true)).toMatch(/DevTools/);
  });

  it("allows the spec's own bindings", () => {
    for (const spec of ["mod+s", "shift+mod+s", "alt+mod+y", "alt+mod+n", "mod+k", "mod+,", "mod+/", "mod+f"]) {
      expect(reservedChordReason(parseChord(spec, true), true)).toBeNull();
      expect(reservedChordReason(parseChord(spec, false), false)).toBeNull();
    }
  });
});

describe("scopes", () => {
  const save = { keys: "mod+s", scope: "global" as const };
  const find = { keys: "mod+f" };
  const favorite = { keys: "." };

  it("fires global shortcuts inside text fields", () => {
    expect(shortcutApplies(save, key({ key: "s", metaKey: true }), { ...app, editable: true })).toBe(true);
  });

  it("keeps app shortcuts out of fields, labs and modals unless allowed", () => {
    const event = key({ key: "f", metaKey: true });
    expect(shortcutApplies(find, event, app)).toBe(true);
    expect(shortcutApplies(find, event, { ...app, editable: true })).toBe(false);
    expect(shortcutApplies({ ...find, allowInEditable: true }, event, { ...app, editable: true })).toBe(true);
    expect(shortcutApplies(find, event, { ...app, inLab: true })).toBe(false);
    expect(shortcutApplies(find, event, { ...app, modalOpen: true })).toBe(false);
    expect(shortcutApplies({ ...find, allowInModal: true }, event, { ...app, modalOpen: true })).toBe(true);
  });

  it("ignores key repeat and disabled bindings", () => {
    expect(shortcutApplies(favorite, key({ key: ".", repeat: true }), app)).toBe(false);
    expect(shortcutApplies({ ...favorite, allowRepeat: true }, key({ key: ".", repeat: true }), app)).toBe(true);
    expect(shortcutApplies({ ...favorite, enabled: false }, key({ key: "." }), app)).toBe(false);
  });

  it("finds the first matching binding", () => {
    const bindings = [find, save, favorite];
    expect(findShortcut(bindings, key({ key: "s", metaKey: true }), app)).toBe(1);
    expect(findShortcut(bindings, key({ key: "x" }), app)).toBe(-1);
  });
});

describe("isEditableTarget", () => {
  it("recognises text-entry controls only", () => {
    expect(isEditableTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isEditableTarget({ tagName: "input", type: "search" })).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isEditableTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
