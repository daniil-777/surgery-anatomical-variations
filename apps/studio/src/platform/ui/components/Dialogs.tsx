import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { cx, focusableWithin } from "../lib/dom";
import { useLatest } from "../hooks/useLatest";
import { Button, IconButton } from "./Button";
import { AppMark } from "./Icon";
import "./dialog.css";

interface ModalOptions {
  open: boolean;
  onClose: () => void;
  /** Return false to keep the dialog open on Escape (a dirty form asks first). */
  onCancel?: (() => boolean | void) | undefined;
  /** Where focus starts; the dialog itself when nothing is returned. */
  initialFocus: (dialog: HTMLDialogElement) => HTMLElement | null;
}

/**
 * showModal() gives the top layer, an inert page behind and the cancel event on Escape (§2.11). The content stays
 * mounted through the exit fade, focus starts where the caller says and returns to the invoker on close.
 */
function useModalDialog({ open, onClose, onCancel, initialFocus }: ModalOptions) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [present, setPresent] = useState(open);
  const latest = useLatest({ open, onClose, onCancel, initialFocus });
  if (open && !present) setPresent(true);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
      (latest.current.initialFocus(dialog) ?? dialog).focus({ preventScroll: true });
    } else if (!open && dialog.open) {
      dialog.close();
      const target = returnFocus.current;
      returnFocus.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
  }, [open, present, latest]);

  useEffect(() => {
    if (open || !present) return undefined;
    // keep the content through the exit fade (--px-dur-fast), then unmount it
    const timer = window.setTimeout(() => setPresent(false), 200);
    return () => window.clearTimeout(timer);
  }, [open, present]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      if (latest.current.onCancel?.() === false) return;
      latest.current.onClose();
    };
    const handleClose = () => {
      // closed by the browser (form method=dialog, a forced close): tell the owner
      if (latest.current.open) latest.current.onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleClose);
    };
  }, [present, latest]);

  return { dialogRef, present };
}

export interface SheetProps {
  open: boolean;
  /** Escape, the close button and Cancel all call this; the owner sets open to false. */
  onClose: () => void;
  title: ReactNode;
  /** Optional line under the title; also describes the dialog. */
  description?: ReactNode;
  /** small 420 · medium 560 · large 720. */
  size?: "small" | "medium" | "large" | undefined;
  /** Trailing footer buttons: Cancel, then the default (prominent) action last. */
  actions?: ReactNode;
  /** Leading tertiary footer actions (Help, Sign Out). */
  leadingActions?: ReactNode;
  /** A close X in the header: only for sheets without a form. */
  closeButton?: boolean | undefined;
  /** Settings-style grouped background for FormGroup boxes. */
  grouped?: boolean | undefined;
  onCancel?: (() => boolean | void) | undefined;
  /** Focus target on open; defaults to the first field in the body. */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/** A modal sheet: one at a time, never stacked; Done is paired with Cancel when changes are not live (HIG). */
export function Sheet({
  open,
  onClose,
  title,
  description,
  size = "medium",
  actions,
  leadingActions,
  closeButton = false,
  grouped = false,
  onCancel,
  initialFocus,
  className,
  children,
}: SheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const { dialogRef, present } = useModalDialog({
    open,
    onClose,
    onCancel,
    initialFocus: (dialog) => {
      if (initialFocus?.current) return initialFocus.current;
      const body = dialog.querySelector<HTMLElement>(".px-sheet__body");
      const fields = body ? focusableWithin(body) : [];
      const field = fields.find((element) => element.matches("input, textarea, select")) ?? fields[0];
      return field ?? focusableWithin(dialog).find((element) => !element.closest(".px-sheet__header")) ?? null;
    },
  });
  if (!present) return null;
  return (
    <dialog
      ref={dialogRef}
      className={cx("px-dialog", "px-sheet", `px-sheet--${size}`, grouped && "px-sheet--grouped", className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
    >
      <div className="px-sheet__header">
        <div className="px-sheet__heading">
          <h2 id={titleId} className="px-sheet__title">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="px-sheet__description">
              {description}
            </p>
          ) : null}
        </div>
        {closeButton ? <IconButton icon={X} label="Close" onClick={onClose} tooltip={false} /> : null}
      </div>
      <div className="px-sheet__body">{children}</div>
      {actions || leadingActions ? (
        <div className="px-sheet__footer">
          <div className="px-sheet__footer-leading">{leadingActions}</div>
          <div className="px-sheet__footer-trailing">{actions}</div>
        </div>
      ) : null}
    </dialog>
  );
}

export interface AlertProps {
  open: boolean;
  /** Cancel and Escape. */
  onClose: () => void;
  /** "Delete “Liver Study”?" */
  title: string;
  /** "This project and its 14 versions will be deleted. You can't undo this action." */
  message?: ReactNode;
  /** 48 px symbol; defaults to the app mark. */
  icon?: ReactNode;
  actionLabel: string;
  /** The owner performs the action and closes the alert. */
  onAction: () => void;
  /** Destructive actions are red and never the Return default: focus starts on Cancel. */
  destructive?: boolean | undefined;
  /** null leaves a single button (purely informational alerts only). */
  cancelLabel?: string | null | undefined;
}

/** Destructive confirmations and blocking errors only; undoable actions get an Undo toast instead (HIG). */
export function Alert({ open, onClose, title, message, icon, actionLabel, onAction, destructive = false, cancelLabel = "Cancel" }: AlertProps) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const { dialogRef, present } = useModalDialog({
    open,
    onClose,
    initialFocus: () => (destructive && cancelRef.current ? cancelRef.current : actionRef.current),
  });
  if (!present) return null;
  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      className="px-dialog px-alert"
      aria-labelledby={titleId}
      aria-describedby={message ? messageId : undefined}
    >
      <div className="px-alert__icon">{icon ?? <AppMark size={48} />}</div>
      <h2 id={titleId} className="px-alert__title">
        {title}
      </h2>
      {message ? (
        <p id={messageId} className="px-alert__message">
          {message}
        </p>
      ) : null}
      <div className={cx("px-alert__actions", cancelLabel === null && "px-alert__actions--single")}>
        {cancelLabel !== null ? (
          <Button ref={cancelRef} size="large" variant="bordered" onClick={onClose}>
            {cancelLabel}
          </Button>
        ) : null}
        <Button ref={actionRef} size="large" variant={destructive ? "destructiveProminent" : "borderedProminent"} onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    </dialog>
  );
}
