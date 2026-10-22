// Choose a New Password (APPLE_STYLE_SPEC §3.1 step 3–4). Shown while a recovery session is active (a reset code or
// link signed it in): the guard keeps every other route away until a password is set or the person cancels, which
// signs the recovery session out. updatePassword needs a sign-in younger than ten minutes, which a fresh recovery
// session is. Without a recovery session (someone opening #/reset while signed in) it points to Settings.

import { useRef, useState, type FormEvent } from "react";
import { ChevronLeft, CircleCheck, LockKeyhole } from "lucide-react";
import { Button, SecureField } from "../../ui";
import { useAuth, usePlatform } from "../../app/context";
import { errorMessage, isSilentError } from "../../app/messages";
import { navigate } from "../../app/router";
import { useSignOut } from "../../app/shell/session";
import { AuthBanner, AuthGlyph, AuthLayout, OFFLINE_MESSAGE, dataLocationNote, isOffline } from "./AuthLayout";
import { NewPasswordField } from "./NewPasswordField";
import { MIN_PASSWORD_LENGTH } from "./passwordStrength";

export default function ResetPage() {
  const { config, backend } = usePlatform();
  const auth = useAuth();
  const signOut = useSignOut();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "cancel" | null>(null);
  const [done, setDone] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLInputElement | null>(null);
  const email = auth.session?.user.email ?? "";

  const finish = () => {
    // navigate first (synchronously, replacing the entry) so the guard never sees the reset route without recovery
    navigate({ name: "home" }, { replace: true });
    auth.clearRecovery();
  };

  const cancel = async () => {
    if (pending) return;
    setPending("cancel");
    // the shell shows sign-in once the recovery session has ended
    if (!(await signOut({ to: { name: "signin" } }))) setPending(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setBanner(null);
    const next: { password?: string; confirm?: string } = {};
    if (password.length < MIN_PASSWORD_LENGTH) next.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    else if (confirm !== password) next.confirm = "The passwords don’t match.";
    setErrors(next);
    if (next.password) {
      passwordRef.current?.focus();
      return;
    }
    if (next.confirm) {
      confirmRef.current?.focus();
      return;
    }
    if (isOffline()) {
      setBanner(OFFLINE_MESSAGE);
      return;
    }
    setPending("save");
    try {
      await backend.auth.updatePassword(password);
      setDone(true);
    } catch (error) {
      if (!isSilentError(error)) setBanner(errorMessage(error, "new-password"));
    } finally {
      setPending(null);
    }
  };

  if (done) {
    return (
      <AuthLayout
        icon={<AuthGlyph icon={CircleCheck} tone="success" />}
        title="Password Changed"
        subtitle="Use your new password the next time you sign in."
        footnote={dataLocationNote(config)}
      >
        <Button variant="borderedProminent" size="auth" autoFocus onClick={finish}>
          Continue to VISCERA
        </Button>
      </AuthLayout>
    );
  }

  if (!auth.recovery) {
    return (
      <AuthLayout
        icon={<AuthGlyph icon={LockKeyhole} />}
        title="Change Your Password"
        subtitle="To change your password while signed in, open Settings. You’ll confirm your current password there."
        footnote={dataLocationNote(config)}
      >
        <div className="px-auth-form__actions">
          <Button variant="borderedProminent" size="auth" onClick={() => navigate({ name: "settings", section: "security" }, { replace: true })}>
            Open Settings
          </Button>
          <Button variant="plain" size="auth" onClick={() => navigate({ name: "home" }, { replace: true })}>
            Go to Home
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      icon={<AuthGlyph icon={LockKeyhole} />}
      title="Choose a New Password"
      subtitle={email ? <>For {email}. Use at least 8 characters; a short phrase is easy to remember and hard to guess.</> : "Use at least 8 characters; a short phrase is easy to remember and hard to guess."}
      back={
        <Button variant="plain" icon={ChevronLeft} aria-disabled={pending !== null ? true : undefined} loading={pending === "cancel"} onClick={() => void cancel()}>
          Cancel
        </Button>
      }
      footnote={dataLocationNote(config)}
      busy={pending !== null}
    >
      <form className="px-auth-form" noValidate aria-label="Choose a new password" onSubmit={(event) => void submit(event)}>
        <AuthBanner message={banner} />
        {/* lets password managers file the new password under the right account */}
        <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
        <NewPasswordField
          inputRef={passwordRef}
          label="New Password"
          value={password}
          onChange={(value) => {
            setPassword(value);
            if (errors.password) setErrors(({ password: _cleared, ...rest }) => rest);
          }}
          context={[email]}
          error={errors.password}
          readOnly={pending !== null}
          autoFocus
        />
        <SecureField
          ref={confirmRef}
          label="Confirm New Password"
          size="auth"
          autoComplete="new-password"
          value={confirm}
          readOnly={pending !== null}
          error={errors.confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
            if (errors.confirm) setErrors(({ confirm: _cleared, ...rest }) => rest);
          }}
        />
        <div className="px-auth-form__actions">
          <Button type="submit" variant="borderedProminent" size="auth" loading={pending === "save"} loadingLabel="Saving…">
            Save New Password
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
