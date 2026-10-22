// The appearance (System/Light/Dark) belongs to the account: profiles.appearance follows every change made in
// Settings or the account menu, and signing in applies the account's choice on this device. Glass and Reduce
// Transparency stay per device (PxProvider keeps them in localStorage). An account that never chose ("system")
// adopts the choice made on this device before signing in, so signing up does not undo it.

import { useCallback, useEffect, useRef } from "react";
import type { Appearance } from "../../core/types";
import { usePx, useToast } from "../../ui";
import { usePlatform, useSession } from "../context";
import { errorMessage, isSilentError } from "../messages";
import { setQueryData } from "../query";
import { profileKey, useProfile } from "./queries";

export function useThemePreference(): { theme: Appearance; setTheme: (theme: Appearance) => void } {
  const { appearance, setAppearance } = usePx();
  const { backend } = usePlatform();
  const userId = useSession()?.user.id ?? null;
  const toast = useToast();
  const setTheme = useCallback(
    (theme: Appearance) => {
      setAppearance({ theme });
      if (!userId) return;
      backend.account.updateProfile({ appearance: theme }).then(
        (profile) => setQueryData(profileKey(userId), () => profile),
        (error: unknown) => {
          if (!isSilentError(error)) toast.show({ tone: "error", message: errorMessage(error, "profile"), id: "appearance-sync" });
        },
      );
    },
    [backend, setAppearance, toast, userId],
  );
  return { theme: appearance.theme, setTheme };
}

/** Once per sign-in: bring this device and the account's appearance into line. */
export function useAppearanceSync(): void {
  const { appearance, setAppearance } = usePx();
  const { backend } = usePlatform();
  const userId = useSession()?.user.id ?? null;
  const profile = useProfile().data;
  const synced = useRef<string | null>(null);
  const deviceTheme = appearance.theme;

  useEffect(() => {
    if (!userId) {
      synced.current = null;
      return;
    }
    if (!profile || profile.id !== userId || synced.current === userId) return;
    synced.current = userId;
    if (profile.appearance !== "system") {
      if (profile.appearance !== deviceTheme) setAppearance({ theme: profile.appearance });
    } else if (deviceTheme !== "system") {
      backend.account.updateProfile({ appearance: deviceTheme }).then(
        (updated) => setQueryData(profileKey(userId), () => updated),
        () => undefined,
      );
    }
  }, [userId, profile, deviceTheme, setAppearance, backend]);
}
