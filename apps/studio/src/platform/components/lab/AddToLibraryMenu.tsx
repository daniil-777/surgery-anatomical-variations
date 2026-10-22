// "Add to Library" (DESIGN.md G3, §9): the lab's own export actions (a shape with its bake, a material …) plus a
// platform snapshot of the view. Files go up content-addressed with progress in a toast; the item records its lab,
// project and version, and the lab's claims verbatim. Research-only exports are refused by the host (LabRightsError).

import { useState } from "react";
import { Camera, Images, Shapes, SwatchBook, Video, Box, Image as ImageIcon, type LucideIcon } from "lucide-react";
import { navigate } from "../../app/router";
import { useBackend } from "../../app/context";
import { invalidate } from "../../app/query";
import type { LabExportInfo } from "../../core/labs/host";
import type { LibraryItem, LibraryKind } from "../../core/types";
import { MenuButton, MenuItem, MenuSection, MenuSeparator, useToast } from "../../ui";
import { friendlyError, isCancellation } from "./friendlyError";
import type { LabHandle } from "./LabFrame";
import { exportToRequest, libraryItemMetadata, libraryTitle, uploadToLibrary, type LibraryUploadRequest } from "./libraryUpload";

export interface LibrarySource {
  labId: string;
  labTitle: string;
  /** The project the item comes from (null in a lab opened without one). */
  projectId: string | null;
  /** The version it matches, when the lab shows a saved version without further changes. */
  versionId: string | null;
  unsavedChanges: boolean;
}

export interface AddToLibraryMenuProps {
  handle: LabHandle | null;
  source: LibrarySource;
  /** The base of generated titles ("Liver Study" → "Liver Study Snapshot"). */
  baseTitle: string;
  /** The lab's busy reason (the menu waits for false). */
  busy: false | string;
  disabled?: boolean | undefined;
}

const KIND_ICON: Partial<Record<LibraryKind, LucideIcon>> = {
  shape: Shapes,
  material: SwatchBook,
  texture: SwatchBook,
  recording: Video,
  model: Box,
  image: ImageIcon,
};

const TOAST_ID = "px-library-job";

/** Shows upload progress and the result in one toast; returns the created item or null. */
export function useLibraryJob(): (job: (onProgress: (fraction: number) => void) => Promise<LibraryItem>) => Promise<LibraryItem | null> {
  const toast = useToast();
  return async (job) => {
    toast.show({ id: TOAST_ID, message: "Adding to the Library…", tone: "info", duration: null, dismissible: false });
    let shown = 0;
    try {
      const item = await job((fraction) => {
        const percent = Math.floor(Math.min(1, Math.max(0, fraction)) * 100);
        // a toast update per 5 % keeps re-renders cheap on large uploads
        if (percent - shown < 5 && percent < 100) return;
        shown = percent;
        toast.show({ id: TOAST_ID, message: `Adding to the Library… ${percent}%`, tone: "info", duration: null, dismissible: false });
      });
      invalidate("library");
      invalidate("account:usage");
      toast.show({
        id: TOAST_ID,
        message: `Added “${item.title}” to the Library.`,
        tone: "success",
        duration: 8000,
        action: { label: "Show in Library", onAction: () => navigate({ name: "library", itemId: item.id }) },
      });
      return item;
    } catch (error) {
      if (isCancellation(error)) {
        toast.dismiss(TOAST_ID);
        return null;
      }
      toast.show({ id: TOAST_ID, message: friendlyError(error, "Couldn't add this to the Library."), tone: "error" });
      return null;
    }
  };
}

function slug(text: string): string {
  const value = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value.slice(0, 60) || "viscera";
}

function imageExtension(type: string): string {
  if (type.includes("webp")) return "webp";
  if (type.includes("jpeg")) return "jpg";
  return "png";
}

/** The generator/material/solver revisions the lab reports with its state (skipped while it is busy). */
async function labVersions(handle: LabHandle): Promise<Record<string, string> | null> {
  if (!handle.connection.adapter() || handle.connection.busy()) return null;
  try {
    const document = await handle.connection.serialize();
    return document.versions ?? null;
  } catch {
    return null;
  }
}

/** A platform still of the lab view (1600 × 1000, cover-cropped) as an "image" item. */
export async function snapshotRequest(handle: LabHandle, source: LibrarySource, baseTitle: string): Promise<LibraryUploadRequest> {
  const still = await handle.connection.thumbnail(1600, 1000);
  if (!still) throw new Error("NOTHING_TO_CAPTURE");
  const title = libraryTitle(`${baseTitle} Snapshot`);
  return {
    kind: "image",
    title,
    labId: source.labId,
    sourceProjectId: source.projectId,
    sourceVersionId: source.versionId,
    files: [{ filename: `${slug(baseTitle)}-snapshot.${imageExtension(still.type)}`, role: "primary", blob: still }],
    thumbnail: still,
    metadata: libraryItemMetadata({
      claims: { evidence: `A still image of the ${source.labTitle} view, captured in the browser.`, limitations: [] },
      provenance: { via: "snapshot", labId: source.labId, labTitle: source.labTitle, projectId: source.projectId, versionId: source.versionId, unsavedChanges: source.unsavedChanges },
      labVersions: await labVersions(handle),
      extra: { image: { width: 1600, height: 1000, mimeType: still.type } },
    }),
  };
}

export function AddToLibraryMenu({ handle, source, baseTitle, busy, disabled = false }: AddToLibraryMenuProps) {
  const backend = useBackend();
  const toast = useToast();
  const runJob = useLibraryJob();
  const [actions, setActions] = useState<LabExportInfo[]>([]);
  const [running, setRunning] = useState(false);
  const unavailable = disabled || handle === null || running;

  const refresh = () => setActions(handle ? handle.connection.exportActions() : []);

  const runExport = async (action: LabExportInfo) => {
    if (!handle) return;
    if (busy) {
      toast.show({ message: `The lab is busy (${busy}). Try again when it has finished.`, tone: "warning" });
      return;
    }
    setRunning(true);
    try {
      await runJob(async (onProgress) => {
        const exported = await handle.connection.runExport(action.id);
        const versions = await labVersions(handle);
        const request = exportToRequest(exported, {
          exportId: action.id,
          labId: source.labId,
          labTitle: source.labTitle,
          projectId: source.projectId,
          versionId: source.versionId,
          unsavedChanges: source.unsavedChanges,
          labVersions: versions,
        });
        return uploadToLibrary(backend, request, { onProgress: ({ loaded, total }) => onProgress(total > 0 ? loaded / total : 1) });
      });
    } finally {
      setRunning(false);
    }
  };

  const runSnapshot = async () => {
    if (!handle) return;
    if (busy) {
      toast.show({ message: `The lab is busy (${busy}). Try again when it has finished.`, tone: "warning" });
      return;
    }
    setRunning(true);
    try {
      const request = await snapshotRequest(handle, source, baseTitle).catch((error: unknown) => {
        if (error instanceof Error && error.message === "NOTHING_TO_CAPTURE") {
          toast.show({ message: "There's nothing to capture yet: the lab hasn't drawn its view.", tone: "warning" });
          return null;
        }
        throw error;
      });
      if (!request) return;
      await runJob((onProgress) =>
        uploadToLibrary(backend, request, { onProgress: ({ loaded, total }) => onProgress(total > 0 ? loaded / total : 1) }),
      );
    } catch (error) {
      toast.show({ id: TOAST_ID, message: friendlyError(error, "Couldn't capture the view."), tone: "error" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <MenuButton
      size="large"
      icon={Images}
      placement="bottom-end"
      className="px-pbar__button"
      aria-disabled={unavailable || undefined}
      loading={running}
      loadingLabel="Adding…"
      onOpenChange={(open) => {
        if (open) refresh();
      }}
      menu={
        <>
          {actions.length > 0 ? (
            <MenuSection title={`From ${source.labTitle}`}>
              {actions.map((action) => (
                <MenuItem key={action.id} icon={KIND_ICON[action.kind] ?? Images} disabled={busy !== false} onSelect={() => void runExport(action)}>
                  {action.label}
                </MenuItem>
              ))}
            </MenuSection>
          ) : null}
          {actions.length > 0 ? <MenuSeparator /> : null}
          <MenuItem icon={Camera} disabled={busy !== false} onSelect={() => void runSnapshot()}>
            Snapshot Image
          </MenuItem>
        </>
      }
    >
      Add to Library
    </MenuButton>
  );
}
