import { useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type MouseEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Placement } from "@floating-ui/react-dom";
import { cx } from "../lib/dom";
import { useMergedRefs } from "../hooks/useLatest";
import { ariaKeyShortcut, parseShortcut, type ShortcutSpec } from "../lib/shortcuts";
import { useIsMac } from "../hooks/usePlatform";
import { Icon } from "./Icon";
import { Spinner } from "./Progress";
import { useTooltip } from "./Tooltip";
import "./button.css";

export type ButtonVariant = "plain" | "bordered" | "borderedProminent" | "destructive" | "destructiveProminent" | "glass";
/** small 20 · regular 24 · large 28 (capsule) · xlarge 36 (capsule) · toolbar 36 (toolbar text/prominent items) · auth 40. */
export type ButtonSize = "small" | "regular" | "large" | "xlarge" | "toolbar" | "auth";

const ICON_SIZE: Record<ButtonSize, number> = { small: 12, regular: 14, large: 15, xlarge: 17, toolbar: 16, auth: 17 };

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Leading glyph; replaced by the spinner while loading. */
  icon?: LucideIcon | undefined;
  trailingIcon?: LucideIcon | undefined;
  /** Busy: spinner, progressive label, width locked so nothing shifts, clicks ignored (§2.6). */
  loading?: boolean | undefined;
  /** The progressive form shown while loading ("Saving…", "Signing In…"). */
  loadingLabel?: ReactNode;
  fullWidth?: boolean | undefined;
}

export function Button({
  variant = "bordered",
  size = "regular",
  icon,
  trailingIcon,
  loading = false,
  loadingLabel,
  fullWidth = false,
  className,
  children,
  type = "button",
  style,
  onClick,
  ref,
  "aria-disabled": ariaDisabled,
  ...rest
}: ButtonProps) {
  const element = useRef<HTMLButtonElement | null>(null);
  const setRef = useMergedRefs(ref, element);
  const restWidth = useRef(0);
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);

  // measure at rest; when loading starts, lock min-width to that width before the frame paints
  useLayoutEffect(() => {
    if (!loading) {
      if (element.current) restWidth.current = element.current.offsetWidth;
      if (lockedWidth !== null) setLockedWidth(null);
    } else if (lockedWidth === null && restWidth.current > 0) {
      setLockedWidth(restWidth.current);
    }
  });

  const disabled = ariaDisabled === true || ariaDisabled === "true" || loading;
  const iconSize = ICON_SIZE[size];
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <button
      ref={setRef}
      type={type}
      className={cx(
        "px-btn",
        `px-btn--${variant}`,
        `px-btn--${size}`,
        fullWidth && "px-btn--full",
        className,
      )}
      style={lockedWidth !== null ? { ...style, minWidth: lockedWidth } : style}
      aria-disabled={disabled ? true : undefined}
      aria-busy={loading ? true : undefined}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : icon ? <Icon icon={icon} size={iconSize} /> : null}
      {children != null || loadingLabel != null ? (
        <span className="px-btn__label">{loading && loadingLabel != null ? loadingLabel : children}</span>
      ) : null}
      {trailingIcon ? <Icon icon={trailingIcon} size={Math.round(iconSize * 0.75)} className="px-btn__trailing" /> : null}
    </button>
  );
}

export type IconButtonVariant = "plain" | "bordered" | "glass" | "toolbar";
/** small 20 · regular 24 · large 28 · toolbar 36 (inside a toolbar group). */
export type IconButtonSize = "small" | "regular" | "large" | "toolbar";

const ICON_BUTTON_GLYPH: Record<IconButtonSize, number> = { small: 12, regular: 16, large: 16, toolbar: 17 };

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  icon: LucideIcon;
  /** Accessible name and tooltip text (Title Case: "Version History"). */
  label: string;
  variant?: IconButtonVariant | undefined;
  size?: IconButtonSize | undefined;
  /** Toggle state: aria-pressed, accent glyph with a persistent pill. */
  pressed?: boolean | undefined;
  /** Shown in the tooltip and exposed as aria-keyshortcuts. */
  shortcut?: ShortcutSpec | undefined;
  /** Every icon-only control shows its name in a tooltip (§2.3); false only where a visible label sits next to it. */
  tooltip?: boolean | undefined;
  tooltipPlacement?: Placement | undefined;
  /** Glyph colour override (e.g. --px-system-red for Record). */
  tint?: string | undefined;
}

export function IconButton({
  icon,
  label,
  variant = "plain",
  size = "regular",
  pressed,
  shortcut,
  tooltip = true,
  tooltipPlacement,
  tint,
  className,
  type = "button",
  ref,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onFocus,
  onBlur,
  onClick,
  style,
  "aria-disabled": ariaDisabled,
  ...rest
}: IconButtonProps) {
  const mac = useIsMac();
  const { triggerProps, tooltip: tooltipNode } = useTooltip({
    content: label,
    shortcut,
    placement: tooltipPlacement,
    describe: false,
    disabled: !tooltip,
  });
  const disabled = ariaDisabled === true || ariaDisabled === "true";
  const setRef = useMergedRefs(ref, triggerProps.ref);
  return (
    <>
      <button
        ref={setRef}
        type={type}
        className={cx("px-icon-btn", `px-icon-btn--${variant}`, `px-icon-btn--${size}`, className)}
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut ? ariaKeyShortcut(parseShortcut(shortcut, mac)) : undefined}
        aria-disabled={disabled ? true : undefined}
        style={tint ? { ...style, color: tint } : style}
        onPointerEnter={(event) => {
          onPointerEnter?.(event);
          triggerProps.onPointerEnter(event);
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          triggerProps.onPointerLeave(event);
        }}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          triggerProps.onPointerDown(event);
        }}
        onFocus={(event) => {
          onFocus?.(event);
          triggerProps.onFocus(event);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          triggerProps.onBlur(event);
        }}
        onClick={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        {...rest}
      >
        <Icon icon={icon} size={ICON_BUTTON_GLYPH[size]} />
      </button>
      {tooltipNode}
    </>
  );
}
