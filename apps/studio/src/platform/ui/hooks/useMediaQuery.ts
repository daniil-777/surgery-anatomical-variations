import { useCallback, useSyncExternalStore } from "react";

const lists = new Map<string, MediaQueryList>();

function mediaList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  let list = lists.get(query);
  if (!list) {
    list = window.matchMedia(query);
    lists.set(query, list);
  }
  return list;
}

/** A CSS media query as React state (concurrent-safe through useSyncExternalStore). */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback((notify: () => void) => {
    const list = mediaList(query);
    if (!list) return () => undefined;
    list.addEventListener("change", notify);
    return () => list.removeEventListener("change", notify);
  }, [query]);
  const snapshot = useCallback(() => mediaList(query)?.matches ?? fallback, [query, fallback]);
  return useSyncExternalStore(subscribe, snapshot, () => fallback);
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

export function usePrefersDark(): boolean {
  return useMediaQuery("(prefers-color-scheme: dark)");
}

export function usePrefersReducedTransparency(): boolean {
  return useMediaQuery("(prefers-reduced-transparency: reduce)");
}
