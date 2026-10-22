import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { Placement, ReferenceType } from "@floating-ui/react-dom";
import { cx, focusableWithin, lastInputWasKeyboard } from "../lib/dom";
import { usePopoverLayer } from "../hooks/usePopoverLayer";
import { useLatest } from "../hooks/useLatest";
import "./overlay.css";

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control the popover points at (focus returns there on Escape). */
  anchor: ReferenceType | null;
  placement?: Placement | undefined;
  /** The 16×8 pointer in the same material (default on). */
  arrow?: boolean | undefined;
  /** Headline title; also names the popover. Without one, pass aria-label. */
  title?: ReactNode;
  "aria-label"?: string | undefined;
  /** Optional trailing actions (HIG: no explicit Cancel unless it discards). */
  footer?: ReactNode;
  width?: number | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * A non-modal, light-dismissing panel (popover="auto"): Escape and outside clicks close it, Tab out of it closes it,
 * focus moves inside only when it was opened from the keyboard (§4.2). Edits inside apply as they happen.
 */
export function Popover({ open, onOpenChange, anchor, placement = "bottom", arrow = true, title, footer, width, className, children, ...aria }: PopoverProps) {
  const titleId = useId();
  const arrowRef = useRef<HTMLDivElement | null>(null);
  const latest = useLatest({ onOpenChange, anchor });
  const layer = usePopoverLayer({
    open,
    reference: anchor,
    mode: "auto",
    placement,
    offset: arrow ? 12 : 6,
    arrowRef: arrow ? arrowRef : undefined,
    onDismiss: () => {
      const element = layer.floatingElement;
      // Escape inside: give focus back to the anchor; an outside click has already moved focus where it belongs
      if (element?.contains(document.activeElement) && latest.current.anchor instanceof HTMLElement) latest.current.anchor.focus();
      latest.current.onOpenChange(false);
    },
  });

  useLayoutEffect(() => {
    const element = layer.floatingElement;
    if (!open || !element || !lastInputWasKeyboard()) return;
    (focusableWithin(element)[0] ?? element).focus({ preventScroll: true });
  }, [open, layer.floatingElement]);

  useEffect(() => {
    const element = layer.floatingElement;
    if (!open || !element) return undefined;
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      const anchorElement = latest.current.anchor instanceof HTMLElement ? latest.current.anchor : null;
      if (next instanceof Node && !element.contains(next) && next !== anchorElement) latest.current.onOpenChange(false);
    };
    element.addEventListener("focusout", onFocusOut);
    return () => element.removeEventListener("focusout", onFocusOut);
  }, [open, layer.floatingElement, latest]);

  if (!open) return null;
  const arrowData = layer.middlewareData.arrow;
  const arrowStyle: CSSProperties = {};
  if (arrowData?.x != null) arrowStyle.left = arrowData.x;
  if (arrowData?.y != null) arrowStyle.top = arrowData.y;
  return (
    <div
      ref={layer.setFloating}
      popover="auto"
      role="dialog"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : aria["aria-label"]}
      tabIndex={-1}
      className={cx("px-popover", className)}
      data-placement={layer.placement}
      data-positioned={layer.isPositioned || undefined}
      style={{ ...layer.floatingStyles, width }}
    >
      {arrow ? <div ref={arrowRef} className="px-popover__arrow" style={arrowStyle} aria-hidden="true" /> : null}
      <div className="px-popover__scroll">
        {title ? (
          <div className="px-popover__header">
            <h2 id={titleId} className="px-popover__title">{title}</h2>
          </div>
        ) : null}
        <div className="px-popover__body">{children}</div>
        {footer ? <div className="px-popover__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
