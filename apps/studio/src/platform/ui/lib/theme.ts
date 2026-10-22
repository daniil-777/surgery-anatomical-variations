// Appearance: the user's choice (persisted under APPEARANCE_STORAGE_KEY, mirrored to profiles.appearance by the app)
// and how it resolves into the data attributes px-tokens.css reads on <html> (APPLE_STYLE_SPEC §1.1).
// Pure: no DOM globals, unit-tested in node.

import type { Appearance } from "../../core/types";

export type PxTheme = Appearance;
export type PxGlass = "regular" | "clear" | "tinted";
export type PxTransparency = "system" | "reduce";
export type PxDensity = "regular" | "compact";
/** "lab" forces Dark appearance (labs keep their dark-only look; Photos switches to dark in Edit the same way). */
export type PxRoute = "auth" | "app" | "lab";
export type PxFont = "sf" | "inter";
export type PxColorScheme = "light" | "dark";

export interface PxAppearance {
  theme: PxTheme;
  glass: PxGlass;
  transparency: PxTransparency;
}

export const APPEARANCE_STORAGE_KEY = "viscera.px.appearance.v1";

export const DEFAULT_APPEARANCE: Readonly<PxAppearance> = Object.freeze({
  theme: "system",
  glass: "regular",
  transparency: "system",
});

const THEMES: readonly PxTheme[] = ["system", "light", "dark"];
const GLASS: readonly PxGlass[] = ["regular", "clear", "tinted"];
const TRANSPARENCY: readonly PxTransparency[] = ["system", "reduce"];

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Tolerant: anything unreadable falls back per field, so a bad stored value never breaks the shell. */
export function normalizeAppearance(value: unknown): PxAppearance {
  const source = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    theme: pick(THEMES, source.theme, DEFAULT_APPEARANCE.theme),
    glass: pick(GLASS, source.glass, DEFAULT_APPEARANCE.glass),
    transparency: pick(TRANSPARENCY, source.transparency, DEFAULT_APPEARANCE.transparency),
  };
}

export function parseAppearance(raw: string | null | undefined): PxAppearance {
  if (!raw) return { ...DEFAULT_APPEARANCE };
  try {
    return normalizeAppearance(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function serializeAppearance(appearance: PxAppearance): string {
  const { theme, glass, transparency } = normalizeAppearance(appearance);
  return JSON.stringify({ theme, glass, transparency });
}

export function mergeAppearance(base: PxAppearance, patch: Partial<PxAppearance> | null | undefined): PxAppearance {
  return normalizeAppearance({ ...base, ...(patch ?? {}) });
}

export function sameAppearance(a: PxAppearance, b: PxAppearance): boolean {
  return a.theme === b.theme && a.glass === b.glass && a.transparency === b.transparency;
}

/** The colour scheme the page shows: lab routes are always dark, "system" follows the OS. */
export function resolveColorScheme(theme: PxTheme, route: PxRoute, systemPrefersDark: boolean): PxColorScheme {
  if (route === "lab") return "dark";
  if (theme === "system") return systemPrefersDark ? "dark" : "light";
  return theme;
}

/** True when materials must be solid (manual Reduce Transparency or the OS setting). */
export function resolveReducedTransparency(transparency: PxTransparency, systemPrefersReduced: boolean): boolean {
  return transparency === "reduce" || systemPrefersReduced;
}

/** SF ships with Apple platforms only (its licence forbids self-hosting); everyone else gets Inter. */
export function detectFont(platform: string): PxFont {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "sf" : "inter";
}

export interface PxRootAttributes {
  "data-px-theme": PxTheme;
  "data-px-glass": PxGlass;
  "data-px-transparency": PxTransparency;
  "data-px-route": PxRoute;
  "data-px-density": PxDensity;
  "data-px-font": PxFont;
}

/** Labs use compact density by default (the spec's inspector metrics inside labs). */
export function rootAttributes(appearance: PxAppearance, route: PxRoute, density: PxDensity | undefined, font: PxFont): PxRootAttributes {
  const normalized = normalizeAppearance(appearance);
  return {
    "data-px-theme": normalized.theme,
    "data-px-glass": normalized.glass,
    "data-px-transparency": normalized.transparency,
    "data-px-route": route,
    "data-px-density": density ?? (route === "lab" ? "compact" : "regular"),
    "data-px-font": font,
  };
}
