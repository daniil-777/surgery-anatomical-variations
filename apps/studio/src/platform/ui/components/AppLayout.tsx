import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cssVars, cx, readStorage, writeStorage } from "../lib/dom";
import type { ShortcutSpec } from "../lib/shortcuts";
import { useControllableState } from "../hooks/useLatest";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useScrolledEdge } from "../hooks/useScrolledEdge";
import { useShortcuts } from "../hooks/useShortcuts";
import "./layout.css";

/** ⌃⌘S on a Mac, Ctrl+Alt+S elsewhere (§4.1). */
export const SIDEBAR_SHORTCUT: ShortcutSpec = { mac: "ctrl+meta+s", other: "ctrl+alt+s" };

const WIDTH_KEY = "viscera.px.sidebar.width.v1";
const WIDTH_DEFAULT = 240;
const WIDTH_MIN = 220;
const WIDTH_MAX = 260;

function clampWidth(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(value))) : WIDTH_DEFAULT;
}

export interface AppLayoutContextValue {
  /** Content has scrolled under the toolbar. */
  scrolled: boolean;
  hasSidebar: boolean;
  sidebarHidden: boolean;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
  /** Below 900 px the sidebar is an overlay with a scrim. */
  overlay: boolean;
  titleRef: RefObject<HTMLHeadingElement | null>;
  /** Route changes focus the toolbar title (§4.2). */
  focusTitle: () => void;
  /** The sidebar width handle; <Sidebar> renders it inside its <nav>. */
  sidebarResizeHandle: ReactNode;
}

const AppLayoutContext = createContext<AppLayoutContextValue | null>(null);

export function useAppLayout(): AppLayoutContextValue | null {
  return useContext(AppLayoutContext);
}

export interface AppLayoutProps {
  sidebar?: ReactNode;
  toolbar?: ReactNode;
  inspector?: ReactNode;
  inspectorShown?: boolean | undefined;
  sidebarHidden?: boolean | undefined;
  defaultSidebarHidden?: boolean | undefined;
  onSidebarHiddenChange?: ((hidden: boolean) => void) | undefined;
  /** "lab": the toolbar never overlaps the viewport and the sidebar floats (solid) over it when shown. */
  mode?: "app" | "lab" | undefined;
  /** Registers ⌃⌘S / Ctrl+Alt+S (default on). */
  sidebarShortcut?: boolean | undefined;
  /** Names <main> when the page has more than one region worth announcing. */
  contentLabel?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * The window frame (§2.1): floating sidebar, unified toolbar over a scrolling content column, optional inspector.
 * Content scrolls under the toolbar; the toolbar reads the scrolled edge from this layout's context.
 */
export function AppLayout({
  sidebar,
  toolbar,
  inspector,
  inspectorShown = true,
  sidebarHidden,
  defaultSidebarHidden,
  onSidebarHiddenChange,
  mode = "app",
  sidebarShortcut = true,
  contentLabel,
  className,
  children,
}: AppLayoutProps) {
  const narrow = useMediaQuery("(max-width: 899px)");
  const [hidden, setHidden] = useControllableState(sidebarHidden, defaultSidebarHidden ?? mode === "lab", onSidebarHiddenChange);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [width, setWidth] = useState(() => clampWidth(Number(readStorage(WIDTH_KEY))));
  const { sentinelRef, scrolled } = useScrolledEdge();
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const hasSidebar = sidebar != null;
  const effectiveHidden = !hasSidebar || (narrow ? !overlayOpen : hidden);

  useEffect(() => {
    if (!narrow) setOverlayOpen(false);
  }, [narrow]);

  const toggleSidebar = useCallback(() => {
    if (narrow) setOverlayOpen((open) => !open);
    else setHidden(!hidden);
  }, [narrow, hidden, setHidden]);

  const setSidebarHidden = useCallback((next: boolean) => {
    if (narrow) setOverlayOpen(!next);
    else setHidden(next);
  }, [narrow, setHidden]);

  useShortcuts([{ keys: SIDEBAR_SHORTCUT, handler: toggleSidebar }], { enabled: sidebarShortcut && hasSidebar });

  useEffect(() => {
    if (!(narrow && overlayOpen)) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setOverlayOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [narrow, overlayOpen]);

  const resizeWidth = useCallback((next: number, persist: boolean) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    if (persist) writeStorage(WIDTH_KEY, String(clamped));
  }, []);
  const resizeHandle = hasSidebar && !narrow && mode === "app" ? <SidebarResizeHandle width={width} onResize={resizeWidth} /> : null;

  const context = useMemo<AppLayoutContextValue>(() => ({
    scrolled,
    hasSidebar,
    sidebarHidden: effectiveHidden,
    toggleSidebar,
    setSidebarHidden,
    overlay: narrow,
    titleRef,
    focusTitle: () => titleRef.current?.focus({ preventScroll: true }),
    sidebarResizeHandle: resizeHandle,
  }), [scrolled, hasSidebar, effectiveHidden, toggleSidebar, setSidebarHidden, narrow, resizeHandle]);

  return (
    <AppLayoutContext.Provider value={context}>
      <div
        className={cx("px-app", narrow && "px-app--narrow", className)}
        data-mode={mode}
        data-sidebar={effectiveHidden ? "hidden" : "shown"}
        data-inspector={inspector != null && inspectorShown ? "shown" : "hidden"}
        style={cssVars({ "--px-sidebar-w": `${width}px` })}
      >
        <a
          className="px-skip-link"
          href="#px-main"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("px-main")?.focus();
          }}
        >
          Skip to Content
        </a>
        {hasSidebar ? (
          <div className="px-app__sidebar" inert={effectiveHidden || undefined}>
            {sidebar}
          </div>
        ) : null}
        {narrow && overlayOpen ? <div className="px-app__scrim" aria-hidden="true" onClick={() => setOverlayOpen(false)} /> : null}
        {toolbar ? <header className="px-app__toolbar">{toolbar}</header> : null}
        <main id="px-main" className="px-content" tabIndex={-1} aria-label={contentLabel} inert={(narrow && overlayOpen) || undefined}>
          <div ref={sentinelRef} className="px-content__sentinel" aria-hidden="true" />
          {children}
        </main>
        {inspector != null && inspectorShown ? <div className="px-app__inspector">{inspector}</div> : null}
      </div>
    </AppLayoutContext.Provider>
  );
}

/** The window frame under its macOS name. */
export const Window = AppLayout;

interface SidebarResizeHandleProps {
  width: number;
  onResize: (width: number, persist: boolean) => void;
}

/** 6 px trailing edge: drag, ←/→ by 8 px, double-click resets to 240 (§2.2). */
function SidebarResizeHandle({ width, onResize }: SidebarResizeHandleProps) {
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    const move = (moveEvent: globalThis.PointerEvent) => {
      latest = startWidth + moveEvent.clientX - startX;
      onResize(latest, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResize(latest, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? -8 : event.key === "ArrowRight" ? 8 : 0;
    if (step !== 0) {
      event.preventDefault();
      onResize(width + step, true);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onResize(event.key === "Home" ? WIDTH_MIN : WIDTH_MAX, true);
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar Width"
      aria-valuenow={width}
      aria-valuemin={WIDTH_MIN}
      aria-valuemax={WIDTH_MAX}
      tabIndex={0}
      className="px-app__resize"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(WIDTH_DEFAULT, true)}
      onKeyDown={onKeyDown}
    />
  );
}
