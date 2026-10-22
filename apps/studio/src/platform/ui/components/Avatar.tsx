import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, CircleHelp, CloudOff, HardDrive, Keyboard, LogIn, LogOut, Settings } from "lucide-react";
import { cssVars, cx } from "../lib/dom";
import { initials, type StorageLevel } from "../lib/format";
import type { PxTheme } from "../lib/theme";
import { Icon } from "./Icon";
import { Menu, MenuHeader, MenuItem, MenuSection, MenuSeparator } from "./Menu";
import { Spinner } from "./Progress";
import "./avatar.css";

export interface AvatarProps {
  name?: string | null | undefined;
  /** A signed URL; falls back to initials when missing or broken. */
  src?: string | null | undefined;
  /** 16 (version rows), 24, 28 (sidebar), 64 (Account sheet). */
  size?: number | undefined;
  /** Names the avatar for assistive technology; empty (default) when a visible name sits next to it. */
  alt?: string | undefined;
  className?: string | undefined;
}

/** Circular photo or Contacts-style initials on a grey gradient (§2.16). */
export function Avatar({ name, src, size = 28, alt = "", className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span
      className={cx("px-avatar", className)}
      style={cssVars({ "--_size": `${size}px` })}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      {src && !failed ? (
        <img src={src} alt="" width={size} height={size} decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="px-avatar__initials">{initials(name)}</span>
      )}
    </span>
  );
}

export type SyncState = "synced" | "syncing" | "offline";

export interface AccountMenuContentProps {
  name: string;
  email?: string | null | undefined;
  appearance: PxTheme;
  onAppearanceChange: (theme: PxTheme) => void;
  onAccountSettings?: (() => void) | undefined;
  onStorage?: (() => void) | undefined;
  onKeyboardShortcuts?: (() => void) | undefined;
  onHelp?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
}

/** The account menu's items (§2.16), usable inside any <Menu>. */
export function AccountMenuContent({
  name,
  email,
  appearance,
  onAppearanceChange,
  onAccountSettings,
  onStorage,
  onKeyboardShortcuts,
  onHelp,
  onSignOut,
}: AccountMenuContentProps) {
  return (
    <>
      <MenuHeader>
        <span className="px-account-menu__name">{name}</span>
        {email ? <span className="px-account-menu__email">{email}</span> : null}
      </MenuHeader>
      <MenuSeparator />
      <MenuItem icon={Settings} shortcut="mod+," onSelect={onAccountSettings} disabled={!onAccountSettings}>
        Account Settings…
      </MenuItem>
      <MenuItem icon={HardDrive} onSelect={onStorage} disabled={!onStorage}>
        Storage…
      </MenuItem>
      <MenuSeparator />
      <MenuSection title="Appearance">
        {(["system", "light", "dark"] as const).map((theme) => (
          <MenuItem key={theme} type="radio" checked={appearance === theme} keepOpen onSelect={() => onAppearanceChange(theme)}>
            {theme === "system" ? "System" : theme === "light" ? "Light" : "Dark"}
          </MenuItem>
        ))}
      </MenuSection>
      <MenuSeparator />
      <MenuItem icon={Keyboard} shortcut="mod+/" onSelect={onKeyboardShortcuts} disabled={!onKeyboardShortcuts}>
        Keyboard Shortcuts
      </MenuItem>
      <MenuItem icon={CircleHelp} onSelect={onHelp} disabled={!onHelp}>
        Help &amp; Feedback
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={LogOut} onSelect={onSignOut} disabled={!onSignOut}>
        Sign Out
      </MenuItem>
    </>
  );
}

export interface AccountButtonProps extends Omit<AccountMenuContentProps, "name"> {
  /** Display name; ignored for guests. */
  name?: string | undefined;
  avatarSrc?: string | null | undefined;
  /** "Pro · 3.2 of 50 GB". */
  subtitle?: ReactNode;
  /** Colours the subtitle at ≥ 90 % (warning) and 100 % (full). */
  usageLevel?: StorageLevel | undefined;
  sync?: SyncState | undefined;
  /** Signed-out shells: the row reads "Guest · Sign In" and signs in directly. */
  guest?: boolean | undefined;
  onSignIn?: (() => void) | undefined;
}

const SYNC_LABEL: Record<SyncState, string> = { synced: "Synced", syncing: "Syncing", offline: "Offline" };

/** The sidebar footer (§2.16): a 48 px row that opens the account menu upward. Presentational: the app wires it. */
export function AccountButton({ name = "", email, avatarSrc, subtitle, usageLevel = "normal", sync, guest = false, onSignIn, ...menu }: AccountButtonProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [initialFocus, setInitialFocus] = useState<"first" | "menu">("menu");
  const dismissedAt = useRef(0);
  const change = (next: boolean) => {
    if (!next) dismissedAt.current = Date.now();
    setOpen(next);
  };

  if (guest) {
    return (
      <button type="button" className="px-account-row" onClick={onSignIn}>
        <Avatar name={null} size={28} />
        <span className="px-account-row__text">
          <span className="px-account-row__name">Guest</span>
          <span className="px-account-row__subtitle">Sign in to save your work</span>
        </span>
        <Icon icon={LogIn} size={14} className="px-account-row__sync" />
      </button>
    );
  }

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={cx("px-account-row", `px-account-row--${usageLevel}`)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          if (!open && Date.now() - dismissedAt.current < 250) return;
          setInitialFocus(event.detail === 0 ? "first" : "menu");
          change(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setInitialFocus("first");
            change(true);
          }
        }}
      >
        <Avatar name={name} src={avatarSrc} size={28} />
        <span className="px-account-row__text">
          <span className="px-account-row__name">{name}</span>
          {subtitle ? <span className="px-account-row__subtitle px-num">{subtitle}</span> : null}
        </span>
        {sync ? (
          <span className={cx("px-account-row__sync", `px-account-row__sync--${sync}`)}>
            {sync === "syncing" ? <Spinner size={12} /> : <Icon icon={sync === "offline" ? CloudOff : Check} size={12} />}
            <span className="px-visually-hidden">{SYNC_LABEL[sync]}</span>
          </span>
        ) : null}
      </button>
      <Menu id={menuId} open={open} onOpenChange={change} anchor={anchor} placement="top-start" initialFocus={initialFocus} aria-label="Account">
        <AccountMenuContent name={name} email={email} {...menu} />
      </Menu>
    </>
  );
}
