// Sign In with a Code: a 6-digit code by email (signInWithOtp + verifyOtp), offered only when platform.json enables
// email codes and the site can deliver mail (DESIGN.md D10, §15.9). Codes never create accounts here, and an unknown
// address gets the same "Check Your Email" step as a known one, so the screen reveals nothing about who has an account.

import { KeyRound } from "lucide-react";
import { isPlatformError } from "../../core/types";
import { usePlatform } from "../../app/context";
import { formatRoute } from "../../app/router";
import { AuthLayout, dataLocationNote } from "./AuthLayout";
import { EmailCodeFlow } from "./EmailCodeFlow";

export interface CodePageProps {
  email?: string | undefined;
  next?: string | undefined;
}

export default function CodePage({ email, next }: CodePageProps) {
  const { config, backend } = usePlatform();
  const signInLink = formatRoute({ name: "signin", ...(next ? { next } : {}) });
  const footer = (
    <p className="px-auth-switch__line">
      <a href={signInLink}>Sign In with Your Password</a>
    </p>
  );

  if (!config.providers.emailCode || !config.emailDelivery) {
    return (
      <AuthLayout title="Sign In with a Code" subtitle="Signing in with an emailed code isn’t available on this site yet." footnote={dataLocationNote(config)}>
        <div className="px-auth-switch">{footer}</div>
      </AuthLayout>
    );
  }

  return (
    <EmailCodeFlow
      initialEmail={email}
      emailTitle="Sign In with a Code"
      emailSubtitle="We’ll email you a 6-digit code. No password needed."
      emailIcon={KeyRound}
      sendLabel="Send Code"
      sendingLabel="Sending…"
      codeSubtitle={(address) => (
        <>
          If an account exists for <strong>{address}</strong>, we sent it a 6-digit code. The code expires in 60 minutes.
        </>
      )}
      verifyLabel="Sign In"
      verifyingLabel="Signing In…"
      context="code"
      send={async (address) => {
        try {
          await backend.auth.sendEmailCode(address, { createUser: false });
        } catch (error) {
          // no account for this address: answer exactly as for one (no enumeration)
          if (isPlatformError(error, "invalid_credentials") || isPlatformError(error, "not_found")) return;
          throw error;
        }
      }}
      verify={async (address, code) => {
        await backend.auth.verifyEmailCode(address, code);
      }}
      footer={footer}
    />
  );
}
