// Create Account (APPLE_STYLE_SPEC §3.1, DESIGN.md §7): the same provider buttons, then name, email, an optional
// username (availability checked while typing, debounced) and a password with the live strength hint. With email
// confirmation on, the account waits for the emailed link; otherwise the shell moves on to Home with a welcome HUD.
// A username taken between the check and the submit never fails sign-up (the profile trigger drops it): the person is
// told and can pick another in Settings.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, MailCheck } from "lucide-react";
import type { OAuthProvider } from "../../core/types";
import { Button, Icon, TextField, useHud, useToast } from "../../ui";
import { usePlatform } from "../../app/context";
import { errorMessage, isSilentError } from "../../app/messages";
import { formatRoute } from "../../app/router";
import { AuthBanner, AuthDivider, AuthGlyph, AuthLayout, OFFLINE_MESSAGE, dataLocationNote, isOffline, signUpPrivacyNote } from "./AuthLayout";
import { isEmailAddress, normalizeUsernameInput, usernameProblem } from "./identifier";
import { NewPasswordField } from "./NewPasswordField";
import { MIN_PASSWORD_LENGTH } from "./passwordStrength";
import { ProviderButtons, enabledOAuthProviders } from "./ProviderButtons";
import { useUsernameAvailability } from "./useUsernameAvailability";

export interface SignUpPageProps {
  next?: string | undefined;
}

type Pending = "form" | OAuthProvider | null;

export default function SignUpPage({ next }: SignUpPageProps) {
  const { config, backend } = usePlatform();
  const hud = useHud();
  const toast = useToast();
  const oauth = enabledOAuthProviders(config.providers);
  const emailSignUp = config.providers.password;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; username?: string; password?: string }>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const normalizedUsername = normalizeUsernameInput(username);
  const shapeProblem = config.providers.username ? usernameProblem(normalizedUsername) : null;
  const availability = useUsernameAvailability(config.providers.username && !shapeProblem ? normalizedUsername : "");

  useEffect(() => {
    if (errors.username && availability === "available") setErrors(({ username: _cleared, ...rest }) => rest);
  }, [availability, errors.username]);

  const validate = (): boolean => {
    const next: { email?: string; username?: string; password?: string } = {};
    if (email.trim() === "") next.email = "Enter your email address.";
    else if (!isEmailAddress(email)) next.email = "Enter a valid email address.";
    if (shapeProblem) next.username = shapeProblem;
    else if (availability === "taken") next.username = "That username is taken. Choose another one.";
    if (password.length < MIN_PASSWORD_LENGTH) next.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    setErrors(next);
    if (next.email) emailRef.current?.focus();
    else if (next.username) usernameRef.current?.focus();
    else if (next.password) passwordRef.current?.focus();
    return Object.keys(next).length === 0;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setBanner(null);
    if (!validate()) return;
    if (isOffline()) {
      setBanner(OFFLINE_MESSAGE);
      return;
    }
    setPending("form");
    const requested = normalizedUsername || null;
    const address = email.trim().toLowerCase();
    try {
      const result = await backend.auth.signUp({
        email: address,
        password,
        ...(requested ? { username: requested } : {}),
        ...(name.trim() ? { displayName: name.trim() } : {}),
      });
      if (result.needsEmailConfirmation || !result.session) {
        setPending(null);
        setConfirmationSentTo(address);
        return;
      }
      hud({ label: "Welcome to VISCERA", icon: Check });
      if (requested) {
        backend.account.profile().then(
          (profile) => {
            if (profile.username !== requested) {
              toast.show({ tone: "warning", message: `The username “${requested}” was taken a moment ago. Choose another one in Settings.` });
            }
          },
          () => undefined,
        );
      }
      // the shell's guard continues to ?next= or Home once the session is announced
    } catch (error) {
      setPending(null);
      if (!isSilentError(error)) setBanner(errorMessage(error, "signup"));
    }
  };

  const continueWith = async (provider: OAuthProvider) => {
    if (pending) return;
    setBanner(null);
    setPending(provider);
    try {
      await backend.auth.signInWithOAuth(provider);
    } catch (error) {
      setPending(null);
      if (!isSilentError(error)) setBanner(errorMessage(error, "signup"));
    }
  };

  if (confirmationSentTo) {
    return (
      <AuthLayout
        icon={<AuthGlyph icon={MailCheck} />}
        title="Confirm Your Email"
        subtitle={
          <>
            We sent a confirmation link to <strong>{confirmationSentTo}</strong>. Open it on this device to finish creating your
            account.
          </>
        }
        footnote={dataLocationNote(config)}
      >
        <div className="px-auth-switch">
          <a href={formatRoute({ name: "signin", ...(next ? { next } : {}) })}>Back to Sign In</a>
        </div>
      </AuthLayout>
    );
  }

  const usernameHint =
    availability === "checking" ? (
      "Checking availability…"
    ) : availability === "available" ? (
      <span className="px-auth-field-status px-auth-field-status--ok">
        <Icon icon={Check} size={12} /> “{normalizedUsername}” is available.
      </span>
    ) : (
      "You can sign in with it instead of your email."
    );
  const usernameError = errors.username ?? (normalizedUsername !== "" ? shapeProblem : null) ?? (availability === "taken" ? "That username is taken. Choose another one." : null);

  return (
    <AuthLayout title="Create Your Account" subtitle="One account for your projects, library and imports." footnote={dataLocationNote(config)} busy={pending !== null}>
      <ProviderButtons providers={oauth} pending={pending === "form" ? null : pending} disabled={pending !== null} onChoose={(provider) => void continueWith(provider)} />
      {oauth.length > 0 && emailSignUp ? <AuthDivider /> : null}
      {emailSignUp ? (
        <form className="px-auth-form" noValidate onSubmit={(event) => void submit(event)} aria-label="Create an account with your email">
          <AuthBanner message={banner} />
          <TextField
            label="Name"
            size="auth"
            name="name"
            autoComplete="name"
            placeholder="Your name"
            maxLength={80}
            value={name}
            readOnly={pending !== null}
            onChange={(event) => setName(event.target.value)}
          />
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
            value={email}
            readOnly={pending !== null}
            error={errors.email}
            onBlur={() => {
              if (email.trim() !== "" && !isEmailAddress(email)) setErrors((current) => ({ ...current, email: "Enter a valid email address." }));
            }}
            onChange={(event) => {
              setEmail(event.target.value);
              if (errors.email) setErrors(({ email: _cleared, ...rest }) => rest);
            }}
          />
          {config.providers.username ? (
            <TextField
              ref={usernameRef}
              label="Username"
              size="auth"
              name="username"
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. daniil"
              maxLength={30}
              value={username}
              readOnly={pending !== null}
              labelAccessory={<span className="px-auth-optional">Optional</span>}
              hint={usernameHint}
              error={usernameError ?? undefined}
              onChange={(event) => {
                setUsername(event.target.value.toLowerCase());
                if (errors.username) setErrors(({ username: _cleared, ...rest }) => rest);
              }}
            />
          ) : null}
          <NewPasswordField
            inputRef={passwordRef}
            value={password}
            onChange={(value) => {
              setPassword(value);
              if (errors.password) setErrors(({ password: _cleared, ...rest }) => rest);
            }}
            context={[name, email, username]}
            error={errors.password}
            readOnly={pending !== null}
          />
          <div className="px-auth-form__actions">
            <Button type="submit" variant="borderedProminent" size="auth" loading={pending === "form"} loadingLabel="Creating Account…">
              Create Account
            </Button>
          </div>
          <p className="px-auth-legal">{signUpPrivacyNote(config)}</p>
        </form>
      ) : null}
      <div className="px-auth-switch">
        <p className="px-auth-switch__line">
          Already have an account? <a href={formatRoute({ name: "signin", ...(next ? { next } : {}) })}>Sign In</a>
        </p>
        <a href={formatRoute({ name: "home" })} className="px-auth-guest">
          Continue Without an Account
        </a>
      </div>
    </AuthLayout>
  );
}
