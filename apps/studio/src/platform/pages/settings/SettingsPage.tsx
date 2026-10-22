// Settings (#/settings[/section]): the account sheet of APPLE_STYLE_SPEC §3.7 as a page of grouped sections, macOS
// Settings style — Profile, Appearance, Security, Sign-In Methods, Storage & Plan, Data & Privacy. Appearance and
// sign-in methods apply at once; text fields save with Save Changes. #/settings/<section> scrolls to that section.

import { useEffect } from "react";
import { Avatar, Badge, Button, EmptyState } from "../../ui";
import { CircleAlert } from "lucide-react";
import { useSession } from "../../app/context";
import { errorMessage } from "../../app/messages";
import { PageLoading } from "../../app/shell/Loading";
import { Page } from "../../app/shell/Page";
import { PageToolbar } from "../../app/shell/PageToolbar";
import { accountDisplayName, useAssetUrl, useProfile, useUsage } from "../../app/shell/queries";
import { formatShortDate } from "../../app/shell/time";
import { AppearanceSection } from "./AppearanceSection";
import { PrivacySection } from "./PrivacySection";
import { ProfileSection } from "./ProfileSection";
import { SecuritySection } from "./SecuritySection";
import { SignInMethodsSection } from "./SignInMethodsSection";
import { StorageSection } from "./StorageSection";
import "./settings.css";

/** The sections #/settings/<section> can name. */
export const SETTINGS_SECTIONS = ["profile", "appearance", "security", "sign-in", "storage", "privacy"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const sectionId = (section: SettingsSection) => `px-settings-${section}`;

export interface SettingsPageProps {
  section?: string | undefined;
}

export default function SettingsPage({ section }: SettingsPageProps) {
  const session = useSession();
  const profile = useProfile();
  const usage = useUsage();
  const ready = profile.data !== undefined;

  useEffect(() => {
    if (!ready || !section) return;
    const known = SETTINGS_SECTIONS.find((candidate) => candidate === section);
    if (known) document.getElementById(sectionId(known))?.scrollIntoView({ block: "start" });
  }, [ready, section]);

  if (!session) return null;
  if (!profile.data) {
    return (
      <>
        <PageToolbar title="Settings" />
        {profile.error !== undefined && !profile.loading ? (
          <div className="px-shell-error">
            <EmptyState
              icon={CircleAlert}
              title="Couldn’t Load Settings"
              description={errorMessage(profile.error, "load")}
              action={<Button onClick={() => void profile.refresh()}>Try Again</Button>}
            />
          </div>
        ) : (
          <PageLoading label="Loading settings" />
        )}
      </>
    );
  }

  const name = accountDisplayName(profile.data, session.user.email);
  return (
    <>
      <PageToolbar title="Settings" />
      <Page width="narrow" className="px-settings">
        <SettingsHeader name={name} email={session.user.email} avatarAssetId={profile.data.avatarAssetId} plan={usage.data?.planTitle} since={profile.data.createdAt} />
        <ProfileSection id={sectionId("profile")} profile={profile.data} session={session} />
        <AppearanceSection id={sectionId("appearance")} />
        <SecuritySection id={sectionId("security")} session={session} />
        <SignInMethodsSection id={sectionId("sign-in")} session={session} />
        {usage.data ? (
          <StorageSection id={sectionId("storage")} usage={usage.data} />
        ) : (
          <section id={sectionId("storage")} className="px-settings-section" aria-label="Storage and Plan">
            <PageLoading label="Loading storage" />
          </section>
        )}
        <PrivacySection id={sectionId("privacy")} session={session} usage={usage.data} />
      </Page>
    </>
  );
}

function SettingsHeader({ name, email, avatarAssetId, plan, since }: { name: string; email: string | null; avatarAssetId: string | null; plan: string | undefined; since: string }) {
  const avatarUrl = useAssetUrl(avatarAssetId);
  return (
    <header className="px-settings-header">
      <Avatar name={name} src={avatarUrl} size={64} />
      <div className="px-settings-header__text">
        <h2 className="px-settings-header__name">{name}</h2>
        {email ? <p className="px-settings-header__email">{email}</p> : null}
        <p className="px-settings-header__meta">
          {plan ? <Badge tone="accent">{plan}</Badge> : null}
          <span>Member since {formatShortDate(since)}</span>
        </p>
      </div>
    </header>
  );
}
