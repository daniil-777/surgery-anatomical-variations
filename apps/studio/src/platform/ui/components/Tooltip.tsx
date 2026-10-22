import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import type { Placement } from "@floating-ui/react-dom";
import { composeHandlers } from "../lib/dom";
import { formatShortcut, type ShortcutSpec } from "../lib/shortcuts";
import { useLatest, useMergedRefs } from "../hooks/useLatest";
import { useIsMac } from "../hooks/usePlatform";
import { usePopoverLayer } from "../hooks/usePopoverLayer";
import "./overlay.css";

export interface TooltipOptions {
  content: ReactNode;
  /** Shown trailing in secondary text ("Version History  ⌥⌘Y"). */
  shortcut?: ShortcutSpec | undefined;
  placement?: Placement | undefined;
  /**
   * true (default): the trigger is described by the tooltip text (aria-describedby on an always-present hidden
   * copy, so the description is there before the tooltip paints). false: visual only, for icon buttons whose
   * aria-label already says the same thing.
   */
  describe?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Hover delay in ms (700 in the spec). */
  delay?: number | undefined;
}

export interface TooltipTriggerProps {
  ref: (element: HTMLElement | null) => void;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  "aria-describedby"?: string | undefined;
}

// within 300 ms of one tooltip closing the next shows instantly, as on macOS
let lastHiddenAt = 0;

/** Tooltip behaviour for any trigger: 700 ms hover, immediate on keyboard focus, Escape and blur dismiss it. */
export function useTooltip(options: TooltipOptions): { triggerProps: TooltipTriggerProps; tooltip: ReactNode } {
  const id = useId();
  const mac = useIsMac();
  const latest = useLatest(options);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useLatest(open);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);

  const clearTimers = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    if (openRef.current) lastHiddenAt = Date.now();
    setOpen(false);
  }, [clearTimers, openRef]);

  const show = useCallback((immediate: boolean) => {
    clearTimers();
    const current = latest.current;
    if (current.disabled || current.content == null || current.content === "") return;
    if (immediate || Date.now() - lastHiddenAt < 300) setOpen(true);
    else showTimer.current = window.setTimeout(() => setOpen(true), current.delay ?? 700);
  }, [clearTimers, latest]);

  // WCAG 1.4.13: the pointer may travel onto the tooltip without it vanishing
  const scheduleHide = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(hide, 120);
  }, [hide]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, hide]);

  useEffect(() => {
    if (options.disabled && open) hide();
  }, [options.disabled, open, hide]);

  const layer = usePopoverLayer({
    open,
    reference: anchor,
    mode: "manual",
    placement: options.placement ?? "bottom",
    offset: 6,
  });

  const describe = options.describe ?? true;
  const shortcut = options.shortcut ? formatShortcut(options.shortcut, mac) : null;
  const descriptionId = `${id}-description`;

  const triggerProps: TooltipTriggerProps = {
    ref: setAnchor,
    onPointerEnter: (event) => {
      if (event.pointerType !== "touch") show(false);
    },
    onPointerLeave: scheduleHide,
    onPointerDown: hide,
    onFocus: (event) => {
      if (event.currentTarget.matches(":focus-visible")) show(true);
    },
    onBlur: hide,
    "aria-describedby": describe ? descriptionId : undefined,
  };

  const tooltip = (
    <>
      {describe ? (
        <span id={descriptionId} hidden>
          {options.content}
        </span>
      ) : null}
      {open ? (
        <div
          ref={layer.setFloating}
          popover="manual"
          className="px-tooltip"
          aria-hidden="true"
          data-placement={layer.placement}
          data-positioned={layer.isPositioned || undefined}
          style={layer.floatingStyles}
          onPointerEnter={() => window.clearTimeout(hideTimer.current)}
          onPointerLeave={scheduleHide}
        >
          <span className="px-tooltip__text">{options.content}</span>
          {shortcut ? <span className="px-tooltip__shortcut">{shortcut}</span> : null}
        </div>
      ) : null}
    </>
  );

  return { triggerProps, tooltip };
}

type TooltipChildProps = {
  ref?: Ref<HTMLElement> | undefined;
  onPointerEnter?: ((event: PointerEvent<HTMLElement>) => void) | undefined;
  onPointerLeave?: ((event: PointerEvent<HTMLElement>) => void) | undefined;
  onPointerDown?: ((event: PointerEvent<HTMLElement>) => void) | undefined;
  onFocus?: ((event: FocusEvent<HTMLElement>) => void) | undefined;
  onBlur?: ((event: FocusEvent<HTMLElement>) => void) | undefined;
  "aria-describedby"?: string | undefined;
};

export interface TooltipProps extends TooltipOptions {
  /** One focusable element (a button, a link, a truncated field). */
  children: ReactElement;
}

/** Wraps one focusable element: `<Tooltip content="Version History" shortcut="alt+mod+y"><button …/></Tooltip>`. */
export function Tooltip({ children, ...options }: TooltipProps) {
  const { triggerProps, tooltip } = useTooltip(options);
  const child = Children.only(children);
  const valid = isValidElement<TooltipChildProps>(child);
  const setRef = useMergedRefs(valid ? child.props.ref : undefined, triggerProps.ref);
  if (!valid) return child;
  const props = child.props;
  const describedBy = [props["aria-describedby"], triggerProps["aria-describedby"]].filter(Boolean).join(" ") || undefined;
  return (
    <>
      {cloneElement(child, {
        ref: setRef,
        onPointerEnter: composeHandlers(props.onPointerEnter, triggerProps.onPointerEnter),
        onPointerLeave: composeHandlers(props.onPointerLeave, triggerProps.onPointerLeave),
        onPointerDown: composeHandlers(props.onPointerDown, triggerProps.onPointerDown),
        onFocus: composeHandlers(props.onFocus, triggerProps.onFocus),
        onBlur: composeHandlers(props.onBlur, triggerProps.onBlur),
        "aria-describedby": describedBy,
      })}
      {tooltip}
    </>
  );
}
