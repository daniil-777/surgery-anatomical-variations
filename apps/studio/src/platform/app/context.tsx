// Shell-wide context: the loaded platform.json, the backend (Supabase or the in-memory twin) and the auth state.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EnabledPlatformConfig } from "../core/config";
import type { AuthEvent, PlatformBackend, Session } from "../core/types";
import { clearQueries } from "./query";

interface PlatformContextValue {
  config: EnabledPlatformConfig;
  backend: PlatformBackend;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

export function PlatformProvider({ config, backend, children }: PlatformContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ config, backend }), [config, backend]);
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): PlatformContextValue {
  const value = useContext(PlatformContext);
  if (!value) throw new Error("usePlatform() outside <PlatformProvider>");
  return value;
}

export const useBackend = (): PlatformBackend => usePlatform().backend;
export const useConfig = (): EnabledPlatformConfig => usePlatform().config;

export type AuthStatus = "loading" | "signed-in" | "signed-out";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  /** The user followed a password-reset link or code: the shell asks for a new password. */
  recovery: boolean;
  lastEvent: AuthEvent | null;
  clearRecovery(): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const [state, setState] = useState<Omit<AuthState, "clearRecovery">>(() => {
    const session = backend.auth.current();
    return { status: session ? "signed-in" : "loading", session, recovery: false, lastEvent: null };
  });

  useEffect(() => {
    let alive = true;
    const unsubscribe = backend.auth.onChange((event, session) => {
      if (!alive) return;
      if (event === "signed_out") clearQueries();
      setState((previous) => ({
        status: session ? "signed-in" : "signed-out",
        session,
        recovery: event === "password_recovery" ? true : event === "signed_out" ? false : previous.recovery,
        lastEvent: event,
      }));
    });
    backend.auth.ready().then(
      (session) => {
        if (alive) setState((previous) => ({ ...previous, status: session ? "signed-in" : "signed-out", session }));
      },
      () => {
        if (alive) setState((previous) => ({ ...previous, status: "signed-out", session: null }));
      },
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [backend]);

  const value = useMemo<AuthState>(
    () => ({ ...state, clearRecovery: () => setState((previous) => ({ ...previous, recovery: false })) }),
    [state],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth() outside <AuthProvider>");
  return value;
}

/** The signed-in session, or null for guests. */
export const useSession = (): Session | null => useAuth().session;
