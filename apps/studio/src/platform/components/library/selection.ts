// Selection rules of the Library grid that the UI kit's MediaGrid leaves to its owner: keeping the selection in step
// with what is visible, Finder's right-click rule, and which item takes the selection after items leave the grid.
// Click, ⌘-click, ⇧-click and the arrow keys live in ui/lib/roving.ts.

/** The selection limited to `visibleIds`; the same Set when nothing had to go (so React state does not churn). */
export function pruneSelection(selected: ReadonlySet<string>, visibleIds: readonly string[]): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const visible = new Set(visibleIds);
  for (const id of selected) {
    if (!visible.has(id)) return new Set([...selected].filter((candidate) => visible.has(candidate)));
  }
  return selected;
}

/** Finder: a right-click on a selected item keeps the selection; on any other item it selects only that item. */
export function contextMenuSelection(selected: ReadonlySet<string>, targetId: string): ReadonlySet<string> {
  return selected.has(targetId) ? selected : new Set([targetId]);
}

/** The selected ids in display order. */
export function orderedSelection(orderedIds: readonly string[], selected: ReadonlySet<string>): string[] {
  return orderedIds.filter((id) => selected.has(id));
}

/**
 * After `removed` leave the grid (moved to the Trash), the item that should be selected next, as in Photos: the first
 * remaining item after the last removed one, else the last remaining item before it; null when nothing remains.
 */
export function neighbourAfterRemoval(orderedIds: readonly string[], removed: ReadonlySet<string>): string | null {
  let lastRemoved = -1;
  orderedIds.forEach((id, index) => {
    if (removed.has(id)) lastRemoved = index;
  });
  if (lastRemoved < 0) return null;
  for (let index = lastRemoved + 1; index < orderedIds.length; index += 1) {
    const id = orderedIds[index];
    if (id !== undefined && !removed.has(id)) return id;
  }
  for (let index = lastRemoved - 1; index >= 0; index -= 1) {
    const id = orderedIds[index];
    if (id !== undefined && !removed.has(id)) return id;
  }
  return null;
}

/** Two selections with the same members. */
export function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
