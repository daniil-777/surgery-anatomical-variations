// A small keyed cache for the shell's lists and records (projects, library, imports, usage …): one fetch per key shared by
// every component that shows it, stale-while-revalidate after writes through invalidate(), cleared on sign-out.
import { useCallback, useEffect, useSyncExternalStore } from "react";

interface Entry {
  data: unknown;
  error: unknown;
  loading: boolean;
  stale: boolean;
  promise: Promise<unknown> | null;
  fetcher: (() => Promise<unknown>) | null;
  listeners: Set<() => void>;
  version: number;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refresh(): Promise<void>;
}

const entries = new Map<string, Entry>();
const snapshots = new Map<string, { version: number; value: { data: unknown; error: unknown; loading: boolean } }>();

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { data: undefined, error: undefined, loading: false, stale: true, promise: null, fetcher: null, listeners: new Set(), version: 0 };
    entries.set(key, entry);
  }
  return entry;
}

function notify(entry: Entry): void {
  entry.version += 1;
  for (const listener of [...entry.listeners]) listener();
}

function load(key: string): Promise<unknown> {
  const entry = entryFor(key);
  if (entry.promise) return entry.promise;
  const fetcher = entry.fetcher;
  if (!fetcher) return Promise.resolve(entry.data);
  entry.loading = true;
  entry.stale = false;
  notify(entry);
  const promise = fetcher().then(
    (data) => {
      if (entry.promise === promise) {
        entry.data = data;
        entry.error = undefined;
      }
      return data;
    },
    (error: unknown) => {
      if (entry.promise === promise) entry.error = error;
      return undefined;
    },
  );
  entry.promise = promise;
  void promise.finally(() => {
    if (entry.promise !== promise) return;
    entry.promise = null;
    entry.loading = false;
    notify(entry);
    if (entry.stale && entry.listeners.size > 0) void load(key);
  });
  return promise;
}

/** Cached data for `key` (null = do not fetch). The latest `fetcher` is used for every load. */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>): QueryResult<T> {
  if (key !== null) entryFor(key).fetcher = fetcher as () => Promise<unknown>;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (key === null) return () => {};
      const entry = entryFor(key);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(() => {
    if (key === null) return EMPTY;
    const entry = entryFor(key);
    const cached = snapshots.get(key);
    if (cached && cached.version === entry.version) return cached.value;
    const value = { data: entry.data, error: entry.error, loading: entry.loading };
    snapshots.set(key, { version: entry.version, value });
    return value;
  }, [key]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (key === null) return;
    const entry = entryFor(key);
    if (entry.stale && !entry.promise) void load(key);
  }, [key]);
  const refresh = useCallback(async () => {
    if (key === null) return;
    entryFor(key).stale = true;
    await load(key);
  }, [key]);
  return { data: state.data as T | undefined, error: state.error, loading: state.loading, refresh };
}

const EMPTY = { data: undefined, error: undefined, loading: false };

/** Marks every key starting with `prefix` stale and reloads the ones on screen. */
export function invalidate(prefix: string): void {
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue;
    entry.stale = true;
    if (entry.listeners.size > 0) void load(key);
  }
}

/** Writes a value into the cache (optimistic updates); `updater` receives the current value. */
export function setQueryData<T>(key: string, updater: (current: T | undefined) => T): void {
  const entry = entryFor(key);
  entry.data = updater(entry.data as T | undefined);
  entry.error = undefined;
  notify(entry);
}

/** Drops everything (sign-out, account switch). */
export function clearQueries(): void {
  for (const entry of entries.values()) {
    entry.data = undefined;
    entry.error = undefined;
    entry.stale = true;
    entry.promise = null;
    notify(entry);
  }
}
