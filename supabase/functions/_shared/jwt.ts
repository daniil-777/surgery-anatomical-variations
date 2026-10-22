// Claims of a Supabase access token. decodeJwtClaims does NOT check the signature: call it only on a token that Auth
// has just accepted (auth.getUser(token) succeeded), so the claims are Auth's own.
//
// How recently the user signed in comes from `amr`, not `iat`: Auth stamps a new `iat` on every token, refreshes
// included, while each `amr` entry carries the time that sign-in method was used for the session and is kept on
// refresh (supabase/auth: AddClaimToSession runs only when a session is issued; CalculateAALAndAMR copies the claim's
// time into the token).
import { isRecord } from "./http.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The payload of a compact JWS ("header.payload.signature"), or null when it is not one. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || !BASE64URL.test(payload)) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** When the session's user last proved who they are (epoch seconds): the newest `amr` timestamp, or null. */
export function lastSignInAt(claims: Record<string, unknown>): number | null {
  const methods = claims.amr;
  if (!Array.isArray(methods)) return null;
  let latest: number | null = null;
  for (const entry of methods) {
    const timestamp = isRecord(entry) ? entry.timestamp : undefined;
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}
