// Hash routes of the account shell (#/library?kind=shape). GitHub Pages has no SPA fallback and the site lives under a
// sub-path, so the shell keeps its location in the hash; the query string stays free for auth callbacks (?code=, ?auth=).
import { useSyncExternalStore } from "react";
import type { LibraryKind, SourceApp } from "../core/types";

export type LibraryFilter = LibraryKind | "favorites";

export type Route =
  | { name: "home" }
  | { name: "signin"; next?: string }
  | { name: "signup"; next?: string }
  | { name: "code"; email?: string; next?: string }
  | { name: "forgot" }
  | { name: "reset" }
  | { name: "projects"; lab?: string }
  | { name: "project"; id: string }
  | { name: "library"; filter?: LibraryFilter; itemId?: string }
  | { name: "imports"; source?: SourceApp; objectId?: string }
  | { name: "trash" }
  | { name: "settings"; section?: string }
  | { name: "lab"; labId: string }
  | { name: "gallery" }
  | { name: "not-found"; path: string };

const LIBRARY_FILTERS: readonly LibraryFilter[] = [
  "shape", "material", "texture", "recording", "scene", "image", "model", "favorites",
];
const SOURCE_APPS: readonly SourceApp[] = [
  "unity", "blender", "maya", "3ds-max", "cinema-4d", "houdini", "sketchup", "substance", "zbrush",
  "reality-composer", "sketchfab", "other", "unknown",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z][a-z0-9-]{1,31}$/;

/** Routes that need a signed-in account; guests are sent to sign-in with ?next=. */
export function requiresAccount(route: Route): boolean {
  switch (route.name) {
    case "projects":
    case "project":
    case "library":
    case "imports":
    case "trash":
    case "settings":
      return true;
    default:
      return false;
  }
}

/** Routes that only make sense signed out (a signed-in visitor goes home instead). */
export function isAuthRoute(route: Route): boolean {
  return route.name === "signin" || route.name === "signup" || route.name === "code" || route.name === "forgot";
}

function safeNext(value: string | null): string | undefined {
  // only in-app hash paths; never an absolute URL (open-redirect guard)
  if (!value || !value.startsWith("/") || value.startsWith("//")) return undefined;
  return value;
}

export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const path = pathPart === "" ? "/" : pathPart;
  const query = new URLSearchParams(queryPart);
  const segments = path.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const [first, second, ...rest] = segments;
  if (rest.length > 0) return { name: "not-found", path };
  const next = safeNext(query.get("next"));
  const withNext = <T extends object>(route: T): T & { next?: string } => (next ? { ...route, next } : route);

  switch (first) {
    case undefined:
      return { name: "home" };
    case "signin":
      return second ? { name: "not-found", path } : withNext({ name: "signin" as const });
    case "signup":
      return second ? { name: "not-found", path } : withNext({ name: "signup" as const });
    case "code": {
      if (second) return { name: "not-found", path };
      const email = query.get("email");
      return withNext(email ? { name: "code" as const, email } : { name: "code" as const });
    }
    case "forgot":
      return second ? { name: "not-found", path } : { name: "forgot" };
    case "reset":
      return second ? { name: "not-found", path } : { name: "reset" };
    case "projects": {
      if (second) return UUID.test(second) ? { name: "project", id: second.toLowerCase() } : { name: "not-found", path };
      const lab = query.get("lab");
      return lab && SLUG.test(lab) ? { name: "projects", lab } : { name: "projects" };
    }
    case "library": {
      if (second && !UUID.test(second)) return { name: "not-found", path };
      const kind = query.get("kind");
      const filter = LIBRARY_FILTERS.find((candidate) => candidate === kind);
      return {
        name: "library",
        ...(filter ? { filter } : {}),
        ...(second ? { itemId: second.toLowerCase() } : {}),
      };
    }
    case "imports": {
      if (second && !UUID.test(second)) return { name: "not-found", path };
      const source = SOURCE_APPS.find((candidate) => candidate === query.get("source"));
      return {
        name: "imports",
        ...(source ? { source } : {}),
        ...(second ? { objectId: second.toLowerCase() } : {}),
      };
    }
    case "trash":
      return second ? { name: "not-found", path } : { name: "trash" };
    case "settings":
      return second ? { name: "settings", section: second } : { name: "settings" };
    case "lab":
      return second && SLUG.test(second) ? { name: "lab", labId: second } : { name: "not-found", path };
    case "dev":
      return second === "gallery" ? { name: "gallery" } : { name: "not-found", path };
    default:
      return { name: "not-found", path };
  }
}

export function formatRoute(route: Route): string {
  const query = new URLSearchParams();
  let path: string;
  switch (route.name) {
    case "home":
      path = "/";
      break;
    case "signin":
    case "signup":
      path = `/${route.name}`;
      if (route.next) query.set("next", route.next);
      break;
    case "code":
      path = "/code";
      if (route.email) query.set("email", route.email);
      if (route.next) query.set("next", route.next);
      break;
    case "forgot":
    case "reset":
    case "trash":
      path = `/${route.name}`;
      break;
    case "projects":
      path = "/projects";
      if (route.lab) query.set("lab", route.lab);
      break;
    case "project":
      path = `/projects/${route.id}`;
      break;
    case "library":
      path = route.itemId ? `/library/${route.itemId}` : "/library";
      if (route.filter) query.set("kind", route.filter);
      break;
    case "imports":
      path = route.objectId ? `/imports/${route.objectId}` : "/imports";
      if (route.source) query.set("source", route.source);
      break;
    case "settings":
      path = route.section ? `/settings/${encodeURIComponent(route.section)}` : "/settings";
      break;
    case "lab":
      path = `/lab/${route.labId}`;
      break;
    case "gallery":
      path = "/dev/gallery";
      break;
    case "not-found":
      path = route.path;
      break;
  }
  const search = query.toString();
  return `#${path}${search ? `?${search}` : ""}`;
}

/** The hash path (without "#") a guest should return to after signing in. */
export function nextPath(route: Route): string {
  return formatRoute(route).slice(1);
}

type Listener = () => void;
const listeners = new Set<Listener>();
let current: Route | null = null;

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

function onHashChange(): void {
  current = parseHash(currentHash());
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("hashchange", onHashChange);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("hashchange", onHashChange);
  };
}

export function currentRoute(): Route {
  if (current === null) current = parseHash(currentHash());
  return current;
}

export function navigate(to: Route | string, options: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const hash = typeof to === "string" ? (to.startsWith("#") ? to : `#${to}`) : formatRoute(to);
  if (hash === window.location.hash) return;
  if (options.replace) {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
    onHashChange();
  } else {
    window.location.hash = hash;
  }
}

const SERVER_ROUTE: Route = { name: "home" };

/** The current route; re-renders on every hash change. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, currentRoute, () => SERVER_ROUTE);
}
