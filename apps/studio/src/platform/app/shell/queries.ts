// Shell-wide queries: the signed-in profile, the usage numbers (sidebar counts, storage meters) and signed URLs for
// thumbnails. Keys carry the user id, so one account never sees another's cached rows; signed out, nothing is fetched
// (signed-out screens make no data requests). invalidate("account:") refreshes profile and usage after a change.

import { useEffect, useRef } from "react";
import type { Profile, Usage, Uuid } from "../../core/types";
import { usePlatform, useSession } from "../context";
import { useQuery, type QueryResult } from "../query";

export const ACCOUNT_KEY_PREFIX = "account:";

export function profileKey(userId: Uuid): string {
  return `${ACCOUNT_KEY_PREFIX}profile:${userId}`;
}

export function usageKey(userId: Uuid): string {
  return `${ACCOUNT_KEY_PREFIX}usage:${userId}`;
}

/**
 * useQuery that revalidates on mount: data cached from an earlier visit shows at once and is refreshed, so a page
 * never shows rows another page changed without invalidating them. A first load is not fetched twice.
 */
export function useFreshQuery<T>(key: string | null, fetcher: () => Promise<T>): QueryResult<T> {
  const result = useQuery(key, fetcher);
  const cached = useRef<{ key: string | null; hadData: boolean }>({ key: null, hadData: false });
  if (cached.current.key !== key) cached.current = { key, hadData: result.data !== undefined };
  const { refresh } = result;
  useEffect(() => {
    if (key !== null && cached.current.hadData) void refresh();
  }, [key, refresh]);
  return result;
}

/** The signed-in account's profile (undefined while loading and for guests). */
export function useProfile(): QueryResult<Profile> {
  const { backend } = usePlatform();
  const userId = useSession()?.user.id ?? null;
  return useQuery(userId ? profileKey(userId) : null, () => backend.account.profile());
}

/** Plan, quota and counts of the signed-in account. */
export function useUsage(): QueryResult<Usage> {
  const { backend } = usePlatform();
  const userId = useSession()?.user.id ?? null;
  return useQuery(userId ? usageKey(userId) : null, () => backend.account.usage());
}

/** A short-lived URL for an asset of the signed-in account (null while loading, for guests or when it fails). */
export function useAssetUrl(assetId: Uuid | null | undefined): string | null {
  const { backend } = usePlatform();
  const userId = useSession()?.user.id ?? null;
  const key = userId && assetId ? `asset-url:${userId}:${assetId}` : null;
  const result = useFreshQuery(key, () => (assetId ? backend.assets.url(assetId) : Promise.resolve("")));
  return result.data ? result.data : null;
}

/** The name the shell shows for an account: display name, else username, else the email's local part. */
export function accountDisplayName(profile: Pick<Profile, "displayName" | "username"> | undefined, email: string | null | undefined): string {
  const display = profile?.displayName?.trim();
  if (display) return display;
  if (profile?.username) return profile.username;
  if (email) return email.slice(0, email.indexOf("@") > 0 ? email.indexOf("@") : email.length);
  return "Account";
}
