// Navigation and keyboard decisions for an embedded lab (pure, DOM-free: the iframe host feeds them event fields).
//
// Inside a project a lab must never navigate its own frame: studio links ("?mode=…", "textures.html") are full page
// loads that would drop the lab's unsaved state, and a bare "./" would boot the platform shell inside itself. The host
// intercepts such clicks and hands the target to the shell, which flushes the project and decides what to open.
// Platform shortcuts (⌘S, ⇧⌘S, …) are forwarded from the lab so they work while the lab has focus; single-key and
// unmodified shortcuts stay the lab's (APPLE_STYLE_SPEC §4.1).

import { labIdFromUrl } from "./registry";

export type ShortcutPlatform = "mac" | "other";

/** Global and editor shortcuts the shell owns even while focus is inside a lab. */
export type ShortcutAction =
  | "save" // ⌘S / Ctrl+S — save now
  | "save-version" // ⇧⌘S / Ctrl+Shift+S — Save Version…
  | "save-copy" // ⌥⇧⌘S / Ctrl+Alt+Shift+S — Save a Copy…
  | "version-history" // ⌥⌘Y / Ctrl+Alt+Y
  | "command-palette" // ⌘K / Ctrl+K
  | "settings" // ⌘, / Ctrl+,
  | "shortcuts"; // ⌘/ / Ctrl+/

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean | undefined;
  isComposing?: boolean | undefined;
  keyCode?: number | undefined;
}

const CODE_KEYS: Readonly<Record<string, string>> = { Comma: ",", Slash: "/", Period: "." };

function physicalKey(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_KEYS[code] ?? "";
}

/** Mac when the browser says so; everything else uses Ctrl. */
export function detectShortcutPlatform(nav: { platform?: string; userAgent?: string } | undefined): ShortcutPlatform {
  const hint = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(hint) ? "mac" : "other";
}

export function classifyShortcut(event: KeyLike, platform: ShortcutPlatform): ShortcutAction | null {
  // IME composition (keyCode 229) owns the keyboard until it ends
  if (event.isComposing || event.keyCode === 229) return null;
  const primary = platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return null;
  // With ⌥ held event.key is a composed character (⌥S is "ß"), and non-Latin layouts report their own letters,
  // so those cases match the physical key instead.
  const printableAscii = /^[\x21-\x7e]$/.test(event.key);
  const key = event.altKey || !printableAscii ? physicalKey(event.code) : event.key.toLowerCase();
  const { altKey: alt, shiftKey: shift } = event;
  switch (key) {
    case "s":
      if (alt) return shift ? "save-copy" : null;
      return shift ? "save-version" : "save";
    case "y":
      return alt && !shift ? "version-history" : null;
    case "k":
      return !alt && !shift ? "command-palette" : null;
    case ",":
      return !alt && !shift ? "settings" : null;
    case "/":
      return !alt && !shift ? "shortcuts" : null;
    default:
      return null;
  }
}

/** Saves fire once per key press: auto-repeat of a held ⌘S is swallowed (still prevented). */
export function isRepeatSensitive(action: ShortcutAction): boolean {
  return action === "save" || action === "save-version" || action === "save-copy";
}

// Links -------------------------------------------------------------------------------------------------------------

/**
 * Why a click would leave the lab:
 * - "lab": another registered lab (labId says which);
 * - "same-lab": the same lab again — a reload that would drop the lab's state and the embed parameters;
 * - "page": another page of the site (the platform shell, the legacy studio, imports…);
 * - "external": another origin or a non-web URL inside the frame;
 * - "top": target=_top/_parent, which would navigate the platform window itself.
 */
export type LabNavigationReason = "lab" | "same-lab" | "page" | "external" | "top";

export interface LabNavigationRequest {
  /** Absolute target URL. */
  url: string;
  reason: LabNavigationReason;
  /** Registry id of the target lab ("lab" and "same-lab"), else null. */
  labId: string | null;
}

export interface AnchorClick {
  /** The resolved absolute href (anchor.href). */
  href: string;
  /** The anchor's target attribute ("" when absent). */
  target: string;
  download: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

export type LabNavigationDecision = { action: "allow" } | { action: "intercept"; request: LabNavigationRequest };

const ALLOW: LabNavigationDecision = { action: "allow" };
// schemes that hand off to another application instead of replacing the frame's document
const HANDOFF_PROTOCOLS = new Set(["javascript:", "mailto:", "tel:", "sms:"]);

/**
 * Decides what a click on an anchor inside a lab frame does. Clicks that open a new tab or window (modifier keys,
 * middle button, target=_blank or a named window), downloads, in-page hash links and links already handled by the lab
 * are allowed; anything that would replace the lab's document (or the platform's) is intercepted.
 */
export function decideLabNavigation(click: AnchorClick, currentUrl: string): LabNavigationDecision {
  if (click.defaultPrevented || click.button !== 0) return ALLOW;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return ALLOW;
  if (click.download) return ALLOW;
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentUrl);
    target = new URL(click.href, current);
  } catch {
    return ALLOW;
  }
  if (HANDOFF_PROTOCOLS.has(target.protocol)) return ALLOW;
  const frameTarget = click.target.trim().toLowerCase();
  const top = frameTarget === "_top" || frameTarget === "_parent";
  if (!top && frameTarget !== "" && frameTarget !== "_self") return ALLOW;
  const url = target.href;
  if (top) return intercept(url, "top", labIdFromUrl(target));
  if (target.origin !== current.origin || (target.protocol !== "http:" && target.protocol !== "https:")) {
    return intercept(url, "external", null);
  }
  // URL#hash is "" for a bare "#", so the raw href decides whether the link carries a fragment
  const samePage = target.pathname === current.pathname && target.search === current.search;
  if (samePage && click.href.includes("#")) return ALLOW;
  const targetLab = labIdFromUrl(target);
  if (targetLab === null) return intercept(url, "page", null);
  return intercept(url, targetLab === labIdFromUrl(current) ? "same-lab" : "lab", targetLab);
}

function intercept(url: string, reason: LabNavigationReason, labId: string | null): LabNavigationDecision {
  return { action: "intercept", request: { url, reason, labId } };
}

/**
 * A navigation the lab starts by script (location.href = …, a form submission), seen through the Navigation API:
 * the same rules as a plain left click on a link to that URL.
 */
export function decideScriptedNavigation(destination: string, currentUrl: string): LabNavigationDecision {
  return decideLabNavigation(
    {
      href: destination,
      target: "",
      download: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
    },
    currentUrl,
  );
}
