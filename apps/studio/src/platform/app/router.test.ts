import { describe, expect, it } from "vitest";
import { formatRoute, isAuthRoute, nextPath, parseHash, requiresAccount, type Route } from "./router";

const ID = "0f9b6c2e-3a1d-4b5e-9c7f-1234567890ab";

describe("hash routes", () => {
  it("parses every route and formats it back", () => {
    const routes: Route[] = [
      { name: "home" },
      { name: "signin" },
      { name: "signin", next: "/library?kind=shape" },
      { name: "signup" },
      { name: "code", email: "a@example.test" },
      { name: "forgot" },
      { name: "reset" },
      { name: "projects" },
      { name: "projects", lab: "organ" },
      { name: "project", id: ID },
      { name: "library" },
      { name: "library", filter: "recording" },
      { name: "library", filter: "favorites", itemId: ID },
      { name: "imports", source: "blender" },
      { name: "imports", objectId: ID },
      { name: "trash" },
      { name: "settings" },
      { name: "settings", section: "security" },
      { name: "lab", labId: "organ" },
      { name: "gallery" },
    ];
    for (const route of routes) expect(parseHash(formatRoute(route))).toEqual(route);
  });

  it("treats an empty hash as home", () => {
    expect(parseHash("")).toEqual({ name: "home" });
    expect(parseHash("#")).toEqual({ name: "home" });
    expect(parseHash("#/")).toEqual({ name: "home" });
  });

  it("rejects malformed ids, unknown filters and extra segments", () => {
    expect(parseHash("#/projects/not-a-uuid").name).toBe("not-found");
    expect(parseHash("#/library?kind=spreadsheet")).toEqual({ name: "library" });
    expect(parseHash("#/imports?source=photoshop")).toEqual({ name: "imports" });
    expect(parseHash("#/lab/Organ!").name).toBe("not-found");
    expect(parseHash(`#/projects/${ID}/extra`).name).toBe("not-found");
    expect(parseHash("#/nowhere").name).toBe("not-found");
  });

  it("only accepts in-app next paths (no open redirects)", () => {
    expect(parseHash("#/signin?next=https://evil.example")).toEqual({ name: "signin" });
    expect(parseHash("#/signin?next=//evil.example")).toEqual({ name: "signin" });
    expect(parseHash("#/signin?next=/projects")).toEqual({ name: "signin", next: "/projects" });
  });

  it("normalises ids to lower case", () => {
    expect(parseHash(`#/projects/${ID.toUpperCase()}`)).toEqual({ name: "project", id: ID });
  });

  it("knows which routes need an account and which are sign-in screens", () => {
    expect(requiresAccount({ name: "library" })).toBe(true);
    expect(requiresAccount({ name: "project", id: ID })).toBe(true);
    expect(requiresAccount({ name: "home" })).toBe(false);
    expect(requiresAccount({ name: "lab", labId: "organ" })).toBe(false);
    expect(isAuthRoute({ name: "signup" })).toBe(true);
    expect(isAuthRoute({ name: "reset" })).toBe(false);
  });

  it("builds the next path a guest returns to", () => {
    expect(nextPath({ name: "library", filter: "shape" })).toBe("/library?kind=shape");
  });
});
