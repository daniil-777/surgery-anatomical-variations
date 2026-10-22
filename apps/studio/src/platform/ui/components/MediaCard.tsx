import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Check, Ellipsis, Heart, ImageOff, type LucideIcon } from "lucide-react";
import { cssVars, cx } from "../lib/dom";
import { countGridColumns, gridTargetIndex, rangeSelection, selectWithGesture } from "../lib/roving";
import { useLatest } from "../hooks/useLatest";
import { useIsMac } from "../hooks/usePlatform";
import { Icon } from "./Icon";
import { ProgressRing } from "./Progress";
import "./media.css";

export interface GridProps {
  /** Minimum tile width: 136 / 168 (default) / 208 / 256 from the zoom slider. */
  tileMin?: number | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  children: ReactNode;
}

/** Responsive auto-fill layout (§2.9): repeat(auto-fill, minmax(tile, 1fr)), gap 16 × 12. */
export function Grid({ tileMin, className, style, children }: GridProps) {
  return (
    <div className={cx("px-grid", className)} style={cssVars({ "--px-tile-min": tileMin === undefined ? undefined : `${tileMin}px` }, style)}>
      {children}
    </div>
  );
}

interface MediaGridContextValue {
  gridId: string;
  selected: ReadonlySet<string>;
  tabStopId: string | null;
  multiSelecting: boolean;
  select: (id: string, event: MouseEvent<HTMLElement>) => void;
  /** A card received focus (click or Tab): it becomes the tab stop. */
  cardFocused: (id: string) => void;
  open: (id: string) => void;
}

const MediaGridContext = createContext<MediaGridContextValue | null>(null);

export interface MediaGridProps {
  "aria-label": string;
  selected: ReadonlySet<string>;
  onSelectionChange: (selected: Set<string>) => void;
  /** ⌘-click, ⇧-click, ⌘A (default on). */
  multiselect?: boolean | undefined;
  /** Double-click, Return, ⌘↓. */
  onOpen?: ((id: string) => void) | undefined;
  /** Space. */
  onQuickLook?: ((id: string) => void) | undefined;
  /** "." toggles favourite on the selection (the Photos convention). */
  onToggleFavorite?: ((ids: string[]) => void) | undefined;
  /** ⌘⌫ (Delete elsewhere): move the selection to the Trash, then offer Undo in a toast. */
  onDelete?: ((ids: string[]) => void) | undefined;
  tileMin?: number | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * The Library/Imports/Projects collection (§2.9): role="listbox" with one tab stop, arrows in two dimensions
 * (columns read from the computed grid), Finder selection gestures, ⌘A, Escape, Return, Space, "." and ⌘⌫.
 */
export function MediaGrid({
  selected,
  onSelectionChange,
  multiselect = true,
  onOpen,
  onQuickLook,
  onToggleFavorite,
  onDelete,
  tileMin,
  className,
  children,
  ...aria
}: MediaGridProps) {
  const gridId = useId();
  const mac = useIsMac();
  const container = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tabStopId, setTabStopId] = useState<string | null>(null);
  const anchorId = useRef<string | null>(null);
  const latest = useLatest({ selected, onSelectionChange, multiselect, onOpen, onQuickLook, onToggleFavorite, onDelete, activeId });

  const orderedIds = useCallback((): string[] => {
    const root = container.current;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>('[role="option"][data-id]')]
      .filter((element) => element.closest('[role="listbox"]') === root)
      .map((element) => element.dataset.id ?? "")
      .filter((id) => id !== "");
  }, []);

  // one tab stop: the active card while it exists, else the first selected card, else the first card
  useLayoutEffect(() => {
    const ids = orderedIds();
    const next = activeId !== null && ids.includes(activeId) ? activeId : ids.find((id) => selected.has(id)) ?? ids[0] ?? null;
    if (next !== tabStopId) setTabStopId(next);
  });

  const focusCard = useCallback((id: string) => {
    const card = container.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    card?.focus();
    setActiveId(id);
  }, []);

  const select = useCallback((id: string, event: MouseEvent<HTMLElement>) => {
    const current = latest.current;
    const result = selectWithGesture(orderedIds(), current.selected, anchorId.current, id, {
      toggle: mac ? event.metaKey : event.ctrlKey,
      extend: event.shiftKey,
    }, current.multiselect);
    anchorId.current = result.anchorId;
    setActiveId(id);
    current.onSelectionChange(result.selected);
  }, [latest, mac, orderedIds]);

  const open = useCallback((id: string) => latest.current.onOpen?.(id), [latest]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = latest.current;
    const all = orderedIds();
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.id ?? current.activeId;
    const index = focusedId ? all.indexOf(focusedId) : -1;
    const mod = mac ? event.metaKey : event.ctrlKey;
    const chosen = () => {
      const list = all.filter((id) => current.selected.has(id));
      return list.length > 0 ? list : focusedId ? [focusedId] : [];
    };
    if (mod && event.key.toLowerCase() === "a" && current.multiselect) {
      event.preventDefault();
      current.onSelectionChange(new Set(all));
      return;
    }
    if (event.key === "Escape" && current.selected.size > 0) {
      event.preventDefault();
      current.onSelectionChange(new Set());
      return;
    }
    if (focusedId && (event.key === "Enter" || (mac && event.metaKey && event.key === "ArrowDown"))) {
      event.preventDefault();
      current.onOpen?.(focusedId);
      return;
    }
    if (focusedId && event.key === " " && !mod) {
      event.preventDefault();
      current.onQuickLook?.(focusedId);
      return;
    }
    if (event.key === "." && !mod && !event.altKey) {
      event.preventDefault();
      current.onToggleFavorite?.(chosen());
      return;
    }
    if ((mac && event.metaKey && event.key === "Backspace") || (!mac && event.key === "Delete")) {
      event.preventDefault();
      current.onDelete?.(chosen());
      return;
    }
    const columns = container.current ? countGridColumns(getComputedStyle(container.current).gridTemplateColumns) : 1;
    const rtl = container.current ? getComputedStyle(container.current).direction === "rtl" : false;
    const target = gridTargetIndex(event.key, index, all.length, columns, rtl);
    if (target === null) return;
    event.preventDefault();
    const id = all[target];
    if (id === undefined) return;
    focusCard(id);
    if (event.shiftKey && current.multiselect) {
      if (anchorId.current === null) anchorId.current = focusedId ?? id;
      current.onSelectionChange(rangeSelection(all, anchorId.current, id));
    } else if (!mod) {
      // selection follows focus; ⌘/Ctrl+arrow moves focus only
      anchorId.current = id;
      current.onSelectionChange(new Set([id]));
    }
  };

  return (
    <MediaGridContext.Provider
      value={{ gridId, selected, tabStopId, multiSelecting: selected.size > 1, select, cardFocused: setActiveId, open }}
    >
      <div
        ref={container}
        role="listbox"
        aria-label={aria["aria-label"]}
        aria-multiselectable={multiselect || undefined}
        aria-orientation="horizontal"
        className={cx("px-grid", "px-media-grid", className)}
        style={cssVars({ "--px-tile-min": tileMin === undefined ? undefined : `${tileMin}px` })}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </MediaGridContext.Provider>
  );
}

export type MediaRatio = "1:1" | "16:10" | "16:9" | "4:3";

export interface MediaCardProps {
  /** Unique within the grid. */
  id: string;
  title: string;
  /** "Material · Tissue Lab", "Tissue Lab · Edited 2 h ago". */
  subtitle?: ReactNode;
  /** Image URL (a signed URL or an object URL). */
  thumbnail?: string | null | undefined;
  /** Shown without a thumbnail (a lab glyph on its tint). */
  placeholder?: ReactNode;
  ratio?: MediaRatio | undefined;
  /** The kind chip (top-left, in "All"). */
  kindIcon?: LucideIcon | undefined;
  /** "0:42" (bottom-right). */
  duration?: string | undefined;
  /** Status chips (bottom-left), e.g. <Badge tone="hud">4K · PBR</Badge>. They are visual: say them in `description`. */
  badges?: ReactNode;
  /** Read after the name ("4K · PBR"); duration, favourite, progress and errors are added automatically. */
  description?: string | undefined;
  favorite?: boolean | undefined;
  /** Shows the heart on hover; keyboard users press "." on the grid. */
  onFavoriteChange?: ((favorite: boolean) => void) | undefined;
  /** Shows the ⋯ button on hover; keyboard users use the context menu. */
  onMore?: ((anchor: HTMLElement) => void) | undefined;
  status?: "ready" | "loading" | "processing" | "error" | undefined;
  /** 0…1 while processing (uploads, imports). */
  progress?: number | undefined;
  /** Placeholder colour while the image loads. */
  dominantColor?: string | undefined;
  /** Documentation only: force the hover look. */
  forceHover?: boolean | undefined;
  className?: string | undefined;
}

/**
 * One tile of a MediaGrid. The role="option" holds the thumbnail, title and subtitle (its name); the chips and the
 * hover buttons sit in an aria-hidden overlay beside it, so the option's visible text is exactly its name and no
 * control is nested inside an option. What the chips say is read as the option's description.
 */
export function MediaCard({
  id,
  title,
  subtitle,
  thumbnail,
  placeholder,
  ratio = "1:1",
  kindIcon,
  duration,
  badges,
  description,
  favorite = false,
  onFavoriteChange,
  onMore,
  status = "ready",
  progress = 0,
  dominantColor,
  forceHover = false,
  className,
}: MediaCardProps) {
  const grid = useContext(MediaGridContext);
  const titleId = useId();
  const subtitleId = useId();
  const descriptionId = useId();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [thumbnail]);

  const selected = grid?.selected.has(id) ?? false;
  const error = status === "error" || failed;
  const showImage = Boolean(thumbnail) && !error;
  const spoken = [
    description,
    duration ? `Duration ${duration}` : null,
    favorite ? "Favorite" : null,
    status === "processing" ? `Processing, ${Math.round(Math.min(1, Math.max(0, progress)) * 100)} percent` : null,
    status === "loading" ? "Loading" : null,
    error ? "Preview unavailable" : null,
  ].filter(Boolean).join(", ");

  return (
    <div className={cx("px-card", selected && "px-card--selected", forceHover && "px-card--hover", className)} data-ratio={ratio}>
      <div
        role="option"
        id={grid ? `${grid.gridId}-${id}` : undefined}
        data-id={id}
        aria-selected={selected}
        aria-labelledby={subtitle ? `${titleId} ${subtitleId}` : titleId}
        aria-describedby={spoken ? descriptionId : undefined}
        aria-busy={status === "processing" || status === "loading" || undefined}
        tabIndex={grid?.tabStopId === id ? 0 : -1}
        className="px-card__option"
        onClick={(event) => grid?.select(id, event)}
        onDoubleClick={() => grid?.open(id)}
        onFocus={(event) => {
          if (event.target === event.currentTarget) grid?.cardFocused(id);
        }}
      >
        <div className="px-card__thumb" style={dominantColor ? { background: dominantColor } : undefined}>
          {showImage ? (
            <img
              src={thumbnail ?? undefined}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              data-loaded={loaded || undefined}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
          ) : error ? null : (
            placeholder
          )}
          {status === "loading" || (showImage && !loaded) ? <span className="px-card__shimmer" aria-hidden="true" /> : null}
        </div>
        <div className="px-card__text">
          <span id={titleId} className="px-card__title">
            {title}
          </span>{" "}
          {subtitle ? (
            <span id={subtitleId} className="px-card__subtitle">
              {subtitle}
            </span>
          ) : null}
        </div>
        {spoken ? (
          <span id={descriptionId} className="px-visually-hidden">
            {spoken}
          </span>
        ) : null}
      </div>
      <div className="px-card__overlay" aria-hidden="true">
        {error ? (
          <span className="px-card__error">
            <Icon icon={ImageOff} size={24} />
            <span>Preview Unavailable</span>
          </span>
        ) : null}
        {kindIcon ? (
          <span className="px-card__chip px-card__kind">
            <Icon icon={kindIcon} size={12} />
          </span>
        ) : null}
        {selected && grid?.multiSelecting ? (
          <span className="px-card__check">
            <Icon icon={Check} size={12} strokeWidth={2.5} />
          </span>
        ) : (
          <span className="px-card__actions">
            {onMore ? (
              <span className="px-card__action px-card__more" onClick={(event) => onMore(event.currentTarget)}>
                <Icon icon={Ellipsis} size={14} />
              </span>
            ) : null}
            {onFavoriteChange || favorite ? (
              <span
                className={cx("px-card__action", "px-card__favorite", favorite && "px-card__favorite--on")}
                onClick={() => onFavoriteChange?.(!favorite)}
              >
                <Icon icon={Heart} size={13} fill={favorite ? "currentColor" : "none"} />
              </span>
            ) : null}
          </span>
        )}
        {status === "processing" ? (
          <span className="px-card__badges">
            <span className="px-card__chip px-card__ring">
              <ProgressRing value={progress} size={16} />
            </span>
          </span>
        ) : badges ? (
          <span className="px-card__badges">{badges}</span>
        ) : null}
        {duration ? <span className="px-card__chip px-card__duration px-num">{duration}</span> : null}
      </div>
    </div>
  );
}
