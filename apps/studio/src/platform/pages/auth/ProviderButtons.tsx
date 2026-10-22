// "Continue with Apple / Google / GitHub / Microsoft" (APPLE_STYLE_SPEC §3.1). Only providers platform.json enables are
// shown. All buttons share one size and visual weight, as both Apple's and Google's rules ask: white capsules 40 px
// tall, the unaltered logo on the leading side, black or near-black titles. Apple: white with an outline on light
// backgrounds, plain white on dark ones; Google: the outline button (#FFFFFF, stroke #747775, text #1F1F1F) in both;
// Microsoft: its light button (stroke #8C8C8C, text #5E5E5E). Logos are the providers' published marks, never recoloured.

import type { OAuthProvider } from "../../core/types";
import type { PlatformProviders } from "../../core/config";
import { Button, Spinner, cx } from "../../ui";

export const OAUTH_ORDER: readonly OAuthProvider[] = ["apple", "google", "github", "azure"];

const NAMES: Record<OAuthProvider, string> = {
  apple: "Apple",
  google: "Google",
  github: "GitHub",
  azure: "Microsoft",
};

export function providerName(provider: OAuthProvider): string {
  return NAMES[provider];
}

/** The OAuth providers platform.json enables, in display order. */
export function enabledOAuthProviders(providers: PlatformProviders): OAuthProvider[] {
  return OAUTH_ORDER.filter((provider) => providers[provider]);
}

export function ProviderLogo({ provider, size = 18 }: { provider: OAuthProvider; size?: number }) {
  switch (provider) {
    case "apple":
      return (
        <svg className="px-provider-logo" width={size} height={size} viewBox="0 0 814 1000" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"
          />
        </svg>
      );
    case "google":
      return (
        <svg className="px-provider-logo" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
      );
    case "github":
      return (
        <svg className="px-provider-logo" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
          />
        </svg>
      );
    case "azure":
      return (
        <svg className="px-provider-logo" width={size} height={size} viewBox="0 0 21 21" aria-hidden="true" focusable="false">
          <rect x="1" y="1" width="9" height="9" fill="#F25022" />
          <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
          <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
          <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
        </svg>
      );
  }
}

export interface ProviderButtonsProps {
  providers: readonly OAuthProvider[];
  /** The provider whose sign-in is under way (its button shows a spinner; all are disabled). */
  pending: OAuthProvider | null;
  disabled?: boolean | undefined;
  onChoose: (provider: OAuthProvider) => void;
}

export function ProviderButtons({ providers, pending, disabled = false, onChoose }: ProviderButtonsProps) {
  if (providers.length === 0) return null;
  return (
    <div className="px-auth-providers">
      {providers.map((provider) => (
        <Button
          key={provider}
          size="auth"
          className={cx("px-provider-btn", `px-provider-btn--${provider}`)}
          aria-disabled={disabled || pending !== null ? true : undefined}
          aria-busy={pending === provider ? true : undefined}
          onClick={() => onChoose(provider)}
        >
          <span className="px-provider-btn__logo">{pending === provider ? <Spinner size={16} /> : <ProviderLogo provider={provider} />}</span>
          <span className="px-provider-btn__title">Continue with {NAMES[provider]}</span>
        </Button>
      ))}
    </div>
  );
}
