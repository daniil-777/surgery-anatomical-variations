import { useCallback, useRef, type FocusEvent, type KeyboardEvent } from "react";
import { firstEnabled, rovingTargetIndex, type IsDisabled, type Orientation } from "../lib/roving";
import { useLatest } from "./useLatest";

export interface UseRovingFocusOptions {
  count: number;
  /** The item that holds the single tab stop (e.g. the selected segment). */
  activeIndex: number;
  /** Called when arrows or focus move the tab stop; radio groups select here (selection follows focus). */
  onActiveIndexChange: (index: number) => void;
  orientation?: Orientation | undefined;
  loop?: boolean | undefined;
  isDisabled?: IsDisabled | undefined;
}

export interface RovingItemProps {
  ref: (element: HTMLElement | null) => void;
  tabIndex: 0 | -1;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
}

/** One tab stop for a composite widget; arrows, Home and End move inside it (§4.2). */
export function useRovingFocus(options: UseRovingFocusOptions): {
  getItemProps: (index: number) => RovingItemProps;
  focusItem: (index: number) => void;
} {
  const latest = useLatest(options);
  const elements = useRef<Array<HTMLElement | null>>([]);
  const refCallbacks = useRef(new Map<number, (element: HTMLElement | null) => void>());

  const focusItem = useCallback((index: number) => {
    elements.current[index]?.focus();
  }, []);

  const isDisabled = options.isDisabled ?? (() => false);
  const tabStop = options.activeIndex >= 0 && options.activeIndex < options.count && !isDisabled(options.activeIndex)
    ? options.activeIndex
    : firstEnabled(options.count, isDisabled);

  const getItemProps = (index: number): RovingItemProps => {
    let ref = refCallbacks.current.get(index);
    if (!ref) {
      ref = (element: HTMLElement | null) => {
        elements.current[index] = element;
      };
      refCallbacks.current.set(index, ref);
    }
    return {
      ref,
      tabIndex: index === tabStop ? 0 : -1,
      onKeyDown: (event) => {
        const current = latest.current;
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const target = rovingTargetIndex(event.key, index, current.count, {
          orientation: current.orientation,
          loop: current.loop,
          isDisabled: current.isDisabled,
          rtl,
        });
        if (target === null) return;
        event.preventDefault();
        if (target === index) return;
        elements.current[target]?.focus();
        current.onActiveIndexChange(target);
      },
      onFocus: () => {
        const current = latest.current;
        if (index !== current.activeIndex && !(current.isDisabled?.(index) ?? false)) current.onActiveIndexChange(index);
      },
    };
  };

  return { getItemProps, focusItem };
}
