// The Imports space (APPLE_STYLE_SPEC §3.5, DESIGN.md G4): objects people bring from Unity, Blender and other tools.
// Toolbar: title and count, the All · Unity · Blender · Other scope with counts, search, Import… (⌘O). Content: a drop
// zone (large when there is nothing yet, a strip above the grid otherwise), the rows of imports in progress, then the
// grid in source sections. Files dropped anywhere on the window are imported; the inspector shows the selection.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, CircleAlert, FolderOpen, Import, Info, SearchX } from "lucide-react";
import { useBackend } from "../../app/context";
import { navigate } from "../../app/router";
import { PageToolbar } from "../../app/shell/PageToolbar";
import { useUsage } from "../../app/shell/queries";
import { IMPORT_LIMITS } from "../../core/imports";
import type { ImportedObject, SourceApp } from "../../core/types";
import {
  Button,
  ContextMenu,
  EmptyState,
  Icon,
  IconButton,
  MediaGrid,
  Menu,
  MenuItem,
  SearchField,
  SegmentedControl,
  Skeleton,
  ToolbarGroup,
  ToolbarItem,
  formatCount,
  useDeferredLoading,
  useLatest,
  useMediaQuery,
  usePx,
  useShortcuts,
  useToast,
} from "../../ui";
import { useImportActions, useImportsList } from "./data";
import { DropOverlay, ImportDropZone } from "./DropZone";
import { collectDrop, collectPicked, dragHasFiles, importGroups, MAX_DROPPED_FILES, snapshotDrop, type CollectedFiles } from "./files";
import { ImportCard } from "./ImportCard";
import { ImportInspector, ImportMenuItems, type ImportCommands } from "./ImportInspector";
import { ImportJobs } from "./ImportJobs";
import { RenameSheet, SourceSheet } from "./ImportSheets";
import {
  FILTER_LABEL,
  fileKind,
  filterFromRoute,
  routeSourceForFilter,
  sectionsBySource,
  SOURCE_FILTERS,
  sourceCounts,
  visibleImports,
  type SourceFilter,
  type SourceGroup,
} from "./model";
import { useImportQueue } from "./queue";
import "./imports.css";

const SUPPORTED = "GLB, glTF, FBX, OBJ, STL, PLY or USDZ files, or a ZIP of them";

const EMPTY_SCOPE: Record<Exclude<SourceFilter, "all">, { title: string; description: string }> = {
  unity: { title: "No Unity Imports", description: "Models exported from Unity (glTFast, UnityGLTF or the FBX Exporter) appear here." },
  blender: { title: "No Blender Imports", description: "Models exported from Blender (glTF, FBX, OBJ, STL, PLY or USD) appear here." },
  other: { title: "No Other Imports", description: "Models from other apps, or whose app isn’t named in the file, appear here." },
};

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The id of the card an event happened on (context menus). */
function cardIdOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest<HTMLElement>('[role="option"][data-id]') : null;
  return element?.dataset.id ?? null;
}

export interface ImportsBrowserProps {
  source?: SourceApp | undefined;
}

export function ImportsBrowser({ source }: ImportsBrowserProps) {
  const backend = useBackend();
  const list = useImportsList();
  const usage = useUsage();
  const actions = useImportActions();
  const { queue, jobs } = useImportQueue(backend);
  const toast = useToast();
  const { announce } = usePx();
  const wide = useMediaQuery("(min-width: 1280px)");

  const filter = filterFromRoute(source);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [inspectorChoice, setInspectorChoice] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<SourceGroup>>(() => new Set());
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState<ImportedObject | null>(null);
  const [changingSource, setChangingSource] = useState<ImportedObject | null>(null);
  const [more, setMore] = useState<{ object: ImportedObject; anchor: HTMLElement } | null>(null);
  const [menuTarget, setMenuTarget] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const inspectorShown = inspectorChoice ?? wide;

  // the plan's per-file limit; the importer also caps what it holds in memory for one analysis
  const planLimit = usage.data?.maxFileBytes ?? (usage.error ? IMPORT_LIMITS.defaultStorageBytes : null);
  const limit = planLimit === null ? null : Math.min(planLimit, IMPORT_LIMITS.analysisBytes);
  useEffect(() => {
    if (planLimit !== null) queue.setLimit(planLimit);
  }, [queue, planLimit]);

  const objects = useMemo(() => list.data ?? [], [list.data]);
  const byId = useMemo(() => new Map(objects.map((object) => [object.id, object])), [objects]);
  const counts = useMemo(() => sourceCounts(objects), [objects]);
  const visible = useMemo(() => visibleImports(objects, filter, query), [objects, filter, query]);
  const searching = query.trim() !== "";
  const sections = useMemo(() => (filter === "all" && !searching ? sectionsBySource(visible) : null), [filter, searching, visible]);
  const selection = useMemo(() => [...selected].flatMap((id) => byId.get(id) ?? []), [selected, byId]);

  // the selection follows what is shown (a filter or search hides cards; Trash removes them)
  const visibleKey = visible.map((object) => object.id).join(",");
  useEffect(() => {
    const shown = new Set(visibleKey.split(","));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => shown.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [visibleKey]);

  const commands = useMemo<ImportCommands>(
    () => ({
      actions,
      onOpen: (object) => navigate({ name: "imports", objectId: object.id, ...(source ? { source } : {}) }),
      onRename: setRenaming,
      onChangeSource: setChangingSource,
      onTrashed: (trashed) => {
        const ids = new Set(trashed.map((object) => object.id));
        setSelected((previous) => new Set([...previous].filter((id) => !ids.has(id))));
      },
    }),
    [actions, source],
  );

  const importFiles = useCallback(
    (collected: CollectedFiles) => {
      if (collected.files.length === 0) return;
      const { groups, ignored } = importGroups(collected.files, limit);
      if (groups.length === 0) {
        const names = collected.files.map((file) => file.name).slice(0, 3).join(", ");
        toast.show({ tone: "error", message: `Nothing to import from ${names}. Choose ${SUPPORTED}.` });
        return;
      }
      queue.enqueue(groups);
      const unused = ignored.filter((path) => fileKind(path) !== "junk");
      if (collected.truncated) {
        toast.show({ tone: "warning", message: `Only the first ${MAX_DROPPED_FILES} files were read. Import large folders a model at a time.` });
      } else if (unused.length > 0) {
        toast.show({
          tone: "info",
          message:
            unused.length === 1
              ? `“${baseName(unused[0] ?? "")}” wasn’t imported: no model in the selection uses it.`
              : `${unused.length} files weren’t imported: no model in the selection uses them.`,
        });
      }
    },
    [limit, queue, toast],
  );

  // the latest handler for the window-level drag listeners, which are registered once
  const importRef = useLatest(importFiles);

  // files dragged anywhere over the window import here (a stray drop would otherwise open the file in the tab)
  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer || !dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const snapshot = snapshotDrop(event.dataTransfer);
      collectDrop(snapshot).then(
        (collected) => importRef.current(collected),
        () => toast.show({ tone: "error", message: "The dropped folder couldn’t be read. Try choosing it with Import a Folder… instead." }),
      );
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [toast, importRef]);

  useEffect(
    () =>
      queue.onEvent((event) => {
        if (event.type === "imported") {
          setSelected(new Set([event.object.id]));
          announce(`Imported ${event.object.title}.`);
        } else if (event.type === "failed") {
          announce(`${event.label} wasn’t imported. ${event.failure.reason}`, "assertive");
        } else if (event.type === "idle" && event.imported.length > 0) {
          const [first] = event.imported;
          toast.show({
            tone: "success",
            message: event.imported.length === 1 && first ? `Imported “${first.title}”.` : `Imported ${event.imported.length} models.`,
          });
        }
      }),
    [queue, announce, toast],
  );

  const chooseFiles = useCallback(() => fileInput.current?.click(), []);
  const chooseFolder = useCallback(() => folderInput.current?.click(), []);
  const toggleInspector = useCallback(() => setInspectorChoice(!inspectorShown), [inspectorShown]);
  useShortcuts([
    { keys: "mod+o", handler: chooseFiles },
    { keys: "mod+i", handler: toggleInspector },
  ]);

  const setFilter = (next: SourceFilter) => {
    const value = routeSourceForFilter(next);
    navigate({ name: "imports", ...(value ? { source: value } : {}) }, { replace: true });
  };

  const objectsOf = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
  const grid = (items: readonly ImportedObject[], label: string) => (
    <MediaGrid
      aria-label={label}
      className="px-imports-grid"
      selected={selected}
      onSelectionChange={setSelected}
      onOpen={(id) => {
        const object = byId.get(id);
        if (object) commands.onOpen?.(object);
      }}
      onToggleFavorite={(ids) => {
        const chosen = objectsOf(ids);
        void actions.setFavorite(chosen, !chosen.every((object) => object.favorite));
      }}
      onDelete={(ids) => {
        const chosen = objectsOf(ids);
        void actions.moveToTrash(chosen).then((moved) => {
          if (moved) commands.onTrashed?.(chosen);
        });
      }}
    >
      {items.map((object) => (
        <ImportCard
          key={object.id}
          object={object}
          onFavoriteChange={(favorite) => void actions.setFavorite([object], favorite)}
          onMore={(anchor) => setMore({ object, anchor })}
        />
      ))}
    </MediaGrid>
  );

  const loadingVisible = useDeferredLoading(list.data === undefined && !list.error);
  let body: ReactNode;
  if (list.data === undefined) {
    body = list.error ? (
      <EmptyState
        icon={CircleAlert}
        title="Couldn’t Load Imports"
        description="Check your connection and try again."
        action={
          <Button onClick={() => void list.refresh()}>Try Again</Button>
        }
        className="px-imports-empty"
      />
    ) : loadingVisible ? (
      <GridSkeleton />
    ) : null;
  } else if (objects.length === 0) {
    body = null;
  } else if (visible.length === 0) {
    body = searching ? (
      <EmptyState icon={SearchX} title={`No Results for “${query.trim()}”`} description="Check the spelling or try a new search." className="px-imports-empty" />
    ) : filter !== "all" ? (
      <EmptyState icon={Import} title={EMPTY_SCOPE[filter].title} description={EMPTY_SCOPE[filter].description} className="px-imports-empty" />
    ) : null;
  } else if (sections) {
    body = sections.map((section) => (
      <SourceSection
        key={section.group}
        group={section.group}
        count={section.items.length}
        collapsed={collapsed.has(section.group)}
        onToggle={() =>
          setCollapsed((previous) => {
            const next = new Set(previous);
            if (next.has(section.group)) next.delete(section.group);
            else next.add(section.group);
            return next;
          })
        }
      >
        {grid(section.items, `${FILTER_LABEL[section.group]} Imports`)}
      </SourceSection>
    ));
  } else {
    body = grid(visible, searching ? "Search Results" : `${FILTER_LABEL[filter]} Imports`);
  }

  const menuObject = menuTarget ? byId.get(menuTarget) ?? null : null;
  const recordMenuTarget = (event: MouseEvent | KeyboardEvent) => {
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (!(key === "ContextMenu" || (key === "F10" && (event as KeyboardEvent).shiftKey))) return;
    }
    setMenuTarget(cardIdOf(event.target));
  };

  return (
    <div className="px-imports" data-inspector={inspectorShown ? "shown" : "hidden"}>
      <PageToolbar
        title="Imports"
        subtitle={list.data ? formatCount(visible.length, "Item") : undefined}
        center={
          <SegmentedControl<SourceFilter>
            variant="toolbar"
            aria-label="Source"
            value={filter}
            onChange={setFilter}
            items={SOURCE_FILTERS.map((value) => ({ value, label: `${FILTER_LABEL[value]} ${counts[value]}` }))}
          />
        }
        trailing={
          <>
            <ToolbarItem priority={2}>
              <SearchField variant="toolbar" label="Search Imports" value={query} onChange={setQuery} focusShortcut="mod+f" />
            </ToolbarItem>
            <ToolbarGroup priority={3}>
              <IconButton
                variant="toolbar"
                size="toolbar"
                icon={Info}
                label={inspectorShown ? "Hide Inspector" : "Show Inspector"}
                pressed={inspectorShown}
                shortcut="mod+i"
                onClick={toggleInspector}
              />
            </ToolbarGroup>
            <Button variant="borderedProminent" size="toolbar" icon={Import} onClick={chooseFiles} aria-keyshortcuts="Meta+O">
              Import…
            </Button>
          </>
        }
      />
      {dragging ? <DropOverlay /> : null}
      <div className="px-imports__main">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            importFiles(collectPicked(event.currentTarget.files));
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={(element) => {
            folderInput.current = element;
            element?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            importFiles(collectPicked(event.currentTarget.files));
            event.currentTarget.value = "";
          }}
        />
        {list.data !== undefined ? (
          <ImportDropZone variant={objects.length === 0 ? "empty" : "strip"} limitBytes={limit} onChooseFiles={chooseFiles} onChooseFolder={chooseFolder} />
        ) : null}
        <ImportJobs jobs={jobs} onCancel={(id) => queue.cancel(id)} onDismiss={(id) => queue.dismiss(id)} onRetry={(id) => queue.retry(id)} />
        <div className="px-imports-contents" onContextMenuCapture={recordMenuTarget} onKeyDownCapture={recordMenuTarget}>
          <ContextMenu
            aria-label={menuObject ? `Actions for ${menuObject.title}` : "Imports"}
            menu={
              menuObject ? (
                <ImportMenuItems object={menuObject} commands={commands} selection={selection} />
              ) : (
                <>
                  <MenuItem icon={Import} shortcut="mod+o" onSelect={chooseFiles}>
                    Import Files…
                  </MenuItem>
                  <MenuItem icon={FolderOpen} onSelect={chooseFolder}>
                    Import a Folder…
                  </MenuItem>
                </>
              )
            }
          >
            <div className="px-imports-sections">{body}</div>
          </ContextMenu>
        </div>
      </div>
      {inspectorShown ? (
        <div className="px-imports__aside">
          <ImportInspector selection={selection} context="grid" commands={commands} />
        </div>
      ) : null}
      <Menu
        open={more !== null}
        onOpenChange={(open) => {
          if (!open) setMore(null);
        }}
        anchor={more?.anchor ?? null}
        placement="bottom-end"
        initialFocus="menu"
        aria-label={more ? `Actions for ${more.object.title}` : "Actions"}
      >
        {more ? <ImportMenuItems object={more.object} commands={commands} selection={selection} /> : null}
      </Menu>
      <RenameSheet object={renaming} onClose={() => setRenaming(null)} onRename={(object, title) => void actions.rename(object, title)} />
      <SourceSheet object={changingSource} onClose={() => setChangingSource(null)} onChange={(object, app) => void actions.setSource(object, app)} />
    </div>
  );
}

interface SourceSectionProps {
  group: SourceGroup;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/** "Blender  12  ⌄": a collapsible section of one source (§3.5). */
function SourceSection({ group, count, collapsed, onToggle, children }: SourceSectionProps) {
  const headingId = useId();
  const bodyId = useId();
  return (
    <section className="px-imports-section" aria-labelledby={headingId}>
      <h2 className="px-imports-section__heading">
        <button type="button" className="px-imports-section__toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={onToggle}>
          <span id={headingId} className="px-imports-section__name">
            {FILTER_LABEL[group]}
          </span>
          <span className="px-imports-section__count px-num">{count}</span>
          <Icon icon={ChevronDown} size={12} strokeWidth={2.25} className="px-imports-section__chevron" />
        </button>
      </h2>
      <div id={bodyId} hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}

/** Twelve placeholder cards while the list loads (§4.4: after 150 ms, at least 300 ms). */
function GridSkeleton() {
  return (
    <div className="px-grid px-imports-grid" aria-hidden="true">
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className="px-imports-skeleton">
          <div className="px-imports-skeleton__thumb">
            <Skeleton width="100%" height="100%" radius={10} />
          </div>
          <Skeleton width="60%" height={10} />
          <Skeleton width="40%" height={10} />
        </div>
      ))}
    </div>
  );
}
