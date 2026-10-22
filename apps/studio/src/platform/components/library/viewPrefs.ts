// The Library's View menu choices (sort order and thumbnail size), remembered per browser in localStorage — a viewer
// convenience, never account data. Parsing is defensive: a missing, old or hand-edited value falls back to defaults.
import { parseSort, type LibrarySort } from "./filters";

export const VIEW_PREFS_KEY = "viscera.px.library.view.v1";

export type TileSize = "small" | "medium" | "large" | "xlarge";

/** The zoom steps of APPLE_STYLE_SPEC §2.9 (--px-tile-min). */
export const TILE_SIZES: ReadonlyArray<{ value: TileSize; label: string; px: number }> = [
  { value: "small", label: "Small", px: 136 },
  { value: "medium", label: "Medium", px: 168 },
  { value: "large", label: "Large", px: 208 },
  { value: "xlarge", label: "Extra Large", px: 256 },
];

export interface ViewPrefs {
  sort: LibrarySort;
  tile: TileSize;
}

export const DEFAULT_VIEW_PREFS: ViewPrefs = { sort: "newest", tile: "medium" };

export function parseViewPrefs(raw: string | null | undefined): ViewPrefs {
  if (!raw) return { ...DEFAULT_VIEW_PREFS };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return { ...DEFAULT_VIEW_PREFS };
    const record = value as { sort?: unknown; tile?: unknown };
    const tile = TILE_SIZES.find((size) => size.value === record.tile)?.value ?? DEFAULT_VIEW_PREFS.tile;
    return { sort: parseSort(record.sort), tile };
  } catch {
    return { ...DEFAULT_VIEW_PREFS };
  }
}

export function serializeViewPrefs(prefs: ViewPrefs): string {
  return JSON.stringify({ sort: prefs.sort, tile: prefs.tile });
}

export function tilePixels(tile: TileSize): number {
  return TILE_SIZES.find((size) => size.value === tile)?.px ?? 168;
}
