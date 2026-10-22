import { useEffect, useState } from "react";

/**
 * True once the scroll container's content has moved under its top edge (the macOS 27 "uniform" toolbar bar appears
 * then, §2.3). Put the returned ref on a 1 px sentinel absolutely positioned at the top of the scroll content
 * (the container needs position: relative); an IntersectionObserver keeps scrolling off the main thread.
 */
export function useScrolledEdge(): { sentinelRef: (element: HTMLElement | null) => void; scrolled: boolean } {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const root = sentinel?.parentElement;
    if (!sentinel || !root) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      const onScroll = () => setScrolled(root.scrollTop > 0);
      onScroll();
      root.addEventListener("scroll", onScroll, { passive: true });
      return () => root.removeEventListener("scroll", onScroll);
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setScrolled(!entry.isIntersecting || entry.intersectionRatio < 1);
    }, { root, threshold: [1] });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel]);

  return { sentinelRef: setSentinel, scrolled };
}
