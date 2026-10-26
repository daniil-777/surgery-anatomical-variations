import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./sceneSectionNav.css";

const sections = [
  { id: "scene-joint-variation", label: "Joint variation", description: "Joint variation: shape and texture", kind: "variation" },
  { id: "scene-actions", label: "Actions", description: "Actions: camera and grasping", kind: "actions" },
  { id: "scene-disease", label: "Disease", description: "Disease: generate a condition", kind: "disease" },
] as const;

function SectionIcon({ kind }: { kind: typeof sections[number]["kind"] }) {
  return <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "variation" ? <>
      <path d="M15 5C9 2 3 7 4 14c1 6 8 7 12 4 5-4 5-10-1-13Z" opacity=".65" />
      <path d="M23 12c-6-3-13 1-12 8 1 6 8 9 13 5 5-3 5-10-1-13Z" />
      <path d="m16 18 3-2m2 5 3-2m-8 4 2-1" />
    </> : kind === "actions" ? <>
      <path d="m7 27 10-10 4 4-10 10M17 17l-2-8 7-6M21 21l8-1 1-9M15 9l5 2m9 9-3-5" />
      <path d="m21 5 2 3m4 2 3 1" opacity=".65" /><circle cx="19" cy="19" r="1" fill="currentColor" stroke="none" />
    </> : <>
      <path d="M12 4c4-3 7 1 10 2 5-1 8 4 6 8 3 5-1 9-5 10-2 6-8 6-11 2-5 1-9-3-8-8-4-4-1-10 4-10Z" />
      <circle cx="19" cy="13" r="3" /><circle cx="12" cy="20" r="2" /><path d="m10 11 1 1m11 9 1-1" opacity=".65" />
    </>}
  </svg>;
}

/** Navigation only: revealing a section must never apply a variation or start a task. */
export function SceneSectionNav({ revealScenePanel, scenePanelVisible }: { revealScenePanel: () => void; scenePanelVisible: boolean }) {
  const nav = useRef<HTMLElement>(null);
  const [request, setRequest] = useState<{ id: string } | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    const element = nav.current!, panel = element.closest<HTMLElement>(".whole-controls")!;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        panel.style.setProperty("--scene-shortcuts-height", `${element.offsetHeight}px`);
        const anchor = element.getBoundingClientRect().bottom + 16;
        setCurrent(sections.find(item => {
          const target = document.getElementById(item.id);
          if (!target || !target.getClientRects().length) return false;
          const box = target.getBoundingClientRect();
          return box.top <= anchor && box.bottom > anchor;
        })?.id ?? null);
      });
    };
    const observer = new ResizeObserver(update); observer.observe(element);
    document.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update); update();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      document.removeEventListener("scroll", update, true); window.removeEventListener("resize", update);
      panel.style.removeProperty("--scene-shortcuts-height");
    };
  }, []);

  useLayoutEffect(() => {
    if (!request || !nav.current) return;
    const target = document.getElementById(request.id);
    if (!target) return;
    const panel = nav.current.closest<HTMLElement>(".whole-controls")!;
    panel.style.setProperty("--scene-shortcuts-height", `${nav.current.offsetHeight}px`);
    if (window.matchMedia("(min-width: 761px)").matches) {
      panel.scrollTo({ top: panel.scrollTop + target.getBoundingClientRect().top - panel.getBoundingClientRect().top - nav.current.offsetHeight - 12, behavior: "instant" });
    } else {
      target.scrollIntoView({ block: "start", behavior: "instant" });
    }
    target.focus({ preventScroll: true }); setCurrent(request.id);
  }, [request]);

  return <nav ref={nav} className="scene-section-nav" aria-label="Scene shortcuts">
    {sections.map(item => <button key={item.id} type="button" aria-label={item.description}
      aria-controls={item.kind === "variation" && !scenePanelVisible ? undefined : item.id} aria-current={current === item.id ? "location" : undefined}
      title={`Open ${item.description.toLowerCase()}`} onClick={() => { revealScenePanel(); setRequest({ id: item.id }); }}>
      <span className={`scene-shortcut-icon scene-shortcut-${item.kind}`}><SectionIcon kind={item.kind} /></span>
      <span>{item.label}</span>
    </button>)}
  </nav>;
}
