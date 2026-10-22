// One small sheet for every "give it a name" step: Save as Project, Save Version (⇧⌘S), Name/Rename a version, Save a
// Copy. The default action is last, Cancel to its left (§2.11); Return submits; the field starts selected.

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Sheet, TextField } from "../../ui";
import { friendlyError, isCancellation } from "./friendlyError";

export interface NameSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /** The field's label ("Name"). */
  label?: string | undefined;
  initialValue: string;
  placeholder?: string | undefined;
  submitLabel: string;
  /** "Saving…" while onSubmit runs. */
  busyLabel?: string | undefined;
  /** Resolves when done (the sheet closes); a rejection is shown under the field. */
  onSubmit: (value: string) => Promise<void>;
  /** Extra content under the field (a note on what will happen). */
  children?: ReactNode;
  maxLength?: number | undefined;
  /** What the error says when onSubmit fails without a known reason. */
  failure?: string | undefined;
}

export function NameSheet({
  open,
  onClose,
  title,
  description,
  label = "Name",
  initialValue,
  placeholder,
  submitLabel,
  busyLabel = "Saving…",
  onSubmit,
  children,
  maxLength = 120,
  failure = "That didn't work. Try again.",
}: NameSheetProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);
  const formId = useId();

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setError(null);
    setBusy(false);
    // the sheet focuses the field; select it so typing replaces the suggestion
    const timer = window.setTimeout(() => field.current?.select(), 0);
    return () => window.clearTimeout(timer);
  }, [open, initialValue]);

  const trimmed = value.replace(/\s+/g, " ").trim();
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (trimmed === "") {
      setError("Enter a name.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed.slice(0, maxLength));
      onClose();
    } catch (reason) {
      if (!isCancellation(reason)) setError(friendlyError(reason, failure));
      field.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      description={description}
      size="small"
      initialFocus={field}
      actions={
        <>
          <Button size="large" onClick={onClose} aria-disabled={busy || undefined}>
            Cancel
          </Button>
          <Button size="large" variant="borderedProminent" type="submit" form={formId} loading={busy} loadingLabel={busyLabel}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="px-name-sheet" onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          ref={field}
          label={label}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          size="large"
          autoComplete="off"
          spellCheck={false}
          error={error ?? undefined}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
        />
        {children}
      </form>
    </Sheet>
  );
}
