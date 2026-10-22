// The sign-in card (APPLE_STYLE_SPEC §3.1): a centred glass card over a soft two-colour backdrop, the VISCERA mark,
// a Title 1 heading and the step's content. Every auth screen (sign in, create account, code, reset) uses it.

import type { ReactNode } from "react";
import { CircleAlert, Info, type LucideIcon } from "lucide-react";
import type { EnabledPlatformConfig } from "../../core/config";
import { AppMark, Icon, cx } from "../../ui";
import "./auth.css";

export interface AuthLayoutProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Replaces the app mark (a mail glyph while waiting for a code, a check when done). */
  icon?: ReactNode;
  /** A "‹ Back" button, top-left inside the card. */
  back?: ReactNode;
  /** Below the card: the data-location note. */
  footnote?: ReactNode;
  busy?: boolean | undefined;
  children?: ReactNode;
}

export function AuthLayout({ title, subtitle, icon, back, footnote, busy = false, children }: AuthLayoutProps) {
  return (
    <div className="px-auth">
      <main className="px-auth__main" aria-busy={busy || undefined}>
        <div className="px-auth__card">
          {back ? <div className="px-auth__back">{back}</div> : null}
          <div className="px-auth__icon">{icon ?? <AppMark size={64} title="VISCERA" />}</div>
          <h1 className="px-auth__title">{title}</h1>
          {subtitle ? <p className="px-auth__subtitle">{subtitle}</p> : null}
          {children ? <div className="px-auth__body">{children}</div> : null}
        </div>
        {footnote ? <p className="px-auth__footnote">{footnote}</p> : null}
      </main>
    </div>
  );
}

/** A round glyph in place of the app mark (Mail, KeyRound, CircleCheck …). */
export function AuthGlyph({ icon, tone = "accent" }: { icon: LucideIcon; tone?: "accent" | "success" }) {
  return (
    <span className={cx("px-auth-glyph", tone === "success" && "px-auth-glyph--success")}>
      <Icon icon={icon} size={30} />
    </span>
  );
}

/** Errors above the form (role=alert) or neutral information (role=status). */
export function AuthBanner({ message, tone = "error" }: { message: ReactNode; tone?: "error" | "info" | undefined }) {
  if (message === null || message === undefined || message === "") return null;
  return (
    <div className={cx("px-auth-banner", tone === "info" && "px-auth-banner--info")} role={tone === "error" ? "alert" : "status"}>
      <Icon icon={tone === "error" ? CircleAlert : Info} size={16} className="px-auth-banner__icon" />
      <p className="px-auth-banner__text">{message}</p>
    </div>
  );
}

/** "or", between the provider buttons and the email form. */
export function AuthDivider() {
  return (
    <div className="px-auth-divider" role="separator" aria-label="or">
      <span aria-hidden="true">or</span>
    </div>
  );
}

/** Where accounts live, said plainly under the card. */
export function dataLocationNote(config: EnabledPlatformConfig): string {
  if (config.backend === "memory") {
    return config.persist ? "Preview mode: accounts are kept in this browser only." : "Preview mode: accounts are kept in this browser tab only.";
  }
  return "Your account and files are stored in the EU.";
}

/** The sign-up line about data (the task's terms/privacy line). */
export function signUpPrivacyNote(config: EnabledPlatformConfig): string {
  if (config.backend === "memory") return "Preview mode: nothing you enter leaves this browser.";
  return "VISCERA stores your account, projects and files in the EU with Supabase. No analytics or advertising trackers.";
}

export const OFFLINE_MESSAGE = "You’re offline. Connect to the internet and try again.";

/** True when the browser knows it has no connection (navigator.onLine is only reliable when false). */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}
