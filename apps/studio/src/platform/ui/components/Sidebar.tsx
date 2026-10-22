import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, PanelLeft, type LucideIcon } from "lucide-react";
import { cx } from "../lib/dom";
import { rovingTargetIndex } from "../lib/roving";
import type { ShortcutSpec } from "../lib/shortcuts";
import { useControllableState } from "../hooks/useLatest";
import { useAppLayout } from "./AppLayout";
import { IconButton } from "./Button";
import { AppMark, Icon } from "./Icon";
import "./sidebar.css";

const ROW_SELECTOR = "[data-px-sidebar-row]";

function visibleRows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter((row) => row.getClientRects().length > 0);
}

const SidebarDepth = createContext(0);

export interface SidebarProps {
  "aria-label"?: string | undefined;
  /** The brand row (SidebarBrand), aligned with the toolbar. */
  header?: ReactNode;
  /** The account row (AccountButton). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}

/**
 * The floating glass sidebar (§2.2): <nav> with one tab stop (the current row), ↑/↓/Home/End between rows, →/← to
 * expand, collapse and step out. The selected row is emphasized (accent fill) while the sidebar has the user's
 * attention and unemphasized (grey) otherwise — a JS flag, because Safari does not focus links on click.
 */
export function Sidebar({ header, footer, children, className, ...aria }: SidebarProps) {
  const nav = useRef<HTMLElement | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(false);
  // inside AppLayout the width handle lives in the nav landmark (content outside landmarks is unreachable by region)
  const resizeHandle = useAppLayout()?.sidebarResizeHandle ?? null;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => setActive(nav.current?.contains(event.target as Node) ?? false);
    const onFocusIn = (event: globalThis.FocusEvent) => {
      if (!nav.current?.contains(event.target as Node)) setActive(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, []);

  // exactly one row is tabbable: the last focused one, else the current page, else the first
  const assignTabStop = () => {
    const root = nav.current;
    if (!root) return;
    const rows = visibleRows(root);
    const stop = rows.find((row) => row === lastFocused.current)
      ?? rows.find((row) => row.getAttribute("aria-current") === "page")
      ?? rows[0];
    for (const row of rows) row.tabIndex = row === stop ? 0 : -1;
  };
  useLayoutEffect(assignTabStop);
  useEffect(() => {
    const root = nav.current;
    if (!root || typeof MutationObserver === "undefined") return undefined;
    // rows inside items that re-render on their own (expand/collapse) appear without the parent re-rendering
    const observer = new MutationObserver(assignTabStop);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
    // assignTabStop only reads refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    setActive(true);
    const root = nav.current;
    if (!root || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = visibleRows(root);
    const current = rows.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    event.preventDefault();
    const target = rovingTargetIndex(event.key, current, rows.length, {
      orientation: "vertical",
      loop: false,
      isDisabled: (index) => rows[index]?.getAttribute("aria-disabled") === "true",
    });
    if (target !== null) rows[target]?.focus();
  };

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(ROW_SELECTOR);
    if (row && nav.current?.contains(row)) {
      lastFocused.current = row;
      assignTabStop();
    }
  };

  return (
    <nav
      ref={nav}
      aria-label={aria["aria-label"] ?? "Sidebar"}
      className={cx("px-sidebar", className)}
      data-active={active || undefined}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {header ? <div className="px-sidebar__header">{header}</div> : null}
      <div className="px-sidebar__scroll">{children}</div>
      {footer ? <div className="px-sidebar__footer">{footer}</div> : null}
      {resizeHandle}
    </nav>
  );
}

export interface SidebarBrandProps {
  /** Usually "#/" (Home). */
  href?: string | undefined;
  name?: string | undefined;
  /** The hide-sidebar toggle (SidebarToggle). */
  trailing?: ReactNode;
}

/** 20 px mark + wordmark, clicking goes Home. */
export function SidebarBrand({ href = "#/", name = "VISCERA", trailing }: SidebarBrandProps) {
  return (
    <>
      <a href={href} className="px-sidebar-brand" aria-label={`${name} Home`}>
        <AppMark size={20} />
        <span className="px-sidebar-brand__wordmark" aria-hidden="true">
          {name}
        </span>
      </a>
      {trailing}
    </>
  );
}

export interface SidebarToggleProps {
  hidden: boolean;
  onToggle: () => void;
  shortcut?: ShortcutSpec | undefined;
}

/** PanelLeft: "Hide Sidebar ⌃⌘S" / "Show Sidebar ⌃⌘S". */
export function SidebarToggle({ hidden, onToggle, shortcut }: SidebarToggleProps) {
  return <IconButton icon={PanelLeft} label={hidden ? "Show Sidebar" : "Hide Sidebar"} shortcut={shortcut} size="large" onClick={onToggle} />;
}

export interface SidebarSectionProps {
  /** Sentence/title case, never uppercase (macOS 11+). Omit for the first, untitled section. */
  title?: string | undefined;
  collapsible?: boolean | undefined;
  collapsed?: boolean | undefined;
  defaultCollapsed?: boolean | undefined;
  onCollapsedChange?: ((collapsed: boolean) => void) | undefined;
  children: ReactNode;
}

export function SidebarSection({ title, collapsible = false, collapsed, defaultCollapsed = false, onCollapsedChange, children }: SidebarSectionProps) {
  const listId = useId();
  const [isCollapsed, setCollapsed] = useControllableState(collapsed, defaultCollapsed, onCollapsedChange);
  return (
    <div className={cx("px-sidebar-section", title === undefined && "px-sidebar-section--untitled")}>
      {title !== undefined ? (
        <h2 className="px-sidebar-section__heading">
          {collapsible ? (
            <button
              type="button"
              data-px-sidebar-row=""
              tabIndex={-1}
              className="px-sidebar-section__toggle"
              aria-expanded={!isCollapsed}
              aria-controls={isCollapsed ? undefined : listId}
              onClick={() => setCollapsed(!isCollapsed)}
            >
              <span>{title}</span>
              <Icon icon={ChevronDown} size={10} strokeWidth={2.25} className="px-sidebar-section__chevron" />
            </button>
          ) : (
            <span className="px-sidebar-section__title">{title}</span>
          )}
        </h2>
      ) : null}
      {isCollapsed ? null : (
        <ul id={listId} role="list" className="px-sidebar-list">
          {children}
        </ul>
      )}
    </div>
  );
}

export interface SidebarItemProps {
  label: string;
  icon?: LucideIcon | undefined;
  /** Icon colour with meaning (lab tints); the accent by default. */
  tint?: string | undefined;
  /** Hash routes ("#/library"); without href the row is a button. */
  href?: string | undefined;
  onSelect?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  /** aria-current="page". */
  current?: boolean | undefined;
  /** Plain trailing count, like Mail (not a pill). */
  count?: number | string | undefined;
  disabled?: boolean | undefined;
  /** Highlight while a dragged library item is over the row. */
  dropTarget?: boolean | undefined;
  /** Nested rows (at most two levels, ≤ 5 recent projects of a lab). */
  children?: ReactNode;
  expanded?: boolean | undefined;
  defaultExpanded?: boolean | undefined;
  onExpandedChange?: ((expanded: boolean) => void) | undefined;
}

export function SidebarItem({
  label,
  icon,
  tint,
  href,
  onSelect,
  current = false,
  count,
  disabled = false,
  dropTarget = false,
  children,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
}: SidebarItemProps) {
  const depth = useContext(SidebarDepth);
  const groupId = useId();
  const expandable = children != null && depth === 0;
  const [isExpanded, setExpanded] = useControllableState(expanded, defaultExpanded, onExpandedChange);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const row = event.currentTarget;
    if (event.key === "ArrowRight" && expandable) {
      event.preventDefault();
      if (!isExpanded) setExpanded(true);
      else row.parentElement?.querySelector<HTMLElement>(`:scope > ul ${ROW_SELECTOR}`)?.focus();
    } else if (event.key === "ArrowLeft") {
      if (expandable && isExpanded) {
        event.preventDefault();
        setExpanded(false);
      } else if (depth > 0) {
        event.preventDefault();
        row.closest("ul")?.parentElement?.querySelector<HTMLElement>(`:scope > ${ROW_SELECTOR}`)?.focus();
      }
    }
  };

  const content = (
    <>
      {depth === 0 && icon ? (
        <Icon icon={icon} size={16} className="px-sidebar-row__icon" style={tint ? { color: tint } : undefined} />
      ) : null}
      <span className="px-sidebar-row__label">{label}</span>
      {count !== undefined ? <span className="px-sidebar-row__count px-num">{count}</span> : null}
      {expandable ? (
        <span
          className="px-sidebar-row__disclosure"
          aria-hidden="true"
          onClick={(event) => {
            // the chevron toggles; the rest of the row navigates (§2.2)
            event.preventDefault();
            event.stopPropagation();
            setExpanded(!isExpanded);
          }}
        >
          <Icon icon={ChevronRight} size={10} strokeWidth={2.25} />
        </span>
      ) : null}
    </>
  );

  const shared = {
    className: cx("px-sidebar-row", depth > 0 && "px-sidebar-row--nested", dropTarget && "px-sidebar-row--drop"),
    "data-px-sidebar-row": "",
    tabIndex: -1,
    "aria-current": current ? ("page" as const) : undefined,
    "aria-expanded": expandable ? isExpanded : undefined,
    "aria-controls": expandable && isExpanded ? groupId : undefined,
    "aria-disabled": disabled || undefined,
    onKeyDown,
  };

  return (
    <li className="px-sidebar-item">
      {href !== undefined && !disabled ? (
        <a href={href} {...shared} onClick={onSelect}>
          {content}
        </a>
      ) : (
        <button type="button" {...shared} onClick={disabled ? undefined : onSelect}>
          {content}
        </button>
      )}
      {expandable && isExpanded ? (
        <SidebarDepth.Provider value={depth + 1}>
          <ul id={groupId} role="list" className="px-sidebar-children">
            {children}
          </ul>
        </SidebarDepth.Provider>
      ) : null}
    </li>
  );
}
