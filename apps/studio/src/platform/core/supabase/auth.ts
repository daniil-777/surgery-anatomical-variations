// AuthPort over supabase-js 2.118 (DESIGN.md §7): PKCE, storage key "viscera.platform.auth", the URL callback exchanged
// by supabase-js itself (detectSessionInUrl is on only when the page carries ?code=). Redirects return to the site
// URL with ?auth=callback (OAuth, sign-up confirmation, email links) or ?auth=recovery (password reset). Username
// sign-in goes through the auth-username Edge Function, which answers with a session for setSession.
//
// Listener calls are deferred with setTimeout: supabase-js holds its auth lock while notifying, and a listener that
// immediately calls back into Supabase (e.g. loads the profile) would otherwise deadlock.

import type { AuthChangeEvent, Session as SupabaseSession, SupabaseClient, User as SupabaseUser } from "@supabase/supabase-js";
import { authRedirectUrl, type SupabasePlatformConfig } from "../config";
import { fromAuthError, fromFunctionsError, fromPostgrestError, platformError, toPlatformError } from "../errors";
import type { AccountUser, AuthEvent, AuthPort, IdentityProvider, OAuthProvider, Session, SignUpInput } from "../types";
import { PlatformError } from "../types";
import { isValidUsername, normalizeUsername } from "../memory/rules";
import { normalizeTimestamp } from "./mappers";

export const AUTH_STORAGE_KEY = "viscera.platform.auth";
/** DESIGN.md §7: at least 8 characters, no composition rules (checked here even when the server allows fewer). */
export const MIN_PASSWORD_LENGTH = 8;
/** Password changes and account deletion need a sign-in at most this long ago (DESIGN.md §15.9; account-delete). */
export const FRESH_SIGN_IN_SECONDS = 600;

/**
 * When the session's user last proved who they are (epoch seconds): the newest `amr` timestamp, as the account-delete
 * function decides it. Not `iat`: Auth stamps a new `iat` on every refresh, while `amr` keeps the sign-in time.
 */
export function lastSignInAt(claims: Record<string, unknown> | null): number | null {
  const methods = claims?.amr;
  if (!Array.isArray(methods)) return null;
  let latest: number | null = null;
  for (const entry of methods) {
    const timestamp = entry !== null && typeof entry === "object" ? (entry as { timestamp?: unknown }).timestamp : undefined;
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && (latest === null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

/** The claims of a JWT (unverified: only for client-side decisions the server checks again). */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return claims !== null && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const IDENTITY_PROVIDERS: readonly IdentityProvider[] = ["email", "google", "apple", "github", "azure"];

function isIdentityProvider(value: unknown): value is IdentityProvider {
  return typeof value === "string" && (IDENTITY_PROVIDERS as readonly string[]).includes(value);
}

/** Linked sign-in methods from identities and app_metadata, "email" first. */
export function userProviders(user: SupabaseUser): IdentityProvider[] {
  const found = new Set<IdentityProvider>();
  for (const identity of user.identities ?? []) if (isIdentityProvider(identity.provider)) found.add(identity.provider);
  const metadata = user.app_metadata as { provider?: unknown; providers?: unknown } | undefined;
  if (Array.isArray(metadata?.providers)) for (const provider of metadata.providers) if (isIdentityProvider(provider)) found.add(provider);
  if (isIdentityProvider(metadata?.provider)) found.add(metadata.provider);
  return IDENTITY_PROVIDERS.filter((provider) => found.has(provider));
}

export function mapUser(user: SupabaseUser): AccountUser {
  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmed: Boolean(user.email_confirmed_at ?? user.confirmed_at),
    providers: userProviders(user),
    createdAt: normalizeTimestamp(user.created_at),
    lastSignInAt: user.last_sign_in_at ? normalizeTimestamp(user.last_sign_in_at) : null,
  };
}

export function mapSession(session: SupabaseSession): Session {
  return { user: mapUser(session.user), expiresAt: typeof session.expires_at === "number" ? session.expires_at : null };
}

function readTokens(value: unknown): { access_token: string; refresh_token: string } | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const source = record.session !== null && typeof record.session === "object" ? (record.session as Record<string, unknown>) : record;
  const access = source.access_token;
  const refresh = source.refresh_token;
  return typeof access === "string" && typeof refresh === "string" ? { access_token: access, refresh_token: refresh } : null;
}

export interface LocationLike {
  search: string;
}

export interface SupabaseAuthOptions {
  /** Navigation to an OAuth provider (default: location.assign). */
  navigate?: (url: string) => void;
  /** The page location (default: globalThis.location); null outside a browser. */
  location?: LocationLike | null;
}

export class SupabaseAuth implements AuthPort {
  private session: Session | null = null;
  private raw: SupabaseSession | null = null;
  private readonly listeners = new Set<(event: AuthEvent, session: Session | null) => void>();
  private pending: Promise<Session | null> | null = null;
  private recoveryUnheard = false;
  private callbackFailure: PlatformError | null = null;
  private readonly navigate: (url: string) => void;
  private readonly location: LocationLike | null;

  constructor(
    private readonly client: SupabaseClient,
    private readonly config: SupabasePlatformConfig,
    options: SupabaseAuthOptions = {},
  ) {
    this.navigate =
      options.navigate ??
      ((url) => {
        if (typeof location !== "undefined") location.assign(url);
      });
    this.location = options.location === undefined ? (typeof location !== "undefined" ? location : null) : options.location;
    // subscribe before supabase-js finishes initialising, so a recovery callback's event is not missed
    client.auth.onAuthStateChange((event, session) => this.handle(event, session));
  }

  private handle(event: AuthChangeEvent, session: SupabaseSession | null): void {
    const previous = this.session;
    this.raw = session;
    this.session = session ? mapSession(session) : null;
    let mapped: AuthEvent | null = null;
    switch (event) {
      case "SIGNED_IN":
        // supabase-js repeats SIGNED_IN when a tab regains focus; only a new user is news
        mapped = previous && this.session && previous.user.id === this.session.user.id ? null : "signed_in";
        break;
      case "SIGNED_OUT":
        mapped = "signed_out";
        break;
      case "TOKEN_REFRESHED":
        mapped = "token_refreshed";
        break;
      case "USER_UPDATED":
        mapped = "user_updated";
        break;
      case "PASSWORD_RECOVERY":
        mapped = "password_recovery";
        break;
      default:
        mapped = null;
    }
    if (mapped) this.dispatch(mapped);
  }

  private dispatch(event: AuthEvent): void {
    if (event === "password_recovery" && this.listeners.size === 0) {
      // the reset page subscribes after the callback was exchanged: keep the news for the first listener
      this.recoveryUnheard = true;
      return;
    }
    const session = this.session;
    // only listeners subscribed now hear about it, even though delivery is deferred
    const targets = [...this.listeners];
    setTimeout(() => {
      for (const listener of targets) {
        if (!this.listeners.has(listener)) continue;
        try {
          listener(event, session);
        } catch {
          // one failing listener must not silence the others
        }
      }
    }, 0);
  }

  private adopt(session: SupabaseSession | null): Session {
    if (!session) throw platformError("unknown", { detail: "the server answered without a session" });
    this.raw = session;
    this.session = mapSession(session);
    return this.session;
  }

  private redirect(purpose: "callback" | "recovery"): string {
    return authRedirectUrl(this.config, purpose);
  }

  private readCallbackError(): void {
    if (!this.location) return;
    const params = new URLSearchParams(this.location.search);
    if (!params.has("auth")) return;
    const description = params.get("error_description");
    const code = params.get("error_code") ?? params.get("error");
    if (!description && !code) return;
    const mapped = fromAuthError({ name: "AuthApiError", code: code ?? undefined, message: description ?? code ?? "", status: 400 });
    this.callbackFailure ??= new PlatformError(mapped.code, description ?? mapped.message, { status: mapped.status, detail: code });
  }

  // AuthPort ---------------------------------------------------------------------------------------------------------

  current(): Session | null {
    return this.session;
  }

  ready(): Promise<Session | null> {
    this.pending ??= (async () => {
      try {
        const { error } = await this.client.auth.initialize();
        if (error) this.callbackFailure = fromAuthError(error);
      } catch (error) {
        this.callbackFailure = toPlatformError(error);
      }
      try {
        const { data } = await this.client.auth.getSession();
        this.raw = data.session;
        this.session = data.session ? mapSession(data.session) : null;
      } catch {
        this.raw = null;
        this.session = null;
      }
      this.readCallbackError();
      return this.session;
    })();
    return this.pending;
  }

  /** Why an OAuth / email-link / recovery callback in the URL did not sign in (null when it did or there was none). */
  callbackError(): PlatformError | null {
    return this.callbackFailure;
  }

  onChange(listener: (event: AuthEvent, session: Session | null) => void): () => void {
    this.listeners.add(listener);
    if (this.recoveryUnheard) {
      this.recoveryUnheard = false;
      this.dispatch("password_recovery");
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves when signed in, else PlatformError("not_authenticated"); never makes a request while signed out. */
  async requireSession(): Promise<Session> {
    await this.ready();
    if (!this.session) throw platformError("not_authenticated", { status: 401 });
    return this.session;
  }

  /** requireSession for sensitive changes: the sign-in must be at most ten minutes old (the account-delete rule). */
  async requireFreshSession(): Promise<Session> {
    const session = await this.requireSession();
    const signedInAt = lastSignInAt(jwtClaims(await this.accessToken()));
    if (signedInAt === null || Math.floor(Date.now() / 1000) - signedInAt > FRESH_SIGN_IN_SECONDS) {
      throw platformError("not_authenticated", { status: 401, detail: "reauthentication_needed", message: "For your security, sign in again to continue." });
    }
    return session;
  }

  /** A current access token (refreshed by supabase-js when it is about to expire). */
  async accessToken(): Promise<string> {
    await this.requireSession();
    const { data, error } = await this.client.auth.getSession();
    if (error) throw fromAuthError(error);
    const token = data.session?.access_token;
    if (!token) throw platformError("not_authenticated", { status: 401 });
    return token;
  }

  async signInWithPassword(email: string, password: string): Promise<Session> {
    await this.ready();
    try {
      const { data, error } = await this.client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw fromAuthError(error);
      return this.adopt(data.session);
    } catch (error) {
      throw toPlatformError(error);
    }
  }

  async signInWithUsername(username: string, password: string): Promise<Session> {
    if (!this.config.providers.username) throw platformError("provider_disabled", { detail: "username" });
    const name = normalizeUsername(username);
    // a name that can never exist gets the wrong-password answer without a request
    if (!isValidUsername(name)) throw platformError("invalid_credentials", { status: 400, detail: "invalid_credentials" });
    await this.ready();
    let result: { data: unknown; error: unknown };
    try {
      result = await this.client.functions.invoke("auth-username", { body: { username: name, password } });
    } catch (error) {
      throw toPlatformError(error);
    }
    if (result.error) throw await fromFunctionsError(result.error);
    const tokens = readTokens(result.data);
    if (!tokens) throw platformError("unknown", { detail: "auth-username answered without a session" });
    try {
      const { data, error } = await this.client.auth.setSession(tokens);
      if (error) throw fromAuthError(error);
      return this.adopt(data.session);
    } catch (error) {
      throw toPlatformError(error);
    }
  }

  async signUp(input: SignUpInput): Promise<{ session: Session | null; needsEmailConfirmation: boolean }> {
    if (input.password.length < MIN_PASSWORD_LENGTH) throw platformError("weak_password", { status: 422, detail: "length" });
    let username: string | null = null;
    if (input.username !== undefined && input.username.trim() !== "") {
      username = normalizeUsername(input.username);
      if (!isValidUsername(username)) throw platformError("invalid_input", { status: 422, detail: "username" });
    }
    const metadata: Record<string, string> = {};
    if (username !== null) metadata.username = username;
    const displayName = input.displayName?.trim();
    if (displayName) metadata.display_name = displayName;
    await this.ready();
    try {
      const { data, error } = await this.client.auth.signUp({
        email: input.email.trim(),
        password: input.password,
        options: { data: metadata, emailRedirectTo: this.redirect("callback") },
      });
      if (error) throw fromAuthError(error);
      if (data.session) return { session: this.adopt(data.session), needsEmailConfirmation: false };
      return { session: null, needsEmailConfirmation: true };
    } catch (error) {
      throw toPlatformError(error);
    }
  }

  async sendEmailCode(email: string, options: { createUser?: boolean } = {}): Promise<void> {
    // codes need mail that reaches people (DESIGN.md §15.9); the built-in mailer only reaches the project team
    if (!this.config.providers.emailCode || !this.config.emailDelivery) throw platformError("provider_disabled", { detail: "email_code" });
    await this.ready();
    try {
      const { error } = await this.client.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: options.createUser ?? false, emailRedirectTo: this.redirect("callback") },
      });
      if (error) throw fromAuthError(error);
    } catch (error) {
      throw toPlatformError(error);
    }
  }

  async verifyEmailCode(email: string, code: string): Promise<Session> {
    await this.ready();
    try {
      const { data, error } = await this.client.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
      if (error) throw fromAuthError(error);
      return this.adopt(data.session);
    } catch (error) {
      throw toPlatformError(error);
    }
  }

  async signInWithOAuth(provider: OAuthProvider): Promise<void> {
    if (!this.config.providers[provider]) throw platformError("provider_disabled", { detail: provider });
    await this.ready();
    let url: string | null;
    try {
      const { data, error } = await this.client.auth.signInWithOAuth({
        provider,
        // Microsoft only returns the email address when asked for it
        options: { redirectTo: this.redirect("callback"), skipBrowserRedirect: true, ...(provider === "azure" ? { scopes: "email" } : {}) },
      });
      if (error) throw fromAuthError(error);
      url = data.url;
    } catch (error) {
      throw toPlatformError(error);
    }
    if (!url) throw platformError("unknown", { detail: "no authorize URL" });
    this.navigate(url);
  }

  async sendPasswordReset(email: string): Promise<void> {
    if (!this.config.emailDelivery) throw platformError("provider_disabled", { detail: "email_delivery" });
    await this.ready();
    try {
      const { error } = await this.client.auth.resetPasswordForEmail(email.trim(), { redirectTo: this.redirect("recovery") });
      if (error) throw fromAuthError(error);
    } catch (error) {
      throw toPlatformError(error);
    }
  }

  /** The 6-digit code of the recovery mail: signs in for a password change ("password_recovery"). */
  async verifyRecoveryCode(email: string, code: string): Promise<Session> {
    await this.ready();
    try {
      const { data, error } = await this.client.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "recovery" });
      if (error) throw fromAuthError(error);
      return this.adopt(data.session);
    } catch (error) {
      throw toPlatformError(error);
    }
  }

  /**
   * Signs in again with the account's own email and `password`: the new session's amr carries a fresh sign-in time,
   * which updatePassword and the account-delete function require. A wrong password leaves the current session as it
   * was. The session it replaces is ended on the server, so its refresh token does not linger.
   */
  async reauthenticate(password: string): Promise<void> {
    const session = await this.requireSession();
    const email = session.user.email;
    // an account without an email address has no password to check
    if (!email) throw platformError("invalid_credentials", { status: 400, detail: "invalid_credentials" });
    const previous = this.raw?.access_token ?? null;
    try {
      const { data, error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) throw fromAuthError(error);
      this.adopt(data.session);
    } catch (error) {
      throw toPlatformError(error);
    }
    if (previous && previous !== this.raw?.access_token) {
      try {
        await this.client.auth.admin.signOut(previous, "local");
      } catch {
        // best effort: an expired token ends on its own
      }
    }
  }

  async updatePassword(password: string): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) throw platformError("weak_password", { status: 422, detail: "length" });
    await this.requireFreshSession();
    try {
      const { data, error } = await this.client.auth.updateUser({ password });
      if (error) throw fromAuthError(error);
      if (data.user && this.raw) this.session = mapSession({ ...this.raw, user: data.user });
    } catch (error) {
      throw toPlatformError(error);
    }
  }

  async signOut(scope: "local" | "global" = "local"): Promise<void> {
    await this.ready();
    if (!this.session) return;
    try {
      const { error } = await this.client.auth.signOut({ scope });
      if (error) throw fromAuthError(error);
    } catch (error) {
      throw toPlatformError(error);
    }
    this.raw = null;
    this.session = null;
  }

  async linkIdentity(provider: OAuthProvider): Promise<void> {
    if (!this.config.providers[provider]) throw platformError("provider_disabled", { detail: provider });
    await this.requireSession();
    let url: string | null;
    try {
      const { data, error } = await this.client.auth.linkIdentity({
        provider,
        options: { redirectTo: this.redirect("callback"), skipBrowserRedirect: true, ...(provider === "azure" ? { scopes: "email" } : {}) },
      });
      if (error) throw fromAuthError(error);
      url = data.url;
    } catch (error) {
      throw toPlatformError(error);
    }
    if (!url) throw platformError("unknown", { detail: "no authorize URL" });
    this.navigate(url);
  }

  async unlinkIdentity(provider: OAuthProvider): Promise<void> {
    await this.requireSession();
    try {
      const { data, error } = await this.client.auth.getUserIdentities();
      if (error) throw fromAuthError(error);
      const identity = data.identities.find((candidate) => candidate.provider === provider);
      if (!identity) throw platformError("not_found", { status: 404, detail: "identity_not_found" });
      const unlinked = await this.client.auth.unlinkIdentity(identity);
      if (unlinked.error) throw fromAuthError(unlinked.error);
      // the stored session still lists the old identities until it is refreshed
      const refreshed = await this.client.auth.refreshSession();
      if (!refreshed.error && refreshed.data.session) this.adopt(refreshed.data.session);
    } catch (error) {
      throw toPlatformError(error);
    }
    this.dispatch("user_updated");
  }

  async usernameAvailable(username: string): Promise<boolean> {
    const name = normalizeUsername(username);
    if (!isValidUsername(name)) return false;
    try {
      const { data, error, status } = await this.client.rpc("username_available", { p_username: name });
      if (error) throw fromPostgrestError(error, status);
      return data === true;
    } catch (error) {
      throw toPlatformError(error);
    }
  }
}
