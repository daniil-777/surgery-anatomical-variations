// Imported objects of the signed-in account: the cached list and single objects (keys carry the user id, like the
// shell's queries), and the edits people make — rename, tags, favourite, source, Trash with Undo, downloads. Edits show
// at once and roll back with an error toast when the server refuses them (APPLE_STYLE_SPEC §4.4).

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlatform, useSession } from "../../app/context";
import { errorMessage, isSilentError } from "../../app/messages";
import { invalidate, setQueryData, type QueryResult } from "../../app/query";
import { ACCOUNT_KEY_PREFIX, useFreshQuery } from "../../app/shell/queries";
import type { ImportedObject, ImportPatch, SourceApp, Uuid } from "../../core/types";
import { useToast } from "../../ui";
import { glbFileName, originalFileName, viewerAssetId } from "./model";
import { IMPORTS_KEY_PREFIX } from "./queue";

/** Accounts keep at most 2 000 imports (DESIGN.md §15.4), so the list holds all of them. */
const LIST_LIMIT = 2000;

export function importsListKey(userId: Uuid): string {
  return `${IMPORTS_KEY_PREFIX}list:${userId}`;
}

export function importKey(userId: Uuid, objectId: Uuid): string {
  return `${IMPORTS_KEY_PREFIX}object:${userId}:${objectId}`;
}

/** Every imported object outside the Trash, newest first. */
export function useImportsList(): QueryResult<ImportedObject[]> {
  const { backend } = usePlatform();
  const userId = useSession()?.user.id ?? null;
  return useFreshQuery(userId ? importsListKey(userId) : null, () => backend.imports.list({ limit: LIST_LIMIT }));
}

export function useImportedObject(objectId: Uuid | null): QueryResult<ImportedObject> {
  const { backend } = usePlatform();
  const userId = useSession()?.user.id ?? null;
  return useFreshQuery(userId && objectId ? importKey(userId, objectId) : null, () => backend.imports.get(objectId ?? ""));
}

/**
 * The bytes of an asset (downloaded once, then cached by its SHA-256); aborted when the id changes or on unmount. A new
 * `attempt` downloads again after a failure.
 */
export function useAssetBlob(assetId: Uuid | null, attempt = 0): { blob: Blob | null; error: unknown; loading: boolean } {
  const { backend } = usePlatform();
  const [state, setState] = useState<{ key: string | null; blob: Blob | null; error: unknown }>({ key: null, blob: null, error: null });
  const key = assetId ? `${assetId}#${attempt}` : null;
  useEffect(() => {
    if (!assetId || !key) return undefined;
    const controller = new AbortController();
    backend.assets.get(assetId, { signal: controller.signal }).then(
      (blob) => {
        if (!controller.signal.aborted) setState({ key, blob, error: null });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, blob: null, error });
      },
    );
    return () => controller.abort();
  }, [backend, assetId, key]);
  const current = state.key === key;
  return { blob: current ? state.blob : null, error: current ? state.error : null, loading: key !== null && !current };
}

function pick(object: ImportedObject, keys: ReadonlyArray<keyof ImportedObject>): Partial<ImportedObject> {
  const result: Partial<Record<keyof ImportedObject, unknown>> = {};
  for (const key of keys) result[key] = object[key];
  return result as Partial<ImportedObject>;
}

export interface ImportActions {
  rename(object: ImportedObject, title: string): Promise<boolean>;
  setTags(object: ImportedObject, tags: string[]): Promise<boolean>;
  setFavorite(objects: readonly ImportedObject[], favorite: boolean): Promise<void>;
  /** A correction of the detected application: stored with "detected by" = the person. */
  setSource(object: ImportedObject, sourceApp: SourceApp): Promise<boolean>;
  /** Moves to the Trash and offers Undo in a toast (no alert for an undoable action, HIG). */
  moveToTrash(objects: readonly ImportedObject[]): Promise<boolean>;
  download(object: ImportedObject, which: "original" | "glb"): Promise<void>;
}

export function useImportActions(): ImportActions {
  const { backend } = usePlatform();
  const userId = useSession()?.user.id ?? null;
  const toast = useToast();

  const patchCached = useCallback(
    (id: Uuid, change: (object: ImportedObject) => ImportedObject) => {
      if (!userId) return;
      setQueryData<ImportedObject[] | undefined>(importsListKey(userId), (list) => list?.map((item) => (item.id === id ? change(item) : item)));
      setQueryData<ImportedObject | undefined>(importKey(userId, id), (item) => (item ? change(item) : item));
    },
    [userId],
  );

  const fail = useCallback(
    (error: unknown, context: "save" | "load" | "delete" | "recover") => {
      if (!isSilentError(error)) toast.show({ tone: "error", message: errorMessage(error, context) });
    },
    [toast],
  );

  const update = useCallback(
    async (object: ImportedObject, patch: ImportPatch, optimistic: Partial<ImportedObject>): Promise<ImportedObject | null> => {
      const previous = pick(object, Object.keys(optimistic) as Array<keyof ImportedObject>);
      patchCached(object.id, (item) => ({ ...item, ...optimistic }));
      try {
        const updated = await backend.imports.update(object.id, patch);
        patchCached(object.id, () => updated);
        return updated;
      } catch (error) {
        patchCached(object.id, (item) => ({ ...item, ...previous }));
        fail(error, "save");
        return null;
      }
    },
    [backend, patchCached, fail],
  );

  return useMemo<ImportActions>(
    () => ({
      async rename(object, title) {
        const trimmed = title.trim();
        if (trimmed === "" || trimmed === object.title) return trimmed !== "";
        return (await update(object, { title: trimmed }, { title: trimmed })) !== null;
      },
      async setTags(object, tags) {
        return (await update(object, { tags }, { tags })) !== null;
      },
      async setFavorite(objects, favorite) {
        await Promise.all(objects.filter((object) => object.favorite !== favorite).map((object) => update(object, { favorite }, { favorite })));
      },
      async setSource(object, sourceApp) {
        if (sourceApp === object.sourceApp && object.detectedBy === "user") return true;
        return (await update(object, { sourceApp }, { sourceApp, detectedBy: "user" })) !== null;
      },
      async moveToTrash(objects) {
        if (!userId || objects.length === 0) return false;
        const ids = new Set(objects.map((object) => object.id));
        setQueryData<ImportedObject[] | undefined>(importsListKey(userId), (list) => list?.filter((item) => !ids.has(item.id)));
        const results = await Promise.allSettled(objects.map((object) => backend.imports.update(object.id, { trashed: true })));
        const moved = objects.filter((_, index) => results[index]?.status === "fulfilled");
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        invalidate(IMPORTS_KEY_PREFIX);
        invalidate(ACCOUNT_KEY_PREFIX);
        if (failure) fail(failure.reason, "delete");
        if (moved.length === 0) return false;
        const first = moved[0];
        toast.show({
          tone: "info",
          message: moved.length === 1 && first ? `Moved “${first.title}” to the Trash.` : `Moved ${moved.length} imports to the Trash.`,
          action: {
            label: "Undo",
            onAction: () => {
              void Promise.allSettled(moved.map((object) => backend.imports.update(object.id, { trashed: false }))).then((undone) => {
                invalidate(IMPORTS_KEY_PREFIX);
                invalidate(ACCOUNT_KEY_PREFIX);
                const undoFailure = undone.find((result): result is PromiseRejectedResult => result.status === "rejected");
                if (undoFailure) fail(undoFailure.reason, "recover");
              });
            },
          },
        });
        return true;
      },
      async download(object, which) {
        const assetId = which === "glb" ? viewerAssetId(object) : object.originalAssetId;
        if (!assetId) return;
        try {
          let name = glbFileName(object);
          if (which === "original") {
            const [asset] = await backend.assets.describe([assetId]);
            name = originalFileName(object, asset?.mimeType ?? null);
          }
          const url = await backend.assets.url(assetId, { download: name });
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = name;
          anchor.rel = "noopener";
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
        } catch (error) {
          fail(error, "load");
        }
      },
    }),
    [backend, update, userId, toast, fail],
  );
}
