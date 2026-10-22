// Index math for composite widgets (segmented controls, menus, the sidebar list, media grids): roving focus, 2-D grid
// moves, type-ahead and multi-selection. Pure, so the keyboard rules are unit-tested in node.

export type Orientation = "horizontal" | "vertical" | "both";

export type IsDisabled = (index: number) => boolean;

const never: IsDisabled = () => false;

/** The next enabled index from `from` moving by `step`; wraps when `loop`. -1 when nothing is enabled that way. */
export function stepIndex(count: number, from: number, step: 1 | -1, isDisabled: IsDisabled = never, loop = true): number {
  if (count <= 0) return -1;
  let index = from;
  for (let tries = 0; tries < count; tries += 1) {
    index += step;
    if (index < 0 || index >= count) {
      if (!loop) return -1;
      index = (index + count) % count;
    }
    if (!isDisabled(index)) return index;
  }
  return -1;
}

export function firstEnabled(count: number, isDisabled: IsDisabled = never): number {
  return stepIndex(count, -1, 1, isDisabled, false);
}

export function lastEnabled(count: number, isDisabled: IsDisabled = never): number {
  return stepIndex(count, count, -1, isDisabled, false);
}

export interface RovingOptions {
  orientation?: Orientation | undefined;
  loop?: boolean | undefined;
  isDisabled?: IsDisabled | undefined;
  /** Right-to-left: ← moves forward in horizontal widgets. */
  rtl?: boolean | undefined;
}

/**
 * Where a key moves focus in a one-dimensional composite, or null when the key is not a navigation key for this
 * orientation (the caller then lets the event through).
 */
export function rovingTargetIndex(key: string, current: number, count: number, options: RovingOptions = {}): number | null {
  const orientation = options.orientation ?? "both";
  const loop = options.loop ?? true;
  const isDisabled = options.isDisabled ?? never;
  const forwardKeys: string[] = [];
  const backwardKeys: string[] = [];
  if (orientation !== "vertical") {
    forwardKeys.push(options.rtl ? "ArrowLeft" : "ArrowRight");
    backwardKeys.push(options.rtl ? "ArrowRight" : "ArrowLeft");
  }
  if (orientation !== "horizontal") {
    forwardKeys.push("ArrowDown");
    backwardKeys.push("ArrowUp");
  }
  let target: number;
  if (forwardKeys.includes(key)) {
    // with nothing focused yet (-1), "forward" lands on the first item
    target = current < 0 ? firstEnabled(count, isDisabled) : stepIndex(count, current, 1, isDisabled, loop);
  } else if (backwardKeys.includes(key)) {
    target = current < 0 ? lastEnabled(count, isDisabled) : stepIndex(count, current, -1, isDisabled, loop);
  } else if (key === "Home" || key === "PageUp") {
    target = firstEnabled(count, isDisabled);
  } else if (key === "End" || key === "PageDown") {
    target = lastEnabled(count, isDisabled);
  } else {
    return null;
  }
  // a non-looping edge keeps focus where it is
  return target < 0 ? current : target;
}

/** The number of tracks in a computed grid-template-columns value ("168px 168px 168px" → 3). */
export function countGridColumns(gridTemplateColumns: string): number {
  // computed values are resolved track sizes separated by spaces, with optional [line names] between them
  const value = gridTemplateColumns.replace(/\[[^\]]*\]/g, " ").trim();
  if (value === "" || value === "none") return 1;
  let depth = 0;
  let tracks = 0;
  let inTrack = false;
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      inTrack = false;
      continue;
    }
    if (!inTrack) {
      tracks += 1;
      inTrack = true;
    }
  }
  return Math.max(1, tracks);
}

/** Grid moves (Finder/Photos): ←/→ by one, ↑/↓ by a row, Home/End to the ends. Null for other keys. */
export function gridTargetIndex(key: string, current: number, count: number, columns: number, rtl = false): number | null {
  if (count <= 0) return null;
  const cols = Math.max(1, Math.floor(columns));
  const from = current < 0 ? -1 : Math.min(current, count - 1);
  const last = count - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowLeft": {
      const forward = (key === "ArrowRight") !== rtl;
      if (from < 0) return forward ? 0 : last;
      return forward ? Math.min(last, from + 1) : Math.max(0, from - 1);
    }
    case "ArrowDown":
      if (from < 0) return 0;
      // the last row may be short: land on its last item rather than nowhere
      return from + cols <= last ? from + cols : Math.floor(from / cols) < Math.floor(last / cols) ? last : from;
    case "ArrowUp":
      if (from < 0) return last;
      return from - cols >= 0 ? from - cols : from;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * Type-ahead (menus, lists): the next enabled label starting with `query`. A single character starts after the
 * current item so repeated presses cycle; longer queries keep the current item while it still matches.
 */
export function typeaheadIndex(labels: readonly string[], query: string, current: number, isDisabled: IsDisabled = never): number {
  const count = labels.length;
  if (count === 0 || query === "") return -1;
  const lowered = query.toLocaleLowerCase();
  const repeated = [...lowered].every((char) => char === lowered[0]);
  const needle = repeated ? lowered.slice(0, 1) : lowered;
  const start = repeated || current < 0 ? current + 1 : current;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (((start + offset) % count) + count) % count;
    const label = labels[index];
    if (label !== undefined && !isDisabled(index) && label.trim().toLocaleLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

// Selection -----------------------------------------------------------------------------------------------------------

export function toggleInSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** ⇧-click / ⇧-arrow: every id between the anchor and the target (inclusive), in display order. */
export function rangeSelection(ids: readonly string[], anchorId: string, targetId: string): Set<string> {
  const anchor = ids.indexOf(anchorId);
  const target = ids.indexOf(targetId);
  if (target < 0) return new Set();
  if (anchor < 0) return new Set([targetId]);
  const [from, to] = anchor <= target ? [anchor, target] : [target, anchor];
  return new Set(ids.slice(from, to + 1));
}

export interface SelectionGesture {
  /** ⌘ on Apple platforms, Ctrl elsewhere. */
  toggle: boolean;
  /** ⇧ extends from the anchor. */
  extend: boolean;
}

/** Finder rules: click selects one, ⌘-click toggles, ⇧-click selects the range from the anchor. */
export function selectWithGesture(
  ids: readonly string[],
  selected: ReadonlySet<string>,
  anchorId: string | null,
  id: string,
  gesture: SelectionGesture,
  multiselect: boolean,
): { selected: Set<string>; anchorId: string } {
  if (!multiselect) return { selected: new Set([id]), anchorId: id };
  if (gesture.extend && anchorId !== null) {
    const range = rangeSelection(ids, anchorId, id);
    const next = gesture.toggle ? new Set([...selected, ...range]) : range;
    return { selected: next, anchorId };
  }
  if (gesture.toggle) return { selected: toggleInSelection(selected, id), anchorId: id };
  return { selected: new Set([id]), anchorId: id };
}
