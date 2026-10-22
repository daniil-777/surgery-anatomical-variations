// The unified toolbar belongs to the window frame (AppLayout's header), but its title and actions belong to the page.
// A page renders <PageToolbar title="Library" subtitle="24 Items" trailing={…} />: the shell puts it in the header
// through a portal and hides its own default toolbar (the route's title) while the page's is mounted. React context
// follows the React tree, so the kit's Toolbar still sees the layout (scrolled edge, sidebar toggle, title focus).

import { createContext, useContext, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Toolbar, type ToolbarProps } from "../../ui";

export interface ToolbarSlot {
  /** The header element the page toolbar is rendered into (null until the frame has mounted). */
  element: HTMLElement | null;
  /** Hides the default toolbar while the returned release has not been called. */
  claim: () => () => void;
}

export const ToolbarSlotContext = createContext<ToolbarSlot | null>(null);

export type PageToolbarProps = ToolbarProps;

/** The page's toolbar: title, subtitle, a centre control and up to three trailing groups (APPLE_STYLE_SPEC §2.3). */
export function PageToolbar(props: PageToolbarProps) {
  const slot = useContext(ToolbarSlotContext);
  const claim = slot?.claim;
  const [claimed, setClaimed] = useState(false);

  useLayoutEffect(() => {
    if (!claim) return undefined;
    const release = claim();
    setClaimed(true);
    return () => {
      release();
      setClaimed(false);
    };
  }, [claim]);

  // outside the shell frame (tests, the gallery) the toolbar renders where it is
  if (!slot) return <Toolbar {...props} />;
  // rendered only after the claim, so the default toolbar's title has already let go of the title ref
  if (!claimed || !slot.element) return null;
  return createPortal(<Toolbar {...props} />, slot.element);
}

/** True inside the shell's app frame. */
export function useInShellFrame(): boolean {
  return useContext(ToolbarSlotContext) !== null;
}
