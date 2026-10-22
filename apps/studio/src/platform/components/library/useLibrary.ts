// The Library's data on top of the shell's query cache (app/query.ts): the item list and single items (keys carry the
// user id, like the shell's own), optimistic edits that roll back with a toast when the server refuses them (§4.4),
// Move to Trash with Undo, downloads (one file through a signed URL, several as a streamed zip) and the upload queue.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useBackend, useSession } from "../../app/context";
import { invalidate, setQueryData, type QueryResult } from "../../app/query";
import { ACCOUNT_KEY_PREFIX, useFreshQuery, useUsage } from "../../app/shell/queries";
import { PlatformError, type LibraryFile, type LibraryItem, type LibraryPatch, type PlatformBackend, type Uuid } from "../../core/types";
import { formatPercent, useToast } from "../../ui";
import { buildZip, saveBlob, triggerDownload, type ZipSource } from "../media/download";
import { shouldCompress, zipEntryPaths, zipFileName } from "../media/zipNames";
import { isSilentError, libraryErrorMessage } from "./messages";
import { probeUpload } from "./probe";
import { inferUpload, UPLOAD_SNIFF_BYTES, displayName } from "./uploadKind";
import { uploadStoreFor, type UploadEntry, type UploadEvent } from "./uploadStore";

export const LIBRARY_KEY_PREFIX = "library:";
/** Rows fetched for the grid (the server's default page; accounts may hold up to 5 000 items, §15.4). */
export const LIBRARY_LIST_LIMIT = 1000;

export function libraryListKey(userId: Uuid): string {
  return `${LIBRARY_KEY_PREFIX}list:${userId}`;
}

export function libraryItemKey(userId: Uuid, itemId: Uuid): string {
  return `${LIBRARY_KEY_PREFIX}item:${userId}:${itemId}`;
}

/** Every item that is not in the Trash, newest first (the grid sorts and filters locally). */
export function useLibraryList(): QueryResult<LibraryItem[]> {
  const backend = useBackend();
  const userId = useSession()?.user.id ?? null;
  return useFreshQuery(userId ? libraryListKey(userId) : null, () => backend.library.list({ limit: LIBRARY_LIST_LIMIT }));
}

/** One item with its files (list rows may come without them). */
export function useLibraryItem(itemId: Uuid | null): QueryResult<LibraryItem> {
  const backend = useBackend();
  const userId = useSession()?.user.id ?? null;
  return useFreshQuery(userId && itemId ? libraryItemKey(userId, itemId) : null, () => backend.library.get(itemId as Uuid));
}

function mergeItem(current: LibraryItem | undefined, next: LibraryItem): LibraryItem {
  // update() answers may omit the files a get() returned
  return next.files === undefined && current?.files !== undefined ? { ...next, files: current.files } : next;
}

/** Applies `change` to the cached copies of `ids` (list and single items); returns a function that puts them back. */
function patchCached(userId: Uuid, ids: ReadonlySet<Uuid>, change: (item: LibraryItem) => LibraryItem): () => void {
  const before = new Map<Uuid, LibraryItem>();
  setQueryData<LibraryItem[] | undefined>(libraryListKey(userId), (list) =>
    list?.map((item) => {
      if (!ids.has(item.id)) return item;
      before.set(item.id, item);
      return change(item);
    }),
  );
  const singles = new Map<Uuid, LibraryItem | undefined>();
  for (const id of ids) {
    setQueryData<LibraryItem | undefined>(libraryItemKey(userId, id), (item) => {
      singles.set(id, item);
      return item ? change(item) : item;
    });
  }
  return () => {
    setQueryData<LibraryItem[] | undefined>(libraryListKey(userId), (list) => list?.map((item) => before.get(item.id) ?? item));
    for (const [id, item] of singles) setQueryData<LibraryItem | undefined>(libraryItemKey(userId, id), () => item);
  };
}

/** Stores the server's copy of an item in both caches. */
function storeItem(userId: Uuid, item: LibraryItem): void {
  // keep the files the list already knows (list rows may omit them; exactOptionalPropertyTypes forbids files: undefined)
  setQueryData<LibraryItem[] | undefined>(libraryListKey(userId), (list) =>
    list?.map((entry) => (entry.id !== item.id ? entry : entry.files ? { ...item, files: entry.files } : item)),
  );
  setQueryData<LibraryItem | undefined>(libraryItemKey(userId, item.id), (current) => mergeItem(current, item));
}

export interface LibraryActions {
  /** Rename, describe, tag: resolves false (after a toast and rollback) when the server refused. */
  update(item: LibraryItem, patch: Omit<LibraryPatch, "trashed">): Promise<boolean>;
  setFavorite(items: readonly LibraryItem[], favorite: boolean): Promise<void>;
  /** Moves items to the Trash at once and offers Undo. */
  moveToTrash(items: readonly LibraryItem[]): Promise<void>;
  restore(items: readonly LibraryItem[]): Promise<void>;
}

export function useLibraryActions(): LibraryActions {
  const backend = useBackend();
  const userId = useSession()?.user.id ?? null;
  const toast = useToast();

  const failed = useCallback(
    (error: unknown, action: "update" | "trash" | "restore", name?: string) => {
      if (!isSilentError(error)) toast.show({ tone: "error", message: libraryErrorMessage(error, action, { name }) });
    },
    [toast],
  );

  /** Runs `patch` on every item; rolls back the ones the server refused. */
  const patchAll = useCallback(
    async (items: readonly LibraryItem[], patch: LibraryPatch, local: (item: LibraryItem) => LibraryItem, action: "update" | "trash" | "restore") => {
      if (!userId || items.length === 0) return items.length === 0;
      const rollback = new Map<Uuid, () => void>();
      for (const item of items) rollback.set(item.id, patchCached(userId, new Set([item.id]), local));
      const results = await Promise.allSettled(items.map((item) => backend.library.update(item.id, patch)));
      let firstError: unknown = null;
      let failedName: string | undefined;
      results.forEach((result, index) => {
        const item = items[index] as LibraryItem;
        if (result.status === "fulfilled") storeItem(userId, result.value);
        else {
          rollback.get(item.id)?.();
          if (firstError === null) {
            firstError = result.reason;
            failedName = item.title;
          }
        }
      });
      if (firstError !== null) failed(firstError, action, items.length === 1 ? failedName : undefined);
      return firstError === null;
    },
    [backend, userId, failed],
  );

  const restore = useCallback(
    async (items: readonly LibraryItem[]) => {
      await patchAll(items, { trashed: false }, (item) => ({ ...item, trashedAt: null }), "restore");
      invalidate(ACCOUNT_KEY_PREFIX);
    },
    [patchAll],
  );

  return useMemo<LibraryActions>(
    () => ({
      update: (item, patch) => patchAll([item], patch, (current) => ({ ...current, ...patch }), "update"),
      setFavorite: async (items, favorite) => {
        await patchAll(
          items.filter((item) => item.favorite !== favorite),
          { favorite },
          (item) => ({ ...item, favorite }),
          "update",
        );
      },
      moveToTrash: async (items) => {
        if (items.length === 0) return;
        const now = new Date().toISOString();
        const ok = await patchAll(items, { trashed: true }, (item) => ({ ...item, trashedAt: now }), "trash");
        invalidate(ACCOUNT_KEY_PREFIX);
        if (!ok) return;
        const first = items[0] as LibraryItem;
        toast.show({
          message: items.length === 1 ? `Moved “${first.title}” to the Trash.` : `Moved ${items.length} items to the Trash.`,
          action: { label: "Undo", onAction: () => void restore(items) },
        });
      },
      restore,
    }),
    [patchAll, restore, toast],
  );
}

export function fileKey(file: Pick<LibraryFile, "assetId" | "filename">): string {
  return `${file.assetId}/${file.filename}`;
}

export interface LibraryDownloads {
  /** Keys (fileKey) of single files being fetched. */
  busyFiles: ReadonlySet<string>;
  /** 0…1 while a zip is being built, else null. */
  zipProgress: number | null;
  downloadFile(file: LibraryFile): Promise<void>;
  /** One file downloads as itself; anything more becomes a zip (one folder per item when there are several). */
  downloadItems(items: readonly LibraryItem[]): Promise<void>;
  cancelZip(): void;
}

async function withFiles(backend: PlatformBackend, items: readonly LibraryItem[]): Promise<LibraryItem[]> {
  return Promise.all(items.map((item) => (item.files ? Promise.resolve(item) : backend.library.get(item.id))));
}

export function useLibraryDownloads(): LibraryDownloads {
  const backend = useBackend();
  const toast = useToast();
  const [busyFiles, setBusyFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [zipProgress, setZipProgress] = useState<number | null>(null);
  const zipping = useRef<AbortController | null>(null);

  useEffect(() => () => zipping.current?.abort(), []);

  const downloadFile = useCallback(
    async (file: LibraryFile) => {
      const key = fileKey(file);
      setBusyFiles((current) => new Set([...current, key]));
      try {
        const url = await backend.assets.url(file.assetId, { download: file.filename });
        triggerDownload(url, file.filename);
      } catch (error) {
        if (!isSilentError(error)) toast.show({ tone: "error", message: libraryErrorMessage(error, "download", { name: file.filename }) });
      } finally {
        setBusyFiles((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [backend, toast],
  );

  const downloadItems = useCallback(
    async (items: readonly LibraryItem[]) => {
      if (items.length === 0 || zipping.current) return;
      const controller = new AbortController();
      zipping.current = controller;
      const toastId = "px-library-zip";
      let name = zipFileName(items.map((item) => item.title));
      try {
        const full = await withFiles(backend, items);
        const files = full.flatMap((item) => item.files ?? []);
        if (full.length === 1 && files.length === 1) {
          zipping.current = null;
          await downloadFile(files[0] as LibraryFile);
          return;
        }
        if (files.length === 0) throw new PlatformError("not_found", "No files.");
        name = zipFileName(full.map((item) => item.title));
        const paths = zipEntryPaths(full.map((item) => ({ title: item.title, filenames: (item.files ?? []).map((file) => file.filename) })));
        const sources: ZipSource[] = full.flatMap((item, itemIndex) =>
          (item.files ?? []).map((file, fileIndex) => ({
            path: paths[itemIndex]?.[fileIndex] ?? file.filename,
            size: file.byteSize ?? 0,
            compress: shouldCompress(file.filename, file.mimeType),
            modified: new Date(item.createdAt),
            open: (signal?: AbortSignal) => backend.assets.get(file.assetId, signal ? { signal } : {}),
          })),
        );
        setZipProgress(0);
        const show = (fraction: number) =>
          toast.show({
            id: toastId,
            message: `Preparing “${name}”… ${formatPercent(fraction)}`,
            duration: null,
            dismissible: false,
            action: { label: "Cancel", onAction: () => controller.abort() },
          });
        show(0);
        let shown = 0;
        const blob = await buildZip(sources, {
          signal: controller.signal,
          onProgress: (progress) => {
            const fraction = progress.total > 0 ? progress.loaded / progress.total : progress.file / progress.files;
            setZipProgress(fraction);
            // a toast update per percent is plenty
            if (Math.floor(fraction * 100) !== Math.floor(shown * 100)) {
              shown = fraction;
              show(fraction);
            }
          },
        });
        saveBlob(blob, name);
        toast.dismiss(toastId);
      } catch (error) {
        toast.dismiss(toastId);
        if (!isSilentError(error)) toast.show({ tone: "error", message: libraryErrorMessage(error, "download", { name }) });
      } finally {
        if (zipping.current === controller) zipping.current = null;
        setZipProgress(null);
      }
    },
    [backend, toast, downloadFile],
  );

  return useMemo(
    () => ({ busyFiles, zipProgress, downloadFile, downloadItems, cancelZip: () => zipping.current?.abort() }),
    [busyFiles, zipProgress, downloadFile, downloadItems],
  );
}

export interface LibraryUploads {
  entries: readonly UploadEntry[];
  /** Checks each file (kind, plan limit) and queues the acceptable ones; returns their entry ids. */
  add(files: readonly File[]): Promise<string[]>;
  cancel(id: string): void;
  retry(id: string): void;
  onEvent(listener: (event: UploadEvent) => void): () => void;
}

export function useLibraryUploads(): LibraryUploads {
  const backend = useBackend();
  const userId = useSession()?.user.id ?? null;
  const usage = useUsage().data;
  const toast = useToast();
  const store = useMemo(() => uploadStoreFor(backend, probeUpload), [backend]);
  const entries = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const maxFileBytes = usage?.maxFileBytes;

  // finished uploads join the cached list at once; counts and storage refresh
  useEffect(
    () =>
      store.onEvent((event) => {
        if (event.type !== "uploaded" || !userId) return;
        setQueryData<LibraryItem[] | undefined>(libraryListKey(userId), (list) => (list ? [event.item, ...list.filter((item) => item.id !== event.item.id)] : list));
        setQueryData<LibraryItem | undefined>(libraryItemKey(userId, event.item.id), () => event.item);
        invalidate(ACCOUNT_KEY_PREFIX);
      }),
    [store, userId],
  );

  // a signed-out shell keeps nothing of the previous account
  useEffect(() => {
    if (userId === null) store.clear();
  }, [store, userId]);

  const add = useCallback(
    async (files: readonly File[]) => {
      const refusals: string[] = [];
      const ids: string[] = [];
      for (const file of files) {
        let head = new Uint8Array();
        try {
          head = new Uint8Array(await file.slice(0, UPLOAD_SNIFF_BYTES).arrayBuffer());
        } catch {
          // unreadable (a folder, a file removed meanwhile): the name decides, and the upload will say what failed
        }
        const decision = inferUpload({ name: file.name, type: file.type, size: file.size }, head);
        if (!decision.ok) {
          refusals.push(decision.reason);
          continue;
        }
        if (maxFileBytes !== undefined && file.size > maxFileBytes) {
          refusals.push(libraryErrorMessage(new PlatformError("file_too_large"), "upload", { name: displayName(file.name), maxFileBytes }));
          continue;
        }
        ids.push(store.enqueue(file, decision.plan));
      }
      if (refusals.length === 1) toast.show({ tone: "error", message: refusals[0] as string });
      else if (refusals.length > 1) {
        toast.show({ tone: "error", message: `${refusals[0] as string} ${refusals.length - 1 === 1 ? "1 more file was" : `${refusals.length - 1} more files were`} not uploaded.` });
      }
      return ids;
    },
    [store, toast, maxFileBytes],
  );

  return useMemo(
    () => ({ entries, add, cancel: (id: string) => store.cancel(id), retry: (id: string) => store.retry(id), onEvent: (listener: (event: UploadEvent) => void) => store.onEvent(listener) }),
    [entries, add, store],
  );
}
