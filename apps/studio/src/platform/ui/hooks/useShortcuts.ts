import { useEffect } from "react";
import { findShortcut, isEditableTarget, type ShortcutBinding } from "../lib/shortcuts";
import { useLatest } from "./useLatest";
import { useIsMac } from "./usePlatform";

export interface ShortcutHandler extends ShortcutBinding {
  handler: (event: KeyboardEvent) => void;
  /** Defaults to true: a handled shortcut never also triggers the browser's action (⌘S "Save Page"). */
  preventDefault?: boolean | undefined;
}

export interface UseShortcutsOptions {
  /** Defaults to window. */
  target?: Window | HTMLElement | null | undefined;
  enabled?: boolean | undefined;
}

/** Lab viewports own their single-key shortcuts (§4.1): app-scope shortcuts stay out of them. */
const LAB_SELECTOR = "[data-px-lab-viewport], .px-lab-host";

function modalOpen(): boolean {
  try {
    return document.querySelector("dialog:modal") !== null;
  } catch {
    return document.querySelector("dialog[open]") !== null;
  }
}

/**
 * Registers keyboard shortcuts ("mod+s" = ⌘S / Ctrl+S). App-scope shortcuts ignore keys typed into text fields
 * unless allowInEditable, and pause while a modal is open; components that handle a key themselves call
 * preventDefault() and the shortcut does not fire.
 */
export function useShortcuts(bindings: readonly ShortcutHandler[], options: UseShortcutsOptions = {}): void {
  const latest = useLatest(bindings);
  const mac = useIsMac();
  const enabled = options.enabled ?? true;
  const target = options.target;
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;
    const node: Window | HTMLElement = target ?? window;
    const onKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent) || event.defaultPrevented) return;
      const element = event.target instanceof Element ? event.target : null;
      const list = latest.current;
      const index = findShortcut(list, event, {
        mac,
        editable: isEditableTarget(element as HTMLElement | null),
        inLab: element?.closest(LAB_SELECTOR) != null,
        modalOpen: modalOpen(),
      });
      const binding = index >= 0 ? list[index] : undefined;
      if (!binding) return;
      if (binding.preventDefault !== false) event.preventDefault();
      binding.handler(event);
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [enabled, target, mac, latest]);
}
