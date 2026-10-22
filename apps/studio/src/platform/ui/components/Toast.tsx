import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { cx } from "../lib/dom";
import { Button, IconButton } from "./Button";
import { Icon } from "./Icon";
import "./toast.css";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
  /** A plain accent text button ("Undo", "Open", "Try Again"). */
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  message: string;
  tone?: ToastTone | undefined;
  /** Leading glyph; defaults by tone, null for none. */
  icon?: LucideIcon | null | undefined;
  action?: ToastAction | undefined;
  /** Milliseconds; defaults to 4 s, 8 s with an action; errors and null stay until dismissed (§2.13). */
  duration?: number | null | undefined;
  /** A close button; defaults to on for toasts that do not dismiss themselves. */
  dismissible?: boolean | undefined;
  /** Reusing an id replaces that toast instead of queueing another. */
  id?: string | undefined;
}

export interface ToastRecord extends ToastOptions {
  id: string;
  tone: ToastTone;
}

const TONE_ICON: Record<ToastTone, LucideIcon | null> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
};

export function toastDuration(toast: ToastOptions): number | null {
  if (toast.duration !== undefined) return toast.duration;
  if (toast.tone === "error") return null;
  return toast.action ? 8000 : 4000;
}

function showManualPopover(element: HTMLElement | null): void {
  if (!element || typeof element.showPopover !== "function") return;
  try {
    if (!element.matches(":popover-open")) element.showPopover();
  } catch {
    // disconnected: nothing to show
  }
}

/** One toast in the top layer (popover="manual", above sheets). Hover or focus pauses its timer. */
export function ToastView({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: string) => void }) {
  const duration = toastDuration(toast);
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const element = useRef<HTMLDivElement | null>(null);
  const remaining = useRef(duration ?? 0);

  useEffect(() => {
    if (duration === null || paused || leaving) return undefined;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => setLeaving(true), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [duration, paused, leaving]);

  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => onDismiss(toast.id), 150);
    return () => window.clearTimeout(timer);
  }, [leaving, onDismiss, toast.id]);

  useLayoutEffect(() => {
    // one line is a capsule (radius 18); wrapped text gets radius 14
    if (element.current) setMultiline(element.current.offsetHeight > 44);
  }, [toast.message]);

  const glyph = toast.icon === null ? null : toast.icon ?? TONE_ICON[toast.tone];
  const dismissible = toast.dismissible ?? duration === null;
  return (
    <div
      ref={(node) => {
        element.current = node;
        showManualPopover(node);
      }}
      popover="manual"
      className={cx("px-toast", `px-toast--${toast.tone}`, leaving && "px-toast--leaving")}
      data-multiline={multiline || undefined}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {glyph ? <Icon icon={glyph} size={16} className="px-toast__icon" /> : null}
      <p className="px-toast__message">{toast.message}</p>
      {toast.action ? (
        <Button
          variant="plain"
          className="px-toast__action"
          onClick={() => {
            toast.action?.onAction();
            setLeaving(true);
          }}
        >
          {toast.action.label}
        </Button>
      ) : null}
      {dismissible ? <IconButton icon={X} label="Dismiss" size="small" tooltip={false} onClick={() => setLeaving(true)} /> : null}
    </div>
  );
}

export interface HudOptions {
  /** "Version Saved", "Link Copied", "Exported". */
  label: string;
  icon?: LucideIcon | undefined;
}

export interface HudRecord extends HudOptions {
  id: number;
}

/** The centred Apple OSD: fade in 150 ms, hold 1.2 s, fade out 300 ms. */
export function HudView({ hud, onDone }: { hud: HudRecord; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const fade = window.setTimeout(() => setLeaving(true), 150 + 1200);
    const done = window.setTimeout(onDone, 150 + 1200 + 300);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(done);
    };
  }, [hud.id, onDone]);
  return (
    <div ref={showManualPopover} popover="manual" className={cx("px-hud", leaving && "px-hud--leaving")}>
      <Icon icon={hud.icon ?? Check} size={32} />
      <span className="px-hud__label">{hud.label}</span>
    </div>
  );
}
