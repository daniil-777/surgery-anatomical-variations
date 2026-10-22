// Small hooks shared by the lab pages: the lab's busy reason, signed asset URLs for thumbnails, the account's limits,
// the 400 ms "Saving…" threshold and the browser's leave-page prompt.

import { useEffect, useState } from "react";
import { useBackend, useSession } from "../../app/context";
import { useQuery } from "../../app/query";
import type { LabConnection } from "../../core/labs/host";
import type { Usage } from "../../core/types";

/** connection.busy() polled (the host has no busy events): false, or the reason ("recording", "loading" …). */
export function useLabBusy(connection: LabConnection | null, intervalMs = 400): false | string {
  const [busy, setBusy] = useState<false | string>(() => (connection ? connection.busy() : "loading"));
  useEffect(() => {
    if (!connection) {
      setBusy("loading");
      return undefined;
    }
    const read = () => {
      let next: false | string;
      try {
        next = connection.busy();
      } catch {
        next = "unavailable";
      }
      setBusy((previous) => (previous === next ? previous : next));
    };
    read();
    const timer = window.setInterval(read, intervalMs);
    return () => window.clearInterval(timer);
  }, [connection, intervalMs]);
  return busy;
}

/** A display URL for an asset (signed on Supabase, an object URL in the memory twin), cached per asset id. */
export function useAssetUrl(assetId: string | null | undefined): string | null {
  const backend = useBackend();
  const session = useSession();
  const key = assetId && session ? `asset-url:${assetId}` : null;
  const { data } = useQuery(key, () => backend.assets.url(assetId ?? ""));
  return key ? (data ?? null) : null;
}

/** The signed-in account's plan limits (file size for recordings, version retention), null while loading. */
export function useUsage(): Usage | null {
  const backend = useBackend();
  const session = useSession();
  const { data } = useQuery(session ? "account:usage" : null, () => backend.account.usage());
  return data ?? null;
}

/** True once `active` has stayed true for `delayMs` (faster saves never flash "Saving…"). */
export function useDelayedFlag(active: boolean, delayMs = 400): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

/** The browser's own "Leave site?" prompt while `pending()` says work would be lost. */
export function useLeavePrompt(pending: () => boolean, onLeaving?: () => void): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      onLeaving?.();
      if (!pending()) return;
      event.preventDefault();
      // older browsers need returnValue set to show the prompt
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [pending, onLeaving]);
}

/** Calls `flush` when this tab is hidden or unloaded (the lab's own document reports through the host). */
export function useFlushOnHide(flush: (() => void) | null): void {
  useEffect(() => {
    if (!flush) return undefined;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flush]);
}
