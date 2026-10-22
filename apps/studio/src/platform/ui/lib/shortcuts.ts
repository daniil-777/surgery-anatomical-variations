// Keyboard shortcuts: parsing, matching, display and scoping (APPLE_STYLE_SPEC §4.1).
// Pure on purpose (no DOM globals): the rules are unit-tested in node and shared by useShortcuts, menus and tooltips.

export interface KeyChord {
  /** A single lower-case character ("s", ",", "/", " ") or a lower-case named key ("enter", "arrowdown", "f1"). */
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * "mod+s" is ⌘S on Apple platforms and Ctrl+S elsewhere; modifiers: mod, meta/cmd, ctrl, alt/option, shift.
 * Use { mac, other } when the platforms differ beyond ⌘ ↔ Ctrl (⌃⌘S vs Ctrl+Alt+S).
 */
export type ShortcutSpec = string | { mac: string; other: string };

/** The KeyboardEvent fields the matcher reads (a structural subset, so tests can pass plain objects). */
export interface KeyEventLike {
  key: string;
  code?: string | undefined;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean | undefined;
  isComposing?: boolean | undefined;
  keyCode?: number | undefined;
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  return: "enter",
  del: "delete",
  space: " ",
  spacebar: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  plus: "+",
  comma: ",",
  period: ".",
  slash: "/",
  apps: "contextmenu",
};

const MODIFIERS: Readonly<Record<string, "mod" | "meta" | "ctrl" | "alt" | "shift">> = {
  mod: "mod",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

export function isMacPlatform(platform: string): boolean {
  // iPadOS reports "MacIntel"; both get ⌘ and the Apple glyphs
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** Normalises KeyboardEvent.key (or a key token) to the form KeyChord.key uses. */
export function normalizeKey(key: string): string {
  if (key.length === 1) return key.toLowerCase();
  const lower = key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

export function resolveShortcut(spec: ShortcutSpec, mac: boolean): string {
  return typeof spec === "string" ? spec : mac ? spec.mac : spec.other;
}

export function parseChord(text: string, mac: boolean): KeyChord {
  const chord: KeyChord = { key: "", meta: false, ctrl: false, alt: false, shift: false };
  // "mod++" binds the plus key: an empty token after a "+" separator is the key itself
  const tokens = text.trim().split("+");
  const parts: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = (tokens[index] ?? "").trim();
    if (token === "" && index === tokens.length - 1 && index > 0) parts.push("+");
    else if (token !== "") parts.push(token);
  }
  if (parts.length === 0) throw new Error(`Empty shortcut "${text}"`);
  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1;
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier && !isLast) {
      if (modifier === "mod") chord[mac ? "meta" : "ctrl"] = true;
      else chord[modifier] = true;
      continue;
    }
    if (!isLast) throw new Error(`Unknown modifier "${part}" in shortcut "${text}"`);
    chord.key = normalizeKey(part);
  }
  if (chord.key === "") throw new Error(`Shortcut "${text}" has no key`);
  return chord;
}

export function parseShortcut(spec: ShortcutSpec, mac: boolean): KeyChord {
  return parseChord(resolveShortcut(spec, mac), mac);
}

const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

/** The physical key (KeyboardEvent.code) that types `key` on a US layout; null for named keys. */
export function codeForKey(key: string): string | null {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return PUNCTUATION_CODES[key] ?? null;
}

function isPrintableSymbol(key: string): boolean {
  return key.length === 1 && key !== " " && !/^[a-z0-9]$/.test(key);
}

export function matchesChord(event: KeyEventLike, chord: KeyChord): boolean {
  // IME composition: the keystroke belongs to the input method, not to us
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.metaKey !== chord.meta || event.ctrlKey !== chord.ctrl || event.altKey !== chord.alt) return false;
  // "?" is Shift+/ on most layouts: a symbol bound without shift matches whatever shift it needed
  if (chord.shift ? !event.shiftKey : event.shiftKey && !isPrintableSymbol(chord.key)) return false;
  const code = codeForKey(chord.key);
  // ⌥ rewrites event.key on macOS (⌥S types "ß"), so with Alt held the physical key decides
  if (chord.alt && code !== null && event.code) return event.code === code;
  const key = normalizeKey(event.key);
  if (key === chord.key) return true;
  // non-Latin layouts (⌘ with a Cyrillic "ы") still mean the Latin letter on the same physical key
  return code !== null && /^[a-z]$/.test(chord.key) && !/^[\x20-\x7e]$/.test(key) && event.code === code;
}

const MAC_KEY_GLYPHS: Readonly<Record<string, string>> = {
  enter: "↩",
  escape: "⎋",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  home: "↖",
  end: "↘",
  pageup: "⇞",
  pagedown: "⇟",
};

const OTHER_KEY_NAMES: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  " ": "Space",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  pagedown: "Page Down",
  contextmenu: "Menu",
};

function keyLabel(key: string, mac: boolean): string {
  const named = mac ? MAC_KEY_GLYPHS[key] : OTHER_KEY_NAMES[key];
  if (named) return named;
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** "⌃⌥⇧⌘K" on Apple platforms (HIG order), "Ctrl+Alt+Shift+K" elsewhere. */
export function formatChord(chord: KeyChord, mac: boolean): string {
  const key = keyLabel(chord.key, mac);
  if (mac) {
    return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.meta ? "⌘" : ""}${key}`;
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  if (chord.meta) parts.push("Win");
  parts.push(key);
  return parts.join("+");
}

export function formatShortcut(spec: ShortcutSpec, mac: boolean): string {
  return formatChord(parseShortcut(spec, mac), mac);
}

const SPOKEN_KEYS: Readonly<Record<string, string>> = {
  " ": "Space",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  arrowup: "Up Arrow",
  arrowdown: "Down Arrow",
  arrowleft: "Left Arrow",
  arrowright: "Right Arrow",
  escape: "Escape",
  enter: "Return",
};

/** Words for screen readers ("Option Command Y"): the glyphs alone read poorly. */
export function describeChord(chord: KeyChord, mac: boolean): string {
  const words: string[] = [];
  if (chord.ctrl) words.push(mac ? "Control" : "Ctrl");
  if (chord.alt) words.push(mac ? "Option" : "Alt");
  if (chord.shift) words.push("Shift");
  if (chord.meta) words.push(mac ? "Command" : "Windows");
  words.push(SPOKEN_KEYS[chord.key] ?? keyLabel(chord.key, false));
  return words.join(" ");
}

const ARIA_KEYS: Readonly<Record<string, string>> = {
  " ": "Space",
  enter: "Enter",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** The aria-keyshortcuts form ("Alt+Meta+Y"). */
export function ariaKeyShortcut(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Control");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  if (chord.meta) parts.push("Meta");
  parts.push(ARIA_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key));
  return parts.join("+");
}

function sameChord(a: KeyChord, b: KeyChord): boolean {
  return a.key === b.key && a.meta === b.meta && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;
}

const RESERVED: ReadonlyArray<{ mac: boolean; spec: string; reason: string }> = [
  ...["n", "t", "w", "q"].flatMap((key) => [
    { mac: true, spec: `meta+${key}`, reason: "the browser keeps ⌘N, ⌘T, ⌘W and ⌘Q" },
    { mac: true, spec: `shift+meta+${key}`, reason: "the browser keeps ⇧⌘N, ⇧⌘T and ⇧⌘W" },
  ]),
  ...["n", "t", "w"].flatMap((key) => [
    { mac: false, spec: `ctrl+${key}`, reason: "the browser keeps Ctrl+N, Ctrl+T and Ctrl+W" },
    { mac: false, spec: `ctrl+shift+${key}`, reason: "the browser keeps Ctrl+Shift+N, T and W" },
  ]),
  { mac: true, spec: "meta+tab", reason: "⌘Tab switches applications" },
  { mac: false, spec: "ctrl+tab", reason: "Ctrl+Tab switches tabs" },
  ...["+", "-", "=", "0"].flatMap((key) => [
    { mac: true, spec: `meta+${key}`, reason: "page zoom is an accessibility feature" },
    { mac: false, spec: `ctrl+${key}`, reason: "page zoom is an accessibility feature" },
  ]),
  { mac: true, spec: "shift+meta+a", reason: "Chrome tab search" },
  { mac: true, spec: "alt+meta+i", reason: "opens DevTools in Chrome" },
  { mac: false, spec: "ctrl+shift+i", reason: "opens DevTools" },
  ...["8", "=", "-"].map((key) => ({ mac: true, spec: `alt+meta+${key}`, reason: "macOS accessibility zoom" })),
];

/** Why a chord must never be bound (§4.1 "Never bind"), or null when it is free to use. */
export function reservedChordReason(chord: KeyChord, mac: boolean): string | null {
  for (const entry of RESERVED) {
    if (entry.mac === mac && sameChord(parseChord(entry.spec, mac), chord)) return entry.reason;
  }
  return null;
}

// Scopes --------------------------------------------------------------------------------------------------------------

/** "global" fires everywhere, text fields included (⌘S, ⌘K, ⌘,); "app" stays out of fields, lab viewports and modals. */
export type ShortcutScope = "global" | "app";

export interface ShortcutBinding {
  keys: ShortcutSpec;
  scope?: ShortcutScope | undefined;
  /** App shortcuts normally ignore keys typed into text fields. */
  allowInEditable?: boolean | undefined;
  /** App shortcuts normally pause while a modal sheet or alert is open. */
  allowInModal?: boolean | undefined;
  /** Held keys repeat; toggles must not flicker, so repeats are ignored unless allowed. */
  allowRepeat?: boolean | undefined;
  enabled?: boolean | undefined;
}

export interface ShortcutContext {
  mac: boolean;
  /** The event target is a text-entry control. */
  editable: boolean;
  /** The event target is inside a lab viewport (labs own their single-key shortcuts). */
  inLab: boolean;
  /** A modal dialog is open. */
  modalOpen: boolean;
}

export function shortcutApplies(binding: ShortcutBinding, event: KeyEventLike, context: ShortcutContext): boolean {
  if (binding.enabled === false) return false;
  if (event.repeat && !binding.allowRepeat) return false;
  if (!matchesChord(event, parseShortcut(binding.keys, context.mac))) return false;
  if ((binding.scope ?? "app") === "global") return true;
  if (context.inLab) return false;
  if (context.editable && !binding.allowInEditable) return false;
  if (context.modalOpen && !binding.allowInModal) return false;
  return true;
}

/** The first binding the event triggers, or -1. */
export function findShortcut(bindings: readonly ShortcutBinding[], event: KeyEventLike, context: ShortcutContext): number {
  return bindings.findIndex((binding) => shortcutApplies(binding, event, context));
}

/** The element fields isEditableTarget reads. */
export interface EditableLike {
  tagName?: string | undefined;
  type?: string | undefined;
  isContentEditable?: boolean | undefined;
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** True for controls that take typed text: shortcuts without modifiers must not steal those keystrokes. */
export function isEditableTarget(target: EditableLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
  return false;
}
