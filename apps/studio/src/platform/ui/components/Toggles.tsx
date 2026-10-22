import { useLayoutEffect, useRef, type ComponentPropsWithRef, type ReactNode } from "react";
import { cx } from "../lib/dom";
import { useMergedRefs } from "../hooks/useLatest";
import "./toggles.css";

export interface CheckboxProps extends Omit<ComponentPropsWithRef<"input">, "type" | "size"> {
  /** Trailing label (HIG); the whole row is the click target. */
  label?: ReactNode;
  description?: ReactNode;
  /** Mixed state for a parent whose children differ. */
  indeterminate?: boolean | undefined;
}

/** A native checkbox drawn as the macOS 14 px box: keyboard, forms and the mixed state come for free. */
export function Checkbox({ label, description, indeterminate = false, className, ref, ...rest }: CheckboxProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const setRef = useMergedRefs(ref, input);
  useLayoutEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className={cx("px-checkbox", className)}>
      <input ref={setRef} type="checkbox" className="px-checkbox__input" {...rest} />
      {label != null ? (
        <span className="px-checkbox__text">
          <span className="px-checkbox__label">{label}</span>
          {description ? <span className="px-checkbox__description">{description}</span> : null}
        </span>
      ) : null}
    </label>
  );
}

export interface SwitchProps extends Omit<ComponentPropsWithRef<"input">, "type" | "size" | "role"> {
  label?: ReactNode;
  description?: ReactNode;
  /** regular 38×22 · small 30×18 · mini 26×15 (§2.8). */
  size?: "regular" | "small" | "mini" | undefined;
  /** macOS settings rows put the label first (default); "trailing" puts it after the switch. */
  labelPosition?: "leading" | "trailing" | undefined;
}

/**
 * role="switch" on a native checkbox (Space toggles, forms work). macOS uses switches only for emphasized or group
 * settings, never in toolbars.
 */
export function Switch({ label, description, size = "regular", labelPosition = "leading", className, ...rest }: SwitchProps) {
  const text = label != null ? (
    <span className="px-switch__text">
      <span className="px-switch__label">{label}</span>
      {description ? <span className="px-switch__description">{description}</span> : null}
    </span>
  ) : null;
  return (
    <label className={cx("px-switch", `px-switch--${size}`, labelPosition === "trailing" && "px-switch--trailing-label", className)}>
      {labelPosition === "leading" ? text : null}
      <span className="px-switch__control">
        <input type="checkbox" role="switch" className="px-switch__input" {...rest} />
        <span className="px-switch__track" aria-hidden="true">
          <span className="px-switch__knob" />
        </span>
      </span>
      {labelPosition === "trailing" ? text : null}
    </label>
  );
}
