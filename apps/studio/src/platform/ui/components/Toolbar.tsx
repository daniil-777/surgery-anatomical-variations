import type { ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { cx } from "../lib/dom";
import { IconButton } from "./Button";
import { SIDEBAR_SHORTCUT, useAppLayout } from "./AppLayout";
import "./toolbar.css";

export interface ToolbarProps {
  /** The page or document name: an <h1 tabindex="-1"> that route changes focus (§4.2). */
  title?: ReactNode;
  /** Item count or save status in Subheadline secondary. */
  subtitle?: ReactNode;
  /** Back button and other leading items; the Show Sidebar toggle is added while the sidebar is hidden. */
  leading?: ReactNode;
  /** One centred control (segmented scope or view switch). */
  center?: ReactNode;
  /** Overflow priority of the centre control (1 never hides; 2 and 3 hide as the toolbar narrows). */
  centerPriority?: ToolbarPriority | undefined;
  /** At most three glass groups and one prominent action, trailing (HIG). */
  trailing?: ReactNode;
  /** Overrides the scrolled-edge state AppLayout provides. */
  scrolled?: boolean | undefined;
  className?: string | undefined;
}

/**
 * The unified 52 px toolbar (§2.3): transparent at rest; once content scrolls under it, the macOS 27 "uniform" bar
 * fades in and the glass items inside stop blurring (glass never samples glass).
 */
export function Toolbar({ title, subtitle, leading, center, centerPriority = 1, trailing, scrolled, className }: ToolbarProps) {
  const layout = useAppLayout();
  const isScrolled = scrolled ?? layout?.scrolled ?? false;
  const showSidebarToggle = layout !== null && layout.hasSidebar && layout.sidebarHidden;
  return (
    <div className={cx("px-toolbar", center ? "px-toolbar--centered" : null, className)} data-scrolled={isScrolled || undefined}>
      <div className="px-toolbar__start">
        {showSidebarToggle ? (
          <span className="px-tb-group">
            <IconButton icon={PanelLeft} label="Show Sidebar" shortcut={SIDEBAR_SHORTCUT} variant="toolbar" size="toolbar" onClick={layout.toggleSidebar} />
          </span>
        ) : null}
        {leading}
        {title != null ? (
          <div className="px-toolbar__titles">
            <h1 ref={layout?.titleRef} tabIndex={-1} className="px-toolbar__title">
              {title}
            </h1>
            {subtitle ? <p className="px-toolbar__subtitle px-num">{subtitle}</p> : null}
          </div>
        ) : null}
      </div>
      {center ? (
        <div className="px-toolbar__center" data-px-priority={centerPriority}>
          {center}
        </div>
      ) : null}
      <div className="px-toolbar__end">{trailing}</div>
    </div>
  );
}

/**
 * Toolbar overflow priority (§2.3): 1 always shows; 3 hides first (toolbar under 920 px), then 2 (under 760 px).
 * Hidden commands must stay reachable elsewhere (context menu, ⌘K), as the spec requires for menu-bar parity.
 */
export type ToolbarPriority = 1 | 2 | 3;

export interface ToolbarGroupProps {
  children: ReactNode;
  /** Names the group when its buttons belong together ("View", "History"). */
  "aria-label"?: string | undefined;
  priority?: ToolbarPriority | undefined;
  className?: string | undefined;
}

/** A glass capsule holding 36 px icon buttons (IconButton variant="toolbar" size="toolbar"). */
export function ToolbarGroup({ children, priority = 1, className, ...aria }: ToolbarGroupProps) {
  return (
    <div
      role={aria["aria-label"] ? "group" : undefined}
      aria-label={aria["aria-label"]}
      className={cx("px-tb-group", className)}
      data-px-priority={priority}
    >
      {children}
    </div>
  );
}

/** Gives any toolbar item (a search field, a menu button) an overflow priority without adding a box. */
export function ToolbarItem({ priority, children }: { priority: ToolbarPriority; children: ReactNode }) {
  return (
    <div className="px-tb-item" data-px-priority={priority}>
      {children}
    </div>
  );
}
