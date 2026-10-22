import { describe, expect, it } from "vitest";
import { parseHash, type Route } from "../router";
import { guardKey, guardRoute, type GuardInput } from "./guards";

const ID = "0f9b6c2e-3a1d-4b5e-9c7f-1234567890ab";
const OUT: GuardInput = { status: "signed-out", recovery: false };
const IN: GuardInput = { status: "signed-in", recovery: false };

describe("route guards", () => {
  it("waits until the stored session is restored", () => {
    for (const hash of ["#/", "#/signin", "#/library", `#/projects/${ID}`]) {
      expect(guardRoute(parseHash(hash), { status: "loading", recovery: false })).toEqual({ kind: "wait" });
    }
  });

  it("sends guests from account pages to sign-in, remembering where they were going", () => {
    expect(guardRoute(parseHash("#/library?kind=shape"), OUT)).toEqual({
      kind: "redirect",
      to: { name: "signin", next: "/library?kind=shape" },
    });
    expect(guardRoute(parseHash(`#/projects/${ID}`), OUT)).toEqual({ kind: "redirect", to: { name: "signin", next: `/projects/${ID}` } });
    for (const hash of ["#/projects", "#/imports?source=unity", "#/trash", "#/settings/security"]) {
      expect(guardRoute(parseHash(hash), OUT).kind, hash).toBe("redirect");
    }
  });

  it("lets guests see Home, the labs and the sign-in screens", () => {
    for (const hash of ["#/", "#/lab/organ", "#/signin", "#/signup", "#/code", "#/forgot", "#/nowhere"]) {
      expect(guardRoute(parseHash(hash), OUT), hash).toEqual({ kind: "render" });
    }
  });

  it("sends a signed-in visitor on from sign-in screens", () => {
    expect(guardRoute(parseHash("#/signin?next=/library"), IN)).toEqual({ kind: "redirect", to: "/library" });
    expect(guardRoute(parseHash("#/signup"), IN)).toEqual({ kind: "redirect", to: "/" });
    expect(guardRoute(parseHash("#/code?email=a@b.co"), IN)).toEqual({ kind: "redirect", to: "/" });
    expect(guardRoute(parseHash("#/forgot"), IN)).toEqual({ kind: "redirect", to: "/" });
    // the open-redirect guard of the router still applies
    expect(guardRoute(parseHash("#/signin?next=https://evil.example"), IN)).toEqual({ kind: "redirect", to: "/" });
  });

  it("lets a signed-in account use every page", () => {
    for (const hash of ["#/", "#/projects", `#/projects/${ID}`, "#/library", "#/imports", "#/trash", "#/settings", "#/lab/organ"]) {
      expect(guardRoute(parseHash(hash), IN), hash).toEqual({ kind: "render" });
    }
  });

  it("sends a password-recovery session to the new-password screen first", () => {
    const recovery: GuardInput = { status: "signed-in", recovery: true };
    for (const hash of ["#/", "#/library", "#/signin", "#/settings"]) {
      expect(guardRoute(parseHash(hash), recovery), hash).toEqual({ kind: "redirect", to: { name: "reset" } });
    }
    expect(guardRoute({ name: "reset" }, recovery)).toEqual({ kind: "render" });
  });

  it("only shows the new-password screen to a signed-in session", () => {
    expect(guardRoute({ name: "reset" }, OUT)).toEqual({ kind: "redirect", to: { name: "forgot" } });
    // after a successful reset the screen stays up until the person continues
    expect(guardRoute({ name: "reset" }, IN)).toEqual({ kind: "render" });
  });

  it("keys redirects by their target", () => {
    const a: Route = { name: "library" };
    expect(guardKey(guardRoute(a, OUT))).toBe(guardKey(guardRoute(a, OUT)));
    expect(guardKey(guardRoute(a, OUT))).not.toBe(guardKey(guardRoute({ name: "trash" }, OUT)));
    expect(guardKey({ kind: "render" })).toBe("render");
    expect(guardKey({ kind: "redirect", to: "/" })).toBe("redirect:/");
  });
});
