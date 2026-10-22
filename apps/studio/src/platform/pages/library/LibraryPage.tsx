// The Library (DESIGN.md G3, APPLE_STYLE_SPEC §2.9, §2.10, §3.4): every shape, material, texture, recording, scene, image
// and model the account keeps. A toolbar (scope, view options, search, inspector, Upload…), a Finder-style grid
// (click, ⌘/⇧-click, arrows, Return/Space for Quick Look, "." to favourite, ⌘⌫ to the Trash, context menus), uploads by
// button or drag and drop, and an inspector for the selection. Route: #/library[?kind=…][/<id>].
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { CloudOff, Download, Eye, FlaskConical, FolderOpen, Heart, Images, Pencil, RotateCcw, SlidersHorizontal, Tags, Trash2, Upload, X } from "lucide-react";
import { useBackend } from "../../app/context";
import { navigate, type LibraryFilter } from "../../app/router";
import { labIcon } from "../../app/shell/labIcons";
import { PageToolbar } from "../../app/shell/PageToolbar";
import { useUsage } from "../../app/shell/queries";
import { getLab, listLabs } from "../../core/labs/registry";
import type { LibraryItem } from "../../core/types";
import {
  Button,
  ContextMenu,
  EmptyState,
  formatCount,
  Grid,
  Icon,
  IconButton,
  MediaGrid,
  Menu,
  MenuButton,
  MenuItem,
  MenuSection,
  MenuSeparator,
  PopUpButton,
  SearchField,
  Skeleton,
  ToolbarGroup,
  ToolbarItem,
  Tooltip,
  useDeferredLoading,
  useMediaQuery,
  useShortcuts,
  useToast,
  type PopUpOption,
} from "../../ui";
import { readStorage, writeStorage } from "../../ui/lib/dom";
import { inScope, LIBRARY_SORTS, SORT_LABEL, visibleItems } from "../../components/library/filters";
import { emptyStateCopy, KIND_INFO, LIBRARY_KIND_ORDER, scopeIcon, scopeTitle, searchEmptyCopy, type EmptyCopy, type LibraryScope } from "../../components/library/kinds";
import { ItemCard, UploadCard } from "../../components/library/LibraryCards";
import { EmptyInspector, LibraryItemInspector, LibrarySelectionInspector, UploadInspector, type FocusRequest } from "../../components/library/LibraryInspector";
import { libraryErrorMessage } from "../../components/library/messages";
import { QuickLook } from "../../components/library/QuickLook";
import { contextMenuSelection, neighbourAfterRemoval, orderedSelection, pruneSelection } from "../../components/library/selection";
import { UPLOAD_ACCEPT } from "../../components/library/uploadKind";
import { LIBRARY_LIST_LIMIT, useLibraryActions, useLibraryDownloads, useLibraryList, useLibraryUploads } from "../../components/library/useLibrary";
import { parseViewPrefs, serializeViewPrefs, TILE_SIZES, tilePixels, VIEW_PREFS_KEY, type ViewPrefs } from "../../components/library/viewPrefs";
import "./library-page.css";

export interface LibraryPageProps {
  filter?: LibraryFilter | undefined;
  itemId?: string | undefined;
}

const SCOPE_OPTIONS: ReadonlyArray<PopUpOption<LibraryScope> | "separator"> = [
  { value: "all", label: "All Items", icon: scopeIcon("all") },
  { value: "favorites", label: "Favorites", icon: scopeIcon("favorites") },
  "separator",
  ...LIBRARY_KIND_ORDER.map((kind) => ({ value: kind, label: KIND_INFO[kind].plural, icon: KIND_INFO[kind].icon })),
];

const number = new Intl.NumberFormat("en-US");
const WIDE_QUERY = "(min-width: 1280px)";

function cardElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.px-library [role="option"][data-id="${CSS.escape(id)}"]`);
}

/** The id of the card an event happened on (its overlay buttons sit beside the option, inside the card). */
function cardIdOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const card = target.closest(".px-card");
  return card?.querySelector<HTMLElement>('[role="option"][data-id]')?.dataset.id ?? null;
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

interface DropArea {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function LibraryPage({ filter, itemId }: LibraryPageProps) {
  const scope: LibraryScope = filter ?? "all";
  const backend = useBackend();
  const toast = useToast();
  const list = useLibraryList();
  const actions = useLibraryActions();
  const downloads = useLibraryDownloads();
  const uploads = useLibraryUploads();
  const maxFileBytes = useUsage().data?.maxFileBytes;
  const wide = useMediaQuery(WIDE_QUERY);
  const [inspectorShown, setInspectorShown] = useState(() => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches);
  const [search, setSearch] = useState("");
  const [prefs, setPrefs] = useState<ViewPrefs>(() => parseViewPrefs(readStorage(VIEW_PREFS_KEY)));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [quickLookId, setQuickLookId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ ids: string[]; anchor: HTMLElement } | null>(null);
  const [contextIds, setContextIds] = useState<string[]>([]);
  const [dropArea, setDropArea] = useState<DropArea | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const dragDepth = useRef(0);

  const items = list.data;
  const visible = useMemo(() => visibleItems(items ?? [], { scope, search, sort: prefs.sort }), [items, scope, search, prefs.sort]);
  const itemById = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);
  const uploadById = useMemo(() => new Map(uploads.entries.map((entry) => [entry.id, entry])), [uploads.entries]);
  const gridIds = useMemo(() => [...uploads.entries.map((entry) => entry.id), ...visible.map((item) => item.id)], [uploads.entries, visible]);
  const selectedIds = useMemo(() => orderedSelection(gridIds, selected), [gridIds, selected]);
  const selectedItems = useMemo(() => selectedIds.map((id) => itemById.get(id)).filter((item): item is LibraryItem => item !== undefined), [selectedIds, itemById]);

  // the selection only ever holds what the grid shows
  useEffect(() => setSelected((current) => pruneSelection(current, gridIds)), [gridIds]);

  const updatePrefs = (patch: Partial<ViewPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      writeStorage(VIEW_PREFS_KEY, serializeViewPrefs(next));
      return next;
    });
  };

  const openPicker = useCallback(() => fileInput.current?.click(), []);

  // uploads: the card's selection follows it into the new item; items that land outside this scope say where they went
  useEffect(
    () =>
      uploads.onEvent((event) => {
        if (event.type === "uploaded") {
          setSelected((current) => (current.has(event.entry.id) ? new Set([...current].map((id) => (id === event.entry.id ? event.item.id : id))) : current));
          if (!inScope(event.item, scope)) {
            const kind = event.item.kind;
            toast.show({
              message: `“${event.item.title}” was added to ${KIND_INFO[kind].plural}.`,
              action: { label: "Show", onAction: () => navigate({ name: "library", filter: kind, itemId: event.item.id }) },
            });
          }
        } else if (event.type === "failed") {
          toast.show({
            tone: "error",
            message: libraryErrorMessage(event.error, "upload", { name: event.entry.name, maxFileBytes }),
            action: { label: "Try Again", onAction: () => uploads.retry(event.entry.id) },
          });
        }
      }),
    [uploads, scope, toast, maxFileBytes],
  );

  // #/library/<id>: select the item and show it; say so when it is in the Trash or gone
  const deepLinked = useRef<string | null>(null);
  useEffect(() => {
    const key = itemId ? `${scope}:${itemId}` : null;
    if (!itemId || !key || !items || deepLinked.current === key) return;
    deepLinked.current = key;
    const reveal = (id: string) => {
      setSelected(new Set([id]));
      setInspectorShown(true);
      requestAnimationFrame(() => cardElement(id)?.scrollIntoView({ block: "nearest" }));
    };
    const known = itemById.get(itemId);
    if (known && inScope(known, scope)) {
      if (!visible.some((item) => item.id === itemId)) setSearch("");
      reveal(itemId);
      return;
    }
    if (known) {
      navigate({ name: "library", itemId }, { replace: true });
      return;
    }
    backend.library.get(itemId).then(
      (item) => {
        if (item.trashedAt) {
          toast.show({ message: `“${item.title}” is in the Trash.`, action: { label: "Show Trash", onAction: () => navigate({ name: "trash" }) } });
        } else {
          void list.refresh();
        }
      },
      (error: unknown) => toast.show({ tone: "error", message: libraryErrorMessage(error, "load") }),
    );
  }, [itemId, scope, items, itemById, visible, backend, toast, list]);

  // a focus request ("Rename…", "Edit Tags…") is consumed by the inspector right away; never replay it on remount
  useEffect(() => {
    if (!focusRequest) return undefined;
    const timer = window.setTimeout(() => setFocusRequest(null), 400);
    return () => window.clearTimeout(timer);
  }, [focusRequest]);

  useShortcuts([{ keys: "mod+i", handler: () => setInspectorShown((shown) => !shown) }]);

  const itemsOf = useCallback((ids: readonly string[]) => ids.map((id) => itemById.get(id)).filter((item): item is LibraryItem => item !== undefined), [itemById]);

  const moveToTrash = useCallback(
    (targets: readonly LibraryItem[]) => {
      if (targets.length === 0) return;
      const removed = new Set(targets.map((item) => item.id));
      const next = neighbourAfterRemoval(gridIds, removed);
      const hadFocus = mainRef.current?.contains(document.activeElement) ?? false;
      setSelected(next ? new Set([next]) : new Set());
      void actions.moveToTrash(targets);
      if (hadFocus && next) requestAnimationFrame(() => cardElement(next)?.focus());
    },
    [actions, gridIds],
  );

  const toggleFavorite = useCallback(
    (targets: readonly LibraryItem[]) => {
      if (targets.length === 0) return;
      void actions.setFavorite(targets, !targets.every((item) => item.favorite));
    },
    [actions],
  );

  const requestEdit = useCallback((item: LibraryItem, field: FocusRequest["field"]) => {
    setSelected(new Set([item.id]));
    setInspectorShown(true);
    setFocusRequest({ field, nonce: Date.now() });
  }, []);

  const openQuickLook = useCallback(
    (id: string) => {
      if (itemById.has(id)) setQuickLookId(id);
    },
    [itemById],
  );

  /** The commands for `ids` (the context menu and the cards' ⋯ menus). */
  const menuFor = (ids: readonly string[]): ReactNode => {
    const targets = itemsOf(ids);
    const pending = ids.map((id) => uploadById.get(id)).filter((entry) => entry !== undefined);
    if (targets.length === 0 && pending.length > 0) {
      return pending.map((entry) =>
        entry.status === "failed" ? (
          <MenuSection key={entry.id} title={entry.name}>
            <MenuItem icon={RotateCcw} onSelect={() => uploads.retry(entry.id)}>
              Try Again
            </MenuItem>
            <MenuItem icon={X} onSelect={() => uploads.cancel(entry.id)}>
              Remove
            </MenuItem>
          </MenuSection>
        ) : (
          <MenuItem key={entry.id} icon={X} onSelect={() => uploads.cancel(entry.id)}>
            {pending.length > 1 ? `Cancel “${entry.name}”` : "Cancel Upload"}
          </MenuItem>
        ),
      );
    }
    if (targets.length === 0) {
      return (
        <>
          <MenuItem icon={Upload} onSelect={openPicker}>
            Upload…
          </MenuItem>
          {visible.length > 0 ? (
            <MenuItem shortcut="mod+a" onSelect={() => setSelected(new Set(gridIds))}>
              Select All
            </MenuItem>
          ) : null}
        </>
      );
    }
    const single = targets.length === 1 ? targets[0] : undefined;
    const allFavorite = targets.every((item) => item.favorite);
    const count = targets.length;
    return (
      <>
        <MenuItem icon={Eye} shortcut="enter" disabled={!single} onSelect={() => single && openQuickLook(single.id)}>
          Open
        </MenuItem>
        {single?.sourceProjectId ? (
          <MenuItem icon={FolderOpen} onSelect={() => single.sourceProjectId && navigate({ name: "project", id: single.sourceProjectId })}>
            Show Source Project
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem icon={Heart} shortcut="." onSelect={() => toggleFavorite(targets)}>
          {allFavorite ? "Remove from Favorites" : "Add to Favorites"}
        </MenuItem>
        <MenuItem icon={Pencil} disabled={!single} onSelect={() => single && requestEdit(single, "title")}>
          Rename…
        </MenuItem>
        <MenuItem icon={Tags} disabled={!single} onSelect={() => single && requestEdit(single, "tags")}>
          Edit Tags…
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Download} onSelect={() => void downloads.downloadItems(targets)}>
          {count > 1 ? `Download ${number.format(count)} Items` : "Download"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} shortcut={{ mac: "meta+backspace", other: "delete" }} onSelect={() => moveToTrash(targets)}>
          {count > 1 ? `Move ${number.format(count)} Items to Trash` : "Move to Trash"}
        </MenuItem>
      </>
    );
  };

  const prepareContextMenu = (target: EventTarget | null) => {
    const id = cardIdOf(target);
    if (!id) {
      setContextIds([]);
      return;
    }
    const next = contextMenuSelection(selected, id);
    if (next !== selected) setSelected(next);
    setContextIds(orderedSelection(gridIds, next));
  };

  const openMoreMenu = (id: string, anchor: HTMLElement) => {
    const next = contextMenuSelection(selected, id);
    if (next !== selected) setSelected(next);
    setMoreMenu({ ids: orderedSelection(gridIds, next), anchor });
  };

  // drag and drop of files onto the grid
  const showDropArea = () => {
    const main = mainRef.current;
    const scroller = document.getElementById("px-main");
    if (!main) return;
    const area = main.getBoundingClientRect();
    const view = scroller?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const toolbar = scroller ? Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0 : 0;
    const top = Math.max(area.top, view.top + toolbar);
    const bottom = Math.min(area.bottom, view.bottom, window.innerHeight);
    setDropArea({ top: top + 12, left: area.left + 12, width: Math.max(0, area.width - 24), height: Math.max(0, bottom - top - 24) });
  };
  const dropHandlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      if (dragDepth.current === 1) showDropArea();
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropArea(null);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDropArea(null);
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) void uploads.add(files);
    },
  };

  const showSkeleton = useDeferredLoading(items === undefined && !list.error);
  const tileMin = tilePixels(prefs.tile);
  const searching = search.trim() !== "";
  const total = visible.length;
  const subtitle =
    items === undefined
      ? undefined
      : selectedIds.length > 0
        ? `${number.format(selectedIds.length)} of ${number.format(total + uploads.entries.length)} Selected`
        : searching
          ? formatCount(total, "Result")
          : formatCount(total, "Item");

  const emptyAction = (copy: EmptyCopy): ReactNode => {
    if (copy.action === "upload") {
      return (
        <>
          <Button variant={scope === "all" ? "bordered" : "borderedProminent"} icon={Upload} onClick={openPicker}>
            Upload…
          </Button>
          {scope === "all" ? <LabMenuButton kind={null} /> : null}
        </>
      );
    }
    if (copy.action === "lab") {
      const lab = copy.labId ? getLab(copy.labId) : null;
      if (lab) {
        return (
          <Button icon={labIcon(lab.icon)} onClick={() => navigate({ name: "lab", labId: lab.id })}>
            Open {lab.title}
          </Button>
        );
      }
      return <LabMenuButton kind={scope === "all" || scope === "favorites" ? null : scope} />;
    }
    return null;
  };

  let content: ReactNode;
  if (items === undefined && list.error) {
    content = (
      <EmptyState
        icon={CloudOff}
        title="Couldn’t Load Library"
        description={libraryErrorMessage(list.error, "load")}
        action={
          <Button icon={RotateCcw} onClick={() => void list.refresh()}>
            Try Again
          </Button>
        }
      />
    );
  } else if (items === undefined) {
    content = showSkeleton ? (
      <Grid tileMin={tileMin} className="px-library__grid" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => (
          <div key={index} className="px-lib-skeleton-card">
            <Skeleton className="px-lib-skeleton-card__thumb" radius={10} height="auto" />
            <Skeleton width="60%" />
            <Skeleton width="40%" />
          </div>
        ))}
      </Grid>
    ) : null;
  } else if (gridIds.length === 0) {
    const copy = searching ? searchEmptyCopy(search) : emptyStateCopy(scope);
    content = (
      <div className="px-library__empty">
        <EmptyState icon={searching ? scopeIcon(scope) : scopeIcon(scope)} title={copy.title} description={copy.description} action={emptyAction(copy)} />
      </div>
    );
  } else {
    content = (
      <>
        <ContextMenu menu={menuFor(contextIds)} aria-label="Library Item Actions">
          <div
            onContextMenuCapture={(event: MouseEvent<HTMLDivElement>) => prepareContextMenu(event.target)}
            onKeyDownCapture={(event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) prepareContextMenu(document.activeElement);
            }}
          >
            <MediaGrid
              aria-label={scopeTitle(scope)}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={openQuickLook}
              onQuickLook={(id) => (quickLookId === id ? setQuickLookId(null) : openQuickLook(id))}
              onToggleFavorite={(ids) => toggleFavorite(itemsOf(ids))}
              onDelete={(ids) => {
                const targets = itemsOf(ids);
                if (targets.length > 0) moveToTrash(targets);
                else for (const id of ids) if (uploadById.has(id)) uploads.cancel(id);
              }}
              tileMin={tileMin}
              className="px-library__grid"
            >
              {uploads.entries.map((entry) => (
                <UploadCard key={entry.id} entry={entry} onMore={(anchor) => openMoreMenu(entry.id, anchor)} />
              ))}
              {visible.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  scope={scope}
                  onFavoriteChange={(favorite) => void actions.setFavorite([item], favorite)}
                  onMore={(anchor) => openMoreMenu(item.id, anchor)}
                />
              ))}
            </MediaGrid>
          </div>
        </ContextMenu>
        {items.length >= LIBRARY_LIST_LIMIT ? <p className="px-library__note">Showing the newest {number.format(LIBRARY_LIST_LIMIT)} items.</p> : null}
      </>
    );
  }

  const closeInspector = wide ? undefined : () => setInspectorShown(false);
  const singleUpload = selectedIds.length === 1 ? uploadById.get(selectedIds[0] as string) : undefined;
  let inspector: ReactNode;
  if (singleUpload) {
    inspector = (
      <UploadInspector
        entry={singleUpload}
        maxFileBytes={maxFileBytes}
        onCancel={() => uploads.cancel(singleUpload.id)}
        onRetry={() => uploads.retry(singleUpload.id)}
        onClose={closeInspector}
      />
    );
  } else if (selectedItems.length === 1) {
    const item = selectedItems[0] as LibraryItem;
    inspector = (
      <LibraryItemInspector
        item={item}
        actions={actions}
        downloads={downloads}
        focusRequest={focusRequest}
        onQuickLook={() => openQuickLook(item.id)}
        onClose={closeInspector}
      />
    );
  } else if (selectedItems.length > 1) {
    inspector = <LibrarySelectionInspector items={selectedItems} actions={actions} downloads={downloads} onClose={closeInspector} />;
  } else {
    inspector = <EmptyInspector />;
  }

  const quickIndex = quickLookId ? visible.findIndex((item) => item.id === quickLookId) : -1;
  const quickItem = quickIndex >= 0 ? (visible[quickIndex] ?? null) : null;
  const stepQuickLook = (delta: 1 | -1) => {
    if (quickIndex < 0 || visible.length === 0) return;
    const next = visible[(quickIndex + delta + visible.length) % visible.length];
    if (!next) return;
    setQuickLookId(next.id);
    setSelected(new Set([next.id]));
  };
  const closeQuickLook = () => {
    const last = quickLookId;
    setQuickLookId(null);
    // the sheet returns focus to the card it opened from; follow the item the arrows moved to instead
    if (last) requestAnimationFrame(() => requestAnimationFrame(() => cardElement(last)?.focus({ preventScroll: false })));
  };

  return (
    <>
      <PageToolbar
        title={scopeTitle(scope)}
        subtitle={subtitle}
        trailing={
          <>
            <ToolbarItem priority={2}>
              <PopUpButton<LibraryScope>
                label="Show"
                variant="glass"
                size="toolbar"
                value={scope}
                options={SCOPE_OPTIONS}
                className="px-library__scope"
                onChange={(value) => navigate(value === "all" ? { name: "library" } : { name: "library", filter: value })}
              />
            </ToolbarItem>
            <ToolbarItem priority={3}>
              <Tooltip content="View Options">
                <MenuButton
                  variant="glass"
                  size="toolbar"
                  icon={SlidersHorizontal}
                  chevron={false}
                  aria-label="View Options"
                  className="px-library__view"
                  placement="bottom-end"
                  menu={
                    <>
                      <MenuSection title="Sort By">
                        {LIBRARY_SORTS.map((sort) => (
                          <MenuItem key={sort} type="radio" checked={prefs.sort === sort} onSelect={() => updatePrefs({ sort })}>
                            {SORT_LABEL[sort]}
                          </MenuItem>
                        ))}
                      </MenuSection>
                      <MenuSeparator />
                      <MenuSection title="Thumbnail Size">
                        {TILE_SIZES.map((size) => (
                          <MenuItem key={size.value} type="radio" checked={prefs.tile === size.value} onSelect={() => updatePrefs({ tile: size.value })}>
                            {size.label}
                          </MenuItem>
                        ))}
                      </MenuSection>
                    </>
                  }
                />
              </Tooltip>
            </ToolbarItem>
            <ToolbarItem priority={2}>
              <SearchField label="Search Library" variant="toolbar" value={search} onChange={setSearch} focusShortcut="mod+f" containerClassName="px-library__search" />
            </ToolbarItem>
            <ToolbarGroup>
              <IconButton
                icon={Images}
                label={inspectorShown ? "Hide Inspector" : "Show Inspector"}
                shortcut="mod+i"
                variant="toolbar"
                size="toolbar"
                pressed={inspectorShown}
                className="px-library__inspector-toggle"
                onClick={() => setInspectorShown((shown) => !shown)}
              />
            </ToolbarGroup>
            <Button variant="borderedProminent" size="toolbar" icon={Upload} onClick={openPicker}>
              Upload…
            </Button>
          </>
        }
      />
      <div className="px-library" data-inspector={inspectorShown ? "shown" : "hidden"}>
        <div ref={mainRef} className="px-library__main" {...dropHandlers}>
          {content}
        </div>
        {inspectorShown ? <div className="px-library__inspector">{inspector}</div> : null}
      </div>
      {dropArea ? (
        <div className="px-lib-drop" style={{ top: dropArea.top, left: dropArea.left, width: dropArea.width, height: dropArea.height } satisfies CSSProperties} aria-hidden="true">
          <span className="px-lib-drop__chip">
            <Icon icon={Upload} size={16} />
            Drop to Upload
          </span>
        </div>
      ) : null}
      <Menu
        open={moreMenu !== null}
        onOpenChange={(open) => {
          if (!open) setMoreMenu(null);
        }}
        anchor={moreMenu?.anchor ?? null}
        placement="bottom-end"
        initialFocus="menu"
        aria-label="Item Actions"
      >
        {moreMenu ? menuFor(moreMenu.ids) : null}
      </Menu>
      <QuickLook
        item={quickItem}
        position={quickItem ? { index: quickIndex, count: visible.length } : null}
        onClose={closeQuickLook}
        onPrevious={() => stepQuickLook(-1)}
        onNext={() => stepQuickLook(1)}
        onDownload={(item) => void downloads.downloadItems([item])}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void uploads.add(files);
        }}
      />
    </>
  );
}

/** "Open a Lab ▾": the labs that can add items of `kind` to the Library (every lab when kind is null). */
function LabMenuButton({ kind }: { kind: LibraryItem["kind"] | null }) {
  const labs = listLabs().filter((lab) => kind === null || lab.capabilities.library.includes(kind));
  if (labs.length === 0) return null;
  return (
    <MenuButton
      icon={FlaskConical}
      menu={labs.map((lab) => (
        <MenuItem key={lab.id} icon={labIcon(lab.icon)} onSelect={() => navigate({ name: "lab", labId: lab.id })}>
          {lab.title}
        </MenuItem>
      ))}
    >
      Open a Lab
    </MenuButton>
  );
}
