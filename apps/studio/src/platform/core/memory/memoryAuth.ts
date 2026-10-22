// In-memory Auth for the memory twin: email + password, username + password, 6-digit email codes (delivered to the
// store's outbox and an injectable mailbox), simulated OAuth, password recovery links, identities and sessions, with
// GoTrue's error codes (invalid_credentials, user_exists, weak_password, rate_limited …) and the profile trigger's
// username rules. Each MemoryAuth is one client with its own session; accounts live in the (shareable) MemoryStore.
// Events are delivered asynchronously (setTimeout 0), as the Supabase adapter does.

import type { PlatformProviders } from "../config";
import { platformError } from "../errors";
import { sha256Hex } from "../hash";
import type { AccountUser, AuthEvent, AuthPort, IdentityProvider, IsoDate, OAuthProvider, Session, SignUpInput, Uuid } from "../types";
import type { MemoryMail, MemorySessionRow, MemoryState, MemoryStore, MemoryUserRow } from "./memoryStore";
import { btrim, charLength, isValidUsername, MAX_DISPLAY_NAME_LENGTH, normalizeUsername } from "./rules";

export type { MemoryMail } from "./memoryStore";

export interface MemoryAuthOptions {
  providers: PlatformProviders;
  /** Codes and reset mails are offered only while mail is delivered (DESIGN.md §15.9). */
  emailDelivery: boolean;
  /** Sign-up waits for an emailed confirmation (Supabase "Confirm email"); off by default, as in DESIGN.md D10. */
  emailConfirmation: boolean;
  oauth: "simulate" | "disabled";
  oauthEmail: (provider: OAuthProvider) => string;
  minPasswordLength: number;
  codes: () => string;
  /** Called with every mail this client causes (after it is added to the store's outbox). */
  mailbox?: (mail: MemoryMail) => void;
  delay: () => Promise<void>;
  /** Keep the session across reloads (the persisted browser configuration). */
  persistSession: boolean;
}

const SESSION_SECONDS = 3600;
/** Password changes and account deletion need a sign-in at most this old (DESIGN.md §15.9). */
export const FRESH_SIGN_IN_SECONDS = 600;
const CODE_TTL_MS = 3600 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const MAX_PASSWORD_BYTES = 72;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function randomSixDigitCode(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto && typeof crypto.getRandomValues === "function") {
    const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    return String(value % 1_000_000).padStart(6, "0");
  }
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) throw platformError("invalid_input", { status: 400, detail: "email_address_invalid" });
  return normalized;
}

function hashPassword(salt: string, password: string): Promise<string> {
  return sha256Hex(`${salt}:${password}`);
}

function accountUser(user: MemoryUserRow): AccountUser {
  return {
    id: user.id,
    email: user.email,
    emailConfirmed: user.emailConfirmedAt !== null,
    providers: [...user.providers],
    createdAt: user.createdAt,
    lastSignInAt: user.lastSignInAt,
  };
}

export class MemoryAuth implements AuthPort {
  private readonly listeners = new Set<(event: AuthEvent, session: Session | null) => void>();
  private session: MemorySessionRow | null;

  constructor(
    private readonly store: MemoryStore,
    private readonly options: MemoryAuthOptions,
  ) {
    this.session = options.persistSession ? store.loadSession() : null;
  }

  // session ----------------------------------------------------------------------------------------------------------

  private sessionUser(state: MemoryState): MemoryUserRow | null {
    const session = this.session;
    if (!session) return null;
    const user = state.users.find((candidate) => candidate.id === session.userId);
    // "sign out everywhere" and account deletion end every other client's session
    return user && user.sessionEpoch === session.epoch ? user : null;
  }

  /** The signed-in user's id (auth.uid()), or PlatformError("not_authenticated"). */
  requireUid(state: MemoryState = this.store.state): Uuid {
    const user = this.sessionUser(state);
    if (!user) throw platformError("not_authenticated", { status: 401 });
    return user.id;
  }

  /** requireUid for sensitive changes: the sign-in must be at most ten minutes old. */
  requireFreshUid(state: MemoryState = this.store.state): Uuid {
    const uid = this.requireUid(state);
    const issuedAt = this.session?.issuedAt ?? 0;
    if (this.store.now() - issuedAt > FRESH_SIGN_IN_SECONDS * 1000) {
      throw platformError("not_authenticated", { status: 401, detail: "reauthentication_needed", message: "For your security, sign in again to continue." });
    }
    return uid;
  }

  current(): Session | null {
    const user = this.sessionUser(this.store.state);
    if (!user || !this.session) return null;
    return { user: accountUser(user), expiresAt: Math.floor(this.session.issuedAt / 1000) + SESSION_SECONDS };
  }

  ready(): Promise<Session | null> {
    return Promise.resolve(this.current());
  }

  /** The memory twin has no redirect callbacks. */
  callbackError(): null {
    return null;
  }

  onChange(listener: (event: AuthEvent, session: Session | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AuthEvent): void {
    const session = this.current();
    // only listeners subscribed now hear about it, even though delivery is deferred
    const targets = [...this.listeners];
    setTimeout(() => {
      for (const listener of targets) {
        if (!this.listeners.has(listener)) continue;
        try {
          listener(event, session);
        } catch {
          // a failing listener must not break the others
        }
      }
    }, 0);
  }

  private setSession(session: MemorySessionRow | null): void {
    this.session = session;
    if (this.options.persistSession) this.store.saveSession(session);
  }

  /** Signs this client in as `userId` (after the operation that allows it committed) and announces it. */
  private begin(userId: Uuid, event: AuthEvent = "signed_in"): Session {
    const stamp = this.store.timestamp();
    const epoch = this.store.mutate((state) => {
      const user = state.users.find((candidate) => candidate.id === userId);
      if (!user) throw platformError("not_found", { status: 404, detail: "user_not_found" });
      user.lastSignInAt = stamp;
      return user.sessionEpoch;
    });
    this.setSession({ userId, epoch, issuedAt: this.store.now() });
    const session = this.current();
    if (!session) throw platformError("unknown", { detail: "session missing after sign-in" });
    this.emit(event);
    return session;
  }

  /** Ends this client's session after its account was deleted. */
  accountDeleted(): void {
    const signedIn = this.session !== null;
    this.setSession(null);
    if (signedIn) this.emit("signed_out");
  }

  private deliver(mail: MemoryMail): void {
    this.store.outbox.push(mail);
    this.options.mailbox?.(mail);
  }

  /** private.handle_new_user: the profile row; a bad or taken username never fails the sign-up. */
  private createProfile(state: MemoryState, id: Uuid, username: string | null, displayName: string | null, now: IsoDate): void {
    let name = username !== null && isValidUsername(username) ? username : null;
    if (name !== null && state.profiles.some((profile) => profile.username === name)) name = null;
    let display = displayName === null ? null : btrim(displayName);
    if (display !== null && display.length === 0) display = null;
    if (display !== null && charLength(display) > MAX_DISPLAY_NAME_LENGTH) display = btrim([...display].slice(0, MAX_DISPLAY_NAME_LENGTH).join(""));
    state.profiles.push({ id, username: name, displayName: display, avatarAssetId: null, planId: "free", appearance: "system", createdAt: now, updatedAt: now });
  }

  private checkPassword(password: string): void {
    if (typeof password !== "string" || password.length < this.options.minPasswordLength) {
      throw platformError("weak_password", { status: 422, detail: "length" });
    }
    if (new TextEncoder().encode(password).byteLength > MAX_PASSWORD_BYTES) {
      throw platformError("invalid_input", { status: 422, detail: "password longer than 72 bytes" });
    }
  }

  private findUser(state: MemoryState, email: string): MemoryUserRow | undefined {
    return state.users.find((user) => user.email === email);
  }

  private newUser(state: MemoryState, email: string, providers: IdentityProvider[], confirmed: boolean, passwordSalt: string, passwordHash: string | null): MemoryUserRow {
    const now = this.store.timestamp();
    const user: MemoryUserRow = {
      id: this.store.newId(),
      email,
      passwordSalt,
      passwordHash,
      emailConfirmedAt: confirmed ? now : null,
      providers,
      createdAt: now,
      lastSignInAt: null,
      sessionEpoch: 0,
    };
    state.users.push(user);
    return user;
  }

  // AuthPort ---------------------------------------------------------------------------------------------------------

  async signInWithPassword(email: string, password: string): Promise<Session> {
    await this.options.delay();
    const normalized = email.trim().toLowerCase();
    const user = this.findUser(this.store.state, normalized);
    const matches = user?.passwordHash ? (await hashPassword(user.passwordSalt, password)) === user.passwordHash : false;
    if (!user || !matches) throw platformError("invalid_credentials", { status: 400, detail: "invalid_credentials" });
    if (this.options.emailConfirmation && user.emailConfirmedAt === null) {
      throw platformError("email_not_confirmed", { status: 400, detail: "email_not_confirmed" });
    }
    return this.begin(user.id);
  }

  async signInWithUsername(username: string, password: string): Promise<Session> {
    if (!this.options.providers.username) throw platformError("provider_disabled", { detail: "username" });
    await this.options.delay();
    const name = normalizeUsername(username);
    const profile = isValidUsername(name) ? this.store.state.profiles.find((candidate) => candidate.username === name) : undefined;
    const user = profile ? this.store.state.users.find((candidate) => candidate.id === profile.id) : undefined;
    // the same answer as a wrong password: usernames are not enumerable
    if (!user) throw platformError("invalid_credentials", { status: 400, detail: "invalid_credentials" });
    return this.signInWithPassword(user.email, password);
  }

  async signUp(input: SignUpInput): Promise<{ session: Session | null; needsEmailConfirmation: boolean }> {
    await this.options.delay();
    const email = normalizeEmail(input.email);
    this.checkPassword(input.password);
    let username: string | null = null;
    if (input.username !== undefined && input.username.trim() !== "") {
      username = normalizeUsername(input.username);
      if (!isValidUsername(username)) throw platformError("invalid_input", { status: 422, detail: "username" });
    }
    const displayName = input.displayName === undefined ? null : input.displayName.trim() || null;
    const salt = this.store.newId();
    const hash = await hashPassword(salt, input.password);
    const confirm = this.options.emailConfirmation;
    const outcome = this.store.mutate((state) => {
      const existing = this.findUser(state, email);
      if (existing) {
        // with confirmation on, GoTrue answers an existing address like a new one (no enumeration)
        if (confirm) return { userId: existing.id, confirmMail: existing.emailConfirmedAt === null };
        throw platformError("user_exists", { status: 422, detail: "user_already_exists" });
      }
      const user = this.newUser(state, email, ["email"], !confirm, salt, hash);
      this.createProfile(state, user.id, username, displayName, user.createdAt);
      return { userId: user.id, confirmMail: confirm };
    });
    if (confirm) {
      if (outcome.confirmMail) this.deliver({ to: email, kind: "confirmation", code: this.store.newId(), sentAt: this.store.timestamp() });
      return { session: null, needsEmailConfirmation: true };
    }
    return { session: this.begin(outcome.userId), needsEmailConfirmation: false };
  }

  async sendEmailCode(email: string, options: { createUser?: boolean } = {}): Promise<void> {
    if (!this.options.providers.emailCode || !this.options.emailDelivery) throw platformError("provider_disabled", { detail: "email_code" });
    await this.options.delay();
    const normalized = normalizeEmail(email);
    const createUser = options.createUser ?? false;
    const code = this.store.mutate((state) => {
      if (!this.findUser(state, normalized) && !createUser) {
        throw platformError("invalid_credentials", { status: 422, detail: "no_account" });
      }
      const now = this.store.now();
      const previous = state.codes.find((row) => row.email === normalized && row.kind === "email_code");
      if (previous && now - previous.sentAt < RESEND_INTERVAL_MS) {
        throw platformError("rate_limited", { status: 429, detail: "over_email_send_rate_limit" });
      }
      const value = this.options.codes();
      state.codes = state.codes.filter((row) => !(row.email === normalized && row.kind === "email_code"));
      state.codes.push({ email: normalized, kind: "email_code", code: value, sentAt: now, expiresAt: now + CODE_TTL_MS, createUser });
      return value;
    });
    this.deliver({ to: normalized, kind: "email_code", code, sentAt: this.store.timestamp() });
  }

  async verifyEmailCode(email: string, code: string): Promise<Session> {
    await this.options.delay();
    const normalized = email.trim().toLowerCase();
    const token = code.trim();
    const userId = this.store.mutate((state) => {
      const row = state.codes.find((candidate) => candidate.email === normalized && candidate.kind === "email_code");
      if (!row || row.code === "" || row.code !== token || this.store.now() > row.expiresAt) {
        throw platformError("invalid_credentials", { status: 403, detail: "otp_expired" });
      }
      // the code is spent, but the resend interval still counts from when it was sent
      row.code = "";
      row.expiresAt = 0;
      let user = this.findUser(state, normalized);
      if (!user) {
        if (!row.createUser) throw platformError("invalid_credentials", { status: 403, detail: "otp_expired" });
        user = this.newUser(state, normalized, ["email"], true, this.store.newId(), null);
        this.createProfile(state, user.id, null, null, user.createdAt);
      } else if (user.emailConfirmedAt === null) {
        user.emailConfirmedAt = this.store.timestamp();
      }
      return user.id;
    });
    return this.begin(userId);
  }

  async signInWithOAuth(provider: OAuthProvider): Promise<void> {
    if (!this.options.providers[provider] || this.options.oauth === "disabled") throw platformError("provider_disabled", { detail: provider });
    await this.options.delay();
    const email = this.options.oauthEmail(provider).trim().toLowerCase();
    const userId = this.store.mutate((state) => {
      let user = this.findUser(state, email);
      if (!user) {
        user = this.newUser(state, email, [provider], true, this.store.newId(), null);
        this.createProfile(state, user.id, null, null, user.createdAt);
      } else if (!user.providers.includes(provider)) {
        user.providers.push(provider);
      }
      return user.id;
    });
    // a real provider would navigate away; the twin signs in on the spot
    this.begin(userId);
  }

  async sendPasswordReset(email: string): Promise<void> {
    if (!this.options.emailDelivery) throw platformError("provider_disabled", { detail: "email_delivery" });
    await this.options.delay();
    const normalized = normalizeEmail(email);
    const code = this.store.mutate((state) => {
      if (!this.findUser(state, normalized)) return null;
      const now = this.store.now();
      const previous = state.codes.find((row) => row.email === normalized && row.kind === "recovery");
      if (previous && now - previous.sentAt < RESEND_INTERVAL_MS) {
        throw platformError("rate_limited", { status: 429, detail: "over_email_send_rate_limit" });
      }
      const value = this.options.codes();
      state.codes = state.codes.filter((row) => !(row.email === normalized && row.kind === "recovery"));
      state.codes.push({ email: normalized, kind: "recovery", code: value, sentAt: now, expiresAt: now + CODE_TTL_MS, createUser: false });
      return value;
    });
    // unknown addresses get the same answer and no mail (no enumeration)
    if (code) this.deliver({ to: normalized, kind: "recovery", code, sentAt: this.store.timestamp() });
  }

  /** The 6-digit code of the recovery mail (or its link): signs in, then "password_recovery". */
  async verifyRecoveryCode(email: string, code: string): Promise<Session> {
    await this.options.delay();
    const normalized = email.trim().toLowerCase();
    const token = code.trim();
    const userId = this.store.mutate((state) => {
      const row = state.codes.find((candidate) => candidate.email === normalized && candidate.kind === "recovery");
      if (!row || row.code === "" || row.code !== token || this.store.now() > row.expiresAt) {
        throw platformError("invalid_credentials", { status: 403, detail: "otp_expired" });
      }
      row.code = "";
      row.expiresAt = 0;
      const user = this.findUser(state, normalized);
      if (!user) throw platformError("invalid_credentials", { status: 403, detail: "otp_expired" });
      return user.id;
    });
    return this.begin(userId, "password_recovery");
  }

  /** Test/e2e hook: what following the sign-up confirmation link does. */
  async confirmEmail(email: string): Promise<void> {
    await this.options.delay();
    const normalized = email.trim().toLowerCase();
    this.store.mutate((state) => {
      const user = this.findUser(state, normalized);
      if (!user) throw platformError("not_found", { status: 404, detail: "user_not_found" });
      user.emailConfirmedAt ??= this.store.timestamp();
    });
  }

  /** What signInWithPassword with the account's own email does for a signed-in user: a fresh sign-in time. */
  async reauthenticate(password: string): Promise<void> {
    await this.options.delay();
    const uid = this.requireUid();
    const user = this.store.state.users.find((candidate) => candidate.id === uid) as MemoryUserRow;
    // accounts made by an email code or a provider have no password: the same answer as a wrong one
    const matches = user.passwordHash ? (await hashPassword(user.passwordSalt, password)) === user.passwordHash : false;
    if (!matches) throw platformError("invalid_credentials", { status: 400, detail: "invalid_credentials" });
    if (this.options.emailConfirmation && user.emailConfirmedAt === null) {
      throw platformError("email_not_confirmed", { status: 400, detail: "email_not_confirmed" });
    }
    const stamp = this.store.timestamp();
    const epoch = this.store.mutate((state) => {
      const row = state.users.find((candidate) => candidate.id === uid);
      if (!row) throw platformError("not_authenticated", { status: 401 });
      row.lastSignInAt = stamp;
      return row.sessionEpoch;
    });
    // the same user signs in again: no event (the Supabase adapter drops a repeated "signed_in" too)
    this.setSession({ userId: uid, epoch, issuedAt: this.store.now() });
  }

  async updatePassword(password: string): Promise<void> {
    await this.options.delay();
    const uid = this.requireFreshUid();
    this.checkPassword(password);
    const user = this.store.state.users.find((candidate) => candidate.id === uid) as MemoryUserRow;
    const hash = await hashPassword(user.passwordSalt, password);
    this.store.mutate((state) => {
      const row = state.users.find((candidate) => candidate.id === uid) as MemoryUserRow;
      if (row.passwordHash === hash) throw platformError("invalid_input", { status: 422, detail: "same_password" });
      row.passwordHash = hash;
      if (!row.providers.includes("email")) row.providers.unshift("email");
    });
    this.emit("user_updated");
  }

  async signOut(scope: "local" | "global" = "local"): Promise<void> {
    await this.options.delay();
    const user = this.sessionUser(this.store.state);
    if (scope === "global" && user) {
      this.store.mutate((state) => {
        const row = state.users.find((candidate) => candidate.id === user.id);
        if (row) row.sessionEpoch += 1;
      });
    }
    const signedIn = this.session !== null;
    this.setSession(null);
    if (signedIn && user) this.emit("signed_out");
  }

  async linkIdentity(provider: OAuthProvider): Promise<void> {
    await this.options.delay();
    const uid = this.requireUid();
    if (!this.options.providers[provider] || this.options.oauth === "disabled") throw platformError("provider_disabled", { detail: provider });
    const email = this.options.oauthEmail(provider).trim().toLowerCase();
    this.store.mutate((state) => {
      const owner = state.users.find((candidate) => candidate.id !== uid && candidate.email === email && candidate.providers.includes(provider));
      if (owner) throw platformError("user_exists", { status: 422, detail: "identity_already_exists" });
      const user = state.users.find((candidate) => candidate.id === uid) as MemoryUserRow;
      if (!user.providers.includes(provider)) user.providers.push(provider);
    });
    this.emit("user_updated");
  }

  async unlinkIdentity(provider: OAuthProvider): Promise<void> {
    await this.options.delay();
    const uid = this.requireUid();
    this.store.mutate((state) => {
      const user = state.users.find((candidate) => candidate.id === uid) as MemoryUserRow;
      if (!user.providers.includes(provider)) throw platformError("not_found", { status: 404, detail: "identity_not_found" });
      if (user.providers.length <= 1) throw platformError("invalid_input", { status: 422, detail: "single_identity_not_deletable" });
      user.providers = user.providers.filter((candidate) => candidate !== provider);
    });
    this.emit("user_updated");
  }

  async usernameAvailable(username: string): Promise<boolean> {
    await this.options.delay();
    const name = normalizeUsername(username);
    return isValidUsername(name) && !this.store.state.profiles.some((profile) => profile.username === name);
  }
}
