import { describe, expect, it } from "vitest";
import { parseHash } from "../router";
import { documentTitle, isSidebarCurrent, libraryKindName, routeFrame, routeTitle, scrollKey, sourceAppName } from "./routeMeta";

const ID = "0f9b6c2e-3a1d-4b5e-9c7f-1234567890ab";

describe("route names", () => {
  it("titles every route the way the toolbar and the tab show it", () => {
    const cases: Array<[string, string]> = [
      ["#/", "Home"],
      ["#/signin", "Sign In"],
      ["#/signup", "Create Account"],
      ["#/code", "Sign In with a Code"],
      ["#/forgot", "Reset Password"],
      ["#/reset", "Choose a New Password"],
      ["#/projects", "Projects"],
      ["#/projects?lab=organ", "Organ Design Projects"],
      ["#/library", "Library"],
      ["#/library?kind=shape", "Shapes"],
      ["#/library?kind=favorites", "Favorites"],
      [`#/library/${ID}?kind=recording`, "Recordings"],
      ["#/imports", "Imports"],
      ["#/imports?source=unity", "Unity Imports"],
      ["#/imports?source=blender", "Blender Imports"],
      ["#/imports?source=other", "Other Imports"],
      ["#/trash", "Trash"],
      ["#/settings/security", "Settings"],
      ["#/lab/organ", "Organ Design"],
      ["#/lab/texture-lab", "Texture Lab"],
      ["#/lab/unknown-lab", "Lab"],
      ["#/nowhere", "Page Not Found"],
    ];
    for (const [hash, title] of cases) expect(routeTitle(parseHash(hash)), hash).toBe(title);
    expect(documentTitle(parseHash("#/library"))).toBe("Library — VISCERA");
  });

  it("puts each route in its frame", () => {
    for (const hash of ["#/signin", "#/signup", "#/code", "#/forgot", "#/reset"]) expect(routeFrame(parseHash(hash)), hash).toBe("auth");
    for (const hash of [`#/projects/${ID}`, "#/lab/organ"]) expect(routeFrame(parseHash(hash)), hash).toBe("full");
    for (const hash of ["#/", "#/projects", "#/library", "#/imports", "#/trash", "#/settings", "#/nowhere"]) {
      expect(routeFrame(parseHash(hash)), hash).toBe("app");
    }
  });

  it("marks exactly one sidebar row as current", () => {
    const route = parseHash("#/library?kind=shape");
    expect(isSidebarCurrent(route, { name: "library", filter: "shape" })).toBe(true);
    expect(isSidebarCurrent(route, { name: "library" })).toBe(false);
    expect(isSidebarCurrent(parseHash("#/library"), { name: "library" })).toBe(true);
    expect(isSidebarCurrent(parseHash(`#/library/${ID}`), { name: "library" })).toBe(true);
    expect(isSidebarCurrent(parseHash("#/imports?source=blender"), { name: "imports", source: "blender" })).toBe(true);
    expect(isSidebarCurrent(parseHash("#/imports?source=blender"), { name: "imports" })).toBe(false);
    expect(isSidebarCurrent(parseHash("#/projects?lab=organ"), { name: "projects" })).toBe(true);
    expect(isSidebarCurrent(parseHash("#/"), { name: "home" })).toBe(true);
    expect(isSidebarCurrent(parseHash("#/trash"), { name: "trash" })).toBe(true);
    expect(isSidebarCurrent(parseHash("#/settings"), { name: "home" })).toBe(false);
  });

  it("keeps the scroll position only between settings sections", () => {
    expect(scrollKey(parseHash("#/settings/security"))).toBe(scrollKey(parseHash("#/settings/storage")));
    expect(scrollKey(parseHash("#/library"))).not.toBe(scrollKey(parseHash("#/library?kind=shape")));
  });

  it("names kinds and source applications", () => {
    expect(libraryKindName("recording")).toBe("Recording");
    expect(sourceAppName("cinema-4d")).toBe("Cinema 4D");
    expect(sourceAppName("3ds-max")).toBe("3ds Max");
  });
});
