// Small React/DOM utilities shared by the px components.

import type { CSSProperties, Ref, RefCallback, SyntheticEvent } from "react";

/** className join that skips falsy parts. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Inline custom properties (React's CSSProperties has no index signature for --*). */
export function cssVars(vars: Record<`--${string}`, string | number | undefined>, base?: CSSProperties): CSSProperties {
  const style: Record<string, string | number> = { ...(base as Record<string, string | number> | undefined) };
  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined) style[name] = value;
  }
  return style as CSSProperties;
}

/** One callback ref that feeds several refs (React 19 refs are plain props). */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined | null>): RefCallback<T> {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as { current: T | null }).current = node;
    }
  };
}

/** Runs the caller's handler first; ours is skipped when the caller called preventDefault(). */
export function composeHandlers<E extends SyntheticEvent>(
  theirs: ((event: E) => void) | undefined,
  ours: ((event: E) => void) | undefined,
): (event: E) => void {
  return (event: E) => {
    theirs?.(event);
    if (!event.defaultPrevented) ours?.(event);
  };
}

/** The platform string the boot script reads (userAgentData is Chromium-only and missing from lib.dom). */
export function navigatorPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform || navigator.platform || "";
}

let lastModality: "keyboard" | "pointer" = "pointer";
let modalityTracking = false;

/**
 * Whether the most recent interaction was a key press. Popovers move focus inside only when opened from the keyboard
 * (§4.2), so a click does not paint a focus ring on the first field.
 */
export function lastInputWasKeyboard(): boolean {
  trackInputModality();
  return lastModality === "keyboard";
}

export function trackInputModality(): void {
  if (modalityTracking || typeof document === "undefined") return;
  modalityTracking = true;
  document.addEventListener("keydown", (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) lastModality = "keyboard";
  }, true);
  document.addEventListener("pointerdown", () => {
    lastModality = "pointer";
  }, true);
}

/** Focusable descendants in tab order (used for initial focus in popovers and sheets). */
export function focusableWithin(root: ParentNode): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
    "[contenteditable='true']",
  ].join(",");
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => !element.closest("[inert]") && element.getClientRects().length > 0);
}

/** Safe localStorage access (private windows and blocked storage throw). */
export function readStorage(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    // storage full or blocked: the preference simply is not remembered
  }
}
