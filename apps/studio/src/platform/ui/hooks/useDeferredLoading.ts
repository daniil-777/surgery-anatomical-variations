import { useEffect, useRef, useState } from "react";

/**
 * Skeleton timing from §2.14 / §4.4: show only when loading lasts longer than `delay` (fast loads never flash a
 * skeleton) and, once shown, keep it at least `minVisible` so it does not flicker away.
 */
export function useDeferredLoading(loading: boolean, delay = 150, minVisible = 300): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (loading) {
      if (visible) return undefined;
      const timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
      return () => window.clearTimeout(timer);
    }
    if (!visible) return undefined;
    const remaining = Math.max(0, minVisible - (Date.now() - shownAt.current));
    const timer = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(timer);
  }, [loading, visible, delay, minVisible]);

  return visible;
}
