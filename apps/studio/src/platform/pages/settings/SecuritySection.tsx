// Settings ▸ Security: Change Password (the current password first — reauthenticate — then updatePassword, because the
// server only accepts password changes from a sign-in younger than ten minutes, DESIGN.md §15.9) and Sign Out
// Everywhere (every session of the account, this one included).

import { useRef, useState } from "react";
import { LogOut } from "lucide-react";
import type { Session } from "../../core/types";
import { Alert, Button, FormGroup, FormRow, Icon, SecureField, Sheet, useHud } from "../../ui";
import { usePlatform } from "../../app/context";
import { errorMessage, isCredentialError, isSilentError } from "../../app/messages";
import { useSignOut } from "../../app/shell/session";
import { AuthBanner } from "../auth/AuthLayout";
import { NewPasswordField } from "../auth/NewPasswordField";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordStrength";

export function SecuritySection({ id, session }: { id: string; session: Session }) {
  const [changing, setChanging] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signOut = useSignOut();

  return (
    <section id={id} className="px-settings-section" aria-label="Security">
      <FormGroup title="Security" footer="For your security, changing your password or deleting your account asks for your current password.">
        <FormRow label="Password" description="Use at least 8 characters. A short phrase works well.">
          <Button onClick={() => setChanging(true)}>Change Password…</Button>
        </FormRow>
        <FormRow label="Signed-In Devices" description="Sign out on every device and browser, including this one.">
          <Button onClick={() => setConfirmSignOut(true)}>Sign Out Everywhere…</Button>
        </FormRow>
      </FormGroup>
      <ChangePasswordSheet open={changing} onClose={() => setChanging(false)} session={session} />
      <Alert
        open={confirmSignOut}
        onClose={() => {
          if (!signingOut) setConfirmSignOut(false);
        }}
        title="Sign Out Everywhere?"
        message="You’ll be signed out here and on every other device and browser where you use VISCERA."
        icon={<Icon icon={LogOut} size={40} className="px-settings-alert-icon" />}
        actionLabel={signingOut ? "Signing Out…" : "Sign Out"}
        onAction={() => {
          if (signingOut) return;
          setSigningOut(true);
          void signOut({ scope: "global" }).then((done) => {
            if (!done) {
              setSigningOut(false);
              setConfirmSignOut(false);
            }
          });
        }}
      />
    </section>
  );
}

function ChangePasswordSheet({ open, onClose, session }: { open: boolean; onClose: () => void; session: Session }) {
  const { backend } = usePlatform();
  const hud = useHud();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const currentRef = useRef<HTMLInputElement | null>(null);
  const nextRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLInputElement | null>(null);
  const email = session.user.email ?? "";

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setErrors({});
    setBanner(null);
    setSaving(false);
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (saving) return;
    setBanner(null);
    const problems: { current?: string; next?: string; confirm?: string } = {};
    if (current === "") problems.current = "Enter your current password.";
    if (next.length < MIN_PASSWORD_LENGTH) problems.next = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    else if (next === current) problems.next = "Choose a password that’s different from your current one.";
    else if (confirm !== next) problems.confirm = "The passwords don’t match.";
    setErrors(problems);
    if (problems.current) return currentRef.current?.focus();
    if (problems.next) return nextRef.current?.focus();
    if (problems.confirm) return confirmRef.current?.focus();
    setSaving(true);
    try {
      await backend.auth.reauthenticate(current);
    } catch (error) {
      setSaving(false);
      if (isSilentError(error)) return;
      if (isCredentialError(error)) {
        setErrors({ current: errorMessage(error, "reauthenticate") });
        setCurrent("");
        currentRef.current?.focus();
      } else {
        setBanner(errorMessage(error, "reauthenticate"));
      }
      return;
    }
    try {
      await backend.auth.updatePassword(next);
      reset();
      onClose();
      hud({ label: "Password Changed" });
    } catch (error) {
      setSaving(false);
      if (!isSilentError(error)) setBanner(errorMessage(error, "new-password"));
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Change Password"
      description={email ? `For ${email}` : undefined}
      size="small"
      actions={
        <>
          <Button onClick={close} aria-disabled={saving ? true : undefined}>
            Cancel
          </Button>
          <Button variant="borderedProminent" loading={saving} loadingLabel="Changing…" onClick={() => void submit()}>
            Change Password
          </Button>
        </>
      }
    >
      <form
        className="px-settings-sheet-form"
        noValidate
        aria-label="Change password"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <AuthBanner message={banner} />
        <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
        <SecureField
          ref={currentRef}
          label="Current Password"
          autoComplete="current-password"
          value={current}
          error={errors.current}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <NewPasswordField
          inputRef={nextRef}
          label="New Password"
          size="large"
          value={next}
          context={[email]}
          error={errors.next}
          onChange={setNext}
        />
        <SecureField
          ref={confirmRef}
          label="Confirm New Password"
          autoComplete="new-password"
          value={confirm}
          error={errors.confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {/* Return submits from any field */}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
