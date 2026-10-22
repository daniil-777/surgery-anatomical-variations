import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "@fontsource-variable/inter/opsz.css";
import "../styles/px-tokens.css";
import "../styles/px-base.css";
import { navigatorPlatform, readStorage, writeStorage } from "../lib/dom";
import {
  APPEARANCE_STORAGE_KEY,
  detectFont,
  mergeAppearance,
  parseAppearance,
  resolveColorScheme,
  rootAttributes,
  sameAppearance,
  serializeAppearance,
  type PxAppearance,
  type PxColorScheme,
  type PxDensity,
  type PxFont,
  type PxRoute,
} from "../lib/theme";
import { isMacPlatform } from "../lib/shortcuts";
import { useLatest } from "../hooks/useLatest";
import { usePrefersDark, usePrefersReducedMotion } from "../hooks/useMediaQuery";
import { HudView, ToastView, type HudOptions, type HudRecord, type ToastOptions, type ToastRecord } from "./Toast";

export interface PxContextValue {
  appearance: PxAppearance;
  setAppearance: (patch: Partial<PxAppearance>) => void;
  /** What the page actually shows (lab routes are always dark). */
  colorScheme: PxColorScheme;
  route: PxRoute;
  isMac: boolean;
  reducedMotion: boolean;
  showToast: (options: ToastOptions) => string;
  /** Without an id, dismisses the visible toast. */
  dismissToast: (id?: string) => void;
  showHud: (options: HudOptions) => void;
  /** Screen-reader announcement through the provider's live regions. */
  announce: (message: string, politeness?: "polite" | "assertive") => void;
}

const PxContext = createContext<PxContextValue | null>(null);

export interface PxProviderProps {
  children: ReactNode;
  /** data-px-route on <html>: "lab" forces Dark appearance and compact density. */
  route?: PxRoute | undefined;
  density?: PxDensity | undefined;
  /** Controlled fields (e.g. the signed-in profile's appearance); the rest come from local storage. */
  appearance?: Partial<PxAppearance> | undefined;
  /** Called when the user changes the appearance (mirror it to the profile). */
  onAppearanceChange?: ((appearance: PxAppearance) => void) | undefined;
  /** Remember the appearance in localStorage "viscera.px.appearance.v1" (default on). */
  persist?: boolean | undefined;
}

function initialFont(): PxFont {
  if (typeof document === "undefined") return "inter";
  const fromBoot = document.documentElement.dataset.pxFont;
  return fromBoot === "sf" || fromBoot === "inter" ? fromBoot : detectFont(navigatorPlatform());
}

let toastCounter = 0;
let hudCounter = 0;

/**
 * The shell's root: writes the theme attributes px-tokens.css reads on <html> (class px-shell, data-px-theme, glass,
 * transparency, route, density, font), persists the appearance and hosts toasts, the HUD and live regions.
 */
export function PxProvider({ children, route = "app", density, appearance: controlled, onAppearanceChange, persist = true }: PxProviderProps) {
  const [stored, setStored] = useState<PxAppearance>(() => parseAppearance(readStorage(APPEARANCE_STORAGE_KEY)));
  const [font] = useState<PxFont>(initialFont);
  const systemDark = usePrefersDark();
  const reducedMotion = usePrefersReducedMotion();
  const isMac = useMemo(() => isMacPlatform(navigatorPlatform()), []);
  const appearance = useMemo(
    () => mergeAppearance(stored, controlled),
    // the controlled object is usually a fresh literal: compare its fields
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored, controlled?.theme, controlled?.glass, controlled?.transparency],
  );
  const latest = useLatest({ appearance, persist, onAppearanceChange });

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add("px-shell");
    for (const [name, value] of Object.entries(rootAttributes(appearance, route, density, font))) root.setAttribute(name, value);
  }, [appearance, route, density, font]);

  useEffect(() => {
    if (!persist) return undefined;
    const onStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_STORAGE_KEY) setStored(parseAppearance(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [persist]);

  const setAppearance = useCallback((patch: Partial<PxAppearance>) => {
    const current = latest.current;
    const next = mergeAppearance(current.appearance, patch);
    if (sameAppearance(next, current.appearance)) return;
    setStored(next);
    if (current.persist) writeStorage(APPEARANCE_STORAGE_KEY, serializeAppearance(next));
    current.onAppearanceChange?.(next);
  }, [latest]);

  // Feedback ------------------------------------------------------------------------------------------------------
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [hud, setHud] = useState<HudRecord | null>(null);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const announceTimer = useRef<number | undefined>(undefined);

  const announce = useCallback((message: string, politeness: "polite" | "assertive" = "polite") => {
    const set = politeness === "assertive" ? setAssertive : setPolite;
    // clear first so the same sentence twice is announced twice
    set("");
    window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => set(message), 60);
  }, []);

  const showToast = useCallback((options: ToastOptions) => {
    toastCounter += 1;
    const id = options.id ?? `px-toast-${toastCounter}`;
    const record: ToastRecord = { ...options, id, tone: options.tone ?? "info" };
    setToasts((list) => {
      const index = list.findIndex((toast) => toast.id === id);
      if (index < 0) return [...list, record];
      const next = [...list];
      next[index] = record;
      return next;
    });
    return id;
  }, []);

  const dismissToast = useCallback((id?: string) => {
    setToasts((list) => (id === undefined ? list.slice(1) : list.filter((toast) => toast.id !== id)));
  }, []);

  const showHud = useCallback((options: HudOptions) => {
    hudCounter += 1;
    setHud({ ...options, id: hudCounter });
  }, []);
  const hideHud = useCallback(() => setHud(null), []);

  const visible = toasts[0];
  useEffect(() => {
    if (visible) announce(visible.message, visible.tone === "error" ? "assertive" : "polite");
    // announce once per toast, when it becomes visible
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible?.id]);

  useEffect(() => {
    if (hud) announce(hud.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hud?.id]);

  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  const value = useMemo<PxContextValue>(() => ({
    appearance,
    setAppearance,
    colorScheme: resolveColorScheme(appearance.theme, route, systemDark),
    route,
    isMac,
    reducedMotion,
    showToast,
    dismissToast,
    showHud,
    announce,
  }), [appearance, setAppearance, route, systemDark, isMac, reducedMotion, showToast, dismissToast, showHud, announce]);

  return (
    <PxContext.Provider value={value}>
      {children}
      {typeof document === "undefined"
        ? null
        : createPortal(
          <section className="px-portal" aria-label="Notifications">
            <div className="px-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
              {polite}
            </div>
            <div className="px-visually-hidden" role="alert" aria-live="assertive" aria-atomic="true">
              {assertive}
            </div>
            {visible ? <ToastView key={visible.id} toast={visible} onDismiss={dismissToast} /> : null}
            {hud ? <HudView key={hud.id} hud={hud} onDone={hideHud} /> : null}
          </section>,
          document.body,
        )}
    </PxContext.Provider>
  );
}

export function usePx(): PxContextValue {
  const context = useContext(PxContext);
  if (!context) throw new Error("px components need a <PxProvider> above them");
  return context;
}

export function useToast(): { show: (options: ToastOptions) => string; dismiss: (id?: string) => void } {
  const { showToast, dismissToast } = usePx();
  return useMemo(() => ({ show: showToast, dismiss: dismissToast }), [showToast, dismissToast]);
}

export function useHud(): (options: HudOptions) => void {
  return usePx().showHud;
}
