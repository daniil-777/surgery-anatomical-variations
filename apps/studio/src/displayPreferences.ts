export const DISPLAY_STORAGE_KEY = "viscera.display.v1";
export type DisplayPreferences = { textPercent: number; controlsWidth: number; sceneHeight: number | null };
export const DEFAULT_DISPLAY: DisplayPreferences = { textPercent: 100, controlsWidth: 340, sceneHeight: null };

const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

export function parseDisplayPreferences(value: unknown): DisplayPreferences {
  const input = value && typeof value === "object" ? value as Partial<DisplayPreferences> : {};
  return {
    textPercent: bounded(input.textPercent, 100, 80, 200),
    controlsWidth: bounded(input.controlsWidth, 340, 240, 600),
    sceneHeight: input.sceneHeight == null ? null : bounded(input.sceneHeight, 640, 320, 1400),
  };
}

export function readDisplayPreferences(storage?: Pick<Storage, "getItem">): DisplayPreferences {
  try { return parseDisplayPreferences(JSON.parse(storage?.getItem(DISPLAY_STORAGE_KEY) ?? "null")); }
  catch { return { ...DEFAULT_DISPLAY }; }
}
