import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ArrowBigUp, CircleAlert, Eye, EyeOff, Search, X, type LucideIcon } from "lucide-react";
import { cx } from "../lib/dom";
import type { ShortcutSpec } from "../lib/shortcuts";
import { useLatest, useMergedRefs } from "../hooks/useLatest";
import { useShortcuts } from "../hooks/useShortcuts";
import { IconButton } from "./Button";
import { Icon } from "./Icon";
import { useTooltip } from "./Tooltip";
import "./fields.css";

/** regular 24 (inspector) · large 28 (sheets, popovers) · auth 40 (sign-in) — §2.7. */
export type FieldSize = "regular" | "large" | "auth";

interface FieldFrameProps {
  id: string;
  label: ReactNode;
  hideLabel: boolean;
  labelAccessory: ReactNode;
  hint: ReactNode;
  error: ReactNode;
  size: FieldSize;
  multiline?: boolean;
  className: string | undefined;
  children: ReactNode;
}

function messageIds(id: string, hint: ReactNode, error: ReactNode) {
  return { hintId: hint && !error ? `${id}-hint` : undefined, errorId: error ? `${id}-error` : undefined };
}

function FieldFrame({ id, label, hideLabel, labelAccessory, hint, error, size, multiline = false, className, children }: FieldFrameProps) {
  const { hintId, errorId } = messageIds(id, hint, error);
  return (
    <div className={cx("px-field", `px-field--${size}`, multiline && "px-field--multiline", error ? "px-field--invalid" : null, className)}>
      <div className={cx("px-field__label-row", hideLabel && "px-visually-hidden")}>
        <label htmlFor={id} className="px-field__label">
          {label}
        </label>
        {labelAccessory}
      </div>
      {children}
      {error ? (
        <p id={errorId} className="px-field__message px-field__message--error">
          <Icon icon={CircleAlert} size={12} />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={hintId} className="px-field__message">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<ComponentPropsWithRef<"input">, "size"> {
  /** Always visible above the field (placeholders are examples, never labels — HIG). */
  label: ReactNode;
  /** Keeps the label for assistive technology only (e.g. a field whose purpose a heading already states). */
  hideLabel?: boolean | undefined;
  hint?: ReactNode;
  /** Shown below with an icon; sets aria-invalid and aria-describedby. */
  error?: ReactNode;
  leadingIcon?: LucideIcon | undefined;
  /** Accessories inside the field, after the text (buttons, indicators). */
  trailing?: ReactNode;
  /** Trailing on the label row ("Forgot Password?"). */
  labelAccessory?: ReactNode;
  size?: FieldSize | undefined;
  containerClassName?: string | undefined;
}

export function TextField({
  label,
  hideLabel = false,
  hint,
  error,
  leadingIcon,
  trailing,
  labelAccessory,
  size = "large",
  containerClassName,
  className,
  id,
  type = "text",
  "aria-describedby": describedBy,
  ...rest
}: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const { hintId, errorId } = messageIds(inputId, hint, error);
  return (
    <FieldFrame
      id={inputId}
      label={label}
      hideLabel={hideLabel}
      labelAccessory={labelAccessory}
      hint={hint}
      error={error}
      size={size}
      className={containerClassName}
    >
      <div className="px-field__control">
        {leadingIcon ? <Icon icon={leadingIcon} size={size === "auth" ? 16 : 14} className="px-field__leading" /> : null}
        <input
          id={inputId}
          type={type}
          className={cx("px-field__input", className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={[describedBy, errorId, hintId].filter(Boolean).join(" ") || undefined}
          {...rest}
        />
        {trailing}
      </div>
    </FieldFrame>
  );
}

export interface TextAreaProps extends ComponentPropsWithRef<"textarea"> {
  label: ReactNode;
  hideLabel?: boolean | undefined;
  hint?: ReactNode;
  error?: ReactNode;
  containerClassName?: string | undefined;
}

/** Multi-line text: at least three lines tall, vertical resize only (§2.7). */
export function TextArea({ label, hideLabel = false, hint, error, containerClassName, className, id, "aria-describedby": describedBy, rows = 3, ...rest }: TextAreaProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const { hintId, errorId } = messageIds(inputId, hint, error);
  return (
    <FieldFrame
      id={inputId}
      label={label}
      hideLabel={hideLabel}
      labelAccessory={null}
      hint={hint}
      error={error}
      size="large"
      multiline
      className={containerClassName}
    >
      <div className="px-field__control">
        <textarea
          id={inputId}
          rows={rows}
          className={cx("px-field__input px-field__textarea", className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={[describedBy, errorId, hintId].filter(Boolean).join(" ") || undefined}
          {...rest}
        />
      </div>
    </FieldFrame>
  );
}

function CapsLockIndicator() {
  const { triggerProps, tooltip } = useTooltip({ content: "Caps Lock is on", describe: false });
  return (
    <>
      <span
        ref={triggerProps.ref}
        className="px-field__caps"
        onPointerEnter={triggerProps.onPointerEnter}
        onPointerLeave={triggerProps.onPointerLeave}
      >
        <Icon icon={ArrowBigUp} size={14} />
      </span>
      {tooltip}
    </>
  );
}

export interface SecureFieldProps extends Omit<TextFieldProps, "type" | "trailing"> {
  /** The eye button that shows the password as text (default on). */
  revealable?: boolean | undefined;
}

/** Password entry with Show/Hide and a Caps Lock indicator (§2.7). */
export function SecureField({ revealable = true, onKeyDown, onKeyUp, onBlur, ...props }: SecureFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const readCapsLock = (event: KeyboardEvent<HTMLInputElement>) => {
    if (typeof event.getModifierState === "function") setCapsLock(event.getModifierState("CapsLock"));
  };
  return (
    <TextField
      {...props}
      type={revealed ? "text" : "password"}
      autoCapitalize="off"
      spellCheck={false}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        readCapsLock(event);
      }}
      onKeyUp={(event) => {
        onKeyUp?.(event);
        readCapsLock(event);
      }}
      onBlur={(event) => {
        onBlur?.(event);
        setCapsLock(false);
      }}
      trailing={
        <>
          {capsLock ? <CapsLockIndicator /> : null}
          <span className="px-visually-hidden" aria-live="polite">
            {capsLock ? "Caps Lock is on" : ""}
          </span>
          {revealable ? (
            <IconButton
              icon={revealed ? EyeOff : Eye}
              label={revealed ? "Hide Password" : "Show Password"}
              size={props.size === "auth" ? "regular" : "small"}
              className="px-field__reveal"
              onClick={() => setRevealed((value) => !value)}
            />
          ) : null}
        </>
      }
    />
  );
}

export interface SearchFieldProps
  extends Omit<ComponentPropsWithRef<"input">, "size" | "onChange" | "value" | "defaultValue" | "type"> {
  /** Accessible name; also the default placeholder ("Search Library" names the scope — §2.5). */
  label: string;
  value?: string | undefined;
  defaultValue?: string | undefined;
  /** Every keystroke. */
  onChange?: ((value: string) => void) | undefined;
  /** Search-as-you-type, debounced 150 ms; also fires immediately on Return and on clear. */
  onSearch?: ((value: string) => void) | undefined;
  /** "toolbar": 36 px glass capsule; "content": 24 px filled field for inspectors and lists. */
  variant?: "toolbar" | "content" | undefined;
  /** Focuses and selects the field ("mod+f" on pages with a search scope). Off by default. */
  focusShortcut?: ShortcutSpec | undefined;
  containerClassName?: string | undefined;
}

export function SearchField({
  label,
  value,
  defaultValue = "",
  onChange,
  onSearch,
  variant = "content",
  focusShortcut,
  placeholder,
  containerClassName,
  className,
  ref,
  onKeyDown,
  ...rest
}: SearchFieldProps) {
  const [internal, setInternal] = useState(defaultValue);
  const text = value ?? internal;
  const input = useRef<HTMLInputElement | null>(null);
  const setRef = useMergedRefs(ref, input);
  const latestSearch = useLatest(onSearch);
  // the initial value is not a search the user typed
  const skipDebounce = useRef(true);

  useEffect(() => {
    if (skipDebounce.current) {
      skipDebounce.current = false;
      return undefined;
    }
    const timer = window.setTimeout(() => latestSearch.current?.(text), 150);
    return () => window.clearTimeout(timer);
  }, [text, latestSearch]);

  useShortcuts(
    focusShortcut
      ? [{ keys: focusShortcut, handler: () => { input.current?.focus(); input.current?.select(); } }]
      : [],
    { enabled: focusShortcut !== undefined },
  );

  const update = (next: string, immediate: boolean) => {
    if (value === undefined) setInternal(next);
    onChange?.(next);
    if (immediate) {
      skipDebounce.current = true;
      latestSearch.current?.(next);
    }
  };

  return (
    <div className={cx("px-search", `px-search--${variant}`, containerClassName)}>
      <Icon icon={Search} size={variant === "toolbar" ? 15 : 13} className="px-search__icon" />
      <input
        ref={setRef}
        type="search"
        className={cx("px-search__input", className)}
        aria-label={label}
        placeholder={placeholder ?? label}
        value={text}
        autoComplete="off"
        spellCheck={false}
        onChange={(event: ChangeEvent<HTMLInputElement>) => update(event.target.value, false)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Escape") {
            // the first Escape clears, the second leaves the field (§2.5)
            event.preventDefault();
            if (text !== "") update("", true);
            else event.currentTarget.blur();
          } else if (event.key === "Enter") {
            skipDebounce.current = true;
            latestSearch.current?.(text);
          }
        }}
        {...rest}
      />
      {text !== "" ? (
        <button
          type="button"
          className="px-search__clear"
          aria-label="Clear Search"
          tabIndex={-1}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            update("", true);
            input.current?.focus();
          }}
        >
          <Icon icon={X} size={9} strokeWidth={2.5} />
        </button>
      ) : null}
    </div>
  );
}

export interface FormGroupProps {
  title?: ReactNode;
  /** Footnote under the box (retention notes, explanations). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}

/** A grouped box of rows, as in macOS Settings sheets (§2.11). */
export function FormGroup({ title, footer, children, className }: FormGroupProps) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={title ? titleId : undefined} className={cx("px-form-group", className)}>
      {title ? (
        <h3 id={titleId} className="px-form-group__title">
          {title}
        </h3>
      ) : null}
      <div className="px-form-group__box">{children}</div>
      {footer ? <p className="px-form-group__footer">{footer}</p> : null}
    </div>
  );
}

export interface FormRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** The id of the control, so the label clicks through to it. */
  htmlFor?: string | undefined;
  children?: ReactNode;
  className?: string | undefined;
}

/** One 36 px row: label leading, value or control trailing. */
export function FormRow({ label, description, htmlFor, children, className }: FormRowProps) {
  return (
    <div className={cx("px-form-row", className)}>
      <div className="px-form-row__text">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="px-form-row__label">
            {label}
          </label>
        ) : (
          <span className="px-form-row__label">{label}</span>
        )}
        {description ? <span className="px-form-row__description">{description}</span> : null}
      </div>
      {children != null ? <div className="px-form-row__control">{children}</div> : null}
    </div>
  );
}
