// The two steps shared by "Sign In with a Code" and "Reset Your Password" (APPLE_STYLE_SPEC §3.1): an email address,
// then the 6-digit code from the email (paste or one-time-code autofill, the sixth digit submits), with "Resend Code"
// once a minute and "Use a Different Email". Codes work on any device, unlike PKCE links (DESIGN.md D10).

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Mail, type LucideIcon } from "lucide-react";
import { Button, TextField, formatDuration } from "../../ui";
import { usePlatform } from "../../app/context";
import { errorCode, errorMessage, isCredentialError, isSilentError, type MessageContext } from "../../app/messages";
import { AuthBanner, AuthGlyph, AuthLayout, OFFLINE_MESSAGE, dataLocationNote, isOffline } from "./AuthLayout";
import { CODE_LENGTH, CodeInput } from "./CodeInput";
import { isEmailAddress } from "./identifier";
import { RESEND_SECONDS, useCountdown } from "./useCountdown";

export interface EmailCodeFlowProps {
  initialEmail?: string | undefined;
  /** Step 1 copy. */
  emailTitle: string;
  emailSubtitle: string;
  emailIcon: LucideIcon;
  sendLabel: string;
  sendingLabel: string;
  /** Step 2 subtitle for the address the code went to. */
  codeSubtitle: (email: string) => ReactNode;
  verifyLabel: string;
  verifyingLabel: string;
  /** Sends the code. Resolve also for unknown addresses: the screen never says whether an account exists. */
  send: (email: string) => Promise<void>;
  /** Signs in with the code; the shell's guard takes over once the session is announced. */
  verify: (email: string, code: string) => Promise<void>;
  context: Extract<MessageContext, "code" | "recovery">;
  /** Below the card (e.g. "Back to Sign In"). */
  footer: ReactNode;
}

export function EmailCodeFlow({
  initialEmail = "",
  emailTitle,
  emailSubtitle,
  emailIcon,
  sendLabel,
  sendingLabel,
  codeSubtitle,
  verifyLabel,
  verifyingLabel,
  send,
  verify,
  context,
  footer,
}: EmailCodeFlowProps) {
  const { config } = usePlatform();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState(initialEmail);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [pending, setPending] = useState<"send" | "verify" | "resend" | null>(null);
  const countdown = useCountdown();
  const emailRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const settleTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  const address = email.trim().toLowerCase();

  const sendCode = async (resend: boolean) => {
    if (pending) return;
    setBanner(null);
    if (!isEmailAddress(address)) {
      setEmailError(address === "" ? "Enter your email address." : "Enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    if (isOffline()) {
      setBanner({ tone: "error", text: OFFLINE_MESSAGE });
      return;
    }
    setPending(resend ? "resend" : "send");
    try {
      await send(address);
      countdown.start(RESEND_SECONDS);
      setStep("code");
      setCode("");
      setCodeError(null);
      if (resend) setBanner({ tone: "info", text: "We sent a new code. Codes from earlier emails no longer work." });
    } catch (error) {
      if (isSilentError(error)) return;
      if (errorCode(error) === "rate_limited" && !resend) {
        // a code went out a moment ago: let the person enter it
        countdown.start(RESEND_SECONDS);
        setStep("code");
      }
      setBanner({ tone: "error", text: errorMessage(error, context) });
    } finally {
      setPending(null);
    }
  };

  const verifyCode = async (value: string) => {
    if (pending === "verify") return;
    setBanner(null);
    if (value.length !== CODE_LENGTH) {
      setCodeError(`Enter the ${CODE_LENGTH}-digit code from the email.`);
      codeRef.current?.focus();
      return;
    }
    if (isOffline()) {
      setBanner({ tone: "error", text: OFFLINE_MESSAGE });
      return;
    }
    setPending("verify");
    try {
      await verify(address, value);
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => setPending(null), 6000);
    } catch (error) {
      setPending(null);
      if (isSilentError(error)) return;
      if (isCredentialError(error)) {
        setCode("");
        setCodeError(errorMessage(error, context));
        codeRef.current?.focus();
      } else {
        setBanner({ tone: "error", text: errorMessage(error, context) });
      }
    }
  };

  if (step === "email") {
    return (
      <AuthLayout icon={<AuthGlyph icon={emailIcon} />} title={emailTitle} subtitle={emailSubtitle} footnote={dataLocationNote(config)} busy={pending !== null}>
        <form
          className="px-auth-form"
          noValidate
          aria-label={emailTitle}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void sendCode(false);
          }}
        >
          <AuthBanner message={banner?.text} tone={banner?.tone} />
          <TextField
            ref={emailRef}
            label="Email"
            size="auth"
            type="email"
            name="email"
            autoComplete="email"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="name@example.com"
            autoFocus
            value={email}
            readOnly={pending !== null}
            error={emailError ?? undefined}
            onChange={(event) => {
              setEmail(event.target.value);
              if (emailError) setEmailError(null);
            }}
          />
          <div className="px-auth-form__actions">
            <Button type="submit" variant="borderedProminent" size="auth" loading={pending === "send"} loadingLabel={sendingLabel}>
              {sendLabel}
            </Button>
          </div>
        </form>
        <div className="px-auth-switch">{footer}</div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout icon={<AuthGlyph icon={Mail} />} title="Check Your Email" subtitle={codeSubtitle(address)} footnote={dataLocationNote(config)} busy={pending !== null}>
      <form
        className="px-auth-form"
        noValidate
        aria-label="Enter the code from the email"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void verifyCode(code);
        }}
      >
        <AuthBanner message={banner?.text} tone={banner?.tone} />
        <CodeInput
          inputRef={codeRef}
          value={code}
          autoFocus
          disabled={pending === "verify"}
          error={codeError}
          onChange={(value) => {
            setCode(value);
            if (codeError) setCodeError(null);
          }}
          onComplete={(value) => void verifyCode(value)}
        />
        <div className="px-auth-form__actions">
          <Button type="submit" variant="borderedProminent" size="auth" loading={pending === "verify"} loadingLabel={verifyingLabel}>
            {verifyLabel}
          </Button>
        </div>
        <div className="px-auth-form__row">
          <Button
            variant="plain"
            aria-disabled={countdown.remaining > 0 || pending !== null ? true : undefined}
            loading={pending === "resend"}
            loadingLabel="Sending…"
            onClick={() => void sendCode(true)}
          >
            {countdown.remaining > 0 ? (
              <span className="px-num">Resend in {formatDuration(countdown.remaining)}</span>
            ) : (
              "Resend Code"
            )}
          </Button>
          <Button
            variant="plain"
            aria-disabled={pending !== null ? true : undefined}
            onClick={() => {
              setStep("email");
              setBanner(null);
              setCode("");
              setCodeError(null);
            }}
          >
            Use a Different Email
          </Button>
        </div>
      </form>
      <div className="px-auth-switch">{footer}</div>
    </AuthLayout>
  );
}
