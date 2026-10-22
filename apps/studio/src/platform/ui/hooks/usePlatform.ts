import { useMemo } from "react";
import { navigatorPlatform } from "../lib/dom";
import { isMacPlatform } from "../lib/shortcuts";

/** Apple platforms show ⌘ and the HIG glyphs; everyone else gets Ctrl+Alt+Shift+K. */
export function useIsMac(): boolean {
  return useMemo(() => isMacPlatform(navigatorPlatform()), []);
}
