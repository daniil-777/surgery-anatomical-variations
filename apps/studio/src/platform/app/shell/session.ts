// Where to go after signing out. Auth events arrive asynchronously (both adapters deliver them on a timer), so
// navigating as soon as signOut() resolves would race the guard, which still sees the old session. Instead the action
// names its destination here and AppShell navigates when the signed-out state actually lands.

import { useCallback } from "react";
import { useToast } from "../../ui";
import { usePlatform } from "../context";
import { errorMessage, isSilentError } from "../messages";
import type { Route } from "../router";

let destination: Route | null = null;

/** The route to show once the session has ended (the latest call wins). */
export function setAfterSignOut(route: Route | null): void {
  destination = route;
}

/** Read once by AppShell when the auth state turns signed-out. */
export function takeAfterSignOut(): Route | null {
  const route = destination;
  destination = null;
  return route;
}

/** Signs out ("local" = this browser, "global" = every device) and then shows `to` (sign-in by default). */
export function useSignOut(): (options?: { scope?: "local" | "global"; to?: Route }) => Promise<boolean> {
  const { backend } = usePlatform();
  const toast = useToast();
  return useCallback(
    async ({ scope = "local", to = { name: "signin" } }: { scope?: "local" | "global"; to?: Route } = {}) => {
      setAfterSignOut(to);
      try {
        await backend.auth.signOut(scope);
        return true;
      } catch (error) {
        setAfterSignOut(null);
        if (!isSilentError(error)) toast.show({ tone: "error", message: errorMessage(error) });
        return false;
      }
    },
    [backend, toast],
  );
}
