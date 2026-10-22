// The app frame (APPLE_STYLE_SPEC §2.1): floating sidebar, unified toolbar, scrolling content. Pages render inside it;
// the toolbar shows the route's title until a page mounts its own <PageToolbar>. Route changes scroll the content to
// the top and move focus to the toolbar title (§4.2); the account's counts refresh as the person moves around.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppLayout, Toolbar, useAppLayout, useShortcuts } from "../../ui";
import { useSession } from "../context";
import { formatRoute, navigate, type Route } from "../router";
import { KeyboardShortcutsSheet } from "./KeyboardShortcutsSheet";
import { ToolbarSlotContext, type ToolbarSlot } from "./PageToolbar";
import { useUsage } from "./queries";
import { routeTitle, scrollKey } from "./routeMeta";
import { ShellSidebar } from "./ShellSidebar";
import "./styles/shell.css";

export interface ShellFrameProps {
  route: Route;
  children: ReactNode;
}

export function ShellFrame({ route, children }: ShellFrameProps) {
  const session = useSession();
  const [slotElement, setSlotElement] = useState<HTMLDivElement | null>(null);
  const [claims, setClaims] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const claim = useCallback(() => {
    let released = false;
    setClaims((value) => value + 1);
    return () => {
      if (released) return;
      released = true;
      setClaims((value) => value - 1);
    };
  }, []);
  const slot = useMemo<ToolbarSlot>(() => ({ element: slotElement, claim }), [slotElement, claim]);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);

  useShortcuts([
    {
      keys: "mod+,",
      scope: "global",
      handler: () => navigate(session ? { name: "settings" } : { name: "signin", next: "/settings" }),
    },
    { keys: "mod+/", scope: "global", handler: openShortcuts },
  ]);

  const title = routeTitle(route);
  return (
    <ToolbarSlotContext.Provider value={slot}>
      <AppLayout
        sidebar={<ShellSidebar route={route} onKeyboardShortcuts={openShortcuts} />}
        toolbar={
          <>
            {claims === 0 ? <Toolbar title={title} /> : null}
            <div ref={setSlotElement} className="px-shell-toolbar-slot" />
          </>
        }
      >
        <RouteEffects route={route} claims={claims} signedIn={session !== null} />
        {children}
      </AppLayout>
      <KeyboardShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </ToolbarSlotContext.Provider>
  );
}

function RouteEffects({ route, claims, signedIn }: { route: Route; claims: number; signedIn: boolean }) {
  const layout = useAppLayout();
  const routeKey = formatRoute(route);
  const pageKey = scrollKey(route);
  const initialRoute = useRef<string | null>(routeKey);
  const focusedRoute = useRef<string | null>(null);
  const usage = useUsage();
  const hasUsage = useRef(false);
  hasUsage.current = usage.data !== undefined;
  const refreshUsage = usage.refresh;

  useEffect(() => {
    document.getElementById("px-main")?.scrollTo({ top: 0 });
  }, [pageKey]);

  useEffect(() => {
    // counts change on other pages (uploads, trash): revalidate on every move, never twice on the first load
    if (signedIn && hasUsage.current) void refreshUsage();
  }, [pageKey, signedIn, refreshUsage]);

  useEffect(() => {
    // the first page of the visit leaves focus where the browser put it
    if (initialRoute.current === routeKey) return undefined;
    initialRoute.current = null;
    const frame = requestAnimationFrame(() => {
      const title = layout?.titleRef.current;
      if (!title) return;
      const active = document.activeElement;
      // a page's own toolbar replaces the default one after its code loads: follow it unless focus moved on
      if (focusedRoute.current !== routeKey || active === null || active === document.body) {
        title.focus({ preventScroll: true });
        focusedRoute.current = routeKey;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [routeKey, claims, layout]);

  return null;
}
