// The 6-digit code entry (APPLE_STYLE_SPEC §3.1): one real <input> (numeric keyboard, one-time-code autofill, paste)
// laid over six drawn cells. Anything pasted is reduced to its digits ("123 456", "123-456"); the sixth digit submits.

import { useId, type ClipboardEvent, type Ref } from "react";
import { CircleAlert } from "lucide-react";
import { Icon, cx } from "../../ui";

export const CODE_LENGTH = 6;

export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "").slice(0, CODE_LENGTH);
}

export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called once the sixth digit is entered (typed, pasted or autofilled). */
  onComplete?: ((code: string) => void) | undefined;
  label?: string | undefined;
  error?: string | null | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  inputRef?: Ref<HTMLInputElement> | undefined;
}

export function CodeInput({ value, onChange, onComplete, label = "6-digit code", error, disabled = false, autoFocus = false, inputRef }: CodeInputProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const cells = Array.from({ length: CODE_LENGTH }, (_, index) => value.charAt(index));
  const active = Math.min(value.length, CODE_LENGTH - 1);

  const update = (next: string) => {
    const digits = digitsOnly(next);
    onChange(digits);
    if (digits.length === CODE_LENGTH && digits !== value) onComplete?.(digits);
  };

  return (
    <div className="px-code-field">
      <label htmlFor={id} className="px-visually-hidden">
        {label}
      </label>
      <div className={cx("px-code", error ? "px-code--invalid" : null, disabled && "px-code--disabled")}>
        <div className="px-code__cells" aria-hidden="true">
          {cells.map((digit, index) => (
            <span key={index} className="px-code__cell" data-active={index === active || undefined} data-filled={digit !== "" || undefined}>
              {digit}
            </span>
          ))}
        </div>
        <input
          ref={inputRef}
          id={id}
          className="px-code__input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => update(event.target.value)}
          onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
            const pasted = event.clipboardData.getData("text");
            if (!pasted) return;
            event.preventDefault();
            update(pasted);
          }}
        />
      </div>
      {error ? (
        <p id={errorId} className="px-field__message px-field__message--error px-code-field__error">
          <Icon icon={CircleAlert} size={12} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
