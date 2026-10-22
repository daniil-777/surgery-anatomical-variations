// "Resend in 0:42": a seconds countdown that survives re-renders and stops at zero.

import { useCallback, useEffect, useState } from "react";

/** Mail can be re-sent once a minute (Supabase [auth.email] max_frequency = "60s"; the memory twin uses the same). */
export const RESEND_SECONDS = 60;

export function useCountdown(): { remaining: number; start: (seconds: number) => void } {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until <= Date.now()) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [until]);

  const start = useCallback((seconds: number) => {
    const time = Date.now();
    setNow(time);
    setUntil(time + seconds * 1000);
  }, []);

  return { remaining: Math.max(0, Math.ceil((until - now) / 1000)), start };
}
