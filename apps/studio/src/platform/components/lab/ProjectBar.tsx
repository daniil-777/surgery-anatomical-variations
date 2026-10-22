// The 44 px project bar over a lab (DESIGN.md D2, APPLE_STYLE_SPEC §3.6): back, the document title with its save status,
// and the editor's actions. Lab routes are always dark; the bar is solid (never glass over the WebGL stage, §0.2).

import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, CircleAlert, CircleCheck, CloudOff, Ellipsis, Lock, Pause, PencilLine, type LucideIcon } from "lucide-react";
import { Button, Icon, IconButton, Menu, Spinner, Tooltip, cx, usePx, type ShortcutSpec } from "../../ui";
import { editorStatus, shouldAnnounce, type EditorStatusAction, type EditorStatusInput, type EditorStatusView } from "./editorStatus";
import { useDelayedFlag } from "./hooks";
import "./lab.css";

export interface ProjectBarProps {
  /** Back button target label ("Projects", "VISCERA"). */
  backLabel: string;
  onBack: () => void;
  title: ReactNode;
  /** The lab name, status and any inline action. */
  subtitle?: ReactNode;
  /** Actions on the trailing side. */
  trailing?: ReactNode;
  /** A notice in the middle (recording indicator). */
  center?: ReactNode;
}

export function ProjectBar({ backLabel, onBack, title, subtitle, trailing, center }: ProjectBarProps) {
  return (
    <header className="px-pbar">
      <div className="px-pbar__start">
        <IconButton icon={ChevronLeft} label={`Back to ${backLabel}`} size="large" onClick={onBack} tooltipPlacement="bottom-start" />
        <div className="px-pbar__titles">
          {title}
          {subtitle ? <div className="px-pbar__subtitle">{subtitle}</div> : null}
        </div>
      </div>
      <div className="px-pbar__center">{center}</div>
      <div className="px-pbar__end">{trailing}</div>
    </header>
  );
}

export interface EditableTitleProps {
  value: string;
  /** Resolves when stored; rejects to keep the field open (the caller shows the reason). */
  onRename?: ((title: string) => Promise<void>) | undefined;
  /** Bump to start editing from elsewhere (a "Rename…" menu item). */
  editRequest?: number | undefined;
  disabled?: boolean | undefined;
}

/** The document title: Return or a click edits it in place, Return commits, Escape reverts, blur commits (§2.10). */
export function EditableTitle({ value, onRename, editRequest = 0, disabled = false }: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const lastRequest = useRef(editRequest);

  useEffect(() => {
    if (editRequest !== lastRequest.current) {
      lastRequest.current = editRequest;
      if (onRename && !disabled) {
        setDraft(value);
        setEditing(true);
      }
    }
  }, [editRequest, onRename, disabled, value]);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const finish = async (commit: boolean) => {
    const next = draft.replace(/\s+/g, " ").trim();
    if (!commit || next === "" || next === value || !onRename) {
      setEditing(false);
      setDraft(value);
      requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
      return;
    }
    setSaving(true);
    try {
      await onRename(next.slice(0, 120));
      setEditing(false);
      requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
    } catch {
      input.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={input}
        className="px-pbar__title-input"
        aria-label="Project Name"
        value={draft}
        maxLength={120}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void finish(true)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            void finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            void finish(false);
          }
        }}
      />
    );
  }
  if (!onRename || disabled) return <h1 className="px-pbar__title">{value}</h1>;
  return (
    <h1 className="px-pbar__title-wrap">
      <Tooltip content="Rename">
        <button
          ref={button}
          type="button"
          className="px-pbar__title px-pbar__title--button"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
        >
          <span className="px-pbar__title-text">{value}</span>
          <Icon icon={PencilLine} size={12} className="px-pbar__title-pencil" />
        </button>
      </Tooltip>
    </h1>
  );
}

const STATUS_ICON: Record<EditorStatusView["icon"], LucideIcon | null> = {
  check: CircleCheck,
  spinner: null,
  edited: null,
  offline: CloudOff,
  alert: CircleAlert,
  lock: Lock,
  pause: Pause,
  none: null,
};

const ACTION_LABEL: Record<Exclude<EditorStatusAction, null>, string> = {
  "edit-here": "Edit Here",
  retry: "Try Again",
  resolve: "Resolve…",
  "reload-lab": "Reload Lab",
  "review-restore": "Review…",
  "put-back": "Put Back",
};

export interface SaveStatusProps {
  state: EditorStatusInput;
  onAction?: ((action: Exclude<EditorStatusAction, null>) => void) | undefined;
}

/** "Organ Design · ✓ Saved": icon plus text, never colour alone; the tooltip gives the time or the reason (§3.6.1). */
export function SaveStatus({ state, onAction }: SaveStatusProps) {
  const { announce } = usePx();
  const savingVisible = useDelayedFlag(state.status === "saving", 400);
  const view = editorStatus(state, { savingVisible });
  const previous = useRef<EditorStatusView | null>(null);
  const detailId = useId();

  useEffect(() => {
    if (shouldAnnounce(previous.current, view)) announce(view.detail ? `${view.text}. ${view.detail}` : view.text, view.tone === "danger" ? "assertive" : "polite");
    previous.current = view;
  });

  const glyph = STATUS_ICON[view.icon];
  const content = (
    <span className="px-pbar-status" data-tone={view.tone} aria-describedby={view.detail ? detailId : undefined}>
      {view.icon === "spinner" ? <Spinner size={10} /> : glyph ? <Icon icon={glyph} size={11} className="px-pbar-status__icon" /> : null}
      <span className="px-pbar-status__text">{view.text}</span>
      {view.detail ? (
        <span id={detailId} className="px-visually-hidden">
          {view.detail}
        </span>
      ) : null}
    </span>
  );
  return (
    <>
      {view.detail ? <Tooltip content={view.detail}>{content}</Tooltip> : content}
      {view.action && onAction ? (
        <button type="button" className="px-pbar-status__action" onClick={() => onAction(view.action as Exclude<EditorStatusAction, null>)}>
          {ACTION_LABEL[view.action]}
        </button>
      ) : null}
    </>
  );
}

export interface IconMenuButtonProps {
  label: string;
  icon?: LucideIcon | undefined;
  /** MenuItem elements. */
  menu: ReactNode;
  shortcut?: ShortcutSpec | undefined;
  disabled?: boolean | undefined;
  size?: "regular" | "large" | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  className?: string | undefined;
}

/** An icon-only pull-down (⋯ More): the kit's IconButton anchoring the kit's Menu. */
export function IconMenuButton({ label, icon = Ellipsis, menu, shortcut, disabled = false, size = "large", onOpenChange, className }: IconMenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [initialFocus, setInitialFocus] = useState<"first" | "menu">("menu");
  const dismissedAt = useRef(0);
  const menuId = useId();
  const change = (next: boolean) => {
    if (!next) dismissedAt.current = Date.now();
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <IconButton
        ref={setAnchor}
        icon={icon}
        label={label}
        size={size}
        shortcut={shortcut}
        className={cx("px-pbar__icon-menu", className)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-disabled={disabled || undefined}
        tooltip={!open}
        onClick={(event) => {
          if (!open && Date.now() - dismissedAt.current < 250) return;
          setInitialFocus(event.detail === 0 ? "first" : "menu");
          change(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setInitialFocus("first");
            change(true);
          }
        }}
      />
      <Menu id={menuId} open={open} onOpenChange={change} anchor={anchor} placement="bottom-end" initialFocus={initialFocus} aria-label={label}>
        {menu}
      </Menu>
    </>
  );
}

/** A labelled bar button (Record, Save as Project…): 28 px capsule. */
export function BarButton(props: ComponentProps<typeof Button>) {
  return <Button size="large" {...props} className={cx("px-pbar__button", props.className)} />;
}
