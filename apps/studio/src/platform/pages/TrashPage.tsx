// Trash (DESIGN.md §6, §10): trashed projects, library items and imports in one grid, newest first, each with the days
// left before maintenance deletes it (30 days, maintenance_run). Recover moves items back; Delete removes them at once
// after a confirmation (the database only deletes rows that are in the trash). Like Photos' Recently Deleted: with
// nothing selected the toolbar offers Recover All and Delete All; with a selection, Recover and Delete.

import { useMemo, useState, type MouseEvent } from "react";
import { Box, Cuboid, FolderClosed, Image, Import, Info, Palette, PersonStanding, SwatchBook, Trash2, Video, type LucideIcon } from "lucide-react";
import { getLab, type LabDefinition } from "../core/labs/registry";
import type { ImportedObject, LibraryItem, LibraryKind, Project, Uuid } from "../core/types";
import {
  Alert,
  Badge,
  Button,
  ContextMenu,
  EmptyState,
  Icon,
  MediaCard,
  MediaGrid,
  MenuItem,
  MenuSeparator,
  Skeleton,
  formatCount,
  useDeferredLoading,
  useToast,
} from "../ui";
import { usePlatform, useSession } from "../app/context";
import { errorMessage } from "../app/messages";
import { invalidate } from "../app/query";
import { LabPlaceholder, Page } from "../app/shell/Page";
import { PageToolbar } from "../app/shell/PageToolbar";
import { ACCOUNT_KEY_PREFIX, useAssetUrl, useFreshQuery } from "../app/shell/queries";
import { libraryKindName, sourceAppName } from "../app/shell/routeMeta";
import { TRASH_RETENTION_DAYS, formatDaysLeft, trashDaysLeft } from "../app/shell/time";
import "../app/shell/styles/trash.css";

type EntryType = "project" | "library" | "import";

interface TrashEntry {
  /** Unique across the three tables (the grid's option id). */
  key: string;
  type: EntryType;
  id: Uuid;
  title: string;
  subtitle: string;
  trashedAt: string;
  thumbnailAssetId: Uuid | null;
  lab: LabDefinition | null;
  icon: LucideIcon;
}

const KIND_ICONS: Record<LibraryKind, LucideIcon> = {
  shape: Cuboid,
  material: Palette,
  texture: SwatchBook,
  recording: Video,
  scene: PersonStanding,
  image: Image,
  model: Box,
};

function projectEntry(project: Project): TrashEntry {
  const lab = getLab(project.labId);
  return {
    key: `project:${project.id}`,
    type: "project",
    id: project.id,
    title: project.title,
    subtitle: `Project · ${lab?.title ?? "Lab"}`,
    trashedAt: project.trashedAt ?? project.updatedAt,
    thumbnailAssetId: project.thumbnailAssetId ?? project.draftThumbnailAssetId,
    lab,
    icon: FolderClosed,
  };
}

function libraryEntry(item: LibraryItem): TrashEntry {
  const lab = item.labId ? getLab(item.labId) : null;
  return {
    key: `library:${item.id}`,
    type: "library",
    id: item.id,
    title: item.title,
    subtitle: `${libraryKindName(item.kind)} · Library`,
    trashedAt: item.trashedAt ?? item.updatedAt,
    thumbnailAssetId: item.thumbnailAssetId,
    lab,
    icon: KIND_ICONS[item.kind],
  };
}

function importEntry(object: ImportedObject): TrashEntry {
  return {
    key: `import:${object.id}`,
    type: "import",
    id: object.id,
    title: object.title,
    subtitle: object.sourceApp === "unknown" ? "Import" : `Import · ${sourceAppName(object.sourceApp)}`,
    trashedAt: object.trashedAt ?? object.updatedAt,
    thumbnailAssetId: object.thumbnailAssetId,
    lab: null,
    icon: Import,
  };
}

function itemsLabel(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

export default function TrashPage() {
  const { backend } = usePlatform();
  const toast = useToast();
  const userId = useSession()?.user.id ?? null;
  const projects = useFreshQuery(userId ? `trash:projects:${userId}` : null, () => backend.projects.list({ trashed: true }));
  const library = useFreshQuery(userId ? `trash:library:${userId}` : null, () => backend.library.list({ trashed: true }));
  const imports = useFreshQuery(userId ? `trash:imports:${userId}` : null, () => backend.imports.list({ trashed: true }));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState<TrashEntry[] | null>(null);
  const [busy, setBusy] = useState<"recover" | "delete" | null>(null);

  const entries = useMemo(() => {
    const all = [
      ...(projects.data ?? []).map(projectEntry),
      ...(library.data ?? []).map(libraryEntry),
      ...(imports.data ?? []).map(importEntry),
    ];
    return all.sort((a, b) => Date.parse(b.trashedAt) - Date.parse(a.trashedAt) || a.key.localeCompare(b.key));
  }, [projects.data, library.data, imports.data]);

  const loading = [projects, library, imports].some((query) => query.data === undefined && query.loading);
  const failure = [projects, library, imports].find((query) => query.data === undefined && query.error !== undefined && !query.loading)?.error;
  const showSkeleton = useDeferredLoading(loading);
  const chosen = entries.filter((entry) => selected.has(entry.key));
  const now = Date.now();

  const refreshAll = () => {
    invalidate("trash:");
    invalidate("projects");
    invalidate("library");
    invalidate("imports");
    invalidate(ACCOUNT_KEY_PREFIX);
  };

  const recover = async (targets: TrashEntry[]) => {
    if (busy || targets.length === 0) return;
    setBusy("recover");
    const results = await Promise.allSettled(
      targets.map((entry) =>
        entry.type === "project"
          ? backend.projects.update(entry.id, { trashed: false })
          : entry.type === "library"
            ? backend.library.update(entry.id, { trashed: false })
            : backend.imports.update(entry.id, { trashed: false }),
      ),
    );
    setBusy(null);
    setSelected(new Set());
    refreshAll();
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const recovered = targets.length - failed.length;
    if (failed.length === 0) toast.show({ tone: "success", message: `Recovered ${itemsLabel(recovered)}.` });
    else {
      const reason = errorMessage(failed[0]?.reason, "recover");
      toast.show({ tone: "error", message: recovered > 0 ? `Recovered ${itemsLabel(recovered)}. ${failed.length} couldn’t be recovered: ${reason}` : reason });
    }
  };

  const deleteForever = async (targets: TrashEntry[]) => {
    if (busy || targets.length === 0) return;
    setBusy("delete");
    const results = await Promise.allSettled(
      targets.map((entry) =>
        entry.type === "project"
          ? backend.projects.deleteForever(entry.id)
          : entry.type === "library"
            ? backend.library.deleteForever(entry.id)
            : backend.imports.deleteForever(entry.id),
      ),
    );
    setBusy(null);
    setConfirming(null);
    setSelected(new Set());
    refreshAll();
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const deleted = targets.length - failed.length;
    if (failed.length === 0) toast.show({ tone: "success", message: `Deleted ${itemsLabel(deleted)}.` });
    else toast.show({ tone: "error", message: errorMessage(failed[0]?.reason, "delete") });
  };

  const targets = chosen.length > 0 ? chosen : entries;
  const empty = !loading && failure === undefined && entries.length === 0;

  // right-clicking an unselected card selects it first, as in Finder
  const selectUnderPointer = (event: MouseEvent<HTMLDivElement>) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"][data-id]');
    const key = option?.dataset.id;
    if (key && !selected.has(key)) setSelected(new Set([key]));
  };

  const confirmTitle =
    confirming && confirming.length === 1
      ? `Delete “${confirming[0]?.title ?? ""}” Now?`
      : confirming && confirming.length === entries.length
        ? "Delete All Items in the Trash?"
        : `Delete ${confirming?.length ?? 0} Items Now?`;

  return (
    <>
      <PageToolbar
        title="Trash"
        subtitle={entries.length > 0 ? formatCount(entries.length, "Item") : undefined}
        trailing={
          entries.length > 0 ? (
            <>
              <Button size="toolbar" variant="glass" loading={busy === "recover"} loadingLabel="Recovering…" aria-disabled={busy !== null ? true : undefined} onClick={() => void recover(targets)}>
                {chosen.length > 0 ? "Recover" : "Recover All"}
              </Button>
              <Button size="toolbar" variant="glass" className="px-trash-delete" aria-disabled={busy !== null ? true : undefined} onClick={() => setConfirming(targets)}>
                {chosen.length > 0 ? "Delete…" : "Delete All…"}
              </Button>
            </>
          ) : undefined
        }
      />
      <Page className="px-trash">
        <p className="px-trash-note">
          <Icon icon={Info} size={14} />
          <span>Items in the Trash are deleted permanently after {TRASH_RETENTION_DAYS} days.</span>
        </p>
        {loading ? (
          showSkeleton ? (
            <div className="px-trash-skeleton" aria-busy="true" aria-label="Loading the Trash">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="px-trash-skeleton__card">
                  <Skeleton height="auto" radius={10} className="px-trash-skeleton__thumb" />
                  <Skeleton width="60%" />
                  <Skeleton width="40%" />
                </div>
              ))}
            </div>
          ) : null
        ) : failure !== undefined ? (
          <EmptyState
            icon={Trash2}
            title="Couldn’t Load the Trash"
            description={errorMessage(failure, "load")}
            action={
              <Button
                onClick={() => {
                  void projects.refresh();
                  void library.refresh();
                  void imports.refresh();
                }}
              >
                Try Again
              </Button>
            }
          />
        ) : empty ? (
          <EmptyState icon={Trash2} title="Trash Is Empty" description="Projects, library items and imports you delete stay here for 30 days, so you can recover them." />
        ) : (
          <div onContextMenuCapture={selectUnderPointer}>
            <ContextMenu
              aria-label="Trash item actions"
              menu={
                <>
                  <MenuItem onSelect={() => void recover(chosen)} disabled={chosen.length === 0}>
                    {chosen.length > 1 ? `Recover ${chosen.length} Items` : "Recover"}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem destructive onSelect={() => setConfirming(chosen)} disabled={chosen.length === 0}>
                    Delete Now…
                  </MenuItem>
                </>
              }
            >
              <MediaGrid
                aria-label="Items in the Trash"
                selected={selected}
                onSelectionChange={setSelected}
                onDelete={(keys) => {
                  const list = entries.filter((entry) => keys.includes(entry.key));
                  if (list.length > 0) setConfirming(list);
                }}
              >
                {entries.map((entry) => (
                  <TrashCard key={entry.key} entry={entry} daysLeft={trashDaysLeft(entry.trashedAt, now)} />
                ))}
              </MediaGrid>
            </ContextMenu>
          </div>
        )}
      </Page>
      <Alert
        open={confirming !== null}
        onClose={() => {
          if (busy !== "delete") setConfirming(null);
        }}
        title={confirmTitle}
        message={`${confirming && confirming.length === 1 ? "This item" : "These items"} will be deleted immediately, with ${confirming && confirming.length === 1 ? "its" : "their"} files and versions. You can’t undo this action.`}
        icon={<Icon icon={Trash2} size={40} className="px-trash-alert-icon" />}
        actionLabel={busy === "delete" ? "Deleting…" : "Delete"}
        destructive
        onAction={() => {
          if (confirming) void deleteForever(confirming);
        }}
      />
    </>
  );
}

function TrashCard({ entry, daysLeft }: { entry: TrashEntry; daysLeft: number }) {
  const url = useAssetUrl(entry.thumbnailAssetId);
  const left = formatDaysLeft(daysLeft);
  return (
    <MediaCard
      id={entry.key}
      title={entry.title}
      subtitle={entry.subtitle}
      thumbnail={url}
      placeholder={<LabPlaceholder lab={entry.lab} />}
      kindIcon={entry.icon}
      badges={<Badge tone="hud">{left}</Badge>}
      description={daysLeft <= 0 ? "Deleted within a day" : `${left} left`}
    />
  );
}
