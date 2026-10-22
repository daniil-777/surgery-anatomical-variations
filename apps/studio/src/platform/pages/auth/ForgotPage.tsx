// Reset Your Password: the recovery email carries a 6-digit code (works on any device, DESIGN.md §15.9).
// verifyRecoveryCode signs the session in as a recovery session; the shell's guard then shows "Choose a New
// Password" (ResetPage) before anything else. Unknown addresses get the same answer, and the screen is only offered
// when the site can deliver email.

import { KeyRound } from "lucide-react";
import { usePlatform } from "../../app/context";
import { formatRoute } from "../../app/router";
import { AuthLayout, dataLocationNote } from "./AuthLayout";
import { EmailCodeFlow } from "./EmailCodeFlow";

export default function ForgotPage() {
  const { config, backend } = usePlatform();
  const footer = (
    <p className="px-auth-switch__line">
      Remembered it? <a href={formatRoute({ name: "signin" })}>Sign In</a>
    </p>
  );

  if (!config.emailDelivery) {
    return (
      <AuthLayout
        title="Reset Your Password"
        subtitle="Password reset by email isn’t available on this site yet. If you can’t sign in, contact the person who runs this site."
        footnote={dataLocationNote(config)}
      >
        <div className="px-auth-switch">{footer}</div>
      </AuthLayout>
    );
  }

  return (
    <EmailCodeFlow
      emailTitle="Reset Your Password"
      emailSubtitle="Enter the email you use for VISCERA. If an account exists, we’ll email you a 6-digit code."
      emailIcon={KeyRound}
      sendLabel="Send Code"
      sendingLabel="Sending…"
      codeSubtitle={(address) => (
        <>
          If an account exists for <strong>{address}</strong>, we sent it a 6-digit code. The code expires in 60 minutes.
        </>
      )}
      verifyLabel="Continue"
      verifyingLabel="Checking…"
      context="recovery"
      send={(address) => backend.auth.sendPasswordReset(address)}
      verify={async (address, code) => {
        await backend.auth.verifyRecoveryCode(address, code);
      }}
      footer={footer}
    />
  );
}
