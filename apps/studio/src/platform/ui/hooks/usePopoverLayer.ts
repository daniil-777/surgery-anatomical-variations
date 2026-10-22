import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  arrow,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
  type Middleware,
  type MiddlewareData,
  type Placement,
  type ReferenceType,
} from "@floating-ui/react-dom";
import { useLatest } from "./useLatest";

export interface PopoverLayerOptions {
  open: boolean;
  /** The anchor: an element, or a virtual point (context menus). */
  reference: ReferenceType | null;
  /** "auto" light-dismisses (Escape, outside click); "manual" stays until hidden (tooltips, toasts). */
  mode?: "auto" | "manual" | undefined;
  placement?: Placement | undefined;
  offset?: number | undefined;
  /** At least as wide as the anchor (pop-up buttons). */
  matchReferenceWidth?: boolean | undefined;
  arrowRef?: RefObject<HTMLElement | null> | undefined;
  /** The browser closed an auto popover (Escape, a click outside, another popover opening). */
  onDismiss?: (() => void) | undefined;
}

export interface PopoverLayer {
  /** Ref for the element carrying the popover attribute. */
  setFloating: (element: HTMLElement | null) => void;
  floatingStyles: CSSProperties;
  placement: Placement;
  middlewareData: MiddlewareData;
  isPositioned: boolean;
  floatingElement: HTMLElement | null;
}

function supportsPopover(element: HTMLElement): boolean {
  return typeof element.showPopover === "function";
}

function isOpenPopover(element: HTMLElement): boolean {
  try {
    return element.matches(":popover-open");
  } catch {
    return false;
  }
}

function showLayer(element: HTMLElement, source: Element | null): void {
  if (!supportsPopover(element) || isOpenPopover(element)) return;
  try {
    // the invoker relationship (Chrome 133+) keeps a click on the anchor from light-dismissing and reopening
    const show = element.showPopover as (options?: { source?: Element }) => void;
    show.call(element, source ? { source } : undefined);
  } catch {
    // already showing in another top-layer context or disconnected: nothing to do
  }
}

function hideLayer(element: HTMLElement): void {
  if (!supportsPopover(element) || !isOpenPopover(element)) return;
  try {
    element.hidePopover();
  } catch {
    // already hidden
  }
}

/**
 * Overlays live in the browser top layer (the popover attribute, §0.9) and are positioned by floating-ui with
 * offset/flip/shift; their height is capped to the space available. Render the floating element only while open
 * and give it popover={mode}: it is shown before floating-ui measures it, so the first frame is already in place.
 */
export function usePopoverLayer(options: PopoverLayerOptions): PopoverLayer {
  const { open, reference, mode = "auto", placement = "bottom-start" } = options;
  const latest = useLatest(options);
  const [floatingElement, setFloatingElement] = useState<HTMLElement | null>(null);
  const fallbackArrow = useRef<HTMLElement | null>(null);
  const arrowRef = options.arrowRef ?? fallbackArrow;

  const middleware: Middleware[] = [
    offset(options.offset ?? 6),
    flip({ padding: 8 }),
    shift({ padding: 8 }),
    size({
      padding: 8,
      apply({ availableHeight, rects, elements }) {
        // read through the ref: floating-ui keeps the first closure while the function source is unchanged
        elements.floating.style.maxHeight = `${Math.max(96, Math.floor(availableHeight))}px`;
        elements.floating.style.minWidth = latest.current.matchReferenceWidth ? `${Math.round(rects.reference.width)}px` : "";
      },
    }),
  ];
  if (options.arrowRef) middleware.push(arrow({ element: arrowRef, padding: 12 }));

  const floating = useFloating({
    open,
    placement,
    strategy: "fixed",
    transform: false,
    middleware,
    elements: { reference, floating: floatingElement },
    whileElementsMounted: autoUpdate,
  });

  const sourceElement = reference instanceof Element ? reference : null;
  const sourceRef = useLatest(sourceElement);

  const setFloating = useCallback((element: HTMLElement | null) => {
    // show during commit, before floating-ui's first measurement, so it never measures a display:none box
    if (element && latest.current.open) showLayer(element, sourceRef.current);
    setFloatingElement(element);
  }, [latest, sourceRef]);

  useLayoutEffect(() => {
    if (!floatingElement) return;
    if (open) showLayer(floatingElement, sourceElement);
    else hideLayer(floatingElement);
  }, [open, floatingElement, sourceElement]);

  useEffect(() => {
    if (!floatingElement || mode !== "auto") return undefined;
    const onToggle = (event: Event) => {
      const next = (event as Event & { newState?: string }).newState;
      if (next === "closed" && latest.current.open) latest.current.onDismiss?.();
    };
    floatingElement.addEventListener("toggle", onToggle);
    return () => floatingElement.removeEventListener("toggle", onToggle);
  }, [floatingElement, mode, latest]);

  return {
    setFloating,
    floatingStyles: floating.floatingStyles,
    placement: floating.placement,
    middlewareData: floating.middlewareData,
    isPositioned: floating.isPositioned,
    floatingElement,
  };
}

/** A zero-size anchor at a viewport point (context menus open at the pointer). */
export function pointReference(x: number, y: number): ReferenceType {
  return {
    getBoundingClientRect: () => ({ x, y, width: 0, height: 0, top: y, left: x, right: x, bottom: y }),
  };
}
