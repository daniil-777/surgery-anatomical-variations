import { useCallback, useLayoutEffect, useMemo, useRef, useState, type Ref, type RefCallback, type RefObject } from "react";
import { mergeRefs } from "../lib/dom";

/**
 * A stable callback ref feeding several refs. A fresh callback every render would make React detach and re-attach
 * the node each commit (and re-run state-setter refs).
 */
export function useMergedRefs<T>(...refs: Array<Ref<T> | undefined | null>): RefCallback<T> {
  // the refs themselves are the dependencies; their count is fixed per call site
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => mergeRefs(...refs), refs);
}

/** The latest value in a ref, for event listeners that must not re-subscribe on every render. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Controlled when `value` is defined, uncontrolled otherwise (onChange fires in both modes). */
export function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: ((next: T) => void) | undefined,
): [T, (next: T) => void] {
  const [internal, setInternal] = useState<T>(defaultValue);
  const controlled = value !== undefined;
  const latestChange = useLatest(onChange);
  const set = useCallback((next: T) => {
    if (!controlled) setInternal(next);
    latestChange.current?.(next);
  }, [controlled, latestChange]);
  return [controlled ? value : internal, set];
}
