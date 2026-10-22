// Settings ▸ Sign-In Methods: the identities linked to the account (AccountUser.providers). Apple, Google, GitHub and
// Microsoft can be connected or disconnected only when platform.json enables them; the last way to sign in can never
// be disconnected.

import { useState, type ReactNode } from "react";
import { Check, Mail } from "lucide-react";
import type { OAuthProvider, Session } from "../../core/types";
import { Alert, Button, FormGroup, FormRow, Icon, useToast } from "../../ui";
import { usePlatform } from "../../app/context";
import { errorMessage, isSilentError } from "../../app/messages";
import { ProviderLogo, enabledOAuthProviders, providerName } from "../auth/ProviderButtons";

export function SignInMethodsSection({ id, session }: { id: string; session: Session }) {
  const { config, backend } = usePlatform();
  const toast = useToast();
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [disconnecting, setDisconnecting] = useState<OAuthProvider | null>(null);
  const linked = session.user.providers;
  const providers = enabledOAuthProviders(config.providers);
  const onlyOne = linked.length <= 1;

  const connect = async (provider: OAuthProvider) => {
    setBusy(provider);
    try {
      // Supabase leaves for the provider and comes back signed in; the memory twin links on the spot
      await backend.auth.linkIdentity(provider);
    } catch (error) {
      if (!isSilentError(error)) toast.show({ tone: "error", message: errorMessage(error, "identity") });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (provider: OAuthProvider) => {
    setBusy(provider);
    try {
      await backend.auth.unlinkIdentity(provider);
      toast.show({ tone: "success", message: `${providerName(provider)} is no longer connected.` });
    } catch (error) {
      if (!isSilentError(error)) toast.show({ tone: "error", message: errorMessage(error, "identity") });
    } finally {
      setBusy(null);
      setDisconnecting(null);
    }
  };

  return (
    <section id={id} className="px-settings-section" aria-label="Sign-In Methods">
      <FormGroup
        title="Sign-In Methods"
        footer={
          providers.length === 0
            ? "Signing in with Apple, Google, GitHub or Microsoft isn’t available on this site yet."
            : "Connecting opens the provider’s sign-in page and brings you back here."
        }
      >
        <FormRow label={<MethodLabel icon={<Icon icon={Mail} size={16} />} name="Email and Password" />} description={session.user.email ?? undefined}>
          {linked.includes("email") ? <Connected /> : <span className="px-settings-value">Not set up</span>}
        </FormRow>
        {providers.map((provider) => {
          const isLinked = linked.includes(provider);
          return (
            <FormRow key={provider} label={<MethodLabel icon={<ProviderLogo provider={provider} size={16} />} name={providerName(provider)} />}>
              {isLinked ? (
                <>
                  <Connected />
                  <Button
                    variant="destructive"
                    aria-disabled={onlyOne || busy !== null ? true : undefined}
                    title={onlyOne ? "Your only way to sign in can’t be disconnected." : undefined}
                    onClick={() => setDisconnecting(provider)}
                  >
                    Disconnect…
                  </Button>
                </>
              ) : (
                <Button loading={busy === provider} loadingLabel="Connecting…" aria-disabled={busy !== null ? true : undefined} onClick={() => void connect(provider)}>
                  Connect…
                </Button>
              )}
            </FormRow>
          );
        })}
      </FormGroup>
      <Alert
        open={disconnecting !== null}
        onClose={() => {
          if (busy === null) setDisconnecting(null);
        }}
        title={disconnecting ? `Disconnect ${providerName(disconnecting)}?` : "Disconnect?"}
        message={disconnecting ? `You won’t be able to sign in with ${providerName(disconnecting)} until you connect it again.` : undefined}
        actionLabel="Disconnect"
        destructive
        onAction={() => {
          if (disconnecting && busy === null) void disconnect(disconnecting);
        }}
      />
    </section>
  );
}

function MethodLabel({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <span className="px-settings-method">
      <span className="px-settings-method__icon" aria-hidden="true">
        {icon}
      </span>
      {name}
    </span>
  );
}

function Connected() {
  return (
    <span className="px-settings-ok">
      <Icon icon={Check} size={12} /> Connected
    </span>
  );
}
