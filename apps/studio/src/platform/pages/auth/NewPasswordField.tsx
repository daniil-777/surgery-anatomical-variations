// A new-password field with the live strength hint (§2.7: new-password rules validate live). Length is the only rule;
// the meter explains what makes a password easy to guess (passwordStrength.ts). Used by sign-up, reset and Settings.

import { useMemo, type Ref } from "react";
import { SecureField, type FieldSize } from "../../ui";
import { MIN_PASSWORD_LENGTH, passwordStrength } from "./passwordStrength";

const NO_CONTEXT: readonly string[] = [];

export interface NewPasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string | undefined;
  /** Name, email and username: a password built from them is flagged. */
  context?: readonly string[] | undefined;
  error?: string | null | undefined;
  size?: FieldSize | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  autoFocus?: boolean | undefined;
  inputRef?: Ref<HTMLInputElement> | undefined;
}

export function NewPasswordField({
  value,
  onChange,
  label = "Password",
  context = NO_CONTEXT,
  error,
  size = "auth",
  disabled,
  readOnly,
  autoFocus,
  inputRef,
}: NewPasswordFieldProps) {
  const strength = useMemo(() => passwordStrength(value, context), [value, context]);
  const hint = (
    <span className="px-strength" data-score={strength.score} data-level={strength.level}>
      <span className="px-strength__bar" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="px-strength__text" aria-live="polite">
        {strength.label ? <span className="px-strength__label">{strength.label}.</span> : null} {strength.hint}
      </span>
    </span>
  );
  return (
    <SecureField
      ref={inputRef}
      label={label}
      size={size}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoComplete="new-password"
      minLength={MIN_PASSWORD_LENGTH}
      error={error ?? undefined}
      hint={hint}
      disabled={disabled}
      readOnly={readOnly}
      autoFocus={autoFocus}
    />
  );
}
