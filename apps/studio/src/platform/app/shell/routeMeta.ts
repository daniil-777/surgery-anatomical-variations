// Names and frames of the shell's routes: the toolbar title a page gets when it does not set its own, the window
// title ("Library — VISCERA", APPLE_STYLE_SPEC §4.2), which frame a route renders in and which sidebar row is current.
// Pure: unit-tested in node.

import { getLab } from "../../core/labs/registry";
import type { LibraryKind, SourceApp } from "../../core/types";
import { formatRoute, type LibraryFilter, type Route } from "../router";

/** "auth": the centred sign-in card · "app": sidebar + toolbar · "full": the whole window (project editor, labs). */
export type RouteFrame = "auth" | "app" | "full";

export const APP_NAME = "VISCERA";

const LIBRARY_TITLES: Record<LibraryFilter, string> = {
  shape: "Shapes",
  material: "Materials",
  texture: "Textures",
  recording: "Recordings",
  scene: "Scenes",
  image: "Images",
  model: "Models",
  favorites: "Favorites",
};

const KIND_NAMES: Record<LibraryKind, string> = {
  shape: "Shape",
  material: "Material",
  texture: "Texture",
  recording: "Recording",
  scene: "Scene",
  image: "Image",
  model: "Model",
};

const SOURCE_NAMES: Record<SourceApp, string> = {
  unity: "Unity",
  blender: "Blender",
  maya: "Maya",
  "3ds-max": "3ds Max",
  "cinema-4d": "Cinema 4D",
  houdini: "Houdini",
  sketchup: "SketchUp",
  substance: "Substance",
  zbrush: "ZBrush",
  "reality-composer": "Reality Composer",
  sketchfab: "Sketchfab",
  other: "Other Apps",
  unknown: "Unknown Source",
};

export function libraryFilterTitle(filter: LibraryFilter | undefined): string {
  return filter ? LIBRARY_TITLES[filter] : "Library";
}

/** "Shape", "Recording" … (singular, for subtitles such as "Shape · Organ Design"). */
export function libraryKindName(kind: LibraryKind): string {
  return KIND_NAMES[kind];
}

export function sourceAppName(source: SourceApp): string {
  return SOURCE_NAMES[source];
}

export function routeFrame(route: Route): RouteFrame {
  switch (route.name) {
    case "signin":
    case "signup":
    case "code":
    case "forgot":
    case "reset":
      return "auth";
    case "project":
    case "lab":
      return "full";
    default:
      return "app";
  }
}

export function routeTitle(route: Route): string {
  switch (route.name) {
    case "home":
      return "Home";
    case "signin":
      return "Sign In";
    case "signup":
      return "Create Account";
    case "code":
      return "Sign In with a Code";
    case "forgot":
      return "Reset Password";
    case "reset":
      return "Choose a New Password";
    case "projects": {
      const lab = route.lab ? getLab(route.lab) : null;
      return lab ? `${lab.title} Projects` : "Projects";
    }
    case "project":
      return "Project";
    case "library":
      return libraryFilterTitle(route.filter);
    case "imports":
      if (!route.source) return "Imports";
      return route.source === "other" ? "Other Imports" : `${SOURCE_NAMES[route.source]} Imports`;
    case "trash":
      return "Trash";
    case "settings":
      return "Settings";
    case "lab":
      return getLab(route.labId)?.title ?? "Lab";
    case "gallery":
      return "Interface Kit";
    case "not-found":
      return "Page Not Found";
  }
}

/** The browser tab title. */
export function documentTitle(route: Route): string {
  return `${routeTitle(route)} — ${APP_NAME}`;
}

/** Content scrolls back to the top when this changes (settings sections keep their own scroll position). */
export function scrollKey(route: Route): string {
  return route.name === "settings" ? "settings" : formatRoute(route);
}

/** The sidebar rows of the app frame. */
export type SidebarTarget =
  | { name: "home" }
  | { name: "projects" }
  | { name: "library"; filter?: LibraryFilter }
  | { name: "imports"; source?: SourceApp }
  | { name: "trash" };

/** Whether `target`'s sidebar row is the current page (aria-current="page"). */
export function isSidebarCurrent(route: Route, target: SidebarTarget): boolean {
  switch (target.name) {
    case "home":
      return route.name === "home";
    case "projects":
      return route.name === "projects";
    case "library":
      return route.name === "library" && route.filter === target.filter;
    case "imports":
      return route.name === "imports" && route.source === target.source;
    case "trash":
      return route.name === "trash";
  }
}
