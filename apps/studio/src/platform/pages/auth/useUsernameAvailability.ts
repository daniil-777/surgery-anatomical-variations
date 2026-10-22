// Debounced username availability (username_available(), callable signed out — one of the few requests a signed-out
// screen may make). Pass a well-formed, lower-case name or "" to stay idle; stale answers are ignored.

import { useEffect, useState } from "react";
import { usePlatform } from "../../app/context";

export type UsernameAvailability = "idle" | "checking" | "available" | "taken" | "unknown";

export interface UsernameAvailabilityOptions {
  /** The account's own username: shown as idle, never checked. */
  current?: string | null | undefined;
  delayMs?: number | undefined;
}

export function useUsernameAvailability(username: string, { current = null, delayMs = 400 }: UsernameAvailabilityOptions = {}): UsernameAvailability {
  const { backend } = usePlatform();
  const [answer, setAnswer] = useState<{ name: string; availability: UsernameAvailability }>({ name: "", availability: "idle" });

  useEffect(() => {
    if (username === "" || username === current) return undefined;
    let alive = true;
    setAnswer({ name: username, availability: "checking" });
    const timer = window.setTimeout(() => {
      backend.auth.usernameAvailable(username).then(
        (free) => {
          if (alive) setAnswer({ name: username, availability: free ? "available" : "taken" });
        },
        () => {
          // offline or throttled: the server decides on submit
          if (alive) setAnswer({ name: username, availability: "unknown" });
        },
      );
    }, delayMs);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [backend, username, current, delayMs]);

  if (username === "" || username === current) return "idle";
  return answer.name === username ? answer.availability : "checking";
}
