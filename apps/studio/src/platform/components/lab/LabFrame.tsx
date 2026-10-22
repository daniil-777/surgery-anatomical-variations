// The lab iframe (DESIGN.md D2): a same-origin frame the platform connects to through the lab-session registry
// (core/labs/host.ts). The connection lives as long as the iframe element; handlers are read through a ref, so new
// callbacks never reconnect. The shell never styles lab DOM — only the box the frame sits in.

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { connectLab, type FlushReason, type LabConnection } from "../../core/labs/host";
import type { LabNavigationRequest, ShortcutAction } from "../../core/labs/navigation";
import { cx, useLatest } from "../../ui";

export interface LabHandle {
  connection: LabConnection;
  frame: HTMLIFrameElement;
}

export interface LabFrameHandlers {
  /** ⌘S / Ctrl+S pressed inside the lab. */
  onSave?: (() => void) | undefined;
  /** ⇧⌘S pressed inside the lab. */
  onSaveNamed?: (() => void) | undefined;
  /** A click or script inside the lab would replace its document. */
  onNavigate?: ((request: LabNavigationRequest) => void) | undefined;
  /** The lab document is being hidden or unloaded. */
  onFlush?: ((reason: FlushReason) => void) | undefined;
  /** Further shell shortcuts taken from the lab while it has focus (⌥⌘Y …). */
  shortcuts?: Partial<Record<Exclude<ShortcutAction, "save" | "save-version">, () => void>> | undefined;
}

export interface LabFrameProps {
  /** labUrl(…): "./?mode=…&embed=1&lab=…". */
  src: string;
  /** The lab this frame serves (adapters of other labs registered on top are ignored). */
  labId: string;
  /** Accessible name of the frame, e.g. "Organ Design lab". */
  title: string;
  onConnect: (handle: LabHandle | null) => void;
  handlers?: LabFrameHandlers | undefined;
  /** How long the lab may take to register its session (default 30 s). */
  timeoutMs?: number | undefined;
  className?: string | undefined;
  /** Overlays drawn over the frame (loading, banners). */
  children?: ReactNode;
}

const SAVE_ACTIONS = new Set<ShortcutAction>(["save", "save-version"]);

export function LabFrame({ src, labId, title, onConnect, handlers, timeoutMs, className, children }: LabFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const latest = useLatest({ handlers, onConnect });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    // the host takes only shortcuts that have a handler when it connects: the set is fixed per frame
    const initial = latest.current.handlers;
    const shortcuts: Partial<Record<ShortcutAction, () => void>> = {};
    for (const action of Object.keys(initial?.shortcuts ?? {}) as ShortcutAction[]) {
      if (SAVE_ACTIONS.has(action)) continue;
      shortcuts[action] = () => {
        const handler = latest.current.handlers?.shortcuts?.[action as Exclude<ShortcutAction, "save" | "save-version">];
        handler?.();
      };
    }
    const connection = connectLab(frame, {
      labId,
      timeoutMs,
      shortcuts,
      onSave: initial?.onSave ? () => latest.current.handlers?.onSave?.() : undefined,
      onSaveNamed: initial?.onSaveNamed ? () => latest.current.handlers?.onSaveNamed?.() : undefined,
      onNavigate: initial?.onNavigate ? (request) => latest.current.handlers?.onNavigate?.(request) : undefined,
      onFlush: (reason) => latest.current.handlers?.onFlush?.(reason),
    });
    latest.current.onConnect({ connection, frame });
    return () => {
      latest.current.onConnect(null);
      connection.dispose();
    };
  }, [labId, timeoutMs, latest]);

  return (
    <div className={cx("px-lab-host", className)}>
      <iframe ref={frameRef} className="px-lab-frame" src={src} title={title} allow="fullscreen" />
      {children}
    </div>
  );
}
