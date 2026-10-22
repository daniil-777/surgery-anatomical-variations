// Which screen a route may show for the current auth state (DESIGN.md §10, §15.9). Pure, so the rules are unit-tested:
//   · nothing is decided until the stored session is restored (no flash of the sign-in screen);
//   · a password-recovery session goes to "Choose a New Password" before anything else;
//   · account pages send guests to sign-in with ?next= (and never render, so they make no requests);
//   · sign-in screens send a signed-in visitor on to ?next= or Home.

import { isAuthRoute, nextPath, requiresAccount, type Route } from "../router";

export type GuardStatus = "loading" | "signed-in" | "signed-out";

export interface GuardInput {
  status: GuardStatus;
  /** A password-reset code or link signed this session in: it must choose a new password first. */
  recovery: boolean;
}

export type GuardResult =
  | { kind: "render" }
  /** The session is still being restored. */
  | { kind: "wait" }
  /** Replace the current history entry with this route (a hash path when it is a string). */
  | { kind: "redirect"; to: Route | string };

const RENDER: GuardResult = { kind: "render" };

export function guardRoute(route: Route, { status, recovery }: GuardInput): GuardResult {
  if (status === "loading") return { kind: "wait" };
  if (recovery && status === "signed-in") return route.name === "reset" ? RENDER : { kind: "redirect", to: { name: "reset" } };
  if (route.name === "reset") return status === "signed-in" ? RENDER : { kind: "redirect", to: { name: "forgot" } };
  if (status === "signed-out" && requiresAccount(route)) {
    return { kind: "redirect", to: { name: "signin", next: nextPath(route) } };
  }
  if (status === "signed-in" && isAuthRoute(route)) {
    const next = "next" in route ? route.next : undefined;
    return { kind: "redirect", to: next ?? "/" };
  }
  return RENDER;
}

/** A stable string for a guard result (effects re-run only when the target changes). */
export function guardKey(result: GuardResult): string {
  if (result.kind !== "redirect") return result.kind;
  return typeof result.to === "string" ? `redirect:${result.to}` : `redirect:${JSON.stringify(result.to)}`;
}
