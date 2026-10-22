// Library kinds as the shell names and draws them: labels, glyphs, the title of every filter scope and the copy of each
// empty state (APPLE_STYLE_SPEC §2.15, §3.4). Pure data plus lucide glyph references, shared by the Library page, its
// inspector and Quick Look.
import { Box, Boxes, Heart, Image, Images, Layers, Palette, Shapes, Video, type LucideIcon } from "lucide-react";
import type { LibraryFilter } from "../../app/router";
import type { LibraryKind } from "../../core/types";

export const LIBRARY_KIND_ORDER: readonly LibraryKind[] = ["shape", "material", "texture", "recording", "scene", "image", "model"];

export interface KindInfo {
  singular: string;
  plural: string;
  icon: LucideIcon;
}

export const KIND_INFO: Readonly<Record<LibraryKind, KindInfo>> = {
  shape: { singular: "Shape", plural: "Shapes", icon: Shapes },
  material: { singular: "Material", plural: "Materials", icon: Palette },
  texture: { singular: "Texture", plural: "Textures", icon: Layers },
  recording: { singular: "Recording", plural: "Recordings", icon: Video },
  scene: { singular: "Scene", plural: "Scenes", icon: Boxes },
  image: { singular: "Image", plural: "Images", icon: Image },
  model: { singular: "Model", plural: "Models", icon: Box },
};

/** What the grid shows: everything, the favourites across kinds, or one kind (the route's ?kind=). */
export type LibraryScope = "all" | LibraryFilter;

export const LIBRARY_SCOPES: readonly LibraryScope[] = ["all", "favorites", ...LIBRARY_KIND_ORDER];

export function isLibraryKind(value: unknown): value is LibraryKind {
  return typeof value === "string" && (LIBRARY_KIND_ORDER as readonly string[]).includes(value);
}

export function scopeTitle(scope: LibraryScope): string {
  if (scope === "all") return "Library";
  if (scope === "favorites") return "Favorites";
  return KIND_INFO[scope].plural;
}

export function scopeIcon(scope: LibraryScope): LucideIcon {
  if (scope === "all") return Images;
  if (scope === "favorites") return Heart;
  return KIND_INFO[scope].icon;
}

export interface EmptyCopy {
  title: string;
  description: string;
  /** "upload" offers Upload…, "lab" offers to open `labId` (or a menu of labs when labId is absent). */
  action: "upload" | "lab" | null;
  labId?: string;
}

/** The empty state of a scope with no items at all (spec §2.15: say what is missing, then what to do). */
export function emptyStateCopy(scope: LibraryScope): EmptyCopy {
  switch (scope) {
    case "all":
      return {
        title: "No Items Yet",
        description: "Shapes, materials and recordings you save from a lab appear here. You can also upload images, GLB models and videos.",
        action: "upload",
      };
    case "favorites":
      return { title: "No Favorites", description: "Press . or click ♥ on an item to add it to Favorites.", action: null };
    case "shape":
      return { title: "No Shapes", description: "Shapes you add to the Library from Organ Design appear here.", action: "lab", labId: "organ" };
    case "material":
      return { title: "No Materials", description: "Materials you add to the Library from a lab appear here.", action: "lab" };
    case "texture":
      return { title: "No Textures", description: "Textures you add to the Library from Texture Lab appear here.", action: "lab", labId: "texture-lab" };
    case "recording":
      return { title: "No Recordings", description: "Record a run in a lab to see it here, or upload an MP4 or WebM video.", action: "upload" };
    case "scene":
      return { title: "No Scenes", description: "Scenes you add to the Library from Whole Body appear here.", action: "lab", labId: "scene" };
    case "image":
      return { title: "No Images", description: "Upload PNG, JPEG, WebP or AVIF images, or add a still from a lab.", action: "upload" };
    case "model":
      return { title: "No Models", description: "Upload a GLB model to keep it in your Library.", action: "upload" };
  }
}

/** The empty state when a search matches nothing in the current scope. */
export function searchEmptyCopy(search: string): EmptyCopy {
  return { title: `No Results for “${search.trim()}”`, description: "Check the spelling or try a new search.", action: null };
}
