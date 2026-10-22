import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Check, ChevronDown, ChevronsUpDown, type LucideIcon } from "lucide-react";
import type { Placement, ReferenceType } from "@floating-ui/react-dom";
import { cx } from "../lib/dom";
import { rovingTargetIndex, typeaheadIndex } from "../lib/roving";
import { ariaKeyShortcut, formatShortcut, parseShortcut, type ShortcutSpec } from "../lib/shortcuts";
import { useLatest, useMergedRefs } from "../hooks/useLatest";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import { useIsMac } from "../hooks/usePlatform";
import { pointReference, usePopoverLayer } from "../hooks/usePopoverLayer";
import { Button, type ButtonProps, type ButtonSize } from "./Button";
import { Icon } from "./Icon";
import "./menu.css";

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

function enabledItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
    (item) => item.getAttribute("aria-disabled") !== "true" && item.closest('[role="menu"]') === menu,
  );
}

interface MenuContextValue {
  /** Closes the menu; focus returns to the anchor when it was inside the menu. */
  close: () => void;
  reducedMotion: boolean;
  isStatic: boolean;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export interface MenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An element or a virtual point (context menus). */
  anchor: ReferenceType | null;
  placement?: Placement | undefined;
  /**
   * Where focus lands on open: "first" item (opened from the keyboard), the "checked" item (pop-up buttons), or the
   * "menu" itself (opened by pointer: nothing highlighted, ↓ starts at the top, as on macOS).
   */
  initialFocus?: "first" | "checked" | "menu" | undefined;
  /** Focus goes back here when the menu closes from inside; defaults to the anchor element. */
  returnFocusTo?: HTMLElement | null | undefined;
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
  /** At least as wide as the anchor (pop-up buttons). */
  matchAnchorWidth?: boolean | undefined;
  /** Gallery/documentation: render inline without the popover (no positioning, choices do not close it). */
  static?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * role="menu" in the top layer (popover="auto"): ↑/↓ wrap, Home/End, type-ahead within 500 ms, Return/Space choose,
 * Escape and Tab close and return focus to the anchor, outside clicks dismiss. Chosen items flash before closing.
 */
export function Menu({
  open,
  onOpenChange,
  anchor,
  placement = "bottom-start",
  initialFocus = "first",
  returnFocusTo,
  matchAnchorWidth = false,
  static: isStatic = false,
  id,
  className,
  children,
  ...aria
}: MenuProps) {
  const reducedMotion = usePrefersReducedMotion();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const latest = useLatest({ onOpenChange, anchor, returnFocusTo });

  const close = useCallback(() => {
    const menu = menuRef.current;
    if (menu?.contains(document.activeElement)) {
      const { returnFocusTo: target, anchor: reference } = latest.current;
      const element = target ?? (reference instanceof HTMLElement ? reference : null);
      element?.focus({ preventScroll: true });
    }
    latest.current.onOpenChange(false);
  }, [latest]);

  const layer = usePopoverLayer({
    open: open && !isStatic,
    reference: anchor,
    mode: "auto",
    placement,
    offset: 4,
    matchReferenceWidth: matchAnchorWidth,
    onDismiss: close,
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (isStatic || !open || !menu) return;
    const items = enabledItems(menu);
    const target = initialFocus === "checked"
      ? items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0]
      : initialFocus === "first" ? items[0] : undefined;
    (target ?? menu).focus({ preventScroll: true });
    // the floating element identity changes when the menu remounts; focus once per open
  }, [open, isStatic, layer.floatingElement, initialFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = event.currentTarget;
    const items = enabledItems(menu);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const target = rovingTargetIndex(event.key, current, items.length, { orientation: "vertical", loop: true });
      if (target !== null && target >= 0) items[target]?.focus({ preventScroll: true });
      return;
    }
    if (isStatic) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const state = typeahead.current;
      state.text = now - state.at > 500 ? event.key : state.text + event.key;
      state.at = now;
      const labels = items.map((item) => item.querySelector(".px-menu-item__label")?.textContent ?? item.textContent ?? "");
      const index = typeaheadIndex(labels, state.text, current);
      if (index >= 0) items[index]?.focus({ preventScroll: true });
      event.preventDefault();
    }
  };

  // leaving the menu clears the highlight (macOS); keyboard focus stays inside on the menu itself
  const setMenuRef = useMergedRefs(menuRef, isStatic ? undefined : layer.setFloating);

  const onPointerLeave = () => {
    const menu = menuRef.current;
    if (menu && menu !== document.activeElement && menu.contains(document.activeElement)) menu.focus({ preventScroll: true });
  };

  if (!open && !isStatic) return null;
  return (
    <MenuContext.Provider value={{ close, reducedMotion, isStatic }}>
      <div
        ref={setMenuRef}
        id={id}
        role="menu"
        aria-orientation="vertical"
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        tabIndex={isStatic ? 0 : -1}
        popover={isStatic ? undefined : "auto"}
        className={cx("px-menu", isStatic && "px-menu--static", className)}
        data-placement={isStatic ? undefined : layer.placement}
        data-positioned={isStatic || layer.isPositioned || undefined}
        style={isStatic ? undefined : layer.floatingStyles}
        onKeyDown={onKeyDown}
        onPointerLeave={onPointerLeave}
      >
        {children}
      </div>
    </MenuContext.Provider>
  );
}

export interface MenuItemProps extends Omit<ComponentPropsWithRef<"button">, "onSelect" | "type" | "role" | "children"> {
  children: ReactNode;
  icon?: LucideIcon | undefined;
  /** Right-aligned in secondary text, symbols in ⌃⌥⇧⌘ order. */
  shortcut?: ShortcutSpec | undefined;
  /** Makes the item a menuitemcheckbox (or menuitemradio with type="radio") with a leading check. */
  checked?: boolean | undefined;
  type?: "checkbox" | "radio" | undefined;
  destructive?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Toggles that should not close the menu. */
  keepOpen?: boolean | undefined;
  onSelect?: (() => void) | undefined;
}

export function MenuItem({
  children,
  icon,
  shortcut,
  checked,
  type = "checkbox",
  destructive = false,
  disabled = false,
  keepOpen = false,
  onSelect,
  className,
  onClick,
  onPointerMove,
  ...rest
}: MenuItemProps) {
  const context = useContext(MenuContext);
  const mac = useIsMac();
  const [flashing, setFlashing] = useState(false);
  const busy = useRef(false);
  const role = checked === undefined ? "menuitem" : type === "radio" ? "menuitemradio" : "menuitemcheckbox";

  const activate = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (disabled || busy.current || event.defaultPrevented) return;
    if (keepOpen || !context || context.isStatic) {
      onSelect?.();
      return;
    }
    if (context.reducedMotion) {
      context.close();
      onSelect?.();
      return;
    }
    // macOS confirms a choice with a quick blink of the highlight before the menu closes
    busy.current = true;
    setFlashing(true);
    window.setTimeout(() => {
      context.close();
      onSelect?.();
    }, 120);
  };

  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      aria-checked={checked === undefined ? undefined : checked}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={shortcut ? ariaKeyShortcut(parseShortcut(shortcut, mac)) : undefined}
      className={cx("px-menu-item", destructive && "px-menu-item--destructive", className)}
      data-flash={flashing || undefined}
      onClick={activate}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (!disabled && document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
      }}
      {...rest}
    >
      <span className="px-menu-item__lead" aria-hidden="true">
        {checked ? <Icon icon={Check} size={12} strokeWidth={2.25} /> : icon ? <Icon icon={icon} size={16} /> : null}
      </span>
      <span className="px-menu-item__label">{children}</span>
      {shortcut ? (
        <span className="px-menu-item__shortcut" aria-hidden="true">
          {formatShortcut(shortcut, mac)}
        </span>
      ) : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="px-menu-separator" />;
}

export interface MenuSectionProps {
  title: ReactNode;
  children: ReactNode;
}

/** A titled group of items (Subheadline emphasized, secondary). */
export function MenuSection({ title, children }: MenuSectionProps) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId} className="px-menu-section">
      <div id={titleId} className="px-menu-section__title">
        {title}
      </div>
      {children}
    </div>
  );
}

/** Non-interactive heading block at the top of a menu (the account menu's name and email). */
export function MenuHeader({ children }: { children: ReactNode }) {
  return (
    <div role="none" className="px-menu-header">
      {children}
    </div>
  );
}

export interface MenuButtonProps extends Omit<ButtonProps, "onClick" | "trailingIcon"> {
  /** MenuItem, MenuSection and MenuSeparator elements. */
  menu: ReactNode;
  placement?: Placement | undefined;
  /** Pull-down chevron after the label (default on; off for icon-like buttons). */
  chevron?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}

/** A pull-down button ("New Project ▾"): ↓, Return or Space open it with the first item highlighted. */
export function MenuButton({ menu, placement = "bottom-start", chevron = true, onOpenChange, id, ref, onKeyDown, ...buttonProps }: MenuButtonProps) {
  const generated = useId();
  const buttonId = id ?? `${generated}-button`;
  const menuId = `${generated}-menu`;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [initialFocus, setInitialFocus] = useState<"first" | "menu">("first");
  const dismissedAt = useRef(0);
  const setButtonRef = useMergedRefs(ref, setAnchor);

  const change = (next: boolean) => {
    if (!next) dismissedAt.current = Date.now();
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <>
      <Button
        {...buttonProps}
        id={buttonId}
        ref={setButtonRef}
        trailingIcon={chevron ? ChevronDown : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          // a click on the anchor that just light-dismissed the menu must not reopen it
          if (!open && Date.now() - dismissedAt.current < 250) return;
          setInitialFocus(event.detail === 0 ? "first" : "menu");
          change(!open);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setInitialFocus("first");
            change(true);
          }
        }}
      />
      <Menu id={menuId} open={open} onOpenChange={change} anchor={anchor} placement={placement} initialFocus={initialFocus} aria-labelledby={buttonId}>
        {menu}
      </Menu>
    </>
  );
}

export interface ContextMenuProps {
  /** MenuItem, MenuSection and MenuSeparator elements. */
  menu: ReactNode;
  children: ReactNode;
  "aria-label"?: string | undefined;
  disabled?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}

interface ContextState {
  reference: ReferenceType;
  returnTo: HTMLElement | null;
  keyboard: boolean;
}

/** Right-click, Shift+F10 or the context-menu key open `menu` at the pointer (or under the focused element). */
export function ContextMenu({ menu, children, disabled = false, onOpenChange, ...aria }: ContextMenuProps) {
  const [state, setState] = useState<ContextState | null>(null);
  const openedAt = useRef(0);
  const keyboardPending = useRef(false);

  const show = (next: ContextState) => {
    // the menu key fires both keydown and contextmenu in some browsers: one menu per gesture
    if (Date.now() - openedAt.current < 150) return;
    openedAt.current = Date.now();
    setState(next);
    onOpenChange?.(true);
  };

  const focusTarget = (target: EventTarget | null): HTMLElement | null => {
    const element = target instanceof HTMLElement ? target : null;
    return element?.closest<HTMLElement>("[tabindex], button, a[href], input, select, textarea") ?? element;
  };

  const atElement = (element: HTMLElement): ContextState => {
    const rect = element.getBoundingClientRect();
    return { reference: pointReference(rect.left + Math.min(16, rect.width / 2), rect.bottom), returnTo: element, keyboard: true };
  };

  return (
    <div
      className="px-context-target"
      onContextMenu={(event) => {
        if (disabled) return;
        event.preventDefault();
        const element = focusTarget(event.target);
        if (keyboardPending.current && element) {
          keyboardPending.current = false;
          show(atElement(element));
          return;
        }
        show({ reference: pointReference(event.clientX, event.clientY), returnTo: element, keyboard: false });
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
          const element = focusTarget(event.target);
          if (!element) return;
          event.preventDefault();
          keyboardPending.current = true;
          show(atElement(element));
        }
      }}
    >
      {children}
      <Menu
        open={state !== null}
        onOpenChange={(next) => {
          if (next) return;
          keyboardPending.current = false;
          setState(null);
          onOpenChange?.(false);
        }}
        anchor={state?.reference ?? null}
        returnFocusTo={state?.returnTo ?? null}
        initialFocus={state?.keyboard ? "first" : "menu"}
        placement="bottom-start"
        aria-label={aria["aria-label"] ?? "Actions"}
      >
        {menu}
      </Menu>
    </div>
  );
}

export interface PopUpOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon | undefined;
  disabled?: boolean | undefined;
}

export interface PopUpButtonProps<T extends string> {
  options: ReadonlyArray<PopUpOption<T> | "separator">;
  value: T;
  onChange: (value: T) => void;
  /** What the control chooses ("Sort By"); read before the current value. */
  label: string;
  variant?: "bordered" | "glass" | undefined;
  size?: Extract<ButtonSize, "small" | "regular" | "large" | "toolbar"> | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

/**
 * The custom pop-up (§2.8): use it when options need icons or sections; prefer <Select> (the native menu) in forms.
 * Its menu opens with the current choice highlighted.
 */
export function PopUpButton<T extends string>({ options, value, onChange, label, variant = "bordered", size = "regular", disabled = false, className }: PopUpButtonProps<T>) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const dismissedAt = useRef(0);
  const current = options.find((option): option is PopUpOption<T> => option !== "separator" && option.value === value);
  const change = (next: boolean) => {
    if (!next) dismissedAt.current = Date.now();
    setOpen(next);
  };
  return (
    <>
      <Button
        ref={setAnchor}
        variant={variant}
        size={size}
        className={cx("px-popup", className)}
        icon={current?.icon}
        trailingIcon={ChevronsUpDown}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${label}, ${current?.label ?? "None"}`}
        onClick={() => {
          if (!open && Date.now() - dismissedAt.current < 250) return;
          change(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            change(true);
          }
        }}
      >
        {current?.label ?? "None"}
      </Button>
      <Menu id={menuId} open={open} onOpenChange={change} anchor={anchor} placement="bottom-start" initialFocus="checked" matchAnchorWidth aria-label={label}>
        {options.map((option, index) =>
          option === "separator" ? (
            <MenuSeparator key={`separator-${index}`} />
          ) : (
            <MenuItem
              key={option.value}
              type="radio"
              checked={option.value === value}
              disabled={option.disabled}
              onSelect={() => onChange(option.value)}
            >
              {option.label}
            </MenuItem>
          ),
        )}
      </Menu>
    </>
  );
}

export interface SelectProps extends Omit<ComponentPropsWithRef<"select">, "size"> {
  controlSize?: "regular" | "large" | undefined;
}

/** A styled native <select>: the real macOS menu on a Mac and free accessibility (§2.8). */
export function Select({ controlSize = "regular", className, children, ...rest }: SelectProps) {
  return (
    <span className={cx("px-select", `px-select--${controlSize}`, className)}>
      <select className="px-select__control" {...rest}>
        {children}
      </select>
      <Icon icon={ChevronsUpDown} size={12} className="px-select__chevron" />
    </span>
  );
}
