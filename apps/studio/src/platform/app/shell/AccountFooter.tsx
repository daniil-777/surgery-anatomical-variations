// The sidebar footer (APPLE_STYLE_SPEC §2.16): the signed-in account's row (avatar, name, plan and storage) opening
// the account menu upward, or the guest row that leads to sign-in. Built from the kit's account-row classes and Menu
// so the menu can carry the storage line and the shell's own items.

import { useId, useRef, useState } from "react";
import { ChevronsUpDown, HardDrive, Keyboard, LogOut, Settings } from "lucide-react";
import type { Session } from "../../core/types";
import {
  AccountButton,
  Avatar,
  Icon,
  Menu,
  MenuHeader,
  MenuItem,
  MenuSection,
  MenuSeparator,
  cssVars,
  cx,
  formatUsage,
  storageFraction,
  storageLevel,
} from "../../ui";
import { useSession } from "../context";
import { navigate } from "../router";
import { useThemePreference } from "./appearance";
import { accountDisplayName, useAssetUrl, useProfile, useUsage } from "./queries";
import { useSignOut } from "./session";
import "./styles/shell.css";

export interface AccountFooterProps {
  onKeyboardShortcuts: () => void;
}

export function AccountFooter({ onKeyboardShortcuts }: AccountFooterProps) {
  const session = useSession();
  const { theme, setTheme } = useThemePreference();
  if (!session) {
    return <AccountButton guest appearance={theme} onAppearanceChange={setTheme} onSignIn={() => navigate({ name: "signin" })} />;
  }
  return <SignedInAccount session={session} onKeyboardShortcuts={onKeyboardShortcuts} />;
}

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function SignedInAccount({ session, onKeyboardShortcuts }: { session: Session; onKeyboardShortcuts: () => void }) {
  const { theme, setTheme } = useThemePreference();
  const profile = useProfile().data;
  const usage = useUsage().data;
  const avatarUrl = useAssetUrl(profile?.avatarAssetId);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [initialFocus, setInitialFocus] = useState<"first" | "menu">("menu");
  const dismissedAt = useRef(0);

  const name = accountDisplayName(profile, session.user.email);
  // the quota counts reserved uploads too (DESIGN.md §15.4)
  const used = usage ? usage.usedBytes + usage.pendingBytes : 0;
  const quota = usage?.storageQuotaBytes ?? 0;
  const level = usage ? storageLevel(used, quota) : "normal";
  const subtitle = usage ? `${usage.planTitle} · ${formatUsage(used, quota)}` : " ";

  const change = (next: boolean) => {
    if (!next) dismissedAt.current = Date.now();
    setOpen(next);
  };

  const signOut = useSignOut();

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={cx("px-account-row", `px-account-row--${level}`)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          // the click that light-dismissed the menu must not reopen it
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
        <Avatar name={name} src={avatarUrl} size={28} />
        <span className="px-account-row__text">
          <span className="px-account-row__name">{name}</span>
          <span className="px-account-row__subtitle px-num">{subtitle}</span>
        </span>
        <Icon icon={ChevronsUpDown} size={12} className="px-account-row__sync" />
      </button>
      <Menu id={menuId} open={open} onOpenChange={change} anchor={anchor} placement="top-start" initialFocus={initialFocus} aria-label="Account">
        <MenuHeader>
          <span className="px-account-menu__name">{name}</span>
          {session.user.email ? <span className="px-account-menu__email">{session.user.email}</span> : null}
          {usage ? (
            <span className={cx("px-shell-menu-usage", `px-shell-menu-usage--${level}`)}>
              <span className="px-shell-menu-usage__text px-num">
                {usage.planTitle} · {formatUsage(used, quota)} used
              </span>
              <span className="px-shell-menu-usage__bar" aria-hidden="true">
                <span style={cssVars({ "--_fill": `${Math.max(storageFraction(used, quota) * 100, used > 0 ? 2 : 0)}%` })} />
              </span>
            </span>
          ) : null}
        </MenuHeader>
        <MenuSeparator />
        <MenuItem icon={Settings} shortcut="mod+," onSelect={() => navigate({ name: "settings" })}>
          Account Settings…
        </MenuItem>
        <MenuItem icon={HardDrive} onSelect={() => navigate({ name: "settings", section: "storage" })}>
          Storage…
        </MenuItem>
        <MenuSeparator />
        <MenuSection title="Appearance">
          {THEMES.map((option) => (
            <MenuItem key={option.value} type="radio" checked={theme === option.value} keepOpen onSelect={() => setTheme(option.value)}>
              {option.label}
            </MenuItem>
          ))}
        </MenuSection>
        <MenuSeparator />
        <MenuItem icon={Keyboard} shortcut="mod+/" onSelect={onKeyboardShortcuts}>
          Keyboard Shortcuts
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={LogOut} onSelect={() => void signOut()}>
          Sign Out
        </MenuItem>
      </Menu>
    </>
  );
}
