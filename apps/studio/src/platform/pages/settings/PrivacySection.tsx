// Settings ▸ Data & Privacy: where the account's data lives and what is kept (DESIGN.md §11), and Delete Account:
// the typed word DELETE plus the current password (a fresh sign-in, §15.9), then account.deleteAccount, which removes
// every file and row; the shell then shows Home signed out.

import { useState } from "react";
import type { Session, Usage } from "../../core/types";
import { Button, FormGroup, FormRow, SecureField, Sheet, TextField, useToast } from "../../ui";
import { usePlatform } from "../../app/context";
import { errorMessage, isCredentialError, isSilentError } from "../../app/messages";
import { setAfterSignOut } from "../../app/shell/session";
import { AuthBanner } from "../auth/AuthLayout";

export function PrivacySection({ id, session, usage }: { id: string; session: Session; usage: Usage | undefined }) {
  const { config } = usePlatform();
  const [deleting, setDeleting] = useState(false);
  const memory = config.backend === "memory";
  return (
    <section id={id} className="px-settings-section" aria-label="Data and Privacy">
      <FormGroup title="Data & Privacy" footer="Labs that promise to keep files on this device keep that promise: those files are never uploaded, only a fingerprint that tells a project which file it needs.">
        <FormRow label="Stored In" description={memory ? "This preview keeps no data on a server." : "With Supabase, in its EU region."}>
          <span className="px-settings-value">{memory ? "This browser" : "The European Union"}</span>
        </FormRow>
        <FormRow label="What’s Stored" description="Your email address, profile, projects and their versions, library items and imports." />
        <FormRow label="Analytics and Tracking">
          <span className="px-settings-value">None</span>
        </FormRow>
      </FormGroup>
      <FormGroup title="Delete Account" footer="Deleting your account removes it and everything in it from VISCERA at once. It can’t be undone.">
        <FormRow label="Delete Account" description="Your projects, versions, library, imports and files are deleted with it.">
          <Button variant="destructive" onClick={() => setDeleting(true)}>
            Delete Account…
          </Button>
        </FormRow>
      </FormGroup>
      <DeleteAccountSheet open={deleting} onClose={() => setDeleting(false)} session={session} usage={usage} />
    </section>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${new Intl.NumberFormat("en-US").format(count)} ${count === 1 ? one : many}`;
}

function DeleteAccountSheet({ open, onClose, session, usage }: { open: boolean; onClose: () => void; session: Session; usage: Usage | undefined }) {
  const { backend } = usePlatform();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // accounts that only ever used Apple, Google … have no password: a fresh sign-in is enough for the server
  const hasPassword = session.user.providers.includes("email");
  const ready = typed === "DELETE" && (!hasPassword || password !== "");

  const close = () => {
    if (busy) return;
    setPassword("");
    setTyped("");
    setPasswordError(null);
    setBanner(null);
    onClose();
  };

  const remove = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setBanner(null);
    setPasswordError(null);
    try {
      if (hasPassword) await backend.auth.reauthenticate(password);
    } catch (error) {
      setBusy(false);
      if (isSilentError(error)) return;
      if (isCredentialError(error)) {
        setPassword("");
        setPasswordError(errorMessage(error, "delete-account"));
      } else setBanner(errorMessage(error, "delete-account"));
      return;
    }
    setAfterSignOut({ name: "home" });
    try {
      await backend.account.deleteAccount("DELETE");
      toast.show({ tone: "success", message: "Your account and everything in it were deleted." });
    } catch (error) {
      setAfterSignOut(null);
      setBusy(false);
      if (!isSilentError(error)) setBanner(errorMessage(error, "delete-account"));
    }
  };

  const contents = usage
    ? `${plural(usage.projectCount, "project", "projects")} with ${plural(usage.versionCount, "version", "versions")}, ${plural(usage.libraryCount, "library item", "library items")}, ${plural(usage.importCount, "import", "imports")}`
    : "all of your projects, versions, library items and imports";

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Delete Account"
      description={session.user.email ?? undefined}
      size="small"
      actions={
        <>
          <Button onClick={close} aria-disabled={busy ? true : undefined}>
            Cancel
          </Button>
          <Button variant="destructiveProminent" loading={busy} loadingLabel="Deleting…" aria-disabled={!ready ? true : undefined} onClick={() => void remove()}>
            Delete Account
          </Button>
        </>
      }
    >
      <form
        className="px-settings-sheet-form"
        noValidate
        aria-label="Delete your account"
        onSubmit={(event) => {
          event.preventDefault();
          void remove();
        }}
      >
        <AuthBanner message={banner} />
        <p className="px-settings-warning">
          This permanently deletes your account and everything in it: {contents}, plus anything in the Trash and every
          file they use. You can’t undo this.
        </p>
        {hasPassword ? (
          <>
            <input type="text" name="username" autoComplete="username" value={session.user.email ?? ""} readOnly hidden />
            <SecureField
              label="Password"
              autoComplete="current-password"
              value={password}
              error={passwordError ?? undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setPasswordError(null);
              }}
            />
          </>
        ) : null}
        <TextField
          label="Type DELETE to confirm"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
