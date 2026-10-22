// Sign In (APPLE_STYLE_SPEC §3.1, DESIGN.md §7): provider buttons for the providers platform.json enables, then one
// "Email or Username" field and the password. An "@" means email (signInWithPassword); anything else is a username
// (signInWithUsername, through the auth-username function). Wrong details clear and refocus the password and keep the
// identifier. "Forgot Password?" and "Sign In with a Code" appear only when the site can deliver email.
// On success nothing navigates here: the shell's guard moves on to ?next= (or Home) once the session is announced.

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { OAuthProvider } from "../../core/types";
import { Button, SecureField, TextField } from "../../ui";
import { usePlatform } from "../../app/context";
import { errorMessage, isCredentialError, isSilentError } from "../../app/messages";
import { formatRoute, navigate } from "../../app/router";
import { AuthBanner, AuthDivider, AuthLayout, OFFLINE_MESSAGE, dataLocationNote, isOffline } from "./AuthLayout";
import { classifyIdentifier, isEmailAddress } from "./identifier";
import { ProviderButtons, enabledOAuthProviders } from "./ProviderButtons";

export interface SignInPageProps {
  /** The in-app path to return to (the router has already refused absolute URLs). */
  next?: string | undefined;
}

type Pending = "password" | OAuthProvider | null;

export default function SignInPage({ next }: SignInPageProps) {
  const { config, backend } = usePlatform();
  const { providers } = config;
  const usernames = providers.username;
  const passwordSignIn = providers.password || providers.username;
  const codeSignIn = providers.emailCode && config.emailDelivery;
  const oauth = enabledOAuthProviders(providers);

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [identifierError, setIdentifierError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const identifierRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const settleTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  // the guard normally replaces this screen within a frame; never leave the button spinning if it does not
  const settleLater = () => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setPending(null), 6000);
  };

  const fail = (error: unknown) => {
    setPending(null);
    if (isSilentError(error)) return;
    setBanner(errorMessage(error, "signin"));
    if (isCredentialError(error)) {
      setPassword("");
      passwordRef.current?.focus();
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setBanner(null);
    const classified = classifyIdentifier(identifier, { usernames });
    const identifierProblem = classified.kind === "invalid" ? classified.problem : null;
    const passwordProblem = password === "" ? "Enter your password." : null;
    setIdentifierError(identifierProblem);
    setPasswordError(passwordProblem);
    if (identifierProblem) {
      identifierRef.current?.focus();
      return;
    }
    if (passwordProblem) {
      passwordRef.current?.focus();
      return;
    }
    if (isOffline()) {
      setBanner(OFFLINE_MESSAGE);
      return;
    }
    setPending("password");
    try {
      if (classified.kind === "email") await backend.auth.signInWithPassword(classified.value, password);
      else if (classified.kind === "username") await backend.auth.signInWithUsername(classified.value, password);
      settleLater();
    } catch (error) {
      fail(error);
    }
  };

  const continueWith = async (provider: OAuthProvider) => {
    if (pending) return;
    setBanner(null);
    if (isOffline()) {
      setBanner(OFFLINE_MESSAGE);
      return;
    }
    setPending(provider);
    try {
      // Supabase navigates to the provider; the memory twin signs in on the spot
      await backend.auth.signInWithOAuth(provider);
      settleLater();
    } catch (error) {
      fail(error);
    }
  };

  const trimmed = identifier.trim();
  const codeRoute = formatRoute({
    name: "code",
    ...(isEmailAddress(trimmed) ? { email: trimmed.toLowerCase() } : {}),
    ...(next ? { next } : {}),
  });

  return (
    <AuthLayout
      title="Sign In to VISCERA"
      subtitle="Your projects, library and imports, on every device."
      footnote={dataLocationNote(config)}
      busy={pending !== null}
    >
      <ProviderButtons providers={oauth} pending={pending === "password" ? null : pending} disabled={pending !== null} onChoose={(provider) => void continueWith(provider)} />
      {oauth.length > 0 && passwordSignIn ? <AuthDivider /> : null}
      {oauth.length > 0 && !passwordSignIn ? <AuthBanner message={banner} /> : null}
      {passwordSignIn ? (
        <form className="px-auth-form" noValidate onSubmit={(event) => void submit(event)} aria-label="Sign in with your password">
          <AuthBanner message={banner} />
          <TextField
            ref={identifierRef}
            label={usernames ? "Email or Username" : "Email"}
            size="auth"
            type={usernames ? "text" : "email"}
            inputMode="email"
            name="username"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={usernames ? "name@example.com or username" : "name@example.com"}
            value={identifier}
            readOnly={pending !== null}
            error={identifierError ?? undefined}
            onChange={(event) => {
              setIdentifier(event.target.value);
              if (identifierError) setIdentifierError(null);
            }}
          />
          <SecureField
            ref={passwordRef}
            label="Password"
            size="auth"
            name="password"
            autoComplete="current-password"
            value={password}
            readOnly={pending !== null}
            error={passwordError ?? undefined}
            labelAccessory={
              config.emailDelivery ? (
                <a href={formatRoute({ name: "forgot" })} className="px-auth-link">
                  Forgot Password?
                </a>
              ) : null
            }
            onChange={(event) => {
              setPassword(event.target.value);
              if (passwordError) setPasswordError(null);
            }}
          />
          <div className="px-auth-form__actions">
            <Button type="submit" variant="borderedProminent" size="auth" loading={pending === "password"} loadingLabel="Signing In…" aria-disabled={pending !== null && pending !== "password" ? true : undefined}>
              Sign In
            </Button>
            {codeSignIn ? (
              <Button variant="plain" size="auth" aria-disabled={pending !== null ? true : undefined} onClick={() => navigate(codeRoute)}>
                Sign In with a Code
              </Button>
            ) : null}
          </div>
        </form>
      ) : codeSignIn ? (
        <Button variant="borderedProminent" size="auth" onClick={() => navigate(codeRoute)}>
          Sign In with a Code
        </Button>
      ) : null}
      <div className="px-auth-switch">
        <p className="px-auth-switch__line">
          New to VISCERA? <a href={formatRoute({ name: "signup", ...(next ? { next } : {}) })}>Create Account</a>
        </p>
        <a href={formatRoute({ name: "home" })} className="px-auth-guest">
          Continue Without an Account
        </a>
      </div>
    </AuthLayout>
  );
}
